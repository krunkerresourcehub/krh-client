// ── Ranked badges on the normal leaderboard ──
// The in-game top-right leaderboard shows no rank, but the ranked list in the middle of the screen does.
// This remembers each player's badge from the ranked list and shows it next to their name on the normal
// leaderboard. Only the two leaderboard containers are observed (never the whole page).

const BADGE_CLASS = 'krh-rank-badge';
const THROTTLE_MS = 250;

const cache = new Map<string, string>();
const STORE_KEY = 'krh_rank_badges';
const STORE_MAX = 600;

// Badges seen in earlier ranked lists are kept (also across lobbies / reloads): the normal lobbies you
// usually play in never show the ranked list themselves, so the cache would otherwise stay empty there.
function loadStore(): void {
  try {
    const o = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (typeof v === 'string' && safeBadgeSrc(v)) cache.set(k, v);
  } catch { /* ignore */ }
}
let storeTimer: ReturnType<typeof setTimeout> | null = null;
function saveStore(): void {
  if (storeTimer) return;
  storeTimer = setTimeout(() => {
    storeTimer = null;
    try {
      while (cache.size > STORE_MAX) cache.delete(cache.keys().next().value as string);
      localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(cache)));
    } catch { /* storage unavailable */ }
  }, 1500);
}

// "1. lususss [k2]" -> "lususss": drops the position prefix, clan tag and spaces
function normalize(name: string): string {
  return name.replace(/^\s*\d+\s*[.)]\s*/, '').replace(/\[[^\]]*]/g, '').replace(/\s+/g, '').trim().toLowerCase();
}

function safeBadgeSrc(src: string): string {
  try {
    const u = new URL(src, location.href);
    return u.protocol === 'https:' && /(^|\.)krunker\.io$/.test(u.hostname) ? u.href : '';
  } catch { return ''; }
}

function readRankedList(): void {
  const center = document.getElementById('centerLeaderDisplay');
  if (!center) return;
  center.querySelectorAll('.newLeaderItem').forEach((item) => {
    const name = item.querySelector('.newLeaderName, .newLeaderNameM, .newLeaderNameF');
    const img = item.querySelector('.newLeaderRanked img') as HTMLImageElement | null;
    if (!name || !img) return;
    const src = safeBadgeSrc(img.getAttribute('src') || img.src);
    const key = normalize(name.textContent || '');
    if (src && key && cache.get(key) !== src) { cache.set(key, src); saveStore(); }
  });
}

// Both the normal top-right board and the older tab / numbered board ("1. name  score").
const BOARD_IDS = ['leaderboardHolder', 'leaderDisplay', 'leaderboard', 'oldLeaderboard', 'leaderboardOld'];
function boardHolders(): HTMLElement[] {
  return BOARD_IDS.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
}

function applyToLeaderboard(): void {
  if (cache.size === 0) return;
  for (const holder of boardHolders()) {
    // any element whose class looks like a leaderboard name (leaderName, leaderNameM, leaderNameF, ...)
    holder.querySelectorAll('[class*="eaderName"], [class*="leaderNm"]').forEach((name) => {
      if (name.classList.contains(BADGE_CLASS) || !name.parentNode) return;
      const row = name.parentElement;
      if (!row || row.querySelector('.' + BADGE_CLASS)) return;
      const src = cache.get(normalize(name.textContent || ''));
      if (!src) return;
      const img = document.createElement('img');
      img.className = BADGE_CLASS;
      img.src = src;
      img.draggable = false;
      img.style.cssText = 'width:22px;height:22px;margin-right:4px;vertical-align:middle;';
      name.parentNode.insertBefore(img, name);
    });
  }
}

let started = false;
let stopFns: Array<() => void> = [];

export function initRankedBadges(): void {
  if (started) return;
  started = true;
  loadStore();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = (): void => {
    timer = null;
    readRankedList();
    applyToLeaderboard();
  };
  const schedule = (): void => { if (!timer) timer = setTimeout(run, THROTTLE_MS); };

  const watched = new Set<string>();
  const attach = (): void => {
    for (const id of ['centerLeaderDisplay', ...BOARD_IDS]) {
      if (watched.has(id)) continue;
      const el = document.getElementById(id);
      if (!el) continue;
      const mo = new MutationObserver(schedule);
      mo.observe(el, { childList: true, subtree: true });
      stopFns.push(() => mo.disconnect());
      watched.add(id);
    }
    schedule();
  };
  attach();
  // The containers may not exist yet (or get replaced): look again every few seconds, outside of aiming.
  const poll = setInterval(() => { if (!document.pointerLockElement && watched.size < 2 + 1) attach(); }, 3000);
  stopFns.push(() => clearInterval(poll));
}

export function stopRankedBadges(): void {
  for (const f of stopFns) f();
  stopFns = [];
  started = false;
  document.querySelectorAll('.' + BADGE_CLASS).forEach((e) => e.remove());
}
