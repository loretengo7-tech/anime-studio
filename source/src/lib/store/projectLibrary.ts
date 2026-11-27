/**
 * ANIME STUDIO — Project library (like After Effects' Home / Recent Projects)
 *
 * Every project is saved on its own in IndexedDB (autosave on each edit), so
 * creating a new project never overwrites the previous one. The Home screen
 * lists them (name, date, thumbnail, layer count) to open, rename, duplicate
 * or delete.
 */
import type { AssetMeta, ProjectDoc } from '@/lib/engine/types'

export interface LibraryEntry {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  thumb: string | null
  layers: number
  duration: number
  width: number
  height: number
  fps: number
}
interface LibraryRecord extends LibraryEntry { doc: ProjectDoc }

const DB = 'anime-studio-library'
function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => { r.result.createObjectStore('projects', { keyPath: 'id' }) }
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db()
  return new Promise((res, rej) => {
    const t = d.transaction('projects', mode)
    const req = fn(t.objectStore('projects'))
    t.oncomplete = () => res(req ? (req as IDBRequest<T>).result : undefined)
    t.onerror = () => rej(t.error)
  })
}

const listeners = new Set<() => void>()
export function onLibraryChange(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } }
const changed = () => listeners.forEach(f => f())

function thumbOf(doc: ProjectDoc): string | null {
  const a = doc.assets.find((x: AssetMeta) => x.kind === 'video' && x.thumbnails?.length) ?? doc.assets.find((x: AssetMeta) => x.kind === 'image')
  if (!a) return null
  return a.kind === 'video' ? a.thumbnails![Math.min(2, a.thumbnails!.length - 1)] : (a.url.startsWith('data:') ? a.url : null)
}

/** Upsert the open project (called by autosave). */
export async function saveToLibrary(doc: ProjectDoc): Promise<void> {
  if (!doc?.id) return
  const prev = await tx<LibraryRecord>('readonly', s => s.get(doc.id)).catch(() => undefined)
  const rec: LibraryRecord = {
    id: doc.id, name: doc.name || 'Untitled', createdAt: prev?.createdAt ?? Date.now(), updatedAt: Date.now(),
    thumb: thumbOf(doc) ?? prev?.thumb ?? null, layers: doc.clips.length, duration: doc.composition.duration,
    width: doc.composition.width, height: doc.composition.height, fps: doc.composition.fps,
    doc: JSON.parse(JSON.stringify({ ...doc, aiHistory: (doc.aiHistory ?? []).slice(-40) })),
  }
  await tx('readwrite', s => { s.put(rec) })
  changed()
}

export async function listLibrary(): Promise<LibraryEntry[]> {
  const all = (await tx<LibraryRecord[]>('readonly', s => s.getAll()).catch(() => [])) ?? []
  return all.map(({ doc: _d, ...e }) => e).sort((a, b) => b.updatedAt - a.updatedAt)
}
export async function loadFromLibrary(id: string): Promise<ProjectDoc | null> {
  const r = await tx<LibraryRecord>('readonly', s => s.get(id)).catch(() => undefined)
  return r?.doc ?? null
}
export async function deleteFromLibrary(id: string) { await tx('readwrite', s => { s.delete(id) }); changed() }
export async function renameInLibrary(id: string, name: string) {
  const r = await tx<LibraryRecord>('readonly', s => s.get(id))
  if (!r) return
  r.name = name; r.doc.name = name
  await tx('readwrite', s => { s.put(r) }); changed()
}
export async function duplicateInLibrary(id: string): Promise<string | null> {
  const r = await tx<LibraryRecord>('readonly', s => s.get(id))
  if (!r) return null
  const nid = `proj_${Math.random().toString(36).slice(2, 10)}`
  const copy: LibraryRecord = { ...r, id: nid, name: `${r.name} copy`, createdAt: Date.now(), updatedAt: Date.now(), doc: { ...r.doc, id: nid, name: `${r.name} copy` } }
  await tx('readwrite', s => { s.put(copy) }); changed()
  return nid
}
