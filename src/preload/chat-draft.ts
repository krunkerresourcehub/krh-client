// ── Friend chat draft keeper ──
// Adapted from Kute (https://github.com/NullDev/Kute, src/frontend/modules/chatDraft.js), GPL-3.0.
// Modified for KRH Client 1.0.1: rewritten in TypeScript, switchable at runtime.
//
// Krunker clears the text box of a friend conversation whenever the conversation re-renders, and it
// re-renders on every incoming message, so a half-typed reply vanishes. This remembers the unsent text
// and puts it back, unless the box was emptied because the message was sent.

const SEND_WINDOW_MS = 250;
const INPUT_CLASS = 'conversation-input';

interface Draft {
  input: HTMLTextAreaElement;
  friend: string;
  text: string;
  start: number;
  end: number;
}

let active = false;
let draft: Draft | null = null;
let observer: MutationObserver | null = null;
let pending: ReturnType<typeof setTimeout> | null = null;
let sentAt = 0;
const tracked = new WeakSet<HTMLTextAreaElement>();

function friendOf(input: HTMLTextAreaElement): string {
  return input.closest('.conversation-root')?.querySelector('.conversation-header-name')?.textContent ?? '';
}

function stop(): void {
  draft = null;
  observer?.disconnect();
  observer = null;
  if (pending !== null) { clearTimeout(pending); pending = null; }
}

function save(input: HTMLTextAreaElement): void {
  if (!active) return;
  if (!input.value) { stop(); return; }
  draft = { input, friend: friendOf(input), text: input.value, start: input.selectionStart, end: input.selectionEnd };
  if (observer) return;
  const root = input.closest('.conversation-root');
  if (!root) return;
  observer = new MutationObserver(schedule);
  observer.observe(root, { childList: true, subtree: true, characterData: true });
}

// The game sets the value in a later microtask than the DOM update that wakes the observer.
function schedule(): void {
  if (pending === null) pending = setTimeout(check, 0);
}

function check(): void {
  pending = null;
  if (!active || !draft) return;
  const { input } = draft;
  if (!input.isConnected || friendOf(input) !== draft.friend) { stop(); return; }
  if (input.value) { save(input); return; } // emoji picks change the value without an input event
  if (performance.now() - sentAt < SEND_WINDOW_MS) { stop(); return; }
  input.value = draft.text;
  if (document.activeElement === input) input.setSelectionRange(draft.start, draft.end);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function track(input: HTMLTextAreaElement): void {
  if (tracked.has(input)) return;
  tracked.add(input);
  input.addEventListener('input', () => save(input));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) sentAt = performance.now();
  });
  input.closest('.conversation-compose')?.querySelector('.conversation-send-button')?.addEventListener('click', () => {
    sentAt = performance.now();
  });
  if (input.value) save(input);
}

// focusin instead of a document keydown listener: that one would run on every key press during a match.
function onFocusIn(event: FocusEvent): void {
  const input = event.target;
  if (input instanceof HTMLTextAreaElement && input.classList.contains(INPUT_CLASS)) track(input);
}

export function setChatDraft(on: boolean): void {
  if (on === active) return;
  active = on;
  if (on) {
    document.addEventListener('focusin', onFocusIn);
  } else {
    document.removeEventListener('focusin', onFocusIn);
    stop();
  }
}
