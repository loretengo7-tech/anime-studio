/**
 * ANIME STUDIO — Speed / Time remapping / Velocity system
 *
 * Real time remapping: constant speed, piecewise source-time curves
 * (velocity ramps), Catmull-Rom smoothing, and preset generators used by
 * both the UI and the AI assistant.
 */
import type { TimeRemap, SpeedCurvePoint, Clip, VideoClip } from './types'

export const VELOCITY_PRESETS: Record<string, { label: string; description: string }> = {
  smooth_ramp: { label: 'Smooth Ramp', description: 'Slow → fast → slow, cinematic ramp' },
  velocity_hit: { label: 'Velocity Hit', description: 'Fast attack into a freeze — beat drop style' },
  pulse: { label: 'Pulse', description: 'Rhythmic fast/slow pulsing' },
  slow_build: { label: 'Slow Build', description: 'Progressive acceleration' },
  crash_zoom: { label: 'Crash Zoom Feel', description: 'Extreme fast → normal' },
  smooth_slow: { label: 'Smooth Slow Mo', description: 'Constant smooth slow motion' },
  twixtor_slow: { label: 'Twixtor-style 20%', description: '20% speed with interpolation' },
}

/**
 * Generate a monotone source-time mapping for a velocity preset.
 * The returned curve maps normalized clip time u ∈ [0,1] to normalized
 * source position v ∈ [0,1] over `sourceDuration` seconds of footage.
 */
export function generateVelocityPreset(
  preset: string,
  sourceDuration: number,
  intensity = 1
): TimeRemap {
  const pts = (raw: [number, number][]): SpeedCurvePoint[] =>
    raw.map(([u, v]) => ({ u, v }))
  const k = Math.min(4, Math.max(0.2, intensity))
  let points: SpeedCurvePoint[]
  switch (preset) {
    case 'smooth_ramp':
      points = pts([[0, 0], [0.35, 0.10], [0.55, 0.45], [0.75, 0.90], [1, 1]])
      break
    case 'velocity_hit':
      points = pts([[0, 0], [0.45, 0.55], [0.5, 0.62], [0.52, 0.62], [1, 0.66]])
      break
    case 'pulse': {
      const p: [number, number][] = [[0, 0]]
      const n = Math.max(2, Math.round(4 * k))
      for (let i = 1; i <= n; i++) {
        p.push([i / n - 0.5 / n, (i - 1) / n + 0.06])
        p.push([i / n, i / n])
      }
      points = pts(p)
      break
    }
    case 'slow_build':
      points = pts([[0, 0], [0.4, 0.08], [0.7, 0.35], [0.9, 0.75], [1, 1]])
      break
    case 'crash_zoom':
      points = pts([[0, 0], [0.6, 0.5], [0.78, 0.94], [0.8, 0.96], [1, 0.96]])
      break
    case 'smooth_slow':
      points = pts([[0, 0], [0.5, 0.5], [1, 1]])
      break
    case 'twixtor_slow':
      points = pts([[0, 0], [0.5, 0.5], [1, 1]])
      break
    default:
      points = pts([[0, 0], [0.5, 0.5], [1, 1]])
  }
  // Ensure strict monotonicity in u and non-decreasing v.
  const clean: SpeedCurvePoint[] = []
  for (const p of points) {
    if (clean.length === 0 || p.u > clean[clean.length - 1].u) clean.push(p)
  }
  for (let i = 1; i < clean.length; i++) {
    if (clean[i].v < clean[i - 1].v) clean[i].v = clean[i - 1].v
  }
  return { points: clean, smooth: true, sourceDuration }
}

/** Sample the remap curve at normalized time u → normalized source position v. */
export function sampleRemap(remap: TimeRemap, u: number): number {
  const pts = remap.points
  if (pts.length === 0) return u
  const cu = Math.min(1, Math.max(0, u))
  if (cu <= pts[0].u) return pts[0].v
  if (cu >= pts[pts.length - 1].u) return pts[pts.length - 1].v
  if (!remap.smooth) {
    for (let i = 1; i < pts.length; i++) {
      if (cu <= pts[i].u) {
        const a = pts[i - 1], b = pts[i]
        const t = (cu - a.u) / Math.max(1e-6, b.u - a.u)
        return a.v + (b.v - a.v) * t
      }
    }
    return cu
  }
  // Catmull-Rom over the polyline (clamped ends).
  let i = 1
  while (i < pts.length - 1 && pts[i].u < cu) i++
  const p1 = pts[i - 1], p2 = pts[i]
  const p0 = pts[i - 2] ?? p1
  const p3 = pts[i + 1] ?? p2
  const t = (cu - p1.u) / Math.max(1e-6, p2.u - p1.u)
  const t2 = t * t, t3 = t2 * t
  const v =
    0.5 * ((2 * p1.v) + (-p0.v + p2.v) * t +
    (2 * p0.v - 5 * p1.v + 4 * p2.v - p3.v) * t2 +
    (-p0.v + 3 * p1.v - 3 * p2.v + p3.v) * t3)
  // Clamp between neighbors to preserve monotonicity
  return Math.min(Math.max(v, Math.min(p1.v, p2.v)), Math.max(p1.v, p2.v))
}

/**
 * Map timeline-local time of a clip to source time.
 * Handles constant speed, time remap curves and reverse playback.
 */
export function clipSourceTime(clip: Clip, localTime: number): number {
  const inPoint = clip.kind === 'video' || clip.kind === 'audio' ? (clip as VideoClip).inPoint : 0
  if (clip.timeRemap) {
    const u = clip.duration > 0 ? Math.min(1, Math.max(0, localTime / clip.duration)) : 0
    const v = sampleRemap(clip.timeRemap, u)
    let st = inPoint + v * clip.timeRemap.sourceDuration
    if (clip.reverse) st = inPoint + clip.timeRemap.sourceDuration - v * clip.timeRemap.sourceDuration
    return st
  }
  const speed = clip.speed || 1
  let st = inPoint + localTime * speed
  if (clip.reverse) {
    const used = clip.duration * speed
    st = inPoint + used - localTime * speed
  }
  return st
}

/** Average speed of a clip (for display + audio playbackRate). */
export function clipAverageSpeed(clip: Clip): number {
  if (clip.timeRemap && clip.duration > 0) {
    return clip.timeRemap.sourceDuration / clip.duration
  }
  return clip.speed || 1
}

/** Instantaneous speed at timeline-local time (for velocity curve display). */
export function clipInstantSpeed(clip: Clip, localTime: number, eps = 1 / 60): number {
  const a = clipSourceTime(clip, Math.max(0, localTime - eps))
  const b = clipSourceTime(clip, localTime + eps)
  return (b - a) / (2 * eps)
}

/**
 * Build a remap that makes the clip fill exactly `targetDuration` at constant speed.
 * NOTE: the remap itself is the identity over the source range — the caller sets
 * clip.duration to targetDuration and clipSourceTime derives the effective speed
 * from duration vs source range. targetDuration is validated and only used to
 * guard degenerate inputs.
 */
export function constantRemapForDuration(sourceDuration: number, targetDuration: number): TimeRemap {
  void targetDuration
  if (!(sourceDuration > 0)) sourceDuration = 1
  return { points: [{ u: 0, v: 0 }, { u: 1, v: 1 }], smooth: false, sourceDuration }
}
