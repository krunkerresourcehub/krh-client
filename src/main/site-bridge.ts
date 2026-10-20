// ── Website -> client bridge ──
// The KRH website (hub window) can ask the client to USE a post that is just a file the client already knows how
// to handle: a CSS file (added to Custom CSS and switched on) or a legal userscript (added to your userscripts and
// switched on). It only works inside KRH Client, because the page reaches this code through the hub window's own
// preload (hub-bridge.ts). Things that need Krunker's own files or paths (crosshairs, scopes, maps, mods, settings)
// are not part of this.
//
// Trust model: the page is a website that shows community posts, so everything it sends is treated as untrusted.
//  - only the hub window's main frame, on the hub host, may call (checked on every call);
//  - the action must be on the list below, the payload is validated again here;
//  - files are only downloaded from the KRH storage bucket or the KRH site itself (never from a link the page
//    makes up), with size limits, no redirects, and are written under fixed names that cannot leave the folder;
//  - nothing is run: scripts are only put in the userscripts folder (and only when the post is a legal script).

import { BrowserWindow, ipcMain } from 'electron';
import type { UserCssManager } from './user-css';
import { electronLog } from './logger';

/** Where the website keeps uploaded files (Supabase Storage, public bucket URLs) and the site itself. */
const ASSET_PREFIXES = [
  'https://rcqkqcipqqicojieudsv.supabase.co/storage/v1/object/public/',
  'https://krunker-resources-hub.pages.dev/',
];
const HUB_HOST = 'krunker-resources-hub.pages.dev';
const MAX_TEXT = 2 * 1024 * 1024;

/** Post categories that may be switched on from the website. Cheat scripts ("scripts-userscript-hack") are NOT here. */
const SCRIPT_CATEGORIES = new Set(['scripts-userscript-legal']);

export const BRIDGE_ACTIONS = ['info', 'use-css', 'use-script'] as const;
type BridgeAction = typeof BRIDGE_ACTIONS[number];

export interface BridgeResult { ok: boolean; message?: string; error?: string; [k: string]: unknown }

export interface BridgeDeps {
  version: string;
  hub: () => BrowserWindow | null;
  userCss: UserCssManager;
  applyUserCss: () => void;
  /** Put a userscript in the scripts folder and switch it on (turns Userscripts on if they were off). */
  installScript: (title: string, code: string) => Promise<{ ok: boolean; message?: string; error?: string }>;
}

function assetAllowed(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 1500) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  return ASSET_PREFIXES.some((p) => u.href.startsWith(p)) ? u : null;
}

async function fetchBytes(url: URL, maxBytes: number): Promise<Buffer> {
  const res = await fetch(url.href, { redirect: 'error', headers: { 'User-Agent': 'KRH-Client-Bridge' } });
  if (!res.ok || !res.body) throw new Error('The download failed (HTTP ' + res.status + ')');
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxBytes) throw new Error('That file is too big');
  const chunks: Buffer[] = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (got > maxBytes) throw new Error('That file is too big');
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** A title from the page, made safe as part of a file name. */
function cleanTitle(raw: unknown, fallback: string): string {
  const s = typeof raw === 'string' ? raw : '';
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 50);
  return t || fallback;
}

function asText(buf: Buffer): string {
  // A text file only: no NUL bytes
  if (buf.includes(0)) throw new Error('That file is not a text file');
  return buf.toString('utf-8');
}

export function registerSiteBridge(deps: BridgeDeps): void {
  const mine = (e: Electron.IpcMainInvokeEvent): boolean => {
    const hub = deps.hub();
    if (!hub || hub.isDestroyed() || e.sender !== hub.webContents) return false;
    const frame = e.senderFrame;
    if (!frame || frame !== e.sender.mainFrame) return false;
    try { return new URL(frame.url).hostname === HUB_HOST; } catch { return false; }
  };

  ipcMain.handle('bridge:call', async (e, action: unknown, payload: unknown): Promise<BridgeResult> => {
    if (!mine(e)) return { ok: false, error: 'Not allowed' };
    if (typeof action !== 'string' || !(BRIDGE_ACTIONS as readonly string[]).includes(action)) return { ok: false, error: 'Unknown action' };
    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    try {
      return await run(action as BridgeAction, p);
    } catch (err) {
      electronLog.warn(`[KRH-Bridge] ${action} failed:`, (err as Error).message);
      return { ok: false, error: (err as Error).message || 'Something went wrong' };
    }
  });

  async function run(action: BridgeAction, p: Record<string, unknown>): Promise<BridgeResult> {
    if (action === 'info') return { ok: true, version: deps.version, actions: [...BRIDGE_ACTIONS] };

    const url = assetAllowed(p.url);
    if (!url) return { ok: false, error: 'That file does not come from the KRH website' };
    const title = cleanTitle(p.title, 'KRH post');

    switch (action) {
      case 'use-css': {
        const css = asText(await fetchBytes(url, MAX_TEXT));
        const r = deps.userCss.create(`KRH - ${title}`, css);
        if ('error' in r) return { ok: false, error: r.error };
        deps.applyUserCss();
        return { ok: true, message: `"${title}" is switched on. Manage it in Dashboard > Custom CSS.` };
      }
      case 'use-script': {
        if (typeof p.category !== 'string' || !SCRIPT_CATEGORIES.has(p.category)) return { ok: false, error: 'Only legal userscripts can be switched on from the website' };
        return deps.installScript(title, asText(await fetchBytes(url, MAX_TEXT)));
      }
      default: return { ok: false, error: 'Unknown action' };
    }
  }
}
