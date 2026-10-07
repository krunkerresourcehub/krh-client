// ── Screenshot capture ──
// Capture the game view to the clipboard, optionally saving a timestamped PNG.
// index.ts wires takeScreenshot() to the screenshot keybind and openScreenshotsFolder()
// to the open-folder IPC handler.

import { app, BrowserWindow, clipboard, ipcMain, nativeImage, shell } from 'electron';
import { join } from 'path';
import { mkdirSync, promises as fsp, writeFileSync } from 'fs';
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

/** Copy an image to the clipboard, optionally save it as PNG, and tell the game window. */
async function deliver(win: BrowserWindow, image: Electron.NativeImage, kind: string): Promise<void> {
  clipboard.writeImage(image);
  let savedPath = '';
  if (config.get('game').screenshotSave) {
    const dir = screenshotDir();
    await fsp.mkdir(dir, { recursive: true });
    savedPath = join(dir, `Krunker_${timestamp()}.png`);
    await fsp.writeFile(savedPath, image.toPNG());
  }
  const { width, height } = image.getSize();
  electronLog.log(`[KRH] ${kind} (${width}x${height}) copied to clipboard${savedPath ? ` + saved to ${savedPath}` : ''}`);
  if (!win.isDestroyed()) {
    win.webContents.send('krh-toast', savedPath ? 'Screenshot copied + saved' : 'Screenshot copied to clipboard');
  }
}

export async function takeScreenshot(win: BrowserWindow): Promise<void> {
  try {
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) {
      electronLog.warn('[KRH] Screenshot: capturePage returned an empty image (nothing captured)');
      return;
    }
    await deliver(win, image, 'Screenshot');
  } catch (err) {
    electronLog.error('[KRH] Screenshot failed:', err);
    if (!win.isDestroyed()) win.webContents.send('krh-toast', 'Screenshot failed');
  }
}

// ── Area screenshot (Snipping Tool style) ──
// 1. Freeze the current game view. 2. Cover the game window with a borderless overlay showing that
// frozen frame. 3. The user drags a rectangle. 4. The rectangle is cropped out of the frozen frame.
let snipping = false;

export async function takeAreaScreenshot(win: BrowserWindow): Promise<void> {
  if (snipping || win.isDestroyed()) return;
  snipping = true;
  let overlay: BrowserWindow | null = null;
  try {
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) {
      electronLog.warn('[KRH] Area screenshot: capturePage returned an empty image (nothing captured)');
      return;
    }
    const cb = win.getContentBounds();
    const imgSize = image.getSize();
    const scaleX = imgSize.width / cb.width;
    const scaleY = imgSize.height / cb.height;

    const pageFile = join(app.getPath('userData'), 'KRH Client', 'snip.html');
    mkdirSync(join(app.getPath('userData'), 'KRH Client'), { recursive: true });
    writeFileSync(pageFile, '<!doctype html><meta charset="utf-8"><title>KRH Screenshot</title>');

    overlay = new BrowserWindow({
      parent: win,
      x: cb.x, y: cb.y, width: cb.width, height: cb.height,
      frame: false, show: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, hasShadow: false, backgroundColor: '#000000',
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'snip.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    const ov = overlay;

    const rect = await new Promise<{ x: number; y: number; w: number; h: number } | null>((resolve) => {
      let done = false;
      const finish = (r: { x: number; y: number; w: number; h: number } | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ipcMain.removeListener('krh-snip-done', onDone);
        ipcMain.removeListener('krh-snip-cancel', onCancel);
        resolve(r);
      };
      const mine = (e: Electron.IpcMainEvent): boolean => !ov.isDestroyed() && e.sender === ov.webContents;
      const onDone = (e: Electron.IpcMainEvent, r: { x: number; y: number; w: number; h: number }): void => { if (mine(e)) finish(r); };
      const onCancel = (e: Electron.IpcMainEvent): void => { if (mine(e)) finish(null); };
      const timer = setTimeout(() => finish(null), 120_000); // never leave the overlay stuck
      ipcMain.on('krh-snip-done', onDone);
      ipcMain.on('krh-snip-cancel', onCancel);
      ov.on('closed', () => finish(null));
      ov.once('ready-to-show', () => { ov.show(); ov.focus(); });
      ov.webContents.once('did-finish-load', () => {
        ov.webContents.send('krh-snip-init', {
          image: 'data:image/png;base64,' + image.toPNG().toString('base64'),
          scale: scaleX,
        });
      });
      void ov.loadFile(pageFile);
    });

    if (!ov.isDestroyed()) ov.destroy();
    overlay = null;
    if (!win.isDestroyed()) win.focus();
    if (!rect) return;

    const x = Math.max(0, Math.round(rect.x * scaleX));
    const y = Math.max(0, Math.round(rect.y * scaleY));
    const w = Math.min(imgSize.width - x, Math.round(rect.w * scaleX));
    const h = Math.min(imgSize.height - y, Math.round(rect.h * scaleY));
    if (w < 1 || h < 1) return;
    const cropped: Electron.NativeImage = image.crop({ x, y, width: w, height: h });
    await deliver(win, cropped.isEmpty() ? nativeImage.createEmpty() : cropped, 'Area screenshot');
  } catch (err) {
    electronLog.error('[KRH] Area screenshot failed:', err);
    if (!win.isDestroyed()) win.webContents.send('krh-toast', 'Screenshot failed');
  } finally {
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    snipping = false;
  }
}

export async function openScreenshotsFolder(): Promise<string> {
  const dir = screenshotDir();
  await fsp.mkdir(dir, { recursive: true });
  return shell.openPath(dir);
}
