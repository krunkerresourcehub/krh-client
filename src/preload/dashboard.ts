// Preload of the KRH Dashboard window: a small bridge to the main process, plus the same settings panel the game's
// settings window shows (renderDashboardSettings), built when the page asks for it.
import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { ALL_CLIENT_CSS } from '../main/client-ui';
import { renderDashboardSettings, searchDashboardSettings } from './settings-render';

contextBridge.exposeInMainWorld('krhDash', {
  call: (channel: string, ...args: unknown[]): Promise<unknown> => {
    if (typeof channel !== 'string' || !channel.startsWith('dash:')) return Promise.reject(new Error('blocked channel'));
    return ipcRenderer.invoke(channel, ...args);
  },
  /** Text size (Themes > Language & Font): zooms the whole dashboard, 80-150 %. */
  setZoom: (percent: number): void => {
    if (typeof percent === 'number' && percent >= 80 && percent <= 150) webFrame.setZoomFactor(percent / 100);
  },
});

let settingsBuilt = false;
document.addEventListener('krh-dash-settings', () => {
  if (settingsBuilt) return;
  settingsBuilt = true;
  const style = document.createElement('style');
  style.id = 'krh-client-css';
  style.textContent = ALL_CLIENT_CSS;
  document.head.appendChild(style);
  try { renderDashboardSettings(); wireSettingsSearch(); }
  catch (err) {
    const holder = document.getElementById('settHolder');
    if (holder) holder.textContent = 'The settings could not be shown here (' + String((err as Error).message) + '). Use Settings > Client in the game instead.';
  }
});

/** Search box above the settings: filters every category at once while you type, Esc or the x clears it. */
function wireSettingsSearch(): void {
  const input = document.getElementById('settSearchDash') as HTMLInputElement | null;
  const clear = document.getElementById('settSearchClear') as HTMLElement | null;
  const count = document.getElementById('settSearchCount') as HTMLElement | null;
  const none = document.getElementById('settNone') as HTMLElement | null;
  if (!input) return;
  let timer = 0;
  const run = (): void => {
    const q = input.value;
    if (clear) clear.hidden = q.length === 0;
    searchDashboardSettings(q, (n) => {
      if (count) count.textContent = n < 0 ? '' : n + (n === 1 ? ' setting' : ' settings');
      if (none) none.hidden = n !== 0;
    });
  };
  input.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(run, 90); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) { e.preventDefault(); input.value = ''; run(); }
  });
  clear?.addEventListener('click', () => { input.value = ''; run(); input.focus(); });
  if (input.value) run();
}
