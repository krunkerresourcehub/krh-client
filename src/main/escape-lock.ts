// ── Escape without the 2 s wait (main process half) ──
// Adapted from NM/NZ Client (GPL-3.0-or-later), src/main/index.ts (takeEscape / syncEscapeShortcut).
// See src/shared/escape-lock.ts for the whole story.
//
// While the game holds the mouse and its window is focused, Escape is registered as a global shortcut so Windows
// consumes it before Chromium counts it as "the user left pointer lock". The lock is then released from here at
// once. The shortcuts exist only for that long, so no other application ever loses the Escape key.

import { BrowserWindow, globalShortcut, ipcMain, WebContents } from 'electron';
import { ESCAPE_ACCELERATORS, stepEscape, stillHolding, wantEscapeShortcut } from '../shared/escape-lock';
import { isKrunkerPage } from './links';
import { electronLog } from './logger';

interface EscapeState { pageLocked: boolean; holdingSince: number | null }

const NO_ESCAPE: EscapeState = { pageLocked: false, holdingSince: null };
const escapeState = new WeakMap<WebContents, EscapeState>();

let enabled = true;
let gameContents: WebContents | null = null;
/** Whose Escape the OS shortcut is taking right now, if anyone's. */
let shortcutOwner: WebContents | null = null;
/** Which of ESCAPE_ACCELERATORS the OS actually let us have, to give back. */
let shortcutsHeld: string[] = [];

function sync(contents: WebContents): void {
  const win = contents.isDestroyed() ? null : BrowserWindow.fromWebContents(contents);
  const want = enabled && wantEscapeShortcut({
    pageLocked: (escapeState.get(contents) ?? NO_ESCAPE).pageLocked,
    focused: win !== null && !win.isDestroyed() && win.isFocused(),
  });

  if (want && shortcutOwner === null) {
    // Each register() is false if something else on the machine already holds that combination (or the platform,
    // e.g. Wayland, does not allow global shortcuts). The rest still work and the in-page fallback is still there,
    // so a missing one is a slower Escape, not a broken one.
    for (const accelerator of ESCAPE_ACCELERATORS) {
      try {
        if (globalShortcut.register(accelerator, () => takeEscape(contents))) shortcutsHeld.push(accelerator);
      } catch { /* not allowed on this platform */ }
    }
    if (shortcutsHeld.length > 0) shortcutOwner = contents;
  } else if (!want && shortcutOwner !== null) {
    releaseEscapeShortcut();
  }
}

export function releaseEscapeShortcut(): void {
  if (shortcutOwner === null) return;
  for (const accelerator of shortcutsHeld) {
    try { globalShortcut.unregister(accelerator); } catch { /* already gone */ }
  }
  shortcutsHeld = [];
  shortcutOwner = null;
}

/**
 * Let go of the mouse for an Escape the OS took, before its keyUp can arrive. Taking page focus away unlocks the
 * pointer synchronously with no refusal attached (the route Alt-Tab takes); focus goes straight back and the native
 * window never loses it. The page is asked to release as well, in case the lock is somewhere a blur does not reach.
 */
function takeEscape(contents: WebContents): void {
  if (contents.isDestroyed()) return;
  const prev = escapeState.get(contents) ?? NO_ESCAPE;
  // The OS took the keyDown, so before-input-event never saw it: mark the press held so its repeats and keyUp go with it.
  escapeState.set(contents, { ...prev, holdingSince: Date.now() });
  const win = BrowserWindow.fromWebContents(contents);
  if (win && !win.isDestroyed()) {
    win.blurWebView();
    win.focusOnWebView();
  }
  contents.send('krh-release-pointer-lock');
}

/** The settings switch ("Fast Escape"). Turning it off gives the Escape key back at once. */
export function setEscapeFastRelease(on: boolean): void {
  enabled = on;
  if (gameContents && !gameContents.isDestroyed()) sync(gameContents);
  else if (!on) releaseEscapeShortcut();
}

/** Hook the game window up. Call once, right after the window exists. */
export function installEscapeLock(win: BrowserWindow, on: boolean): void {
  enabled = on;
  gameContents = win.webContents;
  ipcMain.on('krh-escape-releases-lock', (event, value: unknown) => {
    if (event.sender !== win.webContents) return;
    // A page that is not the game has no business deciding what Escape does.
    if (!isKrunkerPage(event.senderFrame?.url ?? '')) return;
    const prev = escapeState.get(event.sender) ?? NO_ESCAPE;
    const locked = value === true;
    // Taking the mouse again means any earlier press is long over.
    escapeState.set(event.sender, { pageLocked: locked, holdingSince: locked ? null : prev.holdingSince });
    sync(event.sender);
  });
  win.on('focus', () => sync(win.webContents));
  win.on('blur', () => sync(win.webContents));
  win.on('hide', () => releaseEscapeShortcut());
  win.on('closed', () => { releaseEscapeShortcut(); gameContents = null; });
  electronLog.log('[KRH] Fast Escape ready');
}

/**
 * First thing in the game window's before-input-event. Returns true when the event was dealt with here
 * (a taken Escape press, including its repeats and keyUp) and nothing else should look at it.
 */
export function handleEscapeInput(
  contents: WebContents,
  event: { preventDefault: () => void },
  input: { type: string; key: string; control: boolean; alt: boolean; shift: boolean; meta: boolean },
): boolean {
  if (!enabled) return false;
  const state = escapeState.get(contents) ?? NO_ESCAPE;
  const now = Date.now();
  const step = stepEscape(input, state.pageLocked, stillHolding(state.holdingSince, now));
  // Refreshed on every event of a held press, so only silence expires it.
  escapeState.set(contents, { pageLocked: state.pageLocked, holdingSince: step.holding ? now : null });
  if (step.action === 'pass') return false;
  event.preventDefault();
  if (step.action === 'release') contents.send('krh-release-pointer-lock');
  return true;
}
