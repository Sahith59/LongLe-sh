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

/**
 * Lock-screen alerts. The payload carries IDs only — the daemon enforces it — so the
 * words shown here are deliberately generic. The in-app inbox is the source of truth;
 * this is just the tap on the shoulder.
 */
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    // An unreadable payload still means "something needs you".
  }
  event.waitUntil(
    (async () => {
      // A test alert always shows — its entire purpose is to be seen.
      if (data.t === 'test') {
        await self.registration.showNotification('LongLeash', {
          body: 'Test alert — lock-screen alerts are working.',
          tag: 'longleash-test',
          data,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
        })
        return
      }
      // If the app is open and visible the inbox already shows it; don't double-tap.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      if (windows.some((w) => w.visibilityState === 'visible')) return
      await self.registration.showNotification('LongLeash', {
        // The kind, never the content: "a question" tells you what KIND of thirty
        // seconds this will be, without putting a word of the question on a lock screen.
        body: data.t === 'question' ? 'An agent has a question for you.' : 'A session needs you.',
        tag: data.approvalId || 'longleash-approval',
        data,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
      })
    })(),
  )
})

/**
 * Tapping an alert must land on the thing the alert was about.
 *
 * It used to focus any window, or open '/', which dropped you on the home screen to hunt for
 * the session that had just interrupted you. The payload has carried the session id all along.
 *
 * Two paths, because both really happen: the app may already be open (postMessage, so no
 * reload and no lost scroll position), or it may be cold (carry the id in the URL).
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data ?? {}
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : null

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // Preview/welcome pages may also be controlled clients. Pick the actual app shell;
      // focusing an arbitrary window is what made a notification appear to land on Home.
      const existing = windows.find((client) => {
        try {
          const url = new URL(client.url)
          return url.origin === self.location.origin && (url.pathname === '/' || url.pathname === '/index.html')
        } catch {
          return false
        }
      })
      if (existing) {
        if (sessionId !== null) {
          existing.postMessage({ type: 'longleash:open-session', sessionId })
        }
        return existing.focus()
      }
      // IDs only, exactly as the payload is — a session id names WHICH conversation, never
      // anything about it.
      return self.clients.openWindow(sessionId === null ? '/' : `/?session=${encodeURIComponent(sessionId)}`)
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
