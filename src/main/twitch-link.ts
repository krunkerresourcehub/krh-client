import { connect as tlsConnect, TLSSocket } from 'tls';
import { safeStorage } from 'electron';
import { config } from './config';
import { electronLog } from './logger';

/**
 * Twitch "!link" command (idea from the LaF Client, https://github.com/LaFClient/LaF; written from scratch).
 *
 * When a viewer types !link in the streamer's own chat, KRH Client answers with the link of the game you
 * are in. Reading the chat is done by the normal read-only chat connection (twitch.ts); this file only
 * SENDS the answer, over a second, logged-in IRC connection that uses an OAuth token the user pastes in
 * the settings (needs the chat:edit scope, and the token has to belong to the channel owner).
 * The token is stored encrypted with the system keychain when available and never reaches the game page.
 */

const IRC_HOST = 'irc.chat.twitch.tv';
const IRC_PORT = 6697;
const IDLE_TIMEOUT_MS = 6 * 60 * 1000;
const MIN_SEND_GAP_MS = 1500;

/** Accepts "oauth:abc…" or the bare token; returns '' when it does not look like a Twitch token. */
export function normalizeToken(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const t = raw.trim().replace(/^oauth:/i, '');
  return /^[a-z0-9]{20,100}$/i.test(t) ? t : '';
}

export function loadToken(): string {
  const raw = String(config.get('twitchBotAuth') || '');
  if (!raw) return '';
  try {
    if (raw.startsWith('enc:')) return normalizeToken(safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64')));
    if (raw.startsWith('plain:')) return normalizeToken(Buffer.from(raw.slice(6), 'base64').toString('utf8'));
  } catch (err) {
    electronLog.warn('[KRH-Twitch] could not read the saved chat token:', (err as Error).message);
  }
  return '';
}

export function saveToken(token: string): void {
  if (!token) { config.set('twitchBotAuth', ''); return; }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      config.set('twitchBotAuth', 'enc:' + safeStorage.encryptString(token).toString('base64'));
      return;
    }
  } catch { /* fall through to plain */ }
  config.set('twitchBotAuth', 'plain:' + Buffer.from(token, 'utf8').toString('base64'));
}

export class TwitchLinkBot {
  private socket: TLSSocket | null = null;
  private channel = '';
  private token = '';
  private buf = '';
  private ready = false;
  private authFailed = false;
  private generation = 0;
  private backoff = 3000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSent = 0;

  constructor(private onNotice: (text: string) => void) {}

  get isReady(): boolean { return this.ready; }

  /** Connect (or reconnect) for a channel + token; empty values disconnect. No-op when nothing changed. */
  configure(channel: string, token: string): void {
    if (!channel || !token) { this.disconnect(); return; }
    if (channel === this.channel && token === this.token && (this.socket || this.reconnectTimer)) return;
    this.disconnect();
    this.channel = channel;
    this.token = token;
    this.authFailed = false;
    this.backoff = 3000;
    this.open();
  }

  disconnect(): void {
    this.generation++;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const s = this.socket;
    this.socket = null;
    if (s) { s.removeAllListeners(); s.on('error', () => { /* ignore */ }); s.destroy(); }
    this.ready = false;
    this.channel = '';
    this.token = '';
    this.buf = '';
  }

  /** Send one chat message to the channel. Returns false when it was dropped. */
  say(text: string): boolean {
    const s = this.socket;
    if (!s || !this.ready) return false;
    const now = Date.now();
    if (now - this.lastSent < MIN_SEND_GAP_MS) return false;
    const clean = text.replace(/[\r\n]+/g, ' ').slice(0, 400);
    if (!clean) return false;
    this.lastSent = now;
    s.write(`PRIVMSG #${this.channel} :${clean}\r\n`);
    return true;
  }

  private open(): void {
    const gen = this.generation;
    const channel = this.channel;
    const token = this.token;
    const socket = tlsConnect({ host: IRC_HOST, port: IRC_PORT, servername: IRC_HOST });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy(new Error('idle timeout')));
    socket.on('secureConnect', () => {
      if (gen !== this.generation) return;
      socket.write(`PASS oauth:${token}\r\nNICK ${channel}\r\n`);
    });
    socket.on('data', (chunk: string) => {
      if (gen !== this.generation) return;
      this.buf += chunk;
      if (this.buf.length > 200_000) { this.buf = ''; return; }
      let idx: number;
      while ((idx = this.buf.indexOf('\r\n')) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        if (line) this.handleLine(line, socket);
      }
    });
    const lost = (err?: Error): void => {
      if (gen !== this.generation) return;
      this.socket = null;
      this.ready = false;
      this.buf = '';
      if (err) electronLog.warn('[KRH-Twitch] !link connection error:', err.message);
      if (!this.authFailed) this.scheduleReconnect(gen);
    };
    socket.on('error', (err) => lost(err));
    socket.on('close', () => lost());
  }

  private handleLine(line: string, socket: TLSSocket): void {
    if (line.startsWith('PING')) { socket.write('PONG :tmi.twitch.tv\r\n'); return; }
    // Welcome (001) means the login was accepted.
    if (/^:\S+ 001 /.test(line)) {
      this.ready = true;
      this.backoff = 3000;
      socket.write(`JOIN #${this.channel}\r\n`);
      electronLog.log('[KRH-Twitch] !link bot connected as ' + this.channel);
      return;
    }
    if (/NOTICE \* :(Login authentication failed|Improperly formatted auth|Login unsuccessful)/i.test(line)) {
      this.authFailed = true;
      this.ready = false;
      this.onNotice('Twitch refused the chat token for "' + this.channel + '". It must be a token of that account with the chat:edit scope.');
      socket.destroy();
      return;
    }
    if (line.startsWith('RECONNECT') || / RECONNECT/.test(line)) socket.destroy();
  }

  private scheduleReconnect(gen: number): void {
    if (gen !== this.generation || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 60000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (gen === this.generation && this.channel) this.open();
    }, delay);
  }
}
