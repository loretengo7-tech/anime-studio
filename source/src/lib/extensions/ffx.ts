/**
 * ANIME STUDIO — After Effects animation presets (.ffx)
 *
 * A .ffx is a RIFX file like a .aep. We read the effect match names it holds
 * ("ADBE Gaussian Blur 2", "ADBE Glo2", "CC Light Rays"…) and add the matching
 * AnimeStudio effects to the selected layers with default values. Effect
 * settings and keyframes stored in the preset are AE-internal and not converted.
 */
import { useEditorStore } from '@/lib/store/editorStore'
import { EFFECT_MAP } from '@/lib/engine/effects'
import { uid, type Clip, type EffectInstance, type KeyframeTrack } from '@/lib/engine/types'
import { playbackEngine } from '@/lib/engine/playback'
import { MATCH_TO_TYPE } from './matchNames'

const SKIP = /^ADBE (Effect Parade|Transform Group|Effect Built In Params|Group End|Root Vectors Group|Text Properties|Marker|Time Remapping|Mask Parade|Layer Styles|Material Options Group|Audio Group|Extrusion|Plane Options Group|Vector)/

export function ffxEffectNames(buf: Uint8Array): string[] {
  const dec = new TextDecoder('latin1')
  if (dec.decode(buf.subarray(0, 4)) !== 'RIFX') throw new Error('Not an After Effects preset (RIFX header missing)')
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const names: string[] = []
  // tdmn chunks: 'tdmn' + u32 size + NUL-padded match name; find them by scanning
  for (let o = 12; o + 8 <= buf.length; o++) {
    if (buf[o] !== 0x74 || buf[o + 1] !== 0x64 || buf[o + 2] !== 0x6d || buf[o + 3] !== 0x6e) continue
    const size = dv.getUint32(o + 4)
    if (size < 2 || size > 64 || o + 8 + size > buf.length) continue
    const n = dec.decode(buf.subarray(o + 8, o + 8 + size)).replace(/\0[\s\S]*$/, '').trim()
    if (n && !SKIP.test(n) && !/^ADBE (Position|Scale|Rotate|Opacity|Anchor)/.test(n)) names.push(n)
    o += 7 + size
  }
  return names
}

/** Apply a .ffx preset to the selected layers. Returns what was added / skipped. */
export async function applyFfxPreset(file: File): Promise<{ added: string[]; unsupported: string[] }> {
  const names = ffxEffectNames(new Uint8Array(await file.arrayBuffer()))
  // effect groups are the matchnames that map to a known effect; params of an effect (e.g. "ADBE Glo2-0001") are skipped
  const effects = names.filter(n => !/-\d{4}$/.test(n))
  const added: string[] = [], unsupported: string[] = []
  const types: string[] = []
  for (const n of effects) {
    const t = MATCH_TO_TYPE[n]
    if (t && EFFECT_MAP[t]) { types.push(t); added.push(EFFECT_MAP[t].name) } else if (!unsupported.includes(n)) unsupported.push(n)
  }
  const st = useEditorStore.getState()
  const ids = st.selectedClipIds.length ? st.selectedClipIds : st.selectedClipId ? [st.selectedClipId] : []
  if (!ids.length) throw new Error('Select a layer first, then apply the preset')
  if (types.length) st.mutate(d => {
    for (const c of d.clips) if (ids.includes(c.id)) for (const t of types) {
      const def = EFFECT_MAP[t]
      c.effects.push({ id: uid('fx'), type: t, enabled: true, params: Object.fromEntries(def.params.map(p => [p.key, p.default])), paramKeyframes: {} })
    }
  })
  return { added, unsupported }
}

// ------------------------------------------------------------------ preset library (Effects & Presets › Animation Presets)


export interface PresetEntry {
  id: string
  name: string
  /** 'ffx' = installed After Effects preset; 'native' = saved from a layer here. */
  source: 'ffx' | 'native'
  effects: string[]
  unsupported: string[]
  /** native presets carry the full effect settings and keyframes */
  payload?: { effects: EffectInstance[]; keyframes: KeyframeTrack[]; expressions?: Record<string, string> }
  installedAt: number
}

const PDB = 'anime-studio-presets'
function pdb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(PDB, 1)
    r.onupgradeneeded = () => { r.result.createObjectStore('presets', { keyPath: 'id' }) }
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
}
async function ptx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await pdb()
  return new Promise((res, rej) => {
    const t = d.transaction('presets', mode)
    const req = fn(t.objectStore('presets'))
    t.oncomplete = () => res(req ? (req as IDBRequest<T>).result : undefined)
    t.onerror = () => rej(t.error)
  })
}
const plisteners = new Set<() => void>()
export function onPresetsChange(cb: () => void) { plisteners.add(cb); return () => { plisteners.delete(cb) } }
const pchanged = () => plisteners.forEach(f => f())

export async function listPresets(): Promise<PresetEntry[]> {
  return ((await ptx<PresetEntry[]>('readonly', s => s.getAll()).catch(() => [])) ?? []).sort((a, b) => a.name.localeCompare(b.name))
}
export async function removePreset(id: string) { await ptx('readwrite', s => { s.delete(id) }); pchanged() }

/** Install .ffx (After Effects) or .aspreset (AnimeStudio) files into the library. */
export async function installPresetFiles(files: File[]): Promise<PresetEntry[]> {
  const out: PresetEntry[] = []
  for (const f of files) {
    const name = f.name.replace(/\.(ffx|aspreset|json)$/i, '')
    let e: PresetEntry
    if (/\.ffx$/i.test(f.name)) {
      const names = ffxEffectNames(new Uint8Array(await f.arrayBuffer())).filter(n => !/-\d{4}$/.test(n))
      const effects: string[] = [], unsupported: string[] = []
      for (const n of names) { const t = MATCH_TO_TYPE[n]; if (t && EFFECT_MAP[t]) effects.push(t); else if (!unsupported.includes(n)) unsupported.push(n) }
      e = { id: `ffx.${name}`, name, source: 'ffx', effects, unsupported, installedAt: Date.now() }
    } else {
      const j = JSON.parse(await f.text())
      if (j?.format !== 'anime-studio-preset') throw new Error(`${f.name} is not an AnimeStudio preset`)
      e = { ...(j.preset as PresetEntry), id: `native.${name}`, name, source: 'native', installedAt: Date.now() }
    }
    await ptx('readwrite', s => { s.put(e) })
    out.push(e)
  }
  pchanged()
  return out
}

/** Animation › Save Animation Preset: effects + keyframes + expressions of the selected layer. */
export async function saveLayerAsPreset(clip: Clip, name: string): Promise<PresetEntry> {
  const t0 = [...clip.keyframes.flatMap(k => k.keyframes.map(x => x.time)), ...clip.effects.flatMap(fx => Object.values(fx.paramKeyframes ?? {}).flat().map(x => x.time))].reduce((a, b) => Math.min(a, b), Infinity)
  const shift = Number.isFinite(t0) ? t0 : 0
  const e: PresetEntry = {
    id: `native.${name}`, name, source: 'native', effects: clip.effects.map(x => x.type), unsupported: [], installedAt: Date.now(),
    payload: {
      effects: (JSON.parse(JSON.stringify(clip.effects)) as EffectInstance[]).map(fx => ({ ...fx, paramKeyframes: Object.fromEntries(Object.entries(fx.paramKeyframes ?? {}).map(([k, v]) => [k, v.map(x => ({ ...x, time: x.time - shift }))])) })),
      keyframes: clip.keyframes.map(k => ({ property: k.property, keyframes: k.keyframes.map(x => ({ ...x, time: x.time - shift })) })),
      expressions: clip.expressions ? { ...clip.expressions } : undefined,
    },
  }
  await ptx('readwrite', s => { s.put(e) }); pchanged()
  return e
}
export function downloadPreset(e: PresetEntry) {
  const blob = new Blob([JSON.stringify({ format: 'anime-studio-preset', version: 1, preset: e }, null, 2)], { type: 'application/json' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${e.name}.aspreset`; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

/** Apply a library preset to the selected layers (keyframes start at the CTI, like AE). */
export function applyPreset(e: PresetEntry): number {
  const st = useEditorStore.getState()
  const ids = st.selectedClipIds.length ? st.selectedClipIds : st.selectedClipId ? [st.selectedClipId] : []
  if (!ids.length) throw new Error('Select a layer first, then apply the preset')
  const now = playbackEngine.currentTime
  st.mutate(d => {
    for (const c of d.clips) {
      if (!ids.includes(c.id)) continue
      if (e.payload) {
        const remap = new Map<string, string>()
        const at = Math.max(0, now - c.start)
        for (const fx of e.payload.effects) {
          const nid = uid('fx'); remap.set(fx.id, nid)
          const copy: EffectInstance = { ...JSON.parse(JSON.stringify(fx)), id: nid }
          for (const k of Object.keys(copy.paramKeyframes ?? {})) copy.paramKeyframes[k] = copy.paramKeyframes[k].map(x => ({ ...x, id: uid('kf'), time: x.time + at }))
          c.effects.push(copy)
        }
        for (const tr of e.payload.keyframes) {
          let prop = tr.property
          for (const [o, n] of remap) prop = prop.replace(`effect:${o}:`, `effect:${n}:`)
          const kfs = tr.keyframes.map(k => ({ ...k, id: uid('kf'), time: k.time + at }))
          const ex = c.keyframes.find(k => k.property === prop)
          if (ex) { ex.keyframes = [...ex.keyframes.filter(k => !kfs.some(n => Math.abs(n.time - k.time) < 1e-4)), ...kfs].sort((a, b) => a.time - b.time) }
          else c.keyframes.push({ property: prop, keyframes: kfs })
        }
        if (e.payload.expressions) c.expressions = { ...(c.expressions ?? {}), ...e.payload.expressions }
      } else {
        for (const t of e.effects) {
          const def = EFFECT_MAP[t]
          if (def) c.effects.push({ id: uid('fx'), type: t, enabled: true, params: Object.fromEntries(def.params.map(p => [p.key, p.default])), paramKeyframes: {} })
        }
      }
    }
  })
  return ids.length
}
