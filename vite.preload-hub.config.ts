import { defineConfig } from 'vite';
import { resolve } from 'path';

const isProd = process.env.NODE_ENV === 'production' || !process.argv.includes('--mode');

// The preload of the KRH website window (hub-bridge). Its own single-file build, like the dashboard preload,
// because a sandboxed preload cannot load a second file. It must run after vite.preload.config.ts, which empties
// dist/preload first.
export default defineConfig({
  build: {
    lib: {
      entry: { 'hub-bridge': resolve(__dirname, 'src/preload/hub-bridge.ts') },
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
