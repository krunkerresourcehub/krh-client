// ── Raid finder + Trade Plaza joiner ──
// Ideas from Lombre_Blanche's matchmaker script (https://lombreblanche34.github.io/krunker_scripts/);
// written from scratch for KRH Client. Both read the public lobby list (same one the custom matchmaker uses)
// and open the best lobby; they live in the Quick Play window (F2).

import { showToast } from './utils';

export type RaidSort = 'asc' | 'desc';
export const RAIDS: Array<{ key: string; label: string }> = [
  { key: 'sanctum', label: 'Soul Sanctum' },
  { key: 'khepri', label: 'Khepri' },
  { key: 'tortuga', label: 'Tortuga' },
  { key: 'laboratory', label: 'Laboratory' },
  { key: 'facility', label: 'Facility' },
  { key: 'bastion', label: 'Bastion' },
];

// ARG event server (Lombre_Blanche's script opens the same host)
export const ARG_HOST = 'hidden_echo';
export function joinArg(): void {
  showToast('Opening ARG...');
  window.location.assign(`https://${window.location.hostname}/?host=${ARG_HOST}`);
}

/** Short status for the Trade Plaza tile, e.g. "FRA 12/20". Null when unavailable. */
export async function tradePlazaInfo(): Promise<string | null> {
  try {
    const list = (await loadLobbies())
      .filter((g) => (g[4]?.i || '').toLowerCase().includes('plaza'))
      .sort((a, b) => b[2] - a[2]);
    if (list.length === 0) return 'none found';
    const g = list[0];
    return `${String(g[0]).split(':')[0].toUpperCase()} ${g[2]}/${g[3]}`;
  } catch { return null; }
}

// raw lobby: [gameId, ?, players, maxPlayers, { i: mapId, g: mode, c: custom }, remainingTime]
type RawGame = [string, unknown, number, number, { i?: string; g?: number; c?: number } | undefined, number];

async function loadLobbies(): Promise<RawGame[]> {
  const res = await fetch(`https://matchmaker.krunker.io/game-list?hostname=${window.location.hostname}`);
  const json = await res.json();
  return Array.isArray(json?.games) ? (json.games as RawGame[]) : [];
}

function openGame(id: string): void {
  // region:code, nothing else may end up in the address
  if (!/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(id)) { showToast('Unexpected lobby id'); return; }
  window.location.assign(`https://${window.location.hostname}/?game=${encodeURIComponent(id)}`);
}

export async function joinRaid(key: string, sort: RaidSort): Promise<void> {
  showToast('Looking for a ' + (RAIDS.find((r) => r.key === key)?.label || 'raid') + ' lobby...');
  try {
    const list = (await loadLobbies())
      .filter((g) => (g[4]?.i || '').toLowerCase().includes(key) && g[2] < g[3])
      .sort((a, b) => (sort === 'asc' ? a[2] - b[2] : b[2] - a[2]));
    if (list.length === 0) { showToast('No open raid lobby found'); return; }
    openGame(list[0][0]);
  } catch { showToast('Could not load the lobby list'); }
}

export async function joinTradePlaza(): Promise<void> {
  showToast('Looking for a Trade Plaza...');
  try {
    const list = (await loadLobbies())
      .filter((g) => (g[4]?.i || '').toLowerCase().includes('plaza') && g[2] < g[3])
      .sort((a, b) => b[2] - a[2]);
    if (list.length === 0) { showToast('No open Trade Plaza found'); return; }
    openGame(list[0][0]);
  } catch { showToast('Could not load the lobby list'); }
}
