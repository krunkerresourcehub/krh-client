/*
 * Adapted from NM/NZ Client (https://github.com/nmallik1029/nm-nez-client), src/preload/hud/perf-hud.ts.
 * NM/NZ Client is GPL-3.0-or-later, like KRH Client. See THIRD_PARTY_NOTICES.md.
 * Changes: KRH style injection, key handling and settings wrapper.
 */

// ── Frame-time HUD ──
// FPS plus the 1% and 0.1% lows, in a corner of the screen, toggled with a key (F10 by default). It samples every
// frame but paints four times a second, never touches innerHTML, and stops its animation loop while hidden, so it
// costs nothing when off. See frame-stats.ts for what the lows mean.

import { FrameStats } from './frame-stats';

export type HudCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export interface PerfHudOptions { key: string; corner: HudCorner; detail: 'fps' | 'full'; startOn: boolean }

const ID = 'krh-perf-hud';
const STYLE_ID = 'krh-perf-hud-style';
const REPAINT_MS = 250;
const CSS = `
#${ID}{position:fixed;z-index:2147483000;display:none;padding:4px 8px;border-radius:4px;background:rgba(0,0,0,.55);color:#fff;font:600 12px/1.35 ui-monospace,Consolas,monospace;white-space:pre;pointer-events:none;text-shadow:0 1px 2px #000}
#${ID}.on{display:block}
#${ID}.top-left{top:8px;left:8px}#${ID}.top-right{top:8px;right:8px}
#${ID}.bottom-left{bottom:8px;left:8px}#${ID}.bottom-right{bottom:8px;right:8px}
`;

const stats = new FrameStats(1000);
let options: PerfHudOptions = { key: 'F10', corner: 'top-left', detail: 'full', startOn: false };
let root: HTMLElement | null = null;
let visible = false;
let raf: number | null = null;
let lastTime = 0;
let lastPaint = 0;
let keyHooked = false;

function ensureRoot(): HTMLElement {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head ?? document.documentElement).appendChild(style);
  }
  if (!root) { root = document.createElement('div'); root.id = ID; }
  if (!root.isConnected) document.documentElement.appendChild(root);
  root.className = `${options.corner}${visible ? ' on' : ''}`;
  return root;
}

function paint(): void {
  if (!root) return;
  const s = stats.snapshot();
  if (options.detail === 'fps') { root.textContent = `${Math.round(s.fps)} FPS`; return; }
  // Lows read 0 until the window can support the percentile: a dash, not a zero that is not true.
  const low1 = s.low1 > 0 ? String(Math.round(s.low1)) : '--';
  const low01 = s.low01 > 0 ? String(Math.round(s.low01)) : '--';
  root.textContent = `${Math.round(s.fps)} FPS   ${s.frameTimeMs.toFixed(1)} ms\n1%  ${low1}      0.1%  ${low01}`;
}

function frame(now: number): void {
  if (lastTime !== 0) stats.push(now - lastTime);
  lastTime = now;
  if (now - lastPaint >= REPAINT_MS) { lastPaint = now; paint(); }
  raf = requestAnimationFrame(frame);
}

function show(): void {
  if (visible) return;
  visible = true;
  ensureRoot();
  stats.reset();
  lastTime = 0;
  lastPaint = 0;
  if (root) root.textContent = '-- FPS';
  raf = requestAnimationFrame(frame);
}

function hide(): void {
  if (!visible) return;
  visible = false;
  // The loop is stopped while hidden: leaving it up would wake the renderer every frame for numbers nobody sees.
  if (raf !== null) cancelAnimationFrame(raf);
  raf = null;
  root?.classList.remove('on');
}

export function setPerfHud(next: PerfHudOptions): void {
  const first = !keyHooked;
  options = next;
  if (first) {
    keyHooked = true;
    window.addEventListener('keydown', (e) => {
      if (e.repeat || !options.key.trim() || e.key.toLowerCase() !== options.key.trim().toLowerCase()) return;
      e.preventDefault();
      if (visible) hide(); else show();
    }, true);
    if (next.startOn) show();
  }
  if (root) root.className = `${options.corner}${visible ? ' on' : ''}`;
  if (visible) paint();
}
