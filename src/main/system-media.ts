import { spawn, execFile, ChildProcess } from 'child_process';
import { electronLog } from './logger';
import type { SpotifyTrack } from './spotify';

/**
 * "Now playing" straight from the operating system, with NO Spotify login, API or Premium needed.
 * Works for the Spotify desktop app AND for Spotify (or anything else) playing in a browser tab:
 *   - Windows: System Media Transport Controls (the same thing behind the volume flyout media card),
 *     read through one long-lived hidden PowerShell process.
 *   - Linux: MPRIS through `playerctl` (install it with your package manager if it is missing).
 * Album art is not available from here, the card simply shows title + artist.
 */

const WIN_POLL_MS = 2000;
const LINUX_POLL_MS = 2500;

const PS_HEADER = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($op, $type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
function Get-Mgr { Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) }
function Pick-Session($mgr) {
  $best = $null
  foreach ($s in $mgr.GetSessions()) {
    $st = [string]$s.GetPlaybackInfo().PlaybackStatus
    $isSp = ([string]$s.SourceAppUserModelId) -match 'spotify'
    if ($st -eq 'Playing' -and $isSp) { return $s }
    if ($st -eq 'Playing' -and -not $best) { $best = $s }
  }
  if ($best) { return $best }
  $cur = $mgr.GetCurrentSession()
  if ($cur) { return $cur }
  return $null
}
`;

const PS_POLL = PS_HEADER + `
while ($true) {
  $list = @()
  $err = $null
  try {
    $mgr = Get-Mgr
    foreach ($s in $mgr.GetSessions()) {
      try {
        $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        if (-not $p.Title) { continue }
        $pb = $s.GetPlaybackInfo()
        $tl = $s.GetTimelineProperties()
        $list += @{
          app = [string]$s.SourceAppUserModelId
          title = [string]$p.Title
          artist = [string]$p.Artist
          album = [string]$p.AlbumTitle
          playing = ([string]$pb.PlaybackStatus -eq 'Playing')
          pos = [int64]$tl.Position.TotalMilliseconds
          dur = [int64]($tl.EndTime.TotalMilliseconds - $tl.StartTime.TotalMilliseconds)
        }
      } catch { }
    }
  } catch { $err = $_.Exception.Message }
  $out = @{ ok = ($null -eq $err); err = $err; sessions = @($list) }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${WIN_POLL_MS}
}
`;

const psControl = (method: string): string => PS_HEADER + `
$mgr = Get-Mgr
$s = Pick-Session $mgr
if ($s) { [void](Await ($s.${method}()) ([bool])) }
`;

const encodePs = (script: string): string => Buffer.from(script, 'utf16le').toString('base64');

type Listener = (t: SpotifyTrack | null, error?: string) => void;

/** What to leave out: live streams (no duration, e.g. a Twitch tab) and anything containing one of these words. */
export interface MediaFilter { ignoreLive: boolean; ignoreWords: string[] }

interface RawSession { app: string; title: string; artist: string; album: string; playing: boolean; pos: number; dur: number }

/** Pick the session to show: not filtered out, playing before paused, the Spotify app before browsers. */
function pickSession(list: RawSession[], f: MediaFilter): RawSession | null {
  const ok = list.filter((x) => {
    if (f.ignoreLive && !(x.dur > 0)) return false;
    const hay = (x.app + ' ' + x.title + ' ' + x.artist + ' ' + x.album).toLowerCase();
    return !f.ignoreWords.some((w) => w && hay.includes(w));
  });
  const score = (x: RawSession): number => (x.playing ? 2 : 0) + (/spotify/i.test(x.app) ? 1 : 0);
  ok.sort((a, b) => score(b) - score(a));
  return ok[0] ?? null;
}

export class SystemMedia {
  private proc: ChildProcess | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buf = '';
  private listener: Listener | null = null;
  private lastError = '';
  private getFilter: () => MediaFilter = () => ({ ignoreLive: true, ignoreWords: [] });

  static get supported(): boolean {
    return process.platform === 'win32' || process.platform === 'linux';
  }

  start(listener: Listener, getFilter?: () => MediaFilter): void {
    if (this.proc || this.timer || !SystemMedia.supported) return;
    this.listener = listener;
    if (getFilter) this.getFilter = getFilter;
    if (process.platform === 'win32') this.startWindows();
    else this.startLinux();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.proc) {
      try { this.proc.kill(); } catch { /* already gone */ }
      this.proc = null;
    }
    this.buf = '';
    this.listener = null;
  }

  get running(): boolean { return !!this.proc || !!this.timer; }

  // ── Windows ──
  private startWindows(): void {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(PS_POLL),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = child;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line) this.handleWinLine(line);
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => { this.lastError = d.slice(0, 200); });
    child.on('error', (e) => {
      electronLog.warn('[KRH-Media] PowerShell failed to start:', e.message);
      this.proc = null;
      this.listener?.(null, 'Could not start PowerShell: ' + e.message);
    });
    child.on('exit', () => {
      if (this.proc === child) {
        this.proc = null;
        this.listener?.(null, this.lastError ? 'System media reader stopped: ' + this.lastError : undefined);
      }
    });
  }

  private handleWinLine(line: string): void {
    try {
      const j = JSON.parse(line);
      if (!j.ok) { this.listener?.(null, 'System media error: ' + String(j.err || 'unknown')); return; }
      const sessions: RawSession[] = (Array.isArray(j.sessions) ? j.sessions : []).map((x: Record<string, unknown>) => ({
        app: String(x.app || ''), title: String(x.title || ''), artist: String(x.artist || ''), album: String(x.album || ''),
        playing: x.playing === true, pos: Number(x.pos) || 0, dur: Number(x.dur) || 0,
      }));
      const pick = pickSession(sessions, this.getFilter());
      if (!pick) { this.listener?.(null); return; }
      this.listener?.({
        id: pick.title + '|' + pick.artist,
        title: pick.title,
        artist: pick.artist,
        album: pick.album,
        artUrl: '',
        playing: pick.playing,
        progressMs: Math.max(0, pick.pos),
        durationMs: Math.max(0, pick.dur),
        at: Date.now(),
      });
    } catch { /* partial / non JSON line */ }
  }

  // ── Linux (playerctl / MPRIS) ──
  private startLinux(): void {
    const tick = (): void => {
      execFile('playerctl', ['metadata', '--format', '{{status}}\t{{title}}\t{{artist}}\t{{album}}\t{{position}}\t{{mpris:length}}'],
        { timeout: 4000 }, (err, stdout) => {
          if (!this.listener) return;
          if (err) {
            const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
            // playerctl exits non-zero when no player is running: that is just "nothing playing"
            this.listener(null, missing ? 'Install "playerctl" to show what is playing (no Spotify login needed).' : undefined);
            return;
          }
          const [status, title, artist, album, pos, len] = stdout.replace(/\n$/, '').split('\t');
          if (!title) { this.listener(null); return; }
          const lenMs = Math.max(0, Math.round((Number(len) || 0) / 1000));
          if (pickSession([{ app: '', title, artist: artist || '', album: album || '', playing: status === 'Playing', pos: 0, dur: lenMs }], this.getFilter()) === null) { this.listener(null); return; }
          this.listener({
            id: title + '|' + artist, title, artist: artist || '', album: album || '', artUrl: '',
            playing: status === 'Playing',
            progressMs: Math.max(0, Math.round((Number(pos) || 0) / 1000)),
            durationMs: Math.max(0, Math.round((Number(len) || 0) / 1000)),
            at: Date.now(),
          });
        });
    };
    this.timer = setInterval(tick, LINUX_POLL_MS);
    tick();
  }

  // ── Controls ──
  control(action: 'toggle' | 'next' | 'previous'): void {
    if (process.platform === 'win32') {
      const method = action === 'toggle' ? 'TryTogglePlayPauseAsync' : action === 'next' ? 'TrySkipNextAsync' : 'TrySkipPreviousAsync';
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(psControl(method))],
        { windowsHide: true, stdio: 'ignore' }).on('error', () => { /* ignore */ });
    } else if (process.platform === 'linux') {
      const cmd = action === 'toggle' ? 'play-pause' : action;
      execFile('playerctl', [cmd], { timeout: 4000 }, () => { /* ignore */ });
    }
  }
}
