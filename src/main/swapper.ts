import { existsSync, mkdirSync, readFileSync, writeFileSync, promises as fsp } from 'fs';
import { join, resolve, sep } from 'path';
import { pathToFileURL } from 'url';
import { protocol, net, Session } from 'electron';
import { electronLog } from './logger';
import { PACKS_DIR, PACK_ID_RE } from './packs';

const PROTOCOL_NAME = 'krh-swap';
const TARGET_DOMAIN = 'krunker.io';

// External swapper (idea from the PC7 Client, https://github.com/PC7-Client/PC7-Client; written from scratch):
// externalResourceSwapper.json maps a Krunker resource path to a web address instead of a local file,
//   { "/textures/foo.png": "https://example.com/my-foo.png" }
// Keys are resource paths (the same layout as a local swap folder; a leading /assets is ignored).
// Values must be https links. Keys that do not start with "/" (like "_readme") are ignored.
export const EXTERNAL_SWAP_FILE = 'externalResourceSwapper.json';
const EXTERNAL_MAX_ENTRIES = 5000;
export const EXTERNAL_EXAMPLE = {
  _readme: 'Map a Krunker resource path to an https link. Example below (remove the leading underscore to use it).',
  '_/textures/example.png': 'https://example.com/my-texture.png',
};

/**
 * Convert a native file path to a proper krh-swap:// URL.
 * Windows paths like C:\foo\bar become krh-swap://C/foo/bar
 */
export function filePathToSwapURL(filePath: string): string {
  const forwardSlash = filePath.replace(/\\/g, '/');
  // Per segment, so #, ?, and % in a file name survive the handler's decodeURIComponent
  const encode = (p: string): string => p.split('/').map(encodeURIComponent).join('/');
  // Windows drive letter: C:/foo → krh-swap://C/foo
  const match = forwardSlash.match(/^([A-Za-z]):\/(.*)/);
  if (match) {
    return `${PROTOCOL_NAME}://${match[1]}/${encode(match[2])}`;
  }
  // Unix absolute: /home/user/foo → krh-swap:///home/user/foo
  return `${PROTOCOL_NAME}://${encode(forwardSlash)}`;
}

/**
 * Register the custom protocol scheme. Must be called BEFORE app.ready.
 */
export function initSwapperProtocol(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: PROTOCOL_NAME,
    privileges: { standard: true, secure: true, corsEnabled: true, bypassCSP: true },
  }]);
}

/** Must be called AFTER app.ready. */
export function registerSwapperFileProtocol(ses: Session, swapDir: string): void {
  // Windows paths are case-insensitive, and a drive letter can reach us in either case
  const norm = (p: string): string => process.platform === 'win32' ? p.toLowerCase() : p;
  const root = norm(resolve(swapDir));
  ses.protocol.handle(PROTOCOL_NAME, async (request) => {
    const url = new URL(request.url);
    // Windows drive letter rides as the hostname: krh-swap://C/foo → C:/foo
    const raw = url.hostname ? `${url.hostname}:${url.pathname}` : url.pathname;
    let filePath: string;
    try {
      filePath = resolve(decodeURIComponent(raw));
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    // The ACAO below makes these readable cross-origin, so anything outside the
    // swap dir would be an arbitrary local-file read for any script on the page.
    if (norm(filePath) !== root && !norm(filePath).startsWith(root + sep)) {
      electronLog.warn(`[KRH] Blocked swap request outside swap dir: ${filePath}`);
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const res = await net.fetch(pathToFileURL(filePath).href);
      // WebGL texture uploads need a CORS-clean image; file:// carries no ACAO
      const headers = new Headers(res.headers);
      headers.set('access-control-allow-origin', '*');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    } catch (err) {
      electronLog.warn(`[KRH] Swap file fetch failed for ${filePath}:`, err);
      return new Response('Not found', { status: 404 });
    }
  });
}

/**
 * Scans a local directory and intercepts matching Krunker asset requests,
 * redirecting them to local replacement files via a custom protocol.
 */
export class ResourceSwapper {
  private swapDir: string;
  private swapFiles = new Map<string, string>();
  private externalMap = new Map<string, string>();
  private ready = false;
  private scanPromise: Promise<void>;
  /** Switched-on resource packs, lowest priority first (a later pack wins over an earlier one). */
  private enabledPacks: string[] = [];
  /** false = only packs are swapped; the user's own swapper folder is ignored (swapper switched off in settings). */
  private userFiles: boolean;

  constructor(swapDir: string, opts: { userFiles?: boolean; packs?: string[] } = {}) {
    this.swapDir = swapDir;
    this.userFiles = opts.userFiles !== false;
    this.enabledPacks = (opts.packs || []).filter((id) => PACK_ID_RE.test(id));
    if (!existsSync(this.swapDir)) mkdirSync(this.swapDir, { recursive: true });
    this.loadExternal();
    this.scanPromise = this.scanAll();
  }

  /** Pick which packs are switched on; call rescan() afterwards. */
  setEnabledPacks(ids: string[]): void {
    this.enabledPacks = ids.filter((id) => PACK_ID_RE.test(id));
  }

  /** Packs first (in order), then the user's own files, so the user's files always win. */
  private async scanAll(): Promise<void> {
    for (const id of this.enabledPacks) {
      await this.scanAsync('', join(this.swapDir, PACKS_DIR, id, 'files'));
    }
    if (this.userFiles) await this.scanAsync('', this.swapDir, true);
  }

  /** (Re)read externalResourceSwapper.json from the swap folder (created with an example when missing). */
  loadExternal(): void {
    this.externalMap.clear();
    const file = join(this.swapDir, EXTERNAL_SWAP_FILE);
    try {
      if (!existsSync(file)) { writeFileSync(file, JSON.stringify(EXTERNAL_EXAMPLE, null, 2), 'utf-8'); return; }
      const json = JSON.parse(readFileSync(file, 'utf-8'));
      if (!json || typeof json !== 'object' || Array.isArray(json)) return;
      for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
        if (this.externalMap.size >= EXTERNAL_MAX_ENTRIES) break;
        if (typeof value !== 'string' || !key.startsWith('/')) continue;
        let target: URL;
        try { target = new URL(value); } catch { continue; }
        if (target.protocol !== 'https:') continue;
        this.externalMap.set(key.startsWith('/assets/') ? key.substring(7) : key, target.href);
      }
      electronLog.log(`[KRH] External swapper: ${this.externalMap.size} entr${this.externalMap.size === 1 ? 'y' : 'ies'}`);
    } catch (err) {
      electronLog.warn('[KRH] Could not read ' + EXTERNAL_SWAP_FILE + ':', (err as Error).message);
    }
  }

  /** Wait for the async directory scan to complete */
  async waitForReady(): Promise<void> {
    await this.scanPromise;
    this.ready = true;
  }

  /** Rescan the swap directory to pick up added/removed/changed files */
  async rescan(): Promise<void> {
    this.swapFiles.clear();
    this.loadExternal();
    await this.scanAll();
    this.ready = true;
  }

  /** URL filter patterns for webRequest.onBeforeRequest — single broad pattern */
  get patterns(): string[] {
    return this.swapFiles.size > 0 || this.externalMap.size > 0 ? [`*://*.${TARGET_DOMAIN}/*`] : [];
  }

  /**
   * Returns a redirect URL if the request should be swapped, null otherwise.
   * Strips /assets/ prefix so both `assets.krunker.io/assets/textures/foo.png`
   * and `assets.krunker.io/textures/foo.png` resolve to the same local file.
   */
  getRedirect(url: string): string | null {
    if (!this.ready) return null;
    try {
      // Extract pathname from URL using string ops (faster than new URL())
      // URLs are like: https://assets.krunker.io/path/file.ext?v=hash
      const protoEnd = url.indexOf('//');
      if (protoEnd === -1) return null;
      const pathStart = url.indexOf('/', protoEnd + 2);
      if (pathStart === -1) return null;
      const queryStart = url.indexOf('?', pathStart);
      let pathname = queryStart === -1 ? url.substring(pathStart) : url.substring(pathStart, queryStart);
      if (pathname.startsWith('/assets/')) pathname = pathname.substring(7);
      const localPath = this.swapFiles.get(pathname);
      if (localPath) return filePathToSwapURL(localPath);
      const external = this.externalMap.get(pathname);
      if (external) return external;
    } catch { /* malformed URL — ignore */ }
    return null;
  }

  /** Recursively scan a folder and add its files to the map (async). Keys are paths relative to that folder. */
  private async scanAsync(prefix: string, base: string, isUserRoot = false): Promise<void> {
    try {
      const entries = await fsp.readdir(join(base, prefix), { withFileTypes: true });
      for (const dirent of entries) {
        const name = `${prefix}/${dirent.name}`;
        if (dirent.isDirectory()) {
          // The packs folder holds the installed packs; they only count while switched on (scanAll)
          if (isUserRoot && prefix === '' && dirent.name === PACKS_DIR) continue;
          await this.scanAsync(name, base, isUserRoot);
        } else {
          this.swapFiles.set(name, join(base, name));
        }
      }
    } catch (err) {
      electronLog.error(`[KRH] Failed to scan swap directory prefix: ${prefix}`, err);
    }
  }
}
