// ============================================
//  COACH SYSTEM — Aguila Corp
//  Service Worker v1.0
// ============================================

const CACHE_NAME = 'aguila-corp-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/icon-192.png',
  '/icon-512.png'
];

// Instalar y cachear assets principales
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Limpiar caches viejos
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Estrategia: Network first, cache como fallback
self.addEventListener('fetch', e => {
  // Solo interceptar peticiones GET
  if (e.request.method !== 'GET') return;

  // Las llamadas a la API siempre van a la red
  if (e.request.url.includes('/api/')) {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ ok: false, msg: 'Sin conexión' }), { headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // Para el resto: red primero, cache si falla
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
