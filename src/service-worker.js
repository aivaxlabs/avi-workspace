const ASSETS = __PRECACHE_ASSETS__;
const CACHE_NAME = __PRECACHE_NAME__;
const SCOPE = new URL(self.registration.scope);
const allowed = new Set(ASSETS.map((path) => new URL(path === 'index.html' ? './' : path, SCOPE).href));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll([...allowed])));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((name) => name.startsWith(`avi-shell:${SCOPE.pathname}:`) && name !== CACHE_NAME).map((name) => caches.delete(name)))));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== SCOPE.origin) return;
  const navigation = request.mode === 'navigate' && (url.pathname === SCOPE.pathname || url.pathname === `${SCOPE.pathname}index.html`);
  if (!navigation && !allowed.has(url.href)) return;
  const key = navigation ? SCOPE.href : url.href;
  event.respondWith(caches.open(CACHE_NAME).then(async (cache) => {
    const response = await cache.match(key) ?? await fetch(request);
    // Safari rejects redirected responses for navigation, even when served from Cache Storage.
    if (navigation && response.redirected) return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
    return response;
  }));
});
