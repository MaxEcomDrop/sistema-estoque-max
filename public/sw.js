// Estoque Max — Service Worker v1
const CACHE = 'em-v1';
const SHELL = [
  '/login.html',
  '/dashboard.html',
  '/manifest.json',
];

// Instalar: pre-cache do app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// Ativar: limpar caches antigos
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first para APIs, cache-first para assets
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // APIs — sempre network
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'Offline' }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }
  // App shell — network first, fallback cache
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// Push notifications
self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  const title = data.title || 'Estoque Max';
  const body  = data.body  || 'Nova notificação do sistema';
  const icon  = data.icon  || '/icons/icon-192.png';
  const url   = data.url   || '/dashboard.html';
  e.waitUntil(
    self.registration.showNotification(title, {
      body, icon, badge: icon,
      data: { url },
      vibrate: [150, 50, 150],
      tag: data.tag || 'estoque-max',
      renotify: true,
    })
  );
});

// Clique na notificação — abre/foca o app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/dashboard.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const c of clients) {
        if (c.url.includes(self.location.origin) && 'focus' in c) {
          c.navigate(url); return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
