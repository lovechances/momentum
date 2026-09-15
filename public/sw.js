const CACHE_PREFIX = 'momentum-shell-'
// Increment this when the worker's cache contract changes so installation is
// staged separately from the cache used by the currently active worker.
const CACHE = `${CACHE_PREFIX}v4`
const SHELL_ASSET_MANIFEST = '/__momentum_shell_assets__'
const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
]

function builtAssets(html) {
  return [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(match => new URL(match[1], self.location.origin))
    .filter(url => url.origin === self.location.origin && url.pathname.startsWith('/assets/'))
    .map(url => url.pathname)
}

async function cacheShell(response, includeStaticFiles = false) {
  const cache = await caches.open(CACHE)
  if (!response.ok) throw new Error('App shell could not be fetched.')
  const html = await response.clone().text()
  const currentShell = includeStaticFiles ? undefined : await cache.match('/')
  if (currentShell && await currentShell.text() === html) return
  const assets = [...new Set(builtAssets(html))]
  if (assets.length === 0) throw new Error('Built app-shell assets were not found.')
  const required = [...new Set([
    ...assets,
    ...(includeStaticFiles ? APP_SHELL.filter(path => path !== '/') : []),
  ])]
  const fetched = await Promise.all(required.map(async path => {
    const asset = await fetch(path, { cache: 'reload' })
    if (!asset.ok) throw new Error(`Required app-shell asset could not be fetched: ${path}`)
    return [path, asset]
  }))

  let previousAssets = []
  try {
    const previous = await cache.match(SHELL_ASSET_MANIFEST)
    const parsed = previous ? await previous.json() : []
    if (Array.isArray(parsed)) previousAssets = parsed.filter(path => typeof path === 'string')
  } catch {
    // A bad internal cache marker must not prevent a fresh shell from installing.
  }

  // All required responses have been fetched before the entry point changes.
  // This prevents an interrupted update from leaving cached HTML that points to
  // assets which were never cached.
  for (const [path, asset] of fetched) await cache.put(path, asset)
  await cache.put('/', response)
  await cache.put(SHELL_ASSET_MANIFEST, new Response(JSON.stringify(assets), {
    headers: { 'content-type': 'application/json' },
  }))

  const activeAssets = new Set(assets)
  await Promise.all(previousAssets
    .filter(path => !activeAssets.has(path))
    .map(path => cache.delete(path)))
}

async function cacheBuiltShell() {
  const response = await fetch('/', { cache: 'reload' })
  await cacheShell(response, true)
}

self.addEventListener('install', event => {
  event.waitUntil(cacheBuiltShell().then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE)
            .map(key => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)

  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  ) {
    return
  }

  if (request.mode === 'navigate') {
    const navigation = fetch(request)
    event.waitUntil(
      navigation
        .then(response => response.ok ? cacheShell(response.clone()) : undefined)
        .catch(() => undefined),
    )
    event.respondWith(
      navigation
        .catch(async () => {
          const cache = await caches.open(CACHE)
          const cached = await cache.match('/')
          return (
            cached ||
            new Response('Momentum is unavailable offline until it has been opened once.', {
              status: 503,
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            })
          )
        }),
    )
    return
  }

  if (request.headers.has('range')) return

  const cachedState = caches.open(CACHE).then(async cache => ({
    cache,
    cached: await cache.match(request),
  }))
  const refresh = cachedState.then(async ({ cache, cached }) => {
    if (cached && url.pathname.startsWith('/assets/')) return undefined
    const response = await fetch(request)
    if (response.ok && response.type === 'basic') {
      await cache.put(request, response.clone())
    }
    return response
  })
  event.waitUntil(refresh.then(() => undefined).catch(() => undefined))
  event.respondWith(
    cachedState.then(async ({ cached }) => {
      if (cached) return cached
      const response = await refresh
      if (response) return response
      throw new Error('Resource is unavailable offline.')
    }),
  )
})
