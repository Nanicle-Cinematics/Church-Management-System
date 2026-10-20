/* Service worker: shows device notifications sent by the app (lib/push.js)
   and opens the right page when one is tapped, and shows an offline page when
   a page cannot load. Registered on every page by public/pwa.js. Served at
   /sw.js.

   Church pages are never cached: they hold members' and finance records, and
   an installed app is often on a shared phone or office computer. Only the
   offline page, its icon and its one script are kept. */
const OFFLINE_CACHE = 'church-manager-offline-v2';
const OFFLINE_URL = '/static/offline.html';
const OFFLINE_ICON = '/static/icon-192.png';
const OFFLINE_SCRIPT = '/static/js/ui.js';
const OFFLINE_ASSETS = [OFFLINE_ICON, OFFLINE_SCRIPT];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE)
    .then((cache) => cache.addAll([OFFLINE_URL, ...OFFLINE_ASSETS]))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys
      .filter((k) => k.startsWith('church-manager-offline-') && k !== OFFLINE_CACHE)
      .map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Page loads (and the offline page's icon and script) only; everything else
// goes to the network untouched.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
  } else {
    const asset = OFFLINE_ASSETS.find((a) => new URL(req.url).pathname === a);
    if (asset) event.respondWith(fetch(req).catch(() => caches.match(asset)));
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Church Manager', {
    body: data.body || '',
    icon: '/static/icon-192.png',
    badge: '/static/icon-192.png',
    data: { url: data.url || '/' },
    tag: data.url || 'church-manager',
    renotify: true,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) if (w.url === url && 'focus' in w) return w.focus();
    return self.clients.openWindow(url);
  }));
});
