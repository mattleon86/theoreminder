'use strict';

const CACHE_NAME = 'theoreminder-v6';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './boot.js',
  './shared/core.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-icon-512.png',
  './icons/apple-icon-180.png',
  './vendor/fullcalendar-6.1.11.index.global.min.js',
  './vendor/pdf-3.11.174.pdf.min.js',
  './vendor/pdf-3.11.174.pdf.worker.min.js'
];
const BASE_URL = new URL('./', self.location.href);
const STATIC_PATHS = new Set(ASSETS.map((asset) => new URL(asset, BASE_URL).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(ASSETS.map((asset) => cache.add(asset)));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('theoreminder-') && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !STATIC_PATHS.has(url.pathname)) return;

  // Rete prima; solo le risposte valide sostituiscono la copia offline.
  event.respondWith(fetch(event.request)
    .then(async (response) => {
      if (response.ok) {
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(event.request, response.clone());
        } catch (e) {
          // Cache piena o non disponibile: la risposta di rete resta utilizzabile.
        }
      }
      return response;
    })
    .catch(async () => {
      const fallback = event.request.mode === 'navigate'
        ? await caches.match(new URL('./index.html', BASE_URL).href)
        : await caches.match(event.request);
      return fallback || Response.error();
    }));
});

function notificationTarget(event) {
  const data = event.notification.data;
  const eventId = (data && typeof data === 'object' && (data.eventId || data.event_id || data.id))
    || (typeof data === 'string' && data)
    || (event.action && event.action !== 'open' && event.action !== 'dismiss' ? event.action : '');
  const target = new URL('./index.html', self.location.href);
  if (eventId) target.hash = `event=${encodeURIComponent(String(eventId))}`;
  return target.href;
}

// Click su una notifica: apre l'evento indicato dai dati o dall'azione.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = notificationTarget(event);
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.length > 0) {
      try {
        const redirected = typeof clients[0].navigate === 'function'
          ? await clients[0].navigate(target)
          : null;
        if (redirected) return redirected.focus();
      } catch (e) {
        // Se la scheda non è più navigabile, prova a aprire una nuova finestra.
      }
    }
    return self.clients.openWindow(target);
  })());
});

// Notifica Web Push ricevuta anche ad app chiusa.
self.addEventListener('push', (event) => {
  let data = { title: 'Promemoria incarico', body: '' };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (e) {
    // Payload non JSON: usa i valori predefiniti.
  }
  const options = {
    body: data.body,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: data.data || data
  };
  if (Array.isArray(data.actions)) options.actions = data.actions;
  event.waitUntil(self.registration.showNotification(data.title, options));
});

// Rinnovo automatico della sottoscrizione push con la stessa chiave pubblica.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const options = (event.oldSubscription && event.oldSubscription.options)
        || { userVisibleOnly: true, applicationServerKey: event.applicationServerKey };
      const newSub = await self.registration.pushManager.subscribe(options);
      const clientsList = await self.clients.matchAll({ type: 'window' });
      clientsList.forEach((client) => client.postMessage({
        type: 'push-resubscribed',
        subscription: newSub.toJSON()
      }));
    } catch (e) {
      // L'utente può riattivare le notifiche dall'app se il rinnovo fallisce.
    }
  })());
});
