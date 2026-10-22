// ── KRH Dashboard: the extra pages ──
// Servers (ping per region, favourite regions), Rejoin last game and favourite games, session History, game
// Profiles, Diagnostics, Updates / What's new, a keybind overview and the automatic cache limit. Every handler is a
// `dash:*` channel like the rest of the dashboard, and every value from the page is validated again here.

import { ipcMain } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { getStats, kd, fmtDuration, summaryText, topMap } from './session-stats';
import { renderMarkdown } from '../shared/markdown';
import { redact } from '../shared/redact';
import { electronLog } from './logger';
import type { DoctorResult } from './perf-doctor';
import type { NewsResult } from './news-feed';
import type { AutoDisabled } from './userscript-guard';

export interface ExtraDeps {
  dataPath: string;
  version: string;
  buildSystemInfo: () => Promise<string>;
  logTail: () => string;
  copyText: (text: string) => void;
  getPings: (force: boolean) => Promise<Record<string, number>>;
  getMatchmakerRegions: () => string[];
  setMatchmakerRegions: (regions: string[]) => void;
  currentGameUrl: () => string | null;
  launchGame: (url: string) => void;
  profiles: () => string[];
  saveProfile: (name: string) => Promise<boolean>;
  applyProfile: (name: string) => Promise<boolean>;
  deleteProfile: (name: string) => boolean;
  applyLowEndAndRestart: () => void;
  perfDoctor: () => Promise<DoctorResult>;
  news: (force: boolean) => Promise<NewsResult>;
  openHubRoute: (route: string) => void;
  scriptGuard: { list: () => AutoDisabled[]; reenable: (file: string) => Promise<boolean>; dismiss: (file: string) => void };
  checkUpdates: () => Promise<{ latest: string | null }>;
  fetchChangelog: (version: string) => Promise<string>;
  keybinds: () => Record<string, { key: string; ctrl: boolean; shift: boolean; alt: boolean }>;
  cacheSizeBytes: () => Promise<number>;
  clearCache: () => Promise<void>;
}

interface FavoriteGame { name: string; url: string }
interface DashData {
  lastGame: { url: string; at: number } | null;
  favGames: FavoriteGame[];
  favRegions: string[];
  cacheLimitMb: number;
}
const DEFAULT_DATA: DashData = { lastGame: null, favGames: [], favRegions: [], cacheLimitMb: 0 };

/** Ping region codes (what the ping list shows) and the id the matchmaker filters by. */
export const REGION_IDS: Record<string, string> = {
  SV: 'us-ca-sv', TOK: 'jb-hnd', FRA: 'de-fra', MBI: 'as-mb', SYD: 'au-syd',
  SIN: 'sgp', DAL: 'us-tx', BHN: 'me-bhn', BRZ: 'brz', NY: 'us-nj',
};
const KEYBIND_LABELS: Record<string, string> = {
  reload: 'Reload the game', newMatch: 'New match', copyGameLink: 'Copy game link', joinFromClipboard: 'Join from clipboard',
  devTools: 'Developer tools', matchmaker: 'Find a match', matchmakerCancel: 'Cancel the search', fullscreenToggle: 'Fullscreen',
  screenshot: 'Screenshot', screenshotArea: 'Screenshot area', record: 'Record', recordPause: 'Pause recording',
  hubToggle: 'Open / hide the KRH website window', dashboard: 'Show / hide the dashboard over the game',
};
/** A Krunker game link: the real host, a game code, nothing else. */
const GAME_URL = /^https:\/\/krunker\.io\/\?game=[A-Za-z0-9:._-]{3,64}$/;

let dataPath = '';
let cached: DashData | null = null;

function load(): DashData {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(dataPath, 'utf-8')) as Partial<DashData>;
    cached = {
      lastGame: raw.lastGame && typeof raw.lastGame.url === 'string' && GAME_URL.test(raw.lastGame.url) && typeof raw.lastGame.at === 'number' ? { url: raw.lastGame.url, at: raw.lastGame.at } : null,
      favGames: Array.isArray(raw.favGames) ? raw.favGames.filter((f): f is FavoriteGame => !!f && typeof f.name === 'string' && typeof f.url === 'string' && GAME_URL.test(f.url)).slice(0, 30).map((f) => ({ name: f.name.slice(0, 40), url: f.url })) : [],
      favRegions: Array.isArray(raw.favRegions) ? raw.favRegions.filter((r): r is string => typeof r === 'string' && r in REGION_IDS) : [],
      cacheLimitMb: [0, 500, 1000, 2000].includes(raw.cacheLimitMb as number) ? (raw.cacheLimitMb as number) : 0,
    };
  } catch { cached = { ...DEFAULT_DATA, favGames: [], favRegions: [] }; }
  return cached;
}
function save(): void {
  try { mkdirSync(dirname(dataPath), { recursive: true }); writeFileSync(dataPath, JSON.stringify(load(), null, 2), 'utf-8'); }
  catch (err) { electronLog.warn('[KRH] Could not save the dashboard data:', (err as Error).message); }
}

export function initDashboardData(path: string): void { dataPath = path; cached = null; }

/** Remember the game the player is in (called on every navigation of the game window). */
export function recordGameUrl(url: string): void {
  if (!dataPath || !GAME_URL.test(url)) return;
  const d = load();
  if (d.lastGame?.url === url) return;
  d.lastGame = { url, at: Date.now() };
  save();
}

export function cacheLimitMb(): number { return dataPath ? load().cacheLimitMb : 0; }

function combo(k: { key: string; ctrl: boolean; shift: boolean; alt: boolean }): string {
  const key = k.key.length === 1 ? k.key.toUpperCase() : k.key;
  return [k.ctrl ? 'Ctrl' : '', k.alt ? 'Alt' : '', k.shift ? 'Shift' : '', key].filter(Boolean).join('+');
}
function cleanName(raw: unknown, max = 40): string {
  if (typeof raw !== 'string') return '';
  return Array.from(raw).filter((c) => c.charCodeAt(0) >= 32).join('').trim().slice(0, max);
}

export function registerExtras(deps: ExtraDeps): void {
  initDashboardData(deps.dataPath);
  const h = ipcMain.handle.bind(ipcMain);

  // ── Diagnostics ──
  const report = async (): Promise<string> => {
    const info = await deps.buildSystemInfo();
    const log = redact(deps.logTail());
    return `${info}\n===== Recent log (e-mails and tokens hidden) =====\n${log || '(empty)'}\n`;
  };
  h('dash:diag', async () => ({ text: await report() }));
  h('dash:diag-copy', async () => { deps.copyText(await report()); return true; });

  // ── Performance doctor ──
  h('dash:perf-doctor', async () => deps.perfDoctor());
  h('dash:copy-text', (_e, text: unknown) => {
    if (typeof text !== 'string' || text.length === 0 || text.length > 20_000) return false;
    deps.copyText(text);
    return true;
  });

  // ── Krunker news ──
  h('dash:news', async (_e, force: unknown) => deps.news(force === true));
  h('dash:news-open', (_e, route: unknown) => {
    if (typeof route !== 'string' || !/^[a-z0-9-]{1,40}$/.test(route)) return false;
    deps.openHubRoute(route);
    return true;
  });

  // ── Userscripts the client switched off because they crashed the game ──
  h('dash:guard-list', () => ({ items: deps.scriptGuard.list() }));
  h('dash:guard-reenable', async (_e, file: unknown) => ({ ok: typeof file === 'string' && file.length < 200 ? await deps.scriptGuard.reenable(file) : false }));
  h('dash:guard-dismiss', (_e, file: unknown) => { if (typeof file === 'string' && file.length < 200) deps.scriptGuard.dismiss(file); return true; });

  // ── Servers ──
  h('dash:servers', async (_e, force: unknown) => {
    const pings = await deps.getPings(force === true);
    const favs = load().favRegions;
    const rows = Object.entries(pings).map(([code, ms]) => ({ code, id: REGION_IDS[code] ?? '', ms, fav: favs.includes(code) }));
    rows.sort((a, b) => Number(b.fav) - Number(a.fav) || a.ms - b.ms);
    const inMatchmaker = deps.getMatchmakerRegions();
    return { rows, matchmakerRegions: inMatchmaker };
  });
  h('dash:server-fav', (_e, code: unknown) => {
    if (typeof code !== 'string' || !(code in REGION_IDS)) return false;
    const d = load();
    d.favRegions = d.favRegions.includes(code) ? d.favRegions.filter((c) => c !== code) : [...d.favRegions, code];
    save();
    return true;
  });
  h('dash:server-use-favs', (_e, clear: unknown) => {
    const ids = clear === true ? [] : load().favRegions.map((c) => REGION_IDS[c]).filter(Boolean);
    deps.setMatchmakerRegions(ids);
    return { regions: ids };
  });

  // ── Rejoin last game / favourite games ──
  h('dash:games', () => {
    const d = load();
    const cur = deps.currentGameUrl();
    return { last: d.lastGame, favorites: d.favGames, current: cur && GAME_URL.test(cur) ? cur : null };
  });
  h('dash:game-join', (_e, url: unknown) => {
    if (typeof url !== 'string' || !GAME_URL.test(url)) return { error: 'That is not a Krunker game link.' };
    deps.launchGame(url);
    return { ok: true };
  });
  h('dash:game-fav-add', (_e, nameRaw: unknown) => {
    const cur = deps.currentGameUrl();
    if (!cur || !GAME_URL.test(cur)) return { error: 'Join a game first, then save it.' };
    const d = load();
    if (d.favGames.length >= 30) return { error: 'You already have 30 favourites.' };
    const name = cleanName(nameRaw) || cur.split('=')[1];
    d.favGames = [...d.favGames.filter((f) => f.url !== cur), { name, url: cur }];
    save();
    return { ok: true };
  });
  h('dash:game-fav-remove', (_e, url: unknown) => {
    const d = load();
    d.favGames = d.favGames.filter((f) => f.url !== url);
    save();
    return true;
  });

  // ── Session history ──
  h('dash:history', () => {
    const s = getStats();
    const row = (r: NonNullable<typeof s.current>) => ({ start: r.start, end: r.end, kills: r.kills, deaths: r.deaths, kd: kd(r), duration: fmtDuration(r.seconds), matches: r.matches, bestStreak: r.bestStreak, topMap: topMap(r), summary: summaryText(r) });
    return {
      current: s.current ? row(s.current) : null,
      recent: s.recent.map(row),
      total: { ...s.total, kd: kd(s.total), duration: fmtDuration(s.total.seconds) },
    };
  });

  // ── Game profiles (the Krunker settings snapshots from Settings > General > Settings Profiles) ──
  h('dash:profiles', () => ({ names: deps.profiles() }));
  h('dash:profile-save', async (_e, name: unknown) => {
    const n = cleanName(name, 60);
    if (!n) return { error: 'Type a profile name first.' };
    return (await deps.saveProfile(n)) ? { ok: true } : { error: 'Open Krunker first: its settings can only be read from the game.' };
  });
  h('dash:profile-apply', async (_e, name: unknown) => {
    const n = cleanName(name, 60);
    return (await deps.applyProfile(n)) ? { ok: true } : { error: 'Open Krunker first: a profile is applied through the game.' };
  });
  h('dash:profile-delete', (_e, name: unknown) => deps.deleteProfile(cleanName(name, 60)));
  h('dash:low-end', () => { deps.applyLowEndAndRestart(); return true; });

  // ── Updates and what's new ──
  h('dash:updates', async () => {
    let latest: string | null = null;
    try { latest = (await deps.checkUpdates()).latest; } catch (err) { electronLog.warn('[KRH] Update check failed:', (err as Error).message); }
    return { current: deps.version, latest };
  });
  h('dash:changelog', async () => {
    const md = await deps.fetchChangelog(deps.version);
    return { html: md ? renderMarkdown(md, { links: false }) : '' };
  });

  // ── Keybind overview ──
  h('dash:keybinds', () => ({
    rows: Object.entries(deps.keybinds())
      .filter(([k]) => k in KEYBIND_LABELS)
      .map(([k, v]) => ({ label: KEYBIND_LABELS[k], combo: combo(v) })),
  }));

  // ── Cache size and the automatic limit ──
  h('dash:cache-info', async () => ({ bytes: await deps.cacheSizeBytes(), limitMb: load().cacheLimitMb }));
  h('dash:cache-limit', (_e, mb: unknown) => {
    if (![0, 500, 1000, 2000].includes(mb as number)) return false;
    load().cacheLimitMb = mb as number;
    save();
    return true;
  });
}
