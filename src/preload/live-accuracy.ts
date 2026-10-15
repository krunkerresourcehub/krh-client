/*
 * Adapted from NM/NZ Client (https://github.com/nmallik1029/nm-nez-client), src/preload/hud/accuracy.ts.
 * NM/NZ Client is GPL-3.0-or-later, like KRH Client. See THIRD_PARTY_NOTICES.md.
 * Changes: KRH style injection, death detection also through #uiBase's onDeathScrn class (what the session
 * tracker uses), hits from the headshot-sound replay are not counted, settings wrapper.
 */

// ── Live accuracy ──
// The match so far and the current life, side by side, top centre or bottom centre of the screen. The counting
// is in shared/accuracy.ts; this is the page end of it. Shots are read off the ammo counter, hits off the game's
// hit sound, and the readout is built from Krunker's own statIcon / greyInner classes so it looks like one of the
// game's own stats. It is an estimate (the game does not publish the number while you are alive), not Krunker's
// official accuracy figure.
//
// When you die, the finished life's figure stays on screen until your first shot of the next one; the match
// figure carries straight on.

import {
  accuracyLabel,
  EMPTY_TALLY,
  lifeShown,
  readAmmo,
  shotsBetween,
  tallyHit,
  tallyNewLife,
  tallyShots,
  type AccuracyTally,
  type AmmoReading,
} from '../shared/accuracy';
import { HIT_SOUNDS, onGameSound } from './game-sound';
import { watchCounter } from './hud-counter';
import { isHeadshotReplay } from './headshot-sound';

export type AccuracyPlacement = 'top' | 'bottom';

const ELEMENT_ID = 'krh-live-accuracy';
const STYLE_ID = 'krh-live-accuracy-style';
const AMMO_VALUE_ID = 'ammoVal';
const AMMO_MAX_ID = 'ammoMax';
const TOP_CENTRE_ID = 'topMidHold';
const RELOAD_PROMPT_ID = 'reloadMsg';
const REATTACH_MS = 2_000;

// Krunker's HUD is zoomed by the game; the box is zoomed to twice its own statIcon size (too small otherwise).
// Zoom scales the element's own offsets too, so the placements are written at half: 7.5px lands 15px from the edge.
const CSS = `
#${ELEMENT_ID}{vertical-align:top;zoom:2}
#${ELEMENT_ID}[data-place=top]{margin-top:7.5px}
#${ELEMENT_ID}[data-place=bottom]{position:absolute;left:50%;bottom:7.5px;margin:0;transform:translateX(-50%)}
#${ELEMENT_ID} .greyInner{display:flex;align-items:baseline;gap:14px}
#${ELEMENT_ID} .line{display:flex;align-items:baseline;gap:6px;line-height:1}
#${ELEMENT_ID} .lbl{font-size:11px;letter-spacing:.06em;text-transform:uppercase}
#${ELEMENT_ID} .val{min-width:38px;text-align:right;font-size:15px;font-variant-numeric:tabular-nums}
`;

let tally: AccuracyTally = EMPTY_TALLY;
let lastAmmo: AmmoReading | null = null;
let placement: AccuracyPlacement = 'top';

let element: HTMLElement | null = null;
let matchValue: HTMLElement | null = null;
let lifeValue: HTMLElement | null = null;
let ammoParent: HTMLElement | null = null;
let ammoObserver: MutationObserver | null = null;
let uiObserver: MutationObserver | null = null;
let uiBase: HTMLElement | null = null;
let wasDead = false;
let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;

/** Switch the readout on or off (settings). */
export function setLiveAccuracy(on: boolean, place?: AccuracyPlacement): void {
  if (place) placement = place === 'bottom' ? 'bottom' : 'top';
  if (!on) {
    teardown();
    return;
  }
  if (unsubscribe === null) {
    unsubscribe = onGameSound((name) => {
      if (!HIT_SOUNDS.has(name)) return;
      // KRH's own replay of the headshot ding on a kill is not a new shot landing.
      if (isHeadshotReplay()) return;
      tally = tallyHit(tally, performance.now());
      render();
    });
  }
  tick();
  if (timer === null) timer = setInterval(tick, REATTACH_MS);
  if (element) mount(); // a placement change moves a readout already on screen
}

/** Put anything Krunker has rebuilt back. Does nothing when nothing moved. */
function tick(): void {
  mount();
  attachAmmo();
  attachDeathWatch();
  for (const counter of counters) counter.attach();
}

function render(): void {
  if (matchValue) matchValue.textContent = accuracyLabel(tally.match);
  if (lifeValue) lifeValue.textContent = accuracyLabel(lifeShown(tally));
}

/** A new life: a fresh count, with the last figure left up for now. */
function newLife(): void {
  tally = tallyNewLife(tally);
}

/** A new match: nothing from the last one carries over, on screen or off. */
function newMatch(): void {
  tally = EMPTY_TALLY;
  lastAmmo = null;
  render();
}

const counters = [
  // Death counter under both ids the page has used; resetting twice for one death is still one reset.
  watchCounter('deathCount', newLife, newMatch),
  watchCounter('deathsVal', newLife, newMatch),
  // Kills only say something here when they go backwards: a new match.
  watchCounter('killsVal', () => {}, newMatch),
];

/** Death through #uiBase's class, the signal the session tracker already relies on. */
function attachDeathWatch(): void {
  const ui = document.getElementById('uiBase');
  if (!ui || ui === uiBase) return;
  uiObserver?.disconnect();
  uiBase = ui;
  wasDead = ui.classList.contains('onDeathScrn');
  uiObserver = new MutationObserver(() => {
    const dead = ui.classList.contains('onDeathScrn');
    if (dead && !wasDead) newLife();
    wasDead = dead;
  });
  uiObserver.observe(ui, { attributes: true, attributeFilter: ['class'] });
}

/**
 * Watch the ammo counter. Observed through its parent rather than #ammoVal itself, so a counter that Krunker
 * replaces with a fresh element is still seen, and the magazine size beside it is read in the same pass.
 */
function attachAmmo(): void {
  const parent = document.getElementById(AMMO_VALUE_ID)?.parentElement ?? null;
  if (!parent || parent === ammoParent) return;
  ammoObserver?.disconnect();
  ammoParent = parent;
  lastAmmo = null;
  ammoObserver = new MutationObserver(readAmmoNow);
  ammoObserver.observe(parent, { childList: true, characterData: true, subtree: true });
  readAmmoNow();
}

function readAmmoNow(): void {
  const next = readAmmo(
    document.getElementById(AMMO_VALUE_ID)?.textContent,
    document.getElementById(AMMO_MAX_ID)?.textContent,
  );
  const shots = shotsBetween(lastAmmo, next);
  lastAmmo = next;
  if (shots === 0) return;
  tally = tallyShots(tally, shots, performance.now());
  render();
}

interface Spot { parent: Element; before: Element | null }

/** First in Krunker's top-centre column, so the rounds score and messages underneath stay visible. */
function topCentre(): Spot | null {
  const column = document.getElementById(TOP_CENTRE_ID);
  return column ? { parent: column, before: column.firstElementChild } : null;
}

/** Just ahead of the reload prompt, which shares the bottom centre (markup order decides who paints on top). */
function bottomCentre(): Spot | null {
  const reload = document.getElementById(RELOAD_PROMPT_ID);
  const parent = reload?.parentElement;
  return reload && parent ? { parent, before: reload } : null;
}

function line(name: string): { row: HTMLElement; value: HTMLElement } {
  const row = document.createElement('div');
  row.className = 'line';
  const label = document.createElement('span');
  label.className = 'lbl';
  label.textContent = name;
  const value = document.createElement('span');
  value.className = 'val';
  row.append(label, value);
  return { row, value };
}

/**
 * Build the readout into Krunker's HUD. Re-checked on the timer, because the HUD is Krunker's and parts of it get
 * rebuilt, and on a change of setting: a readout that is not where it should be is built again in the right place.
 */
function mount(): void {
  const spot = placement === 'bottom' ? bottomCentre() : topCentre();
  if (!spot || (element?.parentElement === spot.parent && element.dataset.place === placement)) return;

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head ?? document.documentElement).appendChild(style);
  }
  element?.remove();

  element = document.createElement('div');
  element.id = ELEMENT_ID;
  element.className = 'statIcon';
  element.dataset.place = placement;
  const inner = document.createElement('div');
  inner.className = 'greyInner';
  const m = line('Match');
  const l = line('Life');
  matchValue = m.value;
  lifeValue = l.value;
  inner.append(m.row, l.row);
  element.append(inner);
  spot.parent.insertBefore(element, spot.before);
  render();
}

function teardown(): void {
  if (timer !== null) { clearInterval(timer); timer = null; }
  unsubscribe?.();
  unsubscribe = null;
  ammoObserver?.disconnect();
  ammoObserver = null;
  ammoParent = null;
  uiObserver?.disconnect();
  uiObserver = null;
  uiBase = null;
  for (const counter of counters) counter.stop();
  element?.remove();
  element = null;
  matchValue = null;
  lifeValue = null;
  document.getElementById(STYLE_ID)?.remove();
  tally = EMPTY_TALLY;
  lastAmmo = null;
}
