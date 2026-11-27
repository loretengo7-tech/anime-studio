/**
 * ANIME STUDIO — "Template from an edit"
 *
 *  1. analyzeReference(): measures the reference edit ON THE DEVICE — cuts (frame
 *     difference), white flashes (brightness spikes), motion per shot, beats + BPM of
 *     its music, and grabs small frames at the start/middle/end of each shot.
 *  2. requestTemplate(): sends those measurements + frames to Claude, which describes
 *     each shot (role, what kind of clip fits, zoom / pan / shake, speed ramp, effects,
 *     flash, text). Timings always come from the measurement, never from the model.
 *  3. buildTemplateProject(): a new project with the reference music, one placeholder
 *     layer per shot ("slot") carrying the moves and effects, flash layers, a global FX
 *     adjustment layer, cut markers and the beat grid.
 *  4. fillTemplate(): replaces every slot with the user's clips (keeping timing, moves,
 *     effects and the speed ramp). Run it again to shuffle.
 */
import { z } from 'zod'
import type Anthropic from '@anthropic-ai/sdk'
import type { AssetMeta, Clip, ProjectDoc, Track, AIOperation } from '@/lib/engine/types'
import { createDefaultProject, makeClipBase, uid, defaultLabel } from '@/lib/engine/types'
import { EFFECT_MAP } from '@/lib/engine/effects'
import { VELOCITY_PRESETS } from '@/lib/engine/speed'
import { executeOperations } from '@/lib/engine/aiTools'
import { detectBeats } from '@/lib/engine/audio'
import { askClaude } from './aiClient'

// ================================================================ 1. analysis

export interface Segment { i: number; start: number; end: number; motion: number; brightness: number }
export interface EditAnalysis {
  assetId: string
  name: string
  duration: number
  fps: number
  width: number
  height: number
  cuts: number[]
  flashes: number[]
  beats: number[]
  bpm: number
  segments: Segment[]
  frames: { seg: number; at: number; pos: 'start' | 'mid' | 'end'; jpeg: string }[] // base64 (no data: prefix)
}
export interface AnalysisProgress { phase: string; progress: number }

function seek(el: HTMLVideoElement, t: number): Promise<void> {
  return new Promise(resolve => {
    let done = false
    const fin = () => { if (done) return; done = true; clearTimeout(cap); el.removeEventListener('seeked', fin); resolve() }
    el.addEventListener('seeked', fin)
    const cap = setTimeout(fin, 2500)
    try { el.currentTime = t } catch { fin() }
  })
}
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }

export async function analyzeReference(asset: AssetMeta, onProgress: (p: AnalysisProgress) => void, isCancelled: () => boolean = () => false): Promise<EditAnalysis> {
  const el = document.createElement('video')
  el.muted = true; el.playsInline = true; el.preload = 'auto'; el.crossOrigin = 'anonymous'
  el.src = asset.url
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('The video did not load')), 20000)
    el.onloadeddata = () => { clearTimeout(t); res() }
    el.onerror = () => { clearTimeout(t); rej(new Error('The video could not be decoded')) }
  })
  const duration = Math.max(0.2, el.duration || asset.duration)
  const vw = el.videoWidth || asset.width, vh = el.videoHeight || asset.height
  // sampling: 12 samples/s up to ~900 samples
  const rate = Math.max(3, Math.min(12, 900 / duration))
  const n = Math.max(2, Math.floor(duration * rate))
  const W = 64, H = Math.max(8, Math.round(64 * vh / Math.max(1, vw)))
  const small = document.createElement('canvas'); small.width = W; small.height = H
  const sctx = small.getContext('2d', { willReadFrequently: true })!
  const lum: Float32Array[] = []
  const bright: number[] = [], diff: number[] = [0]
  for (let k = 0; k < n; k++) {
    if (isCancelled()) throw new Error('Cancelled')
    await seek(el, Math.min(duration - 0.01, (k + 0.5) / rate))
    sctx.drawImage(el, 0, 0, W, H)
    const d = sctx.getImageData(0, 0, W, H).data
    const l = new Float32Array(W * H)
    let sum = 0
    for (let i = 0; i < l.length; i++) { l[i] = (d[i * 4] * 0.2126 + d[i * 4 + 1] * 0.7152 + d[i * 4 + 2] * 0.0722) / 255; sum += l[i] }
    bright.push(sum / l.length)
    if (k > 0) { const p = lum[k - 1]; let s = 0; for (let i = 0; i < l.length; i++) s += Math.abs(l[i] - p[i]); diff.push(s / l.length) }
    lum.push(l)
    if (k % 6 === 0) onProgress({ phase: 'Reading the edit frame by frame…', progress: 0.05 + 0.55 * (k / n) })
  }
  // flashes: brightness spike above the local median that falls back quickly
  const flashes: number[] = []
  for (let k = 1; k < n - 1; k++) {
    const win = bright.slice(Math.max(0, k - 6), Math.min(n, k + 7))
    if (bright[k] - median(win) > 0.22 && bright[k] > 0.6 && bright[k] >= bright[k - 1] && bright[k] >= bright[k + 1]) {
      const t = (k + 0.5) / rate
      if (!flashes.length || t - flashes[flashes.length - 1] > 0.2) flashes.push(+t.toFixed(3))
    }
  }
  // cuts: big frame difference vs the clip's typical motion (flash frames excluded)
  const md = median(diff.slice(1))
  const thr = Math.max(0.09, md * 3.5)
  const cuts: number[] = []
  const frameDiff = (x: number, y: number) => { const p = lum[x], q = lum[y]; let s = 0; for (let i = 0; i < p.length; i++) s += Math.abs(p[i] - q[i]); return s / p.length }
  for (let k = 1; k < n; k++) {
    const t = k / rate
    if (diff[k] < thr) continue
    if (flashes.some(f => Math.abs(f - t) < 0.12)) continue
    if (!cuts.length || t - cuts[cuts.length - 1] > 0.15) cuts.push(+t.toFixed(3))
  }
  // AMV classic: a white flash hides the cut — compare the picture before and after the flash
  for (const f of flashes) {
    const k = Math.round(f * rate - 0.5)
    let a = k - 1, b = k + 1
    while (b < n - 1 && bright[b] - median(bright.slice(Math.max(0, k - 6), Math.min(n, k + 7))) > 0.15) b++
    if (a < 0 || b >= n) continue
    if (frameDiff(a, b) > thr) {
      const t = +(b / rate).toFixed(3)
      if (!cuts.some(c => Math.abs(c - t) < 0.15)) cuts.push(t)
    }
  }
  cuts.sort((x, y) => x - y)
  // segments between cuts (merge the shortest when there are too many for one request)
  let bounds = [0, ...cuts, duration]
  while (bounds.length - 1 > 48) {
    let mi = 1, ml = Infinity
    for (let j = 1; j < bounds.length - 1; j++) { const l = bounds[j + 1] - bounds[j - 1]; if (l < ml) { ml = l; mi = j } }
    bounds.splice(mi, 1)
  }
  const segments: Segment[] = []
  for (let j = 0; j < bounds.length - 1; j++) {
    const a = bounds[j], b = bounds[j + 1]
    const ks: number[] = []; for (let k = Math.ceil(a * rate) + 1; k < Math.floor(b * rate); k++) ks.push(k)
    const motion = ks.length ? ks.reduce((s, k) => s + diff[k], 0) / ks.length : 0
    const br = ks.length ? ks.reduce((s, k) => s + bright[k], 0) / ks.length : bright[Math.min(n - 1, Math.floor(a * rate))]
    segments.push({ i: j, start: +a.toFixed(3), end: +b.toFixed(3), motion: +(motion * 100).toFixed(2), brightness: +br.toFixed(2) })
  }
  // frames for Claude: start/mid/end of each shot (≤ 40 images, 256 px wide JPEG)
  onProgress({ phase: 'Picking key frames…', progress: 0.62 })
  const fw = 256, fh = Math.max(16, Math.round(256 * vh / Math.max(1, vw)))
  const fc = document.createElement('canvas'); fc.width = fw; fc.height = fh
  const fctx = fc.getContext('2d')!
  const picks: { seg: number; at: number; pos: 'start' | 'mid' | 'end' }[] = []
  const triple = segments.length <= 13
  for (const s of segments) {
    const len = s.end - s.start
    if (triple && len > 0.5) picks.push({ seg: s.i, at: s.start + Math.min(0.08, len * 0.1), pos: 'start' })
    picks.push({ seg: s.i, at: s.start + len / 2, pos: 'mid' })
    if (triple && len > 0.5) picks.push({ seg: s.i, at: s.end - Math.min(0.08, len * 0.1), pos: 'end' })
  }
  const step = Math.max(1, Math.ceil(picks.length / 40))
  const frames: EditAnalysis['frames'] = []
  for (let k = 0; k < picks.length; k += step) {
    if (isCancelled()) throw new Error('Cancelled')
    const p = picks[k]
    await seek(el, Math.min(duration - 0.01, p.at))
    fctx.drawImage(el, 0, 0, fw, fh)
    frames.push({ ...p, at: +p.at.toFixed(3), jpeg: fc.toDataURL('image/jpeg', 0.72).split(',')[1] })
    onProgress({ phase: 'Picking key frames…', progress: 0.62 + 0.18 * (k / picks.length) })
  }
  el.removeAttribute('src'); el.load()
  // music: beats + BPM
  onProgress({ phase: 'Listening to the music (beats)…', progress: 0.82 })
  let beats: number[] = [], bpm = 0
  try { const r = await detectBeats(asset.url); beats = r.beats.map(b => +b.toFixed(3)); bpm = Math.round(r.bpm) } catch { /* no audio track */ }
  onProgress({ phase: 'Analysis done', progress: 1 })
  return { assetId: asset.id, name: asset.name, duration: +duration.toFixed(3), fps: asset.fps || 30, width: vw, height: vh, cuts, flashes, beats, bpm, segments, frames }
}

// ================================================================ 2. Claude

const TEMPLATE_EFFECTS = ['glow', 'sx_deep_glow', 'rgb_split', 'chromatic_aberration', 'sx_chroma', 'zoom_blur', 'directional_blur', 'radial_blur', 'speed_lines', 'sx_speed_burst',
  'glitch', 'sx_glitch', 'sx_vhs', 'exposure', 'contrast', 'saturation', 'vignette', 'film_grain', 'sx_film', 'motion_echo', 'camera_shake', 'impact_flash', 'sx_light_leak',
  'sx_light_rays', 'sx_shockwave', 'sx_duotone', 'posterize_time', 'hue_shift', 'tint', 'gaussian_blur', 'sx_ink', 'sx_posterize', 'sharpen'].filter(t => EFFECT_MAP[t])
const CAMERA = ['none', 'zoom_in', 'zoom_out', 'pan_left_right', 'pan_right_left', 'rotate', 'ken_burns', 'push_in_shake'] as const
const VELOCITY = ['none', ...Object.keys(VELOCITY_PRESETS)]

const EffectZ = z.object({ type: z.string(), params: z.record(z.string(), z.number()).optional() })
const SegZ = z.object({
  i: z.number().int(),
  role: z.string().default('shot'),
  slotHint: z.string().default('any clip'),
  camera: z.object({ type: z.string().default('none'), intensity: z.number().default(1) }).default({ type: 'none', intensity: 1 }),
  shake: z.number().default(0),
  velocity: z.object({ preset: z.string().default('none'), intensity: z.number().default(1) }).default({ preset: 'none', intensity: 1 }),
  flashIn: z.boolean().default(false),
  effects: z.array(EffectZ).default([]),
  text: z.object({ content: z.string(), animation: z.string().optional() }).nullable().optional(),
})
export const TemplateZ = z.object({
  name: z.string().default('AI Template'),
  summary: z.string().default(''),
  style: z.array(z.string()).default([]),
  segments: z.array(SegZ),
  global: z.object({ effects: z.array(EffectZ).default([]) }).default({ effects: [] }),
})
export type TemplateSpec = z.infer<typeof TemplateZ>

function catalog(): string {
  return TEMPLATE_EFFECTS.map(t => {
    const d = EFFECT_MAP[t]
    return `- ${t} (${d.name}): ${d.params.map(p => `${p.key} ${p.min}..${p.max} (default ${p.default})`).join(', ')}`
  }).join('\n')
}

const SYSTEM = `You are the template designer of ANIME STUDIO, an anime / AMV video editor.
You receive the MEASURED structure of a reference edit (shots with exact start/end, cut times, white-flash times, motion energy per shot, beats and BPM of its music) and frames from each shot (labelled shot index + start/mid/end).
Your job: describe each shot so the editor can rebuild the same edit as a reusable template the user fills with their own clips.

Rules:
- Timings are measured: never invent or change times. Return exactly one entry per measured shot, same "i".
- Compare the start/mid/end frames of a shot to tell zoom in/out, pans, rotation and shake. High motion with similar framing usually means shake or fast action; a big scale change means a zoom.
- "velocity" = speed ramp of the clip inside the shot. Use a preset only when the shot clearly speeds up/slows down (motion bursts on the beat, slow-motion feel).
- "flashIn": true when the shot starts with a white flash (a flash time falls on its start).
- Effects: only from the catalog below, only the ones you can actually see (glow on bright highlights, RGB split / chromatic on impacts, zoom blur on fast zooms, film grain/VHS look, color grade via saturation/contrast/tint...). Keep params inside the ranges. 0-3 effects per shot.
- "global.effects": looks applied to the WHOLE edit (overall color grade, grain, vignette).
- "slotHint": the kind of clip that fits that shot, short (e.g. "close-up face, calm", "fast action / attack", "wide scenery", "character turning").
- "role": one of intro, build, drop, impact, calm, outro.
- "text": only if the frames show on-screen text (copy it); otherwise null.
- "name": a short catchy template name; "summary": one sentence about the style; "style": 2-5 tags.

Camera types: ${CAMERA.join(', ')} (intensity 0.3-2).
Shake: 0 (none) to 2 (violent).
Velocity presets: ${VELOCITY.join(', ')} (intensity 0.3-2).
Effect catalog:
${''}`

export async function requestTemplate(a: EditAnalysis, userNotes: string, signal?: AbortSignal): Promise<TemplateSpec> {
  const measured = {
    duration: a.duration, fps: a.fps, size: `${a.width}x${a.height}`, bpm: a.bpm,
    beats: a.beats.slice(0, 400), cuts: a.cuts, flashes: a.flashes,
    shots: a.segments.map(s => ({ i: s.i, start: s.start, end: s.end, length: +(s.end - s.start).toFixed(3), motion: s.motion, brightness: s.brightness })),
  }
  const content: Anthropic.ContentBlockParam[] = [{ type: 'text', text: `MEASURED STRUCTURE:\n${JSON.stringify(measured)}` }]
  for (const f of a.frames) {
    content.push({ type: 'text', text: `shot ${f.seg} · ${f.pos} · t=${f.at}s` })
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.jpeg } })
  }
  content.push({ type: 'text', text: `${userNotes.trim() ? `USER NOTES: ${userNotes.trim()}\n` : ''}Answer ONLY with JSON (no markdown) of this shape:
{"name": string, "summary": string, "style": string[], "global": {"effects": [{"type": string, "params": {..}}]}, "segments": [{"i": number, "role": string, "slotHint": string, "camera": {"type": string, "intensity": number}, "shake": number, "velocity": {"preset": string, "intensity": number}, "flashIn": boolean, "effects": [{"type": string, "params": {..}}], "text": {"content": string, "animation": string} | null}]}` })
  const raw = await askClaude({ system: SYSTEM + catalog(), messages: [{ role: 'user', content }], maxTokens: 32000, signal })
  const i0 = raw.indexOf('{'), i1 = raw.lastIndexOf('}')
  if (i0 < 0 || i1 <= i0) throw new Error('Claude did not return a template (no JSON in the answer).')
  let json: unknown
  try { json = JSON.parse(raw.slice(i0, i1 + 1)) } catch { throw new Error('The template JSON from Claude was malformed — try again.') }
  const r = TemplateZ.safeParse(json)
  if (!r.success) throw new Error(`The template did not match the expected format: ${r.error.issues[0]?.message ?? 'invalid'}`)
  return sanitize(r.data, a)
}

/** Keep only valid shots / effects / presets and clamp every value. */
function sanitize(t: TemplateSpec, a: EditAnalysis): TemplateSpec {
  const fx = (list: { type: string; params?: Record<string, number> }[]) => list
    .filter(e => TEMPLATE_EFFECTS.includes(e.type))
    .slice(0, 4)
    .map(e => {
      const def = EFFECT_MAP[e.type]
      const params: Record<string, number> = {}
      for (const p of def.params) { const v = e.params?.[p.key]; params[p.key] = typeof v === 'number' && Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : p.default }
      return { type: e.type, params }
    })
  const byI = new Map(t.segments.map(s => [s.i, s]))
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo))
  return {
    ...t,
    name: t.name.slice(0, 60) || 'AI Template',
    segments: a.segments.map(seg => {
      const s = byI.get(seg.i)
      return {
        i: seg.i,
        role: s?.role?.slice(0, 20) ?? 'shot',
        slotHint: s?.slotHint?.slice(0, 60) ?? 'any clip',
        camera: { type: s && (CAMERA as readonly string[]).includes(s.camera.type) ? s.camera.type : 'none', intensity: clamp(s?.camera.intensity ?? 1, 0.2, 2) },
        shake: clamp(s?.shake ?? 0, 0, 2),
        velocity: { preset: s && VELOCITY.includes(s.velocity.preset) ? s.velocity.preset : 'none', intensity: clamp(s?.velocity.intensity ?? 1, 0.2, 2) },
        flashIn: !!s?.flashIn || a.flashes.some(f => Math.abs(f - seg.start) < 0.12),
        effects: fx(s?.effects ?? []),
        text: s?.text ?? null,
      }
    }),
    global: { effects: fx(t.global.effects) },
  }
}

// ================================================================ 3. build

const SLOT_COLORS = ['#3a4a6b', '#4b3a6b', '#3a6b5a', '#6b4a3a', '#5a3a6b', '#3a5f6b', '#6b3a4f', '#4f6b3a']

export function buildTemplateProject(t: TemplateSpec, a: EditAnalysis, ref: AssetMeta): ProjectDoc {
  const doc = createDefaultProject(`Template · ${t.name}`)
  const W = Math.max(16, Math.round(a.width / 2) * 2), H = Math.max(16, Math.round(a.height / 2) * 2)
  doc.composition = { width: W, height: H, fps: Math.round(a.fps) || 30, duration: a.duration, background: '#000000' }
  const tr = (kind: Track['kind'], name: string, height = 56): Track => ({ id: uid('track'), kind, name, locked: false, visible: true, muted: false, height })
  const tText = tr('text', 'Text', 44), tFlash = tr('video', 'Flashes', 40), tFx = tr('adjustment', 'Global FX', 36), tSlots = tr('video', 'Slots (your clips)', 64), tMusic = tr('audio', 'Music', 56)
  doc.tracks = [tText, tFlash, tFx, tSlots, tMusic]
  doc.assets = [ref]
  doc.bpm = a.bpm
  doc.beats = a.beats
  doc.markers = a.cuts.map(c => ({ id: uid('mk'), time: c, label: 'cut', color: '#2d8ceb' }))
  // music of the reference (the edit's audio)
  doc.clips.push({ ...makeClipBase(tMusic.id, `${ref.name} (music)`, 0, a.duration), kind: 'audio', assetId: ref.id, inPoint: 0, fadeIn: 0, fadeOut: 0, volume: 1, label: defaultLabel('audio') } as Clip)
  // slots
  const ops: AIOperation[] = []
  t.segments.forEach((s, k) => {
    const seg = a.segments[k]
    const id = uid('clip')
    const len = Math.max(0.05, seg.end - seg.start)
    doc.clips.push({
      ...makeClipBase(tSlots.id, `Slot ${k + 1} · ${s.slotHint}`, seg.start, len), id, kind: 'solid', color: SLOT_COLORS[k % SLOT_COLORS.length], label: 8,
      templateSlot: { index: k, role: s.role, hint: s.slotHint, velocity: s.velocity.preset, velocityIntensity: s.velocity.intensity },
    } as Clip)
    if (s.camera.type !== 'none') ops.push({ op: 'camera_move', clipId: id, type: s.camera.type, intensity: s.camera.intensity })
    if (s.shake > 0.05) ops.push({ op: 'impact_shake', clipId: id, atTime: seg.start, intensity: s.shake, duration: Math.min(len, 0.25 + 0.2 * s.shake) })
    for (const e of s.effects) ops.push({ op: 'apply_effect', clipId: id, effect: e.type, params: e.params })
    if (s.text?.content) ops.push({ op: 'add_text', text: s.text.content.slice(0, 80), start: seg.start, duration: len, animation: s.text.animation, trackId: tText.id })
  })
  // white flashes: measured ones + shots that start with a flash
  const flashTimes: number[] = []
  for (const x of [...a.flashes, ...t.segments.filter(s => s.flashIn).map(s => a.segments[s.i]?.start ?? 0)].sort((p, q) => p - q)) {
    if (!flashTimes.length || x - flashTimes[flashTimes.length - 1] > 0.15) flashTimes.push(+x.toFixed(3)) // one flash per moment
  }
  for (const ft of flashTimes) {
    const d = Math.min(0.22, Math.max(0.05, a.duration - ft))
    doc.clips.push({
      ...makeClipBase(tFlash.id, 'Flash', ft, d), kind: 'solid', color: '#ffffff', blendMode: 'add', label: 2,
      keyframes: [{ property: 'opacity', keyframes: [{ id: uid('kf'), time: 0, value: 1, easing: 'linear' }, { id: uid('kf'), time: d, value: 0, easing: 'easeOut' }] }],
    } as Clip)
  }
  // global look
  if (t.global.effects.length) {
    const gid = uid('clip')
    doc.clips.push({ ...makeClipBase(tFx.id, 'Global look', 0, a.duration), id: gid, kind: 'adjustment', affectCount: 0, label: defaultLabel('adjustment') } as Clip)
    for (const e of t.global.effects) ops.push({ op: 'apply_effect', clipId: gid, effect: e.type, params: e.params })
  }
  const r = executeOperations(doc, ops)
  return r.doc
}

// ================================================================ 4. fill

/** Put the user's clips into the template slots (round-robin, random in-points). Returns how many slots were filled. */
export function fillTemplate(doc: ProjectDoc, clipAssets: AssetMeta[], opts: { shuffle?: boolean } = {}): { doc: ProjectDoc; filled: number } {
  const slots = doc.clips.filter(c => c.templateSlot).sort((x, y) => x.start - y.start)
  if (!slots.length || !clipAssets.length) return { doc, filled: 0 }
  const pool = opts.shuffle ? [...clipAssets].sort(() => Math.random() - 0.5) : clipAssets
  const d: ProjectDoc = JSON.parse(JSON.stringify(doc))
  const ops: AIOperation[] = []
  slots.forEach((slot, k) => {
    const a = pool[k % pool.length]
    const c = d.clips.find(x => x.id === slot.id)!
    const sp = c.templateSlot!.velocity !== 'none' ? 1.6 : 1 // velocity ramps eat more source
    const need = c.duration * sp
    const room = Math.max(0, (a.duration || need) - need)
    const inPoint = a.kind === 'video' ? +(room * (opts.shuffle ? Math.random() : 0.35)).toFixed(3) : 0
    const base = { ...c } as Record<string, unknown>
    delete base.color; delete base.assetId; delete base.inPoint; delete base.timeRemap
    const next = (a.kind === 'image'
      ? { ...base, kind: 'image', assetId: a.id, timeRemap: null }
      : { ...base, kind: 'video', assetId: a.id, inPoint, tracking: null, trackingTarget: null, timeRemap: null }) as unknown as Clip
    d.clips[d.clips.indexOf(c)] = next
    if (a.kind === 'video' && next.templateSlot!.velocity !== 'none') ops.push({ op: 'apply_velocity_preset', clipId: c.id, preset: next.templateSlot!.velocity, intensity: next.templateSlot!.velocityIntensity })
  })
  const r = ops.length ? executeOperations(d, ops).doc : d
  return { doc: r, filled: slots.length }
}

/** Put a slot back to its placeholder look. */
export function clearTemplate(doc: ProjectDoc): ProjectDoc {
  const d: ProjectDoc = JSON.parse(JSON.stringify(doc))
  d.clips = d.clips.map(c => {
    if (!c.templateSlot || c.kind === 'solid') return c
    const base = { ...c } as Record<string, unknown>
    delete base.assetId; delete base.inPoint; delete base.tracking; delete base.trackingTarget
    return { ...base, kind: 'solid', color: SLOT_COLORS[c.templateSlot.index % SLOT_COLORS.length], timeRemap: null } as unknown as Clip
  })
  return d
}

// ================================================================ library

export interface SavedTemplate { id: string; savedAt: number; spec: TemplateSpec; analysis: Omit<EditAnalysis, 'frames'>; ref: AssetMeta }
const LS = 'anime-studio:ai-templates'
export function listTemplates(): SavedTemplate[] { try { return JSON.parse(localStorage.getItem(LS) || '[]') } catch { return [] } }
export function saveTemplate(spec: TemplateSpec, a: EditAnalysis, ref: AssetMeta): SavedTemplate {
  const { frames: _f, ...analysis } = a
  const item: SavedTemplate = { id: uid('tpl'), savedAt: Date.now(), spec, analysis, ref: { ...ref, thumbnails: ref.thumbnails?.slice(0, 1) } }
  const all = [item, ...listTemplates()].slice(0, 30)
  try { localStorage.setItem(LS, JSON.stringify(all)) } catch { /* full */ }
  return item
}
export function deleteTemplate(id: string) { try { localStorage.setItem(LS, JSON.stringify(listTemplates().filter(t => t.id !== id))) } catch { } }
