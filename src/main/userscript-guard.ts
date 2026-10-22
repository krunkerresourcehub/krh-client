// Switches off a userscript that makes the game crash.
//
// A script is "trusted" once the game has run for a few minutes with it switched on (and unchanged). A script that is
// new or was edited since is a "suspect". When the game window crashes or hangs, the suspects are switched off, the
// game reloads without them and the dashboard shows what was turned off and why, with a button to turn them back on.
// A script that throws an error while starting three launches in a row is switched off too.
//
// If every enabled script was already trusted when the game crashed, nothing is switched off: the cause is then
// something else (GPU, driver, the game itself) and blaming a script would be a guess.

import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { UserscriptManager } from './userscripts';

export interface AutoDisabled { file: string; reason: string; at: number }
interface State { trusted: Record<string, string>; autoDisabled: AutoDisabled[]; loadErrors: Record<string, { fp: string; count: number; last: number }> }

const fingerprint = (content: string): string => createHash('sha1').update(content).digest('hex').slice(0, 16);
const MAX_LIST = 20;

export class UserscriptGuard {
  private state: State = { trusted: {}, autoDisabled: [], loadErrors: {} };
  private suspects = new Set<string>();
  private sessionStart = 0;

  constructor(private readonly path: string, private readonly mgr: UserscriptManager) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<State>;
      if (raw && typeof raw === 'object') {
        this.state = {
          trusted: raw.trusted && typeof raw.trusted === 'object' ? raw.trusted : {},
          autoDisabled: Array.isArray(raw.autoDisabled) ? raw.autoDisabled.filter((x) => x && typeof x.file === 'string').slice(0, MAX_LIST) : [],
          loadErrors: raw.loadErrors && typeof raw.loadErrors === 'object' ? raw.loadErrors : {},
        };
      }
    } catch { /* first run */ }
  }

  private save(): void {
    try { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify(this.state), 'utf-8'); } catch { /* best effort */ }
  }

  /** Called when a game starts: works out which enabled scripts are not trusted yet. */
  async beginSession(): Promise<void> {
    this.sessionStart = Date.now();
    this.suspects.clear();
    try {
      const scripts = await this.mgr.scanScripts();
      const tracker = await this.mgr.loadTracker(scripts);
      for (const s of scripts) {
        if (tracker[s.filename] === false) continue;
        if (this.state.trusted[s.filename] !== fingerprint(s.content)) this.suspects.add(s.filename);
      }
    } catch { /* no scripts */ }
  }

  /** The game stayed up for a while: every enabled script is trusted from now on. */
  async markHealthy(): Promise<void> {
    try {
      const scripts = await this.mgr.scanScripts();
      const tracker = await this.mgr.loadTracker(scripts);
      for (const s of scripts) {
        if (tracker[s.filename] === false) continue;
        this.state.trusted[s.filename] = fingerprint(s.content);
        delete this.state.loadErrors[s.filename];
      }
      this.suspects.clear();
      this.save();
    } catch { /* ignore */ }
  }

  /** Seconds since the game started (a crash long after the start is not blamed on a script that was trusted by then). */
  sessionAgeSec(): number { return this.sessionStart ? Math.round((Date.now() - this.sessionStart) / 1000) : 0; }

  private async disable(files: string[], reason: string): Promise<string[]> {
    if (files.length === 0) return [];
    const scripts = await this.mgr.scanScripts();
    const tracker = await this.mgr.loadTracker(scripts);
    const done: string[] = [];
    for (const f of files) {
      if (tracker[f] === false) continue;
      tracker[f] = false;
      done.push(f);
      this.state.autoDisabled = [{ file: f, reason, at: Date.now() }, ...this.state.autoDisabled.filter((x) => x.file !== f)].slice(0, MAX_LIST);
      delete this.state.trusted[f];
    }
    if (done.length) { await this.mgr.saveTracker(tracker); this.save(); }
    return done;
  }

  /** The game crashed or hung: switch off the suspects. Returns the file names that were turned off. */
  async failure(reason: string): Promise<string[]> {
    const names = [...this.suspects];
    this.suspects.clear();
    return this.disable(names, `Turned off because ${reason} after it was added or changed`);
  }

  /** A script threw an error while starting. After three launches in a row it is switched off. */
  async loadError(file: string): Promise<string | null> {
    let fp: string;
    try { const s = (await this.mgr.scanScripts()).find((x) => x.filename === file); if (!s) return null; fp = fingerprint(s.content); } catch { return null; }
    const cur = this.state.loadErrors[file];
    // one count per game start, and only for the same version of the script
    if (cur && cur.fp === fp && Date.now() - cur.last < 20_000) return null;
    const count = cur && cur.fp === fp ? cur.count + 1 : 1;
    this.state.loadErrors[file] = { fp, count, last: Date.now() };
    if (count < 3) { this.save(); return null; }
    delete this.state.loadErrors[file];
    const done = await this.disable([file], 'Turned off because it failed with an error on 3 launches in a row');
    return done[0] ?? null;
  }

  list(): AutoDisabled[] { return this.state.autoDisabled.slice(); }

  /** The player wants a script back: switch it on again and keep watching it. */
  async reenable(file: string): Promise<boolean> {
    if (!this.state.autoDisabled.some((x) => x.file === file)) return false;
    const scripts = await this.mgr.scanScripts();
    if (!scripts.some((s) => s.filename === file)) { this.dismiss(file); return false; }
    const tracker = await this.mgr.loadTracker(scripts);
    tracker[file] = true;
    await this.mgr.saveTracker(tracker);
    delete this.state.loadErrors[file];
    this.dismiss(file);
    return true;
  }

  dismiss(file: string): void {
    this.state.autoDisabled = this.state.autoDisabled.filter((x) => x.file !== file);
    this.save();
  }
}
