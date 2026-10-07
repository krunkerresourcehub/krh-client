// ── UI state reporter ──
// Tells the main process whether the game is in a menu or in a match, so it can apply the matching
// CPU throttling value (Performance > CPU Throttling / CPU Throttling in Menu).
import { ipcRenderer } from 'electron';

export function initUiStateReporter(): void {
  let last = '';
  const report = (): void => {
    const base = document.getElementById('uiBase');
    const state = base && !base.classList.contains('onMenu') ? 'game' : 'menu';
    if (state === last) return;
    last = state;
    ipcRenderer.send('krh-ui-state', state);
  };
  const attach = (): boolean => {
    const base = document.getElementById('uiBase');
    if (!base) return false;
    new MutationObserver(report).observe(base, { attributes: true, attributeFilter: ['class'] });
    report();
    return true;
  };
  if (attach()) return;
  let tries = 0;
  const poll = setInterval(() => { if (attach() || ++tries > 60) clearInterval(poll); }, 500);
}
