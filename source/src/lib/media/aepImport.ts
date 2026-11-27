/**
 * ANIME STUDIO — After Effects project import (.aep binary RIFX / .aepx XML)
 *
 * Reads the structure of an AE project: compositions (size, fps, duration),
 * their layers (name, order, source, kind) and footage references (file path).
 * Footage comes in as "offline" placeholders: importing the real files later
 * relinks them automatically by file name (like AE's "Find missing footage").
 * Nested comps become pre-comps. Effects and expressions are AE-only and are
 * not converted.
 */
import type { AssetMeta, Clip, Composition, Precomp, ProjectDoc, Track } from '@/lib/engine/types'
import { createDefaultProject, defaultLabel, makeClipBase, uid } from '@/lib/engine/types'
import { EFFECT_MAP } from '@/lib/engine/effects'
import { MATCH_TO_TYPE } from '@/lib/extensions/matchNames'

interface Chunk { id: string; list?: string; data?: Uint8Array; text?: string; children?: Chunk[] }

// ---------------------------------------------------------------- RIFX (.aep)
const dec = new TextDecoder('utf-8')
const ascii = (b: Uint8Array, o: number, n = 4) => String.fromCharCode(...b.subarray(o, o + n))

function parseRifx(buf: Uint8Array): Chunk {
  if (ascii(buf, 0) !== 'RIFX') throw new Error('Not an After Effects project (RIFX header missing)')
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const walk = (start: number, end: number, depth: number): Chunk[] => {
    const out: Chunk[] = []
    let o = start
    while (o + 8 <= end) {
      const id = ascii(buf, o)
      const size = dv.getUint32(o + 4)
      const body = o + 8
      const bodyEnd = Math.min(end, body + size)
      if (id === 'LIST' && size >= 4 && depth < 64) {
        const list = ascii(buf, body)
        // 'btdk' holds a binary text-document blob, not sub-chunks
        out.push(list === 'btdk' ? { id, list, data: buf.subarray(body + 4, bodyEnd) } : { id, list, children: walk(body + 4, bodyEnd, depth + 1) })
      } else {
        const data = buf.subarray(body, bodyEnd)
        out.push(id === 'Utf8' ? { id, text: dec.decode(data) } : { id, data })
      }
      o = body + size + (size & 1)
    }
    return out
  }
  return { id: 'LIST', list: 'root', children: walk(12, buf.length, 0) }
}

// ---------------------------------------------------------------- XML (.aepx)
function hex(s: string): Uint8Array {
  const clean = s.replace(/[^0-9a-f]/gi, '')
  const out = new Uint8Array(clean.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16)
  return out
}
function parseAepx(text: string): Chunk {
  const xml = new DOMParser().parseFromString(text, 'application/xml')
  if (xml.getElementsByTagName('parsererror').length) throw new Error('Invalid .aepx XML')
  const conv = (el: Element): Chunk => {
    const tag = el.localName
    if (tag === 'string') return { id: 'Utf8', text: el.textContent ?? '' }
    if (tag === 'fileReference') return { id: 'alas', text: JSON.stringify({ fullpath: el.getAttribute('fullpath') ?? '' }) }
    const bdata = el.getAttribute('bdata')
    if (bdata != null) return { id: tag, data: hex(bdata) }
    return { id: 'LIST', list: tag, children: Array.from(el.children).map(conv) }
  }
  return conv(xml.documentElement)
}

// ---------------------------------------------------------------- model
interface AEFootage { id: number; name: string; path: string; solid: boolean; width: number; height: number; fps: number; duration: number }
interface AELayer { effects?: string[]; name: string; sourceId: number | null; ld?: Uint8Array; threeD?: boolean; adjustment?: boolean; motionBlur?: boolean; kind: 'text' | 'camera' | 'shape' | 'null' | 'light' | 'source' }
interface AEComp { id: number; name: string; width: number; height: number; fps: number; duration: number; layers: AELayer[] }

const u16 = (d: Uint8Array, o: number) => o + 2 <= d.length ? (d[o] << 8) | d[o + 1] : 0
const u32 = (d: Uint8Array, o: number) => o + 4 <= d.length ? ((d[o] << 24) >>> 0) + (d[o + 1] << 16) + (d[o + 2] << 8) + d[o + 3] : 0
const child = (c: Chunk, id: string, list?: string) => c.children?.find(x => x.id === id && (list == null || x.list === list))
const firstText = (c: Chunk) => child(c, 'Utf8')?.text?.trim() ?? ''
function deep(c: Chunk, pred: (x: Chunk) => boolean, acc: Chunk[] = []): Chunk[] {
  if (pred(c)) acc.push(c)
  for (const k of c.children ?? []) deep(k, pred, acc)
  return acc
}
/** All 'tdmn' match names (e.g. "ADBE Text Properties") anywhere inside a layer. */
function matchNames(c: Chunk): Set<string> {
  const s = new Set<string>()
  for (const t of deep(c, x => x.id === 'tdmn' && !!x.data)) s.add(dec.decode(t.data!).replace(/\0[\s\S]*$/, '').trim())
  return s
}
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p

function readModel(root: Chunk) {
  const comps: AEComp[] = []
  const footage = new Map<number, AEFootage>()
  const compIds = new Set<number>()
  for (const item of deep(root, x => x.id === 'LIST' && x.list === 'Item')) {
    const idta = child(item, 'idta')?.data
    if (!idta) continue
    const type = u16(idta, 0)
    const id = u32(idta, 16)
    const name = firstText(item)
    if (type === 4) {
      const cd = child(item, 'cdta')?.data ?? new Uint8Array(0)
      let width = u16(cd, 136), height = u16(cd, 138)
      if (width < 4 || width > 16384 || height < 4 || height > 16384) { width = 1920; height = 1080 }
      const fdiv = u32(cd, 4), fdnd = u32(cd, 8)
      let fps = fdiv > 0 && fdnd > 0 ? fdnd / fdiv : u16(cd, 152)
      if (!(fps >= 1 && fps <= 960)) fps = 30
      const sdnd = u32(cd, 40), sdiv = u32(cd, 44)
      let duration = sdiv > 0 ? sdnd / sdiv : 0
      if (!(duration > 0.04 && duration < 3600 * 3)) duration = 10
      const layers: AELayer[] = []
      for (const L of (item.children ?? []).filter(x => x.id === 'LIST' && x.list === 'Layr')) {
        const ld = child(L, 'ldta')?.data
        const names = matchNames(L)
        const kind: AELayer['kind'] = names.has('ADBE Text Properties') ? 'text'
          : names.has('ADBE Camera Options Group') ? 'camera'
            : names.has('ADBE Light Options Group') ? 'light'
              : names.has('ADBE Root Vectors Group') ? 'shape' : 'source'
        const bits = ld && ld.length >= 40 ? [ld[37], ld[38], ld[39]] : [0, 0, 0]
        layers.push({ effects: [...names].filter(n => MATCH_TO_TYPE[n] && EFFECT_MAP[MATCH_TO_TYPE[n]]).map(n => MATCH_TO_TYPE[n]), name: firstText(L), sourceId: null, ld, kind, threeD: !!(bits[1] & 4), adjustment: !!(bits[1] & 2), motionBlur: !!(bits[2] & 8) })
      }
      comps.push({ id, name: name || 'Comp', width, height, fps: Math.round(fps * 1000) / 1000, duration, layers })
      compIds.add(id)
    } else if (type === 7) {
      const pin = child(item, 'LIST', 'Pin ') ?? child(item, 'LIST', 'Pin')
      let path = ''
      const alas = pin && deep(pin, x => x.id === 'alas')[0]
      if (alas) {
        const txt = alas.text ?? (alas.data ? dec.decode(alas.data) : '')
        try { path = String(JSON.parse(txt.replace(/\0+$/, '')).fullpath ?? '') } catch { path = (txt.match(/"fullpath"\s*:\s*"([^"]*)"/)?.[1] ?? '').replace(/\\\\/g, '\\') }
      }
      const opti = pin && deep(pin, x => x.id === 'opti')[0]?.data
      const ftype = opti ? u16(opti, 4) : 0
      const solid = ftype === 0x09
      const solidName = solid && opti ? dec.decode(opti.subarray(26, 255)).replace(/\0[\s\S]*$/, '') : ''
      const sp = pin && deep(pin, x => x.id === 'sspc')[0]?.data
      const w = sp ? u32(sp, 30) : 0, h = sp ? u32(sp, 34) : 0
      const sd = sp ? u32(sp, 38) : 0, sv = sp ? u32(sp, 42) : 0
      const fr = sp ? u32(sp, 56) + u16(sp, 60) / 65536 : 0
      footage.set(id, {
        id, name: name || solidName || baseName(path) || (solid ? 'Solid' : 'Footage'), path, solid,
        width: w >= 1 && w <= 16384 ? w : 1920, height: h >= 1 && h <= 16384 ? h : 1080,
        fps: fr >= 1 && fr <= 960 ? fr : 30, duration: sv > 0 && sd / sv > 0 && sd / sv < 36000 ? sd / sv : 0,
      })
    }
  }
  // resolve layer sources: the ldta holds the source item id somewhere; we matched candidates later
  const known = new Set<number>([...footage.keys(), ...compIds])
  for (const c of comps) for (const l of c.layers) {
    l.sourceId = l.ld ? scanSourceId(l.ld) : null
    delete l.ld
    if (l.sourceId === c.id) l.sourceId = null
    const f = l.sourceId != null ? footage.get(l.sourceId) : undefined
    if (l.kind === 'source' && f?.solid && /^Null( \d+)?$/.test(f.name) && f.width === 100 && f.height === 100) l.kind = 'null'
    if (l.kind === 'source' && l.sourceId == null && /^Shape Layer/i.test(l.name)) l.kind = 'shape'
    if (l.kind === 'source' && l.sourceId == null) l.kind = 'null'
  }
  return { comps, footage }

  function scanSourceId(ld: Uint8Array): number | null {
    // boltframe layout: source id at offset 40; fall back to scanning for any known item id
    const at40 = u32(ld, 40)
    if (known.has(at40)) return at40
    for (let o = 4; o + 4 <= ld.length; o++) { const v = u32(ld, o); if (v && known.has(v)) return v }
    return null
  }
}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|mxf|wmv|flv|mpg|mpeg|gif)$/i
const AUDIO_EXT = /\.(mp3|wav|aac|m4a|ogg|flac|aif|aiff|opus)$/i
function kindOfPath(p: string): AssetMeta['kind'] { return AUDIO_EXT.test(p) ? 'audio' : VIDEO_EXT.test(p) ? 'video' : 'image' }

export interface AepImportResult { doc: ProjectDoc; missing: string[] }

/** Parse a .aep / .aepx file into an AnimeStudio project. */
export async function importAfterEffectsProject(file: File): Promise<ProjectDoc> {
  const root = /\.aepx$/i.test(file.name) ? parseAepx(await file.text()) : parseRifx(new Uint8Array(await file.arrayBuffer()))
  return aeModelToDoc(readModel(root), file.name.replace(/\.(aep|aepx)$/i, ''))
}

export function aeModelToDoc(model: ReturnType<typeof readModel>, projectName: string): ProjectDoc {
  const { comps, footage } = model
  if (comps.length === 0) comps.push({ id: -1, name: projectName || 'Comp 1', width: 1920, height: 1080, fps: 30, duration: 10, layers: [] })
  const doc = createDefaultProject(projectName || 'After Effects Project')
  doc.tracks = []
  // offline footage placeholders, relinked by file name on import
  const assetOf = new Map<number, AssetMeta>()
  for (const f of footage.values()) {
    if (f.solid) continue
    const a: AssetMeta = { id: uid('asset'), name: baseName(f.path) || f.name, kind: kindOfPath(f.path || f.name), url: '', duration: f.duration || 10, width: f.width, height: f.height, fps: f.fps, size: 0, missingPath: f.path || f.name }
    assetOf.set(f.id, a)
    doc.assets.push(a)
  }
  // main comp = not used inside another comp, with the most layers
  const used = new Set<number>()
  for (const c of comps) for (const l of c.layers) if (l.sourceId != null) used.add(l.sourceId)
  const main = [...comps].sort((a, b) => Number(used.has(a.id)) - Number(used.has(b.id)) || b.layers.length - a.layers.length)[0]
  const precompId = new Map<number, string>()
  for (const c of comps) if (c !== main) precompId.set(c.id, uid('precomp'))

  const build = (c: AEComp): { composition: Composition; tracks: Track[]; clips: Clip[] } => {
    const composition: Composition = { width: c.width, height: c.height, fps: c.fps, duration: c.duration, background: '#000000' }
    const tracks: Track[] = []
    const clips: Clip[] = []
    for (const l of c.layers) {
      if (l.kind === 'light') continue
      const src = l.sourceId != null ? footage.get(l.sourceId) : undefined
      const asset = l.sourceId != null ? assetOf.get(l.sourceId) : undefined
      const pre = l.sourceId != null ? precompId.get(l.sourceId) : undefined
      const name = l.name || src?.name || asset?.name || comps.find(x => x.id === l.sourceId)?.name || l.kind
      const isAudio = asset?.kind === 'audio'
      const track: Track = { id: uid('track'), kind: isAudio ? 'audio' : l.kind === 'text' ? 'text' : 'video', name: name.slice(0, 28), locked: false, visible: true, muted: false, height: 44 }
      tracks.push(track)
      const base = { ...makeClipBase(track.id, name.slice(0, 40), 0, c.duration), threeD: !!l.threeD, ...(l.motionBlur ? { motionBlur: true } : {}) }
      let clip: Clip
      if (l.adjustment) clip = { ...base, kind: 'adjustment', affectCount: 0, label: defaultLabel('adjustment') } as Clip
      else if (l.kind === 'text') clip = { ...base, kind: 'text', label: defaultLabel('text'), text: { content: name, font: 'Inter', size: Math.round(c.height / 10), color: '#ffffff', strokeColor: '#000000', strokeWidth: 0, weight: 700, align: 'center', letterSpacing: 0, shadow: false, animation: 'none', animationDuration: 0.5 } } as Clip
      else if (l.kind === 'camera') clip = { ...base, kind: 'camera', camera: { positionX: 0, positionY: 0, positionZ: -c.height, rotationX: 0, rotationY: 0, rotationZ: 0, focalLength: Math.round(c.height * 1.2), zoom: 1, depthOfField: 0, aperture: 0.4, focusDistance: c.height } } as Clip
      else if (l.kind === 'shape') clip = { ...base, kind: 'shape', label: defaultLabel('shape'), shape: { type: 'rect', width: Math.round(c.width * 0.4), height: Math.round(c.height * 0.4), fill: '#f5f5f4', stroke: '#a1a1aa', strokeWidth: 0, cornerRadius: 0 } } as Clip
      else if (l.kind === 'null') clip = { ...base, kind: 'null', label: defaultLabel('null') } as Clip
      else if (pre) clip = { ...base, kind: 'precomp', precompId: pre } as Clip
      else if (src?.solid) clip = { ...base, kind: 'solid', label: defaultLabel('solid'), color: '#808080' } as Clip
      else if (asset?.kind === 'audio') clip = { ...base, kind: 'audio', assetId: asset.id, inPoint: 0, fadeIn: 0, fadeOut: 0, volume: 1, label: defaultLabel('audio') } as Clip
      else if (asset?.kind === 'image') clip = { ...base, kind: 'image', assetId: asset.id, label: defaultLabel('image') } as Clip
      else if (asset) clip = { ...base, kind: 'video', assetId: asset.id, inPoint: 0, tracking: null, trackingTarget: null, label: defaultLabel('video') } as Clip
      else clip = { ...base, kind: 'null', label: defaultLabel('null') } as Clip
      if (l.effects?.length) clip.effects = l.effects.map(t => ({ id: uid('fx'), type: t, enabled: true, params: Object.fromEntries(EFFECT_MAP[t].params.map(p => [p.key, p.default])), paramKeyframes: {} }))
      clips.push(clip)
    }
    return { composition, tracks, clips }
  }
  const m = build(main)
  doc.name = projectName || main.name
  doc.composition = m.composition
  doc.tracks = m.tracks.length ? m.tracks : createDefaultProject().tracks
  doc.clips = m.clips
  const precomps: Precomp[] = []
  for (const c of comps) if (c !== main) precomps.push({ id: precompId.get(c.id)!, name: c.name, ...build(c) })
  doc.precomps = precomps
  return doc
}

/** Exposed for tests. */
export const __aep = { parseRifx, parseAepx, readModel }
