// Estoque Max — Service Worker v3 + Firebase Messaging
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBN9e-vJfKk66ZW6BE9dgNDFQvbnbzM82I",
  authDomain: "erp-max-sistema.firebaseapp.com",
  projectId: "erp-max-sistema",
  storageBucket: "erp-max-sistema.firebasestorage.app",
  messagingSenderId: "1023327647246",
  appId: "1:1023327647246:web:7c35c5dd88d7aeef9dae5f",
});
const messaging = firebase.messaging();

// Notificações em background via FCM
messaging.onBackgroundMessage(payload => {
  const { title = 'Estoque Max', body = 'Nova notificação', url = '/dashboard.html', tag = 'em' } = payload.notification || payload.data || {};
  return self.registration.showNotification(title, {
    body, icon: '/favicon.ico', badge: '/favicon.ico',
    data: { url }, vibrate: [150, 50, 150], tag, renotify: true,
  });
});

// Cache
const CACHE = 'em-v3';
const SHELL = ['/login.html', '/dashboard.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => {
        // Notify all clients that a new version is available
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' }));
        });
      })
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // For API calls: network first, then cache
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(async () => {
        const cachedRes = await caches.match(e.request);
        if (cachedRes) return cachedRes;
        return new Response(JSON.stringify({ error: 'Offline — dados não disponíveis no cache', offline: true }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }
  // For app shell: network first, fallback to cache
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok && e.request.method === 'GET') {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});

// Clique na notificação
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
