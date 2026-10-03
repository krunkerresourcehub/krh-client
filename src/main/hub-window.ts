import { BrowserWindow, app, session } from 'electron';
import { electronLog } from './logger';
import { devWindowIcon } from './platform';

/**
 * KRH Hub window — the first screen of KRH Client.
 *
 * It loads the Krunker Resource Hub website. The hub's nav links (Play, Hub, Games, Editor,
 * Docs, Viewer, Guides) point at krunker.io; instead of navigating inside the hub, the client
 * intercepts them:
 *   - https://krunker.io/            -> Play: opens the modded Krunker game window
 *   - any other krunker.io page      -> opens in a new window (editor, games, viewer, docs, guides, hub)
 *   - other websites                 -> default browser
 *   - krunker-resources-hub.pages.dev -> stays inside the hub window
 */

export const HUB_URL = 'https://krunker-resources-hub.pages.dev/';
const HUB_HOSTNAME = 'krunker-resources-hub.pages.dev';

export type HubRoute = 'hub' | 'play' | 'window' | 'external' | 'blocked';

export function routeHubUrl(raw: string): HubRoute {
  let u: URL;
  try { u = new URL(raw); } catch { return 'blocked'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'blocked';
  if (u.hostname === HUB_HOSTNAME || u.hostname.endsWith('.' + HUB_HOSTNAME)) return 'hub';
  if (u.hostname === 'krunker.io' || u.hostname.endsWith('.krunker.io')) {
    const isGameRoot = u.hostname === 'krunker.io' && (u.pathname === '/' || u.pathname === '');
    return isGameRoot ? 'play' : 'window';
  }
  return 'external';
}

export interface HubWindowOptions {
  version: string;
  /** Play pressed: open (or focus) the Krunker game window. */
  onPlay: (url: string) => void;
  /** Editor / Games / Viewer / Docs / Guides / Hub pressed: open in a new window. */
  onOpenWindow: (url: string) => void;
  /** Open a non-Krunker link in the system browser. */
  onExternal: (url: string) => void;
  isGameVisible: () => boolean;
  isQuitting: () => boolean;
}

function offlineHTML(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>KRH Client</title><style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;
  background:#120c28;color:#e8e6f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center}
  h1{font-size:22px;margin:0}p{margin:0;color:#a9a4c7;font-size:14px}
  a{display:inline-block;margin:6px 4px;padding:9px 18px;border-radius:8px;background:#2f6bff;color:#fff;text-decoration:none;font-size:14px}
  a.s{background:#2a2250}
  </style></head><body><h1>Can't reach Krunker Resource Hub</h1>
  <p>Check your internet connection and try again.</p>
  <div><a href="${HUB_URL}">Retry</a><a class="s" href="https://krunker.io">Play Krunker anyway</a></div></body></html>`;
}

export function createHubWindow(opts: HubWindowOptions): BrowserWindow {
  // Separate persistent session so hub logins/settings don't mix with the game session.
  const ses = session.fromPartition('persist:krh-hub');
  // Lets the hub website detect it's running inside KRH Client (e.g. navigator.userAgent includes "KRHClient/").
  ses.setUserAgent(`${ses.getUserAgent()} KRHClient/${opts.version}`);

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#120c28',
    title: 'KRH Client',
    icon: devWindowIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  const dispatch = (route: HubRoute, url: string): void => {
    switch (route) {
      case 'play': opts.onPlay(url); break;
      case 'window': opts.onOpenWindow(url); break;
      case 'external': opts.onExternal(url); break;
      default: break; // 'blocked' (non-http schemes) and 'hub' are handled by the callers
    }
  };

  // Clicking a normal link
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('data:')) return; // our own offline page
    const route = routeHubUrl(url);
    if (route === 'hub') return;
    event.preventDefault();
    dispatch(route, url);
  });

  // target="_blank" / window.open
  win.webContents.setWindowOpenHandler(({ url }) => {
    const route = routeHubUrl(url);
    if (route === 'hub') setImmediate(() => { if (!win.isDestroyed()) void win.loadURL(url); });
    else setImmediate(() => dispatch(route, url));
    return { action: 'deny' };
  });

  win.webContents.on('did-fail-load', (_e, errorCode, desc, url, isMainFrame) => {
    // -3 = ERR_ABORTED (superseded navigation) — not a real failure
    if (!isMainFrame || errorCode === -3 || url.startsWith('data:')) return;
    electronLog.warn(`[KRH] Hub failed to load (${errorCode} ${desc})`);
    void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(offlineHTML()));
  });

  // Small conveniences (the app has no menu bar)
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || (input.control && !input.shift && !input.alt && input.key.toLowerCase() === 'r')) {
      win.webContents.reload();
      event.preventDefault();
    } else if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // Closing the hub quits the app — unless the game is open, in which case the hub just hides
  // (it comes back when the game window is closed).
  win.on('close', (event) => {
    if (opts.isQuitting()) return;
    if (opts.isGameVisible()) {
      event.preventDefault();
      win.hide();
      return;
    }
    app.quit();
  });

  void win.loadURL(HUB_URL);
  return win;
}

export function showWindow(win: BrowserWindow | null | undefined): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
