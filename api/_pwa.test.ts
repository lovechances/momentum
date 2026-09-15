// The leading underscore keeps this build suite out of Vercel's /api route discovery.
import { readFile, stat } from 'node:fs/promises'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

type WorkerListener = (event: Record<string, unknown>) => void

const origin = 'https://momentum.example'
const keyFor = (input: string | { url: string }) => {
  const value = typeof input === 'string' ? input : input.url
  const url = new URL(value, origin)
  return `${url.pathname}${url.search}`
}

async function workerHarness() {
  const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8')
  const listeners = new Map<string, WorkerListener>()
  const cacheStores = new Map<string, Map<string, Response>>()
  const files = new Map<string, string>([
    ['/', '<!doctype html><script type="module" src="/assets/app-old.js"></script><link rel="stylesheet" href="/assets/app-old.css">'],
    ['/assets/app-old.js', 'old js'],
    ['/assets/app-old.css', 'old css'],
    ['/manifest.webmanifest', '{}'],
    ['/icon.svg', '<svg/>'],
    ['/icon-192.png', '192'],
    ['/icon-512.png', '512'],
    ['/apple-touch-icon.png', '180'],
  ])
  let offline = false

  const caches = {
    open: vi.fn(async (name: string) => {
      let entries = cacheStores.get(name)
      if (!entries) {
        entries = new Map()
        cacheStores.set(name, entries)
      }
      return {
        put: async (input: string | { url: string }, response: Response) => {
          entries!.set(keyFor(input), response.clone())
        },
        match: async (input: string | { url: string }) => entries!.get(keyFor(input))?.clone(),
        delete: async (input: string | { url: string }) => entries!.delete(keyFor(input)),
      }
    }),
    keys: async () => [...cacheStores.keys()],
    delete: async (name: string) => cacheStores.delete(name),
  }
  const fetch = vi.fn(async (input: string | { url: string }) => {
    if (offline) throw new TypeError('offline')
    const body = files.get(keyFor(input))
    return body === undefined
      ? new Response('missing', { status: 404 })
      : new Response(body, { status: 200, headers: { 'content-type': keyFor(input) === '/' ? 'text/html' : 'application/octet-stream' } })
  })
  const skipWaiting = vi.fn(async () => undefined)
  const claim = vi.fn(async () => undefined)
  const self = {
    location: { origin },
    clients: { claim },
    skipWaiting,
    addEventListener: (name: string, listener: WorkerListener) => listeners.set(name, listener),
  }

  vm.runInNewContext(source, {
    self,
    caches,
    fetch,
    URL,
    Response,
    Promise,
    Set,
    JSON,
    Error,
  })

  return {
    listeners,
    cacheStores,
    files,
    fetch,
    skipWaiting,
    claim,
    setOffline: (value: boolean) => { offline = value },
  }
}

function lifetimeEvent() {
  let lifetime: Promise<unknown> | undefined
  return {
    event: { waitUntil: (promise: Promise<unknown>) => { lifetime = promise } },
    done: async () => lifetime,
  }
}

function fetchEvent(request: Record<string, unknown>) {
  let response: Promise<Response> | undefined
  let lifetime: Promise<unknown> | undefined
  return {
    event: {
      request,
      respondWith: (promise: Promise<Response>) => { response = promise },
      waitUntil: (promise: Promise<unknown>) => { lifetime = promise },
    },
    response: async () => response,
    done: async () => lifetime,
    responded: () => response !== undefined,
  }
}

describe('production service worker', () => {
  it('keeps the Vercel AI function alive beyond its controlled upstream timeout', async () => {
    const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8')) as {
      framework?: string
      installCommand?: string
      buildCommand?: string
      outputDirectory?: string
      functions?: Record<string, { maxDuration?: number }>
    }
    expect(config).toMatchObject({
      framework: 'vite',
      installCommand: 'npm ci',
      buildCommand: 'npm run build',
      outputDirectory: 'dist',
      functions: { 'api/ai.ts': { maxDuration: 30 } },
    })
  })

  it('ships a valid standalone manifest and every declared local icon', async () => {
    const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8')) as {
      id?: string
      start_url?: string
      scope?: string
      display?: string
      icons?: Array<{ src?: string; sizes?: string; type?: string }>
    }
    expect(manifest).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone' })
    expect(manifest.icons?.length).toBeGreaterThanOrEqual(2)
    for (const icon of manifest.icons ?? []) {
      expect(icon.src).toMatch(/^\/[A-Za-z0-9._-]+$/)
      expect(icon.sizes).toBeTruthy()
      expect(icon.type).toMatch(/^image\//)
      expect((await stat(new URL(`../public${icon.src}`, import.meta.url))).size).toBeGreaterThan(0)
    }

    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
    expect(html).toContain('viewport-fit=cover')
    expect(html).toContain('apple-mobile-web-app-capable')
    expect(html).toContain('rel="apple-touch-icon"')
    expect(html).toContain('rel="manifest"')
  })

  it('pre-caches the built shell, serves it offline, and never handles the AI route', async () => {
    const harness = await workerHarness()
    const install = lifetimeEvent()
    harness.listeners.get('install')!(install.event)
    await install.done()

    expect(harness.skipWaiting).toHaveBeenCalledOnce()
    const shell = harness.cacheStores.get('momentum-shell-v4')!
    expect([...shell.keys()].sort()).toEqual([
      '/',
      '/__momentum_shell_assets__',
      '/apple-touch-icon.png',
      '/assets/app-old.css',
      '/assets/app-old.js',
      '/icon-192.png',
      '/icon-512.png',
      '/icon.svg',
      '/manifest.webmanifest',
    ])

    harness.setOffline(true)
    const navigation = fetchEvent({ method: 'GET', mode: 'navigate', url: `${origin}/`, headers: new Headers() })
    harness.listeners.get('fetch')!(navigation.event)
    expect(await (await navigation.response())!.text()).toContain('/assets/app-old.js')

    const api = fetchEvent({ method: 'GET', mode: 'cors', url: `${origin}/api/ai`, headers: new Headers() })
    harness.listeners.get('fetch')!(api.event)
    expect(api.responded()).toBe(false)
  })

  it('keeps the working shell when an update asset fails, then switches coherently', async () => {
    const harness = await workerHarness()
    const install = lifetimeEvent()
    harness.listeners.get('install')!(install.event)
    await install.done()

    harness.files.set('/', '<!doctype html><script type="module" src="/assets/app-new.js"></script>')
    const failedUpdate = fetchEvent({ method: 'GET', mode: 'navigate', url: `${origin}/`, headers: new Headers() })
    harness.listeners.get('fetch')!(failedUpdate.event)
    await failedUpdate.response()
    await failedUpdate.done()
    expect(await harness.cacheStores.get('momentum-shell-v4')!.get('/')!.clone().text()).toContain('app-old.js')

    harness.files.set('/assets/app-new.js', 'new js')
    const goodUpdate = fetchEvent({ method: 'GET', mode: 'navigate', url: `${origin}/`, headers: new Headers() })
    harness.listeners.get('fetch')!(goodUpdate.event)
    await goodUpdate.response()
    await goodUpdate.done()
    const shell = harness.cacheStores.get('momentum-shell-v4')!
    expect(await shell.get('/')!.clone().text()).toContain('app-new.js')
    expect(shell.has('/assets/app-new.js')).toBe(true)
    expect(shell.has('/assets/app-old.js')).toBe(false)
    expect(shell.has('/assets/app-old.css')).toBe(false)
  })

  it('removes only old Momentum shell caches when activated', async () => {
    const harness = await workerHarness()
    harness.cacheStores.set('momentum-shell-v3', new Map())
    harness.cacheStores.set('unrelated-cache', new Map())
    const activate = lifetimeEvent()
    harness.listeners.get('activate')!(activate.event)
    await activate.done()

    expect(harness.cacheStores.has('momentum-shell-v3')).toBe(false)
    expect(harness.cacheStores.has('unrelated-cache')).toBe(true)
    expect(harness.claim).toHaveBeenCalledOnce()
  })
})
