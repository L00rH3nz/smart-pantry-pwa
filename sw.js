/* ==========================================================================
 * Smart Pantry — Service Worker (PWA offline-first)
 *
 * Strategia:
 *  - App shell (HTML, manifest, icone): precache in install (cache-first).
 *  - Script CDN (Tailwind / Dexie / Lucide / ZXing / Tesseract): precache
 *    best-effort in install + stale-while-revalidate a runtime, così l'app
 *    resta usabile offline dopo la prima visita online.
 *    (Il worker/wasm Tesseract e i dati lingua "ita" si caricano al primo OCR
 *    e vengono cachati dal runtime SW per gli usi successivi.)
 *  - Navigazioni: network-first con fallback alla index.html cachata.
 *  - API Open Food Facts: sempre network-only (dati freschi, serve rete).
 *
 * NOTA: i dati utente sono già offline-by-design (IndexedDB via Dexie.js);
 * il SW copre invece le risorse statiche di rete.
 * ========================================================================== */
'use strict';

const CACHE_VERSION = 'smart-pantry-v3';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

/** Risorse same-origin garantite dal deploy (percorsi relativi allo scope). */
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

/** CDN pinnati (devono corrispondere agli <script src> in index.html). */
const CDN_CORE = [
  'https://cdn.tailwindcss.com/',
  'https://cdn.jsdelivr.net/npm/dexie@4.0.8/dist/dexie.min.js',
  'https://cdn.jsdelivr.net/npm/lucide@0.469.0/dist/umd/lucide.min.js',
  'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
];

/** Origini servite con strategia stale-while-revalidate. */
const RUNTIME_ORIGINS = ['cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'unpkg.com', 'tessdata.projectnaptha.com'];

/* ---------------- Install: precache app shell + CDN (best-effort) -------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const staticCache = await caches.open(STATIC_CACHE);
      // 1) App shell: deve riuscire, altrimenti l'install fallisce.
      await staticCache.addAll(APP_SHELL);

      // 2) CDN: best-effort (una CDN irraggiungibile non deve bloccare l'install).
      const runtimeCache = await caches.open(RUNTIME_CACHE);
      await Promise.allSettled(
        CDN_CORE.map(async (url) => {
          try {
            // cache.add richiede CORS; fallback a no-cors (risposta opaca, comunque valida offline).
            await runtimeCache.add(url);
          } catch {
            const res = await fetch(url, { mode: 'no-cors' });
            if (res) await runtimeCache.put(url, res);
          }
        }),
      );

      await self.skipWaiting();
    })(),
  );
});

/* ---------------- Activate: pulizia vecchie cache + controllo immediato --- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([STATIC_CACHE, RUNTIME_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/* ---------------- Fetch --------------------------------------------------- */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Navigazioni (apertura / refresh / start_url): network-first → fallback offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  // App shell same-origin + CDN: stale-while-revalidate.
  const isSameOrigin = url.origin === self.location.origin;
  const isRuntimeCDN = RUNTIME_ORIGINS.includes(url.hostname);
  if (isSameOrigin || isRuntimeCDN) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  // Qualsiasi altra origine: lascio passare la richiesta al network.
});

/** Restituisce subito la copia cachata (se c'è) e aggiorna la cache in background. */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request, { ignoreSearch: request.url.includes('cdn.tailwindcss.com') });

  const networkUpdate = fetch(request)
    .then((res) => {
      // Cachiamo solo risposte valide oppure opache (no-cors).
      if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
      return res;
    })
    .catch(() => cached); // offline e nessuna copia → undefined (gestito sotto)

  // Se abbiamo una copia, rispondi subito; altrimenti attendi la rete.
  return cached || networkUpdate.then((res) => res || cache.match('./index.html'));
}
