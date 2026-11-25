/**
 * ANIME STUDIO — Static/offline mode
 *
 * When the app is deployed as a static single-file build (no Next.js server),
 * everything runs client-side: media imports become local Blob URLs persisted
 * in IndexedDB so they survive reloads, and server-dependent features are hidden.
 */
import type { AssetMeta } from '../engine/types'

export const STATIC_MODE: boolean =
  typeof process !== 'undefined' && process.env.NEXT_PUBLIC_STATIC_MODE === '1'

// ---------------------------------------------------------------------------
// IndexedDB blob store (static mode only)
// ---------------------------------------------------------------------------

const DB_NAME = 'anime-studio-media'
const STORE = 'files'

function openDB(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
}

/** Persist the raw file so blob URLs can be rebuilt after a reload. */
export async function persistLocalFile(id: string, file: File): Promise<void> {
  const db = await openDB()
  if (!db) return
  await new Promise<void>(resolve => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({ id, name: file.name, blob: file })
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
    tx.onabort = () => resolve()
  })
  db.close()
}

/** Delete a locally persisted file (asset removed). */
export async function deleteLocalFile(id: string): Promise<void> {
  const db = await openDB()
  if (!db) return
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).delete(id)
  db.close()
}

/**
 * Rebuild live Blob URLs for every asset that has a persisted file.
 * Returns the patched asset list (url replaced); assets without a stored
 * blob are returned untouched (they will simply fail to load — e.g. assets
 * imported in server mode).
 */
export async function restoreLocalAssets(assets: AssetMeta[]): Promise<AssetMeta[]> {
  const db = await openDB()
  if (!db) return assets
  const out: AssetMeta[] = []
  for (const a of assets) {
    const rec = await new Promise<{ id: string; blob: Blob } | null>(resolve => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(a.id)
      req.onsuccess = () => resolve((req.result as { id: string; blob: Blob }) ?? null)
      req.onerror = () => resolve(null)
    })
    if (rec?.blob) {
      out.push({ ...a, url: URL.createObjectURL(rec.blob) })
    } else {
      out.push(a)
    }
  }
  db.close()
  return out
}

/** Ids of files persisted in the local media store (for missing-footage checks). */
export async function listStoredMediaIds(): Promise<Set<string>> {
  const db = await openDB()
  if (!db) return new Set()
  const ids = await new Promise<string[]>(resolve => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAllKeys()
    req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String))
    req.onerror = () => resolve([])
  })
  db.close()
  return new Set(ids)
}

/**
 * Server-less uploadFn for importMediaFile(): keeps the file alive as a Blob
 * URL (playback, thumbnails, peaks all work) and stores it in IndexedDB.
 */
export async function localImportUpload(
  file: File,
  _probe: { kind: string; duration: number; width: number; height: number; fps: number },
): Promise<{ id: string; url: string }> {
  const id = `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  await persistLocalFile(id, file)
  return { id, url: URL.createObjectURL(file) }
}
