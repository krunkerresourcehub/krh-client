// ── Background updates ──
// Update mode "background": nothing is asked at launch. A few seconds after the client is up it checks for a
// new version, downloads the installer quietly (same host and SHA-256 checks as the launch update), and then
// offers "Restart to update" in three places: a badge in the KRH Hub window, a system notification and a
// toast in the game. Optionally the installer also runs by itself, silently, when the client is closed.
// Windows installer builds only; other builds keep the notice at launch.

import { app, BrowserWindow, Notification } from 'electron';
import { existsSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { checkForUpdate, downloadUpdate, installUpdate } from './updater';
import { electronLog } from './logger';

const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const BADGE_ID = 'krh-update-badge';
const BADGE_SIGNAL = 'KRH_UPDATE:install';

export interface ReadyUpdate { version: string; path: string }

export interface UpdateManagerDeps {
  appVersion: string;
  /** Current settings, read fresh each time. */
  settings: () => { mode: 'ask' | 'background'; installOnQuit: boolean };
  skippedVersion: () => string;
  hub: () => BrowserWindow | null;
  toastGame: (msg: string) => void;
}

let deps: UpdateManagerDeps | null = null;
let ready: ReadyUpdate | null = null;
let busy = false;
let installStarted = false;
let firstTimer: ReturnType<typeof setTimeout> | null = null;
let loopTimer: ReturnType<typeof setInterval> | null = null;

export function getReadyUpdate(): ReadyUpdate | null { return ready; }

function badgeScript(version: string): string {
  const label = `Update v${version} ready — Restart to update`;
  return `(() => {
    if (document.getElementById(${JSON.stringify(BADGE_ID)})) return;
    const b = document.createElement('button');
    b.id = ${JSON.stringify(BADGE_ID)};
    b.type = 'button';
    b.textContent = ${JSON.stringify('\u2B07  ' + label)};
    b.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;padding:10px 16px;border-radius:999px;' +
      'border:1px solid rgba(120,190,255,0.55);background:linear-gradient(90deg,#1f6fe0,#38c8ff);color:#fff;' +
      'font:600 13px "Segoe UI",system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 28px rgba(31,111,224,0.5);';
    b.addEventListener('click', () => console.log(${JSON.stringify(BADGE_SIGNAL)}));
    (document.body || document.documentElement).appendChild(b);
  })()`;
}

export function showBadge(): void {
  if (!ready || !deps) return;
  const hub = deps.hub();
  if (!hub || hub.isDestroyed() || hub.webContents.isDestroyed()) return;
  hub.webContents.executeJavaScript(badgeScript(ready.version)).catch(() => { /* page not ready: re-injected on load */ });
}

/** Wire the hub window once: re-adds the badge after page loads and reacts to its click. */
export function wireHubBadge(hub: BrowserWindow): void {
  hub.webContents.on('did-finish-load', () => showBadge());
  hub.webContents.on('console-message', (...args: unknown[]) => {
    let message = '';
    for (const a of args) {
      if (typeof a === 'string' && a === BADGE_SIGNAL) message = a;
      else if (a && typeof a === 'object' && (a as { message?: unknown }).message === BADGE_SIGNAL) message = BADGE_SIGNAL;
    }
    if (message === BADGE_SIGNAL) installReadyUpdate();
  });
}

/** Run the downloaded installer now (the normal installer window) and quit. */
export function installReadyUpdate(): boolean {
  if (!ready || installStarted) return false;
  installStarted = true;
  electronLog.log('[KRH-Update] Restart to update chosen, installing v' + ready.version);
  installUpdate(ready.path);
  return true;
}

/** Called at shutdown: silent install when the user asked for it. Never blocks the quit. */
export function installOnQuitIfWanted(): void {
  if (!ready || installStarted || !deps) return;
  if (!deps.settings().installOnQuit) return;
  installStarted = true;
  try {
    electronLog.log('[KRH-Update] Installing v' + ready.version + ' silently after quit');
    const child = spawn(ready.path, ['/S'], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    electronLog.warn('[KRH-Update] Silent install on quit failed:', (err as Error).message);
  }
}

async function cycle(): Promise<void> {
  if (!deps || busy || ready) return;
  const s = deps.settings();
  if (s.mode !== 'background') return;
  busy = true;
  try {
    const update = await checkForUpdate(deps.appVersion);
    if (!update || update.version === deps.skippedVersion()) return;
    const dir = join(app.getPath('temp'), 'krh-update');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, `KRH-${update.version}-Setup.exe`);
    electronLog.log(`[KRH-Update] Background download of v${update.version}`);
    // The file only gets its final name after the SHA-256 check passed (see downloadUpdate).
    await downloadUpdate(update.downloadUrl, path, () => { /* silent */ }, update.sha256);
    ready = { version: update.version, path };
    electronLog.log(`[KRH-Update] v${update.version} downloaded and verified`);
    showBadge();
    deps.toastGame(`Update v${update.version} is ready. Open the KRH Hub and press "Restart to update".`);
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'KRH Client update ready',
        body: `Version ${update.version} was downloaded. Click to restart and install it.`,
        silent: true,
      });
      n.on('click', () => installReadyUpdate());
      n.show();
    }
  } catch (err) {
    electronLog.warn('[KRH-Update] Background update failed (will retry later):', (err as Error).message);
  } finally {
    busy = false;
  }
}

/** Start the schedule. Does nothing outside Windows installer builds. */
export function startBackgroundUpdates(d: UpdateManagerDeps, supported: boolean): void {
  deps = d;
  if (!supported) return;
  if (firstTimer) clearTimeout(firstTimer);
  if (loopTimer) clearInterval(loopTimer);
  firstTimer = setTimeout(() => { void cycle(); }, FIRST_CHECK_MS);
  loopTimer = setInterval(() => { void cycle(); }, CHECK_EVERY_MS);
  firstTimer.unref?.();
  loopTimer.unref?.();
}

/** Settings changed (e.g. switched to background mode while running): look right away. */
export function pokeBackgroundUpdates(): void {
  if (deps && !ready && !busy) void cycle();
}
