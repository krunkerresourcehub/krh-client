// ── Session stats ──
// The game page reports small deltas (kills, deaths, seconds played, matches, maps). This keeps the
// running session and a history of the last sessions in <userData>/KRH Client/session-stats.json.
// A session starts with the first report and ends when the game window is closed (back to the hub)
// or the client quits. Everything stays on this computer.

import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { electronLog } from './logger';

export interface SessionRecord {
  start: number;
  end: number;
  kills: number;
  deaths: number;
  seconds: number;
  matches: number;
  bestStreak: number;
  maps: Record<string, number>;
}

export interface StatsDelta {
  kills?: number;
  deaths?: number;
  seconds?: number;
  matches?: number;
  bestStreak?: number;
  maps?: Record<string, number>;
}

const MAX_SESSIONS = 200;
const FLUSH_EVERY_MS = 3 * 60 * 1000;

let history: SessionRecord[] = [];
let current: SessionRecord | null = null;
let loaded = false;
let dirty = false;
let timer: ReturnType<typeof setInterval> | null = null;

function file(): string {
  const dir = join(app.getPath('userData'), 'KRH Client');
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return join(dir, 'session-stats.json');
}

function int(x: unknown, max: number): number {
  const n = typeof x === 'number' && isFinite(x) ? Math.floor(x) : 0;
  return Math.max(0, Math.min(max, n));
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const j = JSON.parse(readFileSync(file(), 'utf-8')) as { sessions?: unknown };
    if (Array.isArray(j.sessions)) {
      history = (j.sessions as Partial<SessionRecord>[])
        .filter((s) => s && typeof s.start === 'number')
        .map((s) => ({
          start: int(s.start, 4e12), end: int(s.end, 4e12), kills: int(s.kills, 1e7), deaths: int(s.deaths, 1e7),
          seconds: int(s.seconds, 1e9), matches: int(s.matches, 1e6), bestStreak: int(s.bestStreak, 1e5),
          maps: s.maps && typeof s.maps === 'object' ? cleanMaps(s.maps as Record<string, unknown>) : {},
        }))
        .slice(-MAX_SESSIONS);
    }
  } catch { /* first run or unreadable file: start empty */ }
}

function cleanMaps(m: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m).slice(0, 40)) {
    const name = String(k).slice(0, 40).trim();
    const n = int(v, 1e6);
    if (name && n > 0) out[name] = n;
  }
  return out;
}

function save(): void {
  try {
    const all = current && (current.kills || current.deaths || current.seconds) ? [...history, { ...current, end: Date.now() }] : history;
    writeFileSync(file(), JSON.stringify({ sessions: all.slice(-MAX_SESSIONS) }), 'utf-8');
    dirty = false;
  } catch (err) {
    electronLog.warn('[KRH-Stats] Could not save session stats:', (err as Error).message);
  }
}

export function addDelta(d: StatsDelta): void {
  load();
  if (!d || typeof d !== 'object') return;
  const now = Date.now();
  if (!current) current = { start: now, end: now, kills: 0, deaths: 0, seconds: 0, matches: 0, bestStreak: 0, maps: {} };
  current.kills += int(d.kills, 500);
  current.deaths += int(d.deaths, 500);
  current.seconds += int(d.seconds, 3600);
  current.matches += int(d.matches, 20);
  current.bestStreak = Math.max(current.bestStreak, int(d.bestStreak, 1e5));
  if (d.maps && typeof d.maps === 'object') {
    for (const [name, n] of Object.entries(cleanMaps(d.maps as Record<string, unknown>))) {
      if (Object.keys(current.maps).length >= 40 && !(name in current.maps)) continue;
      current.maps[name] = (current.maps[name] || 0) + Math.min(n, 20);
    }
  }
  current.end = now;
  dirty = true;
  if (!timer) {
    timer = setInterval(() => { if (dirty) save(); }, FLUSH_EVERY_MS);
    timer.unref?.();
  }
}

export function topMap(r: SessionRecord): string {
  let best = '';
  let bestN = 0;
  for (const [k, v] of Object.entries(r.maps)) if (v > bestN) { best = k; bestN = v; }
  return best;
}

export function fmtDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 1) return '<1 min';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function kd(r: { kills: number; deaths: number }): string {
  return r.deaths > 0 ? (r.kills / r.deaths).toFixed(2) : r.kills > 0 ? r.kills.toFixed(2) : '0.00';
}

export function summaryText(r: SessionRecord): string {
  const parts = [`${r.kills} kills, ${r.deaths} deaths (K/D ${kd(r)})`, fmtDuration(r.seconds)];
  if (r.matches) parts.push(`${r.matches} ${r.matches === 1 ? 'match' : 'matches'}`);
  if (r.bestStreak > 1) parts.push(`best streak ${r.bestStreak}`);
  const m = topMap(r);
  if (m) parts.push(`most played: ${m}`);
  return parts.join(' · ');
}

/** Close the running session and store it. Returns it when it had any activity. */
export function endSession(): SessionRecord | null {
  load();
  const c = current;
  current = null;
  if (!c || (!c.kills && !c.deaths && c.seconds < 30)) { if (dirty) save(); return null; }
  c.end = Date.now();
  history.push(c);
  history = history.slice(-MAX_SESSIONS);
  save();
  return c;
}

export function flushStats(): void { if (dirty || current) save(); }

export function getStats(): { current: SessionRecord | null; recent: SessionRecord[]; total: { kills: number; deaths: number; seconds: number; matches: number; sessions: number; bestStreak: number } } {
  load();
  const all = current ? [...history, current] : history;
  const total = { kills: 0, deaths: 0, seconds: 0, matches: 0, sessions: all.length, bestStreak: 0 };
  for (const s of all) {
    total.kills += s.kills; total.deaths += s.deaths; total.seconds += s.seconds; total.matches += s.matches;
    total.bestStreak = Math.max(total.bestStreak, s.bestStreak);
  }
  return { current: current ? { ...current } : null, recent: history.slice(-10).reverse(), total };
}

export function clearStats(): void {
  history = [];
  current = null;
  dirty = false;
  try { writeFileSync(file(), JSON.stringify({ sessions: [] }), 'utf-8'); } catch { /* ignore */ }
}
