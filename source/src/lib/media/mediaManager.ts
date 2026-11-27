/**
 * ANIME STUDIO — Media Manager
 *
 * Owns the runtime lifecycle of imported media on the client:
 *  - HTMLVideoElement pool per clip (memory-aware, capped active elements)
 *  - Seek coordination with de-duplication (avoids seek storms on iOS)
 *  - Thumbnail + waveform peak extraction at import time
 *  - Frame sampling for interpolation / tracking pipelines
 */
import type { AssetMeta, Clip, VideoClip, AudioClip, ImageClip } from '../engine/types'
import type { SourceProvider, TextureSource } from '../engine/compositor'
import { renderTextCanvas } from '../engine/textRenderer'
import type { TextClip } from '../engine/types'

const MAX_ACTIVE_ELEMENTS = 8

export interface PoolEntry {
  el: HTMLVideoElement
  pendingSeek: number | null
  lastSeekedTime: number
  lastUse: number
}

class MediaManagerImpl implements SourceProvider {
  assets = new Map<string, AssetMeta>()
  private pools = new Map<string, Map<string, PoolEntry>>() // assetId -> clipId -> entry
  private images = new Map<string, HTMLImageElement>() // assetId -> decoded image
  /** Decoded image → 2D canvas (texture source). Same upload path as the video bridge. */
  private imageCanvases = new Map<string, { canvas: HTMLCanvasElement; url: string }>()
  /** Runtime in-browser proxy blob URLs (local proxies) — override asset.proxyUrl. */
  private proxyOverrides = new Map<string, string>()
  private audioCtx: AudioContext | null = null
  onElementNeeded?: (clip: VideoClip, asset: AssetMeta) => void
  /**
   * Optional frame-synthesis hook (set by the interpolation engine).
   * When it returns a drawable, the compositor renders that instead of the
   * raw video element — this is how motion-interpolated in-between frames
   * reach the preview and the export pipeline.
   */
  synthesisHook: ((clip: VideoClip, sourceTime: number) => TextureSource | null) | null = null

  setAudioContext(ctx: AudioContext | null) {
    this.audioCtx = ctx
  }

  registerAsset(meta: AssetMeta) {
    if (meta.missingPath || !meta.url) return // offline footage: nothing to decode until relinked
    this.assets.set(meta.id, meta)
  }

  /** Wire a locally generated proxy blob URL (runtime only, not persisted in doc). */
  setProxyUrl(assetId: string, url: string | null) {
    if (url) this.proxyOverrides.set(assetId, url)
    else this.proxyOverrides.delete(assetId)
    // drop pooled elements so they reload from the proxy
    const pool = this.pools.get(assetId)
    if (pool) {
      for (const [, e] of pool) {
        e.el.pause()
        e.el.removeAttribute('src')
        e.el.load()
      }
      this.pools.delete(assetId)
    }
  }

  hasLocalProxy(assetId: string): boolean {
    return this.proxyOverrides.has(assetId)
  }

  removeAsset(assetId: string) {
    const pool = this.pools.get(assetId)
    if (pool) {
      for (const [, e] of pool) {
        e.el.pause()
        e.el.removeAttribute('src')
        e.el.load()
      }
      this.pools.delete(assetId)
    }
    const img = this.images.get(assetId)
    if (img) { img.removeAttribute('src'); this.images.delete(assetId) }
    this.imageCanvases.delete(assetId)
    this.assets.delete(assetId)
  }

  /**
   * Clips of the same footage that show the same source frame at every moment
   * (duplicated layers for effects, the AI cut-out copy…) share ONE decoder.
   * Each used to open its own <video>: 5 duplicates = 5 decoders → choppy preview.
   */
  decoderKey(clip: VideoClip): string {
    if (clip.timeRemap || clip.reverse) return clip.id
    const sp = clip.speed || 1
    return `sync:${(clip.start - (clip.inPoint ?? 0) / sp).toFixed(3)}:${sp.toFixed(4)}`
  }

  /** Get (or create) the video element used by a specific clip. */
  getElement(clip: VideoClip): HTMLVideoElement | null {
    const asset = this.assets.get(clip.assetId)
    if (!asset) return null
    let pool = this.pools.get(clip.assetId)
    if (!pool) { pool = new Map(); this.pools.set(clip.assetId, pool) }
    const key = this.decoderKey(clip)
    let entry = pool.get(key)
    if (!entry) {
      // Enforce active element budget (mobile memory): recycle least-recently-used
      const allEntries: { key: string; poolKey: string; e: PoolEntry }[] = []
      for (const [ak, p] of this.pools) for (const [ck, e] of p) allEntries.push({ key: ck, poolKey: ak, e })
      const active = allEntries.filter(x => !x.e.el.paused).length
      if (allEntries.length >= MAX_ACTIVE_ELEMENTS * 2 && active > MAX_ACTIVE_ELEMENTS) {
        allEntries.sort((a, b) => a.e.lastUse - b.e.lastUse)
        const victim = allEntries[0]
        victim.e.el.pause()
        const vp = this.pools.get(victim.poolKey)
        vp?.delete(victim.key)
      }
      const el = document.createElement('video')
      el.src = this.proxyOverrides.get(asset.id) || asset.proxyUrl || asset.url
      el.playsInline = true
      el.preload = 'auto'
      el.crossOrigin = 'anonymous'
      // muted until the audio engine wires it into WebAudio: an element that
      // is NOT routed (muted clip/track, context not created yet) used to play
      // straight to the speakers on top of the mixed audio (double / echo)
      el.muted = true
      el.volume = 1
      // iOS: must call load() after setting src
      el.load()
      entry = { el, pendingSeek: null, lastSeekedTime: -1, lastUse: performance.now() }
      pool.set(key, entry)
    }
    entry.lastUse = performance.now()
    return entry.el
  }

  releaseClip(clipId: string) {
    for (const [, pool] of this.pools) {
      const e = pool.get(clipId)
      if (e) {
        e.el.pause()
        e.el.removeAttribute('src')
        e.el.load()
        pool.delete(clipId)
      }
    }
  }

  /**
   * Get the decoded image for an image asset as a 2D canvas (built once).
   * Using a canvas — exactly like the video bridge — avoids WebGL texture
   * orientation quirks across engines and keeps one upload per asset.
   */
  getImage(assetId: string): HTMLCanvasElement | null {
    const asset = this.assets.get(assetId)
    if (!asset || asset.kind !== 'image') return null
    const cached = this.imageCanvases.get(assetId)
    if (cached && cached.url === asset.url) return cached.canvas
    const img = this.images.get(assetId)
    if (!img || img.getAttribute('src') !== asset.url) {
      const el = new Image()
      el.crossOrigin = 'anonymous'
      el.decoding = 'async'
      el.src = asset.url
      try { el.decode() } catch { /* decode() unsupported — onload still fires */ }
      this.images.set(assetId, el)
      return null
    }
    if (!img.complete || img.naturalWidth === 0) return null
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d')!.drawImage(img, 0, 0)
    this.imageCanvases.set(assetId, { canvas, url: asset.url })
    return canvas
  }

  /** True when the image asset has a decoded canvas ready. */
  isImageReady(assetId: string): boolean {
    const cached = this.imageCanvases.get(assetId)
    if (cached) return true
    // trigger decode attempt and re-check
    const el = this.getImage(assetId)
    return !!el && !!this.imageCanvases.get(assetId)
  }

  /**
   * Seek an element to an exact time (used when paused / scrubbing /
   * variable-speed playback). Coalesces duplicate seeks.
   */
  seek(el: HTMLVideoElement, time: number, opts?: { exact?: boolean; capMs?: number }): Promise<void> {
    if (opts?.exact) return this.seekExact(el, time, opts.capMs ?? 2500)
    return new Promise(resolve => {
      const target = Math.max(0, time)
      // Settled = seek finished AND the decoded frame for it is available.
      // Checking el.seeking is important right after assigning currentTime.
      const settled = () => !el.seeking && el.readyState >= 2 && Math.abs(el.currentTime - target) < 0.05
      if (settled()) {
        resolve()
        return
      }
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearInterval(poll)
        clearTimeout(cap)
        el.removeEventListener('seeked', ev)
        resolve()
      }
      const ev = () => finish()
      el.addEventListener('seeked', ev)
      // Poll the actual state: some browsers (iOS Safari) DROP 'seeked' events
      // on rapid seeks — resolving the instant the seek really lands avoids
      // fixed 350 ms stalls per frame during export ("stuck frames").
      const poll = setInterval(() => { if (settled()) finish() }, 10)
      // Safety cap — never hang on a browser that never settles the seek.
      const cap = setTimeout(finish, 350)
      try { el.currentTime = target } catch { finish() }
    })
  }

  /**
   * Frame-accurate seek for EXPORT. Unlike seek():
   *  - never skips the seek because the element is "close enough" (50 ms is
   *    1-3 frames: the export used to reuse a stale frame and then jump,
   *    which looks like a micro-shake),
   *  - waits for the real 'seeked' (or !seeking) + decoded data,
   *  - long safety cap (2.5 s) instead of 350 ms, so a slow decoder doesn't
   *    produce a stale/black frame — it just takes a bit longer.
   */
  private seekExact(el: HTMLVideoElement, time: number, capMs: number): Promise<void> {
    return new Promise(resolve => {
      const target = Math.max(0, Math.min(time, Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.001) : time))
      if (!el.paused) el.pause()
      if (!el.seeking && el.readyState >= 2 && Math.abs(el.currentTime - target) < 0.002) { resolve(); return }
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearInterval(poll)
        clearTimeout(cap)
        el.removeEventListener('seeked', onSeeked)
        // one extra macrotask so the decoded frame is presentable to WebGL
        setTimeout(resolve, 0)
      }
      const ready = () => !el.seeking && el.readyState >= 2
      const onSeeked = () => { if (ready()) finish() }
      el.addEventListener('seeked', onSeeked)
      // iOS Safari can drop 'seeked': poll the real state as well.
      const poll = setInterval(() => { if (ready() && Math.abs(el.currentTime - target) < 0.1) finish() }, 8)
      const cap = setTimeout(finish, capMs)
      try { el.currentTime = target } catch { finish() }
    })
  }

  private playPending = new WeakSet<HTMLMediaElement>()
  /**
   * Play an element for realtime playback at given rate. Returns false if play() was blocked.
   *
   * FIX (stutter / choppy audio): this runs on EVERY rAF. It used to seek the
   * element whenever it drifted > 80 ms from the timeline clock — media clocks
   * always drift a little, so playback kept seeking: the decoder dropped to
   * readyState < 2 (black frame) and the audio coming out of the same element
   * was chopped on every seek. Now a playing element is never seeked for small
   * drift: it is steered back with a tiny playbackRate nudge (inaudible), and
   * only a real jump (> 0.4 s: loop, scrub, clip entry) does a hard seek.
   */
  async playAt(el: HTMLVideoElement, time: number, rate: number): Promise<boolean> {
    if (this.playPending.has(el)) return true
    // FIX ("the video restarts from the beginning"): past the source's last frame
    // the element must HOLD it. Calling play() on an ended element rewinds it to
    // 0, which replayed the start of the clip over and over near its end.
    const dur = Number.isFinite(el.duration) ? el.duration : Infinity
    const endHold = Math.max(0, dur - 0.02)
    if (time >= endHold) {
      if (!el.paused) el.pause()
      if (Math.abs(el.currentTime - endHold) > 0.03 && !el.seeking) { try { el.currentTime = endHold } catch { } }
      return true
    }
    const clamped = Math.max(0, time)
    const base = Math.min(16, Math.max(0.0625, rate))
    const drift = el.currentTime - clamped // + = element ahead
    if (el.paused) {
      this.playPending.add(el)
      try {
        if (Math.abs(drift) > 0.04 && !el.seeking) { try { el.currentTime = clamped } catch { } }
        if (Math.abs(el.playbackRate - base) > 0.001) { try { el.playbackRate = base } catch { } }
        await el.play()
        delete el.dataset.playBlocked
        return true
      } catch {
        // Autoplay policy blocked playback (no trusted gesture) — engine falls back to seek-driven rendering
        el.dataset.playBlocked = '1'
        return false
      } finally {
        this.playPending.delete(el)
      }
    }
    if (el.seeking) return true
    let want = base
    if (Math.abs(drift) > 0.4) {
      try { el.currentTime = clamped } catch { }
    } else if (Math.abs(drift) > 0.03) {
      // proportional correction, at most ±6 % (pitch-preserved, not noticeable)
      want = base * (1 - Math.max(-0.06, Math.min(0.06, drift * 0.5)))
    }
    if (Math.abs(el.playbackRate - want) > 0.004) {
      try { el.playbackRate = Math.min(16, Math.max(0.0625, want)) } catch { /* range */ }
    }
    return true
  }

  pause(el: HTMLVideoElement) {
    if (!el.paused) el.pause()
  }

  // ---- SourceProvider implementation ----

  get(clip: Clip, sourceTime: number): TextureSource | null {
    if (clip.kind === 'video') {
      const vc = clip as VideoClip
      // Motion-interpolated in-between frames take priority when a session
      // is ready (Twixtor-style slow motion / time remap support).
      if (this.synthesisHook) {
        const synth = this.synthesisHook(vc, sourceTime)
        if (synth) return synth
      }
      const el = this.getElement(vc)
      if (!el || el.readyState < 2) return null
      return el
    }
    if (clip.kind === 'image') {
      const ic = clip as ImageClip
      const canvas = this.getImage(ic.assetId)
      if (!canvas) return null
      return canvas
    }
    return null
  }

  getTextCanvas(clip: TextClip, localTime: number, fps: number): HTMLCanvasElement | null {
    return renderTextCanvas(clip, localTime, fps)
  }

  /** Extract one frame as ImageBitmap at a given source time (for pipelines). */
  async extractFrame(assetId: string, sourceTime: number, maxWidth: number): Promise<ImageBitmap | null> {
    const asset = this.assets.get(assetId)
    if (!asset) return null
    const el = document.createElement('video')
    el.src = this.proxyOverrides.get(assetId) || asset.proxyUrl || asset.url
    el.muted = true
    el.playsInline = true
    el.preload = 'auto'
    el.crossOrigin = 'anonymous'
    try { await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('video load timeout')), 15000)
      el.onloadeddata = () => { clearTimeout(t); res() }
      el.onerror = () => { clearTimeout(t); rej(new Error('video load error')) }
    }) } catch { return null }
    await this.seek(el, sourceTime)
    const scale = Math.min(1, maxWidth / Math.max(1, el.videoWidth))
    const c = document.createElement('canvas')
    c.width = Math.max(2, Math.round(el.videoWidth * scale))
    c.height = Math.max(2, Math.round(el.videoHeight * scale))
    const ctx = c.getContext('2d')!
    ctx.drawImage(el, 0, 0, c.width, c.height)
    el.removeAttribute('src'); el.load()
    try {
      return await createImageBitmap(c)
    } catch {
      return null
    }
  }

  dispose() {
    for (const [aid] of this.assets) this.removeAsset(aid)
  }
}

export const mediaManager = new MediaManagerImpl()

// Debug/testing handle (read-only inspection from console)
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__AS = {
    mediaManager,
  }
}

// ---------------------------------------------------------------------------
// Import pipeline: probe metadata, generate thumbnails and audio peaks
// ---------------------------------------------------------------------------

export interface ImportResult {
  meta: AssetMeta
  file: File
}

/** MIME is often empty for .mkv/.mov on Windows/Android — fall back to the extension. */
/** Containers browsers decode badly — the desktop app always routes them through Influx/ffmpeg. */
const INFLUX_EXT = /\.(avi|wmv|asf|flv|f4v|mxf|vob|mts|m2ts|ts|3gp|3g2|rm|rmvb|dv|y4m|nut|divx|xvid|mpg|mpeg|m2v)(\.influx)?$/i

export function mediaKindOf(file: File): 'video' | 'audio' | 'image' {
  const name = file.name.replace(/\.influx$/i, '')
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'gif' && /\.influx$/i.test(file.name)) return 'video'
  if (file.type.startsWith('video')) return 'video'
  if (file.type.startsWith('audio')) return 'audio'
  if (file.type.startsWith('image')) return 'image'
  if (['mkv', 'mp4', 'm4v', 'mov', 'webm', 'avi', 'ts', 'mts', 'm2ts', 'flv', 'wmv', 'ogv', '3gp', '3g2', 'mxf', 'vob', 'asf', 'f4v', 'rm', 'rmvb', 'dv', 'y4m', 'nut', 'divx', 'xvid', 'mpg', 'mpeg', 'm2v', 'apng'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'aif', 'aiff', 'wma'].includes(ext)) return 'audio'
  return 'image'
}

/** Real source frame rate (24…240) from presented-frame timestamps. */
async function measureFps(el: HTMLVideoElement): Promise<number> {
  const v = el as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, md: { mediaTime: number }) => void) => number }
  if (typeof v.requestVideoFrameCallback !== 'function') return 30
  const times: number[] = []
  const done = new Promise<void>(res => {
    const step = (_: number, md: { mediaTime: number }) => {
      times.push(md.mediaTime)
      if (times.length < 14) v.requestVideoFrameCallback!(step); else res()
    }
    v.requestVideoFrameCallback!(step)
    setTimeout(res, 2500)
  })
  // play at ¼ speed: a 240 fps source then presents ≤60 frames/s, so a 60 Hz screen still sees every frame
  try { el.muted = true; el.playbackRate = 0.25; await el.play() } catch { return 30 }
  await done
  el.pause()
  const d: number[] = []
  for (let i = 1; i < times.length; i++) { const x = times[i] - times[i - 1]; if (x > 0.0005 && x < 0.2) d.push(x) }
  if (d.length < 3) return 30
  d.sort((a, b) => a - b)
  const fps = 1 / d[0] // smallest step = one source frame (display may skip frames)
  const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 100, 119.88, 120, 144, 165, 180, 200, 240]
  return common.reduce((b, c) => Math.abs(c - fps) < Math.abs(b - fps) ? c : b, 30)
}

export async function probeMediaFile(file: File): Promise<{ kind: 'video' | 'audio' | 'image'; duration: number; width: number; height: number; fps: number }> {
  const url = URL.createObjectURL(file)
  const kind = mediaKindOf(file)
  try {
    if (kind === 'video') {
      const el = document.createElement('video')
      el.src = url; el.muted = true; el.playsInline = true; el.preload = 'metadata'
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error('timeout')), 20000)
        el.onloadedmetadata = () => { clearTimeout(t); res() }
        el.onerror = () => { clearTimeout(t); rej(new Error('decode error')) }
      })
      if (!el.videoWidth) throw new Error('decode error')
      let fps = 30
      try { fps = await measureFps(el) } catch { /* keep default */ }
      return { kind: 'video', duration: el.duration || 0, width: el.videoWidth, height: el.videoHeight, fps }
    }
    if (kind === 'audio') {
      const el = document.createElement('audio')
      el.src = url; el.preload = 'metadata'
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error('timeout')), 20000)
        el.onloadedmetadata = () => { clearTimeout(t); res() }
        el.onerror = () => { clearTimeout(t); rej(new Error('decode error')) }
      })
      return { kind: 'audio', duration: el.duration || 0, width: 0, height: 0, fps: 0 }
    }
    const img = new Image()
    img.src = url
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), 15000)
      img.onload = () => { clearTimeout(t); res() }
      img.onerror = () => { clearTimeout(t); rej(new Error('decode error')) }
    })
    return { kind: 'image', duration: 5, width: img.naturalWidth, height: img.naturalHeight, fps: 0 }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function seekTo(el: HTMLVideoElement, t: number): Promise<void> {
  return new Promise(res => {
    const done = () => { el.removeEventListener('seeked', done); res() }
    el.addEventListener('seeked', done)
    el.currentTime = t
    setTimeout(res, 400)
  })
}

/** Generate small timeline thumbnails for a video asset. */
export async function generateThumbnails(assetId: string, url: string, duration: number, count = 8): Promise<string[]> {
  const thumbs: string[] = []
  if (duration <= 0) return thumbs
  const el = document.createElement('video')
  el.src = url; el.muted = true; el.playsInline = true; el.crossOrigin = 'anonymous'
  try {
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('t')), 15000)
      el.onloadeddata = () => { clearTimeout(t); res() }
      el.onerror = () => { clearTimeout(t); rej(new Error('e')) }
    })
  } catch { return thumbs }
  const w = 96
  const h = Math.max(2, Math.round(w * (el.videoHeight / Math.max(1, el.videoWidth))))
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d')!
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.max(0.05, duration - 0.05)
    try {
      await seekTo(el, t)
      ctx.drawImage(el, 0, 0, w, h)
      thumbs.push(c.toDataURL('image/jpeg', 0.5))
    } catch { break }
  }
  el.removeAttribute('src'); el.load()
  return thumbs
}

/** Decode audio and compute waveform peaks (normalized). */
export async function generatePeaks(url: string, buckets = 900): Promise<number[]> {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new AC()
    const res = await fetch(url)
    const buf = await res.arrayBuffer()
    const audio = await ctx.decodeAudioData(buf)
    const ch = audio.getChannelData(0)
    const per = Math.max(1, Math.floor(ch.length / buckets))
    const peaks: number[] = []
    for (let i = 0; i < buckets; i++) {
      let max = 0
      const s = i * per
      for (let j = 0; j < per && s + j < ch.length; j += 4) {
        const v = Math.abs(ch[s + j])
        if (v > max) max = v
      }
      peaks.push(Math.min(1, max))
    }
    void ctx.close()
    return peaks
  } catch {
    return []
  }
}

/** Import a File: probe + thumbnails/peaks + upload to server. Returns AssetMeta. */
export async function importMediaFile(file: File, uploadFn: (file: File, meta: { kind: string; duration: number; width: number; height: number; fps: number }) => Promise<{ id: string; url: string }>, opts?: { influx?: boolean }): Promise<AssetMeta> {
  let probe: Awaited<ReturnType<typeof probeMediaFile>>
  // Influx-style import (desktop): forced by File > Import with Influx, a ".influx"
  // suffix (same trick as the AE plug-in) or formats browsers decode badly.
  const forced = opts?.influx || /\.influx$/i.test(file.name) || (mediaKindOf(file) === 'video' && INFLUX_EXT.test(file.name))
  if (forced) {
    const desk = desktopBridge()
    if (!desk) throw new Error('Influx import converts with the bundled ffmpeg — it needs the AnimeStudio desktop app.')
    file = await desk.convert(file, 'influx', file.name.replace(/\.influx$/i, ''))
  }
  try {
    probe = await probeMediaFile(file)
  } catch (e) {
    // Codec the browser can't decode (MKV with HEVC/AC3, AVI, ProRes…): the desktop
    // app converts it with its bundled ffmpeg; the web build explains why.
    const desk = desktopBridge()
    if (desk && mediaKindOf(file) !== 'image') {
      file = await desk.convert(file, 'influx')
      probe = await probeMediaFile(file)
    } else {
      const ext = file.name.split('.').pop()?.toUpperCase()
      throw new Error(`${ext} uses a codec this browser can't decode (e.g. HEVC/AC3). Open it in the AnimeStudio desktop app (it converts automatically) or convert it to MP4 (H.264/AAC).`)
    }
  }
  const { id, url } = await uploadFn(file, probe)
  const meta: AssetMeta = {
    id,
    name: file.name,
    kind: probe.kind,
    url,
    duration: probe.duration,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    size: file.size,
  }
  if (probe.kind === 'video') {
    meta.thumbnails = await generateThumbnails(id, url, probe.duration, 8)
  }
  if (probe.kind === 'audio' || probe.kind === 'video') {
    meta.peaks = await generatePeaks(url, 900)
  }
  mediaManager.registerAsset(meta)
  return meta
}

// ---------------------------------------------------------------------------
// Desktop (Electron) bridge — present only in the AnimeStudio desktop app
// ---------------------------------------------------------------------------
export interface DesktopBridge {
  platform: string
  convert: (file: File | Blob, preset: 'compat' | 'proxy' | 'influx', name?: string) => Promise<File>
  gpuInfo?: () => Promise<string>
}
export function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { animeStudioDesktop?: { platform: string; transcode: (name: string, data: ArrayBuffer, preset: string) => Promise<{ name: string; data: ArrayBuffer }>; gpuInfo?: () => Promise<string> } }).animeStudioDesktop
  if (!api) return null
  return {
    platform: api.platform,
    gpuInfo: api.gpuInfo,
    convert: async (file, preset, name) => {
      const nm = name ?? (file as File).name ?? 'media'
      const out = await api.transcode(nm, await file.arrayBuffer(), preset)
      return new File([out.data], out.name, { type: /\.webm$/i.test(out.name) ? 'video/webm' : 'video/mp4' })
    },
  }
}
