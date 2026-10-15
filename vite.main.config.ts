import { defineConfig } from 'vite';
import { resolve } from 'path';
import { builtinModules } from 'module';
import { readFileSync } from 'fs';

/**
 * The patched Electron build this app is being built against, from the stamp scripts/download-electron.js leaves
 * beside it. Baked into main so the updater can tell an update it can swap in without the installer from one that
 * brings a new Electron runtime (see src/shared/lite-update.ts). 'unknown' without a stamp: always the installer.
 */
function runtimePin(): string {
  try {
    const stamp = JSON.parse(readFileSync(resolve(__dirname, 'node_modules/electron/.patched-build.json'), 'utf8')) as { runtime?: unknown };
    return typeof stamp.runtime === 'string' && stamp.runtime !== '' ? stamp.runtime : 'unknown';
  } catch {
    return 'unknown';
  }
}

// Both 'fs' and 'node:fs' forms must be externalized
const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

const isProd = process.env.NODE_ENV === 'production' || !process.argv.includes('--mode');

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/main/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.js',
    },
    outDir: 'dist/main',
    emptyDirBefore: true,
    rollupOptions: {
      // original-fs is Electron's untouched fs (the lite update swaps app.asar with it); it only exists at runtime.
      external: ['electron', 'electron-store', 'original-fs', ...nodeBuiltins],
    },
    target: 'node20',
    minify: isProd,
    sourcemap: !isProd,
  },
  define: { __KRH_RUNTIME__: JSON.stringify(runtimePin()) },
  resolve: {
    // Treat this as a Node build — don't swap node builtins for browser stubs
    conditions: ['node'],
    mainFields: ['module', 'main'],
  },
});
