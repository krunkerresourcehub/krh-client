// ── Match End Message per account ──
// Adapted from Kute (https://github.com/NullDev/Kute, src/frontend/modules/accountEndMessage.js), GPL-3.0.
// Modified for KRH Client 1.0.1: rewritten in TypeScript; the messages are stored by the main process
// (IPC 'end-message-get' / 'end-message-set') instead of Kute's host bridge.
//
// Krunker has one "Match End Message" setting for the whole game. With this on, the message is remembered
// for each account name: an account without a message of its own sends nothing, so an alt never sends the
// main account's message. Until the header confirms who is signed in, nothing is sent either.

import { ipcRenderer } from 'electron';
import { showToast } from './utils';
import { savedConsole as _console } from './saved-console';

const SETTING_KEY = 'kro_setngss_endMessage'; // Krunker's own localStorage key for the setting
const FIELD_ID = 'slid_endMessage';
const HEADER_ID = 'playerHeaderEl'; // holds the signed-in / signed-out bar; a login or logout swaps it
const SAVE_DELAY_MS = 500;

let enabled = false;
let messages: Record<string, string> = {};
let loaded = false;
/** Account whose message is in the game setting right now; undefined before the first check. */
let account: string | null | undefined;
let editedFor: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let toggleToken = 0;
const header = new MutationObserver(() => check());

// Krunker's header shows "signed out" for seconds after a load, so nobody is confirmed until it flips.
function confirmedAccount(): string | null {
  if (!document.getElementById('signedInHeaderBar')) return null;
  try { return localStorage.getItem('krunker_username') || null; } catch { return null; }
}

function storedMessage(): string {
  try { return localStorage.getItem(SETTING_KEY) ?? ''; } catch { return ''; }
}

function remember(name: string, message: string): void {
  if ((messages[name] ?? '') === message) return;
  if (message) messages[name] = message; else delete messages[name];
  void ipcRenderer.invoke('end-message-set', name, message);
}

function flush(): void {
  if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
  if (editedFor) remember(editedFor, storedMessage());
  editedFor = null;
}

function check(): void {
  if (!enabled) return;
  const now = confirmedAccount();
  if (now === account) return;
  flush(); // an edit made right before a switch belongs to the old account
  account = now;
  const message = now ? (messages[now] ?? '') : '';
  if (storedMessage() !== message) (window as any).setSetting?.('endMessage', message);
}

// Capture phase: Krunker's own oninput stores the value after this runs.
function onInput(event: Event): void {
  const t = event.target;
  if (!(t instanceof HTMLInputElement) || t.id !== FIELD_ID || !account) return;
  editedFor = account;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY_MS);
}

function stop(): void {
  header.disconnect();
  document.removeEventListener('input', onInput, true);
  flush();
  account = undefined;
}

/**
 * Turn the per-account end message on or off.
 * @param byPlayer true when the player just switched it on in the settings: the message set right now
 *                 then stays with the account that is signed in, the other accounts start empty.
 */
export async function setAccountEndMessage(on: boolean, byPlayer = false): Promise<void> {
  const token = ++toggleToken;
  if (!on) {
    enabled = false;
    stop();
    return;
  }
  if (!loaded) {
    try {
      const got = await ipcRenderer.invoke('end-message-get');
      messages = got && typeof got === 'object' ? { ...(got as Record<string, string>) } : {};
      loaded = true;
    } catch (err) {
      _console.warn('[KRH] end messages could not be loaded:', err);
      return;
    }
    if (token !== toggleToken) return; // switched again while loading
  }
  enabled = true;
  stop();

  const current = confirmedAccount();
  if (byPlayer && current) {
    const message = storedMessage();
    remember(current, message);
    showToast(message
      ? `Kept your end message for ${current}. Other accounts send nothing until you give them one`
      : `End messages are now per account, ${current} has none`);
  }

  document.addEventListener('input', onInput, true);
  const bar = document.getElementById(HEADER_ID);
  if (bar) header.observe(bar, { childList: true });
  else _console.warn('[KRH] end message: no account header found, nothing will be sent');
  check();
}
