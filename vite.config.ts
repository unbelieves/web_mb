import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';

const base = process.env.VITE_BASE_PATH || '/web_mb/';

function offlineCache(): Plugin {
  return {
    name: 'modbus-offline-cache',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = [...new Set(['', 'index.html', 'app-icon.svg', 'manifest.webmanifest', ...Object.keys(bundle)])]
        .filter((file) => !file.endsWith('.map'))
        .map((file) => `${base}${file}`);
      const cache = `web-mb-${Date.now()}`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: `
const CACHE = ${JSON.stringify(cache)};
const FILES = ${JSON.stringify(files)};
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('web-mb-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(${JSON.stringify(base)})) return;
  // Static same-origin assets are identical with or without the module Origin header.
  // Vite preview sends Vary: Origin; honouring it would miss precached module scripts offline.
  event.respondWith(caches.match(event.request, { ignoreVary: true }).then(cached => cached || fetch(event.request)));
});
` });
      this.emitFile({ type: 'asset', fileName: '.nojekyll', source: '' });
    },
  };
}

export default defineConfig({
  base,
  plugins: [vue(), offlineCache()],
  build: { outDir: 'docs', emptyOutDir: true, target: 'es2022' },
  worker: { format: 'es' },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
