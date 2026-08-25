// Service Worker minimale: cache statica per uso offline + supporto notifiche (locali e Web Push).
const CACHE_NAME = 'theoreminder-v5';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Solo file locali dell'app: le richieste ai CDN (pdf.js, FullCalendar) passano dritte alla rete.
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Rete prima, con la cache solo come riserva per l'uso offline: così l'app aggiornata
  // (nuovo app.js/index.html/style.css) arriva sempre subito quando c'è connessione, invece
  // di restare bloccata sulla prima versione mai scaricata (come succedeva con "cache-first").
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Click su una notifica: apre/porta in primo piano l'app.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      if (clients.length > 0) {
        clients[0].focus();
      } else {
        self.clients.openWindow('./index.html');
      }
    })
  );
});

// Notifica Web Push "vera" ricevuta dal server (api/send-reminders.js), anche ad app chiusa:
// mostra la notifica con titolo/testo presi dal payload JSON inviato dal server.
self.addEventListener('push', (event) => {
  let data = { title: 'Promemoria incarico', body: '' };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (e) {
    // payload non-JSON o mancante: usa i valori di default sopra
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png'
    })
  );
});

// Il browser può invalidare/rinnovare la sottoscrizione push da solo (es. scaduta): qui la
// ricreiamo con la stessa chiave pubblica e la giriamo alla pagina, che la reinvia al server.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const options = (event.oldSubscription && event.oldSubscription.options)
          || { userVisibleOnly: true, applicationServerKey: event.applicationServerKey };
        const newSub = await self.registration.pushManager.subscribe(options);
        const clientsList = await self.clients.matchAll({ type: 'window' });
        clientsList.forEach((c) => c.postMessage({ type: 'push-resubscribed', subscription: newSub.toJSON() }));
      } catch (e) {
        // se fallisce non c'è molto da fare qui: l'utente dovrà riattivare le notifiche dall'app
      }
    })()
  );
});
