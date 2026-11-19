import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build`        -> dist/ static site (index.html + hashed JS/CSS/JSON assets)
// `npm run build:single` -> dist-single/index.html with JS, CSS and data inlined (one file to share)
export default defineConfig(({ mode }) => ({
  base: './',
  publicDir: false,
  plugins: mode === 'single' ? [viteSingleFile()] : [],
  build: mode === 'single'
    ? { outDir: 'dist-single', assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 4000 }
    : { outDir: 'dist', chunkSizeWarningLimit: 1000 },
}));
