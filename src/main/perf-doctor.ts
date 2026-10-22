// Performance doctor (Dashboard > Diagnostics). One click checks the things that change FPS and says in plain words
// what it found: the Electron build, FPS / frame-cap / throttle settings, the GPU profile and hardware acceleration,
// display scaling, heavy features that are switched on and which of the client's processes use CPU or memory while
// you play. The same findings are returned as a text report you can paste into a bug report.

import { app, BrowserWindow, screen } from 'electron';
import { getGpuProfileInfo } from './platform';

export type DoctorLevel = 'ok' | 'info' | 'warn' | 'bad';
export interface DoctorItem { level: DoctorLevel; title: string; detail: string }
export interface DoctorResult { items: DoctorItem[]; report: string; counts: { bad: number; warn: number } }

export interface DoctorDeps {
  performance: () => { fpsUnlocked?: boolean; frameCap?: number; cpuThrottle?: number; cpuThrottleMenu?: number; processPriority?: string };
  advanced: () => { gpuProfile?: string; ignoreDisplayScaling?: boolean; perfTweaks?: boolean };
  instantReplayOn: () => boolean;
  gameActive: () => boolean;
  gameWindow: () => BrowserWindow | null;
  version: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mb = (kb: number): string => (kb / 1024).toFixed(0) + ' MB';

export async function runPerfDoctor(deps: DoctorDeps): Promise<DoctorResult> {
  const items: DoctorItem[] = [];
  const add = (level: DoctorLevel, title: string, detail: string): void => { items.push({ level, title, detail }); };
  const perf = deps.performance();
  const adv = deps.advanced();
  const playing = deps.gameActive();

  // 1. Electron build: the FPS patches (frame cap, scheduler) only exist in the KRH Electron build.
  const patched = typeof (BrowserWindow.prototype as unknown as { setFrameCap?: unknown }).setFrameCap === 'function';
  if (patched) add('ok', 'Electron build', `KRH Client ${deps.version} on Electron ${process.versions.electron} (Chromium ${process.versions.chrome}) with the FPS patches.`);
  else if (!app.isPackaged) add('info', 'Electron build', `Development run on Electron ${process.versions.electron}: the FPS patches of the release build are not part of it, so FPS here is not representative.`);
  else add('bad', 'Electron build', `This build runs on a stock Electron ${process.versions.electron} without the FPS patches (frame cap and scheduler). FPS can be much lower than on the patched build. Install the client from the official Releases page.`);

  // 2. FPS settings
  if (perf.fpsUnlocked === false) add('warn', 'FPS limit', 'The FPS unlock is off, so the game is limited by V-sync / the display refresh rate. Turn it on in Client Settings > Performance for the highest FPS.');
  else add('ok', 'FPS limit', perf.frameCap && perf.frameCap > 0 ? `Unlocked, with a frame cap of ${perf.frameCap} FPS.` : 'Unlocked, no frame cap.');
  if (perf.frameCap && perf.frameCap > 0 && perf.frameCap < 144) add('info', 'Frame cap', `A frame cap of ${perf.frameCap} FPS is set. Set it to 0 to remove the cap.`);

  // 3. CPU throttle
  const ct = perf.cpuThrottle ?? 1;
  if (ct > 1) add('warn', 'CPU throttle', `The CPU throttle is ${ct}x while playing; it deliberately slows the game down. Set it to 1 for full speed.`);
  const ctm = perf.cpuThrottleMenu ?? 1;
  if (ctm > 1) add('info', 'CPU throttle in menus', `The menu throttle is ${ctm}x. That only affects menus, not matches.`);
  if (perf.processPriority && perf.processPriority !== 'Normal') add('info', 'Process priority', `The priority is "${perf.processPriority}". Raising it rarely helps and can make Windows less responsive.`);

  // 4. GPU
  const gpu = getGpuProfileInfo();
  if (gpu) {
    const eff = String(gpu.effective);
    if (eff === 'low' || eff === 'legacy') add('warn', 'GPU profile', `Using the "${eff}" GPU profile (setting: ${gpu.setting}). It switches off some GPU features to stay stable on weak or old graphics cards; on a modern GPU choose "standard" under Client Settings > Advanced.`);
    else add('ok', 'GPU profile', `"${eff}" (setting: ${gpu.setting}).`);
  }
  try {
    const f = app.getGPUFeatureStatus() as unknown as Record<string, string>;
    const off = ['gpu_compositing', 'webgl', 'webgl2', 'rasterization'].filter((k) => typeof f[k] === 'string' && !f[k].startsWith('enabled'));
    if (off.length) add('bad', 'Hardware acceleration', `Not fully on: ${off.map((k) => `${k} = ${f[k]}`).join(', ')}. The game then runs on the CPU. Update the graphics driver and make sure the game uses the dedicated GPU.`);
    else add('ok', 'Hardware acceleration', 'Compositing, WebGL and rasterization run on the GPU.');
  } catch { /* status not available */ }

  // 5. Display
  try {
    const d = screen.getPrimaryDisplay();
    const hz = (d as unknown as { displayFrequency?: number }).displayFrequency;
    add('info', 'Display', `${d.size.width}x${d.size.height} at ${d.scaleFactor * 100}% scaling${hz ? `, ${hz} Hz` : ''}.`);
    if (d.scaleFactor > 1 && !adv.ignoreDisplayScaling) add('info', 'Display scaling', `Windows scaling is ${d.scaleFactor * 100}%, so the game draws more pixels than the screen resolution suggests. "Ignore display scaling" (Client Settings > Advanced) can raise FPS.`);
  } catch { /* no display info */ }

  // 6. Heavy features
  if (deps.instantReplayOn()) add('info', 'Instant replay', 'Instant replay is on: it keeps recording while you play, which costs some FPS and memory. Switch it off if you do not use it.');

  // 7. Processes (two samples one second apart, so the CPU percentages mean something)
  try {
    app.getAppMetrics();
    await sleep(1200);
    const metrics = app.getAppMetrics();
    const names = new Map<number, string>();
    const game = deps.gameWindow();
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      const pid = w.webContents.getOSProcessId();
      names.set(pid, w === game ? 'Game window' : `Window "${w.getTitle().slice(0, 40) || 'untitled'}"`);
    }
    const rows = metrics.map((m) => ({
      kind: m.type, pid: m.pid, cpu: m.cpu.percentCPUUsage, mem: m.memory.workingSetSize,
      label: names.get(m.pid) ?? (m.type === 'Tab' ? 'Page' : m.type),
    }));
    const totalCpu = rows.reduce((a, r) => a + r.cpu, 0), totalMem = rows.reduce((a, r) => a + r.mem, 0);
    add('info', 'Processes', `${rows.length} processes, ${totalCpu.toFixed(1)}% of one CPU core in total, ${mb(totalMem)} memory.${playing ? '' : ' (The game is not running now, so this is the idle cost. Run the check again while you play for the real picture.)'}`);
    const renderers = rows.filter((r) => r.kind === 'Tab');
    if (playing) {
      const extra = renderers.filter((r) => r.label !== 'Game window');
      const busy = extra.filter((r) => r.cpu >= 2);
      if (busy.length) add('warn', 'Other windows use CPU while you play', busy.map((r) => `${r.label}: ${r.cpu.toFixed(1)}%`).join('; ') + '. Close them (a tab, the website window) while you play.');
      else if (extra.length) add('ok', 'Other windows', `${extra.length} other page process(es) are alive but idle (${extra.map((r) => mb(r.mem)).join(', ')}).`);
      else add('ok', 'Other windows', 'No other page runs next to the game.');
    }
    const top = rows.slice().sort((a, b) => b.cpu - a.cpu).slice(0, 4).filter((r) => r.cpu >= 0.5);
    if (top.length) add('info', 'Busiest processes', top.map((r) => `${r.label} (${r.kind}) ${r.cpu.toFixed(1)}%, ${mb(r.mem)}`).join('; '));
  } catch { add('info', 'Processes', 'Could not read the process list.'); }

  const counts = { bad: items.filter((i) => i.level === 'bad').length, warn: items.filter((i) => i.level === 'warn').length };
  const tag: Record<DoctorLevel, string> = { ok: 'OK  ', info: 'INFO', warn: 'WARN', bad: 'BAD ' };
  const report = [`KRH Client ${deps.version} performance check (${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC)`, ...items.map((i) => `[${tag[i.level]}] ${i.title}: ${i.detail}`)].join('\n');
  return { items, report, counts };
}
