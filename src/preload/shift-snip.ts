// ── Tap Shift to snip ──
// Like the Snipping Tool on a PC: a quick tap of Shift starts the area snip (the same one the Screenshot Area
// hotkey starts). Only a clean tap counts: Shift released within a third of a second with no other key or mouse
// button in between, so Shift+F9, capital letters, Shift+click and holding Shift never trigger it. It is ignored
// while the mouse is captured by the game (in a match Shift is sprint / crouch) and while typing in a text field.

import { ipcRenderer } from 'electron';

const TAP_MAX_MS = 300;

let enabled = false;
let installed = false;
let downAt = -1; // -1 = Shift is not down
let dirty = false;

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Shift') {
    if (e.repeat) { dirty = true; return; }
    downAt = performance.now();
    dirty = false;
    return;
  }
  dirty = true; // another key together with Shift: not a tap
}

function typing(): boolean {
  const a = document.activeElement as HTMLElement | null;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.key !== 'Shift' || downAt < 0) return;
  const clean = !dirty && performance.now() - downAt < TAP_MAX_MS;
  downAt = -1;
  dirty = false;
  if (!clean || !enabled) return;
  if (document.pointerLockElement) return; // in a match
  if (typing()) return;
  ipcRenderer.send('krh-snip-request');
}

export function setShiftSnip(on: boolean): void {
  enabled = on;
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('mousedown', () => { dirty = true; }, true);
  window.addEventListener('blur', () => { downAt = -1; dirty = false; });
}
