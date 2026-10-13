// ── Skins per account ──
// Switching accounts (Alt Manager, logout / login) used to bring back the default loadout: the skins you had
// equipped on an account were gone and had to be equipped again one by one. With this on, the equipped-skin
// state that Krunker keeps in localStorage is saved for every account name and put back when that account
// signs in again. Sign-in data (tokens, passwords) and settings are never part of what is saved.
//
// How it works: while an account is signed in its skin entries are saved now and then (and when the page
// closes). When another account is confirmed in the header, that account's saved entries are written back; if
// that changed anything the page reloads once so the game reads them. An account with nothing saved yet is
// recorded as soon as its loadout has loaded (about half a second; up to 8 s if it looks identical to the account
// before it, so the previous account's leftovers are never saved under the new name).

import { ipcRenderer } from 'electron';
import { showToast } from './utils';
import { savedConsole as _console } from './saved-console';

const HEADER_ID = 'playerHeaderEl'; // holds the signed-in / signed-out bar; a login or logout swaps it
const POLL_MS = 2000;
const SETTLE_STEP_MS = 500; // how often a new account is checked for its loadout having loaded
const SETTLE_MS = 8000; // longest wait: only when the loadout looks exactly like the previous account's
const RELOAD_GUARD_KEY = 'krh_skins_reload_at'; // sessionStorage: never reload twice within a minute
const MAX_KEYS = 60;
const MAX_VALUE = 4000;
const MAX_TOTAL = 60_000;

// Which localStorage entries count as "skins", and which are never touched whatever their name is.
// Krunker keeps the loadout in keys like skins, charms, classindex, secondaryInd, dyeIndex, shoeIndex, petIndex,
// wristIndex, sprayIndex, playerCardIndex, skinColIndex, pcStatIndex, titleIndex, meleeIndex, streakIndex1-3,
// reticleIndex, attachIndex, scopeIndex, savedReticle and savedScope.
const INCLUDE = /skin|loadout|equip|cosmetic|spray|charm|dye|index\d*$|^(?:secondaryind|savedreticle|savedscope)$/i;
const EXCLUDE = /token|pass|auth|session|frvr|login|secret|cookie|credential|krunker_username|^krh_|^kro_setngss_|^queue_|^s_|server|region|tab|page|menu|scroll|chat|lobby/i;

type Snap = Record<string, string>;

let enabled = false;
let snaps: Record<string, Snap> = {};
let loaded = false;
/** Account that is signed in right now; undefined before the first check. */
let account: string | null | undefined;
/** Set once this account's saved skins are in place (or it had none), so saving can start. */
let readyFor: string | null = null;
let lastSaved = '';
/** Loadout of the last account that was signed in on this page, kept across the signed-out gap of a switch. */
let lastAccountStamp = '';
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let toggleToken = 0;
const header = new MutationObserver(() => check());

// Krunker's header shows "signed out" for seconds after a load, so nobody is confirmed until it flips.
function confirmedAccount(): string | null {
  if (!document.getElementById('signedInHeaderBar')) return null;
  try { return localStorage.getItem('krunker_username') || null; } catch { return null; }
}

function isSkinKey(key: string): boolean {
  return INCLUDE.test(key) && !EXCLUDE.test(key);
}

function readSnap(): Snap {
  const out: Snap = {};
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !isSkinKey(k)) continue;
      const v = localStorage.getItem(k);
      if (v === null || v.length > MAX_VALUE) continue;
      total += k.length + v.length;
      if (Object.keys(out).length >= MAX_KEYS || total > MAX_TOTAL) break;
      out[k] = v;
    }
  } catch { /* localStorage unavailable */ }
  return out;
}

const stamp = (s: Snap): string => JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]]));

/** Writes a saved set back. Returns how many entries changed. */
function applySnap(snap: Snap): number {
  let changed = 0;
  try {
    for (const k of Object.keys(readSnap())) {
      if (!(k in snap)) { localStorage.removeItem(k); changed++; } // left over from the account that was signed in before
    }
    for (const [k, v] of Object.entries(snap)) {
      if (!isSkinKey(k)) continue;
      if (localStorage.getItem(k) !== v) { localStorage.setItem(k, v); changed++; }
    }
  } catch (err) {
    _console.warn('[KRH] skins could not be restored:', err);
  }
  return changed;
}

function save(): void {
  if (!enabled || !account || readyFor !== account || confirmedAccount() !== account) return;
  const snap = readSnap();
  const s = stamp(snap);
  if (s === lastSaved) return;
  // An empty result right after a sign-out would wipe the good copy: keep what is saved.
  if (!Object.keys(snap).length && Object.keys(snaps[account] ?? {}).length) return;
  lastSaved = s;
  snaps[account] = snap;
  void ipcRenderer.invoke('account-skins-set', account, snap);
}

function clearTimers(): void {
  if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; }
}

function reloadOnce(name: string): void {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY)) || 0;
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch { return; }
  showToast(`Putting ${name}'s skins back...`);
  setTimeout(() => location.reload(), 700);
}

function check(): void {
  if (!enabled) return;
  const now = confirmedAccount();
  if (now === account) return;
  save(); // a last save for the account that is leaving, if the header has not already flipped
  clearTimers();
  if (lastSaved) lastAccountStamp = lastSaved;
  const base = lastAccountStamp; // loadout of the account signed in before (empty on a fresh page load)
  account = now;
  readyFor = null;
  lastSaved = '';
  if (!now) return;

  const saved = snaps[now];
  if (saved && Object.keys(saved).length) {
    const changed = applySnap(saved);
    readyFor = now;
    lastSaved = stamp(readSnap());
    if (changed > 0) reloadOnce(now);
  } else {
    // First time we see this account: record its loadout as soon as the game has loaded it. A loadout that
    // differs from the previous account's is already this account's; an identical one is waited on a while.
    let waited = 0;
    const tick = (): void => {
      settleTimer = null;
      if (confirmedAccount() !== now) return;
      waited += SETTLE_STEP_MS;
      if (stamp(readSnap()) !== base || waited >= SETTLE_MS) {
        readyFor = now;
        save();
        return;
      }
      settleTimer = setTimeout(tick, SETTLE_STEP_MS);
    };
    settleTimer = setTimeout(tick, SETTLE_STEP_MS);
  }
}

function stop(): void {
  header.disconnect();
  clearTimers();
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  window.removeEventListener('pagehide', save);
  save();
  account = undefined;
  readyFor = null;
  lastAccountStamp = '';
}

/**
 * Turn "skins per account" on or off.
 * @param byPlayer true when the player just switched it on: the skins equipped right now are kept for the
 *                 account that is signed in.
 */
export async function setAccountSkins(on: boolean, byPlayer = false): Promise<void> {
  const token = ++toggleToken;
  if (!on) {
    enabled = false;
    stop();
    return;
  }
  if (!loaded) {
    try {
      const got = await ipcRenderer.invoke('account-skins-get');
      snaps = got && typeof got === 'object' ? { ...(got as Record<string, Snap>) } : {};
      loaded = true;
    } catch (err) {
      _console.warn('[KRH] saved skins could not be loaded:', err);
      return;
    }
    if (token !== toggleToken) return; // switched again while loading
  }
  enabled = true;
  stop();

  const current = confirmedAccount();
  if (byPlayer && current) {
    account = current;
    readyFor = current;
    save();
    showToast(`Your skins are now saved for ${current}. Other accounts keep their own`);
  }

  window.addEventListener('pagehide', save);
  pollTimer = setInterval(save, POLL_MS);
  const bar = document.getElementById(HEADER_ID);
  if (bar) header.observe(bar, { childList: true });
  else _console.warn('[KRH] skins per account: no account header found, nothing will be saved');
  if (!byPlayer) check();
}
