/**
 * ANIME STUDIO — Video Lab
 *
 * Topaz-style enhancement + Flowframes-style frame interpolation for whole
 * clips. Renders a NEW video file (that you can drop on the timeline or use
 * to replace the clip), like those standalone tools do.
 *
 * Two engines:
 *  - GPU (any device): exact per-frame decode → GPU restore/upscale chain
 *    (enhance.ts) → dense optical-flow in-betweens (interpolation.ts,
 *    pyramidal Horn–Schunck, occlusion-aware) with scene-cut detection →
 *    WebCodecs H.264 + AAC (original audio kept).
 *  - ffmpeg (desktop app): motion-compensated interpolation (minterpolate
 *    MCI/AOBMC, bidirectional ME, scene-change detection), hqdn3d denoise,
 *    lanczos upscale, unsharp line recovery, x264 — fast and robust.
 */
import type { AssetMeta } from './types'
import { enhanceRenderer, type EnhanceParams } from './enhance'
import { PairInterpolator, type InterpQuality } from './interpolation'
import { desktopBridge } from '../media/mediaManager'

export type InterpMethod = 'flow' | 'mci' | 'blend' | 'dup'

export interface LabOptions {
  /** null = no enhancement pass */
  enhance: EnhanceParams | null
  /** output frame rate; null = keep source fps (no interpolation) */
  targetFps: number | null
  /** Slow motion: keep the SOURCE fps and play the new frames N× slower (Flowframes "slowmo"). */
  slowmo: boolean
  method: InterpMethod
  quality: InterpQuality
  sceneDetect: boolean
  /** source range in seconds */
  start: number
  end: number
  bitrateMbps: number
  engine: 'gpu' | 'ffmpeg'
}

export interface LabProgress { progress: number; message: string; fps?: number; eta?: number }

export function labOutputSize(asset: AssetMeta, opts: Pick<LabOptions, 'enhance'>): { w: number; h: number } {
  const s = opts.enhance && opts.enhance.upscale > 1 ? opts.enhance.upscale : 1
  let w = Math.round(asset.width * s), h = Math.round(asset.height * s)
  const cap = 3840 / Math.max(w, h)
  if (cap < 1) { w = Math.round(w * cap); h = Math.round(h * cap) }
  return { w: w & ~1, h: h & ~1 }
}

/** Frames per source frame the output carries (2× / 4× …). */
export function labFactor(asset: AssetMeta, opts: Pick<LabOptions, 'targetFps'>): number {
  const src = asset.fps || 30
  return opts.targetFps ? opts.targetFps / src : 1
}

export async function runVideoLab(
  asset: AssetMeta,
  opts: LabOptions,
  onProgress: (p: LabProgress) => void,
  isCancelled: () => boolean,
): Promise<File> {
  if (opts.engine === 'ffmpeg') {
    const desk = desktopApi()
    if (!desk) throw new Error('The ffmpeg engine needs the AnimeStudio desktop app')
    return runFfmpeg(desk, asset, opts, onProgress)
  }
  return runGpu(asset, opts, onProgress, isCancelled)
}

// ------------------------------------------------------------------ desktop / ffmpeg

interface DeskLab {
  videolab: (name: string, data: ArrayBuffer, opts: unknown) => Promise<{ name: string; data: ArrayBuffer }>
  onLabProgress: (cb: (p: { progress: number; fps?: number; speed?: string }) => void) => () => void
}
function desktopApi(): DeskLab | null {
  const api = (globalThis as unknown as { animeStudioDesktop?: Partial<DeskLab> }).animeStudioDesktop
  return api?.videolab && api.onLabProgress ? api as DeskLab : null
}
export function hasFfmpegLab(): boolean { return !!desktopApi() }

async function runFfmpeg(desk: DeskLab, asset: AssetMeta, opts: LabOptions, onProgress: (p: LabProgress) => void): Promise<File> {
  onProgress({ progress: 0.01, message: 'Reading source…' })
  const data = await (await fetch(asset.url)).arrayBuffer()
  const { w, h } = labOutputSize(asset, opts)
  const t0 = performance.now()
  const off = desk.onLabProgress(p => {
    const el = (performance.now() - t0) / 1000
    onProgress({
      progress: 0.03 + p.progress * 0.95,
      message: `ffmpeg ${opts.method === 'mci' ? 'motion-compensated' : opts.method} ${p.speed ? '· ' + p.speed : ''}`,
      fps: p.fps,
      eta: p.progress > 0.02 ? (el / p.progress) * (1 - p.progress) : undefined,
    })
  })
  try {
    const out = await desk.videolab(asset.name, data, {
      start: opts.start, end: opts.end, srcFps: asset.fps || 30,
      targetFps: opts.targetFps, slowmo: opts.slowmo, method: opts.method, sceneDetect: opts.sceneDetect,
      width: w, height: h, enhance: opts.enhance, crf: Math.max(10, Math.round(26 - opts.bitrateMbps / 8)),
    })
    onProgress({ progress: 1, message: 'Done' })
    return new File([out.data], out.name, { type: 'video/mp4' })
  } finally { off() }
}

// ------------------------------------------------------------------ GPU (any device)

function seekExact(el: HTMLVideoElement, t: number): Promise<void> {
  return new Promise(resolve => {
    let done = false
    const fin = () => { if (done) return; done = true; clearTimeout(cap); el.removeEventListener('seeked', onS); setTimeout(resolve, 0) }
    const onS = () => fin()
    el.addEventListener('seeked', onS)
    const cap = setTimeout(fin, 3000)
    try { el.currentTime = t } catch { fin() }
  })
}

function lumaThumb(c: HTMLCanvasElement): Float32Array {
  const t = document.createElement('canvas')
  t.width = 64; t.height = 36
  const x = t.getContext('2d', { willReadFrequently: true })!
  x.drawImage(c, 0, 0, 64, 36)
  const d = x.getImageData(0, 0, 64, 36).data
  const out = new Float32Array(64 * 36)
  for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] * 0.2126 + d[i * 4 + 1] * 0.7152 + d[i * 4 + 2] * 0.0722) / 255
  return out
}
/** Scene cut = large mean luma change on a 64×36 thumbnail (Flowframes' scene detection). */
function isSceneCut(a: Float32Array, b: Float32Array): boolean {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return s / a.length > 0.18
}

async function runGpu(asset: AssetMeta, opts: LabOptions, onProgress: (p: LabProgress) => void, isCancelled: () => boolean): Promise<File> {
  const srcFps = asset.fps || 30
  const { w: outW, h: outH } = labOutputSize(asset, opts)
  const outFps = opts.slowmo ? srcFps : (opts.targetFps ?? srcFps)
  const factor = opts.targetFps ? opts.targetFps / srcFps : 1
  const srcFrames = Math.max(1, Math.round((opts.end - opts.start) * srcFps))
  const total = Math.max(1, Math.round(srcFrames * factor))

  // ---- encoder
  const mbps = Math.ceil(outW / 16) * Math.ceil(outH / 16) * outFps
  const level = mbps <= 245760 ? '2A' : mbps <= 589824 ? '33' : mbps <= 983040 ? '34' : '3E'
  const bitrate = opts.bitrateMbps * 1e6
  const cfg: VideoEncoderConfig = { codec: `avc1.6400${level}`, width: outW, height: outH, bitrate, framerate: outFps }
  if (!(await VideoEncoder.isConfigSupported(cfg).catch(() => null))?.supported) cfg.codec = `avc1.4200${level}`
  if (!(await VideoEncoder.isConfigSupported(cfg).catch(() => null))?.supported) throw new Error(`This device can't encode ${outW}×${outH} @ ${outFps} fps — lower the upscale or the frame rate`)

  // ---- audio (original, same range; slow-mo output has no audio, like Flowframes)
  onProgress({ progress: 0.01, message: 'Preparing audio…' })
  let audio: AudioBuffer | null = null
  if (!opts.slowmo && typeof AudioEncoder !== 'undefined') {
    try {
      const sup = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 })
      if (sup.supported) {
        const buf = await (await fetch(asset.url)).arrayBuffer()
        const ctx = new OfflineAudioContext(2, 48000, 48000)
        const dec = await ctx.decodeAudioData(buf)
        const a0 = Math.floor(opts.start * dec.sampleRate), a1 = Math.min(dec.length, Math.ceil(opts.end * dec.sampleRate))
        if (a1 > a0) {
          const len = Math.round((a1 - a0) * 48000 / dec.sampleRate)
          const oc = new OfflineAudioContext(2, len, 48000)
          const src = oc.createBufferSource()
          src.buffer = dec
          src.connect(oc.destination)
          src.start(0, opts.start, opts.end - opts.start)
          audio = await oc.startRendering()
        }
      }
    } catch { audio = null /* no audio track or undecodable */ }
  }

  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer')
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: outW, height: outH, frameRate: outFps },
    ...(audio ? { audio: { codec: 'aac', numberOfChannels: 2, sampleRate: 48000 } } : {}),
    fastStart: 'in-memory',
  })
  let encErr: string | null = null
  const enc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => { encErr = e.message } })
  enc.configure(cfg)
  if (audio) {
    const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: () => { } })
    aenc.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 })
    for (let o = 0; o < audio.length; o += 48000) {
      const n = Math.min(48000, audio.length - o)
      const planar = new Float32Array(n * 2)
      planar.set(audio.getChannelData(0).subarray(o, o + n), 0)
      planar.set(audio.getChannelData(Math.min(1, audio.numberOfChannels - 1)).subarray(o, o + n), n)
      const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(o / 48000 * 1e6), data: planar })
      aenc.encode(ad); ad.close()
    }
    await aenc.flush(); aenc.close()
  }

  // ---- decoder (exact seeks; one element, sequential)
  const el = document.createElement('video')
  el.muted = true; el.playsInline = true; el.preload = 'auto'; el.crossOrigin = 'anonymous'
  el.src = asset.url
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('Source did not load')), 20000)
    el.onloadeddata = () => { clearTimeout(t); res() }
    el.onerror = () => { clearTimeout(t); rej(new Error('Source could not be decoded')) }
  })
  const grab = async (i: number): Promise<HTMLCanvasElement> => {
    await seekExact(el, Math.min(asset.duration - 0.001, opts.start + (i + 0.5) / srcFps))
    let c = document.createElement('canvas')
    c.width = el.videoWidth || asset.width; c.height = el.videoHeight || asset.height
    c.getContext('2d')!.drawImage(el, 0, 0)
    if (opts.enhance) c = await enhanceRenderer.processParams(c, opts.enhance)
    if (c.width !== outW || c.height !== outH) {
      const r = document.createElement('canvas')
      r.width = outW; r.height = outH
      r.getContext('2d')!.drawImage(c, 0, 0, outW, outH)
      c = r
    }
    return c
  }

  const interp = opts.targetFps && opts.method !== 'dup' ? new PairInterpolator(opts.quality, Math.max(outW, outH)) : null
  const cache = new Map<number, { c: HTMLCanvasElement; l: Float32Array }>()
  const frameAt = async (i: number) => {
    const k = Math.min(srcFrames - 1, Math.max(0, i))
    let f = cache.get(k)
    if (!f) {
      const c = await grab(k)
      f = { c, l: lumaThumb(c) }
      cache.set(k, f)
      for (const key of cache.keys()) if (key < k - 1) cache.delete(key)
    }
    return f
  }
  let pairKey = -1, pairCut = false
  const blendCv = document.createElement('canvas')
  blendCv.width = outW; blendCv.height = outH
  const bctx = blendCv.getContext('2d')!

  const t0 = performance.now()
  try {
    for (let k = 0; k < total; k++) {
      if (isCancelled()) throw new Error('Cancelled')
      if (encErr) throw new Error(`Encoder failed: ${encErr}`)
      const pos = k / factor
      const i = Math.floor(pos + 1e-6)
      const frac = pos - i
      const A = await frameAt(i)
      let out: HTMLCanvasElement = A.c
      if (frac > 0.001 && i + 1 < srcFrames && opts.targetFps) {
        const B = await frameAt(i + 1)
        if (opts.method === 'blend') {
          bctx.globalAlpha = 1; bctx.drawImage(A.c, 0, 0)
          bctx.globalAlpha = frac; bctx.drawImage(B.c, 0, 0); bctx.globalAlpha = 1
          out = blendCv
        } else if (interp) {
          if (pairKey !== i) {
            pairKey = i
            pairCut = opts.sceneDetect && isSceneCut(A.l, B.l)
            if (!pairCut) interp.setPair(A.c, B.c)
          }
          out = pairCut ? (frac < 0.5 ? A.c : B.c) : interp.synth(frac)
        }
      }
      const vf = new VideoFrame(out, { timestamp: Math.round(k * 1e6 / outFps), duration: Math.round(1e6 / outFps) })
      enc.encode(vf, { keyFrame: k % Math.max(1, Math.round(outFps * 2)) === 0 })
      vf.close()
      while (enc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 2))
      if (k % 4 === 0 || k === total - 1) {
        const el2 = (performance.now() - t0) / 1000
        const p = (k + 1) / total
        onProgress({
          progress: 0.02 + p * 0.96,
          message: `Frame ${k + 1}/${total}${interp ? ` · ${interp.engine === 'gpu' ? 'GPU optical flow' : 'CPU flow'}` : ''}${opts.enhance ? ' · enhance' : ''}`,
          fps: (k + 1) / Math.max(0.001, el2),
          eta: (el2 / p) * (1 - p),
        })
        await new Promise(r => setTimeout(r, 0))
      }
    }
    await enc.flush()
  } finally {
    try { enc.close() } catch { }
    interp?.dispose()
    el.removeAttribute('src'); el.load()
  }
  muxer.finalize()
  const tag = [opts.enhance ? `${outH}p` : '', opts.targetFps ? (opts.slowmo ? `${Math.round(factor)}x-slowmo` : `${opts.targetFps}fps`) : ''].filter(Boolean).join('-') || 'lab'
  const base = asset.name.replace(/\.[^.]+$/, '')
  return new File([(muxer.target as InstanceType<typeof ArrayBufferTarget>).buffer], `${base} [${tag}].mp4`, { type: 'video/mp4' })
}

/** Quick motion preview for the Lab: in-betweens between two consecutive source frames. */
export async function labMotionPreview(asset: AssetMeta, time: number, steps: number, quality: InterpQuality, maxW = 640): Promise<{ frames: string[]; engine: string }> {
  const srcFps = asset.fps || 30
  const el = document.createElement('video')
  el.muted = true; el.playsInline = true; el.preload = 'auto'; el.crossOrigin = 'anonymous'
  el.src = asset.url
  await new Promise<void>((res, rej) => { el.onloadeddata = () => res(); el.onerror = () => rej(new Error('Source could not be decoded')) })
  const k = Math.min(1, maxW / (asset.width || maxW))
  const grab = async (t: number) => {
    await seekExact(el, t)
    const c = document.createElement('canvas')
    c.width = Math.round((el.videoWidth || asset.width) * k) & ~1; c.height = Math.round((el.videoHeight || asset.height) * k) & ~1
    c.getContext('2d')!.drawImage(el, 0, 0, c.width, c.height)
    return c
  }
  const a = await grab(time), b = await grab(Math.min(asset.duration - 0.01, time + 1 / srcFps))
  el.removeAttribute('src'); el.load()
  const pi = new PairInterpolator(quality, Math.max(a.width, a.height))
  pi.setPair(a, b)
  const frames = [a.toDataURL('image/jpeg', 0.85)]
  for (let s = 1; s < steps; s++) frames.push(pi.synth(s / steps).toDataURL('image/jpeg', 0.85))
  frames.push(b.toDataURL('image/jpeg', 0.85))
  const engine = pi.engine
  pi.dispose()
  return { frames, engine }
}
