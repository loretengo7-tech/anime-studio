/**
 * ANIME STUDIO — Keyframe evaluation & easing
 *
 * Real interpolation engine: linear, hold, standard eases, cubic bezier
 * with editable handles, and value sampling over any keyed property.
 */
import type { Clip, EasingName, Keyframe, KeyframeTrack, TransformProperty, EffectInstance } from './types'

export function ease(name: EasingName, t: number, handles?: Keyframe['handles']): number {
  const x = Math.min(1, Math.max(0, t))
  switch (name) {
    case 'hold': return 0
    case 'linear': return x
    case 'easeIn': return x * x
    case 'easeOut': return 1 - (1 - x) * (1 - x)
    case 'easeInOut': return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2
    case 'easeOutBack': {
      const c1 = 1.70158, c3 = c1 + 1
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
    }
    case 'easeInBack': {
      const c1 = 1.70158, c3 = c1 + 1
      return c3 * x * x * x - c1 * x * x
    }
    case 'easeOutElastic': {
      const c4 = (2 * Math.PI) / 3
      return x === 0 ? 0 : x === 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1
    }
    case 'expoOut': return x === 1 ? 1 : 1 - Math.pow(2, -10 * x)
    case 'expoIn': return x === 0 ? 0 : Math.pow(2, 10 * x - 10)
    case 'circOut': return Math.sqrt(1 - Math.pow(x - 1, 2))
    case 'bezier': {
      if (!handles) return x
      // Cubic bezier with P0=(0,0) P3=(1,1), control points from handles (absolute in unit space)
      const [h1, h2] = handles
      return cubicBezierY(h1.x, h1.y, h2.x, h2.y, x)
    }
    default: return x
  }
}

/** Solve y(t) of a cubic bezier defined by control points (x1,y1),(x2,y2) at given x. */
export function cubicBezierY(x1: number, y1: number, x2: number, y2: number, x: number): number {
  // Newton-Raphson then bisection fallback — standard approach for timing functions.
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  let t = x
  for (let i = 0; i < 8; i++) {
    const dx = sampleX(t) - x
    if (Math.abs(dx) < 1e-5) return sampleY(t)
    const d = sampleDX(t)
    if (Math.abs(d) < 1e-6) break
    t -= dx / d
  }
  let lo = 0, hi = 1
  t = x
  for (let i = 0; i < 20; i++) {
    const v = sampleX(t)
    if (Math.abs(v - x) < 1e-5) break
    if (v < x) lo = t; else hi = t
    t = (lo + hi) / 2
  }
  return sampleY(t)
}

function sortKeys(kf: Keyframe[]): Keyframe[] {
  return [...kf].sort((a, b) => a.time - b.time)
}

/**
 * Evaluate a keyframe track at clip-local time.
 * If no keyframes or before/after, returns `fallback` when provided.
 */
export function evalKeyframeTrack(
  track: KeyframeTrack | undefined,
  time: number,
  fallback?: number
): number | undefined {
  if (!track || track.keyframes.length === 0) return fallback
  const keys = sortKeys(track.keyframes)
  if (time <= keys[0].time) return keys[0].value
  if (time >= keys[keys.length - 1].time) return keys[keys.length - 1].value
  let i = 0
  while (i < keys.length - 1 && keys[i + 1].time <= time) i++
  const a = keys[i], b = keys[i + 1]
  if (a.easing === 'hold') return a.value
  const span = b.time - a.time
  const t = span <= 0 ? 1 : (time - a.time) / span
  const e = ease(a.easing === 'bezier' ? 'bezier' : a.easing, t, a.easing === 'bezier' ? a.handles : undefined)
  return a.value + (b.value - a.value) * e
}

/** Evaluate a transform property on a clip at clip-local time (seconds). */
export function evalProperty(clip: Clip, prop: TransformProperty | 'volume', time: number): number {
  const track = clip.keyframes.find(k => k.property === prop)
  const fallback =
    prop === 'x' ? clip.x :
    prop === 'y' ? clip.y :
    prop === 'z' ? (clip as { z?: number }).z ?? 0 :
    prop === 'scale' ? clip.scale :
    prop === 'rotation' ? clip.rotation :
    prop === 'opacity' ? clip.opacity :
    prop === 'anchorX' ? clip.anchorX :
    prop === 'anchorY' ? clip.anchorY :
    (clip.kind === 'audio' ? clip.volume : 0)
  const v = evalKeyframeTrack(track, time, fallback)
  return v ?? 0
}

/** Evaluate an effect parameter with optional keyframes. */
export function evalEffectParam(effect: EffectInstance, param: string, time: number): number {
  const kf = effect.paramKeyframes?.[param]
  if (kf && kf.length > 0) {
    const v = evalKeyframeTrack({ property: param, keyframes: kf }, time, effect.params[param])
    if (v !== undefined) return v
  }
  return effect.params[param]
}

/** True if the property has keyframes on the clip. */
export function isAnimated(clip: Clip, prop: string): boolean {
  const track = clip.keyframes.find(k => k.property === prop)
  return !!track && track.keyframes.length > 0
}

/**
 * Analytic velocity of a property at time (finite difference on evaluation —
 * used for motion blur shutter direction).
 */
export function propertyVelocity(clip: Clip, prop: string, time: number, dt = 1 / 120): number {
  const a = evalKeyframeTrack(clip.keyframes.find(k => k.property === prop), time - dt) as number | undefined
  const b = evalKeyframeTrack(clip.keyframes.find(k => k.property === prop), time + dt) as number | undefined
  if (a === undefined || b === undefined) return 0
  return (b - a) / (2 * dt)
}

export function addKeyframeToTrack(track: KeyframeTrack, kf: Keyframe): KeyframeTrack {
  const keyframes = [...track.keyframes.filter(k => Math.abs(k.time - kf.time) > 1e-4), kf].sort((a, b) => a.time - b.time)
  return { ...track, keyframes }
}
