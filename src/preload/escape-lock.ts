// ── Escape without the 2 s wait ──
// Adapted from NM/NZ Client (GPL-3.0-or-later), src/preload/escape-lock.ts. See src/shared/escape-lock.ts for why.
//
// Main decides whether to take an Escape press, but only the page knows the two things that decision rests on:
// whether the mouse is locked, and whether something is being typed into. So the page reports the answer whenever
// either changes (pointerlockchange and focus moving) and main keeps the last one. Event-driven, so it costs
// nothing between those events. Typing counts as "not locked" on purpose: Escape in the chat box has to reach the
// page to close the chat box.
//
// When main takes a press it sends a release back and this lets go of the lock from code, the same kind of release
// Alt-Tab produces, which is the one that lets you click straight back in.

import { ipcRenderer } from 'electron';

let reported: boolean | null = null;
let installed = false;

function typing(): boolean {
  const el = document.activeElement;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

function report(): void {
  const take = document.pointerLockElement !== null && !typing();
  if (take === reported) return;
  reported = take;
  ipcRenderer.send('krh-escape-releases-lock', take);
}

export function installEscapeLockRelease(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('pointerlockchange', report);
  document.addEventListener('focusin', report, true);
  // During focusout nothing has been focused yet, so read it once focus lands.
  document.addEventListener('focusout', () => setTimeout(report, 0), true);
  // Main keeps the last answer per page, and Krunker loads each match as a new page that starts unlocked
  // without a pointerlockchange to say so. Reporting once here clears an old page's "locked".
  report();

  ipcRenderer.on('krh-release-pointer-lock', () => {
    if (document.pointerLockElement) document.exitPointerLock();
  });
}
