// Preload of the KRH Dashboard window: a small bridge to the main process, plus the same settings panel the game's
// settings window shows (renderDashboardSettings), built when the page asks for it.
import { contextBridge, ipcRenderer } from 'electron';
import { ALL_CLIENT_CSS } from '../main/client-ui';
import { renderDashboardSettings } from './settings-render';

contextBridge.exposeInMainWorld('krhDash', {
  call: (channel: string, ...args: unknown[]): Promise<unknown> => {
    if (typeof channel !== 'string' || !channel.startsWith('dash:')) return Promise.reject(new Error('blocked channel'));
    return ipcRenderer.invoke(channel, ...args);
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
  try { renderDashboardSettings(); }
  catch (err) {
    const holder = document.getElementById('settHolder');
    if (holder) holder.textContent = 'The settings could not be shown here (' + String((err as Error).message) + '). Use Settings > Client in the game instead.';
  }
});
