#!/usr/bin/env node
// Downloads Krunker's official map pictures and saves them under the names the Discord Art Assets need.
//
//   node scripts/make-discord-map-art.mjs [output-folder]      (default: ./discord-map-art)
//   DRY=1 node scripts/make-discord-map-art.mjs                (only lists what would be downloaded)
//
// The pictures come from assets.krunker.io (the same ones the matchmaker shows). Each file is named
// map_<name>.png, for example map_sandstorm.png. Upload them in the Discord Developer Portal under
// Rich Presence > Art Assets: the file name without ".png" becomes the asset key. See DISCORD-ART.md.
//
// Discord wants square pictures (1024x1024 recommended, 512x512 minimum). If the optional package "sharp"
// is installed (npm i --no-save sharp) every picture is cropped to a 1024x1024 square. Without it the
// original pictures are saved unchanged.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] || 'discord-map-art');
const dry = !!process.env.DRY;

// Same list the client uses; the position in the list is the picture number.
const src = await readFile(join(root, 'src', 'main', 'maps.ts'), 'utf-8');
const start = src.indexOf('OFFICIAL_MAPS');
const block = src.slice(start, src.indexOf('];', start));
const maps = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
if (maps.length < 10) { console.error('Could not read the map list from src/main/maps.ts'); process.exit(1); }

// Must match the key the client builds (src/preload/index.ts: slug)
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28);

let sharp = null;
try { sharp = (await import('sharp')).default; } catch { /* optional */ }

if (!dry) await mkdir(outDir, { recursive: true });
console.log(`${maps.length} maps -> ${outDir}${sharp ? ' (cropped to 1024x1024)' : ' (original size; install sharp to crop to squares)'}`);

let ok = 0, failed = 0;
for (let i = 0; i < maps.length; i++) {
  const key = 'map_' + slug(maps[i]);
  const url = `https://assets.krunker.io/img/maps/map_${i}.png`;
  if (dry) { console.log(`${key}.png  <-  ${url}   (${maps[i]})`); continue; }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let buf = Buffer.from(await res.arrayBuffer());
    if (sharp) buf = await sharp(buf).resize(1024, 1024, { fit: 'cover' }).png().toBuffer();
    await writeFile(join(outDir, key + '.png'), buf);
    ok++;
    console.log('saved', key + '.png');
  } catch (err) {
    failed++;
    console.warn(`skipped ${maps[i]} (${url}): ${err.message}`);
  }
}
if (!dry) console.log(`Done: ${ok} saved, ${failed} skipped.`);
