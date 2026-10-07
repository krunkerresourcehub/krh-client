import { connect as tlsConnect, TLSSocket } from 'tls';
import { net } from 'electron';
import { electronLog } from './logger';

/**
 * Twitch chat (read-only).
 *
 * Connects anonymously to Twitch IRC over TLS (a "justinfan" nick needs no login, token or API key),
 * parses messages in the main process and sends ready-to-render tokens to the game window.
 * Emote support: native Twitch emotes (from the IRC tags) plus BTTV, FrankerFaceZ and 7TV
 * (global + channel sets, from their public APIs). Emote images are fetched here and handed to the
 * page as data: URLs, so the game page's own network rules never have to allow those CDNs.
 *
 * Written from scratch for KRH Client against the public Twitch IRC / emote provider docs.
 */

export interface TwitchConfig {
  enabled: boolean;
  channel: string;
  showBadges: boolean;
  showHeader: boolean;
  thirdPartyEmotes: boolean;
  fontSize: number;
  width: number;
  height: number;
  x: number;
  y: number;
  background: number;
  autoPlace: boolean;
  /** Answer "!link" in the channel with the current game link (needs a chat token, see twitch-link.ts). */
  linkCommand: boolean;
  /** Only answer while the channel is live. */
  linkOnlyLive: boolean;
}

export type TwitchToken = { t: 'text'; v: string } | { t: 'emote'; url: string; name: string };

export interface TwitchChatMessage {
  id: string;
  user: string;
  color: string;
  badges: string[];
  action: boolean;
  tokens: TwitchToken[];
}

export interface TwitchStreamInfo {
  channel: string;
  /** Display name with the streamer's own capitalisation, e.g. "NotKyrex_". */
  name: string;
  live: boolean;
  viewers: number;
  game: string;
}

export type TwitchStatus = { state: 'connecting' | 'connected' | 'disconnected'; channel: string; detail?: string };

const GQL_URL = 'https://gql.twitch.tv/gql';
// Public web client id used by twitch.tv itself; lets us read "is this channel live" without any login or API key.
const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const STREAM_POLL_MS = 60 * 1000;

const IRC_HOST = 'irc.chat.twitch.tv';
const IRC_PORT = 6697;
const CHANNEL_RE = /^[a-z0-9_]{3,25}$/;
const EMOTE_ID_RE = /^[A-Za-z0-9_]{1,64}$/;
const MAX_TEXT = 500;
const IDLE_TIMEOUT_MS = 6 * 60 * 1000; // Twitch pings about every 5 minutes
const MAX_IMAGE_BYTES = 512 * 1024;
const IMAGE_CACHE_MAX = 400;

const ALLOWED_EMOTE_HOSTS = new Set([
  'static-cdn.jtvnw.net',
  'cdn.betterttv.net',
  'cdn.frankerfacez.com',
  'cdn.7tv.app',
]);

/** Accepts "name", "#name" or a twitch.tv link; returns '' when it is not a valid channel. */
export function normalizeChannel(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let c = raw.trim().toLowerCase();
  c = c.replace(/^https?:\/\/(www\.|m\.)?twitch\.tv\//, '').replace(/^#/, '');
  c = c.split(/[/?#]/)[0];
  return CHANNEL_RE.test(c) ? c : '';
}

export function isAllowedEmoteUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && ALLOWED_EMOTE_HOSTS.has(u.hostname);
  } catch { return false; }
}

function absUrl(u: string): string {
  return u.startsWith('//') ? 'https:' + u : u;
}

async function getJson(url: string): Promise<any | null> {
  try {
    const r = await net.fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** Live status of a channel (null when it could not be fetched). */
export async function fetchStreamInfo(channel: string): Promise<TwitchStreamInfo | null> {
  try {
    const r = await net.fetch(GQL_URL, {
      method: 'POST',
      headers: { 'Client-ID': GQL_CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query($l:String!){user(login:$l){displayName stream{viewersCount game{name}}}}',
        variables: { l: channel },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const user = j?.data?.user;
    if (!user) return { channel, name: channel, live: false, viewers: 0, game: '' };
    const name = typeof user.displayName === 'string' && user.displayName ? user.displayName.slice(0, 40) : channel;
    const stream = user.stream;
    return {
      channel,
      name,
      live: !!stream,
      viewers: Number(stream?.viewersCount) || 0,
      game: typeof stream?.game?.name === 'string' ? stream.game.name.slice(0, 60) : '',
    };
  } catch { return null; }
}

// ── Emote images (fetched in main, handed over as data: URLs) ──
const imageCache = new Map<string, string>();
const imageInflight = new Map<string, Promise<string | null>>();

export function fetchEmoteImage(url: string): Promise<string | null> {
  if (!isAllowedEmoteUrl(url)) return Promise.resolve(null);
  const hit = imageCache.get(url);
  if (hit) return Promise.resolve(hit);
  const pending = imageInflight.get(url);
  if (pending) return pending;
  const p = (async () => {
    try {
      const r = await net.fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return null;
      const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!/^image\/(png|webp|gif|jpeg|avif)$/.test(type)) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
      const data = `data:${type};base64,${buf.toString('base64')}`;
      if (imageCache.size >= IMAGE_CACHE_MAX) {
        const oldest = imageCache.keys().next().value;
        if (oldest !== undefined) imageCache.delete(oldest);
      }
      imageCache.set(url, data);
      return data;
    } catch { return null; } finally { imageInflight.delete(url); }
  })();
  imageInflight.set(url, p);
  return p;
}

// ── IRC helpers ──
function unescapeTag(v: string): string {
  return v.replace(/\\(.)/g, (_m, c: string) => (c === 's' ? ' ' : c === ':' ? ';' : c === 'r' ? '\r' : c === 'n' ? '\n' : c));
}

function parseTags(raw: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) tags[part] = '';
    else tags[part.slice(0, eq)] = unescapeTag(part.slice(eq + 1));
  }
  return tags;
}

const KNOWN_BADGES = new Set(['broadcaster', 'moderator', 'vip', 'subscriber', 'founder', 'staff', 'admin', 'global_mod', 'partner', 'verified']);

function parseBadges(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const entry of raw.split(',')) {
    const name = entry.split('/')[0];
    if (KNOWN_BADGES.has(name)) out.push(name);
  }
  return out;
}

interface Range { start: number; end: number; id: string }

function parseEmoteRanges(raw: string | undefined): Range[] {
  if (!raw) return [];
  const out: Range[] = [];
  for (const group of raw.split('/')) {
    const colon = group.indexOf(':');
    if (colon < 0) continue;
    const id = group.slice(0, colon);
    if (!EMOTE_ID_RE.test(id)) continue;
    for (const r of group.slice(colon + 1).split(',')) {
      const [a, b] = r.split('-').map(Number);
      if (Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= a) out.push({ start: a, end: b, id });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

export interface TwitchChatEvents {
  onMessage: (m: TwitchChatMessage) => void;
  onStatus: (s: TwitchStatus) => void;
  onStream?: (s: TwitchStreamInfo) => void;
  /** Every chat line as plain text (used for the !link command). */
  onChatLine?: (login: string, text: string) => void;
}

export class TwitchChat {
  private socket: TLSSocket | null = null;
  private channel = '';
  private thirdParty = true;
  private buf = '';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private streamTimer: ReturnType<typeof setInterval> | null = null;
  private backoff = 2000;
  private generation = 0;
  private roomId = '';
  private emotes = new Map<string, string>();
  private events: TwitchChatEvents;

  constructor(events: TwitchChatEvents) {
    this.events = events;
  }

  /** (Re)connect to a channel. No-op when already on that channel with the same emote setting. */
  connect(channel: string, thirdPartyEmotes: boolean): void {
    if (!channel) { this.disconnect(); return; }
    const sameChannel = channel === this.channel && (this.socket !== null || this.reconnectTimer !== null);
    if (sameChannel) {
      if (thirdPartyEmotes !== this.thirdParty) {
        this.thirdParty = thirdPartyEmotes;
        if (thirdPartyEmotes && this.roomId) void this.loadEmotes(this.generation, this.roomId);
        else this.emotes = new Map();
      }
      return;
    }
    this.disconnect();
    this.channel = channel;
    this.thirdParty = thirdPartyEmotes;
    this.generation++;
    this.backoff = 2000;
    this.open();
    this.startStreamPoll();
  }

  private startStreamPoll(): void {
    this.stopStreamPoll();
    if (!this.events.onStream) return;
    const gen = this.generation;
    const channel = this.channel;
    const poll = (): void => {
      void fetchStreamInfo(channel).then((info) => {
        if (info && gen === this.generation) this.events.onStream?.(info);
      });
    };
    poll();
    this.streamTimer = setInterval(poll, STREAM_POLL_MS);
  }

  private stopStreamPoll(): void {
    if (this.streamTimer) { clearInterval(this.streamTimer); this.streamTimer = null; }
  }

  disconnect(): void {
    this.generation++;
    this.stopStreamPoll();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const s = this.socket;
    this.socket = null;
    if (s) { s.removeAllListeners(); s.on('error', () => { /* ignore */ }); s.destroy(); }
    if (this.channel) this.events.onStatus({ state: 'disconnected', channel: this.channel });
    this.channel = '';
    this.roomId = '';
    this.buf = '';
    this.emotes = new Map();
  }

  private open(): void {
    const gen = this.generation;
    const channel = this.channel;
    this.events.onStatus({ state: 'connecting', channel });
    const socket = tlsConnect({ host: IRC_HOST, port: IRC_PORT, servername: IRC_HOST });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy(new Error('idle timeout')));
    socket.on('secureConnect', () => {
      if (gen !== this.generation) return;
      const nick = 'justinfan' + (10000 + Math.floor(Math.random() * 89999));
      socket.write(`CAP REQ :twitch.tv/tags twitch.tv/commands\r\nPASS SCHMOOPIIE\r\nNICK ${nick}\r\nJOIN #${channel}\r\n`);
    });
    socket.on('data', (chunk: string) => {
      if (gen !== this.generation) return;
      this.buf += chunk;
      if (this.buf.length > 1_000_000) { this.buf = ''; return; }
      let idx: number;
      while ((idx = this.buf.indexOf('\r\n')) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        if (line) this.handleLine(line, gen);
      }
    });
    const lost = (err?: Error): void => {
      if (gen !== this.generation) return;
      this.socket = null;
      this.buf = '';
      this.events.onStatus({ state: 'disconnected', channel, detail: err?.message });
      this.scheduleReconnect(gen);
    };
    socket.on('error', (err) => { electronLog.warn('[KRH] Twitch chat error:', err.message); lost(err); });
    socket.on('close', () => lost());
  }

  private scheduleReconnect(gen: number): void {
    if (gen !== this.generation || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (gen === this.generation && this.channel) this.open();
    }, delay);
  }

  private handleLine(line: string, gen: number): void {
    if (line.startsWith('PING')) { this.socket?.write('PONG :tmi.twitch.tv\r\n'); return; }
    let rest = line;
    let tags: Record<string, string> = {};
    if (rest[0] === '@') {
      const sp = rest.indexOf(' ');
      if (sp < 0) return;
      tags = parseTags(rest.slice(1, sp));
      rest = rest.slice(sp + 1);
    }
    let prefix = '';
    if (rest[0] === ':') {
      const sp = rest.indexOf(' ');
      if (sp < 0) return;
      prefix = rest.slice(1, sp);
      rest = rest.slice(sp + 1);
    }
    const sp = rest.indexOf(' ');
    const cmd = sp < 0 ? rest : rest.slice(0, sp);
    const params = sp < 0 ? '' : rest.slice(sp + 1);

    switch (cmd) {
      case 'PRIVMSG': this.handlePrivmsg(tags, prefix, params); break;
      case 'ROOMSTATE': {
        this.backoff = 2000;
        const id = tags['room-id'];
        if (id && /^\d+$/.test(id) && id !== this.roomId) {
          this.roomId = id;
          this.events.onStatus({ state: 'connected', channel: this.channel });
          if (this.thirdParty) void this.loadEmotes(gen, id);
        }
        break;
      }
      case 'RECONNECT': this.socket?.destroy(); break;
      default: break;
    }
  }

  private handlePrivmsg(tags: Record<string, string>, prefix: string, params: string): void {
    const textStart = params.indexOf(' :');
    if (textStart < 0) return;
    let text = params.slice(textStart + 2);
    let action = false;
    if (text.startsWith('\u0001ACTION ') && text.endsWith('\u0001')) {
      action = true;
      text = text.slice(8, -1);
    }
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    const login = prefix.split('!')[0];
    this.events.onChatLine?.(login, text);
    const user = (tags['display-name'] || login || '?').slice(0, 40);
    const color = /^#[0-9a-fA-F]{6}$/.test(tags['color'] || '') ? tags['color'] : '';
    this.events.onMessage({
      id: tags['id'] || '',
      user,
      color,
      badges: parseBadges(tags['badges']),
      action,
      tokens: this.tokenize(text, parseEmoteRanges(tags['emotes'])),
    });
  }

  private tokenize(text: string, ranges: Range[]): TwitchToken[] {
    const chars = Array.from(text);
    const tokens: TwitchToken[] = [];
    const pushText = (v: string): void => {
      if (!v) return;
      const last = tokens[tokens.length - 1];
      if (last && last.t === 'text') last.v += v;
      else tokens.push({ t: 'text', v });
    };
    const pushPlain = (segment: string): void => {
      if (!this.thirdParty || this.emotes.size === 0) { pushText(segment); return; }
      for (const part of segment.split(/(\s+)/)) {
        const url = this.emotes.get(part);
        if (url) tokens.push({ t: 'emote', url, name: part });
        else pushText(part);
      }
    };
    let pos = 0;
    for (const r of ranges) {
      if (r.start < pos || r.start >= chars.length) continue;
      pushPlain(chars.slice(pos, r.start).join(''));
      const name = chars.slice(r.start, r.end + 1).join('');
      tokens.push({ t: 'emote', url: `https://static-cdn.jtvnw.net/emoticons/v2/${r.id}/default/dark/2.0`, name });
      pos = r.end + 1;
    }
    pushPlain(chars.slice(pos).join(''));
    return tokens;
  }

  // ── BTTV / FrankerFaceZ / 7TV ──
  private async loadEmotes(gen: number, roomId: string): Promise<void> {
    const [bttvG, bttvC, ffzG, ffzC, stvG, stvC] = await Promise.all([
      getJson('https://api.betterttv.net/3/cached/emotes/global'),
      getJson(`https://api.betterttv.net/3/cached/users/twitch/${roomId}`),
      getJson('https://api.frankerfacez.com/v1/set/global'),
      getJson(`https://api.frankerfacez.com/v1/room/id/${roomId}`),
      getJson('https://7tv.io/v3/emote-sets/global'),
      getJson(`https://7tv.io/v3/users/twitch/${roomId}`),
    ]);
    if (gen !== this.generation || !this.thirdParty) return;

    const map = new Map<string, string>();
    const add = (name: unknown, url: unknown): void => {
      if (typeof name !== 'string' || typeof url !== 'string' || !name || /\s/.test(name)) return;
      const full = absUrl(url);
      if (isAllowedEmoteUrl(full)) map.set(name, full);
    };

    // Later sources win: globals first, then channel sets.
    const bttv = (list: any): void => {
      if (!Array.isArray(list)) return;
      for (const e of list) if (e && typeof e.id === 'string' && /^[A-Za-z0-9]+$/.test(e.id)) add(e.code, `https://cdn.betterttv.net/emote/${e.id}/2x.webp`);
    };
    const ffz = (json: any, setIds: string[]): void => {
      for (const id of setIds) {
        const list = json?.sets?.[id]?.emoticons;
        if (!Array.isArray(list)) continue;
        for (const e of list) add(e?.name, e?.urls?.['2'] || e?.urls?.['1']);
      }
    };
    const stv = (list: any): void => {
      if (!Array.isArray(list)) return;
      for (const e of list) {
        const host = e?.data?.host?.url;
        if (typeof host === 'string') add(e?.name, `${absUrl(host)}/2x.webp`);
      }
    };

    bttv(bttvG);
    ffz(ffzG, (ffzG?.default_sets ?? []).map(String));
    stv(stvG?.emotes);
    bttv(bttvC?.channelEmotes);
    bttv(bttvC?.sharedEmotes);
    if (ffzC?.room?.set !== undefined) ffz(ffzC, [String(ffzC.room.set)]);
    stv(stvC?.emote_set?.emotes);

    this.emotes = map;
    electronLog.log(`[KRH] Twitch chat: loaded ${map.size} third-party emotes`);
  }
}
