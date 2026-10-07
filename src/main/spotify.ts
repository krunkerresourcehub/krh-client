import { createHash, randomBytes } from 'crypto';
import { createServer, Server } from 'http';
import { net, safeStorage, shell } from 'electron';
import { electronLog } from './logger';
import { config } from './config';
import { SystemMedia } from './system-media';

/**
 * Spotify now-playing + controls, through the official Spotify Web API (Authorization Code with PKCE).
 * There is no client secret anywhere: the user registers their own (free) Spotify developer app, pastes
 * its Client ID in the settings, and signs in once in their browser. Tokens are kept in the main process
 * only (encrypted with the OS keychain when available) and never reach the game page.
 *
 * Redirect URI that must be registered in the Spotify app: http://127.0.0.1:53682/callback
 */

export const SPOTIFY_REDIRECT_PORT = 53682;
export const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${SPOTIFY_REDIRECT_PORT}/callback`;
const SCOPES = 'user-read-playback-state user-modify-playback-state';
const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;
const POLL_PLAYING_MS = 3000;
const POLL_IDLE_MS = 6000;
const MAX_ART_BYTES = 2 * 1024 * 1024;
const API_RETRY_MS = 5 * 60 * 1000; // after the API refused us, try it again this often

export interface SpotifyConfig {
  enabled: boolean;
  clientId: string;
  showArt: boolean;
  showProgress: boolean;
  hideWhenIdle: boolean;
  scale: number;
  x: number;
  y: number;
  background: number;
}

export interface SpotifyTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  artUrl: string;
  playing: boolean;
  progressMs: number;
  durationMs: number;
  at: number; // Date.now() when progressMs was read
}

export interface SpotifyState {
  connected: boolean;
  track: SpotifyTrack | null;
}

export type SpotifyAction = 'toggle' | 'next' | 'previous';

interface Tokens { access: string; refresh: string; expiresAt: number; clientId: string }

interface Hooks {
  onState: (s: SpotifyState) => void;
  onNotice: (text: string) => void;
}

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function isValidClientId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v.trim());
}

// ── Pure helpers (kept free of Electron so they can be tested on their own) ──

/** Turn a /me/player response body into our track shape. Returns null when nothing is loaded. */
export function parsePlayer(j: any, now: number): SpotifyTrack | null {
  const item = j && j.item;
  if (!item || typeof item.name !== 'string') return null;
  const isEpisode = item.type === 'episode';
  const artists = Array.isArray(item.artists) ? item.artists.map((a: any) => String(a?.name || '')).filter(Boolean) : [];
  const artist = isEpisode ? String(item.show?.publisher || item.show?.name || '') : artists.join(', ');
  const album = isEpisode ? String(item.show?.name || '') : String(item.album?.name || '');
  const images: any[] = (isEpisode ? item.images : item.album?.images) || [];
  // Images come biggest first; take the smallest one that is still at least 160px wide.
  let artUrl = '';
  for (const im of images) {
    if (typeof im?.url === 'string' && (Number(im.width) || 0) >= 160) artUrl = im.url;
  }
  if (!artUrl && images[0] && typeof images[0].url === 'string') artUrl = images[0].url;
  return {
    id: String(item.id || item.uri || item.name),
    title: item.name,
    artist,
    album,
    artUrl,
    playing: j.is_playing === true,
    progressMs: Math.max(0, Number(j.progress_ms) || 0),
    durationMs: Math.max(0, Number(item.duration_ms) || 0),
    at: now,
  };
}

export function isAllowedArtUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'scdn.co' || u.hostname.endsWith('.scdn.co'));
  } catch { return false; }
}

// ── Album art (fetched in main, handed over as data: URLs, like Twitch emotes) ──
const artCache = new Map<string, string>();
export async function fetchSpotifyArt(url: string): Promise<string | null> {
  if (!isAllowedArtUrl(url)) return null;
  const hit = artCache.get(url);
  if (hit) return hit;
  try {
    const r = await net.fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(jpeg|png|webp)$/.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_ART_BYTES) return null;
    const data = `data:${type};base64,${buf.toString('base64')}`;
    if (artCache.size >= 40) {
      const oldest = artCache.keys().next().value;
      if (oldest !== undefined) artCache.delete(oldest);
    }
    artCache.set(url, data);
    return data;
  } catch { return null; }
}

export class Spotify {
  private tokens: Tokens | null = null;
  private loaded = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private failures = 0;
  // Spotify's Web API is Premium-only for developer apps since Feb 2026. When it refuses us (or nobody
  // logged in) we read the now-playing info from the OS instead, which works for free accounts too.
  private media = new SystemMedia();
  private apiBlockedAt = 0;
  private lastMediaError = '';
  private mediaNoticeShown = false;
  private lastState: SpotifyState = { connected: false, track: null };
  private loginServer: Server | null = null;
  private loginTimer: ReturnType<typeof setTimeout> | null = null;
  private loginDone: ((r: { ok: boolean; error?: string }) => void) | null = null;

  constructor(private hooks: Hooks) {}

  // ── Token storage ──
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const raw = String(config.get('spotifyAuth') || '');
    if (!raw) return;
    try {
      let json: string;
      if (raw.startsWith('enc:')) json = safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64'));
      else if (raw.startsWith('plain:')) json = Buffer.from(raw.slice(6), 'base64').toString('utf8');
      else return;
      const t = JSON.parse(json);
      if (t && typeof t.access === 'string' && typeof t.refresh === 'string' && isValidClientId(t.clientId)) {
        this.tokens = { access: t.access, refresh: t.refresh, expiresAt: Number(t.expiresAt) || 0, clientId: t.clientId };
      }
    } catch (err) {
      electronLog.warn('[KRH-Spotify] could not read saved login:', (err as Error).message);
    }
  }

  private save(): void {
    if (!this.tokens) { config.set('spotifyAuth', ''); return; }
    const json = JSON.stringify(this.tokens);
    try {
      if (safeStorage.isEncryptionAvailable()) {
        config.set('spotifyAuth', 'enc:' + safeStorage.encryptString(json).toString('base64'));
        return;
      }
    } catch { /* fall through to plain */ }
    config.set('spotifyAuth', 'plain:' + Buffer.from(json, 'utf8').toString('base64'));
  }

  get connected(): boolean {
    this.load();
    return !!this.tokens;
  }

  /** True while the card is fed by the Web API (login + Premium owner) instead of the OS media session. */
  private get useApi(): boolean {
    return this.connected && (this.apiBlockedAt === 0 || Date.now() - this.apiBlockedAt > API_RETRY_MS);
  }

  getState(): SpotifyState {
    // The card is usable without any login as long as the OS can tell us what plays.
    return { connected: this.connected || SystemMedia.supported, track: this.lastState.track };
  }

  // ── Login (PKCE, loopback redirect) ──
  connect(clientIdRaw: string): Promise<{ ok: boolean; error?: string }> {
    const clientId = String(clientIdRaw || '').trim();
    if (!isValidClientId(clientId)) {
      return Promise.resolve({ ok: false, error: 'Enter your Spotify Client ID first (32 characters, see the README).' });
    }
    this.cancelLogin('Login restarted.');

    const verifier = b64url(randomBytes(64));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = randomBytes(16).toString('hex');

    return new Promise((resolve) => {
      const finish = (r: { ok: boolean; error?: string }): void => {
        if (this.loginTimer) { clearTimeout(this.loginTimer); this.loginTimer = null; }
        const srv = this.loginServer;
        this.loginServer = null;
        this.loginDone = null;
        if (srv) srv.close(); // stops listening now (so a retry can reuse the port); the reply in flight still completes
        resolve(r);
      };
      this.loginDone = finish;

      const page = (title: string, msg: string): string =>
        `<!doctype html><meta charset="utf-8"><title>KRH Client</title><body style="font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${title}</h2><p>${msg}</p></div>`;

      const server = createServer((req, res) => {
        const url = new URL(req.url || '/', SPOTIFY_REDIRECT_URI);
        if (url.pathname !== '/callback') { res.writeHead(404, { connection: 'close' }).end(); return; }
        const code = url.searchParams.get('code');
        const err = url.searchParams.get('error');
        const fail = (msg: string): void => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(page('Spotify not connected', msg));
          finish({ ok: false, error: msg });
        };
        if (url.searchParams.get('state') !== state) { fail('Login rejected (state mismatch). Try again from the settings.'); return; }
        if (err || !code) { fail(err === 'access_denied' ? 'You declined the Spotify login.' : 'Spotify returned an error: ' + (err || 'no code')); return; }
        void this.tokenRequest({
          grant_type: 'authorization_code', code, redirect_uri: SPOTIFY_REDIRECT_URI,
          client_id: clientId, code_verifier: verifier,
        }).then((t) => {
          this.tokens = { access: t.access_token, refresh: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000, clientId };
          this.loaded = true;
          this.save();
          if (this.polling) { this.apiBlockedAt = 0; this.failures = 0; void this.pollOnce(); }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(page('Spotify connected', 'You can close this tab and go back to the game.'));
          electronLog.log('[KRH-Spotify] Connected');
          finish({ ok: true });
          this.emit();
        }).catch((e: Error) => fail('Spotify login failed: ' + e.message));
      });

      server.on('error', (e: NodeJS.ErrnoException) => {
        finish({ ok: false, error: e.code === 'EADDRINUSE'
          ? `Port ${SPOTIFY_REDIRECT_PORT} is already in use. Close whatever uses it and try again.`
          : 'Could not start the login listener: ' + e.message });
      });
      server.listen(SPOTIFY_REDIRECT_PORT, '127.0.0.1', () => {
        this.loginServer = server;
        const auth = new URL(AUTH_URL);
        auth.searchParams.set('client_id', clientId);
        auth.searchParams.set('response_type', 'code');
        auth.searchParams.set('redirect_uri', SPOTIFY_REDIRECT_URI);
        auth.searchParams.set('scope', SCOPES);
        auth.searchParams.set('code_challenge_method', 'S256');
        auth.searchParams.set('code_challenge', challenge);
        auth.searchParams.set('state', state);
        void shell.openExternal(auth.toString());
        this.loginTimer = setTimeout(() => finish({ ok: false, error: 'Login timed out. Try again.' }), LOGIN_TIMEOUT_MS);
      });
    });
  }

  private cancelLogin(reason: string): void {
    if (this.loginDone) this.loginDone({ ok: false, error: reason });
  }

  disconnect(): void {
    this.cancelLogin('Cancelled.');
    this.stopPolling();
    this.tokens = null;
    this.loaded = true;
    this.save();
    this.lastState = { connected: false, track: null };
    this.emit();
  }

  /** Called on app quit / game window close. */
  shutdown(): void {
    this.cancelLogin('Closed.');
    this.stopPolling();
  }

  private onMedia = (track: SpotifyTrack | null, error?: string): void => {
    if (this.useApi) return; // the API is healthy: it wins
    this.lastState = { connected: true, track };
    this.emit();
    if (error && error !== this.lastMediaError) {
      this.lastMediaError = error;
      this.hooks.onNotice(error);
    }
  };

  private startMedia(): void {
    if (SystemMedia.supported) {
      this.media.start(this.onMedia, () => {
        const c = config.get('spotify') as { ignoreLive?: boolean; ignoreWords?: string } | undefined;
        return {
          ignoreLive: c?.ignoreLive !== false,
          ignoreWords: String(c?.ignoreWords ?? 'twitch').toLowerCase().split(',').map((w) => w.trim()).filter(Boolean),
        };
      });
    }
  }

  // ── HTTP ──
  private async tokenRequest(params: Record<string, string>): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
    const r = await net.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15000),
    });
    let j: any = null;
    try { j = await r.json(); } catch { /* not json */ }
    if (!r.ok || !j || typeof j.access_token !== 'string') {
      const e = new Error(j?.error_description || j?.error || `HTTP ${r.status}`) as Error & { fatal?: boolean };
      e.fatal = j?.error === 'invalid_grant' || j?.error === 'invalid_client';
      throw e;
    }
    return { access_token: j.access_token, refresh_token: j.refresh_token || '', expires_in: Number(j.expires_in) || 3600 };
  }

  private async refresh(): Promise<boolean> {
    if (!this.tokens) return false;
    try {
      const t = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.tokens.refresh, client_id: this.tokens.clientId });
      this.tokens = {
        access: t.access_token,
        refresh: t.refresh_token || this.tokens.refresh, // Spotify only sometimes rotates it
        expiresAt: Date.now() + t.expires_in * 1000,
        clientId: this.tokens.clientId,
      };
      this.save();
      return true;
    } catch (err) {
      electronLog.warn('[KRH-Spotify] token refresh failed:', (err as Error).message);
      if ((err as { fatal?: boolean }).fatal) {
        // Access was revoked or the app was removed: drop the login so the settings show "not connected".
        this.disconnect();
        this.hooks.onNotice('Spotify login expired. Connect again in Settings.');
      }
      return false;
    }
  }

  private async api(method: string, path: string, retried = false): Promise<Response | null> {
    this.load();
    if (!this.tokens) return null;
    if (this.tokens.expiresAt - Date.now() < 60_000 && !(await this.refresh())) return null;
    if (!this.tokens) return null;
    const r = await net.fetch(API + path, {
      method,
      headers: { authorization: 'Bearer ' + this.tokens.access },
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 401 && !retried) {
      if (await this.refresh()) return this.api(method, path, true);
      return null;
    }
    return r;
  }

  // ── Polling ──
  startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    this.failures = 0;
    this.apiBlockedAt = 0;
    this.startMedia(); // free / no-login source, only used while the API is not usable
    if (this.connected) void this.pollOnce();
    else this.emit();
  }

  stopPolling(): void {
    this.media.stop();
    this.polling = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  private schedule(ms: number): void {
    if (!this.polling) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => { void this.pollOnce(); }, ms);
  }

  private blockApi(reason: string): void {
    const first = this.apiBlockedAt === 0;
    this.apiBlockedAt = Date.now();
    electronLog.warn('[KRH-Spotify] Web API unusable (' + reason + '), using the system media session instead');
    if (first) {
      this.hooks.onNotice(SystemMedia.supported
        ? 'Spotify API refused (' + reason + '; it needs a Premium owner). Showing what plays on this PC instead.'
        : 'Spotify API refused (' + reason + '; it needs a Premium owner).');
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.polling) return;
    if (!this.useApi) { this.schedule(API_RETRY_MS); return; }
    let next = POLL_IDLE_MS;
    try {
      const r = await this.api('GET', '/me/player?additional_types=episode');
      if (!r) {
        next = POLL_IDLE_MS * 2;
      } else if (r.status === 204) {
        this.failures = 0;
        this.apiBlockedAt = 0;
        this.lastState = { connected: true, track: null };
        this.emit();
      } else if (r.status === 200) {
        this.failures = 0;
        this.apiBlockedAt = 0;
        const track = parsePlayer(await r.json(), Date.now());
        this.lastState = { connected: true, track };
        this.emit();
        next = track?.playing ? POLL_PLAYING_MS : POLL_IDLE_MS;
      } else if (r.status === 429) {
        next = Math.max(5, Number(r.headers.get('retry-after')) || 10) * 1000;
      } else if (r.status === 401 || r.status === 403) {
        // Not a temporary glitch: free account / app owner without Premium / app removed.
        this.blockApi('HTTP ' + r.status);
        next = API_RETRY_MS;
      } else {
        throw new Error('HTTP ' + r.status);
      }
    } catch (err) {
      this.failures++;
      next = Math.min(60_000, POLL_IDLE_MS * 2 ** Math.min(this.failures, 4));
      if (this.failures === 1) electronLog.warn('[KRH-Spotify] poll failed:', (err as Error).message);
      if (this.failures >= 3) this.blockApi('no answer');
    }
    this.schedule(next);
  }

  // ── Controls ──
  async control(action: SpotifyAction): Promise<void> {
    if (!this.useApi) { this.media.control(action); return; }
    try {
      let r: Response | null = null;
      if (action === 'next') r = await this.api('POST', '/me/player/next');
      else if (action === 'previous') r = await this.api('POST', '/me/player/previous');
      else {
        const playing = this.lastState.track?.playing === true;
        r = await this.api('PUT', playing ? '/me/player/pause' : '/me/player/play');
      }
      if (!r) return;
      if (r.status === 403) { this.hooks.onNotice('Spotify controls need Spotify Premium.'); this.media.control(action); }
      else if (r.status === 404) this.hooks.onNotice('No active Spotify device. Start playing in Spotify first.');
      else if (r.status === 429) this.hooks.onNotice('Spotify is rate limiting, try again in a moment.');
      else if (!r.ok && r.status !== 204) this.hooks.onNotice('Spotify error (HTTP ' + r.status + ').');
    } catch (err) {
      this.hooks.onNotice('Could not reach Spotify.');
      electronLog.warn('[KRH-Spotify] control failed:', (err as Error).message);
    }
    // Spotify takes a moment to reflect the change
    if (this.polling) this.schedule(500);
  }

  private emit(): void {
    this.hooks.onState(this.getState());
  }
}
