import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build`        -> dist/ static site (index.html + hashed JS/CSS/JSON assets)
// `npm run build:single` -> dist-single/index.html with JS, CSS and data inlined (one file to share)
// `vite build --mode artifact` -> dist-artifact/: one page with JS/CSS inlined + assets/district-*.json (claude.ai Artifact)
export default defineConfig(({ mode }) => ({
  base: './',
  publicDir: false,
  plugins: mode === 'single' || mode === 'artifact' ? [viteSingleFile()] : [],
  build: mode === 'single'
    ? { outDir: 'dist-single', assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 4000 }
    : mode === 'artifact' // JS/CSS inlined, map data kept as a separate file fetched by relative URL
      ? { outDir: 'dist-artifact', assetsInlineLimit: 0, chunkSizeWarningLimit: 4000 }
      : { outDir: 'dist', chunkSizeWarningLimit: 2000, rollupOptions: { input: { main: 'index.html', explore: 'explore.html' } } },
}));
