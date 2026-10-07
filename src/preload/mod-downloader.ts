// ── One-click mod downloader ──
// Idea from the Water Client (https://github.com/ghostypostie/Water); written from scratch for KRH Client.
// Krunker's Mods window lists mods as cards with a "Load" button. This adds a small download icon next to it
// that saves the mod's .zip to Downloads/KRH Client/Mods (named after the mod, never overwriting).
// The download itself runs in the main process, which only accepts https links on krunker.io.
// Only a small part of the page (the menu window) is observed, and only for added nodes.

import { ipcRenderer } from 'electron';
import { showToast } from './utils';

const BTN_CLASS = 'krh-mod-dl';
const STYLE_ID = 'krh-mod-dl-style';
const THROTTLE_MS = 300;

const CSS = `
.${BTN_CLASS} {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; margin-left: 6px; border-radius: 6px; cursor: pointer; vertical-align: middle;
  background: rgba(255,255,255,0.12); color: #fff; font-size: 18px; user-select: none;
}
.${BTN_CLASS}:hover { background: rgba(255,255,255,0.25); }
.${BTN_CLASS}.krh-busy { opacity: 0.5; pointer-events: none; }
.${BTN_CLASS}.krh-done { background: #2e9e4f; }
.${BTN_CLASS}.krh-fail { background: #b3372f; }
`;

function modUrl(loadBtn: Element): string {
  const code = loadBtn.getAttribute('onclick') || '';
  const m = code.match(/loadUserMod\([^,]+,\s*["']([^"']+)["']/)
    || code.match(/loadMod\([^,]+,\s*["']([^"']+)["']/)
    || code.match(/(https?:\/\/[^\s"']+\.zip)/);
  return m ? m[1] : '';
}

function modName(loadBtn: HTMLElement, url: string): string {
  // The card is the closest ancestor that holds more than the button itself.
  let card: HTMLElement | null = loadBtn.parentElement;
  for (let i = 0; i < 4 && card && card.textContent && card.textContent.trim().length < 3; i++) card = card.parentElement;
  const lines = (card?.innerText || card?.textContent || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^(load|loaded|download)$/i.test(l));
  const first = lines[0] || '';
  if (first && first.length <= 60) return first;
  try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '').replace(/\.zip$/i, '') || 'mod'; } catch { return 'mod'; }
}

function addButtons(): void {
  const root = document.getElementById('menuWindow');
  if (!root) return;
  const loadButtons = root.querySelectorAll<HTMLElement>('div[onclick*="loadUserMod"], div[onclick*="loadMod"]');
  loadButtons.forEach((loadBtn) => {
    const parent = loadBtn.parentElement;
    if (!parent || parent.querySelector('.' + BTN_CLASS)) return;
    const url = modUrl(loadBtn);
    if (!url) return;

    const btn = document.createElement('span');
    btn.className = BTN_CLASS + ' material-icons';
    btn.textContent = 'download';
    btn.title = 'Download this mod (KRH Client)';
    let savedPath = '';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (savedPath) { void ipcRenderer.invoke('reveal-mod-file', savedPath); return; }
      btn.classList.add('krh-busy');
      btn.classList.remove('krh-fail');
      ipcRenderer.invoke('download-mod', { url, name: modName(loadBtn, url) })
        .then((r: { ok: boolean; path?: string; error?: string }) => {
          btn.classList.remove('krh-busy');
          if (r.ok && r.path) {
            savedPath = r.path;
            btn.classList.add('krh-done');
            btn.textContent = 'check';
            btn.title = 'Saved. Click to show the file.';
            showToast('Mod saved to ' + r.path);
          } else {
            btn.classList.add('krh-fail');
            showToast(r.error || 'Could not download the mod');
          }
        })
        .catch(() => { btn.classList.remove('krh-busy'); btn.classList.add('krh-fail'); showToast('Could not download the mod'); });
    });
    parent.insertBefore(btn, loadBtn.nextSibling);
  });
}

let started = false;

export function initModDownloader(): void {
  if (started) return;
  started = true;
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; addButtons(); }, THROTTLE_MS);
  };
  const attach = (): boolean => {
    const root = document.getElementById('menuWindow');
    if (!root) return false;
    new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
    schedule();
    return true;
  };
  if (!attach()) {
    let tries = 0;
    const poll = setInterval(() => { if (attach() || ++tries > 60) clearInterval(poll); }, 1000);
  }
}
