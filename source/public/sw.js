/**
 * ANIME STUDIO — Service Worker (PWA)
 *
 * Strategy:
 *  - Static assets (/_next/static, icons, fonts): cache-first.
 *  - Navigations: network-first with cache fallback + offline shell.
 *  - API calls (/api/*): network only, never cached (they are live data).
 *
 * Base-path aware: works at a domain root AND on GitHub Pages sub-paths
 * (https://user.github.io/repo/) because everything is derived from the
 * registration scope. Bump CACHE_VERSION to invalidate everything.
 */
const CACHE_VERSION = 'as-v20'
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '')

const SHELL = [
  `${BASE}/`,
  `${BASE}/manifest.webmanifest`,
  `${BASE}/icons/icon-192.png`,
  `${BASE}/icons/icon-512.png`,
]

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET') return
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith(`${BASE}/api/`)) return

  // path inside this deployment, e.g. "" or "/anime-studio"
  const rel = BASE && url.pathname.startsWith(BASE) ? url.pathname.slice(BASE.length) : url.pathname

  // cache-first for immutable build assets + icons
  if (rel.startsWith('/_next/static') || rel.startsWith('/icons/') || /\.(png|jpg|jpeg|svg|woff2?|webmanifest)$/.test(rel)) {
    event.respondWith(
      caches.match(event.request).then(hit => hit || fetch(event.request).then(res => {
        const copy = res.clone()
        caches.open(CACHE_VERSION).then(c => c.put(event.request, copy))
        return res
      }))
    )
    return
  }

  // navigations: network-first, fall back to cached shell (offline start)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(res => {
        const copy = res.clone()
        caches.open(CACHE_VERSION).then(c => c.put(event.request, copy))
        return res
      }).catch(() => caches.match(event.request).then(hit => hit || caches.match(`${BASE}/`)))
    )
  }
})
