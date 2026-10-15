/*
 * Adapted from NM/NZ Client (https://github.com/nmallik1029/nm-nez-client), src/shared/escape-lock.ts.
 * NM/NZ Client is GPL-3.0-or-later, like KRH Client. See THIRD_PARTY_NOTICES.md.
 * Changes: comment wording, and the IPC channel names live in main/index.ts and preload/escape-lock.ts.
 */

/**
 * Escape, taken in the main process while the game holds the mouse.
 *
 * WHY. Pressing Escape to leave a match made clicking back in take about two
 * seconds, however fast you clicked. Chromium says so in as many words:
 * "Pointer lock cannot be acquired immediately after the user has exited the
 * lock." It counts Escape as you leaving the lock and makes the next request
 * wait. A lock the page releases from code carries no such wait, and neither
 * does losing it to Alt-Tab, which is why that clicked straight back in.
 *
 * WHERE IT HAS TO BE TAKEN. The first attempt took the key in
 * `before-input-event` and changed nothing: Chromium's view layer releases the
 * lock on Escape before Electron emits that event, so by the time the key
 * could be refused it had already counted. So while the game holds the mouse
 * and its window is focused, Escape is registered as a global shortcut, which
 * Windows consumes before the window receives a keystroke at all. The lock is
 * then released from main at once, because the keyUp is not consumed and
 * counts as escaping just the same if the lock is still held when it lands:
 * see takeEscape in main/index.ts. Registered only for that long, so no other
 * application ever loses the key.
 *
 * Only while the mouse is locked and nothing is being typed into, which the
 * page reports. Everywhere else Escape reaches the page untouched: it still
 * closes chat, menus, windows and the client's own dialogs.
 *
 * Pure, because the awkward part is the rest of the press. Taking a keyDown
 * and letting its keyUp through would hand the page half a keystroke, and a
 * held Escape repeats: after the first repeat the lock is already gone, so a
 * repeat judged on its own would reach Krunker and act on the menu that just
 * opened. Once a press is taken, the whole press is taken.
 */

/** The fields of Electron's `before-input-event` input that matter here. */
export interface EscapeKeyInput {
  readonly type: string;
  readonly key: string;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

export interface EscapeStep {
  /** `release` means take the key and have the page release the lock. */
  readonly action: 'pass' | 'release' | 'swallow';
  /** Whether a press is being taken, carried to the next event. */
  readonly holding: boolean;
}

/**
 * Should Escape be taken at the OS level right now?
 *
 * Only while both hold. Focus is what keeps this from ever taking Escape off
 * another application: the moment the game window is not the one you are
 * typing into, the shortcut goes.
 *
 * There is no setting for it. It used to be one, but Escape costing two
 * seconds to click back in was a bug, not a preference.
 */
export function wantEscapeShortcut(state: {
  readonly pageLocked: boolean;
  readonly focused: boolean;
}): boolean {
  return state.pageLocked && state.focused;
}

/**
 * Every Escape the OS shortcut has to take, held modifiers and all.
 *
 * A Windows hotkey fires only on its exact modifier state, so a shortcut for
 * Escape alone lets Shift+Escape straight through. Chromium does not care:
 * its exclusive access manager releases the lock on an Escape with any
 * modifiers held, and starts the same refusal as a plain one. In a match that
 * is most presses -- crouch and slide are held on Shift or Ctrl -- which is
 * why Escape stayed fast on the end screen, where nobody is holding anything,
 * and kept going slow in game.
 *
 * Never Ctrl+Shift+Escape. That is Task Manager, and a game that has frozen
 * with the mouse locked is exactly when somebody needs it.
 */
export const ESCAPE_ACCELERATORS: readonly string[] = [
  'Escape',
  'Shift+Escape',
  'Control+Escape',
  'Alt+Escape',
  'Shift+Alt+Escape',
  'Control+Alt+Escape',
];

/**
 * How long a taken press stays taken without hearing from its key again.
 *
 * The global shortcut takes the keyDown, so its repeats and keyUp are what
 * tell this the press has ended. If a keyUp is ever lost, a press left held
 * forever would swallow the next Escape you press to close a menu. Each
 * repeat refreshes the time, so a long hold is still one press.
 */
export const HOLD_EXPIRY_MS = 2000;

export function stillHolding(holdingSince: number | null, now: number): boolean {
  return holdingSince !== null && now - holdingSince < HOLD_EXPIRY_MS;
}

export function stepEscape(
  input: EscapeKeyInput,
  pageLocked: boolean,
  holding: boolean,
): EscapeStep {
  if (input.key !== 'Escape') return { action: 'pass', holding };

  // The repeats and the keyUp of a press already taken go with it. The keyUp
  // is the end of that press.
  if (holding) return { action: 'swallow', holding: input.type !== 'keyUp' };

  // A modified Escape is somebody's shortcut, not leaving the game.
  const plain = !input.control && !input.alt && !input.shift && !input.meta;
  if (input.type !== 'keyDown' || !plain || !pageLocked) return { action: 'pass', holding: false };

  return { action: 'release', holding: true };
}
