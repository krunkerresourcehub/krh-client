import { Socket } from 'net';
import { electronLog } from './logger';

// Application ID of the "Krunker Resource Hub Client" app in the Discord Developer Portal.
// The name and icon on the Discord profile come from that app. Art asset key used: `krh_logo`.
// KRH_DISCORD_CLIENT_ID can override it (e.g. for testing with another app).
const DISCORD_CLIENT_ID = process.env.KRH_DISCORD_CLIENT_ID || '1558098697810616400';

// Discord IPC opcodes
const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;

// Rate limit: Discord allows ~5 presence updates per 20s, so keep >= 4s between sends
const RATE_LIMIT_MS = 4000;
const RECONNECT_INTERVAL_MS = 30000;

export interface ActivityPayload {
    details?: string;
    state?: string;
    startTimestamp?: number;
    largeImageKey?: string;
    largeImageText?: string;
    buttons?: Array<{ label: string; url: string }>;
}

function getPipePath(id: number): string {
    if (process.platform === 'win32') {
        return `\\\\?\\pipe\\discord-ipc-${id}`;
    }
    // Linux/macOS: check XDG_RUNTIME_DIR, TMPDIR, TMP, TEMP, /tmp
    const dir = process.env.XDG_RUNTIME_DIR
        || process.env.TMPDIR
        || process.env.TMP
        || process.env.TEMP
        || '/tmp';
    return `${dir}/discord-ipc-${id}`;
}

function encodeFrame(opcode: number, payload: object): Buffer {
    const json = JSON.stringify(payload);
    const jsonBuf = Buffer.from(json);
    const header = Buffer.alloc(8);
    header.writeUInt32LE(opcode, 0);
    header.writeUInt32LE(jsonBuf.length, 4);
    return Buffer.concat([header, jsonBuf]);
}

export class DiscordRPC {
    private socket: Socket | null = null;
    private connected = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private lastUpdate = 0;
    private nonce = 0;
    private destroyed = false;
    private recvBuf = Buffer.alloc(0);
    private pendingActivity: ActivityPayload | null = null;
    // Last activity the game asked for. Kept so it can be re-sent after a (re)connect:
    // the preload only sends on change, so without this the presence vanishes for good
    // whenever Discord restarts or the pipe drops.
    private lastActivity: ActivityPayload | null = null;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;

    get isConnected(): boolean {
        return this.connected;
    }

    connect(): void {
        if (this.destroyed) return;
        this.tryConnect(0);
    }

    private tryConnect(pipeIndex: number): void {
        if (this.destroyed || pipeIndex > 9) {
            this.scheduleReconnect();
            return;
        }

        const pipePath = getPipePath(pipeIndex);
        const sock = new Socket();
        let settled = false;

        const onError = () => {
            if (settled) return;
            settled = true;
            sock.destroy();
            // Try next pipe index
            this.tryConnect(pipeIndex + 1);
        };

        sock.once('error', onError);

        sock.connect(pipePath, () => {
            if (settled || this.destroyed) {
                sock.destroy();
                return;
            }
            settled = true;
            sock.setTimeout(0);
            this.socket = sock;
            this.recvBuf = Buffer.alloc(0);

            // Remove the initial error handler and set up persistent ones
            sock.removeListener('error', onError);
            sock.on('error', (err) => {
                electronLog.warn('[KRH-Discord] Socket error:', err.message);
                this.handleDisconnect();
            });
            sock.on('close', () => {
                this.handleDisconnect();
            });
            sock.on('data', (data) => {
                this.onData(data);
            });

            // Send handshake
            const handshake = encodeFrame(OP_HANDSHAKE, {
                v: 1,
                client_id: DISCORD_CLIENT_ID,
            });
            sock.write(handshake);
        });

        // Connection timeout — 5s
        sock.setTimeout(5000, onError);
    }

    private onData(data: Buffer): void {
        this.recvBuf = Buffer.concat([this.recvBuf, data]);

        while (this.recvBuf.length >= 8) {
            const opcode = this.recvBuf.readUInt32LE(0);
            const length = this.recvBuf.readUInt32LE(4);

            if (this.recvBuf.length < 8 + length) break;

            const jsonBuf = this.recvBuf.slice(8, 8 + length);
            this.recvBuf = this.recvBuf.slice(8 + length);

            try {
                const payload = JSON.parse(jsonBuf.toString());
                this.handleMessage(opcode, payload);
            } catch {
                // Malformed JSON — ignore
            }
        }
    }

    private handleMessage(opcode: number, payload: any): void {
        if (opcode === OP_FRAME) {
            if (payload.cmd === 'DISPATCH' && payload.evt === 'READY') {
                this.connected = true;
                electronLog.log('[KRH-Discord] Connected to Discord');
                // Re-send the latest activity (set before connect, or from before a disconnect)
                const toSend = this.pendingActivity ?? this.lastActivity;
                this.pendingActivity = null;
                if (toSend) this.sendActivity(toSend);
            } else if (payload.evt === 'ERROR' || (payload.data && payload.data.code && payload.evt === 'ERROR')) {
                electronLog.warn('[KRH-Discord] Discord rejected a command:', payload.data?.code, payload.data?.message || '');
            }
        } else if (opcode === OP_CLOSE) {
            electronLog.warn('[KRH-Discord] Discord closed connection:', payload.message || '');
            this.handleDisconnect();
        }
    }

    private handleDisconnect(): void {
        if (!this.connected && !this.socket) return;
        this.connected = false;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.recvBuf = Buffer.alloc(0);
        electronLog.log('[KRH-Discord] Disconnected');
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (this.destroyed || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.destroyed && !this.connected) {
                this.tryConnect(0);
            }
        }, RECONNECT_INTERVAL_MS);
    }

    setActivity(activity: ActivityPayload): void {
        if (this.destroyed) return;

        // Always store latest activity so it can be sent on (re)connect
        this.pendingActivity = activity;
        this.lastActivity = activity;

        if (!this.connected || !this.socket) return;

        const now = Date.now();
        const elapsed = now - this.lastUpdate;
        if (elapsed < RATE_LIMIT_MS) {
            // Schedule a flush after the rate limit window expires
            if (!this.flushTimer) {
                this.flushTimer = setTimeout(() => {
                    this.flushTimer = null;
                    if (this.pendingActivity && this.connected && this.socket) {
                        this.sendActivity(this.pendingActivity);
                        this.pendingActivity = null;
                    }
                }, RATE_LIMIT_MS - elapsed);
            }
            return;
        }

        this.sendActivity(activity);
        this.pendingActivity = null;
    }

    private sendActivity(activity: ActivityPayload): void {
        if (!this.socket || this.destroyed) return;
        this.lastUpdate = Date.now();

        // Discord rejects the whole payload if details/state are shorter than 2 or longer than 128 chars
        const clean = (v?: string): string | undefined => {
            const t = (v ?? '').trim();
            if (t.length < 2) return undefined;
            return t.length > 128 ? t.slice(0, 127) + '…' : t;
        };
        const activityObj: any = {};
        const details = clean(activity.details);
        const state = clean(activity.state);
        if (details) activityObj.details = details;
        if (state) activityObj.state = state;
        if (activity.startTimestamp) {
            // Discord wants unix seconds; accept ms too
            const ts = activity.startTimestamp > 1e12 ? Math.floor(activity.startTimestamp / 1000) : activity.startTimestamp;
            activityObj.timestamps = { start: ts };
        }
        if (activity.buttons && activity.buttons.length) activityObj.buttons = activity.buttons.slice(0, 2);
        if (activity.largeImageKey) {
            activityObj.assets = {
                large_image: activity.largeImageKey,
                large_text: activity.largeImageText || 'Krunker Resource Hub Client',
            };
        }

        const frame = encodeFrame(OP_FRAME, {
            cmd: 'SET_ACTIVITY',
            args: {
                pid: process.pid,
                activity: activityObj,
            },
            nonce: String(++this.nonce),
        });

        try {
            this.socket.write(frame);
        } catch (err) {
            electronLog.warn('[KRH-Discord] Write error:', (err as Error).message);
        }
    }

    clearActivity(): void {
        if (!this.connected || !this.socket || this.destroyed) return;

        const frame = encodeFrame(OP_FRAME, {
            cmd: 'SET_ACTIVITY',
            args: {
                pid: process.pid,
                activity: null,
            },
            nonce: String(++this.nonce),
        });

        try {
            this.socket.write(frame);
        } catch {
            // Silent
        }
    }

    disconnect(): void {
        this.destroyed = true;
        this.lastActivity = null;
        this.pendingActivity = null;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.socket) {
            try {
                this.clearActivity();
            } catch {
                // Silent
            }
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
        this.recvBuf = Buffer.alloc(0);
    }
}
