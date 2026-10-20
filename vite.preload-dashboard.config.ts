import { defineConfig } from 'vite';
import { resolve } from 'path';

const isProd = process.env.NODE_ENV === 'production' || !process.argv.includes('--mode');

// The dashboard preload shares code with the game preload (the settings panel). A sandboxed preload cannot load a
// second file, and building both together makes Vite put the shared code into a separate chunk, so this one is its
// own build with everything inlined. It must run after vite.preload.config.ts, which empties dist/preload first.
export default defineConfig({
  build: {
    lib: {
      entry: { dashboard: resolve(__dirname, 'src/preload/dashboard.ts') },
      formats: ['cjs'],
      fileName: (_format: string, name: string) => `${name}.js`,
    },
    outDir: 'dist/preload',
    emptyOutDir: false,
    rollupOptions: { external: ['electron'] },
    target: 'node20',
    minify: isProd,
    sourcemap: !isProd,
  },
});
