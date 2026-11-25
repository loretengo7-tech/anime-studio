/**
 * ANIME STUDIO — AE-style expressions.
 *
 * An expression is JavaScript evaluated per frame for one transform group
 * ('position' | 'scale' | 'rotation' | 'opacity' | 'anchor'). Units match the
 * AE timeline: position/anchor in px ([x, y]), scale in % ([100, 100]),
 * rotation in degrees, opacity 0–100.
 *
 * Available: value, time, inPoint, outPoint, index, fps, thisLayer.name,
 * wiggle(freq, amp[, octaves, ampMult, t]), loopOut(type), loopIn(type),
 * valueAtTime(t), velocity, linear(), ease(), easeIn(), easeOut(), clamp(),
 * random(), noise(), seedRandom(n), degreesToRadians(), radiansToDegrees(),
 * timeToFrames(), framesToTime(), add/sub/mul/div/length, Math.* (sin, cos…).
 * Plus anime helpers: shake(amp, freq, decay) and beat(bpm) → 0..1 pulse.
 */
import type { Clip, KeyframeTrack } from './types'

export type ExprGroup = 'position' | 'scale' | 'rotation' | 'opacity' | 'anchor'
export const PROP_GROUP: Record<string, { group: ExprGroup; index: number }> = {
  x: { group: 'position', index: 0 }, y: { group: 'position', index: 1 },
  anchorX: { group: 'anchor', index: 0 }, anchorY: { group: 'anchor', index: 1 },
  scale: { group: 'scale', index: 0 }, rotation: { group: 'rotation', index: 0 }, opacity: { group: 'opacity', index: 0 },
}
const GROUP_PROPS: Record<ExprGroup, string[]> = {
  position: ['x', 'y'], anchor: ['anchorX', 'anchorY'], scale: ['scale', 'scale'], rotation: ['rotation'], opacity: ['opacity'],
}
/** engine units → AE display units */
const MUL: Record<ExprGroup, number> = { position: 1, anchor: 1, scale: 100, rotation: 1, opacity: 100 }

type Raw = (clip: Clip, prop: string, localTime: number) => number

const compiled = new Map<string, Function | Error>()
export const exprErrors = new Map<string, string>() // key `${clipId}:${group}` → message

function compile(src: string): Function | Error {
  let fn = compiled.get(src)
  if (fn) return fn
  try {
    new Function(src) // syntax check only
    // eval() returns the completion value of the last statement = AE semantics
    fn = new Function('ctx', '__src', 'with (ctx) { return eval(__src) }')
  } catch (e) {
    fn = e instanceof Error ? e : new Error(String(e))
  }
  compiled.set(src, fn)
  return fn
}

// ---- deterministic noise ----
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123
  return x - Math.floor(x)
}
function noise1(x: number, seed: number): number {
  const i = Math.floor(x), f = x - i
  const u = f * f * (3 - 2 * f)
  const a = hash(i + seed * 57.3) * 2 - 1, b = hash(i + 1 + seed * 57.3) * 2 - 1
  return a + (b - a) * u
}
function strSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) % 10007
}

const vecOp = (a: number | number[], b: number | number[], op: (x: number, y: number) => number): number | number[] => {
  if (Array.isArray(a) || Array.isArray(b)) {
    const A = Array.isArray(a) ? a : [a, a], B = Array.isArray(b) ? b : [b, b]
    return A.map((v, i) => op(v, B[i] ?? B[0]))
  }
  return op(a, b)
}

function interp(t: number, tMin: number, tMax: number, v1: number | number[], v2: number | number[], fn: (u: number) => number) {
  const u = fn(Math.max(0, Math.min(1, (t - tMin) / ((tMax - tMin) || 1))))
  return vecOp(v1, v2, (a, b) => a + (b - a) * u)
}

/**
 * Evaluate the expression of `clip` for engine property `prop` at clip-local
 * time. `raw` evaluates keyframes/static value WITHOUT expressions.
 * Returns null when the property has no (valid) expression.
 */
export function evalExpression(clip: Clip, prop: string, localTime: number, raw: Raw, layerIndex = 0, fps = 30): number | null {
  const pg = PROP_GROUP[prop]
  if (!pg) return null
  const src = clip.expressions?.[pg.group]
  if (!src || !src.trim()) return null
  const fn = compile(src)
  const errKey = `${clip.id}:${pg.group}`
  if (fn instanceof Error) { exprErrors.set(errKey, fn.message); return null }

  const group = pg.group
  const mul = MUL[group]
  const props = GROUP_PROPS[group]
  const isVec = group === 'position' || group === 'anchor' || group === 'scale'
  const valAt = (lt: number): number | number[] => {
    if (!isVec) return raw(clip, props[0], lt) * mul
    return [raw(clip, props[0], lt) * mul, raw(clip, props[1], lt) * mul]
  }
  const value = valAt(localTime)
  const seed = strSeed(clip.id + group)
  const comp = (t: number) => t - clip.start // comp time → local
  const time = clip.start + localTime

  // keyframe range of the group (for loopOut/loopIn)
  const tracks = props.map(p => clip.keyframes.find(k => k.property === p)).filter(Boolean) as KeyframeTrack[]
  let k0 = Infinity, k1 = -Infinity
  for (const t of tracks) for (const kf of t.keyframes) { k0 = Math.min(k0, kf.time); k1 = Math.max(k1, kf.time) }

  let rnd = seed
  const ctx = {
    value, time, fps, index: layerIndex,
    inPoint: clip.start, outPoint: clip.start + clip.duration,
    thisLayer: { name: clip.name, index: layerIndex, inPoint: clip.start, outPoint: clip.start + clip.duration },
    thisComp: { frameDuration: 1 / fps },
    Math, PI: Math.PI,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
    min: Math.min, max: Math.max, pow: Math.pow, sqrt: Math.sqrt, exp: Math.exp, log: Math.log, atan2: Math.atan2,
    valueAtTime: (t: number) => valAt(comp(t)),
    get velocity() {
      const dt = 1 / 120
      return vecOp(valAt(localTime + dt), valAt(localTime - dt), (a, b) => (a - b) / (2 * dt))
    },
    wiggle: (freq: number, amp: number, octaves = 1, ampMult = 0.5, t = time) => {
      const w = (dim: number) => {
        let s = 0, a = 1, f = freq, norm = 0
        for (let o = 0; o < Math.max(1, octaves); o++) { s += noise1(t * f, seed + dim * 13 + o * 7) * a; norm += a; a *= ampMult; f *= 2 }
        return (s / (norm || 1)) * amp
      }
      return Array.isArray(value) ? value.map((v, i) => v + w(i)) : (value as number) + w(0)
    },
    noise: (x: number) => noise1(x, seed),
    seedRandom: (n: number) => { rnd = seed + n * 101 },
    random: (a?: number | number[], b?: number | number[]) => {
      rnd += 1
      const r = hash(rnd)
      if (a === undefined) return r
      if (b === undefined) return vecOp(a, 0, x => x * r)
      return vecOp(a, b, (x, y) => x + (y - x) * r)
    },
    loopOut: (type = 'cycle') => {
      if (!(k1 > k0) || localTime <= k1) return value
      const dur = k1 - k0
      const over = localTime - k1
      if (type === 'pingpong') {
        const c = Math.floor(over / dur), r = over % dur
        return valAt(c % 2 === 0 ? k1 - r : k0 + r)
      }
      if (type === 'offset') {
        const c = Math.floor(over / dur) + 1
        const delta = vecOp(valAt(k1), valAt(k0), (a, b) => a - b)
        return vecOp(valAt(k0 + (over % dur)), vecOp(delta, c, (a, n) => a * n), (a, b) => a + b)
      }
      if (type === 'continue') {
        const dt = 1 / 120
        const v = vecOp(valAt(k1), valAt(k1 - dt), (a, b) => (a - b) / dt)
        return vecOp(valAt(k1), vecOp(v, over, (a, s) => a * s), (a, b) => a + b)
      }
      return valAt(k0 + (over % dur))
    },
    loopIn: (type = 'cycle') => {
      if (!(k1 > k0) || localTime >= k0) return value
      const dur = k1 - k0
      const under = k0 - localTime
      if (type === 'pingpong') { const c = Math.floor(under / dur), r = under % dur; return valAt(c % 2 === 0 ? k0 + r : k1 - r) }
      return valAt(k1 - (under % dur))
    },
    linear: (t: number, a: number, b: number, c?: number | number[], d?: number | number[]) =>
      c === undefined ? interp(t, 0, 1, a, b, u => u) : interp(t, a, b, c, d ?? c, u => u),
    ease: (t: number, a: number, b: number, c?: number | number[], d?: number | number[]) =>
      c === undefined ? interp(t, 0, 1, a, b, u => u * u * (3 - 2 * u)) : interp(t, a, b, c, d ?? c, u => u * u * (3 - 2 * u)),
    easeIn: (t: number, a: number, b: number, c: number | number[], d: number | number[]) => interp(t, a, b, c, d, u => u * u),
    easeOut: (t: number, a: number, b: number, c: number | number[], d: number | number[]) => interp(t, a, b, c, d, u => 1 - (1 - u) * (1 - u)),
    clamp: (v: number, a: number, b: number) => Math.max(a, Math.min(b, v)),
    add: (a: number | number[], b: number | number[]) => vecOp(a, b, (x, y) => x + y),
    sub: (a: number | number[], b: number | number[]) => vecOp(a, b, (x, y) => x - y),
    mul: (a: number | number[], b: number | number[]) => vecOp(a, b, (x, y) => x * y),
    div: (a: number | number[], b: number | number[]) => vecOp(a, b, (x, y) => x / (y || 1)),
    length: (a: number[] | number, b?: number[]) => Array.isArray(a) ? Math.hypot(...(b ? a.map((v, i) => v - b[i]) : a)) : Math.abs(a),
    degreesToRadians: (d: number) => (d * Math.PI) / 180,
    radiansToDegrees: (r: number) => (r * 180) / Math.PI,
    timeToFrames: (t = time) => Math.round(t * fps),
    framesToTime: (f: number) => f / fps,
    // ---- AnimeStudio helpers ----
    /** impact shake that decays from the layer in-point (or from `at`) */
    shake: (amp = 30, freq = 18, decay = 4, at = clip.start) => {
      const tt = Math.max(0, time - at)
      const k = amp * Math.exp(-decay * tt)
      return Array.isArray(value)
        ? value.map((v, i) => v + noise1(tt * freq, seed + i * 31) * k)
        : (value as number) + noise1(tt * freq, seed) * k
    },
    /** 1 on each beat decaying to 0 — `value + beat(128)*20` */
    beat: (bpm = 120, sharpness = 6) => {
      const ph = (time * bpm / 60) % 1
      return Math.exp(-sharpness * ph)
    },
  }
  let out: unknown
  try {
    out = fn(ctx, src)
    exprErrors.delete(errKey)
  } catch (e) {
    exprErrors.set(errKey, e instanceof Error ? e.message : String(e))
    return null
  }
  let n: number
  if (Array.isArray(out)) n = Number(out[pg.index] ?? out[0])
  else n = Number(out)
  if (!Number.isFinite(n)) { exprErrors.set(errKey, 'Expression result is not a number'); return null }
  return n / mul
}

export const EXPRESSION_PRESETS: { label: string; group: ExprGroup | 'any'; code: string }[] = [
  { label: 'wiggle(3, 25)', group: 'any', code: 'wiggle(3, 25)' },
  { label: 'Impact shake', group: 'position', code: 'shake(40, 20, 5)' },
  { label: 'Beat pulse 128 bpm', group: 'scale', code: 'add(value, mul([10, 10], beat(128)))' },
  { label: 'loopOut("cycle")', group: 'any', code: 'loopOut("cycle")' },
  { label: 'loopOut("pingpong")', group: 'any', code: 'loopOut("pingpong")' },
  { label: 'Spin 90°/s', group: 'rotation', code: 'value + time * 90' },
  { label: 'Flicker', group: 'opacity', code: 'random(40, 100)' },
  { label: 'Float', group: 'position', code: 'add(value, [0, Math.sin(time * 2) * 12])' },
]
