import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialData } from './seed'
import { clearAll, currentSnapshotGeneration, replaceDatabase, writeSnapshot } from './storage'

const fixed = new Date(2026, 8, 14, 12)

describe('snapshot replacement write gate', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('invalidates pending debounced writes synchronously for clear and import', async () => {
    const open = vi.fn(() => { throw new Error('test database unavailable') })
    vi.stubGlobal('indexedDB', { open })
    const snapshot = createInitialData(fixed)

    const beforeClear = currentSnapshotGeneration()
    const clearing = clearAll().catch(() => undefined)
    expect(currentSnapshotGeneration()).toBe(beforeClear + 1)
    await expect(writeSnapshot(snapshot, beforeClear)).resolves.toBeUndefined()
    await clearing

    const beforeImport = currentSnapshotGeneration()
    const replacing = replaceDatabase(snapshot, []).catch(() => undefined)
    expect(currentSnapshotGeneration()).toBe(beforeImport + 1)
    await expect(writeSnapshot(snapshot, beforeImport)).resolves.toBeUndefined()
    await replacing

    // Only clear/import tried to open IndexedDB; both stale writes were skipped.
    expect(open).toHaveBeenCalledTimes(2)
  })
})
