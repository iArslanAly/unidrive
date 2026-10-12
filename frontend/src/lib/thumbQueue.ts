import { useEffect, useRef, useState } from 'react'

/**
 * Thumbnail pipeline: a two-tier cache (IndexedDB + in-memory mirror) + a
 * concurrency-limited extraction queue + a viewport-aware lazy trigger.
 *
 *  - Persistence: generated posters survive reloads via IndexedDB (sessionStorage
 *    fallback). On mount we hydrate an in-memory Map so cache hits are synchronous.
 *  - Native fast path: FileGrid renders Google Drive `thumbnailLink` directly.
 *  - No saturation: at most 2 extractions run in parallel.
 *  - Lazy: extraction only starts once a card scrolls into view.
 */

// --- Tier 1: in-memory mirror (synchronous reads) ---
const thumbCache = new Map<string, string>()
const MAX_CACHE_ENTRIES = 120

export function getCachedThumb(fileId?: string): string | undefined {
  return fileId ? thumbCache.get(fileId) : undefined
}

export function setCachedThumb(fileId: string | undefined, url: string): void {
  if (!fileId || !url) return
  if (!thumbCache.has(fileId) && thumbCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = thumbCache.keys().next().value
    if (oldest) thumbCache.delete(oldest)
  }
  thumbCache.set(fileId, url)
  void idbPut(fileId, url)
}

export function clearThumbCache(): void {
  thumbCache.clear()
  void idbClear()
}

// --- Tier 2: IndexedDB persistence (sessionStorage fallback) ---
const IDB_NAME = 'unidrive-thumbs'
const IDB_STORE = 'thumbs'
const SS_PREFIX = 'unidrive:thumb:'
const MAX_PERSISTED = 200

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(IDB_NAME, 1)
    } catch {
      return resolve(null)
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
  return dbPromise
}

async function idbPut(key: string, value: string): Promise<void> {
  try {
    const db = await openDb()
    if (db) {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readwrite')
        tx.objectStore(IDB_STORE).put(value, key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      })
      return
    }
  } catch { /* fall through to sessionStorage */ }
  try {
    if (typeof sessionStorage === 'undefined') return
    sessionStorage.setItem(SS_PREFIX + key, value)
    const keys = Object.keys(sessionStorage).filter((k) => k.startsWith(SS_PREFIX))
    if (keys.length > MAX_PERSISTED) {
      for (const k of keys.slice(0, keys.length - MAX_PERSISTED)) sessionStorage.removeItem(k)
    }
  } catch { /* quota exceeded — ignore */ }
}

async function idbGet(key: string): Promise<string | undefined> {
  try {
    const db = await openDb()
    if (db) {
      const value = await new Promise<string | undefined>((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readonly')
        const req = tx.objectStore(IDB_STORE).get(key)
        req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : undefined)
        req.onerror = () => resolve(undefined)
      })
      if (value) return value
    }
  } catch { /* fall through */ }
  try {
    if (typeof sessionStorage === 'undefined') return undefined
    return sessionStorage.getItem(SS_PREFIX + key) ?? undefined
  } catch {
    return undefined
  }
}

/** Async per-key cache read (used when the sync mirror hasn't hydrated yet). */
export { idbGet }

async function idbClear(): Promise<void> {
  try {
    const db = await openDb()
    if (db) {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readwrite')
        tx.objectStore(IDB_STORE).clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      })
    }
  } catch { /* ignore */ }
  try {
    if (typeof sessionStorage === 'undefined') return
    for (const k of Object.keys(sessionStorage)) if (k.startsWith(SS_PREFIX)) sessionStorage.removeItem(k)
  } catch { /* ignore */ }
}

let hydrated = false
/** Hydrate the in-memory mirror from IndexedDB once per session. */
export async function hydrateThumbCache(): Promise<void> {
  if (hydrated) return
  hydrated = true
  try {
    const db = await openDb()
    if (db) {
      const entries = await new Promise<Array<[string, string]>>((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readonly')
        const store = tx.objectStore(IDB_STORE)
        const keysReq = store.getAllKeys()
        const valsReq = store.getAll()
        const done = () => {
          const keys = (keysReq.result ?? []) as IDBValidKey[]
          const vals = (valsReq.result ?? []) as unknown[]
          resolve(keys.map((k, i): [string, string] => [String(k), typeof vals[i] === 'string' ? (vals[i] as string) : '']).filter(([, v]) => v))
        }
        tx.oncomplete = done
        tx.onerror = () => resolve([])
        tx.onabort = () => resolve([])
      })
      for (const [k, v] of entries) setCachedThumb(k, v)
    }
  } catch { /* ignore */ }
}

// --- Concurrency-limited extraction queue (max 2 in parallel) ---
const MAX_CONCURRENT = 2
let activeCount = 0
const waiters: Array<() => void> = []

function drain(): void {
  while (activeCount < MAX_CONCURRENT && waiters.length > 0) {
    const next = waiters.shift()
    next?.()
  }
}

/**
 * Runs `task` once a concurrency slot frees up. At most 2 heavy extractions run at
 * once, leaving HTTP connection slots free for navigation/API. Aborted-task
 * rejections surface to the caller but never stall the queue.
 */
export function runThumbTask<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      activeCount += 1
      task().then(resolve, reject).finally(() => {
        activeCount -= 1
        drain()
      })
    }
    waiters.push(start)
    drain()
  })
}

// --- Viewport-aware lazy trigger ---
/**
 * Returns a ref + a boolean that flips true the first time the element scrolls into
 * view (generous rootMargin pre-warms near-viewport cards). Falls back to visible
 * immediately when IntersectionObserver is unavailable.
 */
export function useThumbVisible<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) { setVisible(true); observer.disconnect() }
        }
      },
      { rootMargin: '300px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, visible]
}
