// ── Screenshot capture ──
// Capture the game view to the clipboard, optionally saving a timestamped PNG.
// index.ts wires takeScreenshot() to the screenshot keybind and openScreenshotsFolder()
// to the open-folder IPC handler.

import { app, BrowserWindow, clipboard, shell } from 'electron';
import { join } from 'path';
import { promises as fsp } from 'fs';
import { config } from './config';
import { electronLog } from './logger';

function screenshotDir(): string {
  return join(app.getPath('userData'), 'KRH Client', 'screenshots');
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export async function takeScreenshot(win: BrowserWindow): Promise<void> {
  try {
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) {
      electronLog.warn('[KRH] Screenshot: capturePage returned an empty image (nothing captured)');
      return;
    }
    clipboard.writeImage(image);
    let savedPath = '';
    if (config.get('game').screenshotSave) {
      const dir = screenshotDir();
      await fsp.mkdir(dir, { recursive: true });
      savedPath = join(dir, `Krunker_${timestamp()}.png`);
      await fsp.writeFile(savedPath, image.toPNG());
    }
    electronLog.log(`[KRH] Screenshot copied to clipboard${savedPath ? ` + saved to ${savedPath}` : ''}`);
    if (!win.isDestroyed()) {
      win.webContents.send('krh-toast', savedPath ? 'Screenshot copied + saved' : 'Screenshot copied to clipboard');
    }
  } catch (err) {
    electronLog.error('[KRH] Screenshot failed:', err);
    if (!win.isDestroyed()) win.webContents.send('krh-toast', 'Screenshot failed');
  }
}

export async function openScreenshotsFolder(): Promise<string> {
  const dir = screenshotDir();
  await fsp.mkdir(dir, { recursive: true });
  return shell.openPath(dir);
}
