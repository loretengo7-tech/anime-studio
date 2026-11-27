/**
 * ANIME STUDIO — AI character cut-out (rotoscoping).
 *
 * Uses MediaPipe's InteractiveSegmenter ("magic touch"): the user taps the
 * character once; every frame of the layer is segmented around that point and
 * the point follows the mask's centroid, so the cut-out tracks the character.
 * Mattes are baked once (8-bit, ≤512 px) and stored in memory + IndexedDB;
 * the compositor applies them through the "AI Cut-out" Studio FX effect.
 * Model + wasm ship with the app (public/mediapipe) so it works offline.
 */
import type { Clip, VideoClip, ImageClip, ProjectDoc } from './types'
import { mediaManager } from '../media/mediaManager'

export interface Matte { w: number; h: number; fps: number; srcStart: number; frames: Uint8Array[] }

const mattes = new Map<string, Matte>() // key = clip id
const loading = new Set<string>()
let segmenterP: Promise<unknown> | null = null

const BP = process.env.NEXT_PUBLIC_BASE_PATH || ''

async function getSegmenter(): Promise<{ segment: (img: TexImageSource, roi: unknown) => { confidenceMasks?: { getAsFloat32Array(): Float32Array; width: number; height: number; close(): void }[]; close(): void } }> {
  if (!segmenterP) {
    segmenterP = (async () => {
      const mp = await import('@mediapipe/tasks-vision')
      const base = typeof window !== 'undefined' ? new URL(`${BP}/mediapipe`, window.location.href).href : `${BP}/mediapipe`
      const fileset = await mp.FilesetResolver.forVisionTasks(base)
      const make = (delegate: 'GPU' | 'CPU') => mp.InteractiveSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${base}/magic_touch.tflite`, delegate },
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      })
      try { return await make('GPU') } catch { return await make('CPU') } // older GPUs / WebGL2-less devices
    })().catch(e => { segmenterP = null; throw e })
  }
  return segmenterP as never
}

// ---------------- persistence ----------------
const DB = 'anime-studio-mattes'
function db(): Promise<IDBDatabase | null> {
  return new Promise(res => {
    if (typeof indexedDB === 'undefined') { res(null); return }
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore('m')
    r.onsuccess = () => res(r.result)
    r.onerror = () => res(null)
  })
}
async function persist(id: string, m: Matte) {
  const d = await db(); if (!d) return
  const flat = new Uint8Array(m.w * m.h * m.frames.length)
  m.frames.forEach((f, i) => flat.set(f, i * m.w * m.h))
  await new Promise<void>(r => { const tx = d.transaction('m', 'readwrite'); tx.objectStore('m').put({ w: m.w, h: m.h, fps: m.fps, srcStart: m.srcStart, n: m.frames.length, data: new Blob([flat]) }, id); tx.oncomplete = () => r(); tx.onerror = () => r() })
  d.close()
}
async function restore(id: string): Promise<Matte | null> {
  const d = await db(); if (!d) return null
  const rec = await new Promise<{ w: number; h: number; fps: number; srcStart: number; n: number; data: Blob } | null>(r => {
    const q = d.transaction('m', 'readonly').objectStore('m').get(id); q.onsuccess = () => r(q.result ?? null); q.onerror = () => r(null)
  })
  d.close()
  if (!rec) return null
  const flat = new Uint8Array(await rec.data.arrayBuffer())
  const sz = rec.w * rec.h
  return { w: rec.w, h: rec.h, fps: rec.fps, srcStart: rec.srcStart, frames: Array.from({ length: rec.n }, (_, i) => flat.subarray(i * sz, (i + 1) * sz)) }
}
export async function deleteMatte(id: string) {
  mattes.delete(id)
  const d = await db(); if (!d) return
  d.transaction('m', 'readwrite').objectStore('m').delete(id)
}

/** Matte frame for a clip at a SOURCE time (null while not baked / loading). */
const blended = new Map<string, { key: string; data: Uint8Array }>()
let bakeGen = 0 // part of the texture key so a re-bake re-uploads
export function matteAt(clipId: string, sourceTime: number, temporal = 0): { data: Uint8Array; w: number; h: number; key: string } | null {
  const m = mattes.get(clipId)
  if (!m) {
    if (!loading.has(clipId)) {
      loading.add(clipId)
      void restore(clipId).then(r => { if (r) mattes.set(clipId, r) })
    }
    return null
  }
  const i = Math.max(0, Math.min(m.frames.length - 1, Math.round((sourceTime - m.srcStart) * m.fps)))
  const tq = Math.round(Math.max(0, Math.min(1, temporal)) * 20) / 20
  if (tq <= 0 || m.frames.length < 3) return { data: m.frames[i], w: m.w, h: m.h, key: `${clipId}:${bakeGen}:${i}` }
  // temporal smoothing: weighted average with the neighbour frames (removes AI matte jitter / flicker)
  const key = `${clipId}:${bakeGen}:${i}:t${tq}`
  const hit = blended.get(clipId)
  if (hit?.key === key) return { data: hit.data, w: m.w, h: m.h, key }
  const a = m.frames[Math.max(0, i - 1)], b = m.frames[i], c = m.frames[Math.min(m.frames.length - 1, i + 1)]
  const a2 = m.frames[Math.max(0, i - 2)], c2 = m.frames[Math.min(m.frames.length - 1, i + 2)]
  const w1 = 0.5 * tq, w2 = 0.25 * tq, w0 = 1, ws = w0 + 2 * w1 + 2 * w2
  const out = hit?.data.length === b.length ? hit.data : new Uint8Array(b.length)
  if (!a || !c || !a2 || !c2) return { data: b, w: m.w, h: m.h, key: `${clipId}:${bakeGen}:${i}` }
  for (let k = 0; k < b.length; k++) out[k] = (b[k] * w0 + (a[k] + c[k]) * w1 + (a2[k] + c2[k]) * w2) / ws
  blended.set(clipId, { key, data: out })
  return { data: out, w: m.w, h: m.h, key }
}
export function hasMatte(clipId: string) { return mattes.has(clipId) }
/** Reuse a baked matte on a copy of the layer (duplicate / text-behind sandwich). */
export function shareMatte(fromId: string, toId: string) {
  const m = mattes.get(fromId)
  if (!m) return
  mattes.set(toId, m)
  void persist(toId, m)
}

/**
 * Bake the cut-out for `clip`. `point` is normalised (0..1, y down) inside the
 * source frame at `atSourceTime`. The bake walks forward and backward from there.
 */
export async function bakeCutout(doc: ProjectDoc, clip: Clip, point: { x: number; y: number }, atSourceTime: number, onProgress: (p: number) => void, isCancelled: () => boolean, opts: { maxD?: number; merge?: boolean } = {}): Promise<number> {
  const seg = await getSegmenter()
  const MAXD = opts.maxD ?? 512
  const prev = opts.merge ? mattes.get(clip.id) : undefined
  const mergeInto = (m: Matte): Matte => {
    // "Add to cut-out": union with the existing matte (e.g. a second pick on hair or a prop)
    if (!prev || prev.w !== m.w || prev.h !== m.h || prev.frames.length !== m.frames.length) return m
    m.frames = m.frames.map((f, i) => { const o = prev.frames[i]; if (!o || !f) return f ?? o; const r = new Uint8Array(f.length); for (let k = 0; k < f.length; k++) r[k] = f[k] > o[k] ? f[k] : o[k]; return r })
    return m
  }
  if (clip.kind === 'image') {
    const src = mediaManager.get(clip as ImageClip, 0) as HTMLCanvasElement | null
    if (!src) throw new Error('Image not loaded yet')
    const { w, h, cv, ctx } = frameCanvas(src.width, src.height, MAXD)
    ctx.drawImage(src, 0, 0, w, h)
    const m = runOnce(seg, cv, point, w, h)
    const matte: Matte = mergeInto({ w, h, fps: 1, srcStart: 0, frames: [m.mask] })
    blended.delete(clip.id); bakeGen++
    mattes.set(clip.id, matte); void persist(clip.id, matte)
    onProgress(1)
    return 1
  }
  if (clip.kind !== 'video') throw new Error('Cut-out works on video and image layers')
  const vc = clip as VideoClip
  const asset = doc.assets.find(a => a.id === vc.assetId)
  if (!asset) throw new Error('Footage missing')
  const el = document.createElement('video')
  el.muted = true; el.playsInline = true; el.preload = 'auto'; el.crossOrigin = 'anonymous'
  el.src = mediaManager.hasLocalProxy(asset.id) ? (mediaManager as unknown as { proxyOverrides: Map<string, string> }).proxyOverrides.get(asset.id)! : asset.url
  await new Promise<void>((res, rej) => { el.onloadeddata = () => res(); el.onerror = () => rej(new Error('Video could not be decoded')); setTimeout(res, 8000) })
  const fps = Math.min(30, Math.max(12, doc.composition.fps))
  const sp = Math.max(0.05, vc.speed || 1)
  const srcStart = vc.inPoint
  const srcEnd = Math.min(asset.duration || el.duration, vc.inPoint + vc.duration * sp)
  const n = Math.max(1, Math.round((srcEnd - srcStart) * fps))
  const { w, h, cv, ctx } = frameCanvas(el.videoWidth, el.videoHeight, MAXD)
  const frames: Uint8Array[] = new Array(n)
  const startIdx = Math.max(0, Math.min(n - 1, Math.round((atSourceTime - srcStart) * fps)))
  let done = 0
  const walk = async (from: number, to: number, step: number) => {
    let pt = { ...point }
    for (let i = from; step > 0 ? i < to : i > to; i += step) {
      if (isCancelled()) throw new Error('Cancelled')
      await mediaManager.seek(el, srcStart + i / fps, { exact: true })
      ctx.drawImage(el, 0, 0, w, h)
      const r = runOnce(seg, cv, pt, w, h)
      frames[i] = r.mask
      if (r.area > w * h * 0.002) pt = r.centroid // follow the character
      done++
      onProgress(done / n)
    }
  }
  await walk(startIdx, n, 1)
  await walk(startIdx - 1, -1, -1)
  el.removeAttribute('src'); el.load()
  const matte: Matte = mergeInto({ w, h, fps, srcStart, frames })
  blended.delete(clip.id)
  bakeGen++
  mattes.set(clip.id, matte)
  void persist(clip.id, matte)
  return n
}

function frameCanvas(sw: number, sh: number, maxD: number) {
  const k = Math.min(1, maxD / Math.max(sw, sh))
  const w = Math.max(2, Math.round(sw * k)), h = Math.max(2, Math.round(sh * k))
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h
  const ctx = cv.getContext('2d', { willReadFrequently: true })!
  return { w, h, cv, ctx }
}

function runOnce(seg: Awaited<ReturnType<typeof getSegmenter>>, img: HTMLCanvasElement, pt: { x: number; y: number }, w: number, h: number) {
  const res = seg.segment(img, { keypoint: { x: Math.min(0.999, Math.max(0.001, pt.x)), y: Math.min(0.999, Math.max(0.001, pt.y)) } })
  const cm = res.confidenceMasks?.[0]
  const out = new Uint8Array(w * h)
  let sx = 0, sy = 0, area = 0
  if (cm) {
    const f = cm.getAsFloat32Array()
    const mw = cm.width, mh = cm.height
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = f[Math.floor((y * mh) / h) * mw + Math.floor((x * mw) / w)]
      const b = Math.max(0, Math.min(255, Math.round(v * 255)))
      out[y * w + x] = b
      if (b > 127) { sx += x; sy += y; area++ }
    }
  }
  res.close()
  return { mask: out, area, centroid: area ? { x: sx / area / w, y: sy / area / h } : pt }
}
