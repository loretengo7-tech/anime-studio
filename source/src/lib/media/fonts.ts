/**
 * ANIME STUDIO — Font catalog + custom font support
 *
 * Built-in: curated device font stacks that render on iOS/Android/desktop
 * Safari/Chrome (the actual glyphs come from the device's system fonts).
 * Custom: the user uploads a .ttf/.otf/.woff/.woff2 file — it is loaded via
 * the FontFace API, persisted in IndexedDB (db `anime-studio-ui`, store
 * `fonts`) and re-registered automatically on every boot. The canvas text
 * renderer consumes these like any other font family.
 */

export interface FontOption {
  /** CSS font-family string (what goes into ctx.font). */
  family: string
  label: string
  custom?: boolean
}

export const BUILTIN_FONTS: FontOption[] = [
  { family: 'system-ui, -apple-system, sans-serif', label: 'System (SF / Roboto)' },
  { family: 'Arial, Helvetica, sans-serif', label: 'Arial' },
  { family: '"Arial Black", Arial, sans-serif', label: 'Arial Black' },
  { family: '"Helvetica Neue", Arial, sans-serif', label: 'Helvetica Neue' },
  { family: 'Verdana, Geneva, sans-serif', label: 'Verdana' },
  { family: 'Tahoma, Verdana, sans-serif', label: 'Tahoma' },
  { family: '"Trebuchet MS", Helvetica, sans-serif', label: 'Trebuchet MS' },
  { family: 'Impact, Charcoal, sans-serif', label: 'Impact' },
  { family: 'Georgia, "Times New Roman", serif', label: 'Georgia' },
  { family: '"Times New Roman", Times, serif', label: 'Times New Roman' },
  { family: '"Palatino Linotype", Palatino, serif', label: 'Palatino' },
  { family: '"Courier New", Courier, monospace', label: 'Courier New' },
  { family: 'Menlo, Consolas, monospace', label: 'Menlo / Consolas' },
  { family: '"Comic Sans MS", cursive', label: 'Comic Sans MS' },
  { family: '"Brush Script MT", "Snell Roundhand", cursive', label: 'Brush Script' },
  { family: 'Copperplate, "Copperplate Gothic Light", serif', label: 'Copperplate' },
  { family: 'Optima, Candara, sans-serif', label: 'Optima' },
  { family: 'Futura, "Century Gothic", sans-serif', label: 'Futura / Century Gothic' },
  { family: 'serif', label: 'Serif (device default)' },
  { family: 'sans-serif', label: 'Sans (device default)' },
  { family: 'monospace', label: 'Mono (device default)' },
  { family: 'cursive', label: 'Cursive (device default)' },
]

const DB_NAME = 'anime-studio-ui'
const STORE = 'fonts'
let customCache: FontOption[] | null = null
const listeners = new Set<() => void>()

function openDB(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    const req = indexedDB.open(DB_NAME, 2) // v2: fonts + autosave share this DB — create both stores
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('fonts')) db.createObjectStore('fonts', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('autosave')) db.createObjectStore('autosave', { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
}

interface FontRecord { id: string; label: string; data: ArrayBuffer }

/** Load persisted custom fonts and register them with the document. Fails soft with a console warn. */
export async function restoreCustomFonts(): Promise<FontOption[]> {
  try {
    const db = await openDB()
    if (!db) return []
    const records = await new Promise<FontRecord[]>(resolve => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).getAll()
      req.onsuccess = () => resolve((req.result as FontRecord[]) ?? [])
      req.onerror = () => resolve([])
    })
    db.close()
    const out: FontOption[] = []
    for (const r of records) {
      const family = `custom-${r.id}`
      try {
        const ff = new FontFace(family, r.data)
        await ff.load()
        document.fonts.add(ff)
        out.push({ family, label: r.label, custom: true })
      } catch (e) {
        console.warn(`Font "${r.label}" failed to load:`, e)
      }
    }
    customCache = out
    listeners.forEach(l => l())
    return out
  } catch (e) {
    console.warn('Custom font restore failed:', e)
    return []
  }
}

/** Register + persist an uploaded font file. Returns the new option (or throws with a clear message). */
export async function addCustomFont(file: File): Promise<FontOption> {
  const id = `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  const label = file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Custom font'
  const data = await file.arrayBuffer()
  const family = `custom-${id}`
  try {
    const ff = new FontFace(family, data)
    await ff.load()
    document.fonts.add(ff)
  } catch (e) {
    throw new Error(`"${file.name}" is not a readable font file (.ttf/.otf/.woff/.woff2)`)
  }
  const db = await openDB()
  if (db) {
    await new Promise<void>(resolve => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ id, label, data } satisfies FontRecord)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
    db.close()
  }
  const opt: FontOption = { family, label, custom: true }
  customCache = [...(customCache ?? []), opt]
  listeners.forEach(l => l())
  return opt
}

export async function deleteCustomFont(family: string): Promise<void> {
  const id = family.replace(/^custom-/, '')
  const db = await openDB()
  if (db) {
    await new Promise<void>(resolve => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
    db.close()
  }
  customCache = (customCache ?? []).filter(f => f.family !== family)
  listeners.forEach(l => l())
}

export function getCustomFonts(): FontOption[] {
  return customCache ?? []
}

export function subscribeFonts(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function allFonts(): FontOption[] {
  return [...getCustomFonts(), ...BUILTIN_FONTS]
}
