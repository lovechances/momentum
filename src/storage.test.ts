import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialData } from './seed'
import {
  clearAll,
  createSnapshotWriteContext,
  currentSnapshotGeneration,
  readSnapshot,
  replaceDatabase,
  StaleSnapshotError,
  writeSnapshot,
  writeSnapshotAndMedia,
} from './storage'

const fixed = new Date(2026, 8, 14, 12)

function fakeIndexedDb(initialSnapshot = createInitialData(fixed), initialMedia: Array<[string, unknown]> = []) {
  const app = new Map<string, unknown>(initialSnapshot ? [['snapshot', initialSnapshot]] : [])
  const media = new Map<string, unknown>(initialMedia)
  const transactions: Array<{ stores: string | string[]; mode: string }> = []

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: vi.fn(),
    close: vi.fn(),
    onversionchange: undefined as (() => void) | undefined,
    transaction: (stores: string | string[], mode: string) => {
      transactions.push({ stores, mode })
      const staged: Array<() => void> = []
      let pending = 0
      let aborted = false
      let completionQueued = false
      const transaction = {
        error: undefined,
        oncomplete: undefined as (() => void) | undefined,
        onerror: undefined as (() => void) | undefined,
        onabort: undefined as (() => void) | undefined,
        abort: () => {
          if (aborted) return
          aborted = true
          queueMicrotask(() => transaction.onabort?.())
        },
        objectStore: (name: string) => {
          const values = name === 'app' ? app : media
          const request = <T,>(read: () => T) => {
            const result = { result: undefined as T, onsuccess: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined }
            pending += 1
            queueMicrotask(() => {
              if (aborted) return
              result.result = read()
              pending -= 1
              result.onsuccess?.()
              maybeComplete()
            })
            return result
          }
          return {
            get: (key: string) => request(() => values.get(key)),
            put: (value: unknown, key: string) => {
              staged.push(() => values.set(key, value))
              return { result: key }
            },
            delete: (key: string) => {
              staged.push(() => values.delete(key))
              return { result: undefined }
            },
            clear: () => {
              staged.push(() => values.clear())
              return { result: undefined }
            },
          }
        },
      }
      const maybeComplete = () => {
        if (aborted || pending > 0 || completionQueued) return
        completionQueued = true
        queueMicrotask(() => {
          completionQueued = false
          if (aborted || pending > 0) return
          staged.forEach(apply => apply())
          transaction.oncomplete?.()
        })
      }
      queueMicrotask(maybeComplete)
      return transaction
    },
  }
  const open = vi.fn(() => {
    const request = {
      result: db,
      error: undefined,
      onupgradeneeded: undefined as (() => void) | undefined,
      onsuccess: undefined as (() => void) | undefined,
      onerror: undefined as (() => void) | undefined,
      onblocked: undefined as (() => void) | undefined,
    }
    queueMicrotask(() => request.onsuccess?.())
    return request
  })
  vi.stubGlobal('indexedDB', { open })
  return { app, media, open, transactions }
}

describe('snapshot replacement write gate', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('invalidates pending debounced writes synchronously for clear and import', async () => {
    const open = vi.fn(() => { throw new Error('test database unavailable') })
    vi.stubGlobal('indexedDB', { open })
    const snapshot = createInitialData(fixed)

    const beforeClear = currentSnapshotGeneration()
    const clearing = clearAll(createSnapshotWriteContext()).catch(() => undefined)
    expect(currentSnapshotGeneration()).toBe(beforeClear + 1)
    await expect(writeSnapshot(snapshot, beforeClear, createSnapshotWriteContext())).resolves.toBeUndefined()
    await expect(writeSnapshotAndMedia(snapshot, {}, beforeClear, createSnapshotWriteContext())).resolves.toBeUndefined()
    await clearing

    const beforeImport = currentSnapshotGeneration()
    const replacing = replaceDatabase(snapshot, [], createSnapshotWriteContext()).catch(() => undefined)
    expect(currentSnapshotGeneration()).toBe(beforeImport + 1)
    await expect(writeSnapshot(snapshot, beforeImport, createSnapshotWriteContext())).resolves.toBeUndefined()
    await replacing

    expect(open).toHaveBeenCalledTimes(2)
  })

  it('lets the first context upgrade a legacy snapshot and commits media atomically', async () => {
    const legacy = createInitialData(fixed)
    const { app, media, transactions } = fakeIndexedDb(legacy, [['orphan', { id: 'orphan' }]])
    const context = createSnapshotWriteContext()
    await expect(readSnapshot(context)).resolves.toEqual(legacy)
    const snapshot = { ...legacy, onboarded: true, updatedAt: '2026-09-14T17:00:00.000Z' }
    const replacement = { id: 'replacement', blob: new Blob(['new']), mimeType: 'image/webp', bytes: 3, createdAt: fixed.toISOString() }

    await writeSnapshotAndMedia(snapshot, {
      put: [replacement, replacement],
      delete: ['replacement', 'orphan', 'orphan'],
    }, currentSnapshotGeneration(), context)

    expect(app.get('snapshot')).toEqual(snapshot)
    expect(app.get('snapshot-revision')).toEqual(expect.any(String))
    expect(media.get('replacement')).toEqual(replacement)
    expect(media.has('orphan')).toBe(false)
    expect(transactions.at(-1)).toEqual({ stores: ['app', 'media'], mode: 'readwrite' })
  })

  it('rejects a stale second context without changing its snapshot or media', async () => {
    const initial = createInitialData(fixed)
    const { app, media } = fakeIndexedDb(initial, [['existing', { id: 'existing' }]])
    const first = createSnapshotWriteContext()
    const stale = createSnapshotWriteContext()
    await readSnapshot(first)
    await readSnapshot(stale)
    const winner = { ...initial, onboarded: true, updatedAt: '2026-09-14T17:00:00.000Z' }
    const winnerMedia = { id: 'winner-media', blob: new Blob(['winner']), mimeType: 'image/jpeg', bytes: 6, createdAt: fixed.toISOString() }
    await writeSnapshotAndMedia(winner, { put: [winnerMedia] }, currentSnapshotGeneration(), first)

    const loser = { ...initial, updatedAt: '2026-09-14T18:00:00.000Z' }
    const loserMedia = { id: 'loser-media', blob: new Blob(['loser']), mimeType: 'image/jpeg', bytes: 5, createdAt: fixed.toISOString() }
    await expect(writeSnapshotAndMedia(
      loser,
      { put: [loserMedia], delete: ['existing'] },
      currentSnapshotGeneration(),
      stale,
    )).rejects.toBeInstanceOf(StaleSnapshotError)

    expect(app.get('snapshot')).toEqual(winner)
    expect(media.get('winner-media')).toEqual(winnerMedia)
    expect(media.has('loser-media')).toBe(false)
    expect(media.has('existing')).toBe(true)
  })

  it('rotates the revision on import and clear while keeping the initiating context writable', async () => {
    const initial = createInitialData(fixed)
    const { app, media } = fakeIndexedDb(initial)
    const owner = createSnapshotWriteContext()
    const staleBeforeImport = createSnapshotWriteContext()
    await readSnapshot(owner)
    await readSnapshot(staleBeforeImport)

    const imported = { ...initial, onboarded: true, updatedAt: '2026-09-14T17:00:00.000Z' }
    const importedMedia = { id: 'imported-media', blob: new Blob(['imported']), mimeType: 'image/jpeg', bytes: 8, createdAt: fixed.toISOString() }
    await replaceDatabase(imported, [importedMedia], owner)
    const importedRevision = app.get('snapshot-revision')
    expect(importedRevision).toEqual(expect.any(String))
    await expect(writeSnapshot(
      { ...initial, updatedAt: '2026-09-14T18:00:00.000Z' },
      currentSnapshotGeneration(),
      staleBeforeImport,
    )).rejects.toBeInstanceOf(StaleSnapshotError)

    const staleBeforeClear = createSnapshotWriteContext()
    await readSnapshot(staleBeforeClear)
    await clearAll(owner)
    expect(app.has('snapshot')).toBe(false)
    expect(app.get('snapshot-revision')).toEqual(expect.any(String))
    expect(app.get('snapshot-revision')).not.toBe(importedRevision)
    expect(media.size).toBe(0)
    await expect(writeSnapshot(
      { ...imported, updatedAt: '2026-09-14T19:00:00.000Z' },
      currentSnapshotGeneration(),
      staleBeforeClear,
    )).rejects.toBeInstanceOf(StaleSnapshotError)

    const reset = { ...createInitialData(fixed), updatedAt: '2026-09-14T20:00:00.000Z' }
    await expect(writeSnapshot(reset, currentSnapshotGeneration(), owner)).resolves.toBeUndefined()
    expect(app.get('snapshot')).toEqual(reset)
  })
})
