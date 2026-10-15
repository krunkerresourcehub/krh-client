/*
 * Adapted from NM/NZ Client (https://github.com/nmallik1029/nm-nez-client), src/shared/highlights.ts and
 * src/preload/name-highlights.ts. NM/NZ Client is GPL-3.0-or-later, like KRH Client. See THIRD_PARTY_NOTICES.md.
 * Changes: the friend and clan lists come from Settings (one entry per line) instead of being written into the
 * source, and the player list patch chains with KRH's own genList patch.
 */

// ── Friend and clan name colours ──
// Names picked out in your own colours on the in-match leaderboards, the end-of-match tables and the player list.
// A friend's colour wins over their clan's for the name; the clan tag keeps the clan's colour. Krunker writes a
// clan as `Name [TAG]` with the tag in a nested span, so the two can be coloured apart.
//
// List format, one entry per line:   Name #ff8800        Name #ff8800 bold        (clans: TAG #48eaff bold)

export interface NameRule { key: string; color: string; bold: boolean }
export interface NameColorsConfig { friends: string; clans: string }

const COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i;

/** Parse the settings text. Lines that do not read as `<name> <colour> [bold]` are ignored. */
export function parseRules(text: string, clan: boolean): NameRule[] {
  const rules: NameRule[] = [];
  for (const raw of text.split(/\r?\n/).slice(0, 200)) {
    const parts = raw.trim().split(/\s+/);
    let bold = false;
    if (parts.length > 1 && parts[parts.length - 1]?.toLowerCase() === 'bold') { bold = true; parts.pop(); }
    const color = parts.length > 1 ? parts.pop() ?? '' : '';
    if (!COLOR.test(color) || !CSS.supports('color', color)) continue;
    let key = parts.join(' ').trim();
    if (clan) key = key.replace(/^\[|\]$/g, '').trim();
    if (key) rules.push({ key: key.toLowerCase(), color, bold });
  }
  return rules;
}

interface Highlight { nameColor: string | null; clanColor: string | null; bold: boolean }

/** `Name [TAG]` into its parts: only a trailing bracket group counts as a clan. */
export function nameAndClan(el: Element): { name: string; clan: string | null } {
  let name = '';
  for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE) name += node.textContent ?? '';
  const clan = /\[([^\]]+)\]/.exec(el.querySelector('span')?.textContent ?? '')?.[1] ?? null;
  return { name: name.trim(), clan };
}

let friends: NameRule[] = [];
let clans: NameRule[] = [];

function highlightFor(name: string, clan: string | null): Highlight | null {
  const clanRule = clan === null ? undefined : clans.find((c) => c.key === clan.toLowerCase());
  const friend = friends.find((f) => f.key === name.toLowerCase());
  if (!friend && !clanRule) return null;
  return {
    nameColor: friend?.color ?? clanRule?.color ?? null,
    clanColor: clanRule?.color ?? null,
    bold: (friend?.bold ?? false) || (clanRule?.bold ?? false),
  };
}

const DONE = 'data-krh-namecolor';
const BOARD_IDS = ['leaderContainer', 'centerLeaderDisplay', 'endUI'];
const BOARD_NAMES = '.leaderName, .leaderNameM, .leaderNameF, .newLeaderName, .newLeaderNameM, .newLeaderNameF, .endTableN';
const LIST_NAMES = '.pListName > a, .pListName';

function paint(el: HTMLElement, h: Highlight): void {
  if (h.nameColor !== null) el.style.setProperty('color', h.nameColor, 'important');
  if (h.bold) el.style.setProperty('font-weight', 'bold', 'important');
  const span = el.querySelector('span');
  if (span instanceof HTMLElement && h.clanColor !== null) span.style.setProperty('color', h.clanColor, 'important');
}

function paintNames(root: ParentNode, selector: string): void {
  for (const el of root.querySelectorAll<HTMLElement>(selector)) {
    if (el.hasAttribute(DONE)) continue;
    el.setAttribute(DONE, '');
    const { name, clan } = nameAndClan(el);
    if (name === '') continue;
    const h = highlightFor(name, clan);
    if (h) paint(el, h);
  }
}

const observers = new Map<string, MutationObserver>();
function watchBoards(): void {
  for (const id of BOARD_IDS) {
    const board = document.getElementById(id);
    if (!board || observers.has(id)) continue;
    paintNames(board, BOARD_NAMES);
    const o = new MutationObserver(() => paintNames(board, BOARD_NAMES));
    o.observe(board, { childList: true, subtree: true });
    observers.set(id, o);
  }
}

const PATCHED = '__krhNameColorPatched';
function patchPlayerList(): boolean {
  const target = (window as any).windows?.[22];
  const original = target?.genList;
  if (!target || typeof original !== 'function') return false;
  if (original[PATCHED] === true) return true;
  const wrapped = function (this: unknown): string {
    const html = original.call(this) as string;
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      paintNames(doc, LIST_NAMES);
      return doc.body.innerHTML;
    } catch { return html; }
  };
  (wrapped as any)[PATCHED] = true;
  target.genList = wrapped;
  return true;
}

let started = false;
/** Start colouring. Changes to the lists apply on the next load of the game. */
export function initNameColors(cfg: NameColorsConfig): void {
  friends = parseRules(cfg.friends, false);
  clans = parseRules(cfg.clans, true);
  if ((friends.length === 0 && clans.length === 0) || started) return;
  started = true;
  let attempts = 0;
  const timer = setInterval(() => {
    patchPlayerList();
    watchBoards();
    // The three boards are all in the page from the start; stop once they are hooked, or after a minute.
    if ((observers.size === BOARD_IDS.length && patchPlayerList()) || ++attempts >= 120) clearInterval(timer);
  }, 500);
}
