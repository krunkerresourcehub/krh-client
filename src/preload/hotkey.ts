// Small key-combination helper for the settings that take a key such as "F6" or "Ctrl+Alt+M".
// Modifiers must match exactly (a plain "F6" does not fire while Ctrl is held).

interface Combo { key: string; ctrl: boolean; alt: boolean; shift: boolean }

const cache = new Map<string, Combo | null>();

export function parseCombo(spec: string): Combo | null {
  const raw = String(spec || '').trim();
  if (!raw) return null;
  if (cache.has(raw)) return cache.get(raw) ?? null;
  let combo: Combo | null = null;
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length) {
    const c: Combo = { key: '', ctrl: false, alt: false, shift: false };
    for (const p of parts.slice(0, -1)) {
      const l = p.toLowerCase();
      if (l === 'ctrl' || l === 'control') c.ctrl = true;
      else if (l === 'alt') c.alt = true;
      else if (l === 'shift') c.shift = true;
    }
    c.key = parts[parts.length - 1].toLowerCase();
    // a lone "+" key is written as "Ctrl++" which splits into an empty last part
    combo = c.key ? c : null;
  }
  cache.set(raw, combo);
  return combo;
}

export function matchCombo(e: KeyboardEvent, spec: string): boolean {
  const c = parseCombo(spec);
  if (!c) return false;
  if (e.ctrlKey !== c.ctrl || e.altKey !== c.alt || e.shiftKey !== c.shift) return false;
  if (e.key.toLowerCase() === c.key) return true;
  // Alt (AltGr) can change e.key on some layouts, so letters and digits also match the physical key
  if (c.key.length === 1) {
    if (/[a-z]/.test(c.key)) return e.code === 'Key' + c.key.toUpperCase();
    if (/[0-9]/.test(c.key)) return e.code === 'Digit' + c.key;
  }
  return false;
}

/** True when the key press happens inside a text box (so a shortcut should not steal it). */
export function typingInField(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable === true;
}
