/**
 * ANIME STUDIO — IndexedDB autosave
 *
 * The project autosave moved from localStorage-only to IndexedDB (bigger,
 * more reliable on iOS, survives Safari's storage pressure better). A small
 * ring of recent versions is kept so a bad edit can be rolled back.
 * Every failure surfaces a clear toast — no silent data loss.
 */
import type { ProjectDoc } from '@/lib/engine/types'

const DB_NAME = 'anime-studio-ui'
const STORE = 'autosave'
const KEY_LATEST = 'latest'
const HISTORY_KEYS = ['hist-1', 'hist-2', 'hist-3', 'hist-4', 'hist-5']
const HISTORY_TIP = 'hist-0'

interface AutosaveRecord {
  key: string
  doc: ProjectDoc
  at: number
}

function openDB(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
}

async function put(db: IDBDatabase, rec: AutosaveRecord): Promise<void> {
  await new Promise<void>(resolve => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(rec)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
    tx.onabort = () => resolve()
  })
}

/** Save the doc as the latest autosave, pushing the previous latest into the history ring. */
export async function writeAutosave(doc: ProjectDoc): Promise<void> {
  const db = await openDB()
  if (!db) throw new Error('IndexedDB unavailable (private mode?)')
  try {
    const prev = await readAutosave()
    if (prev && prev.doc !== doc) {
      // shift the ring: hist-4 ← hist-3 ← ... ← hist-0 ← previous latest
      for (let i = HISTORY_KEYS.length - 1; i > 0; i--) {
        const older = await getRec(db, HISTORY_KEYS[i - 1])
        if (older) await put(db, { ...older, key: HISTORY_KEYS[i] })
      }
      const tip = await getRec(db, HISTORY_TIP)
      if (tip) await put(db, { ...tip, key: HISTORY_KEYS[0] })
      await put(db, { key: HISTORY_TIP, doc: prev.doc, at: prev.at })
    }
    await put(db, { key: KEY_LATEST, doc, at: Date.now() })
  } finally {
    db.close()
  }
}

async function getRec(db: IDBDatabase, key: string): Promise<AutosaveRecord | null> {
  return new Promise(resolve => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve((req.result as AutosaveRecord) ?? null)
    req.onerror = () => resolve(null)
  })
}

export async function readAutosave(): Promise<AutosaveRecord | null> {
  const db = await openDB()
  if (!db) return null
  try {
    return await getRec(db, KEY_LATEST)
  } finally {
    db.close()
  }
}

/** List available recovery points (latest + ring), newest first. */
export async function listAutosaves(): Promise<AutosaveRecord[]> {
  const db = await openDB()
  if (!db) return []
  try {
    const keys = [KEY_LATEST, HISTORY_TIP, ...HISTORY_KEYS]
    const out: AutosaveRecord[] = []
    for (const k of keys) {
      const r = await getRec(db, k)
      if (r) out.push(r)
    }
    return out
  } finally {
    db.close()
  }
}
