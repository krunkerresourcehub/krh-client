import { defineConfig } from 'vite';
import { resolve } from 'path';

const isProd = process.env.NODE_ENV === 'production' || !process.argv.includes('--mode');

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/preload/index.ts'),
        recorder: resolve(__dirname, 'src/preload/recorder.ts'),
        snip: resolve(__dirname, 'src/preload/snip.ts'),
      },
      formats: ['cjs'],
      fileName: (_format: string, name: string) => `${name}.js`,
    },
    outDir: 'dist/preload',
    emptyDirBefore: true,
    rollupOptions: {
      external: ['electron'],
    },
    target: 'node20',
    minify: isProd,
    sourcemap: !isProd,
  },
});
