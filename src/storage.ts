import type { AppData, MediaRecord } from './domain'

const DB_NAME = 'momentum'
const APP_STORE = 'app'
const MEDIA_STORE = 'media'
const KEY = 'snapshot'

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

export const readSnapshot = () => afterMutations(() => store<AppData | undefined>(APP_STORE, 'readonly', objectStore => objectStore.get(KEY)))
export const currentSnapshotGeneration = () => snapshotGeneration
export const writeSnapshot = (snapshot: AppData, generation = snapshotGeneration) => {
  if (generation !== snapshotGeneration) return Promise.resolve()
  return mutate(async () => {
    // A clear/import may have started while this write was waiting behind an
    // earlier IndexedDB mutation. Never let the stale snapshot run afterward.
    if (generation !== snapshotGeneration) return
    await store<IDBValidKey>(APP_STORE, 'readwrite', objectStore => objectStore.put(snapshot, KEY))
  })
}
export const putMedia = (media: MediaRecord) => mutate(() => store<IDBValidKey>(MEDIA_STORE, 'readwrite', objectStore => objectStore.put(media, media.id)))
export const getMedia = (id: string) => afterMutations(() => store<MediaRecord | undefined>(MEDIA_STORE, 'readonly', objectStore => objectStore.get(id)))
export const deleteMedia = (id: string) => mutate(() => store<undefined>(MEDIA_STORE, 'readwrite', objectStore => objectStore.delete(id)))
export const allMedia = () => afterMutations(() => store<MediaRecord[]>(MEDIA_STORE, 'readonly', objectStore => objectStore.getAll()))

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

export async function clearAll() {
  // Invalidate already-scheduled hook writes synchronously, before this
  // destructive transaction is queued or yields to the event loop.
  snapshotGeneration += 1
  return mutate(async () => {
    const db = await openDatabase()
    return new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction | undefined
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        db.close()
        callback()
      }
      try {
        transaction = db.transaction([APP_STORE, MEDIA_STORE], 'readwrite')
        transaction.oncomplete = () => finish(resolve)
        transaction.onerror = () => finish(() => reject(transaction?.error || new Error('Local data could not be cleared.')))
        transaction.onabort = () => finish(() => reject(transaction?.error || new Error('Local data clearing was canceled.')))
        transaction.objectStore(APP_STORE).clear()
        transaction.objectStore(MEDIA_STORE).clear()
      } catch (error) {
        try { transaction?.abort() } catch { /* The transaction may already be inactive. */ }
        finish(() => reject(error))
      }
    })
  })
}

/** Replace app data and media in one transaction so a failed import preserves the old database. */
export async function replaceDatabase(snapshot: AppData, media: MediaRecord[]) {
  // Imported data must not be overwritten by a debounce carrying the previous
  // in-memory snapshot.
  snapshotGeneration += 1
  return mutate(async () => {
    const db = await openDatabase()
    return new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction | undefined
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        db.close()
        callback()
      }
      try {
        transaction = db.transaction([APP_STORE, MEDIA_STORE], 'readwrite')
        transaction.oncomplete = () => finish(resolve)
        transaction.onerror = () => finish(() => reject(transaction?.error || new Error('Backup restore failed.')))
        transaction.onabort = () => finish(() => reject(transaction?.error || new Error('Backup restore was canceled.')))
        const app = transaction.objectStore(APP_STORE)
        const mediaStore = transaction.objectStore(MEDIA_STORE)
        app.clear()
        mediaStore.clear()
        app.put(snapshot, KEY)
        media.forEach(record => mediaStore.put(record, record.id))
      } catch (error) {
        try { transaction?.abort() } catch { /* The transaction may already be inactive. */ }
        finish(() => reject(error))
      }
    })
  })
}
