import { app } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

/**
 * User-editable lists (ported idea from Glorp's user_blocklist.json / user_flags.json).
 * Both files live in <userData>/KRH Client/ and are created with an example on first run.
 * A broken file is ignored (defaults are used) and never overwritten.
 */
export function userListsDir(): string {
  return join(app.getPath('userData'), 'KRH Client');
}

function readJson(file: string, example: string): any | null {
  try {
    mkdirSync(userListsDir(), { recursive: true });
    if (!existsSync(file)) writeFileSync(file, example, 'utf-8');
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

// ── URL blocklist ──
const BLOCKLIST_EXAMPLE = `{
  "_help": "Add URL patterns to block under \\"blocked\\", e.g. \\"*://*.example.com/*\\". To re-enable a built-in blocked URL, put its exact pattern under \\"disabled_defaults\\". Restart KRH Client after editing.",
  "blocked": [],
  "disabled_defaults": []
}
`;

// Chromium match pattern: scheme://host/path — all three parts required.
const MATCH_PATTERN_RE = /^(\*|https?|wss?):\/\/(\*|\*\.[^/*]+|[^/*]+)\/.*$/;

function normalizePattern(p: unknown): string | null {
  if (typeof p !== 'string') return null;
  let s = p.trim();
  if (!s) return null;
  if (/^(\*|https?|wss?):\/\/[^/]+$/.test(s)) s += '/*'; // "*://host" -> "*://host/*"
  return MATCH_PATTERN_RE.test(s) ? s : null;
}

function patternToRegExp(pattern: string): string {
  return '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
}

export interface BlocklistResult {
  /** Built-in patterns minus the ones the user disabled. */
  defaults: string[];
  /** The user's own valid patterns. */
  extra: string[];
  /** Matches any of the user's own patterns (also covers krunker.io hosts). */
  extraRe: RegExp | null;
}

export function loadBlocklist(defaults: string[], warn: (msg: string) => void): BlocklistResult {
  const json = readJson(join(userListsDir(), 'user_blocklist.json'), BLOCKLIST_EXAMPLE);
  if (!json || typeof json !== 'object') {
    warn('[KRH] user_blocklist.json unreadable — using default blocklist only');
    return { defaults, extra: [], extraRe: null };
  }
  const disabled = new Set<string>(Array.isArray(json.disabled_defaults) ? json.disabled_defaults.filter((x: unknown) => typeof x === 'string') : []);
  const extra: string[] = [];
  for (const raw of Array.isArray(json.blocked) ? json.blocked : []) {
    const n = normalizePattern(raw);
    if (n) extra.push(n);
    else if (typeof raw === 'string' && raw.trim()) warn(`[KRH] user_blocklist.json: ignoring invalid pattern "${raw}"`);
  }
  const extraRe = extra.length ? new RegExp(extra.map(patternToRegExp).join('|')) : null;
  return { defaults: defaults.filter((d) => !disabled.has(d)), extra, extraRe };
}

// ── Chromium flags ──
const FLAGS_EXAMPLE = `{
  "_help": "Extra Chromium flags, one per entry, e.g. \\"--disable-gpu-vsync\\". Restart KRH Client after editing.",
  "flags": []
}
`;

// Switches that can run arbitrary programs or weaken the sandbox are never accepted from this file.
const FORBIDDEN_FLAG_RE = /^(no-sandbox|disable-setuid-sandbox|disable-gpu-sandbox-off|remote-debugging-.*|remote-allow-origins|.*-cmd-prefix|gpu-launcher|browser-subprocess-path|load-extension|disable-extensions-except|renderer-startup-dialog|js-flags-unsafe)$/;

export function loadUserFlags(warn: (msg: string) => void): Array<{ name: string; value: string }> {
  const json = readJson(join(userListsDir(), 'user_flags.json'), FLAGS_EXAMPLE);
  const out: Array<{ name: string; value: string }> = [];
  if (!json || !Array.isArray(json.flags)) return out;
  for (const raw of json.flags) {
    if (typeof raw !== 'string') continue;
    const m = /^--?([A-Za-z0-9][A-Za-z0-9-]*)(?:=(.*))?$/.exec(raw.trim());
    if (!m) { warn(`[KRH] user_flags.json: ignoring invalid flag "${raw}"`); continue; }
    if (FORBIDDEN_FLAG_RE.test(m[1])) { warn(`[KRH] user_flags.json: flag "${m[1]}" is not allowed`); continue; }
    out.push({ name: m[1], value: m[2] ?? '' });
  }
  return out;
}
