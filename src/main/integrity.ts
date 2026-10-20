// ── Anti-hack check and lockdown ──
// KRH Client is a fair-play client. If it finds a known cheat client or cheat script next to it, it goes into
// LOCKDOWN: every window is closed, the game, the dashboard and the website cannot be used, and only a small
// "locked" window stays, with Quit and Check again.
//
// What this can and cannot do (be honest about it): this runs on the player's own computer, so it can only catch
// what it knows about (the signatures below) and a determined cheater can change names. It is a seatbelt that
// stops casual use of known cheat clients, not a replacement for server-side anti-cheat. Add new signatures to
// CHEAT_PROCESS_NAMES / CHEAT_SCRIPT_PATTERNS / CHEAT_PAGE_MARKERS when you learn about new cheat clients.

import { execFile } from 'child_process';
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

/** Lower-case parts of process names of known cheat clients / launchers. */
export const CHEAT_PROCESS_NAMES: string[] = ['quirify'];

/** Text that marks a script as a cheat (checked on the userscripts in the userscripts folder). */
export const CHEAT_SCRIPT_PATTERNS: RegExp[] = [
  /quirify/i,
  /\baimbot\b/i,
  /\btrigger[\s_-]?bot\b/i,
  /\bwall[\s_-]?hack\b/i,
  /\bauto[\s_-]?aim\b/i,
];

/** Global names, ids and class names that a cheat menu injected into the game page would use (global names are matched as parts). */
export const CHEAT_PAGE_MARKERS: string[] = ['quirify'];

export interface LockState { locked: boolean; reason: string; at: number }

function lockFile(): string { return join(app.getPath('userData'), 'integrity.json'); }

export function readLock(): LockState | null {
  try {
    const raw = JSON.parse(readFileSync(lockFile(), 'utf-8')) as Partial<LockState>;
    if (raw && raw.locked === true) return { locked: true, reason: String(raw.reason || 'Cheat software detected'), at: Number(raw.at) || Date.now() };
  } catch { /* no lock file */ }
  return null;
}

export function writeLock(reason: string): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(lockFile(), JSON.stringify({ locked: true, reason, at: Date.now() }), 'utf-8');
  } catch { /* the lockdown still holds for this run */ }
}

export function clearLock(): void {
  try { if (existsSync(lockFile())) unlinkSync(lockFile()); } catch { /* already gone */ }
}

/** Debugger / inspector flags are how a cheat gets into a packaged Electron app. Normal for development builds only. */
export function scanLaunchFlags(): string | null {
  if (!app.isPackaged) return null;
  const bad = process.argv.find((a) => /^--(inspect|inspect-brk|remote-debugging-port|remote-debugging-pipe)\b/.test(a));
  if (bad) return `Started with a debugger flag (${bad.split('=')[0]})`;
  if (process.env.NODE_OPTIONS && /--inspect/.test(process.env.NODE_OPTIONS)) return 'Started with a debugger option';
  return null;
}

/** Names of the running programs. Resolves to [] if the list cannot be read (then nothing is flagged). */
function listProcesses(): Promise<string[]> {
  return new Promise((resolve) => {
    const done = (out: string): void => resolve(out.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean));
    const cb = (err: Error | null, stdout: string): void => done(err ? '' : stdout);
    if (process.platform === 'win32') execFile('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, cb);
    else execFile('ps', ['-A', '-o', 'comm='], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, cb);
  });
}

export async function scanProcesses(): Promise<string | null> {
  const lines = await listProcesses();
  for (const line of lines) {
    const hit = CHEAT_PROCESS_NAMES.find((n) => line.includes(n));
    if (hit) return `Cheat software is running (${hit})`;
  }
  return null;
}

/** The userscripts the client would run. */
export function scanScripts(dir: string | null): string | null {
  if (!dir || !existsSync(dir)) return null;
  let files: string[];
  try { files = readdirSync(dir).filter((f) => /\.js$/i.test(f)); } catch { return null; }
  for (const f of files) {
    try {
      const full = join(dir, f);
      if (statSync(full).size > 4 * 1024 * 1024) continue;
      const text = readFileSync(full, 'utf-8');
      const hit = CHEAT_SCRIPT_PATTERNS.find((re) => re.test(text));
      if (hit) return `A cheat script is in your userscripts (${f})`;
    } catch { /* unreadable file: skip */ }
  }
  return null;
}

/** Run inside the game page: looks for things a cheat menu leaves behind. Returns '' when clean. */
export const GAME_PROBE_JS = `(() => { try {
  const marks = ${JSON.stringify(CHEAT_PAGE_MARKERS)};
  for (const k of Object.getOwnPropertyNames(window)) { const l = k.toLowerCase(); if (marks.some((m) => l.includes(m))) return 'global:' + k; }
  for (const m of marks) { if (document.getElementById(m) || document.getElementsByClassName(m).length) return 'element:' + m; }
  return '';
} catch (e) { return ''; } })()`;

export function lockdownPage(reason: string): string {
  const esc = reason.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>KRH Client - locked</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#12060a;color:#f3e9ec;font:15px/1.5 system-ui,Segoe UI,Arial,sans-serif;text-align:center}
.b{max-width:460px;padding:30px}h1{margin:0 0 8px;font-size:24px;color:#ff5577}p{color:#c9b3b9}code{display:block;margin:14px 0;padding:10px;border-radius:8px;background:rgba(255,255,255,.06);color:#fff}
a{display:inline-block;margin:8px 6px 0;padding:9px 18px;border-radius:8px;text-decoration:none;font-weight:600}.q{background:#ff5577;color:#12060a}.r{box-shadow:inset 0 0 0 1px #ff5577;color:#ff5577}</style>
<div class="b"><h1>KRH Client is locked</h1><p>KRH Client is a fair-play client. It found cheat software, so the game, the dashboard and the KRH website are switched off.</p><code>${esc}</code>
<p>Close the cheat software and remove cheat scripts, then press Check again.</p><a class="r" href="krh-lock://recheck">Check again</a><a class="q" href="krh-lock://quit">Quit</a></div>`);
}
