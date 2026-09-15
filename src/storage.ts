import type { AppData, MediaRecord } from './domain'

const DB_NAME = 'momentum'
const APP_STORE = 'app'
const MEDIA_STORE = 'media'
const KEY = 'snapshot'
const REVISION_KEY = 'snapshot-revision'

export interface SnapshotWriteContext {
  initialized: boolean
  revision?: string
  snapshotUpdatedAt?: string
}

export const createSnapshotWriteContext = (): SnapshotWriteContext => ({ initialized: false })

const defaultSnapshotContext = createSnapshotWriteContext()

export class StaleSnapshotError extends Error {
  constructor() {
    super('Momentum changed in another tab. Reload this page before saving more changes.')
    this.name = 'StaleSnapshotError'
  }
}

function revisionToken() {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function storedRevision(value: unknown) {
  return typeof value === 'string' && value ? value : undefined
}

function storedUpdatedAt(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const updatedAt = (value as { updatedAt?: unknown }).updatedAt
  return typeof updatedAt === 'string' ? updatedAt : undefined
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, 2)
    } catch (error) {
      reject(error)
      return
    }
    const timeout = globalThis.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('Local database took too long to open.'))
    }, 5_000)
    const complete = () => globalThis.clearTimeout(timeout)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(APP_STORE)) db.createObjectStore(APP_STORE)
      if (!db.objectStoreNames.contains(MEDIA_STORE)) db.createObjectStore(MEDIA_STORE)
    }
    request.onsuccess = () => {
      const db = request.result
      if (settled) {
        db.close()
        return
      }
      settled = true
      complete()
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => {
      if (settled) return
      settled = true
      complete()
      reject(request.error || new Error('Local database could not be opened.'))
    }
    request.onblocked = () => {
      if (settled) return
      settled = true
      complete()
      reject(new Error('Local database upgrade is blocked by another Momentum window.'))
    }
  })
}

async function store<T>(name: string, mode: IDBTransactionMode, action: (objectStore: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    let result: T
    let transaction: IDBTransaction | undefined
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      db.close()
      callback()
    }
    try {
      const activeTransaction = db.transaction(name, mode)
      transaction = activeTransaction
      const request = action(activeTransaction.objectStore(name))
      request.onsuccess = () => { result = request.result }
      activeTransaction.oncomplete = () => finish(() => resolve(result))
      activeTransaction.onerror = () => finish(() => reject(activeTransaction.error || request.error || new Error('Local database operation failed.')))
      activeTransaction.onabort = () => finish(() => reject(activeTransaction.error || new Error('Local database operation was canceled.')))
    } catch (error) {
      try { transaction?.abort() } catch { /* The transaction may already be inactive. */ }
      finish(() => reject(error))
    }
  })
}

let mutationQueue: Promise<void> = Promise.resolve()
let snapshotGeneration = 0

function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation)
  mutationQueue = result.then(() => undefined, () => undefined)
  return result
}

function afterMutations<T>(operation: () => Promise<T>): Promise<T> {
  return mutationQueue.then(operation)
}

function readSnapshotState(context: SnapshotWriteContext): Promise<AppData | undefined> {
  return openDatabase().then(db => new Promise((resolve, reject) => {
    let transaction: IDBTransaction | undefined
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      db.close()
      callback()
    }
    try {
      transaction = db.transaction(APP_STORE, 'readonly')
      const app = transaction.objectStore(APP_STORE)
      const snapshotRequest = app.get(KEY)
      const revisionRequest = app.get(REVISION_KEY)
      transaction.oncomplete = () => finish(() => {
        const snapshot = snapshotRequest.result as AppData | undefined
        context.initialized = true
        context.revision = storedRevision(revisionRequest.result)
        context.snapshotUpdatedAt = storedUpdatedAt(snapshot)
        resolve(snapshot)
      })
      transaction.onerror = () => finish(() => reject(transaction?.error || snapshotRequest.error || revisionRequest.error || new Error('Local snapshot could not be read.')))
      transaction.onabort = () => finish(() => reject(transaction?.error || new Error('Local snapshot reading was canceled.')))
    } catch (error) {
      try { transaction?.abort() } catch { /* The transaction may already be inactive. */ }
      finish(() => reject(error))
    }
  }))
}

export const readSnapshot = (context = defaultSnapshotContext) => afterMutations(() => readSnapshotState(context))
export const currentSnapshotGeneration = () => snapshotGeneration

function commitSnapshot(
  snapshot: AppData,
  changes: { put?: MediaRecord[]; delete?: string[] },
  context: SnapshotWriteContext,
  includeMedia: boolean,
) {
  return openDatabase().then(db => new Promise<void>((resolve, reject) => {
    let transaction: IDBTransaction | undefined
    let settled = false
    let stale = false
    const nextRevision = revisionToken()
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      db.close()
      callback()
    }
    try {
      const recordsToPut = new Map((changes.put ?? []).map(record => [record.id, record]))
      const idsToDelete = new Set((changes.delete ?? []).filter(id => !recordsToPut.has(id)))
      transaction = db.transaction(includeMedia ? [APP_STORE, MEDIA_STORE] : APP_STORE, 'readwrite')
      const activeTransaction = transaction
      const app = activeTransaction.objectStore(APP_STORE)
      const revisionRequest = app.get(REVISION_KEY)
      const snapshotRequest = app.get(KEY)
      let revisionReady = false
      let snapshotReady = false
      let commitStarted = false
      const commitIfCurrent = () => {
        if (!revisionReady || !snapshotReady || commitStarted) return
        commitStarted = true
        const currentSnapshot = snapshotRequest.result as AppData | undefined
        const currentRevision = storedRevision(revisionRequest.result)
        const currentUpdatedAt = storedUpdatedAt(currentSnapshot)
        const unchanged = context.initialized
          ? currentRevision === context.revision && currentUpdatedAt === context.snapshotUpdatedAt
          : currentRevision === undefined && currentSnapshot === undefined
        if (!unchanged) {
          stale = true
          activeTransaction.abort()
          return
        }
        app.put(snapshot, KEY)
        app.put(nextRevision, REVISION_KEY)
        if (includeMedia) {
          const mediaStore = activeTransaction.objectStore(MEDIA_STORE)
          for (const record of recordsToPut.values()) mediaStore.put(record, record.id)
          for (const id of idsToDelete) mediaStore.delete(id)
        }
      }
      revisionRequest.onsuccess = () => { revisionReady = true; commitIfCurrent() }
      snapshotRequest.onsuccess = () => { snapshotReady = true; commitIfCurrent() }
      activeTransaction.oncomplete = () => finish(() => {
        context.initialized = true
        context.revision = nextRevision
        context.snapshotUpdatedAt = snapshot.updatedAt
        resolve()
      })
      activeTransaction.onerror = () => finish(() => reject(stale ? new StaleSnapshotError() : activeTransaction.error || new Error('Local changes could not be saved.')))
      activeTransaction.onabort = () => finish(() => reject(stale ? new StaleSnapshotError() : activeTransaction.error || new Error('Local changes saving was canceled.')))
    } catch (error) {
      try { transaction?.abort() } catch { /* The transaction may already be inactive. */ }
      finish(() => reject(error))
    }
  }))
}

export const writeSnapshot = (snapshot: AppData, generation = snapshotGeneration, context = defaultSnapshotContext) => {
  if (generation !== snapshotGeneration) return Promise.resolve()
  return mutate(async () => {
    // A clear/import may have started while this write was waiting behind an
    // earlier IndexedDB mutation. Never let the stale snapshot run afterward.
    if (generation !== snapshotGeneration) return
    await commitSnapshot(snapshot, {}, context, false)
  })
}
export const putMedia = (media: MediaRecord) => mutate(() => store<IDBValidKey>(MEDIA_STORE, 'readwrite', objectStore => objectStore.put(media, media.id)))
export const getMedia = (id: string) => afterMutations(() => store<MediaRecord | undefined>(MEDIA_STORE, 'readonly', objectStore => objectStore.get(id)))
export const deleteMedia = (id: string) => mutate(() => store<undefined>(MEDIA_STORE, 'readwrite', objectStore => objectStore.delete(id)))
export const allMedia = () => afterMutations(() => store<MediaRecord[]>(MEDIA_STORE, 'readonly', objectStore => objectStore.getAll()))

/** Commit a snapshot and its media changes together; callers can safely retry with the same IDs. */
export const writeSnapshotAndMedia = (
  snapshot: AppData,
  changes: { put?: MediaRecord[]; delete?: string[] } = {},
  generation = snapshotGeneration,
  context = defaultSnapshotContext,
) => {
  if (generation !== snapshotGeneration) return Promise.resolve()
  return mutate(async () => {
    if (generation !== snapshotGeneration) return
    await commitSnapshot(snapshot, changes, context, true)
  })
}

/** Sum media metadata one record at a time instead of retaining every Blob. */
export const mediaBytes = () => afterMutations(async () => {
  const db = await openDatabase()
  return new Promise<number>((resolve, reject) => {
    let total = 0
    let transaction: IDBTransaction | undefined
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      db.close()
      callback()
    }
    try {
      transaction = db.transaction(MEDIA_STORE, 'readonly')
      const request = transaction.objectStore(MEDIA_STORE).openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        const bytes = (cursor.value as Partial<MediaRecord>).bytes
        if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0) total += bytes
        cursor.continue()
      }
      transaction.oncomplete = () => finish(() => resolve(total))
      transaction.onerror = () => finish(() => reject(transaction?.error || request.error || new Error('Media storage could not be measured.')))
      transaction.onabort = () => finish(() => reject(transaction?.error || new Error('Media storage measurement was canceled.')))
    } catch (error) {
      try { transaction?.abort() } catch { /* The transaction may already be inactive. */ }
      finish(() => reject(error))
    }
  })
})

export async function clearAll(context = defaultSnapshotContext) {
  // Invalidate already-scheduled hook writes synchronously, before this
  // destructive transaction is queued or yields to the event loop.
  snapshotGeneration += 1
  return mutate(async () => {
    const db = await openDatabase()
    return new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction | undefined
      let settled = false
      const nextRevision = revisionToken()
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        db.close()
        callback()
      }
      try {
        transaction = db.transaction([APP_STORE, MEDIA_STORE], 'readwrite')
        transaction.oncomplete = () => finish(() => {
          context.initialized = true
          context.revision = nextRevision
          context.snapshotUpdatedAt = undefined
          resolve()
        })
        transaction.onerror = () => finish(() => reject(transaction?.error || new Error('Local data could not be cleared.')))
        transaction.onabort = () => finish(() => reject(transaction?.error || new Error('Local data clearing was canceled.')))
        const app = transaction.objectStore(APP_STORE)
        app.clear()
        app.put(nextRevision, REVISION_KEY)
        transaction.objectStore(MEDIA_STORE).clear()
      } catch (error) {
        try { transaction?.abort() } catch { /* The transaction may already be inactive. */ }
        finish(() => reject(error))
      }
    })
  })
}

/** Replace app data and media in one transaction so a failed import preserves the old database. */
export async function replaceDatabase(snapshot: AppData, media: MediaRecord[], context = defaultSnapshotContext) {
  // Imported data must not be overwritten by a debounce carrying the previous
  // in-memory snapshot.
  snapshotGeneration += 1
  return mutate(async () => {
    const db = await openDatabase()
    return new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction | undefined
      let settled = false
      const nextRevision = revisionToken()
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        db.close()
        callback()
      }
      try {
        transaction = db.transaction([APP_STORE, MEDIA_STORE], 'readwrite')
        transaction.oncomplete = () => finish(() => {
          context.initialized = true
          context.revision = nextRevision
          context.snapshotUpdatedAt = snapshot.updatedAt
          resolve()
        })
        transaction.onerror = () => finish(() => reject(transaction?.error || new Error('Backup restore failed.')))
        transaction.onabort = () => finish(() => reject(transaction?.error || new Error('Backup restore was canceled.')))
        const app = transaction.objectStore(APP_STORE)
        const mediaStore = transaction.objectStore(MEDIA_STORE)
        app.clear()
        mediaStore.clear()
        app.put(snapshot, KEY)
        app.put(nextRevision, REVISION_KEY)
        media.forEach(record => mediaStore.put(record, record.id))
      } catch (error) {
        try { transaction?.abort() } catch { /* The transaction may already be inactive. */ }
        finish(() => reject(error))
      }
    })
  })
}
