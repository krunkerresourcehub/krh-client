// GPU detection that works BEFORE app.ready.
//
// Chromium flags (ANGLE backend, GPU selection, ...) have to be on the command line before the
// GPU process starts, so Electron's own app.getGPUInfo() (which needs the app to be ready) is too
// late. This module reads the adapter list straight from the OS instead:
//   - Windows: the display-adapter class key in the registry (one `reg query`, ~50 ms)
//   - Linux:   /sys/class/drm (vendor IDs) + `lspci` for the marketing name when it exists
//   - macOS:   not detected (Apple GPUs / Metal need none of this)
//
// Everything here is best effort: any failure returns an empty list and the client simply keeps
// its generic (safe) flags. Detection never throws.
//
// Startup speed: spawning `reg` / `lspci` is the slow part, and the flags are needed before the app
// is ready. So the result is saved to disk (gpu-cache.json in the app data folder). Every launch after
// the first one reads that file instead of spawning anything, and re-checks the hardware in the
// background (async, nothing waits for it); a changed GPU is picked up on the launch after it was found.

import { execFile, execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';

export type GpuVendor = 'nvidia' | 'intel' | 'amd' | 'other';
/**
 * legacy = pre-2013 integrated parts (HD 2000/3000/4000, GMA, GeForce 8-400 era): no extra flags,
 *          every "force" switch is more likely to hurt than help
 * low    = weak but modern enough (HD/UHD Graphics, GT 710/1030, MX110-250, GTX 650-750...)
 * mid    = everything else we recognise (Iris Xe, GTX 1050+, RTX, Arc, Radeon...)
 * unknown = could not tell (e.g. Linux without lspci)
 */
export type GpuTier = 'legacy' | 'low' | 'mid' | 'unknown';

export interface DetectedGpu {
  vendor: GpuVendor;
  name: string;
  tier: GpuTier;
  /** true for integrated parts (Intel HD/UHD/Iris, AMD APU names...) */
  integrated: boolean;
}

export interface GpuSummary {
  gpus: DetectedGpu[];
  hasNvidia: boolean;
  hasIntel: boolean;
  /** An integrated GPU plus a discrete one (laptop "Optimus" / hybrid graphics). */
  hybrid: boolean;
  /** The GPU the game should end up on: the discrete one on hybrid machines, else the first. */
  primary: DetectedGpu | null;
}

const DISPLAY_CLASS_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';

function vendorOf(name: string): GpuVendor {
  const n = name.toLowerCase();
  if (/nvidia|geforce|quadro|\brtx\b|\bgtx\b|tesla/.test(n)) return 'nvidia';
  if (/intel|iris|\buhd\b|\bhd graphics\b|\barc\b/.test(n)) return 'intel';
  if (/\bamd\b|radeon|\bati\b|vega/.test(n)) return 'amd';
  return 'other';
}

function isIntegrated(vendor: GpuVendor, name: string): boolean {
  const n = name.toLowerCase();
  if (vendor === 'intel') return !/\barc\b/.test(n); // Arc is the only discrete Intel line
  if (vendor === 'amd') return /radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|vega graphics|radeon\s*(r[2-7]|hd 8[0-9]{3}g)\b/.test(n) && !/\brx\b/.test(n);
  return false;
}

function tierOf(vendor: GpuVendor, name: string): GpuTier {
  const n = name.toLowerCase();
  if (vendor === 'intel') {
    if (/\barc\b|iris xe|iris plus|iris pro|iris\(r\) xe|iris\(r\) plus/.test(n)) return 'mid';
    // Sandy Bridge .. Haswell era and older: HD Graphics 2000/2500/3000/4000/4200/4400/4600, GMA, G41 ...
    if (/gma|\bg(33|41|45)\b|hd graphics (2000|2500|3000|4000|4200|4400|4600|5000)\b|^intel\(r\) hd graphics$|^intel hd graphics$/.test(n)) return 'legacy';
    if (/\buhd\b|\bhd graphics\b|iris/.test(n)) return 'low';
    return 'unknown';
  }
  if (vendor === 'nvidia') {
    if (/\brtx\b|\bquadro\s*(rtx|[pt]\d)|\btitan\b/.test(n)) return 'mid';
    const m = n.match(/\b(gts|gtx|gt|mx)?\s*(\d{3,4})\s*(ti|mx|m)?\b/);
    if (!m) return 'unknown';
    const prefix = m[1] ?? '';
    const num = parseInt(m[2], 10);
    if (prefix === 'mx') return 'low';
    if (num >= 8000 && num < 10000) return 'legacy';       // 8800 GT, 9600 GT ...
    if (num >= 1000) return num <= 1030 ? 'low' : 'mid';   // GT 1030 low, GTX 1050+, 16xx, 20xx+ mid
    if (num < 600) return 'legacy';                        // 2xx-5xx (Tesla / Fermi)
    if (num < 800) {                                       // Kepler: GT 6xx/7xx and the small GTX
      if (prefix === 'gt' || prefix === '') return 'low';
      return [650, 750].includes(num) ? 'low' : 'mid';
    }
    if (num <= 850 && (m[3] === 'm' || m[3] === 'mx')) return 'low';          // 820M-850M
    if (num < 950) return 'low';                           // GT 9xx / 8xx small parts
    return 'mid';                                          // GTX 950+ / 960 / 970 / 980
  }
  if (vendor === 'amd') {
    return isIntegrated(vendor, name) ? 'low' : 'mid';
  }
  return 'unknown';
}

export function classify(name: string, vendorHint?: GpuVendor): DetectedGpu {
  const vendor = vendorHint && vendorHint !== 'other' ? vendorHint : vendorOf(name);
  return { vendor, name, tier: tierOf(vendor, name), integrated: isIntegrated(vendor, name) };
}

function parseWindowsAdapters(out: string): DetectedGpu[] {
  const names = new Set<string>();
  for (const m of out.matchAll(/DriverDesc\s+REG_SZ\s+(.+)/g)) {
    const name = m[1].trim();
    // skip the virtual / fallback adapters Windows always lists
    if (!name || /microsoft (basic|remote|hyper-v)|remote display|virtual|parsec|displaylink|indirect/i.test(name)) continue;
    names.add(name);
  }
  return [...names].map((n) => classify(n));
}

const WIN_QUERY_ARGS = ['query', DISPLAY_CLASS_KEY, '/s', '/v', 'DriverDesc'];

function windowsAdapters(): DetectedGpu[] {
  const out = execFileSync('reg', WIN_QUERY_ARGS, {
    windowsHide: true, timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  return parseWindowsAdapters(out);
}

function windowsAdaptersAsync(): Promise<DetectedGpu[]> {
  return new Promise((resolve) => {
    execFile('reg', WIN_QUERY_ARGS, { windowsHide: true, timeout: 8000, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? [] : parseWindowsAdapters(String(stdout)));
    });
  });
}

function parseLspci(out: string): Record<string, string> {
  const names: Record<string, string> = {};
  for (const line of out.split('\n')) {
    // 00:02.0 "VGA compatible controller" "Intel Corporation" "HD Graphics 630" ...
    const m = line.match(/^(\S+)\s+"(?:VGA compatible controller|3D controller|Display controller)"\s+"([^"]*)"\s+"([^"]*)"/);
    if (m) names[m[1].replace(/^0000:/, '')] = `${m[2]} ${m[3]}`.trim();
  }
  return names;
}

function linuxPciGpus(): Array<{ vendor: GpuVendor; slot: string }> {
  const vendorIds: Record<string, GpuVendor> = { '0x10de': 'nvidia', '0x8086': 'intel', '0x1002': 'amd' };
  const found: Array<{ vendor: GpuVendor; slot: string }> = [];
  for (const d of readdirSync('/sys/class/drm')) {
    if (!/^card\d+$/.test(d)) continue;
    try {
      const base = `/sys/class/drm/${d}/device`;
      const id = readFileSync(`${base}/vendor`, 'utf8').trim().toLowerCase();
      const slot = readFileSync(`${base}/uevent`, 'utf8').match(/PCI_SLOT_NAME=(\S+)/)?.[1] ?? '';
      found.push({ vendor: vendorIds[id] ?? 'other', slot });
    } catch { /* not a PCI GPU */ }
  }
  return found;
}

function namePciGpus(found: Array<{ vendor: GpuVendor; slot: string }>, names: Record<string, string>): DetectedGpu[] {
  return found.map((f) => {
    const nm = names[f.slot.replace(/^0000:/, '')] ?? '';
    return classify(nm || `${f.vendor} GPU`, f.vendor);
  });
}

function linuxAdapters(): DetectedGpu[] {
  const found = linuxPciGpus();
  // Marketing names come from lspci when it is installed (it usually is).
  let names: Record<string, string> = {};
  try {
    names = parseLspci(execFileSync('lspci', ['-mm'], { timeout: 2500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { /* no lspci: keep the generic names */ }
  return namePciGpus(found, names);
}

function linuxAdaptersAsync(): Promise<DetectedGpu[]> {
  return new Promise((resolve) => {
    let found: Array<{ vendor: GpuVendor; slot: string }>;
    try { found = linuxPciGpus(); } catch { resolve([]); return; }
    execFile('lspci', ['-mm'], { timeout: 4000, encoding: 'utf8' }, (err, stdout) => {
      resolve(namePciGpus(found, err ? {} : parseLspci(String(stdout))));
    });
  });
}

function summarize(allGpus: DetectedGpu[]): GpuSummary {
  const gpus = allGpus.filter((g) => g.vendor !== 'other');
  const hasNvidia = gpus.some((g) => g.vendor === 'nvidia');
  const hasIntel = gpus.some((g) => g.vendor === 'intel');
  const discrete = gpus.filter((g) => !g.integrated);
  const integrated = gpus.filter((g) => g.integrated);
  const hybrid = discrete.length > 0 && integrated.length > 0;
  // Prefer a discrete NVIDIA card, then any discrete card, then whatever is there.
  const primary = discrete.find((g) => g.vendor === 'nvidia') ?? discrete[0] ?? gpus[0] ?? null;
  return { gpus, hasNvidia, hasIntel, hybrid, primary };
}

// ── Saved result (see the note at the top) ──
const CACHE_VERSION = 1;
interface GpuCacheFile { v: number; platform: string; gpus: DetectedGpu[] }

function cachePath(): string | null {
  try { return join(app.getPath('userData'), 'gpu-cache.json'); } catch { return null; }
}

function readCache(): DetectedGpu[] | null {
  const p = cachePath();
  if (!p) return null;
  try {
    const c = JSON.parse(readFileSync(p, 'utf8')) as GpuCacheFile;
    if (c.v !== CACHE_VERSION || c.platform !== process.platform || !Array.isArray(c.gpus)) return null;
    const ok = c.gpus.every((g) => g && typeof g.name === 'string' && ['nvidia', 'intel', 'amd', 'other'].includes(g.vendor)
      && ['legacy', 'low', 'mid', 'unknown'].includes(g.tier) && typeof g.integrated === 'boolean');
    return ok ? c.gpus : null;
  } catch { return null; }
}

function writeCache(gpus: DetectedGpu[]): void {
  const p = cachePath();
  if (!p) return;
  try {
    mkdirSync(join(p, '..'), { recursive: true });
    const data: GpuCacheFile = { v: CACHE_VERSION, platform: process.platform, gpus };
    writeFileSync(p, JSON.stringify(data));
  } catch { /* best effort */ }
}

/** Asks the OS again without blocking anything and refreshes the saved result for the next launch. */
function refreshCacheInBackground(previous: DetectedGpu[] | null): void {
  const run = process.platform === 'win32' ? windowsAdaptersAsync : process.platform === 'linux' ? linuxAdaptersAsync : null;
  if (!run) return;
  void run().then((fresh) => {
    // An empty answer is a failed query, not "no GPU": never overwrite a good saved result with it.
    if (fresh.length === 0) return;
    if (previous && JSON.stringify(previous) === JSON.stringify(fresh)) return;
    writeCache(fresh);
  }).catch(() => { /* best effort */ });
}

let cached: GpuSummary | null = null;

export function detectGpus(): GpuSummary {
  if (cached) return cached;

  // Fast path: reuse the saved result, no process is spawned and nothing waits.
  const saved = readCache();
  if (saved) {
    cached = summarize(saved);
    refreshCacheInBackground(saved);
    return cached;
  }

  // First launch (or no / broken saved result): ask the OS now, then save it for next time.
  let gpus: DetectedGpu[] = [];
  try {
    if (process.platform === 'win32') gpus = windowsAdapters();
    else if (process.platform === 'linux') gpus = linuxAdapters();
  } catch { gpus = []; }
  if (gpus.length > 0) writeCache(gpus);
  cached = summarize(gpus);
  return cached;
}

/** True when the proprietary NVIDIA driver is actually loaded (Linux): PCI presence alone can mean nouveau. */
export function nvidiaProprietaryLoaded(): boolean {
  return process.platform === 'linux' && existsSync('/proc/driver/nvidia/version');
}
