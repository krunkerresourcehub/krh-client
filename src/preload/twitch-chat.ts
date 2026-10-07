// ── Twitch chat overlay ──
// Read-only chat on top of the game. The connection and message parsing live in the main process
// (src/main/twitch.ts); this file only renders the tokens it sends. User text is only ever written
// with textContent, never as HTML.
//
// Select + copy: while the mouse is free (pointer lock released, e.g. after Esc, in menus or when
// spectating) the messages can be dragged over with the mouse like normal text (blue highlight) and
// copied with Ctrl+C, and the list can be scrolled back. While you are aiming the overlay stays
// click-through. Copied text looks like "name: message" (badges dropped, emotes copied as their names).
// Messages never fade away (like the in-game chat); only the oldest ones are dropped once the list is full.
//
// Placement: with `autoPlace` (default) the overlay sits right below the score boxes (top-left HUD) and
// ends above the in-game chat, so it can never cover the game chat or the HUD. Without it the
// manual X / Y position is used.

import { ipcRenderer } from 'electron';
import { savedConsole as _console } from './saved-console';

export interface TwitchChatConfig {
  enabled: boolean;
  channel: string;
  showBadges: boolean;
  showHeader: boolean;
  thirdPartyEmotes: boolean;
  fontSize: number;
  width: number;
  height: number;
  x: number;           // % of screen width (left edge)
  y: number;           // % of screen height (top edge)
  background: number;  // 0 - 1
  autoPlace: boolean;  // sit next to the in-game chat instead of using x / y
  linkCommand?: boolean;   // answer !link (handled in the main process, only stored here)
  linkOnlyLive?: boolean;
}

type Token = { t: 'text'; v: string } | { t: 'emote'; url: string; name: string };
interface ChatMessage { id: string; user: string; color: string; badges: string[]; action: boolean; tokens: Token[] }
interface StreamInfo { channel: string; name: string; live: boolean; viewers: number; game: string }
interface ChatStatus { state: 'connecting' | 'connected' | 'disconnected'; channel: string; detail?: string }

const STYLE_ID = 'krh-twitch-css';
const EL_ID = 'krh-twitch-chat';
const MAX_MESSAGES = 150;
const REATTACH_MS = 2000;

const BADGE_LABELS: Record<string, string> = {
  broadcaster: 'LIVE', moderator: 'MOD', vip: 'VIP', subscriber: 'SUB', founder: 'FND',
  staff: 'STAFF', admin: 'ADMIN', global_mod: 'GMOD', partner: 'PRT', verified: 'VER',
};

const CSS = `
#${EL_ID} {
  position: absolute;
  z-index: 9;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  overflow: hidden;
  color: #fff;
  line-height: 1.35;
  word-break: break-word;
  text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.9);
}
#${EL_ID} .krh-tw-list {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding-bottom: 4px;
}
#${EL_ID} .krh-tw-list > :first-child { margin-top: auto; }
#${EL_ID}.krh-tw-free .krh-tw-list {
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.35) transparent;
}
#${EL_ID} .krh-tw-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 7px;
  line-height: 1.5;
  border-radius: 4px;
  background: rgba(0, 0, 0, calc(var(--krh-tw-bg, 0.35) + 0.25));
  border-left: 3px solid #9146ff;
  white-space: nowrap;
  overflow: hidden;
}
#${EL_ID} .krh-tw-head.krh-tw-nohead { display: none; }
/* padding-bottom keeps the tails of g / j / p / q / y inside the clipped box (they were cut off before) */
#${EL_ID} .krh-tw-head-name { font-weight: bold; overflow: hidden; text-overflow: ellipsis; padding-bottom: 4px; margin-bottom: -4px; }
#${EL_ID} .krh-tw-head-site { color: #b794ff; font-size: 0.8em; }
#${EL_ID} .krh-tw-head-status {
  margin-left: auto;
  flex: none;
  padding: 0 6px;
  border-radius: 3px;
  font-size: 0.75em;
  font-weight: bold;
  text-shadow: none;
  background: #5c5c66;
}
#${EL_ID} .krh-tw-head-status.krh-tw-live { background: #e91916; }
#${EL_ID}.krh-tw-hidden { display: none; }
#${EL_ID}.krh-tw-free { z-index: 2147483000; }
#${EL_ID}.krh-tw-free .krh-tw-msg { pointer-events: auto; cursor: text; }
#${EL_ID}, #${EL_ID} * {
  -webkit-user-select: text !important;
  user-select: text !important;
}
#${EL_ID} .krh-tw-badge { -webkit-user-select: none !important; user-select: none !important; }
#${EL_ID} ::selection { background: #2f7bff; color: #fff; text-shadow: none; }
#${EL_ID} .krh-tw-msg {
  flex: none;
  margin-top: 2px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, var(--krh-tw-bg, 0.35));
}
#${EL_ID} .krh-tw-sys { opacity: 0.7; font-style: italic; }
#${EL_ID} .krh-tw-user { font-weight: bold; }
#${EL_ID} .krh-tw-action { font-style: italic; }
#${EL_ID} .krh-tw-badge {
  display: inline-block;
  margin-right: 4px;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 0.7em;
  font-weight: bold;
  vertical-align: middle;
  text-shadow: none;
  background: #5c5c66;
}
#${EL_ID} .krh-tw-b-broadcaster { background: #e91916; }
#${EL_ID} .krh-tw-b-moderator { background: #00ad03; }
#${EL_ID} .krh-tw-b-vip { background: #e005b9; }
#${EL_ID} .krh-tw-b-subscriber, #${EL_ID} .krh-tw-b-founder { background: #8a4bff; }
#${EL_ID} .krh-tw-b-staff, #${EL_ID} .krh-tw-b-admin, #${EL_ID} .krh-tw-b-global_mod { background: #1f69ff; }
#${EL_ID} img.krh-tw-emote {
  height: 1.7em;
  vertical-align: middle;
  margin: 0 1px;
  -webkit-user-drag: none;
}
`;

let cfg: TwitchChatConfig | null = null;
let styleEl: HTMLStyleElement | null = null;
let overlayEl: HTMLElement | null = null;
let headEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let lastStream: StreamInfo | null = null;
let tick: ReturnType<typeof setInterval> | null = null;
let hiddenByUser = false;
let listenersReady = false;
let lastViewport = '';
let lastChatTop = 0;
let docListenersReady = false;

const imageCache = new Map<string, Promise<string | null>>();

function loadEmote(url: string): Promise<string | null> {
  let p = imageCache.get(url);
  if (!p) {
    p = ipcRenderer.invoke('twitch-emote', url).then((d: unknown) => (typeof d === 'string' ? d : null)).catch(() => null);
    imageCache.set(url, p);
    if (imageCache.size > 500) {
      const oldest = imageCache.keys().next().value;
      if (oldest !== undefined) imageCache.delete(oldest);
    }
  }
  return p;
}

function hostParent(): HTMLElement {
  return document.getElementById('inGameUI') || document.getElementById('uiBase') || document.body;
}

function gameChatRect(): DOMRect | null {
  const el = document.getElementById('chatHolder');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width >= 40 && r.height >= 20 ? r : null;
}

// Bottom edge of the top-left HUD (timer, mode / map info and the team score boxes). The overlay is
// anchored right below it. Known ids first, then a generic scan of the HUD's top-left children so the
// score boxes are found even if Krunker renames them.
const HUD_IDS = ['timerHolder', 'matchInfo', 'mapInfoHld', 'tlInfHold', 'gameNameHolder', 'teamScoresHolder', 'teamScores', 'teamScoreHolder', 'teamScore0', 'teamScore1', 'scoreHolder', 'gameModeScores'];
function hudBottom(): number {
  let bottom = 0;
  const consider = (el: Element | null): void => {
    if (!el || el.id === EL_ID || overlayEl?.contains(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.left < window.innerWidth * 0.5) bottom = Math.max(bottom, r.bottom);
  };
  for (const id of HUD_IDS) consider(document.getElementById(id));
  const host = document.getElementById('inGameUI');
  if (host) {
    for (const el of Array.from(host.children)) {
      if (el.id === EL_ID || el.id === 'chatHolder') continue;
      const r = el.getBoundingClientRect();
      // small things in the upper left corner only (no full-screen wrappers, nothing from the lower half)
      if (r.width > 0 && r.height > 0 && r.width < window.innerWidth * 0.4 && r.height < window.innerHeight * 0.35
        && r.left < window.innerWidth * 0.3 && r.top < window.innerHeight * 0.4) bottom = Math.max(bottom, r.bottom);
    }
  }
  return bottom;
}

// Top edge of everything that belongs to the in-game chat (holder, list and its messages), so the
// overlay never reaches into it even while the chat is filling up.
function gameChatTop(): number | null {
  let top: number | null = null;
  const consider = (el: Element | null): void => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 10) return;
    top = top === null ? r.top : Math.min(top, r.top);
  };
  const holder = document.getElementById('chatHolder');
  consider(holder);
  consider(document.getElementById('chatList'));
  if (holder) for (const c of Array.from(holder.querySelectorAll('.chatItem, #chatList > *')).slice(0, 40)) consider(c);
  return top;
}

// Auto placement: anchored directly under the score boxes, at the left edge of the game chat, and it
// stops above the game chat (with a safety gap), so it covers neither the HUD nor the in-game chat.
function placeAuto(clamp: (v: unknown, lo: number, hi: number, d: number) => number): boolean {
  if (!overlayEl || !cfg) return false;
  const chat = gameChatRect();
  const chatTop = gameChatTop();
  const parent = overlayEl.offsetParent as HTMLElement | null;
  if (!chat || chatTop === null) return false;
  const pr = parent ? parent.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  const gap = 8;
  const chatSafety = 14;
  const left = Math.max(0, chat.left - pr.left);
  const width = Math.min(clamp(cfg.width, 150, 1000, 340), Math.max(150, pr.width - left - 8));
  const top = Math.max(0, hudBottom() - pr.top + gap);
  const limit = chatTop - pr.top - chatSafety;
  const free = limit - top;
  if (free < 60) return false; // no room at all: fall back to the manual position
  const height = Math.min(clamp(cfg.height, 80, 800, 260), free);
  overlayEl.style.left = Math.round(left) + 'px';
  overlayEl.style.top = Math.round(top) + 'px';
  overlayEl.style.width = Math.round(width) + 'px';
  overlayEl.style.height = Math.round(height) + 'px';
  return true;
}

function applyConfig(): void {
  if (!overlayEl || !cfg) return;
  const clamp = (v: unknown, lo: number, hi: number, d: number): number => Math.min(hi, Math.max(lo, Number(v) || d));
  overlayEl.style.fontSize = clamp(cfg.fontSize, 8, 40, 16) + 'px';
  overlayEl.style.setProperty('--krh-tw-bg', String(clamp(cfg.background, 0, 1, 0.35)));
  overlayEl.classList.toggle('krh-tw-hidden', hiddenByUser);
  if (headEl) headEl.classList.toggle('krh-tw-nohead', cfg.showHeader === false);
  overlayEl.classList.toggle('krh-tw-free', !document.pointerLockElement);
  if (!(cfg.autoPlace !== false && placeAuto(clamp))) {
    overlayEl.style.left = clamp(cfg.x, 0, 100, 1) + '%';
    overlayEl.style.top = clamp(cfg.y, 0, 100, 40) + '%';
    overlayEl.style.width = clamp(cfg.width, 150, 1000, 340) + 'px';
    overlayEl.style.height = clamp(cfg.height, 80, 800, 260) + 'px';
  }
}

function inject(): void {
  if (!cfg) return;
  if (overlayEl && overlayEl.isConnected) return;
  const old = overlayEl;
  const oldList = listEl;
  overlayEl = document.createElement('div');
  overlayEl.id = EL_ID;
  headEl = document.createElement('div');
  headEl.className = 'krh-tw-head';
  listEl = document.createElement('div');
  listEl.className = 'krh-tw-list';
  // Scrolling back (only possible while the mouse is free) stops the auto-follow until you scroll to the bottom again.
  listEl.addEventListener('scroll', () => { if (!document.pointerLockElement) pinned = atBottom(); }, { passive: true });
  overlayEl.appendChild(headEl);
  overlayEl.appendChild(listEl);
  // Keep the messages already shown if Krunker rebuilt its UI around us.
  if (old && oldList) while (oldList.firstChild) listEl.appendChild(oldList.firstChild);
  hostParent().appendChild(overlayEl);
  renderHeader();
  applyConfig();
}

function fmtViewers(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K' : String(n);
}

// Header above the chat: "twitch  channel  [LIVE 123]" (or OFFLINE). Text only, never HTML.
function renderHeader(): void {
  if (!headEl || !cfg) return;
  headEl.textContent = '';
  const site = document.createElement('span');
  site.className = 'krh-tw-head-site';
  site.textContent = 'twitch';
  const name = document.createElement('span');
  name.className = 'krh-tw-head-name';
  name.textContent = lastStream?.name || cfg.channel;
  const status = document.createElement('span');
  status.className = 'krh-tw-head-status';
  if (!lastStream) {
    status.textContent = '…';
  } else if (lastStream.live) {
    status.classList.add('krh-tw-live');
    status.textContent = 'LIVE ' + fmtViewers(lastStream.viewers);
    if (lastStream.game) name.title = lastStream.game;
  } else {
    status.textContent = 'OFFLINE';
  }
  headEl.append(site, name, status);
}

// A message is "held" while the mouse is over it or it is part of the selection, so it is never
// removed from under you while you are copying it.
function isHeld(row: HTMLElement): boolean {
  if (row.matches(':hover')) return true;
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.containsNode(row, true);
}

function trim(): void {
  if (!listEl) return;
  let guard = 0;
  while (listEl.childElementCount > MAX_MESSAGES && guard++ < 50) {
    const first = listEl.firstElementChild as HTMLElement | null;
    if (!first || isHeld(first)) break;
    first.remove();
  }
}

let pinned = true; // follow the newest message (set false only when you scroll back with the mouse free)

function atBottom(): boolean {
  return !listEl || listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 24;
}

function stickToBottom(): void {
  if (listEl) listEl.scrollTop = listEl.scrollHeight;
}

function addSystem(text: string): void {
  if (!listEl) return;
  const row = document.createElement('div');
  row.className = 'krh-tw-msg krh-tw-sys';
  row.textContent = text;
  listEl.appendChild(row);
  trim();
  if (pinned || document.pointerLockElement) stickToBottom();
}

function addMessage(m: ChatMessage): void {
  if (!cfg || !listEl) return;
  const row = document.createElement('div');
  row.className = 'krh-tw-msg';

  if (cfg.showBadges) {
    for (const b of m.badges) {
      const label = BADGE_LABELS[b];
      if (!label) continue;
      const badge = document.createElement('span');
      badge.className = 'krh-tw-badge krh-tw-b-' + b;
      badge.textContent = label;
      row.appendChild(badge);
    }
  }

  const user = document.createElement('span');
  user.className = 'krh-tw-user';
  user.style.color = m.color || '#b9a8ff';
  user.textContent = m.user;
  row.appendChild(user);
  row.appendChild(document.createTextNode(m.action ? ' ' : ': '));

  const body = document.createElement('span');
  if (m.action) {
    body.className = 'krh-tw-action';
    body.style.color = m.color || '#b9a8ff';
  }
  for (const tok of m.tokens) {
    if (tok.t === 'text') {
      body.appendChild(document.createTextNode(tok.v));
    } else {
      const holder = document.createElement('span');
      holder.textContent = tok.name;
      body.appendChild(holder);
      void loadEmote(tok.url).then((data) => {
        if (!data || !holder.isConnected) return;
        const img = document.createElement('img');
        img.className = 'krh-tw-emote';
        img.alt = tok.name;
        img.draggable = false;
        // Emotes arrive after the row was added and make it taller: keep following the newest message.
        img.onload = () => { if (pinned || document.pointerLockElement) stickToBottom(); };
        img.src = data;
        holder.replaceWith(img);
        if (pinned || document.pointerLockElement) stickToBottom();
      });
    }
  }
  row.appendChild(body);

  listEl.appendChild(row);
  trim();
  if (pinned || document.pointerLockElement) stickToBottom();
}

function nodeText(n: Node): string {
  if (n.nodeType === Node.TEXT_NODE) return n.nodeValue || '';
  if (n.nodeType !== Node.ELEMENT_NODE && n.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return '';
  const el = n as Element;
  if (el.classList?.contains('krh-tw-badge')) return '';
  if (el.tagName === 'IMG') return el.classList.contains('krh-tw-emote') ? (el as HTMLImageElement).alt : '';
  let out = '';
  for (const c of Array.from(n.childNodes)) out += nodeText(c);
  if (el.classList?.contains('krh-tw-msg')) out += '\n';
  return out;
}

/** Plain text of the current selection if it lives inside the chat overlay, else null. */
function selectedChatText(): string | null {
  const sel = window.getSelection();
  if (!overlayEl || !sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  if (!(sel.anchorNode && overlayEl.contains(sel.anchorNode)) && !(sel.focusNode && overlayEl.contains(sel.focusNode))) return null;
  let text = '';
  for (let i = 0; i < sel.rangeCount; i++) text += nodeText(sel.getRangeAt(i).cloneContents());
  text = text.replace(/\n+$/, '');
  return text || null;
}

function setupDocListeners(): void {
  if (docListenersReady) return;
  docListenersReady = true;

  document.addEventListener('pointerlockchange', () => {
    if (!overlayEl) return;
    overlayEl.classList.toggle('krh-tw-free', !document.pointerLockElement);
    if (document.pointerLockElement) { pinned = true; stickToBottom(); } // back to the newest messages when you aim again
    applyConfig(); // HUD / game chat may have changed size since the last measurement
  });

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resizeTimer = null; applyConfig(); }, 150);
  });

  // The game must not see clicks that land on a chat message (it would e.g. preventDefault the
  // mousedown, which kills text selection). Capture phase on window runs before the game's handlers.
  const swallow = (e: Event): void => {
    if (!overlayEl || document.pointerLockElement) return;
    const t = e.target as Node | null;
    if (t && overlayEl.contains(t)) e.stopImmediatePropagation();
  };
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'selectstart']) {
    window.addEventListener(type, swallow, true);
  }

  // Copy: replace the clipboard text with the clean "name: message" version.
  document.addEventListener('copy', (e) => {
    const text = selectedChatText();
    if (text === null || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  }, true);

  // Ctrl+C fallback in case the game swallows the key before the browser's own copy runs.
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'c') return;
    if (selectedChatText() === null) return;
    e.stopImmediatePropagation();
    try { document.execCommand('copy'); } catch { /* clipboard unavailable */ }
  }, true);
}

function setupListeners(): void {
  if (listenersReady) return;
  listenersReady = true;
  ipcRenderer.on('twitch-message', (_e, m: ChatMessage) => {
    if (!cfg || !cfg.enabled) return;
    try { addMessage(m); } catch (err) { _console.warn('[KRH-Twitch] render failed:', err); }
  });
  ipcRenderer.on('twitch-status', (_e, s: ChatStatus) => {
    if (!cfg || !cfg.enabled) return;
    if (s.state === 'connected') addSystem('Connected to #' + s.channel);
    else if (s.state === 'disconnected' && s.detail) addSystem('Twitch chat disconnected, retrying…');
  });
  ipcRenderer.on('twitch-stream', (_e, s: StreamInfo) => {
    if (!cfg || !cfg.enabled || !s || typeof s.name !== 'string') return;
    lastStream = { channel: String(s.channel), name: s.name, live: !!s.live, viewers: Number(s.viewers) || 0, game: String(s.game || '') };
    renderHeader();
  });
  ipcRenderer.on('twitch-toggle', () => {
    hiddenByUser = !hiddenByUser;
    applyConfig();
  });
}

export function setTwitchChat(conf: TwitchChatConfig): void {
  if (!conf.enabled) { destroyTwitchChat(); return; }
  cfg = { ...conf };
  if (lastStream && !String(cfg.channel).toLowerCase().includes(lastStream.channel)) lastStream = null;
  setupListeners();
  setupDocListeners();
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }
  inject();
  renderHeader();
  applyConfig();
  // Polling (not MutationObserver) on purpose, same as the other overlays: observers on the main frame hang WebGL.
  if (!tick) {
    tick = setInterval(() => {
      if (overlayEl && !overlayEl.isConnected) { inject(); return; }
      // Auto placement follows the in-game chat: re-measure only when the window size changed (no layout reads while aiming otherwise).
      // The in-game chat grows while you play: a single cheap measurement keeps the overlay above it.
      if (document.pointerLockElement) {
        const ct = Math.round(gameChatTop() ?? 0);
        if (Math.abs(ct - lastChatTop) > 4) { lastChatTop = ct; applyConfig(); }
        return;
      }
      const key = window.innerWidth + 'x' + window.innerHeight + ':' + Math.round(hudBottom()) + ':' + Math.round(gameChatTop() ?? 0);
      if (key !== lastViewport) { lastViewport = key; applyConfig(); }
    }, REATTACH_MS);
  }
}

export function destroyTwitchChat(): void {
  if (tick) { clearInterval(tick); tick = null; }
  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  headEl = null;
  listEl = null;
  lastStream = null;
  if (styleEl) { styleEl.remove(); styleEl = null; }
  cfg = null;
}
