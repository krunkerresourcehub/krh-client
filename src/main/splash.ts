import { BrowserWindow } from 'electron';
import { devWindowIcon } from './platform';
import { SPLASH_POSTER } from './splash-image';
import { escapeHtml, renderMarkdown } from '../shared/markdown';

// Branded startup splash: the KRH poster art shown while the update check and the initial game load run.
// Status sits in a glass pill at the top and progress runs along the bottom edge, so the poster logo stays
// clear. It doubles as the update UI: the update prompt (version change, release notes, accept/skip
// buttons) opens as a glass card over the dimmed poster in the same window. One window covers the whole launch, so there is never a zero-window moment where the
// window-all-closed handler would quit the app mid-startup.

const SPLASH_WIDTH = 800;
const SPLASH_HEIGHT = 440;

function buildSplashHTML(version: string): string {
  // Buttons and the close control signal via console.log — captured by
  // webContents 'console-message' in main. Works on data: URLs without a preload.
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root { --blue: #2f8cff; --cyan: #38c8ff; --ink: #eaf2ff; --muted: rgba(200,218,248,0.7); }
  body {
    font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
    width: 100vw; height: 100vh; overflow: hidden;
    background: #060912; color: var(--ink);
    user-select: none; cursor: default;
    -webkit-app-region: drag;
  }
  #poster {
    position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; pointer-events: none;
    transition: filter 0.3s ease, transform 0.3s ease;
  }
  /* top and bottom shading so the pill and progress line stay readable over the art */
  #shade {
    position: absolute; inset: 0; pointer-events: none;
    background:
      linear-gradient(180deg, rgba(4,8,20,0.65) 0%, rgba(4,8,20,0) 24%),
      linear-gradient(0deg, rgba(4,8,20,0.5) 0%, rgba(4,8,20,0) 14%);
    transition: background 0.3s ease;
  }
  #frame { position: absolute; inset: 0; pointer-events: none; border: 1px solid rgba(90,150,255,0.28); }

  #topbar {
    position: absolute; top: 12px; left: 14px; right: 14px; z-index: 2;
    display: flex; align-items: center; justify-content: space-between;
  }
  .chip {
    font-size: 11px; font-weight: 600; letter-spacing: 0.05em;
    padding: 5px 11px; border-radius: 999px;
    background: rgba(8,14,32,0.55); border: 1px solid rgba(120,170,255,0.28);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    color: var(--ink);
  }
  #status {
    position: absolute; left: 50%; transform: translateX(-50%);
    max-width: 60%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    font-weight: 500; letter-spacing: 0; font-size: 12.5px; padding: 6px 16px;
  }
  #close {
    -webkit-app-region: no-drag; cursor: pointer;
    width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
    border-radius: 999px; font-size: 12px; color: var(--muted);
    background: rgba(8,14,32,0.55); border: 1px solid rgba(120,170,255,0.28);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    transition: color 0.15s, background 0.15s;
  }
  #close:hover { color: #fff; background: rgba(8,14,32,0.8); }

  /* a different tip each launch, changing every few seconds */
  #tip {
    position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 2;
    max-width: 82%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    font-size: 12px; font-weight: 500; padding: 6px 16px;
    transition: opacity 0.35s ease;
  }
  #tip.fade { opacity: 0; }

  /* progress line along the bottom edge */
  .progress-container {
    position: absolute; left: 0; right: 0; bottom: 0; height: 4px; z-index: 2;
    background: rgba(8,14,32,0.55); overflow: hidden;
    opacity: 0; transition: opacity 0.25s;
  }
  .progress-container.active { opacity: 1; }
  .progress-bar {
    height: 100%; width: 0%;
    background: linear-gradient(90deg, var(--blue), var(--cyan));
    box-shadow: 0 0 12px rgba(56,200,255,0.8);
    transition: width 0.3s ease;
  }
  /* Indeterminate sweep for steps with no measurable progress (check, verify, install). */
  .progress-container.indeterminate .progress-bar {
    width: 40%; transition: none;
    animation: krh-indet 1.15s ease-in-out infinite;
  }

  /* Update prompt card */
  #card {
    position: absolute; z-index: 3; left: 50%; top: 50%;
    width: 470px; max-width: calc(100% - 48px);
    transform: translate(-50%, -48%) scale(0.98);
    opacity: 0; pointer-events: none;
    padding: 20px 22px 16px; text-align: center;
    background: rgba(8,14,32,0.78);
    border: 1px solid rgba(120,170,255,0.3); border-radius: 14px;
    box-shadow: 0 18px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(47,140,255,0.08) inset;
    -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
    transition: opacity 0.25s ease, transform 0.25s ease;
  }
  #title { font-size: 13px; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; }
  #flow { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 10px; font-size: 13px; font-weight: 600; }
  #flow .from { color: var(--muted); }
  #flow .arrow { color: var(--cyan); }
  #flow .to {
    color: #fff; padding: 2px 10px; border-radius: 999px;
    background: rgba(47,140,255,0.22); border: 1px solid rgba(56,200,255,0.45);
  }
  #cardMsg { margin-top: 8px; font-size: 12.5px; color: var(--muted); }
  #notes {
    display: none; -webkit-app-region: no-drag;
    text-align: left; max-height: 120px; overflow-y: auto; margin-top: 12px;
    background: rgba(4,10,26,0.6);
    border: 1px solid rgba(90,150,255,0.2); border-radius: 10px;
    padding: 10px 13px;
    font-size: 12px; line-height: 1.55; color: rgba(214,226,250,0.88);
  }
  #notes h1, #notes h2, #notes h3 { font-size: 12.5px; font-weight: 600; color: #fff; margin: 9px 0 4px; }
  #notes h1:first-child, #notes h2:first-child, #notes h3:first-child { margin-top: 0; }
  #notes ul { padding-left: 16px; margin: 4px 0; }
  #notes li { margin: 3px 0; }
  #notes li::marker { color: var(--cyan); }
  #notes strong { color: #fff; }
  #notes::-webkit-scrollbar { width: 8px; }
  #notes::-webkit-scrollbar-track { background: transparent; }
  #notes::-webkit-scrollbar-thumb { background: rgba(120,160,230,0.28); border-radius: 4px; }
  #notes::-webkit-scrollbar-thumb:hover { background: rgba(120,160,230,0.45); }
  #buttons { display: flex; justify-content: center; gap: 10px; margin-top: 14px; -webkit-app-region: no-drag; }
  button {
    min-width: 112px; padding: 9px 20px;
    border: 1px solid transparent; border-radius: 8px;
    color: #fff; font-size: 12.5px; font-weight: 600;
    cursor: pointer; font-family: inherit; white-space: nowrap;
    transition: filter 0.15s, background 0.15s;
  }
  button.primary { background: linear-gradient(90deg, #1f6fe0, var(--cyan)); box-shadow: 0 4px 18px rgba(47,140,255,0.35); }
  button.primary:hover { filter: brightness(1.12); }
  button.secondary { background: rgba(120,160,230,0.14); border-color: rgba(120,160,230,0.3); }
  button.secondary:hover { background: rgba(120,160,230,0.24); }
  #skipRow {
    display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 11px;
    -webkit-app-region: no-drag; font-size: 11px; color: var(--muted); cursor: pointer;
  }
  #skipRow input { cursor: pointer; accent-color: var(--blue); margin: 0; }

  /* prompting: dim + blur the poster, hide the pill, open the card */
  body.prompting #poster { filter: blur(5px) brightness(0.5); transform: scale(1.03); }
  body.prompting #shade { background: rgba(4,8,20,0.25); }
  body.prompting #status, body.prompting #tip { display: none; }
  body.prompting #card { opacity: 1; transform: translate(-50%, -50%) scale(1); pointer-events: auto; }

  @keyframes krh-indet {
    0%   { transform: translateX(-110%); }
    100% { transform: translateX(260%); }
  }
</style></head>
<body>
  <img id="poster" src="${SPLASH_POSTER}" alt="">
  <div id="shade"></div>
  <div id="frame"></div>
  <div id="topbar">
    <div class="chip" id="version">v${version}</div>
    <div class="chip" id="status">Starting...</div>
    <div id="close" title="Close">&#10005;</div>
  </div>
  <div class="chip" id="tip"></div>
  <div class="progress-container" id="progress">
    <div class="progress-bar" id="progressBar"></div>
  </div>
  <div id="card">
    <div id="title">Update available</div>
    <div id="flow"><span class="from" id="flowFrom"></span><span class="arrow">&#8594;</span><span class="to" id="flowTo"></span></div>
    <div id="cardMsg"></div>
    <div id="notes"></div>
    <div id="buttons">
      <button class="secondary" id="btnSecondary"></button>
      <button class="primary" id="btnPrimary"></button>
    </div>
    <label id="skipRow"><input type="checkbox" id="skipChk"><span>Don't ask again for this version</span></label>
  </div>
  <script>
    // Tips (keys are the defaults; they can be changed in Settings)
    const TIPS = [
      'Press F2 for Quick Play: pick regions, modes and maps in one screen',
      'Ctrl+Alt+L opens the layout editor: drag your overlays where you want them',
      'Turn on Instant Replay in Settings > Extras, then press Ctrl+Alt+R to save the last seconds',
      'Ctrl+Alt+M switches Streamer Mode on and off',
      'Ctrl+Alt+K shows your session stats: kills, deaths and play time',
      'Resource Packs in Settings > Extras: install a zip and switch it on or off any time',
      'Ctrl+H brings the KRH Hub back over the game without closing it',
      'F1 opens the chat logs, F3 cycles the chat filters',
      'Save your Krunker settings as a profile and share it with a short code',
      'Ctrl+Alt+T shows or hides the Twitch chat overlay',
      'Background updates in Settings > Extras download new versions while you play',
      'If the client keeps crashing, Safe Mode starts it without scripts and extras'
    ];
    (function () {
      const el = document.getElementById('tip');
      if (!el) return;
      let i = Math.floor(Math.random() * TIPS.length);
      const show = () => { el.textContent = 'Tip: ' + TIPS[i % TIPS.length]; };
      show();
      setInterval(() => {
        el.classList.add('fade');
        setTimeout(() => { i++; show(); el.classList.remove('fade'); }, 350);
      }, 5000);
    })();
    document.getElementById('close').addEventListener('click', () => console.log('KRH_SPLASH:close'));
    document.getElementById('btnPrimary').addEventListener('click', () => console.log('KRH_SPLASH:primary'));
    document.getElementById('btnSecondary').addEventListener('click', () =>
      console.log('KRH_SPLASH:secondary' + (document.getElementById('skipChk').checked ? ':skip' : '')));
  </script>
</body></html>`;
}

/**
 * Pull the logged string out of a 'console-message' event, tolerating both the old
 * (event, level, message, ...) and new (single event-object) Electron signatures.
 */
function extractConsoleMessage(args: unknown[]): string {
  for (const arg of args) {
    if (typeof arg === 'string') return arg;
    if (arg && typeof arg === 'object' && 'message' in arg && typeof (arg as { message: unknown }).message === 'string') {
      return (arg as { message: string }).message;
    }
  }
  return '';
}

// Single-use per process: the splash is created once at startup and this module
// state is not reset by a second createSplash().
let splash: BrowserWindow | null = null;
let splashCreatedAt = 0;
let closedByApp = false;
type PromptChoice = 'primary' | 'secondary' | 'secondary-skip' | 'closed';
let pendingPrompt: ((choice: PromptChoice) => void) | null = null;
const userClosedCallbacks: Array<() => void> = [];

function resolvePrompt(choice: PromptChoice): void {
  const resolve = pendingPrompt;
  pendingPrompt = null;
  if (resolve) resolve(choice);
}

export function createSplash(version: string): void {
  splashCreatedAt = Date.now();
  splash = new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: '#060912',
    title: 'KRH Client',
    icon: devWindowIcon(),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  splash.removeMenu();
  // Display-only surface: never navigate away (e.g. a file dragged onto the
  // window) or open child windows.
  splash.webContents.on('will-navigate', (e) => e.preventDefault());
  splash.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  splash.once('ready-to-show', () => {
    if (splash && !splash.isDestroyed()) splash.show();
  });

  splash.webContents.on('console-message', (...args: unknown[]) => {
    const message = extractConsoleMessage(args);
    if (message === 'KRH_SPLASH:close') {
      // User close — the 'closed' handler below fires the callbacks. With no
      // other window open, window-all-closed then quits the app.
      if (splash && !splash.isDestroyed()) splash.close();
    } else if (message === 'KRH_SPLASH:primary') {
      resolvePrompt('primary');
    } else if (message === 'KRH_SPLASH:secondary') {
      resolvePrompt('secondary');
    } else if (message === 'KRH_SPLASH:secondary:skip') {
      resolvePrompt('secondary-skip');
    }
  });

  splash.on('closed', () => {
    splash = null;
    resolvePrompt('closed');
    if (!closedByApp) {
      for (const cb of userClosedCallbacks) cb();
    }
  });

  splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildSplashHTML(version)));
}

export function splashAlive(): boolean {
  return splash !== null && !splash.isDestroyed();
}

/** Milliseconds since the splash was created (Infinity if it never was). */
export function splashElapsed(): number {
  return splashCreatedAt ? Date.now() - splashCreatedAt : Infinity;
}

export function getSplash(): BrowserWindow | null {
  return splashAlive() ? splash : null;
}

/** Runs cb when the splash is closed by the user (not via closeSplash). */
export function onSplashUserClosed(cb: () => void): void {
  userClosedCallbacks.push(cb);
}

/**
 * Update the status line and progress bar. percent >= 0 → determinate width;
 * percent < 0 → indeterminate sweep; omitted → progress bar hidden.
 * Also hides the prompt buttons, so a status update always exits prompt state.
 */
export function splashStatus(message: string, percent?: number): void {
  if (!splashAlive()) return;
  const pct = typeof percent === 'number' ? percent : NaN;
  splash!.webContents.executeJavaScript(`(() => {
    const s = document.getElementById('status');
    const c = document.getElementById('progress');
    const p = document.getElementById('progressBar');
    const n = document.getElementById('notes');
    document.body.classList.remove('prompting');
    if (s) s.textContent = ${JSON.stringify(message)};
    if (n) n.style.display = 'none';
    if (c && p) {
      const pct = ${pct};
      if (Number.isNaN(pct)) { c.classList.remove('active', 'indeterminate'); }
      else if (pct >= 0) { c.classList.add('active'); c.classList.remove('indeterminate'); p.style.width = pct + '%'; }
      else { c.classList.add('active', 'indeterminate'); }
    }
  })()`).catch(() => {});
}

/**
 * Show an update prompt in the splash overlay. 'install' offers Skip / Update Now;
 * 'notice' (builds that can't self-install) offers Later / Download. Non-empty
 * notes (release markdown) render in a card above the buttons. Resolves
 * 'primary' (update/download), 'secondary' (skip/later), 'secondary-skip' (skip
 * with "don't ask again for this version" ticked), or 'closed' if the user
 * closed the splash — the caller should treat 'closed' as the app quitting.
 */
export function splashPrompt(kind: 'install' | 'notice', newVersion: string, currentVersion: string, notes = ''): Promise<PromptChoice> {
  if (!splashAlive()) return Promise.resolve('closed');

  const message = kind === 'install'
    ? 'A new version is ready to install.'
    : "This build can't update itself. Download opens the releases page.";
  const primaryLabel = kind === 'install' ? 'Update Now' : 'Download';
  const secondaryLabel = kind === 'install' ? 'Skip' : 'Later';
  // Links render as plain text — the splash blocks all navigation.
  const notesHtml = notes.trim()
    ? `<h2>What's new in v${escapeHtml(newVersion)}</h2>` + renderMarkdown(notes, { links: false })
    : '';

  splash!.webContents.executeJavaScript(`(() => {
    const m = document.getElementById('cardMsg');
    const c = document.getElementById('progress');
    const kc = document.getElementById('skipChk');
    document.body.classList.add('prompting');
    const ff = document.getElementById('flowFrom');
    const ft = document.getElementById('flowTo');
    if (ff) ff.textContent = ${JSON.stringify('v' + currentVersion)};
    if (ft) ft.textContent = ${JSON.stringify('v' + newVersion)};
    if (m) m.textContent = ${JSON.stringify(message)};
    if (c) c.classList.remove('active', 'indeterminate');
    if (kc) kc.checked = false;
    const n = document.getElementById('notes');
    if (n) { n.innerHTML = ${JSON.stringify(notesHtml)}; n.style.display = ${JSON.stringify(notesHtml ? 'block' : 'none')}; }
    const bp = document.getElementById('btnPrimary');
    const bs = document.getElementById('btnSecondary');
    if (bp) bp.textContent = ${JSON.stringify(primaryLabel)};
    if (bs) bs.textContent = ${JSON.stringify(secondaryLabel)};
  })()`).catch(() => {});

  return new Promise((resolve) => {
    pendingPrompt = resolve;
  });
}

/** Close the splash from app code (e.g. once the main window is shown). */
export function closeSplash(): void {
  if (!splashAlive()) return;
  closedByApp = true;
  splash!.close();
}
