// Estoque Max — Service Worker v2 + Firebase Messaging
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
const CACHE = 'em-v2';
const SHELL = ['/login.html', '/dashboard.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).catch(() =>
      new Response(JSON.stringify({ error: 'Offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
    ));
    return;
  }
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok && e.request.method === 'GET') {
        caches.open(CACHE).then(c => c.put(e.request, res.clone()));
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
        if (c.url.includes(self.location.origin) && 'focus' in c) { c.navigate(url); return c.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});
