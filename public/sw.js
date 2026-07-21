// Estoque Max — Service Worker v6 — Cache Busting Forçado
// TIMESTAMP: 1719804000000
const SW_VERSION = 'estoquemax-v10';
// Precache apenas o manifest (HTML será servido sempre da rede)
const PRECACHE = ['/manifest.json'];

// Install: limpa TUDO e precacheia apenas o essencial
self.addEventListener('install', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
    .then(() => caches.open(SW_VERSION).then(c => c.addAll(PRECACHE)))
    .then(() => self.skipWaiting())
  );
});

// Activate: elimina qualquer cache antigo e toma controle imediato
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SW_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => {
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => client.postMessage({ type: 'SW_UPDATED', version: SW_VERSION }));
        });
      })
  );
});

// Fetch: NETWORK FIRST para tudo. Cache é apenas fallback offline.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API calls: sempre rede, nunca cache
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'Offline — verifique sua conexão' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // HTML pages: SEMPRE buscar da rede. Nunca servir do cache.
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  // Outros assets (JS, CSS, fontes): network first, cache fallback
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok && e.request.method === 'GET') {
        const clone = res.clone();
        caches.open(SW_VERSION).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});

// Click em notificação
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/dashboard.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const c of clients) {
        if (c.url.includes(self.location.origin) && 'focus' in c) {
          c.navigate(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
