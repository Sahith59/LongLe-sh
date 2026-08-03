/**
 * Keeps the installed app bootable when the daemon is unreachable — which is the entire
 * point of the relay: away from home, nothing can serve index.html, so the phone must
 * already have it. Network-first with cache fallback: updates flow whenever the laptop is
 * reachable, and the cached shell carries the app the rest of the time.
 */
const CACHE = 'longleash-shell-v2'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // A new worker owns the cache outright; stale shells from old versions are the
      // reason a phone can keep showing a design that no longer exists.
      for (const name of await caches.keys()) {
        if (name !== CACHE) await caches.delete(name)
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== location.origin) return
  // Liveness and pairing must never be answered from cache: a cached /health would make an
  // unreachable laptop look reachable, which is precisely the lie this app exists to avoid.
  if (url.pathname === '/health' || url.pathname === '/pair') return

  // Navigations bypass the HTTP cache entirely: the shell must always revalidate with
  // the server (cheap — it answers 304 unless the build changed).
  const network = request.mode === 'navigate' ? fetch(request, { cache: 'no-cache' }) : fetch(request)
  event.respondWith(
    network
      .then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put(request, copy))
        }
        return response
      })
      .catch(async () => {
        const cached = await caches.match(request)
        if (cached) return cached
        if (request.mode === 'navigate') {
          const shell = await caches.match('/index.html')
          if (shell) return shell
        }
        return Response.error()
      }),
  )
})
