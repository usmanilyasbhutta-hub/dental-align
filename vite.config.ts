import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

const BUILD = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

// Stamp the service-worker cache version so each deployment refreshes the offline cache.
function stampSw(): Plugin {
  return {
    name: 'stamp-sw',
    apply: 'build',
    closeBundle() {
      const p = path.resolve(import.meta.dirname, 'dist/sw.js');
      if (fs.existsSync(p)) fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('__BUILD__', BUILD));
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), stampSw()],
  define: { __BUILD__: JSON.stringify(BUILD) },
  server: { host: true },
});
