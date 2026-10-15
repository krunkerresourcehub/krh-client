/*
 * Adapted from NM/NZ Client (https://github.com/nmallik1029/nm-nez-client), src/main/lite-swap.ts.
 * NM/NZ Client is GPL-3.0-or-later, like KRH Client. See THIRD_PARTY_NOTICES.md.
 * Changes: swapFolder removed (KRH ships nothing beside app.asar).
 */

import { createHash } from 'node:crypto';

/**
 * The part of updating without the installer that touches the live install:
 * putting a staged app.asar and staged folders where the running ones are.
 *
 * Its own module, with the fs handed in, so the one step that could leave an
 * install broken is tested against real files, including the case Windows
 * forces when the running app holds app.asar open. See `lite-update.ts`.
 */

/** The fs calls this needs, so a test can hand in one that refuses a rename. */
export interface SwapFs {
  existsSync(path: string): boolean;
  readFileSync(path: string): Uint8Array;
  writeFileSync(path: string, data: Uint8Array): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string, options: { recursive?: boolean; force?: boolean }): void;
  openSync(path: string, flags: string): number;
  writeSync(fd: number, data: Uint8Array, offset: number, length: number, position: number): number;
  ftruncateSync(fd: number, length: number): void;
  closeSync(fd: number): void;
}

export interface AsarPaths {
  readonly live: string;
  readonly staged: string;
  readonly previous: string;
}

export function sha512(data: Uint8Array): string {
  return createHash('sha512').update(data).digest('base64');
}

function writeOver(fs: SwapFs, path: string, data: Uint8Array): void {
  const fd = fs.openSync(path, 'r+');
  try {
    fs.writeSync(fd, data, 0, data.length, 0);
    fs.ftruncateSync(fd, data.length);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Put the staged app.asar where the live one is, whatever the running app is
 * doing with it.
 *
 * A rename first, which is the clean way: if Windows lets the open file be
 * renamed, the running process keeps reading the old one under its new name
 * and the next launch opens the new one. If the handle Electron holds does
 * not allow that, the file is written over in place instead, which Windows
 * does allow, from a backup it can be put back from if the result does not
 * read back as the release's hash. Only safe because it runs at the very end
 * of quitting, when nothing is left to read the app.
 *
 * Returns how it was done, for the log.
 */
export function swapAsar(
  fs: SwapFs,
  paths: AsarPaths,
  expectedSha512: string,
): 'renamed' | 'written' {
  const { live, staged, previous } = paths;
  fs.rmSync(previous, { force: true });

  try {
    fs.renameSync(live, previous);
  } catch {
    const old = fs.readFileSync(live);
    fs.writeFileSync(previous, old);
    writeOver(fs, live, fs.readFileSync(staged));
    if (sha512(fs.readFileSync(live)) !== expectedSha512) {
      writeOver(fs, live, old);
      throw new Error('app.asar did not read back as written; the old one is back');
    }
    fs.rmSync(staged, { force: true });
    return 'written';
  }

  try {
    fs.renameSync(staged, live);
  } catch (err) {
    fs.renameSync(previous, live);
    throw err;
  }
  return 'renamed';
}
