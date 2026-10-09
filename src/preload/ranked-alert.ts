// ── Ranked match alert ──
// Idea and element names from Kute (https://github.com/NullDev/Kute, src/frontend/modules/rankedAlert.js), GPL-3.0.
// Written for KRH Client 1.0.1 with its own IPC.
//
// When Krunker's own ranked queue finds a match, its status line under the play buttons reads "Match found!".
// Krunker accepts the match by itself a moment later, so if you are tabbed out you would miss it. This watches
// that line and asks the main process to bring the client to the front (or flash the taskbar).

import { ipcRenderer } from 'electron';

const STATUS = '.ranked-matchmaking-status';
const FOUND = 'Match found!';
const FIND_INTERVAL_MS = 1500;
const FIND_ATTEMPTS = 240; // about six minutes: the line only exists once the menu has rendered it

let enabled = false;
let status: Element | null = null;
let found = false;
let observer: MutationObserver | null = null;
let findTimer: ReturnType<typeof setInterval> | null = null;

// While idle the hidden line already reads "Match found!"; only the .show class makes it real.
function shown(): boolean {
  return Boolean(status?.classList.contains('show')) && status?.textContent === FOUND;
}

function check(): void {
  const now = shown();
  if (now && !found) ipcRenderer.send('krh-ranked-found');
  found = now;
}

function attach(el: Element): void {
  observer?.disconnect();
  status = el;
  // The line ticks once a second while searching; nothing else touches it.
  observer = new MutationObserver(check);
  observer.observe(el, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });
  found = shown();
}

function stopFinding(): void {
  if (findTimer !== null) { clearInterval(findTimer); findTimer = null; }
}

export function setRankedAlert(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  if (!on) {
    stopFinding();
    observer?.disconnect();
    observer = null;
    status = null;
    found = false;
    return;
  }
  const el = document.querySelector(STATUS);
  if (el) { attach(el); return; }
  let attempts = 0;
  findTimer = setInterval(() => {
    const next = document.querySelector(STATUS);
    if (next) { stopFinding(); attach(next); return; }
    if (++attempts > FIND_ATTEMPTS) stopFinding();
  }, FIND_INTERVAL_MS);
}
