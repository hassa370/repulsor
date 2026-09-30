import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'node:fs';
import path from 'node:path';

// public/models/source/ holds the raw downloads for `npm run assets`; never ship them in dist/.
const dropSourceModels = {
  name: 'drop-source-models',
  apply: 'build',
  closeBundle() {
    fs.rmSync(path.resolve('dist/models/source'), { recursive: true, force: true });
  },
};

// Relative base so dist/ works from any sub-path (GitHub Pages, Netlify, file server).
export default defineConfig({
  base: './',
  plugins: [basicSsl(), dropSourceModels],
  server: { host: true, https: true },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
  },
});
