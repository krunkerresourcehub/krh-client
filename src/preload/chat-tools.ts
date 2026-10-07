// ── Chat filters + Chat Logs ──
// Chat filters: idea from the Water Client (https://github.com/ghostypostie/Water).
// Chat Logs window: idea from the PC7 Client (https://github.com/PC7-Client/PC7-Client).
// Both written from scratch for KRH Client.
//
// Filters: type /players, /kills, /unbox, /server in the in-game chat (or press the filter key) to show only that
// kind of message, /all to show everything again. The command is never sent to the server and hidden messages are
// only hidden with CSS, not deleted.
// Chat Logs: every in-game chat message is remembered (newest 2000); a key opens a window where you can filter,
// search, select / copy and click links while the game chat keeps scrolling.
//
// Only #chatList (a small container) is observed, and only for added children.

import { showToast } from './utils';

export type ChatCategory = 'player' | 'killfeed' | 'unbox' | 'server';

const CATEGORY_LABEL: Record<ChatCategory, string> = { player: 'Players', killfeed: 'Kills', unbox: 'Unboxing', server: 'Server' };
const CATEGORY_ORDER: ChatCategory[] = ['player', 'killfeed', 'server', 'unbox'];
const COMMANDS: Record<string, ChatCategory | 'all'> = {
  '/players': 'player', '/player': 'player',
  '/kills': 'killfeed', '/kill': 'killfeed', '/killfeed': 'killfeed',
  '/unbox': 'unbox', '/unboxes': 'unbox', '/unboxing': 'unbox',
  '/server': 'server', '/system': 'server',
  '/all': 'all',
};
const MAX_LOG = 2000;
const STYLE_ID = 'krh-chat-tools-style';
const ATTR = 'data-krh-cat';

export interface ChatToolsOptions {
  filters: boolean;
  filterKey: string;
  logs: boolean;
  logsKey: string;
}

interface LogEntry { t: number; cat: ChatCategory; text: string }

const log: LogEntry[] = [];
const shown = new Set<ChatCategory>(); // empty = show everything
let opts: ChatToolsOptions = { filters: true, filterKey: 'F3', logs: true, logsKey: 'F1' };
let started = false;

// ── classification ──
function isServerColor(el: Element): boolean {
  const msg = el.querySelector('.chatMsg') as HTMLElement | null;
  const c = ((msg && msg.style.color) || '').replace(/\s+/g, '').toLowerCase();
  return c === '#fc03ec' || c === 'rgb(252,3,236)';
}

function classify(el: HTMLElement): ChatCategory {
  const text = (el.textContent || '').trim();
  if (isServerColor(el) || /(joined|left) the game$|kill streak$/i.test(text)) return 'server';
  if (el.querySelector('img')) return 'killfeed'; // weapon icon between the two names
  const first = el.firstChild;
  if (first && first.childNodes.length > 1) return 'player'; // "name: message"
  const inner = first && (first.firstChild as HTMLElement | null);
  if (inner && inner.childNodes && inner.childNodes.length > 1) return 'unbox';
  return 'server';
}

function tag(el: HTMLElement): ChatCategory {
  const existing = el.getAttribute(ATTR) as ChatCategory | null;
  if (existing) return existing;
  const cat = classify(el);
  el.setAttribute(ATTR, cat);
  return cat;
}

// ── filter state ──
function ensureStyle(): HTMLStyleElement {
  let st = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!st) {
    st = document.createElement('style');
    st.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(st);
  }
  return st;
}

function applyFilter(): void {
  const hidden = shown.size === 0 ? [] : CATEGORY_ORDER.filter((c) => !shown.has(c));
  let css = hidden.map((c) => `#chatList > div[${ATTR}="${c}"] { display: none !important; }`).join('\n');
  css += LOG_CSS;
  ensureStyle().textContent = css;
  const input = document.getElementById('chatInput') as HTMLInputElement | null;
  if (input) {
    input.placeholder = shown.size === 0 ? 'Enter Message' : 'Showing ' + CATEGORY_ORDER.filter((c) => shown.has(c)).map((c) => CATEGORY_LABEL[c]).join(', ');
  }
}

function applyCommand(target: ChatCategory | 'all'): void {
  if (target === 'all') shown.clear();
  else if (shown.has(target)) shown.delete(target);
  else shown.add(target);
  applyFilter();
  showToast(shown.size === 0 ? 'Chat: showing everything' : 'Chat: showing ' + CATEGORY_ORDER.filter((c) => shown.has(c)).map((c) => CATEGORY_LABEL[c]).join(', '));
}

function cycleFilter(): void {
  const cur = shown.size === 1 ? [...shown][0] : null;
  const i = cur ? CATEGORY_ORDER.indexOf(cur) : -1;
  shown.clear();
  if (i + 1 < CATEGORY_ORDER.length) shown.add(CATEGORY_ORDER[i + 1]);
  applyFilter();
  showToast(shown.size === 0 ? 'Chat: showing everything' : 'Chat: showing ' + CATEGORY_LABEL[[...shown][0]]);
}

// ── chat list observer ──
function onAdded(node: Node): void {
  if (!(node instanceof HTMLElement)) return;
  const cat = tag(node);
  if (!opts.logs) return;
  const text = (node.textContent || '').trim();
  if (!text) return;
  log.push({ t: Date.now(), cat, text });
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
  if (panel && panel.style.display !== 'none') renderLog();
}

let chatObserver: MutationObserver | null = null;
function attachChat(): boolean {
  const list = document.getElementById('chatList');
  if (!list) return false;
  list.childNodes.forEach(onAdded);
  chatObserver = new MutationObserver((muts) => {
    for (const m of muts) m.addedNodes.forEach(onAdded);
  });
  chatObserver.observe(list, { childList: true });
  applyFilter();
  return true;
}

// ── Chat Logs window ──
const LOG_CSS = `
#krhChatLogs { position: fixed; z-index: 2147483000; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: min(760px, 86vw); height: min(560px, 78vh); display: none; flex-direction: column;
  background: rgba(18,18,22,0.96); border: 1px solid rgba(255,255,255,0.15); border-radius: 10px;
  color: #fff; font-family: inherit; font-size: 15px; box-shadow: 0 10px 40px rgba(0,0,0,0.6); }
#krhChatLogs .krh-cl-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.1); }
#krhChatLogs .krh-cl-title { font-weight: bold; margin-right: 8px; }
#krhChatLogs button { background: rgba(255,255,255,0.1); color: #fff; border: 0; border-radius: 6px; padding: 5px 10px; cursor: pointer; font-family: inherit; font-size: 13px; }
#krhChatLogs button:hover { background: rgba(255,255,255,0.22); }
#krhChatLogs button.krh-on { background: #3a7bd5; }
#krhChatLogs input { flex: 1 1 120px; min-width: 90px; background: rgba(0,0,0,0.4); color: #fff; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 5px 8px; font-family: inherit; font-size: 13px; }
#krhChatLogs .krh-cl-list { flex: 1 1 auto; overflow-y: auto; padding: 8px 12px; user-select: text; -webkit-user-select: text; cursor: text; pointer-events: auto; }
#krhChatLogs .krh-cl-row { padding: 2px 0; word-break: break-word; user-select: text; }
#krhChatLogs .krh-cl-time { opacity: 0.45; margin-right: 8px; font-size: 12px; }
#krhChatLogs .krh-cl-row.krh-killfeed { opacity: 0.8; }
#krhChatLogs .krh-cl-row.krh-server { color: #fc03ec; }
#krhChatLogs a { color: #7db7ff; text-decoration: underline; cursor: pointer; }
#krhChatLogs .krh-cl-foot { padding: 6px 12px; font-size: 12px; opacity: 0.6; border-top: 1px solid rgba(255,255,255,0.1); }
`;

let panel: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let searchEl: HTMLInputElement | null = null;
const logFilter = new Set<ChatCategory>();

function pad(n: number): string { return n < 10 ? '0' + n : String(n); }

function linkify(parent: HTMLElement, text: string): void {
  const re = /https?:\/\/[^\s<>"']+/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.textContent = m[0];
    a.href = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    parent.appendChild(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function renderLog(): void {
  if (!listEl) return;
  const q = (searchEl?.value || '').trim().toLowerCase();
  const stick = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;
  const frag = document.createDocumentFragment();
  for (const e of log) {
    if (logFilter.size && !logFilter.has(e.cat)) continue;
    if (q && !e.text.toLowerCase().includes(q)) continue;
    const row = document.createElement('div');
    row.className = 'krh-cl-row krh-' + e.cat;
    const d = new Date(e.t);
    const time = document.createElement('span');
    time.className = 'krh-cl-time';
    time.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    row.appendChild(time);
    linkify(row, e.text);
    frag.appendChild(row);
  }
  listEl.replaceChildren(frag);
  if (stick) listEl.scrollTop = listEl.scrollHeight;
}

function buildPanel(): void {
  if (panel) return;
  panel = document.createElement('div');
  panel.id = 'krhChatLogs';
  const head = document.createElement('div');
  head.className = 'krh-cl-head';
  const title = document.createElement('span');
  title.className = 'krh-cl-title';
  title.textContent = 'Chat Logs';
  head.appendChild(title);
  const btns = new Map<ChatCategory | 'all', HTMLButtonElement>();
  const refreshBtns = (): void => {
    btns.get('all')!.classList.toggle('krh-on', logFilter.size === 0);
    for (const c of CATEGORY_ORDER) btns.get(c)!.classList.toggle('krh-on', logFilter.has(c));
  };
  const mk = (key: ChatCategory | 'all', label: string): void => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => {
      if (key === 'all') logFilter.clear();
      else if (logFilter.has(key)) logFilter.delete(key);
      else logFilter.add(key);
      refreshBtns();
      renderLog();
    });
    btns.set(key, b);
    head.appendChild(b);
  };
  mk('all', 'All');
  for (const c of CATEGORY_ORDER) mk(c, CATEGORY_LABEL[c]);
  searchEl = document.createElement('input');
  searchEl.type = 'text';
  searchEl.placeholder = 'Search…';
  searchEl.autocomplete = 'off';
  searchEl.addEventListener('input', renderLog);
  searchEl.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') closeLogs(); });
  head.appendChild(searchEl);
  const copy = document.createElement('button');
  copy.textContent = 'Copy';
  copy.title = 'Copy the messages that are shown';
  copy.addEventListener('click', () => {
    const text = listEl ? Array.from(listEl.children).map((r) => (r as HTMLElement).innerText.replace(/\n/g, ' ')).join('\n') : '';
    void navigator.clipboard.writeText(text).then(() => showToast('Chat log copied'));
  });
  head.appendChild(copy);
  const clear = document.createElement('button');
  clear.textContent = 'Clear';
  clear.addEventListener('click', () => { log.length = 0; renderLog(); });
  head.appendChild(clear);
  const close = document.createElement('button');
  close.textContent = '✕';
  close.addEventListener('click', closeLogs);
  head.appendChild(close);
  panel.appendChild(head);

  listEl = document.createElement('div');
  listEl.className = 'krh-cl-list';
  panel.appendChild(listEl);
  const foot = document.createElement('div');
  foot.className = 'krh-cl-foot';
  foot.textContent = 'Select text with the mouse and copy with Ctrl+C. The newest 2000 messages are kept. Esc closes.';
  panel.appendChild(foot);
  refreshBtns();
  (document.body || document.documentElement).appendChild(panel);
}

function openLogs(): void {
  buildPanel();
  if (!panel) return;
  ensureStyle(); // makes sure the panel CSS is present
  applyFilter();
  panel.style.display = 'flex';
  if (document.pointerLockElement) document.exitPointerLock();
  renderLog();
  if (listEl) listEl.scrollTop = listEl.scrollHeight;
}

function closeLogs(): void {
  if (panel) panel.style.display = 'none';
}

function toggleLogs(): void {
  if (panel && panel.style.display !== 'none') closeLogs();
  else openLogs();
}

// ── input handling ──
function sameKey(e: KeyboardEvent, want: string): boolean {
  return !!want && e.key.toLowerCase() === want.trim().toLowerCase();
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && opts.filters) {
    const t = e.target as HTMLInputElement | null;
    if (t && t.id === 'chatInput') {
      const cmd = COMMANDS[(t.value || '').trim().toLowerCase()];
      if (cmd) {
        e.preventDefault();
        e.stopImmediatePropagation();
        t.value = '';
        applyCommand(cmd);
        return;
      }
    }
  }
  if (e.repeat) return;
  if (opts.logs && sameKey(e, opts.logsKey)) { e.preventDefault(); toggleLogs(); return; }
  if (opts.filters && sameKey(e, opts.filterKey)) { e.preventDefault(); cycleFilter(); return; }
  if (e.key === 'Escape' && panel && panel.style.display !== 'none') { closeLogs(); }
}

export function initChatTools(o: ChatToolsOptions): void {
  opts = { ...opts, ...o };
  if (started) return;
  if (!opts.filters && !opts.logs) return;
  started = true;
  window.addEventListener('keydown', onKeyDown, true);
  if (!attachChat()) {
    let tries = 0;
    const poll = setInterval(() => { if (attachChat() || ++tries > 120) clearInterval(poll); }, 1000);
  }
}
