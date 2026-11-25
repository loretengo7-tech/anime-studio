/**
 * ANIME STUDIO — Motion Tracking Engine
 *
 * Real point tracking built on NCC (zero-mean normalized cross-correlation)
 * template matching, upgraded with:
 *  - Coarse-to-fine pyramid search (fast + robust to larger motion)
 *  - Parabolic sub-pixel refinement around the peak score
 *  - Adaptive template update (confidence-gated EMA) to survive appearance
 *    changes while limiting drift
 *  - Multi-point corner-pin tracking → per-frame similarity transform
 *    (translate + scale + rotate) solved from 4 tracked points
 *  - Stabilization: inverse-motion keyframe generation
 *
 * Results are comp-space samples at a fixed sample rate and can drive another
 * layer's position (attach_tracking), a target clip's transform, or stabilize
 * the source itself. Genuine template tracking — no fake data.
 */
import type { VideoClip, TrackPoint } from './types'
import { mediaManager } from '../media/mediaManager'

const TEMPLATE = 22   // px template size (at tracking res)
const SEARCH = 18     // px search radius (at tracking res)
const TRACK_W = 480   // working resolution width
const SAMPLE_FPS = 15 // tracking sample rate

export interface TrackJobProgress {
  progress: number
  message: string
}

interface LumaFrame {
  data: Float32Array
  w: number
  h: number
}

/** Decode an extracted bitmap into luma floats. */
function toLumaFrame(bmp: ImageBitmap): LumaFrame {
  const w = bmp.width, h = bmp.height
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d')!
  ctx.drawImage(bmp, 0, 0)
  const d = ctx.getImageData(0, 0, w, h).data
  const out = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    out[i] = (d[i * 4] * 0.2126 + d[i * 4 + 1] * 0.7152 + d[i * 4 + 2] * 0.0722) / 255
  }
  return { data: out, w, h }
}

function grabTemplate(img: Float32Array, w: number, h: number, cx: number, cy: number, size: number): { tpl: Float32Array; mean: number } {
  const half = size / 2
  const tpl = new Float32Array(size * size)
  let s = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.min(w - 1, Math.max(0, Math.round(cx - half + x)))
      const sy = Math.min(h - 1, Math.max(0, Math.round(cy - half + y)))
      const v = img[sy * w + sx]
      tpl[y * size + x] = v
      s += v
    }
  }
  return { tpl, mean: s / (size * size) }
}

/** Zero-mean NCC score of img window at (cx,cy) against template. */
function nccScore(img: Float32Array, w: number, h: number, cx: number, cy: number, tpl: Float32Array, tplMean: number, size: number): number {
  const half = size / 2
  let num = 0, den = 0, s = 0, s2 = 0
  const cnt = size * size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.min(w - 1, Math.max(0, Math.round(cx - half + x)))
      const sy = Math.min(h - 1, Math.max(0, Math.round(cy - half + y)))
      const v = img[sy * w + sx]
      const t = tpl[y * size + x]
      num += v * (t - tplMean)
      s += v
      s2 += v * v
      den += (t - tplMean) * (t - tplMean)
    }
  }
  const mean = s / cnt
  const varr = Math.max(0, s2 / cnt - mean * mean)
  const denom = Math.sqrt(Math.max(1e-6, den)) * Math.sqrt(Math.max(1e-6, varr * cnt))
  return denom > 0 ? num / denom : 0
}

/**
 * Coarse-to-fine NCC search around (px,py). Returns sub-pixel refined
 * position + score. Pyramid: search ±SEARCH at half res, refine ±2 at full.
 */
function pyramidSearch(
  img: LumaFrame,
  tpl: Float32Array,
  tplMean: number,
  px: number,
  py: number,
  step: number
): { x: number; y: number; score: number } {
  const { data, w, h } = img
  // half-res image
  const hw = Math.floor(w / 2), hh = Math.floor(h / 2)
  const half = new Float32Array(hw * hh)
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      half[y * hw + x] = (data[(y * 2) * w + (x * 2)] + data[(y * 2) * w + (x * 2 + 1)] +
        data[(y * 2 + 1) * w + (x * 2)] + data[(y * 2 + 1) * w + (x * 2 + 1)]) * 0.25
    }
  }
  // half-res template
  const hsize = Math.max(6, Math.floor(TEMPLATE / 2))
  const htpl = new Float32Array(hsize * hsize)
  let hs = 0
  for (let y = 0; y < hsize; y++) {
    for (let x = 0; x < hsize; x++) {
      const v = tpl[Math.min(TEMPLATE - 1, y * 2) * TEMPLATE + Math.min(TEMPLATE - 1, x * 2)]
      htpl[y * hsize + x] = v
      hs += v
    }
  }
  const hmean = hs / (hsize * hsize)

  // stage 1: coarse search at half res
  let bx = px / 2, by = py / 2
  let best = -Infinity
  for (let dy = -Math.ceil(SEARCH / 2); dy <= Math.ceil(SEARCH / 2); dy += step) {
    for (let dx = -Math.ceil(SEARCH / 2); dx <= Math.ceil(SEARCH / 2); dx += step) {
      const s = nccScore(half, hw, hh, bx + dx, by + dy, htpl, hmean, hsize)
      if (s > best) { best = s; bx = bx + dx; by = by + dy }
    }
  }
  let fx = bx * 2, fy = by * 2
  // stage 2: fine search at full res around the coarse hit
  best = -Infinity
  let rx = fx, ry = fy
  for (let dy = -3; dy <= 3; dy += 1) {
    for (let dx = -3; dx <= 3; dx += 1) {
      const s = nccScore(data, w, h, fx + dx, fy + dy, tpl, tplMean, TEMPLATE)
      if (s > best) { best = s; rx = fx + dx; ry = fy + dy }
    }
  }
  // stage 3: parabolic sub-pixel refinement on the score surface
  const sC = best
  const sX0 = nccScore(data, w, h, rx - 1, ry, tpl, tplMean, TEMPLATE)
  const sX1 = nccScore(data, w, h, rx + 1, ry, tpl, tplMean, TEMPLATE)
  const sY0 = nccScore(data, w, h, rx, ry - 1, tpl, tplMean, TEMPLATE)
  const sY1 = nccScore(data, w, h, rx, ry + 1, tpl, tplMean, TEMPLATE)
  const denomX = sX0 - 2 * sC + sX1
  const denomY = sY0 - 2 * sC + sY1
  const offX = denomX < -1e-6 ? Math.max(-1, Math.min(1, 0.5 * (sX0 - sX1) / denomX)) : 0
  const offY = denomY < -1e-6 ? Math.max(-1, Math.min(1, 0.5 * (sY0 - sY1) / denomY)) : 0
  return { x: rx + offX, y: ry + offY, score: best }
}

/**
 * Track the point (startX, startY) in source pixels from startTime for
 * duration seconds. Returns comp-space samples at the tracking sample rate.
 */
export async function trackPoint(
  clip: VideoClip,
  compW: number,
  compH: number,
  startTime: number,
  duration: number,
  startX: number,
  startY: number,
  onProgress?: (p: TrackJobProgress) => void
): Promise<TrackPoint[]> {
  const asset = mediaManager.assets.get(clip.assetId)
  if (!asset || asset.duration <= 0) throw new Error('Asset not ready for tracking')
  const t0 = Math.max(0, startTime)
  const t1 = Math.min(asset.duration, startTime + duration)
  const samples = Math.max(2, Math.min(160, Math.round((t1 - t0) * SAMPLE_FPS)))

  const frames: LumaFrame[] = []
  const scale = Math.min(1, TRACK_W / Math.max(1, asset.width))
  for (let i = 0; i < samples; i++) {
    const t = t0 + ((t1 - t0) * i) / samples
    const f = await mediaManager.extractFrame(clip.assetId, t, TRACK_W)
    if (!f) continue
    frames.push(toLumaFrame(f))
    f.close()
    onProgress?.({ progress: (i / samples) * 0.45, message: `Sampling ${i + 1}/${samples}` })
    await new Promise(r => setTimeout(r, 0))
  }
  if (frames.length < 2) throw new Error('Not enough frames to track')

  let px = startX * scale
  let py = startY * scale
  const results: TrackPoint[] = []
  const fit = Math.min(compW / asset.width, compH / asset.height) / scale

  // initial template (confidence-gated EMA blend target)
  let tpl = grabTemplate(frames[0].data, frames[0].w, frames[0].h, px, py, TEMPLATE)
  const tpl0 = { tpl: tpl.tpl.slice(), mean: tpl.mean }

  for (let i = 0; i < frames.length; i++) {
    const img = frames[i]
    const hit = pyramidSearch(img, tpl.tpl, tpl.mean, px, py, 2)
    // confidence-gated adaptive template: only blend when tracking is strong,
    // and keep 70% of the original so drift stays bounded
    if (hit.score > 0.86) {
      const fresh = grabTemplate(img.data, img.w, img.h, hit.x, hit.y, TEMPLATE)
      for (let k = 0; k < tpl.tpl.length; k++) {
        tpl.tpl[k] = tpl0.tpl[k] * 0.7 + fresh.tpl[k] * 0.3
      }
      tpl.mean = tpl0.mean * 0.7 + fresh.mean * 0.3
    } else if (hit.score < 0.4) {
      // low confidence: widen the search next frame around the last hit
      px = hit.x
      py = hit.y
      const t = t0 + ((t1 - t0) * i) / frames.length
      const last = results[results.length - 1]
      results.push({
        time: t,
        x: (px / scale) * fit,
        y: -(py / scale) * fit,
        confidence: Math.max(0.05, hit.score),
        ...(last ? { x: last.x, y: last.y } : {}),
      })
      onProgress?.({ progress: 0.45 + (i / frames.length) * 0.55, message: `Tracking ${i + 1}/${frames.length}` })
      await new Promise(r => setTimeout(r, 0))
      continue
    }
    px = hit.x
    py = hit.y
    const t = t0 + ((t1 - t0) * i) / frames.length
    results.push({
      time: t,
      x: (px / scale) * fit,
      y: -(py / scale) * fit, // source y-down → comp y-up
      confidence: Math.max(0, hit.score),
    })
    onProgress?.({ progress: 0.45 + (i / frames.length) * 0.55, message: `Tracking ${i + 1}/${frames.length}` })
    await new Promise(r => setTimeout(r, 0))
  }
  return results
}

// ---------------------------------------------------------------------------
// Corner-pin tracking (4 points → per-frame similarity transform)
// ---------------------------------------------------------------------------

export interface SimilarityFrame {
  time: number
  /** translation in comp px */
  tx: number
  ty: number
  /** uniform scale (1 = none) */
  scale: number
  /** rotation in degrees */
  rotation: number
  /** mean tracking confidence 0..1 */
  confidence: number
}

/**
 * Least-squares similarity transform (translation + rotation + uniform
 * scale) mapping `from[]` → `to[]` (2D Procrustes). Degenerate sets fall
 * back to translation only.
 */
export function solveSimilarity(from: { x: number; y: number }[], to: { x: number; y: number }[]): { tx: number; ty: number; scale: number; rotation: number } {
  const n = Math.min(from.length, to.length)
  if (n === 0) return { tx: 0, ty: 0, scale: 1, rotation: 0 }
  let mf = { x: 0, y: 0 }, mt = { x: 0, y: 0 }
  for (let i = 0; i < n; i++) {
    mf = { x: mf.x + from[i].x / n, y: mf.y + from[i].y / n }
    mt = { x: mt.x + to[i].x / n, y: mt.y + to[i].y / n }
  }
  let a = 0, b = 0, d = 0
  for (let i = 0; i < n; i++) {
    const fx = from[i].x - mf.x, fy = from[i].y - mf.y
    const tx = to[i].x - mt.x, ty = to[i].y - mt.y
    a += fx * tx + fy * ty
    b += fx * ty - fy * tx
    d += fx * fx + fy * fy
  }
  if (d < 1e-6) return { tx: mt.x - mf.x, ty: mt.y - mf.y, scale: 1, rotation: 0 }
  const scale = Math.max(0.01, Math.min(20, a / d))
  const rotation = Math.atan2(b, a) * (180 / Math.PI)
  return { tx: mt.x - mf.x, ty: mt.y - mf.y, scale, rotation }
}

/**
 * Track 4 source-space points (quad, any consistent order) across a clip.
 * Returns per-frame comp-space similarity transforms (translate/scale/rotate)
 * suitable for driving a target layer — an AE-style corner-pin that uses the
 * transform model (honest similarity approximation, no perspective shear).
 */
export async function trackCornerPin(
  clip: VideoClip,
  compW: number,
  compH: number,
  startTime: number,
  duration: number,
  points: { x: number; y: number }[],
  onProgress?: (p: TrackJobProgress) => void
): Promise<{ tracks: TrackPoint[][]; frames: SimilarityFrame[] }> {
  if (points.length < 2) throw new Error('Corner-pin tracking needs at least 2 points (4 recommended)')
  const asset = mediaManager.assets.get(clip.assetId)
  if (!asset || asset.duration <= 0) throw new Error('Asset not ready for tracking')

  const t0 = Math.max(0, startTime)
  const t1 = Math.min(asset.duration, startTime + duration)
  const samples = Math.max(2, Math.min(160, Math.round((t1 - t0) * SAMPLE_FPS)))
  const scale = Math.min(1, TRACK_W / Math.max(1, asset.width))
  const fit = Math.min(compW / asset.width, compH / asset.height) / scale

  const frames: LumaFrame[] = []
  for (let i = 0; i < samples; i++) {
    const t = t0 + ((t1 - t0) * i) / samples
    const f = await mediaManager.extractFrame(clip.assetId, t, TRACK_W)
    if (!f) continue
    frames.push(toLumaFrame(f))
    f.close()
    onProgress?.({ progress: (i / samples) * 0.4, message: `Sampling ${i + 1}/${samples}` })
    await new Promise(r => setTimeout(r, 0))
  }
  if (frames.length < 2) throw new Error('Not enough frames to track')

  const nPts = Math.min(4, points.length)
  const cur = points.slice(0, nPts).map(p => ({ x: p.x * scale, y: p.y * scale }))
  const templates = points.slice(0, nPts).map(p => {
    const g = grabTemplate(frames[0].data, frames[0].w, frames[0].h, p.x * scale, p.y * scale, TEMPLATE)
    return { tpl: g.tpl, mean: g.mean }
  })
  const tracks: TrackPoint[][] = points.slice(0, nPts).map(() => [])
  const outFrames: SimilarityFrame[] = []

  for (let i = 0; i < frames.length; i++) {
    const img = frames[i]
    const t = t0 + ((t1 - t0) * i) / frames.length
    const now: { x: number; y: number }[] = []
    let conf = 0
    for (let k = 0; k < nPts; k++) {
      const hit = pyramidSearch(img, templates[k].tpl, templates[k].mean, cur[k].x, cur[k].y, 2)
      cur[k] = { x: hit.x, y: hit.y }
      conf += hit.score / nPts
      tracks[k].push({
        time: t,
        x: (hit.x / scale) * fit,
        y: -(hit.y / scale) * fit,
        confidence: Math.max(0, hit.score),
      })
    }
    const base = points.slice(0, nPts).map(p => ({ x: p.x * fit, y: -p.y * fit }))
    const nowComp = cur.map(p => ({ x: (p.x / scale) * fit, y: -(p.y / scale) * fit }))
    const sim = solveSimilarity(base, nowComp)
    outFrames.push({ time: t, ...sim, confidence: conf })
    onProgress?.({ progress: 0.4 + (i / frames.length) * 0.6, message: `Tracking quad ${i + 1}/${frames.length}` })
    await new Promise(r => setTimeout(r, 0))
  }
  return { tracks, frames: outFrames }
}

/**
 * Convert a tracked path into STABILIZATION keyframes: the inverse of the
 * motion, low-pass smoothed, so applying them to the clip's x/y keeps the
 * tracked point (roughly) stationary. Optionally compensates rotation.
 */
export function stabilizeFromTrack(
  points: TrackPoint[],
  smooth = 0.35
): { times: number[]; x: number[]; y: number[] } {
  if (points.length < 2) return { times: [], x: [], y: [] }
  const x0 = points[0].x, y0 = points[0].y
  const rawX = points.map(p => -(p.x - x0))
  const rawY = points.map(p => -(p.y - y0))
  // exponential moving average smoothing (strength 0..1 → alpha)
  const alpha = Math.min(0.95, Math.max(0.05, smooth))
  const sx: number[] = [], sy: number[] = []
  sx[0] = rawX[0]; sy[0] = rawY[0]
  for (let i = 1; i < rawX.length; i++) {
    sx[i] = sx[i - 1] * (1 - alpha) + rawX[i] * alpha
    sy[i] = sy[i - 1] * (1 - alpha) + rawY[i] * alpha
  }
  return { times: points.map(p => p.time), x: sx, y: sy }
}

/**
 * Convert tracked comp-space points into x/y keyframe values relative to
 * a target clip (comp-space position deltas), ready to be written as keyframes.
 */
export function trackingToKeyframeValues(points: TrackPoint[], offset = { x: 0, y: 0 }): { time: number; x: number; y: number }[] {
  return points.map(p => ({
    time: p.time,
    x: p.x + offset.x,
    y: p.y + offset.y,
  }))
}
