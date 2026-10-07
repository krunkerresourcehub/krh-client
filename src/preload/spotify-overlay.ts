// ── Spotify now-playing overlay ──
// Small card (album art, title, artist, progress bar) on top of the game. The Spotify connection, polling
// and controls all live in the main process (src/main/spotify.ts); this file only draws what it sends.
// All track text is written with textContent, never as HTML. While the mouse is free (pointer lock
// released) previous / play-pause / next buttons appear on the card; Ctrl+Alt+B / P / N work any time.

import { ipcRenderer } from 'electron';
import { savedConsole as _console } from './saved-console';

export interface SpotifyOverlayConfig {
  enabled: boolean;
  clientId: string;
  showArt: boolean;
  showProgress: boolean;
  hideWhenIdle: boolean;
  scale: number;
  x: number;           // % of screen width (centre of the card)
  y: number;           // % of screen height (top edge)
  background: number;
  ignoreLive?: boolean;   // main process only (media-session filter)
  ignoreWords?: string;  // 0 - 1
}

interface Track { id: string; title: string; artist: string; album: string; artUrl: string; playing: boolean; progressMs: number; durationMs: number; at: number }
interface State { connected: boolean; track: Track | null }

const STYLE_ID = 'krh-spotify-css';
const EL_ID = 'krh-spotify';
const REATTACH_MS = 2000;
const BAR_MS = 500;
const NOTICE_MS = 4000;

const ICON_PREV = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 6h2v12H6zM9.5 12 18 18V6z"/></svg>';
const ICON_NEXT = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

const CSS = `
#${EL_ID} {
  position: absolute;
  z-index: 9;
  pointer-events: none;
  display: none;
  flex-direction: column;
  gap: 6px;
  width: 280px;
  padding: 8px;
  box-sizing: border-box;
  border-radius: 8px;
  background: rgba(0, 0, 0, var(--krh-sp-bg, 0.45));
  color: #fff;
  font-size: 14px;
  line-height: 1.25;
  transform-origin: top center;
  text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.8);
}
#${EL_ID}.krh-sp-on { display: flex; }
#${EL_ID}.krh-sp-hidden { display: none; }
#${EL_ID}.krh-sp-free { z-index: 2147483000; }
#${EL_ID} .krh-sp-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
#${EL_ID} .krh-sp-art { flex: none; width: 48px; height: 48px; border-radius: 4px; background: #222; object-fit: cover; }
#${EL_ID}.krh-sp-noart .krh-sp-art { display: none; }
#${EL_ID} .krh-sp-info { min-width: 0; flex: 1; }
#${EL_ID} .krh-sp-title { font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${EL_ID} .krh-sp-artist { opacity: 0.8; font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${EL_ID} .krh-sp-bar { height: 3px; border-radius: 2px; background: rgba(255, 255, 255, 0.2); overflow: hidden; }
#${EL_ID}.krh-sp-nobar .krh-sp-bar { display: none; }
#${EL_ID} .krh-sp-bar i { display: block; height: 100%; width: 0; background: #1ed760; }
#${EL_ID} .krh-sp-notice { font-size: 0.85em; color: #ffd27a; }
#${EL_ID} .krh-sp-ctl { display: none; justify-content: center; gap: 6px; }
#${EL_ID}.krh-sp-free .krh-sp-ctl { display: flex; }
#${EL_ID} .krh-sp-ctl button {
  pointer-events: auto;
  cursor: pointer;
  width: 34px; height: 26px;
  border: 0; border-radius: 4px;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  display: grid; place-items: center;
  padding: 0;
}
#${EL_ID} .krh-sp-ctl button:hover { background: rgba(30, 215, 96, 0.55); }
`;

let cfg: SpotifyOverlayConfig | null = null;
let state: State = { connected: false, track: null };
let styleEl: HTMLStyleElement | null = null;
let overlayEl: HTMLElement | null = null;
let artEl: HTMLImageElement | null = null;
let titleEl: HTMLElement | null = null;
let artistEl: HTMLElement | null = null;
let barEl: HTMLElement | null = null;
let noticeEl: HTMLElement | null = null;
let playBtn: HTMLElement | null = null;
let tick: ReturnType<typeof setInterval> | null = null;
let barTick: ReturnType<typeof setInterval> | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let hiddenByUser = false;
let listenersReady = false;
let shownArtUrl = '';

const artCache = new Map<string, Promise<string | null>>();

function loadArt(url: string): Promise<string | null> {
  let p = artCache.get(url);
  if (!p) {
    p = ipcRenderer.invoke('spotify-art', url).then((d: unknown) => (typeof d === 'string' ? d : null)).catch(() => null);
    artCache.set(url, p);
    if (artCache.size > 20) {
      const oldest = artCache.keys().next().value;
      if (oldest !== undefined) artCache.delete(oldest);
    }
  }
  return p;
}

function hostParent(): HTMLElement {
  return document.getElementById('inGameUI') || document.getElementById('uiBase') || document.body;
}

function button(icon: string, title: string, action: 'previous' | 'toggle' | 'next'): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = title;
  b.innerHTML = icon; // static icon constants only
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    ipcRenderer.send('spotify-control', action);
  });
  return b;
}

function build(): HTMLElement {
  const el = document.createElement('div');
  el.id = EL_ID;

  const row = document.createElement('div');
  row.className = 'krh-sp-row';
  artEl = document.createElement('img');
  artEl.className = 'krh-sp-art';
  artEl.draggable = false;
  artEl.alt = '';
  const info = document.createElement('div');
  info.className = 'krh-sp-info';
  titleEl = document.createElement('div');
  titleEl.className = 'krh-sp-title';
  artistEl = document.createElement('div');
  artistEl.className = 'krh-sp-artist';
  info.append(titleEl, artistEl);
  row.append(artEl, info);

  const bar = document.createElement('div');
  bar.className = 'krh-sp-bar';
  barEl = document.createElement('i');
  bar.appendChild(barEl);

  noticeEl = document.createElement('div');
  noticeEl.className = 'krh-sp-notice';
  noticeEl.style.display = 'none';

  const ctl = document.createElement('div');
  ctl.className = 'krh-sp-ctl';
  playBtn = button(ICON_PLAY, 'Play / pause (Ctrl+Alt+P)', 'toggle');
  ctl.append(button(ICON_PREV, 'Previous (Ctrl+Alt+B)', 'previous'), playBtn, button(ICON_NEXT, 'Next (Ctrl+Alt+N)', 'next'));

  el.append(row, bar, noticeEl, ctl);
  return el;
}

function applyConfig(): void {
  if (!overlayEl || !cfg) return;
  const clamp = (v: unknown, lo: number, hi: number, d: number): number => Math.min(hi, Math.max(lo, Number(v) || d));
  overlayEl.style.left = clamp(cfg.x, 0, 100, 50) + '%';
  overlayEl.style.top = clamp(cfg.y, 0, 100, 1.5) + '%';
  overlayEl.style.transform = 'translateX(-50%) scale(' + clamp(cfg.scale, 0.5, 3, 1) + ')';
  overlayEl.style.setProperty('--krh-sp-bg', String(clamp(cfg.background, 0, 1, 0.45)));
  overlayEl.classList.toggle('krh-sp-noart', !cfg.showArt || !state.track || !state.track.artUrl);
  overlayEl.classList.toggle('krh-sp-nobar', !cfg.showProgress);
  overlayEl.classList.toggle('krh-sp-hidden', hiddenByUser);
  overlayEl.classList.toggle('krh-sp-free', !document.pointerLockElement);
}

function inject(): void {
  if (!cfg) return;
  if (overlayEl && overlayEl.isConnected) return;
  overlayEl = build();
  shownArtUrl = '';
  hostParent().appendChild(overlayEl);
  applyConfig();
  render();
}

function render(): void {
  if (!overlayEl || !cfg || !titleEl || !artistEl || !artEl || !playBtn) return;
  const t = state.track;
  const visible = state.connected && (t !== null || !cfg.hideWhenIdle);
  overlayEl.classList.toggle('krh-sp-on', visible);
  if (!visible) return;
  titleEl.textContent = t ? t.title : 'Nothing playing';
  artistEl.textContent = t ? t.artist : 'Play a song in Spotify (app or browser)';
  overlayEl.classList.toggle('krh-sp-noart', !cfg.showArt || !t || !t.artUrl);
  playBtn.innerHTML = t && t.playing ? ICON_PAUSE : ICON_PLAY;
  const url = t ? t.artUrl : '';
  if (url !== shownArtUrl) {
    shownArtUrl = url;
    artEl.removeAttribute('src');
    if (url) {
      void loadArt(url).then((data) => {
        if (data && shownArtUrl === url && artEl) artEl.src = data;
      });
    }
  }
  updateBar();
}

function updateBar(): void {
  if (!barEl) return;
  const t = state.track;
  if (!t || t.durationMs <= 0) { barEl.style.width = '0'; return; }
  const elapsed = t.progressMs + (t.playing ? Date.now() - t.at : 0);
  barEl.style.width = Math.min(100, Math.max(0, (elapsed / t.durationMs) * 100)).toFixed(1) + '%';
}

function showNotice(text: string): void {
  if (!noticeEl || !overlayEl) return;
  noticeEl.textContent = text;
  noticeEl.style.display = '';
  overlayEl.classList.add('krh-sp-on'); // show the card even when idle so the message is seen
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    if (noticeEl) noticeEl.style.display = 'none';
    render();
  }, NOTICE_MS);
}

function setupListeners(): void {
  if (listenersReady) return;
  listenersReady = true;
  ipcRenderer.on('spotify-state', (_e, s: State) => {
    state = s;
    if (cfg && cfg.enabled) render();
  });
  ipcRenderer.on('spotify-notice', (_e, text: string) => {
    if (cfg && cfg.enabled && typeof text === 'string') showNotice(text);
  });
  ipcRenderer.on('spotify-toggle', () => {
    hiddenByUser = !hiddenByUser;
    applyConfig();
  });
  document.addEventListener('pointerlockchange', () => {
    if (overlayEl) overlayEl.classList.toggle('krh-sp-free', !document.pointerLockElement);
  });
}

export function setSpotifyOverlay(conf: SpotifyOverlayConfig): void {
  if (!conf.enabled) { destroySpotifyOverlay(); return; }
  cfg = { ...conf };
  setupListeners();
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }
  inject();
  applyConfig();
  render();
  // Polling (not MutationObserver) on purpose, same as the other overlays: observers on the main frame hang WebGL.
  if (!tick) tick = setInterval(() => { if (overlayEl && !overlayEl.isConnected) inject(); }, REATTACH_MS);
  if (!barTick) barTick = setInterval(updateBar, BAR_MS);
  // The main process may already have a state from before this page loaded.
  void ipcRenderer.invoke('spotify-get-state').then((s: State | undefined) => {
    if (s && typeof s === 'object') { state = s; render(); }
  }).catch((err) => _console.warn('[KRH-Spotify] state fetch failed:', err));
}

export function destroySpotifyOverlay(): void {
  if (tick) { clearInterval(tick); tick = null; }
  if (barTick) { clearInterval(barTick); barTick = null; }
  if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  if (styleEl) { styleEl.remove(); styleEl = null; }
  cfg = null;
}
