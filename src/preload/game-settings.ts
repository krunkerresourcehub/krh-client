/*
 * Adapted from NM/NZ Client (https://github.com/nmallik1029/nm-nez-client), src/preload/look/game-settings.ts.
 * NM/NZ Client is GPL-3.0-or-later, like KRH Client. See THIRD_PARTY_NOTICES.md.
 */

// Krunker's own settings, read and written the way its settings window does. `setSetting` is the game's own
// function and there is no getter to go with it, so values are read back from the localStorage key each one lands in.
// Every write here is one somebody pressed a button for.

import { KRUNKER_SETTINGS } from '../shared/presets';

const PREFIX = 'kro_setngss_';

/** What the game has this setting at, or null if it has never been changed. */
export function gameSetting(key: string): string | null {
  try { return window.localStorage.getItem(`${PREFIX}${key}`); } catch { return null; }
}

/** Every setting the game has stored, by id, prefix taken off. */
export function storedGameSettingIds(): string[] {
  const ids: string[] = [];
  try {
    const storage = window.localStorage;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(PREFIX)) ids.push(key.slice(PREFIX.length));
    }
  } catch { /* storage blocked: nothing stored as far as anyone here can tell */ }
  return ids;
}

/**
 * Write several at once, which is how a preset lands. Each write passes keepPreset, and the game's preset picker is
 * moved to Custom once at the end instead (left alone, setSetting does that on every write and rebuilds the window).
 * Returns false when the game has no setSetting yet, or a write threw.
 */
export function setGameSettings(writes: readonly (readonly [string, string])[]): boolean {
  const page = window as unknown as Record<string, unknown>;
  const write = page['setSetting'];
  if (typeof write !== 'function') return false;
  if (writes.length === 0) return true;
  try {
    for (const [key, value] of writes) (write as (k: string, v: string, keepPreset: boolean) => void)(key, value, true);
  } catch { return false; }
  const pick = page[KRUNKER_SETTINGS.presetPicker];
  if (typeof pick === 'function') {
    try { (pick as (i: number, skipLoad: boolean, quiet: boolean) => void)(KRUNKER_SETTINGS.customPreset, true, true); } catch { /* cosmetic */ }
  }
  return true;
}
