import { app } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, readdirSync, unlinkSync, createWriteStream, WriteStream } from 'fs';

const LOG_RETENTION_DAYS = 7;

let electronStream: WriteStream;
let electronPath: string;
let ready = false;

function dateStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function pruneOldLogs(logDir: string): void {
  try {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 86400000;
    for (const file of readdirSync(logDir)) {
      const m = file.match(/^electron-(\d{4}-\d{2}-\d{2})\.log$/);
      if (!m) continue;
      const fileDate = new Date(m[1] + 'T00:00:00').getTime();
      if (fileDate < cutoff) {
        try { unlinkSync(join(logDir, file)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function init(): void {
  if (ready) return;
  const logDir = join(app.getPath('userData'), 'logs');
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

  pruneOldLogs(logDir);

  const stamp = dateStamp();
  electronPath = join(logDir, `electron-${stamp}.log`);

  // Append to today's log — one file per day, multiple sessions
  electronStream = createWriteStream(electronPath, { flags: 'a' });

  const sep = `\n${'='.repeat(60)}\n  Session started ${new Date().toISOString()}\n${'='.repeat(60)}\n`;
  electronStream.write(sep);
  ready = true;
}

function ts(): string {
  return new Date().toISOString();
}

function fmt(...args: unknown[]): string {
  return args.map(a => {
    if (a instanceof Error) return `${a.message}\n${a.stack}`;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

// Readable log lines (idea from the Water Client's "Better Console"): wall-clock time with milliseconds and a
// source tag, MAIN for the client itself and RENDERER for the game page (forwarded when Verbose Logging is on).
// In a terminal (npm start) the tag is coloured; the log file gets the same text without colours.
function clock(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function makeLogger(getStream: () => WriteStream, tag: 'MAIN' | 'RENDERER' = 'MAIN') {
  const tty = !!process.stdout.isTTY;
  const color = tag === 'MAIN' ? '\x1b[35m' : '\x1b[36m';
  const line = (m: string): string => (tty ? `\x1b[90m${clock()}\x1b[0m ${color}[${tag}]\x1b[0m ${m}` : `${clock()} [${tag}] ${m}`);
  return {
    log: (...args: unknown[]) => { init(); const m = fmt(...args); console.log(line(m)); if (!closed) getStream().write(`[${ts()}] [${tag}] ${m}\n`); },
    warn: (...args: unknown[]) => { init(); const m = fmt(...args); console.warn(line(m)); if (!closed) getStream().write(`[${ts()}] [${tag}] WARN: ${m}\n`); },
    error: (...args: unknown[]) => { init(); const m = fmt(...args); console.error(line(m)); if (!closed) getStream().write(`[${ts()}] [${tag}] ERROR: ${m}\n`); },
  };
}

export const electronLog = makeLogger(() => electronStream);
export const rendererLog = makeLogger(() => electronStream, 'RENDERER');

export function getLogPath(): string {
  init();
  return electronPath;
}

let closed = false;

export function closeLogStreams(): void {
  closed = true;
  if (electronStream) electronStream.end();
}
