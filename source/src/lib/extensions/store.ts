/**
 * Installed extensions (After Effects CEP panels .zxp/.zip and ExtendScript
 * .jsx scripts) — persisted in IndexedDB, listed in a small zustand store.
 */
import { create } from 'zustand'
import { readZip } from './zip'

export interface ExtPanel {
  /** CEP extension id (or 'main' for scripts) */
  id: string
  name: string
  /** html path inside the bundle (no query) */
  main: string
  query: string
  type: 'Panel' | 'Modeless' | 'ModalDialog' | 'Custom'
  menu: string | null
  width: number
  height: number
}

export interface InstalledExt {
  id: string
  kind: 'cep' | 'script'
  name: string
  version: string
  panels: ExtPanel[]
  /** ExtendScript host file inside the bundle (CEP ScriptPath) or the script itself */
  scriptPath: string | null
  files: Record<string, Uint8Array>
  installedAt: number
}

const DB = 'anime-studio-extensions'
function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => { r.result.createObjectStore('ext', { keyPath: 'id' }) }
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
async function idbAll(): Promise<InstalledExt[]> {
  const d = await db()
  return new Promise((res, rej) => {
    const q = d.transaction('ext').objectStore('ext').getAll()
    q.onsuccess = () => res(q.result as InstalledExt[])
    q.onerror = () => rej(q.error)
  })
}
async function idbPut(e: InstalledExt) {
  const d = await db()
  await new Promise<void>((res, rej) => { const t = d.transaction('ext', 'readwrite'); t.objectStore('ext').put(e); t.oncomplete = () => res(); t.onerror = () => rej(t.error) })
}
async function idbDel(id: string) {
  const d = await db()
  await new Promise<void>((res, rej) => { const t = d.transaction('ext', 'readwrite'); t.objectStore('ext').delete(id); t.oncomplete = () => res(); t.onerror = () => rej(t.error) })
}

export interface FloatingExt { key: string; extId: string; panelId: string; title: string; width: number; height: number }

interface ExtState {
  loaded: boolean
  list: InstalledExt[]
  floating: FloatingExt[]
  /** panels docked as tabs in the right column (key = extId|panelId) */
  docked: string[]
  load: () => Promise<void>
  install: (file: File) => Promise<InstalledExt>
  remove: (id: string) => Promise<void>
  openFloating: (extId: string, panelId: string) => void
  closeFloating: (key: string) => void
  dock: (extId: string, panelId: string) => void
  undock: (key: string) => void
}

const DOCK_KEY = 'anime-studio:ext-docked'
const readDocked = (): string[] => { try { return JSON.parse(localStorage.getItem(DOCK_KEY) || '[]') } catch { return [] } }
const writeDocked = (v: string[]) => { try { localStorage.setItem(DOCK_KEY, JSON.stringify(v)) } catch { } }

export const useExtStore = create<ExtState>((set, get) => ({
  loaded: false,
  list: [],
  floating: [],
  docked: [],
  load: async () => {
    if (get().loaded) return
    try {
      const list = await idbAll()
      set({ list, loaded: true, docked: readDocked().filter(k => list.some(e => k.startsWith(e.id + '|'))) })
    } catch { set({ loaded: true }) }
  },
  install: async (file) => {
    const exts = await parseExtension(file)
    for (const e of exts) await idbPut(e)
    const ext = exts[0]
    const list = [...get().list.filter(e => !exts.some(x => x.id === e.id)), ...exts]
    // dock its first panel right away (AE shows new panels via Window > Extensions)
    const first = ext.panels.find(p => p.type === 'Panel') ?? ext.panels[0]
    const docked = first ? [...new Set([...get().docked, `${ext.id}|${first.id}`])] : get().docked
    writeDocked(docked)
    set({ list, docked })
    return ext
  },
  remove: async (id) => {
    await idbDel(id)
    const docked = get().docked.filter(k => !k.startsWith(id + '|'))
    writeDocked(docked)
    set({ list: get().list.filter(e => e.id !== id), floating: get().floating.filter(f => f.extId !== id), docked })
  },
  openFloating: (extId, panelId) => {
    const ext = get().list.find(e => e.id === extId)
    const p = ext?.panels.find(x => x.id === panelId)
    if (!ext || !p) return
    const key = `${extId}|${panelId}`
    if (get().floating.some(f => f.key === key)) return
    set({ floating: [...get().floating, { key, extId, panelId, title: p.name, width: p.width, height: p.height }] })
  },
  closeFloating: (key) => set({ floating: get().floating.filter(f => f.key !== key) }),
  dock: (extId, panelId) => {
    const docked = [...new Set([...get().docked, `${extId}|${panelId}`])]
    writeDocked(docked)
    set({ docked, floating: get().floating.filter(f => f.key !== `${extId}|${panelId}`) })
  },
  undock: (key) => {
    const docked = get().docked.filter(k => k !== key)
    writeDocked(docked)
    set({ docked })
  },
}))

// ------------------------------------------------------------------ parsing

function num(v: string | null | undefined, d: number) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d }

const SCRIPT_EXT = /\.(jsx|js|jsxinc|jsinc|jsxbin)$/i
const enc = new TextEncoder(), decT = new TextDecoder()

/** Inline `#include "x.jsx"` / `//@include 'x'` from the bundle (recursive, once per file). */
export function resolveIncludes(code: string, path: string, files: Record<string, Uint8Array>, seen = new Set<string>()): string {
  seen.add(path)
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
  const norm = (p: string) => { const out: string[] = []; for (const seg of p.split('/')) { if (seg === '..') out.pop(); else if (seg && seg !== '.') out.push(seg) } return out.join('/') }
  return code.replace(/^[ \t]*(?:#|\/\/@)include\s+["']([^"']+)["'];?[ \t]*$/gm, (line, inc: string) => {
    const want = norm(dir + inc.replace(/\\/g, '/'))
    const key = files[want] ? want : Object.keys(files).find(k => k.toLowerCase() === want.toLowerCase() || k.toLowerCase().endsWith('/' + inc.split(/[\\/]/).pop()!.toLowerCase()))
    if (!key || seen.has(key)) return `// ${line.trim()} (not found in bundle)`
    return `// ---- ${inc}\n${resolveIncludes(decT.decode(files[key]), key, files, seen)}\n// ---- end ${inc}`
  })
}

function isJsxbin(data: Uint8Array) { return /@JSXBIN@ES@/.test(decT.decode(data.subarray(0, 4096))) }
function scriptExt(name: string, path: string, files: Record<string, Uint8Array>): InstalledExt {
  if (isJsxbin(files[path])) throw new Error(`${path.split('/').pop()} is compiled ExtendScript (.jsxbin). It is encrypted bytecode that only Adobe's engine runs — install the .jsx version or the .zxp panel instead.`)
  const code = resolveIncludes(decT.decode(files[path]), path, files)
  return {
    id: `script.${name.replace(/[^\w.-]+/g, '_')}`, kind: 'script', name, version: '', installedAt: Date.now(),
    panels: [{ id: 'main', name, main: '', query: '', type: 'Panel', menu: name, width: 300, height: 420 }],
    scriptPath: path, files: { [path]: enc.encode(code) },
  }
}

async function parseExtension(file: File): Promise<InstalledExt[]> {
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.ffx')) throw new Error('.ffx is an animation preset — apply it with Animation › Apply Animation Preset… (it goes on the selected layer)')
  if (SCRIPT_EXT.test(lower)) {
    const data = new Uint8Array(await file.arrayBuffer())
    return [scriptExt(file.name.replace(SCRIPT_EXT, ''), file.name, { [file.name]: data })]
  }
  const entries = await readZip(await file.arrayBuffer())
  const files: Record<string, Uint8Array> = {}
  for (const e of entries) {
    if (e.name.startsWith('META-INF/') || e.name === 'mimetype') continue
    files[e.name] = e.data
  }
  // a .zip may wrap the bundle in one folder
  let root = ''
  const manifestName = Object.keys(files).find(n => /(^|\/)CSXS\/manifest\.xml$/i.test(n))
  if (!manifestName) {
    // a zip of scripts: install every top-level script (.jsxinc files are only includes)
    const scripts = Object.keys(files).filter(n => /\.(jsx|js|jsxbin)$/i.test(n) && !/(^|\/)(node_modules|__MACOSX)\//.test(n))
    if (scripts.length) {
      const out: InstalledExt[] = []
      const errs: string[] = []
      for (const p of scripts) { try { out.push(scriptExt(p.split('/').pop()!.replace(SCRIPT_EXT, ''), p, files)) } catch (e) { errs.push(e instanceof Error ? e.message : String(e)) } }
      if (!out.length) throw new Error(errs[0] ?? 'No runnable scripts in this archive')
      return out
    }
    throw new Error('No CSXS/manifest.xml found — this is not an After Effects extension (.zxp)')
  }
  root = manifestName.replace(/CSXS\/manifest\.xml$/i, '')
  const rel: Record<string, Uint8Array> = {}
  for (const [n, d] of Object.entries(files)) if (n.startsWith(root)) rel[n.slice(root.length)] = d
  const xml = new DOMParser().parseFromString(new TextDecoder().decode(files[manifestName]), 'application/xml')
  const man = xml.querySelector('ExtensionManifest')
  const bundleId = man?.getAttribute('ExtensionBundleId') || file.name
  const version = man?.getAttribute('ExtensionBundleVersion') || ''
  const hosts = [...xml.querySelectorAll('HostList > Host')].map(h => h.getAttribute('Name'))
  if (hosts.length && !hosts.includes('AEFT')) throw new Error(`This extension is for ${hosts.join(', ')} — only After Effects (AEFT) panels are supported`)
  const panels: ExtPanel[] = []
  let scriptPath: string | null = null
  for (const ext of xml.querySelectorAll('DispatchInfoList > Extension')) {
    const id = ext.getAttribute('Id') || 'main'
    const mainPath = ext.querySelector('Resources > MainPath')?.textContent?.trim() || ''
    const sp = ext.querySelector('Resources > ScriptPath')?.textContent?.trim()
    if (sp && !scriptPath) scriptPath = sp.replace(/^\.\//, '')
    if (!mainPath) continue
    const [path, query = ''] = mainPath.replace(/^\.\//, '').split('?')
    const type = (ext.querySelector('UI > Type')?.textContent?.trim() || 'Panel') as ExtPanel['type']
    const menu = ext.querySelector('UI > Menu')?.textContent?.trim() || null
    const size = ext.querySelector('UI > Geometry > Size')
    panels.push({
      id, name: menu || id.split('.').pop() || id, main: path, query: query ? `?${query}` : '', type, menu,
      width: num(size?.querySelector('Width')?.textContent, 320), height: num(size?.querySelector('Height')?.textContent, 560),
    })
  }
  if (!panels.length) throw new Error('The manifest declares no panels')
  const name = panels.find(p => p.menu)?.menu || bundleId
  if (scriptPath && rel[scriptPath]) rel[scriptPath] = enc.encode(resolveIncludes(decT.decode(rel[scriptPath]), scriptPath, rel))
  return [{ id: bundleId, kind: 'cep', name, version, panels, scriptPath, files: rel, installedAt: Date.now() }]
}
