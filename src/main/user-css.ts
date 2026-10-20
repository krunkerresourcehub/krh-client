// ── User CSS files ──
// Any number of .css files, each switched on or off on its own, stacked in alphabetical order on top of the
// selected theme.
// New files dropped into the folder show up switched on. Names are plain file names, never paths.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, extname, join } from 'path';
import { electronLog } from './logger';

export interface UserCssEntry { name: string; enabled: boolean; size: number }

const MAX_BYTES = 2 * 1024 * 1024;

export function safeCssName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = basename(raw);
  if (name !== raw || name.startsWith('.') || extname(name).toLowerCase() !== '.css' || name.length > 120) return null;
  return name;
}

export class UserCssManager {
  private readonly metaPath: string;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.metaPath = join(dir, 'meta.json');
  }

  private readMeta(): Record<string, boolean> {
    try {
      const raw = JSON.parse(readFileSync(this.metaPath, 'utf-8')) as Record<string, unknown>;
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'boolean') out[k] = v;
      return out;
    } catch { return {}; }
  }

  private writeMeta(meta: Record<string, boolean>): void {
    try { writeFileSync(this.metaPath, JSON.stringify(meta, null, 2), 'utf-8'); }
    catch (err) { electronLog.warn('[KRH] Could not save the CSS list:', (err as Error).message); }
  }

  list(): UserCssEntry[] {
    const meta = this.readMeta();
    const out: UserCssEntry[] = [];
    try {
      for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
        if (!entry.isFile() || !safeCssName(entry.name)) continue;
        out.push({ name: entry.name, enabled: meta[entry.name] !== false, size: statSync(join(this.dir, entry.name)).size });
      }
    } catch { /* folder gone: empty list */ }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Copy a file in (renamed with _1, _2 ... if the name is taken). Returns the stored name or an error text. */
  add(srcPath: string): { name: string } | { error: string } {
    const wanted = safeCssName(basename(srcPath));
    if (!wanted) return { error: 'Pick a .css file.' };
    try {
      if (statSync(srcPath).size > MAX_BYTES) return { error: 'That file is over 2 MB.' };
      let name = wanted;
      for (let i = 1; existsSync(join(this.dir, name)); i++) name = wanted.replace(/\.css$/i, `_${i}.css`);
      copyFileSync(srcPath, join(this.dir, name));
      return { name };
    } catch (err) { return { error: (err as Error).message }; }
  }

  /** The text of one file (for the editor). */
  read(rawName: unknown): string | null {
    const name = safeCssName(rawName);
    if (!name) return null;
    try { return readFileSync(join(this.dir, name), 'utf-8'); } catch { return null; }
  }

  /** Write the text of a file (new or existing) and switch it on. Used by the editor. */
  save(rawName: unknown, text: unknown): { name: string } | { error: string } {
    const name = safeCssName(rawName);
    if (!name) return { error: 'Use a plain file name ending in .css' };
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) return { error: 'The CSS is over 2 MB.' };
    try {
      writeFileSync(join(this.dir, name), text, 'utf-8');
      const meta = this.readMeta();
      if (meta[name] === false) { delete meta[name]; this.writeMeta(meta); }
      return { name };
    } catch (err) { return { error: (err as Error).message }; }
  }

  /** A new file from text (renamed with (2), (3) ... if the name is taken), switched on. Used by the website bridge. */
  create(baseName: string, text: string): { name: string } | { error: string } {
    // eslint-disable-next-line no-control-regex
    const stem = baseName.replace(/\.css$/i, '').replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').trim().slice(0, 100) || 'style';
    let name = stem + '.css';
    for (let i = 2; existsSync(join(this.dir, name)); i++) name = `${stem} (${i}).css`;
    return this.save(name, text);
  }

  toggle(rawName: unknown): boolean | null {
    const name = safeCssName(rawName);
    if (!name || !existsSync(join(this.dir, name))) return null;
    const meta = this.readMeta();
    meta[name] = meta[name] === false;
    this.writeMeta(meta);
    return meta[name];
  }

  remove(rawName: unknown): boolean {
    const name = safeCssName(rawName);
    if (!name) return false;
    try { rmSync(join(this.dir, name), { force: true }); } catch { return false; }
    const meta = this.readMeta();
    delete meta[name];
    this.writeMeta(meta);
    return true;
  }

  /** All switched-on files joined into one stylesheet. */
  combined(): string {
    let css = '';
    for (const f of this.list()) {
      if (!f.enabled) continue;
      try { css += `\n/* ${f.name} */\n${readFileSync(join(this.dir, f.name), 'utf-8')}\n`; } catch { /* unreadable: skip */ }
    }
    return css;
  }
}
