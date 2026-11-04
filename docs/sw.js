
const CACHE = "web-mb-1793762680180";
const FILES = ["/web_mb/","/web_mb/index.html","/web_mb/app-icon.svg","/web_mb/manifest.webmanifest","/web_mb/assets/index-DzWDwyck.css","/web_mb/assets/index-GP4TTbzT.js","/web_mb/assets/modbus.worker-DipA80Ko.js"];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('web-mb-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith("/web_mb/")) return;
  // Static same-origin assets are identical with or without the module Origin header.
  // Vite preview sends Vary: Origin; honouring it would miss precached module scripts offline.
  event.respondWith(caches.match(event.request, { ignoreVary: true }).then(cached => cached || fetch(event.request)));
});
