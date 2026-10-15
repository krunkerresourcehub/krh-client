/*
 * Adapted from NM/NZ Client (https://github.com/nmallik1029/nm-nez-client), scripts/lite-release.mjs.
 * NM/NZ Client is GPL-3.0-or-later, like KRH Client. See THIRD_PARTY_NOTICES.md.
 * Changes: app.asar only, KRH product name and 4-part release version.
 */

/**
 * The publishing half of updating without the installer.
 *
 * Run after `electron-builder --win`, from the repo root. Reads the packaged app out of
 * out/win-unpacked/resources and writes out/lite/:
 *
 *   lite.json                 what the client reads first
 *   KRH-Client-<v>.asar       resources/app.asar, as shipped in the installer
 *
 * The release workflow uploads both next to the installers. Why any of this exists, and what the client does with
 * it, is in src/shared/lite-update.ts.
 *
 * Exits non-zero on anything missing rather than publishing a manifest that would send every client back to the
 * installer.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCES = join(ROOT, 'out', 'win-unpacked', 'resources');
const OUT = join(ROOT, 'out', 'lite');
const PRODUCT = 'KRH-Client';

function fail(message) {
  console.error(`lite-release: ${message}`);
  process.exit(1);
}

// The release version is extraMetadata.version in electron-builder.yml (4 parts, e.g. 1.3.0.0): package.json has to
// stay valid 3-part semver. This is the same rule the release workflow uses to name the tag.
const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8');
const match = /^[ \t]+version:[ \t]*(\d+(?:\.\d+){2,3})[ \t]*$/m.exec(yml);
if (!match) fail('no extraMetadata.version in electron-builder.yml');
const version = match[1];

// The pin the client compares against its own. Written by scripts/download-electron.js and read by
// vite.main.config.ts from the same file, so the app and its manifest cannot disagree about the build.
let runtime;
try {
  runtime = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'electron', '.patched-build.json'), 'utf8')).runtime;
} catch {
  // Handled just below.
}
if (typeof runtime !== 'string' || runtime === '') {
  fail('no patched Electron stamp; clients would all fall back to the installer');
}

let appAsar;
try {
  appAsar = readFileSync(join(RESOURCES, 'app.asar'));
} catch {
  fail(`no app.asar in ${RESOURCES}; run electron-builder --win first`);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const asarName = `${PRODUCT}-${version}.asar`;
writeFileSync(join(OUT, asarName), appAsar);
const asar = {
  name: asarName,
  size: appAsar.length,
  sha512: createHash('sha512').update(appAsar).digest('base64'),
};

writeFileSync(join(OUT, 'lite.json'), `${JSON.stringify({ version, runtime, asar }, null, 1)}\n`);
console.log(`lite-release: ${version} on runtime ${runtime}`);
console.log(`  ${asar.name}  ${(asar.size / 1024 / 1024).toFixed(1)} MB`);
