import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Relative base so dist/ works from any sub-path (GitHub Pages, Netlify, file server).
export default defineConfig({
  base: './',
  plugins: [basicSsl()],
  server: { host: true, https: true },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
  },
});
