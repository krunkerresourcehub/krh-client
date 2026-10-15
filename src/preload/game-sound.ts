/*
 * Adapted from NM/NZ Client (https://github.com/nmallik1029/nm-nez-client), src/preload/look/game-sound.ts.
 * NM/NZ Client is GPL-3.0-or-later, like KRH Client. See THIRD_PARTY_NOTICES.md.
 */

/**
 * Krunker's sound manager, as something several features can listen to.
 *
 * `window.SOUND.play(name)` is the game's own audio, and a few of its sounds
 * are the most reliable signals the page gives: `hit_0` plays on the frame
 * the game decides a shot of yours landed. The custom hitmarker found that
 * out after the #hitmarker element turned out never to be touched in a live
 * match, and live accuracy counts hits off the same sounds.
 *
 * One wrap for all of them rather than one each. Each extra wrapper is
 * another function on the path of every sound the game plays, and the retry
 * logic below is the part worth having exactly once.
 *
 * Wrapped, never replaced, and the original is always called: this is on the
 * path that makes the sounds you hear, so anything it swallows or throws is
 * audible. A listener that throws is contained for the same reason. Never
 * unwrapped either -- with no listeners it is one Set iteration per sound --
 * because unwrapping would drop any wrapper added on top of it since, such as
 * the built-in headshot script's.
 */

/** The sounds Krunker plays when a shot of yours lands. */
export const HIT_SOUNDS: ReadonlySet<string> = new Set(['hit_0', 'headshot_0', 'instantkill_0']);

/** The sound manager only exists once the game has booted. */
const HOOK_RETRY_MS = 2000;
/**
 * How many times to look for it before giving up.
 *
 * Two minutes. The preload also runs on Krunker's other pages, and social.html
 * has no sound manager and never will, so something has to stop asking.
 */
const HOOK_ATTEMPTS = 60;

interface SoundManager {
  play: (name: string, ...rest: unknown[]) => unknown;
}

type Listener = (name: string) => void;

const listeners = new Set<Listener>();
let hooked = false;
let attempts = 0;
let retryTimer: ReturnType<typeof setInterval> | null = null;

/** Hear every sound the game plays from here on. Returns an unsubscribe. */
export function onGameSound(listener: Listener): () => void {
  listeners.add(listener);
  hook();
  return () => {
    listeners.delete(listener);
  };
}

function hook(): void {
  if (hooked) return;

  const sound = (window as unknown as { SOUND?: SoundManager }).SOUND;
  if (!sound || typeof sound.play !== 'function') {
    attempts += 1;
    if (attempts >= HOOK_ATTEMPTS) {
      stopRetrying();
      return;
    }
    if (retryTimer === null) retryTimer = setInterval(hook, HOOK_RETRY_MS);
    return;
  }

  const original = sound.play.bind(sound);
  sound.play = function patched(name: string, ...rest: unknown[]): unknown {
    for (const listener of listeners) {
      try {
        listener(name);
      } catch {
        // Never let a feature break the game's audio.
      }
    }
    return original(name, ...rest);
  };

  hooked = true;
  stopRetrying();
}

function stopRetrying(): void {
  if (retryTimer === null) return;
  clearInterval(retryTimer);
  retryTimer = null;
}
