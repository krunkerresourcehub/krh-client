// ── Streamer mode ──
// One switch for when you are live: the main process stops the Discord presence, and the page hides
// the saved-account button and list, blurs account names in settings and hides the Spotify card.
// Toggle with the key from Settings (default Ctrl+Alt+M).

import { ipcRenderer } from 'electron';
import { matchCombo, typingInField } from './hotkey';
import { showToast } from './utils';

const STYLE_ID = 'krh-streamer-css';
const CLASS = 'krh-streamer';
const CSS = `
html.${CLASS} #krhAltBtn, html.${CLASS} #krhAltBtnSep, html.${CLASS} #krhAltModal, html.${CLASS} #krh-spotify { display: none !important; }
html.${CLASS} .krh-acc-item, html.${CLASS} .krh-acc-avatar { filter: blur(9px) !important; pointer-events: none !important; }
`;

let on = false;
let started = false;

function apply(v: boolean): void {
  on = v;
  document.documentElement.classList.toggle(CLASS, v);
}

export function initStreamerMode(initial: boolean, key: string): void {
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }
  apply(initial);
  if (started) return;
  started = true;
  ipcRenderer.on('streamer-mode', (_e, v: boolean) => { apply(!!v); showToast(v ? 'Streamer mode ON: presence, accounts and Spotify hidden' : 'Streamer mode OFF'); });
  let hotkey = key;
  ipcRenderer.on('streamer-key', (_e, k: string) => { hotkey = k; });
  window.addEventListener('keydown', (e) => {
    if (e.repeat || typingInField(e) || !matchCombo(e, hotkey)) return;
    e.preventDefault();
    e.stopPropagation();
    void ipcRenderer.invoke('streamer-set', !on);
  }, true);
}

export function isStreamerMode(): boolean { return on; }
