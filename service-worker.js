// service-worker.js
const CACHE_NAME = 'medienfachwirt-cache-v2'; // Version auf v2 erhöht, damit Browser den neuen Cache erkennen
const urlsToCache = [
    '/',
    '/index.html'
    // Wenn du später icon-192.png oder icon-512.png hinzufügst,
    // müsstest du sie auch hier eintragen:
    // '/icon-192.png',
    // '/icon-512.png'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Service Worker: Opened cache');
                return cache.addAll(urlsToCache);
            })
            .catch(error => {
                console.error('Service Worker: Failed to cache', error);
            })
    );
});

self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                // Cache Hit - return response
                if (response) {
                    console.log('Service Worker: Serving from cache:', event.request.url);
                    return response;
                }
                // Fallback to network if not in cache
                return fetch(event.request);
            })
            .catch(error => {
                console.error('Service Worker: Fetch failed:', event.request.url, error);
                // Optional: Fallback auf eine Offline-Seite, wenn Fetch fehlschlägt
                // return caches.match('/offline.html');
            })
    );
});

self.addEventListener('activate', event => {
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheWhitelist.indexOf(cacheName) === -1) {
                        console.log('Service Worker: Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});