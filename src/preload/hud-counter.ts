/*
 * Adapted from NM/NZ Client (https://github.com/nmallik1029/nm-nez-client), src/preload/look/hud-counter.ts.
 * NM/NZ Client is GPL-3.0-or-later, like KRH Client. See THIRD_PARTY_NOTICES.md.
 */

/**
 * Watch one of Krunker's HUD counters for changes.
 *
 * Shared by kill streak and live accuracy, which both need to know when you
 * die and when a match starts over, and both read it the same way:
 *
 *  - going up is the event,
 *  - going down is a new match,
 *  - the first reading after attaching is only a baseline. Joining a match
 *    already on twelve kills is not twelve kills just now, and nor is Krunker
 *    rebuilding its HUD mid-round.
 *
 * `attach` is safe to call on a timer, and should be. Krunker replaces chunks
 * of its HUD, and an observer left on a detached node goes quiet without ever
 * erroring; re-attaching only does anything when the element has changed.
 */

export interface HudCounter {
  attach(): void;
  stop(): void;
}

export function watchCounter(
  id: string,
  onUp: (gained: number) => void,
  onDown: () => void,
): HudCounter {
  let el: HTMLElement | null = null;
  let last: number | null = null;
  let observer: MutationObserver | null = null;

  const read = (): void => {
    if (!el) return;
    const value = Number.parseInt(el.textContent ?? '', 10);
    if (Number.isNaN(value)) return;
    const previous = last;
    last = value;
    if (previous === null) return;
    if (value < previous) onDown();
    else if (value > previous) onUp(value - previous);
  };

  return {
    attach(): void {
      const now = document.getElementById(id);
      if (!now || now === el) return;
      observer?.disconnect();
      el = now;
      last = null;
      observer = new MutationObserver(read);
      observer.observe(now, { childList: true, characterData: true, subtree: true });
      // The baseline, so the first real change is a change.
      read();
    },
    stop(): void {
      observer?.disconnect();
      observer = null;
      el = null;
      last = null;
    },
  };
}
