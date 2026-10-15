/*
 * Adapted from NM/NZ Client (https://github.com/nmallik1029/nm-nez-client), src/shared/accuracy.ts.
 * NM/NZ Client is GPL-3.0-or-later, like KRH Client. See THIRD_PARTY_NOTICES.md.
 */

/**
 * Live accuracy, for the match so far and for the life in progress: of the
 * shots you fired, how many landed.
 *
 * Nothing in the page keeps this -- the figure on Krunker's death screen is
 * built once, when you die -- so it is counted from two things the game does
 * show while you are alive:
 *
 *  - SHOTS come off the ammo counter. It drops by one per shot. It also moves
 *    for reasons that are not shooting, and those are the whole difficulty:
 *    a reload sends it up, and a weapon swap sends it anywhere, including
 *    down by 24 when a full 30-round gun gives way to a 6-round one.
 *  - HITS come off the hit sound. Krunker's own sound manager plays `hit_0`
 *    on the frame the game decides a shot of yours connected, which is the
 *    signal the custom hitmarker settled on after the #hitmarker element
 *    turned out never to be touched in a live match.
 *
 * What is counted is shots that landed, not bullets that did. A shotgun
 * shell plays a hit for every pellet and a headshot plays `hit_0` and
 * `headshot_0` together; counting sounds would put both over 100%. So a hit
 * claims one waiting shot, sounds on the same frame are one hit, and a hit
 * with no shot waiting -- a knife -- claims nothing.
 *
 * Pure, so the arithmetic is testable without being in a match.
 */

export interface AmmoReading {
  readonly value: number;
  /**
   * The magazine size, which is what tells one weapon from another. 0 when
   * the page does not show one, so two unknowns still compare as the same.
   */
  readonly max: number;
}

/**
 * The most shots one update of the ammo counter can stand for.
 *
 * A burst weapon lands three rounds between two looks at the page. Much past
 * that is not gunfire: it is a swap between two guns that happen to share a
 * magazine size, which the size check cannot see.
 */
export const MAX_SHOTS_PER_UPDATE = 5;

/**
 * How long a shot waits for its hit before it is a miss.
 *
 * Hitscan lands on the same frame, but rockets and crossbow bolts travel.
 * Long enough for those; short enough that a hit a second later is not
 * credited to a shot that plainly went wide.
 */
export const HIT_WINDOW_MS = 1200;

/**
 * Hit sounds this close together are one shot landing.
 *
 * Every pellet of a shotgun shell, or `hit_0` beside `headshot_0`, arrive on
 * the same frame. The fastest weapons Krunker has fire far slower than this,
 * so two genuinely separate hits are never merged.
 */
export const HIT_MERGE_MS = 30;

/** The ammo counter as numbers, or null when the thing in hand has none. */
export function readAmmo(
  valueText: string | null | undefined,
  maxText: string | null | undefined,
): AmmoReading | null {
  const value = digits(valueText);
  if (value === null) return null;
  return { value, max: digits(maxText) ?? 0 };
}

function digits(text: string | null | undefined): number | null {
  const cleaned = (text ?? '').replace(/\D/g, '');
  if (cleaned === '') return null;
  return Number.parseInt(cleaned, 10);
}

/**
 * How many shots the ammo counter moving from `prev` to `next` means.
 *
 * Zero whenever the move is not gunfire: the first reading, which is only a
 * baseline; the counter going up, which is a reload; a different magazine
 * size, which is a different weapon; and a drop too large to be shooting.
 */
export function shotsBetween(prev: AmmoReading | null, next: AmmoReading | null): number {
  if (!prev || !next) return 0;
  if (next.max !== prev.max) return 0;
  const drop = prev.value - next.value;
  if (drop <= 0 || drop > MAX_SHOTS_PER_UPDATE) return 0;
  return drop;
}

export interface AccuracyState {
  readonly shots: number;
  readonly landed: number;
  /** When each shot not yet matched to a hit was fired, oldest first. */
  readonly waiting: readonly number[];
  /** When the last hit was counted, so the rest of its frame is merged in. */
  readonly lastHitAt: number;
}

export const EMPTY_ACCURACY: AccuracyState = {
  shots: 0,
  landed: 0,
  waiting: [],
  lastHitAt: Number.NEGATIVE_INFINITY,
};

function stillWaiting(waiting: readonly number[], now: number): number[] {
  return waiting.filter((firedAt) => now - firedAt <= HIT_WINDOW_MS);
}

export function withShots(state: AccuracyState, count: number, now: number): AccuracyState {
  if (count <= 0) return state;
  return {
    ...state,
    shots: state.shots + count,
    waiting: [...stillWaiting(state.waiting, now), ...Array<number>(count).fill(now)],
  };
}

export function withHit(state: AccuracyState, now: number): AccuracyState {
  if (now - state.lastHitAt < HIT_MERGE_MS) return state;

  const waiting = stillWaiting(state.waiting, now);
  // Nothing fired recently enough to have caused this: a knife, most likely.
  if (waiting.length === 0) return { ...state, waiting, lastHitAt: now };

  return {
    shots: state.shots,
    landed: state.landed + 1,
    // The oldest waiting shot is the one a hit can most plausibly belong to.
    waiting: waiting.slice(1),
    lastHitAt: now,
  };
}

/**
 * The match so far and the life in progress, side by side.
 *
 * Both are handed every shot and every hit, and dying clears only the life.
 * The match is its own count rather than a sum of finished lives so that a
 * rocket fired just before you die still lands in it: the life that fired it
 * is gone by the time the hit sounds, and the match is not.
 */
export interface AccuracyTally {
  readonly match: AccuracyState;
  readonly life: AccuracyState;
  /**
   * The last life that fired a shot, which the life line shows from the
   * moment you die until the new life's first shot. A dash the instant you
   * die would take the figure away at the one moment you are likely to look
   * at it.
   */
  readonly lastLife: AccuracyState;
}

export const EMPTY_TALLY: AccuracyTally = {
  match: EMPTY_ACCURACY,
  life: EMPTY_ACCURACY,
  lastLife: EMPTY_ACCURACY,
};

export function tallyShots(tally: AccuracyTally, count: number, now: number): AccuracyTally {
  if (count <= 0) return tally;
  return {
    ...tally,
    match: withShots(tally.match, count, now),
    life: withShots(tally.life, count, now),
  };
}

export function tallyHit(tally: AccuracyTally, now: number): AccuracyTally {
  return { ...tally, match: withHit(tally.match, now), life: withHit(tally.life, now) };
}

/**
 * A death. Safe to call twice for one: a life with no shots in it hands
 * nothing on, so the second call keeps the figure the first one kept.
 */
export function tallyNewLife(tally: AccuracyTally): AccuracyTally {
  return {
    match: tally.match,
    life: EMPTY_ACCURACY,
    lastLife: tally.life.shots > 0 ? tally.life : tally.lastLife,
  };
}

/** What the life line shows: this life once it has fired, the last one until then. */
export function lifeShown(tally: AccuracyTally): AccuracyState {
  return tally.life.shots > 0 ? tally.life : tally.lastLife;
}

/** What the HUD shows: a percentage, or a dash before the first shot. */
export function accuracyLabel(state: AccuracyState): string {
  if (state.shots === 0) return '-';
  return `${Math.round((state.landed / state.shots) * 100)}%`;
}
