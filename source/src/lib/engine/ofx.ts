/**
 * ANIME STUDIO — OpenFX plug-ins (desktop app)
 *
 * Installed .ofx.bundle plug-ins (Sapphire, RSMB, Neat Video… in their OFX versions) are
 * described by the desktop OFX host and registered here as normal effects, so they show up
 * in Effects & Presets, Effect Controls (with keyframes) and the timeline.
 *
 * Rendering is a CPU round-trip through the host process: the layer's source frame goes out
 * as RGBA, the processed frame comes back and replaces the layer source before the GPU
 * effects. Preview is asynchronous (the frame updates as soon as the plug-in answers, the
 * last good frame is kept meanwhile); export and RAM preview wait for every frame.
 */
import type { Clip, EffectDef, EffectInstance, EffectParamDef, ImageClip, ProjectDoc, VideoClip } from './types'
import { EFFECT_DEFS, EFFECT_MAP } from './effects'
import { evalEffectParam } from './keyframes'
import { clipSourceTime } from './speed'

// ---------------------------------------------------------------- bridge

interface OfxParamInfo { name: string; type: string; label: string; dims: number; min: number; max: number; def: number[]; choices: string[]; hint: string }
export interface OfxPluginInfo { bundle: string; index: number; id: string; label: string; group: string; context: string; temporal: boolean; depth: number; params: OfxParamInfo[] }
export interface OfxScanResult { dirs: string[]; hostOk: boolean; results: { bundle: string; plugins: OfxPluginInfo[]; skipped: { index: number; id: string; reason: string }[]; err: string | null }[] }
interface Bridge {
  ofxScan: (force?: boolean) => Promise<OfxScanResult>
  ofxAddDir: () => Promise<OfxScanResult | null>
  ofxOpenDir: () => Promise<string>
  ofxRender: (req: { bundle: string; index: number; w: number; h: number; time: number; params: Record<string, number[]>; data: ArrayBuffer }) => Promise<{ data: ArrayBuffer; ms: number }>
}
function bridge(): Bridge | null {
  const d = typeof window !== 'undefined' ? (window as unknown as { animeStudioDesktop?: Partial<Bridge> }).animeStudioDesktop : undefined
  return d && typeof d.ofxRender === 'function' && typeof d.ofxScan === 'function' ? d as Bridge : null
}
export function ofxAvailable() { return !!bridge() }

// ---------------------------------------------------------------- registry

interface Mapping { bundle: string; index: number; params: { name: string; keys: string[]; spatial: boolean; isInt: boolean }[] }
const MAP = new Map<string, Mapping>() // effect type → plug-in
const LS = 'anime-studio:ofx-plugins'
let lastScan: OfxScanResult | null = null
const listeners = new Set<() => void>()
export function onOfxChange(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } }
const changed = () => { listeners.forEach(f => f()); try { window.dispatchEvent(new Event('as-effects-changed')) } catch { } }
export function ofxLastScan() { return lastScan }

function hashStr(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return (h >>> 0).toString(36) }
export function ofxTypeFor(p: { bundle: string; index: number; id: string }) { return `ofx_${hashStr(p.bundle + '|' + p.id)}_${p.index}` }
export function isOfxEffect(type: string) { return type.startsWith('ofx_') }

const sane = (v: number) => Number.isFinite(v) && Math.abs(v) < 1e8
function toDef(p: OfxPluginInfo): EffectDef {
  const params: EffectParamDef[] = []
  const mp: Mapping['params'] = []
  for (const q of p.params) {
    const isInt = /Integer|Boolean|Choice/.test(q.type)
    const spatial = q.hint === 'spatial'
    const color = /RGB/.test(q.type)
    const keys: string[] = []
    const suffix = color ? ['R', 'G', 'B', 'A'] : ['X', 'Y', 'Z']
    for (let k = 0; k < q.dims; k++) {
      const key = q.dims === 1 ? q.name : `${q.name}.${k}`
      keys.push(key)
      let min = q.min, max = q.max
      const def = q.def[k] ?? 0
      if (/Boolean/.test(q.type)) { min = 0; max = 1 }
      else if (/Choice/.test(q.type)) { min = 0; max = Math.max(0, q.choices.length - 1) }
      else if (spatial || color) { min = 0; max = 1 }
      else if (!sane(min) || !sane(max) || max <= min) {
        const span = Math.max(1, Math.abs(def) * 2)
        min = sane(min) ? min : Math.min(0, def - span); max = sane(max) && max > min ? max : Math.max(def + span, min + 1)
      }
      const label = q.dims === 1 ? q.label : `${q.label} ${suffix[k] ?? k}`
      const choiceHint = /Choice/.test(q.type) && q.choices.length ? ` (${q.choices.map((c, i) => `${i} ${c}`).join(', ')})` : ''
      params.push({
        key, label: label + choiceHint, min, max, step: isInt ? 1 : (max - min) / 200 > 0.05 ? 0.1 : 0.001, default: def,
        uniform: key, ...(/Boolean/.test(q.type) ? { kind: 'toggle' as const } : color ? { kind: 'number' as const } : {}),
      })
    }
    mp.push({ name: q.name, keys, spatial, isInt })
  }
  const type = ofxTypeFor(p)
  MAP.set(type, { bundle: p.bundle, index: p.index, params: mp })
  const bundleName = p.bundle.split(/[\\/]/).pop()!.replace(/\.ofx\.bundle$/i, '')
  return {
    type, name: p.label, category: 'stylize',
    description: `OpenFX plug-in · ${bundleName}${p.group ? ` · ${p.group}` : ''}${p.temporal ? ' · uses other frames (limited support)' : ''}`,
    params, pluginId: `ofx:${p.bundle}`, pluginName: `OpenFX${p.group ? ` · ${p.group.split('/')[0]}` : ''}`,
  }
}

function register(scan: OfxScanResult) {
  // drop previous OFX defs, add the new ones (EFFECT_MAP/EFFECT_DEFS are shared registries)
  for (let i = EFFECT_DEFS.length - 1; i >= 0; i--) if (isOfxEffect(EFFECT_DEFS[i].type)) EFFECT_DEFS.splice(i, 1)
  for (const k of Object.keys(EFFECT_MAP)) if (isOfxEffect(k)) delete EFFECT_MAP[k]
  MAP.clear()
  for (const r of scan.results) for (const p of r.plugins) {
    if (p.context !== 'OfxImageEffectContextFilter' && p.context !== 'OfxImageEffectContextGeneral') continue
    const d = toDef(p)
    EFFECT_DEFS.push(d); EFFECT_MAP[d.type] = d
  }
  lastScan = scan
  try { localStorage.setItem(LS, JSON.stringify(scan)) } catch { }
  changed()
}

/** Register the plug-ins found last time right away (projects open with their effects), then rescan. */
export function initOfx() {
  if (!bridge()) return
  try { const s = localStorage.getItem(LS); if (s) register(JSON.parse(s)) } catch { }
  void rescanOfx(false)
}
export async function rescanOfx(force = true): Promise<OfxScanResult | null> {
  const b = bridge(); if (!b) return null
  const r = await b.ofxScan(force)
  register(r)
  return r
}
export async function addOfxFolder() { const b = bridge(); if (!b) return null; const r = await b.ofxAddDir(); if (r) register(r); return r }
export async function openOfxFolder() { return bridge()?.ofxOpenDir() ?? null }

// ---------------------------------------------------------------- rendering

const PREVIEW_MAX = 1280
interface Entry { key: string; canvas: HTMLCanvasElement }
const cache = new Map<string, Entry>()           // full key → result
const lastGood = new Map<string, HTMLCanvasElement>() // clip → last processed frame (shown while the next one renders)
const inflight = new Set<string>()               // clip ids
const errors = new Map<string, string>()          // effect type → last error
let pendingCount = 0
export function ofxPending() { return pendingCount > 0 }
export function ofxError(type: string) { return errors.get(type) ?? null }

function enabledOfx(clip: Clip): EffectInstance[] { return clip.effects.filter(e => e.enabled && isOfxEffect(e.type) && MAP.has(e.type)) }
export function clipHasOfx(clip: Clip) { return clip.effects.some(e => e.enabled && isOfxEffect(e.type)) }

function paramsFor(fx: EffectInstance, local: number, w: number, h: number): Record<string, number[]> {
  const m = MAP.get(fx.type)!
  const out: Record<string, number[]> = {}
  for (const p of m.params) {
    out[p.name] = p.keys.map((k, i) => {
      let v = evalEffectParam(fx, k, local) ?? EFFECT_MAP[fx.type]?.params.find(q => q.key === k)?.default ?? 0
      if (p.spatial) v *= p.keys.length === 2 ? (i === 0 ? w : h) : w
      if (p.isInt) v = Math.round(v)
      return v
    })
  }
  return out
}
function keyFor(clip: Clip, srcKey: number, local: number, w: number, h: number) {
  const fxs = enabledOfx(clip)
  return `${clip.id}|${srcKey}|${w}x${h}|` + fxs.map(f => f.type + JSON.stringify(paramsFor(f, local, w, h))).join('|')
}
function fit(sw: number, sh: number, full: boolean) {
  const k = full ? 1 : Math.min(1, PREVIEW_MAX / Math.max(sw, sh))
  return { w: Math.max(2, Math.round(sw * k)), h: Math.max(2, Math.round(sh * k)) }
}
function srcDims(src: CanvasImageSource): [number, number] {
  const v = src as HTMLVideoElement
  if (v.videoWidth) return [v.videoWidth, v.videoHeight]
  const c = src as HTMLCanvasElement
  return [c.width || 0, c.height || 0]
}

async function process(clip: Clip, src: CanvasImageSource, local: number, srcTime: number, full: boolean, key: string, w: number, h: number) {
  const b = bridge()
  if (!b) return null
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h
  const ctx = cv.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(src, 0, 0, w, h)
  let data = ctx.getImageData(0, 0, w, h).data.buffer as ArrayBuffer
  for (const fx of enabledOfx(clip)) {
    const m = MAP.get(fx.type)!
    try {
      const r = await b.ofxRender({ bundle: m.bundle, index: m.index, w, h, time: srcTime, params: paramsFor(fx, local, w, h), data })
      data = r.data
      errors.delete(fx.type)
    } catch (e) {
      errors.set(fx.type, e instanceof Error ? e.message : String(e))
      try { window.dispatchEvent(new CustomEvent('as-ofx-error', { detail: { type: fx.type, message: errors.get(fx.type) } })) } catch { }
    }
  }
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0)
  ;(cv as unknown as { __asVer?: number }).__asVer = Date.now()
  cache.set(key, { key, canvas: cv })
  if (cache.size > 40) cache.delete(cache.keys().next().value as string)
  lastGood.set(clip.id, cv)
  return cv
}

/**
 * Called by the compositor (synchronous): the processed frame when ready, otherwise the last
 * processed frame of this layer (or the raw source) while a render is started in the background.
 */
export function ofxLayerSource(clip: Clip, src: CanvasImageSource, local: number, srcTime: number): CanvasImageSource {
  if (!enabledOfx(clip).length) return src
  const [sw, sh] = srcDims(src)
  if (!sw || !sh) return src
  // exact frame prepared for export / RAM preview?
  const fullKey = keyFor(clip, Math.round(srcTime * 1000), local, sw, sh)
  const fullHit = cache.get(fullKey)
  if (fullHit) return fullHit.canvas
  const { w, h } = fit(sw, sh, false)
  const key = keyFor(clip, Math.round(srcTime * 1000), local, w, h)
  const hit = cache.get(key)
  if (hit) return hit.canvas
  if (!inflight.has(clip.id)) {
    inflight.add(clip.id); pendingCount++
    void process(clip, src, local, srcTime, false, key, w, h).finally(() => {
      inflight.delete(clip.id); pendingCount--
      try { window.dispatchEvent(new Event('as-ofx-ready')) } catch { }
    })
  }
  return lastGood.get(clip.id) ?? src
}

/** Export / RAM preview: process every OFX layer at time `t` at full resolution and wait. */
export async function ofxPrepare(doc: ProjectDoc, t: number, provider: { get(c: VideoClip | ImageClip, st: number): unknown }) {
  if (!bridge() || !MAP.size) return
  const jobs: Promise<unknown>[] = []
  for (const c of doc.clips) {
    if ((c.kind !== 'video' && c.kind !== 'image') || t < c.start || t >= c.start + c.duration || !enabledOfx(c).length) continue
    const local = t - c.start
    const st = c.kind === 'video' ? clipSourceTime(c as VideoClip, local) : 0
    const src = provider.get(c as VideoClip | ImageClip, st) as CanvasImageSource | null
    if (!src) continue
    const [sw, sh] = srcDims(src)
    if (!sw || !sh) continue
    const key = keyFor(c, Math.round(st * 1000), local, sw, sh)
    if (cache.has(key)) continue
    jobs.push(process(c, src, local, st, true, key, sw, sh))
  }
  await Promise.all(jobs)
}
