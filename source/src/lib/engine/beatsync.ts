/**
 * ANIME STUDIO — Beat Sync.
 *
 * Analysis: band-weighted spectral flux (kick/snare emphasis) → onsets with
 * strength; tempo by autocorrelation; beat grid phase fitted to the onsets so
 * "beats" land on the actual pulse (not just loud moments); downbeats = the
 * grid phase (of 4) with the most energy.
 *
 * Apply: writes real keyframes / layers / markers, so everything stays
 * editable in the timeline and graph editor (and undoable as one step).
 */
import type { ProjectDoc, Clip, AudioClip, VideoClip, EasingName, KeyframeTrack } from './types'
import { uid, makeSolidClip, defaultLabel } from './types'
import { evalProperty } from './keyframes'
import { EFFECT_MAP } from './effects'

export interface BeatAnalysis {
  bpm: number
  onsets: { t: number; s: number }[] // asset time, strength 0..1
  beats: { t: number; s: number; down: boolean }[]
  duration: number
}

const cache = new Map<string, BeatAnalysis>()

function fftMag(re: Float32Array, im: Float32Array) {
  // in-place radix-2 FFT
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]] }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr
      }
    }
  }
}

export async function analyzeBeats(url: string, sensitivity = 1.3): Promise<BeatAnalysis> {
  const key = `${url}|${sensitivity}`
  const hit = cache.get(key)
  if (hit) return hit
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ctx = new AC()
  try {
    const buf = await (await fetch(url)).arrayBuffer()
    const audio = await ctx.decodeAudioData(buf)
    const sr = audio.sampleRate
    const ch0 = audio.getChannelData(0)
    const ch1 = audio.numberOfChannels > 1 ? audio.getChannelData(1) : ch0
    const N = 1024, hop = Math.round(sr * 0.01) // 10 ms hop
    const frames = Math.max(0, Math.floor((ch0.length - N) / hop))
    const re = new Float32Array(N), im = new Float32Array(N)
    const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)))
    const bins = N / 2
    let prev = new Float32Array(bins)
    const flux = new Float32Array(frames)
    const binHz = sr / N
    // weights: kick (40–150 Hz) and snare/clap (150–4k) dominate
    const weight = new Float32Array(bins).map((_, b) => { const f = b * binHz; return f < 30 ? 0 : f < 160 ? 2.2 : f < 4000 ? 1 : f < 9000 ? 0.4 : 0.1 })
    for (let f = 0; f < frames; f++) {
      const s = f * hop
      for (let i = 0; i < N; i++) { re[i] = ((ch0[s + i] + ch1[s + i]) * 0.5) * win[i]; im[i] = 0 }
      fftMag(re, im)
      const cur = new Float32Array(bins)
      let sum = 0
      for (let b = 0; b < bins; b++) {
        const m = Math.log1p(Math.hypot(re[b], im[b]) * 10)
        cur[b] = m
        const d = m - prev[b]
        if (d > 0) sum += d * weight[b]
      }
      flux[f] = sum
      prev = cur
      if (f % 2000 === 0) await new Promise(r => setTimeout(r, 0)) // keep the UI alive
    }
    // normalise + local adaptive threshold
    let mx = 1e-9
    for (const v of flux) mx = Math.max(mx, v)
    for (let i = 0; i < frames; i++) flux[i] /= mx
    const onsets: { t: number; s: number }[] = []
    const W = 30
    for (let i = 2; i < frames - 2; i++) {
      let m = 0, c = 0
      for (let j = Math.max(0, i - W); j < Math.min(frames, i + W); j++) { m += flux[j]; c++ }
      m /= c
      if (flux[i] > m * sensitivity + 0.04 && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1] && flux[i] >= flux[i - 2] && flux[i] >= flux[i + 2]) {
        const t = i * 0.01
        if (!onsets.length || t - onsets[onsets.length - 1].t > 0.09) onsets.push({ t, s: flux[i] })
      }
    }
    // tempo by autocorrelation (70–180 BPM, folded)
    let bestBpm = 120, best = -1
    for (let bpm = 70; bpm <= 180; bpm += 0.5) {
      const lag = (60 / bpm) * 100
      const l0 = Math.floor(lag), fr = lag - l0
      let sc = 0
      for (let i = 0; i + l0 + 1 < frames; i++) sc += flux[i] * (flux[i + l0] * (1 - fr) + flux[i + l0 + 1] * fr)
      if (sc > best) { best = sc; bestBpm = bpm }
    }
    // grid phase that collects the most flux
    const period = 60 / bestBpm
    let bestPhase = 0, bestPhSc = -1
    for (let ph = 0; ph < period; ph += 0.01) {
      let sc = 0
      for (let t = ph; t < frames * 0.01; t += period) sc += flux[Math.round(t * 100)] ?? 0
      if (sc > bestPhSc) { bestPhSc = sc; bestPhase = ph }
    }
    // beats: grid ticks snapped to a nearby onset when one exists (±70 ms)
    const beats: BeatAnalysis['beats'] = []
    for (let t = bestPhase, k = 0; t < frames * 0.01; t += period, k++) {
      const near = onsets.find(o => Math.abs(o.t - t) < 0.07)
      beats.push({ t: near ? near.t : t, s: near ? near.s : (flux[Math.round(t * 100)] ?? 0) * 0.6, down: false })
    }
    // downbeats: phase of 4 with the most strength
    let dp = 0, dsc = -1
    for (let p = 0; p < 4; p++) { let sc = 0; for (let i = p; i < beats.length; i += 4) sc += beats[i].s; if (sc > dsc) { dsc = sc; dp = p } }
    for (let i = dp; i < beats.length; i += 4) beats[i].down = true
    const res = { bpm: Math.round(bestBpm * 10) / 10, onsets, beats, duration: audio.duration }
    cache.set(key, res)
    return res
  } finally {
    void ctx.close()
  }
}

export type BeatMode = 'beats' | 'downbeats' | 'onsets'
export interface BeatSyncOptions {
  mode: BeatMode
  every: number          // use every Nth hit
  offset: number         // seconds (negative = earlier, anticipates the hit)
  intensity: number      // 0..2
  decay: number          // seconds the pulse takes to settle
  flash: boolean
  zoom: boolean
  shake: boolean
  rgb: boolean
  glow: boolean
  cuts: boolean
  markers: boolean
}

/** Hits of the analysis mapped to COMP time through the source layer's trim/speed. */
export function hitsInComp(a: BeatAnalysis, source: Clip, opts: Pick<BeatSyncOptions, 'mode' | 'every' | 'offset'>): { t: number; s: number }[] {
  const list = opts.mode === 'onsets' ? a.onsets.map(o => ({ t: o.t, s: o.s })) : a.beats.filter(b => opts.mode === 'beats' || b.down).map(b => ({ t: b.t, s: b.s }))
  const inP = (source as AudioClip | VideoClip).inPoint ?? 0
  const sp = Math.max(0.05, source.speed || 1)
  const out: { t: number; s: number }[] = []
  list.forEach((h, i) => {
    if (i % Math.max(1, opts.every) !== 0) return
    const ct = source.start + (h.t - inP) / sp + opts.offset
    if (ct >= source.start - 1e-3 && ct <= source.start + source.duration) out.push({ t: Math.max(0, ct), s: Math.min(1, 0.35 + h.s) })
  })
  return out
}

function addKey(c: Clip, prop: string, time: number, value: number, easing: EasingName = 'easeOut') {
  if (time < 0 || time > c.duration) return
  let tr = c.keyframes.find(k => k.property === prop) as KeyframeTrack | undefined
  if (!tr) {
    tr = { property: prop, keyframes: [] }
    c.keyframes.push(tr)
  }
  tr.keyframes = tr.keyframes.filter(k => Math.abs(k.time - time) > 1 / 240)
  tr.keyframes.push({ id: uid('kf'), time, value, easing })
  tr.keyframes.sort((a, b) => a.time - b.time)
}

function addFxKey(c: Clip, type: string, param: string, time: number, value: number, base: Record<string, number>) {
  if (time < 0 || time > c.duration) return
  let fx = c.effects.find(e => e.type === type)
  if (!fx) {
    const def = EFFECT_MAP[type]
    if (!def) return
    fx = { id: uid('fx'), type, enabled: true, params: { ...Object.fromEntries(def.params.map(p => [p.key, p.default])), ...base }, paramKeyframes: {} }
    c.effects.push(fx)
  }
  const arr = fx.paramKeyframes[param] ?? (fx.paramKeyframes[param] = [])
  const i = arr.findIndex(k => Math.abs(k.time - time) < 1 / 240)
  if (i >= 0) arr.splice(i, 1)
  arr.push({ id: uid('kf'), time, value, easing: 'easeOut' })
  arr.sort((a, b) => a.time - b.time)
}

/** Writes the beat-synced animation into the doc (call inside mutate). Returns a summary. */
export function applyBeatSync(d: ProjectDoc, hits: { t: number; s: number }[], targetIds: string[], o: BeatSyncOptions): string {
  const fps = Math.max(1, d.composition.fps)
  const fr = 1 / fps
  const targets = d.clips.filter(c => targetIds.includes(c.id) && c.kind !== 'audio')
  let n = 0
  for (const c of targets) {
    const base = { x: evalProperty(c, 'x', 0), y: evalProperty(c, 'y', 0), s: evalProperty(c, 'scale', 0) }
    let seed = 1
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 - 0.5 }
    for (const h of hits) {
      const lt = h.t - c.start
      if (lt < -o.decay || lt > c.duration) continue
      const k = o.intensity * h.s
      if (o.zoom) {
        addKey(c, 'scale', lt - fr, base.s, 'easeIn')
        addKey(c, 'scale', lt, base.s * (1 + 0.12 * k), 'expoOut')
        addKey(c, 'scale', lt + o.decay, base.s, 'easeOut')
      }
      if (o.shake) {
        const amp = 38 * k
        addKey(c, 'x', lt - fr, base.x, 'linear'); addKey(c, 'y', lt - fr, base.y, 'linear')
        const steps = Math.max(2, Math.round(o.decay / fr))
        for (let i = 0; i <= steps; i++) {
          const f = 1 - i / steps
          addKey(c, 'x', lt + i * fr, base.x + (i === steps ? 0 : rnd() * 2 * amp * f), 'linear')
          addKey(c, 'y', lt + i * fr, base.y + (i === steps ? 0 : rnd() * 2 * amp * f), 'linear')
        }
      }
      if (o.rgb) {
        addFxKey(c, 'sx_chroma', 'amount', lt - fr, 0, { amount: 0 })
        addFxKey(c, 'sx_chroma', 'amount', lt, 0.03 * k, {})
        addFxKey(c, 'sx_chroma', 'amount', lt + o.decay, 0, {})
      }
      if (o.glow) {
        const rest = 0.3
        addFxKey(c, 'sx_deep_glow', 'intensity', lt - fr, rest, { intensity: rest })
        addFxKey(c, 'sx_deep_glow', 'intensity', lt, 0.3 + 3.2 * k, {})
        addFxKey(c, 'sx_deep_glow', 'intensity', lt + o.decay * 1.4, rest, {})
      }
      n++
    }
  }
  if (o.cuts) {
    // AMV jump cuts: split every target at each hit (new segments go on their own layers)
    for (const c0 of targets) {
      let cur: Clip | undefined = d.clips.find(x => x.id === c0.id)
      for (const h of hits) {
        if (!cur) break
        const local = h.t - cur.start
        if (local <= fr || local >= cur.duration - fr) continue
        const right = JSON.parse(JSON.stringify(cur)) as Clip
        right.id = uid('clip')
        right.start = cur.start + local
        right.duration = cur.duration - local
        right.keyframes = right.keyframes.map(k => ({ ...k, keyframes: k.keyframes.filter(kf => kf.time >= local).map(kf => ({ ...kf, time: kf.time - local })) }))
        if ((right.kind === 'video' || right.kind === 'audio') && (cur.kind === 'video' || cur.kind === 'audio')) right.inPoint = cur.inPoint + local * (cur.speed || 1)
        cur.duration = local
        d.clips.push(right)
        cur = right
      }
    }
  }
  if (o.flash && hits.length) {
    const track = { id: uid('track'), kind: 'video' as const, name: 'Beat Flash', locked: false, visible: true, muted: false, height: 64 }
    d.tracks.unshift(track)
    const t0 = Math.max(0, hits[0].t - 0.1)
    const t1 = Math.min(d.composition.duration, hits[hits.length - 1].t + o.decay + 0.2)
    const fl = { ...makeSolidClip(track.id, t0, Math.max(0.2, t1 - t0), '#ffffff'), name: 'Beat Flash', blendMode: 'add' as const, opacity: 0, label: defaultLabel('solid') }
    for (const h of hits) {
      const lt = h.t - t0
      addKey(fl, 'opacity', lt - fr, 0, 'hold')
      addKey(fl, 'opacity', lt, Math.min(1, 0.75 * o.intensity * h.s), 'easeOut')
      addKey(fl, 'opacity', lt + Math.max(fr * 2, o.decay * 0.8), 0, 'linear')
    }
    d.clips.push(fl)
  }
  if (o.markers) for (const h of hits) d.markers.push({ id: uid('mk'), time: h.t, label: 'Beat', color: '#3ccf55' })
  d.beats = hits.map(h => h.t)
  return `${hits.length} hits · ${n} pulses on ${targets.length} layer${targets.length === 1 ? '' : 's'}`
}
