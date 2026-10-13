import { get as httpsGet } from 'https';
import { createReadStream, createWriteStream, renameSync, unlinkSync, existsSync, statSync } from 'fs';
import { pipeline } from 'stream';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { app } from 'electron';
import { electronLog } from './logger';

export interface UpdateInfo {
  version: string;
  downloadUrl: string;
  fileSize: number;
  sha256: string;
  notes: string;
}

/** Lightweight "an update exists" result for builds that can't self-install (portable, AppImage). */
export interface UpdateNotice {
  version: string;
  /** Link to the release page, where the user can pick the download for their platform. */
  releaseUrl: string;
  notes: string;
}

export type ProgressCallback = (percent: number) => void;

interface GithubAsset {
  name: string;
  browser_download_url: string;
  size: number;
  digest: string;
}

interface GithubRelease {
  tag_name: string;
  html_url: string;
  body?: string;
  assets: GithubAsset[];
}

// Update checks read the latest GitHub release of the repository configured below (krunkerresourcehub/krh-client).
// Releases need a vX.Y.Z tag and a '...Setup.exe' asset for the Windows self-update.
const UPDATES_ENABLED = true;

const UPDATE_CONFIG = {
  checkUrl: 'https://api.github.com/repos/krunkerresourcehub/krh-client/releases/latest',
  releasesUrl: 'https://github.com/krunkerresourcehub/krh-client/releases/latest',
  allowedHosts: ['github.com', 'githubusercontent.com'],
};

export const RELEASES_URL = UPDATE_CONFIG.releasesUrl;

// Only Windows self-installs (the NSIS Setup.exe); other platforms use the notice path.
function updateAssetPattern(): RegExp {
  if (process.platform === 'win32') return /Setup\.exe$/i;
  return /$^/; // matches nothing
}

// The version flows into a filesystem path (installer name) and the dialog HTML, so
// reject anything with path separators, HTML metacharacters, or whitespace.
function isSafeVersion(v: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(v);
}

const CHECK_TIMEOUT_MS = 10000;
// A download may take as long as it needs; it only counts as stuck when NO data arrives for this long.
const DOWNLOAD_STALL_MS = 60000;
const DOWNLOAD_MAX_RETRIES = 20; // interrupted downloads continue where they stopped (Range), this caps the attempts

function isAllowedRedirect(url: string): boolean {
  try {
    const parsed = new URL(url);
    return UPDATE_CONFIG.allowedHosts.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

function versionLessThan(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na < nb) return true;
    if (na > nb) return false;
  }
  return false;
}

/** Resolves the latest GitHub release, or null on any error/timeout/non-200 (never rejects). */
function fetchLatestRelease(currentVersion: string): Promise<GithubRelease | null> {
  return new Promise((resolve) => {
    const headers = { 'User-Agent': 'KrunkerKRHClient/' + currentVersion };

    function doGet(url: string, redirectCount: number): void {
      if (redirectCount > 5) {
        electronLog.error('[KRH-Update] Too many redirects during check');
        resolve(null);
        return;
      }

      const req = httpsGet(url, { headers }, (res) => {
        electronLog.log('[KRH-Update] Check response status:', res.statusCode);
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = res.headers.location;
          electronLog.log('[KRH-Update] Redirected to:', redirectUrl);
          if (!isAllowedRedirect(redirectUrl)) {
            electronLog.error('[KRH-Update] Redirect to untrusted host blocked:', redirectUrl);
            resolve(null);
            return;
          }
          res.resume(); // drain so the socket can be reused
          doGet(redirectUrl, redirectCount + 1);
          return;
        }

        if (res.statusCode !== 200) {
          electronLog.error('[KRH-Update] Check returned status', res.statusCode);
          resolve(null);
          return;
        }

        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as GithubRelease);
          } catch (err) {
            electronLog.error('[KRH-Update] Failed to parse release data:', err);
            resolve(null);
          }
        });
        res.on('error', (err) => {
          electronLog.error('[KRH-Update] Response error:', err);
          resolve(null);
        });
      });

      req.setTimeout(CHECK_TIMEOUT_MS, () => {
        electronLog.error('[KRH-Update] Check timed out after', CHECK_TIMEOUT_MS, 'ms');
        req.destroy();
        resolve(null);
      });

      req.on('error', (err) => {
        electronLog.error('[KRH-Update] Check error:', err);
        resolve(null);
      });
    }

    electronLog.log('[KRH-Update] Checking for updates at:', UPDATE_CONFIG.checkUrl);
    electronLog.log('[KRH-Update] Current version:', currentVersion);
    doGet(UPDATE_CONFIG.checkUrl, 0);
  });
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  if (!UPDATES_ENABLED) return null;
  const release = await fetchLatestRelease(currentVersion);
  if (!release) return null;

  const remoteVersion = (release.tag_name || '').replace(/^v/i, '');
  if (remoteVersion && !isSafeVersion(remoteVersion)) {
    electronLog.error('[KRH-Update] Rejecting release with unsafe version token:', remoteVersion);
    return null;
  }
  electronLog.log('[KRH-Update] Latest release:', remoteVersion, '| Current:', currentVersion);
  if (!remoteVersion || !versionLessThan(currentVersion, remoteVersion)) {
    electronLog.log('[KRH-Update] Already up to date');
    return null;
  }

  const pattern = updateAssetPattern();
  const setupAsset = (release.assets || []).find((a) => pattern.test(a.name));
  if (!setupAsset) {
    electronLog.error('[KRH-Update] No installable asset matching', String(pattern), 'in release', remoteVersion);
    return null;
  }

  if (!isAllowedRedirect(setupAsset.browser_download_url)) {
    electronLog.error('[KRH-Update] Download URL points to untrusted host:', setupAsset.browser_download_url);
    return null;
  }

  // GitHub returns the digest as "sha256:<hex>"
  const sha256 = (setupAsset.digest || '').replace(/^sha256:/i, '');
  if (!sha256) {
    electronLog.error('[KRH-Update] No SHA-256 digest found for asset');
    return null;
  }

  electronLog.log('[KRH-Update] Update available:', remoteVersion, '| SHA-256:', sha256.substring(0, 16) + '...');
  return {
    version: remoteVersion,
    downloadUrl: setupAsset.browser_download_url,
    fileSize: setupAsset.size,
    sha256,
    notes: release.body || '',
  };
}

/**
 * Newer-release check for builds that can't self-install (macOS, Linux, portable):
 * returns the version plus a link to the release page, without downloading anything.
 */
export async function checkForUpdateNotice(currentVersion: string): Promise<UpdateNotice | null> {
  if (!UPDATES_ENABLED) return null;
  const release = await fetchLatestRelease(currentVersion);
  if (!release) return null;

  const remoteVersion = (release.tag_name || '').replace(/^v/i, '');
  if (remoteVersion && !isSafeVersion(remoteVersion)) {
    electronLog.error('[KRH-Update] Rejecting release with unsafe version token:', remoteVersion);
    return null;
  }
  electronLog.log('[KRH-Update] Latest release:', remoteVersion, '| Current:', currentVersion);
  if (!remoteVersion || !versionLessThan(currentVersion, remoteVersion)) {
    electronLog.log('[KRH-Update] Already up to date');
    return null;
  }

  const releaseUrl = release.html_url || UPDATE_CONFIG.releasesUrl;
  if (!isAllowedRedirect(releaseUrl)) {
    electronLog.error('[KRH-Update] Notice URL points to untrusted host:', releaseUrl);
    return null;
  }

  electronLog.log('[KRH-Update] Update notice:', remoteVersion, '->', releaseUrl);
  return { version: remoteVersion, releaseUrl, notes: release.body || '' };
}

function verifyChecksum(filePath: string, expectedSha256: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      const actual = hash.digest('hex');
      electronLog.log('[KRH-Update] SHA-256 expected:', expectedSha256);
      electronLog.log('[KRH-Update] SHA-256 actual:  ', actual);
      resolve(actual === expectedSha256);
    });
    stream.on('error', reject);
  });
}

export function downloadUpdate(url: string, destPath: string, onProgress: ProgressCallback, expectedSha256?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmpPath = destPath + '.tmp';
    let retries = 0;
    let total = 0; // size of the whole file once the server told us

    const giveUp = (err: Error): void => {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      reject(err);
    };

    // A stalled or dropped connection is not the end: wait a moment and continue from the bytes already on disk.
    const retry = (err: Error, madeProgress: boolean): void => {
      if (madeProgress) retries = 0;
      retries++;
      if (retries > DOWNLOAD_MAX_RETRIES) { giveUp(err); return; }
      electronLog.warn(`[KRH-Update] Download interrupted (${err.message}), continuing (attempt ${retries})`);
      setTimeout(() => doDownload(url), Math.min(1000 * retries, 8000));
    };

    function doDownload(downloadUrl: string, redirectCount = 0): void {
      if (redirectCount > 5) {
        giveUp(new Error('Too many redirects'));
        return;
      }
      let resumeFrom = 0;
      try { if (existsSync(tmpPath)) resumeFrom = statSync(tmpPath).size; } catch { resumeFrom = 0; }
      electronLog.log('[KRH-Update] Downloading from:', downloadUrl, resumeFrom > 0 ? `(continuing at ${resumeFrom} bytes)` : '');

      let settled = false; // one outcome per attempt, whichever event comes first
      let gotData = false;
      const once = (fn: () => void): void => { if (!settled) { settled = true; fn(); } };

      const req = httpsGet(downloadUrl, {
        headers: { 'User-Agent': 'KrunkerKRHClient', ...(resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {}) },
      }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = res.headers.location;
          electronLog.log('[KRH-Update] Download redirected to:', redirectUrl);
          res.resume();
          req.setTimeout(0); // this request is done: its timer must not outlive it and cut the real download
          once(() => {
            if (!isAllowedRedirect(redirectUrl)) {
              electronLog.error('[KRH-Update] Download redirect to untrusted host blocked:', redirectUrl);
              giveUp(new Error('Download redirect to untrusted host: ' + redirectUrl));
              return;
            }
            doDownload(redirectUrl, redirectCount + 1);
          });
          return;
        }

        if (res.statusCode === 416) { // the saved part does not fit the file: start over
          res.resume();
          once(() => { try { unlinkSync(tmpPath); } catch { /* ignore */ } doDownload(url); });
          return;
        }

        const partial = res.statusCode === 206;
        if (res.statusCode !== 200 && !partial) {
          electronLog.error('[KRH-Update] Download returned status', res.statusCode, 'from:', downloadUrl);
          res.resume();
          const status = res.statusCode ?? 0;
          once(() => (status >= 500 ? retry(new Error('Download returned status ' + status), false) : giveUp(new Error('Download returned status ' + status))));
          return;
        }

        const length = parseInt(res.headers['content-length'] || '0', 10);
        const startAt = partial ? resumeFrom : 0;
        if (length > 0) total = startAt + length;
        let received = startAt;

        res.on('data', (chunk: Buffer) => {
          gotData = true;
          received += chunk.length;
          if (total > 0) onProgress(Math.min(100, Math.round(100 * received / total)));
        });

        const file = createWriteStream(tmpPath, { flags: partial ? 'a' : 'w' });
        pipeline(res, file, (err) => {
          if (err) { once(() => retry(err, gotData)); return; } // cut off half way: the part on disk is kept
          once(() => {
            void (async () => {
              try {
                if (expectedSha256) {
                  const valid = await verifyChecksum(tmpPath, expectedSha256);
                  if (!valid) {
                    electronLog.error('[KRH-Update] Checksum mismatch — file may be corrupted or tampered');
                    giveUp(new Error('SHA-256 checksum mismatch'));
                    return;
                  }
                  electronLog.log('[KRH-Update] Checksum verified');
                }
                if (existsSync(destPath)) unlinkSync(destPath);
                renameSync(tmpPath, destPath);
                resolve();
              } catch (e) {
                reject(e);
              }
            })();
          });
        });
      });

      // Socket idle timer of THIS request: it restarts whenever data arrives, so a slow but moving download is fine.
      req.setTimeout(DOWNLOAD_STALL_MS, () => {
        req.destroy(new Error(`no data for ${DOWNLOAD_STALL_MS / 1000} s`));
      });

      req.on('error', (err) => { once(() => retry(err, gotData)); });
    }

    doDownload(url);
  });
}

export function installUpdate(installerPath: string): void {
  electronLog.log('[KRH-Update] Launching installer:', installerPath);
  const child = spawn(installerPath, [], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  app.quit();
}

