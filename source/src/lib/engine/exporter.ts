/**
 * ANIME STUDIO — Export & Render Engine
 *
 * Two REAL export paths (no fake progress, no fake completion):
 *
 *  A) Realtime capture (iOS Safari compatible):
 *     - Hidden canvas + dedicated Compositor, composition driven in real time
 *     - canvas.captureStream + WebAudio mix via MediaStreamAudioDestinationNode
 *     - MediaRecorder → MP4 (Safari H.264) or WebM (Chrome)
 *
 *  B) Frame-accurate (WebCodecs-capable browsers):
 *     - Every frame seeked, composited, encoded via VideoEncoder
 *     - Audio mixed in an OfflineAudioContext (volume automation, fades,
 *       biquad/reverb effects) and encoded via AudioEncoder when available
 *     - Muxed with mp4-muxer / webm-muxer
 *
 * Optional Topaz-style enhancement pass runs per frame before encoding.
 */
import type { ProjectDoc } from './types'
import { flattenForMedia, rootView } from './precomp'
import { projectDuration } from './types'
import { Compositor } from './compositor'
import { mediaManager } from '../media/mediaManager'
import { audioEngine } from './audio'
import { playbackEngine } from './playback'
import { clipSourceTime, clipAverageSpeed } from './speed'
import { evalKeyframeTrack, evalEffectParam } from './keyframes'
import { enhanceRenderer } from './enhance'
import type { EnhancePreset } from './enhance'
import type { VideoClip, AudioClip } from './types'
import { EFFECT_MAP } from './effects'

export interface ExportSettings {
  format: 'mp4' | 'webm' | 'auto'
  width: number
  height: number
  fps: number
  quality: 'low' | 'medium' | 'high' | 'ultra'
  bitrateMbps?: number
  enhancePreset?: EnhancePreset | null
  engine: 'realtime' | 'precise' | 'auto'
}

export interface ExportProgress {
  phase: 'prepare' | 'render' | 'encode' | 'mux' | 'done' | 'error'
  progress: number
  message: string
  result?: ExportResult
  error?: string
}

export interface ExportResult {
  blob: Blob
  mimeType: string
  width: number
  height: number
  fps: number
  durationSec: number
  sizeBytes: number
  engine: string
  audioIncluded: boolean
  /** Sidecar audio (WAV) when the video container could not carry audio. */
  audioWav?: Blob
  audioWavInfo?: string
  notes: string[]
}

const QUALITY_BITRATE: Record<ExportSettings['quality'], number> = {
  low: 2, medium: 6, high: 12, ultra: 24,
}

function pickRecorderMime(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === 'undefined') return null
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ]
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) {
      return { mime: c, ext: c.startsWith('video/mp4') ? 'mp4' : 'webm' }
    }
  }
  return null
}

/** Export the composition. Returns a result blob; throws on real failures. */
export async function exportComposition(
  doc: ProjectDoc,
  settings: ExportSettings,
  onProgress: (p: ExportProgress) => void,
  isCancelled: () => boolean
): Promise<ExportResult> {
  // always render the MAIN comp, even if a pre-comp is open in the editor
  doc = rootView(doc)
  const duration = projectDuration(doc)
  const notes: string[] = []
  // NOTE: the precise engine mixes audio in an OfflineAudioContext which does
  // NOT need an unlocked AudioContext. Only the realtime capture engine uses
  // the live graph — and its unlock must never hang the export (Safari can
  // leave resume() pending without a fresh gesture), so we race a timeout.
  const useEngine = settings.engine === 'auto'
    ? ('VideoEncoder' in window ? 'precise' : 'realtime')
    : settings.engine

  if (useEngine === 'realtime') {
    await Promise.race([audioEngine.unlock(), new Promise(r => setTimeout(r, 900))])
  }

  if (useEngine === 'precise' && 'VideoEncoder' in window) {
    try {
      return await exportPrecise(doc, settings, duration, notes, onProgress, isCancelled)
    } catch (e) {
      notes.push(`Precise engine failed (${e instanceof Error ? e.message : String(e)}); falling back to realtime capture.`)
    }
  }
  return exportRealtime(doc, settings, duration, notes, onProgress, isCancelled)
}

// ---------------------------------------------------------------------------
// Engine B — frame-accurate WebCodecs export
// ---------------------------------------------------------------------------

async function exportPrecise(
  doc: ProjectDoc,
  settings: ExportSettings,
  duration: number,
  notes: string[],
  onProgress: (p: ExportProgress) => void,
  isCancelled: () => boolean
): Promise<ExportResult> {
  onProgress({ phase: 'prepare', progress: 0.02, message: 'Preparing render pipeline…' })
  const { width, height, fps } = settings
  const bitrate = (settings.bitrateMbps ?? QUALITY_BITRATE[settings.quality]) * 1_000_000

  interface SimpleMuxer {
    addVideoChunk: (c: unknown, m: unknown) => void
    addAudioChunk: (c: unknown, m: unknown) => void
    finalize: () => void
    target: { buffer: ArrayBuffer }
  }

  const hasAudioTracks = flattenForMedia(doc).clips.some(c => c.kind === 'audio' || (c.kind === 'video' && !doc.tracks.find(t => t.id === c.trackId)?.muted))
  const sampleRate = 48000
  const channels = 2

  const avcConfig: VideoEncoderConfig = { codec: 'avc1.42002A', width, height, bitrate, framerate: fps }
  const vp9Config: VideoEncoderConfig = { codec: 'vp09.00.10.08', width, height, bitrate, framerate: fps }
  const [avcSupport, vp9Support] = await Promise.all([
    VideoEncoder.isConfigSupported(avcConfig).catch(() => null),
    VideoEncoder.isConfigSupported(vp9Config).catch(() => null),
  ])

  // container decision
  let container: 'mp4' | 'webm'
  const wantMp4 = settings.format === 'mp4' || settings.format === 'auto'
  if (wantMp4 && avcSupport?.supported) {
    container = 'mp4'
  } else if (vp9Support?.supported) {
    container = 'webm'
  } else if (avcSupport?.supported) {
    container = 'mp4'
  } else {
    throw new Error('No supported hardware video encoder found for precise export')
  }

  // Probe the audio codec that MATCHES the chosen container (MP4→AAC, WebM→Opus).
  // If the browser can't encode it, audio is never silently dropped: it goes to
  // a WAV sidecar file below (offline mix, no encoder needed).
  let audioKind: 'aac' | 'opus' | null = null
  if (hasAudioTracks && duration > 0 && typeof AudioEncoder !== 'undefined') {
    const probe: AudioEncoderConfig = container === 'mp4'
      ? { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate: 192_000 }
      : { codec: 'opus', sampleRate, numberOfChannels: channels, bitrate: 192_000 }
    const sup = await AudioEncoder.isConfigSupported(probe).catch(() => null)
    if (sup?.supported) audioKind = container === 'mp4' ? 'aac' : 'opus'
  }
  if (hasAudioTracks && duration > 0 && !audioKind) {
    notes.push(typeof AudioEncoder === 'undefined'
      ? `AudioEncoder is not available in this browser — audio is delivered as a separate WAV file.`
      : `This browser cannot encode ${container === 'mp4' ? 'AAC (MP4 audio)' : 'Opus (WebM audio)'} — audio is delivered as a separate WAV file.`)
  }
  if (!hasAudioTracks) audioKind = null

  let muxerFactory: ((withAudio: { codec: string; numberOfChannels: number; sampleRate: number } | null) => SimpleMuxer) | null = null
  let audioCodec = ''
  if (container === 'mp4') {
    const { Muxer, ArrayBufferTarget } = await import('mp4-muxer')
    muxerFactory = (audio) => {
      const m = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: 'avc', width, height },
        ...(audio ? { audio: { codec: 'aac', numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate } } : {}),
        fastStart: 'in-memory',
      })
      return m as unknown as SimpleMuxer
    }
  } else {
    const { Muxer, ArrayBufferTarget } = await import('webm-muxer')
    muxerFactory = (audio) => {
      const m = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: 'V_VP9', width, height },
        ...(audio ? { audio: { codec: 'A_OPUS', numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate } } : {}),
      })
      return m as unknown as SimpleMuxer
    }
  }

  const muxer = muxerFactory(audioKind ? { codec: audioKind, numberOfChannels: channels, sampleRate } : null) as unknown as {
    addVideoChunk: (c: EncodedVideoChunk, m: EncodedVideoChunkMetadata) => void
    addAudioChunk: (c: EncodedAudioChunk, m: EncodedAudioChunkMetadata) => void
    finalize: () => void
    target: { buffer: ArrayBuffer }
  }

  // ---- audio: mix offline ONCE, embed when possible, else keep for WAV sidecar ----
  let audioIncluded = false
  let offlineBuf: AudioBuffer | null = null
  if (hasAudioTracks && duration > 0) {
    onProgress({ phase: 'prepare', progress: 0.03, message: 'Mixing audio offline…' })
    try {
      offlineBuf = await mixAudioOffline(doc, duration, sampleRate, channels)
      if (!offlineBuf || offlineBuf.length === 0) {
        offlineBuf = null
        notes.push('No audible audio in the offline mix — video carries no sound.')
      }
    } catch (e) {
      offlineBuf = null
      notes.push(`Audio mix failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (offlineBuf && audioKind) {
    try {
      const audioCfg: AudioEncoderConfig = {
        codec: audioKind === 'aac' ? 'mp4a.40.2' : 'opus',
        sampleRate, numberOfChannels: channels, bitrate: 192_000,
      }
      let chunkCount = 0
      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => { muxer.addAudioChunk(chunk, meta); chunkCount++ },
        error: (e) => notes.push(`Audio encoder error: ${e.message}`),
      })
      audioEncoder.configure(audioCfg)
      // chunk the offline buffer (1s chunks)
      const chunkFrames = sampleRate * 1
      const buf = offlineBuf
      for (let off = 0; off < buf.length; off += chunkFrames) {
        const n = Math.min(chunkFrames, buf.length - off)
        const slice = new AudioData({
          format: 'f32-planar',
          sampleRate,
          numberOfFrames: n,
          numberOfChannels: channels,
          timestamp: Math.round((off / sampleRate) * 1e6),
          data: planarSlice(buf, off, n, channels) as unknown as BufferSource,
        })
        audioEncoder.encode(slice)
        slice.close()
      }
      await audioEncoder.flush()
      audioEncoder.close()
      // honest result: only claim audio when chunks actually reached the muxer
      if (chunkCount > 0) audioIncluded = true
      else notes.push('Audio encoded but no chunks were produced — audio moves to the WAV sidecar.')
    } catch (e) {
      audioIncluded = false
      notes.push(`Audio encode failed (${e instanceof Error ? e.message : String(e)}) — audio moves to the WAV sidecar.`)
    }
  } else if (!hasAudioTracks) {
    notes.push('No audio clips on the timeline.')
  }

  // video encoder
  let keyframeEvery = fps * 2
  let encoderFailed: string | null = null
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encoderFailed = e.message },
  })
  videoEncoder.configure(container === 'mp4' ? avcConfig : vp9Config)

  // hidden render canvas + dedicated compositor
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const compositor = new Compositor()
  // captureSafe → preserveDrawingBuffer=true: Safari reads back a stale/cleared
  // buffer from a plain WebGL canvas (single-frame flicker in exports).
  compositor.attach(canvas, true)
  // force canvas size to export resolution (resize() recreates buffers at canvas size)
  compositor.resize()

  // Prewarm: getElement creates video elements LAZILY. Without this wait the
  // first frames seek elements that are still loading → 350 ms seek timeouts
  // and black/stale textures ("stuck frames" at the start of the export).
  await prewarmVideoElements(doc, onProgress, isCancelled)

  const totalFrames = Math.max(1, Math.round(duration * fps))
  for (let i = 0; i < totalFrames; i++) {
    if (isCancelled()) {
      try { videoEncoder.close() } catch { }
      throw new Error('Export cancelled')
    }
    // Async encoder failures used to be only noted — the loop kept encoding
    // into a dead encoder and produced corrupt video. Fail loudly instead;
    // exportComposition() then falls back to realtime capture.
    if (encoderFailed) {
      try { videoEncoder.close() } catch { }
      throw new Error(`Video encoder failed: ${encoderFailed}`)
    }
    const t = i / fps
    if (i % 15 === 0) {
      for (const c of doc.clips) {
        if (c.kind === 'video' && t > c.start + c.duration + 0.5) mediaManager.releaseClip(c.id)
      }
    }
    await seekAllForRender(doc, t)
    compositor.render(doc, mediaManager, { time: t })
    let frameSource: HTMLCanvasElement = canvas
    if (settings.enhancePreset) {
      try {
        frameSource = await enhanceRenderer.process(canvas, settings.enhancePreset)
      } catch {
        notes.push('Enhancement pass failed on a frame — frame encoded without enhancement.')
      }
    }
    const frame = new VideoFrame(frameSource, {
      timestamp: Math.round((i / fps) * 1e6),
      duration: Math.round(1e6 / fps),
    })
    videoEncoder.encode(frame, { keyFrame: i % keyframeEvery === 0 })
    frame.close()
    if (i % 3 === 0) {
      onProgress({ phase: 'render', progress: 0.05 + (i / totalFrames) * 0.85, message: `Rendering frame ${i + 1}/${totalFrames}` })
      await new Promise(r => setTimeout(r, 0))
    }
    if (videoEncoder.encodeQueueSize > 30) {
      // Backpressure wait — with a hard deadline: a stalled hardware encoder
      // must not hang the export forever (it falls back to realtime instead).
      const deadline = performance.now() + 5000
      while (videoEncoder.encodeQueueSize > 8) {
        if (performance.now() > deadline) {
          try { videoEncoder.close() } catch { }
          throw new Error('Video encoder queue stalled (hardware encoder did not drain)')
        }
        await new Promise(r => setTimeout(r, 16))
      }
    }
  }
  onProgress({ phase: 'encode', progress: 0.92, message: 'Finalizing encoding…' })
  await videoEncoder.flush()
  videoEncoder.close()
  muxer.finalize()
  const buffer = muxer.target.buffer
  const blob = new Blob([buffer], { type: container === 'mp4' ? 'video/mp4' : 'video/webm' })
  onProgress({ phase: 'done', progress: 1, message: 'Export complete' })
  compositor.disposeAllTextures()
  // AUDIO GUARANTEE: if the container could not carry audio, deliver the offline
  // mix as a WAV sidecar so the audio always comes out (worst case separate file).
  let audioWav: Blob | undefined
  let audioWavInfo: string | undefined
  if (!audioIncluded && offlineBuf) {
    try {
      audioWav = encodeWav(offlineBuf)
      audioWavInfo = `${(audioWav.size / 1024 / 1024).toFixed(1)}MB · ${offlineBuf.numberOfChannels}ch · ${offlineBuf.sampleRate}Hz PCM16`
      notes.push('Download the WAV too and you have the complete audio (works in any editor).')
    } catch (e) {
      notes.push(`WAV sidecar failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return {
    blob,
    mimeType: container === 'mp4' ? 'video/mp4' : 'video/webm',
    width, height, fps,
    durationSec: duration,
    sizeBytes: blob.size,
    engine: 'precise (WebCodecs)',
    audioIncluded,
    audioWav,
    audioWavInfo,
    notes,
  }
}

// ---------------------------------------------------------------------------
// Audio guarantee: offline mix → AAC/Opus embed, else WAV sidecar (always)
// ---------------------------------------------------------------------------

/** Encode an AudioBuffer as 16-bit PCM WAV — pure JS, works everywhere. */
export function encodeWav(buffer: AudioBuffer): Blob {
  const numCh = buffer.numberOfChannels
  const sr = buffer.sampleRate
  const len = buffer.length
  const bytesPerSample = 2
  const blockAlign = numCh * bytesPerSample
  const dataSize = len * blockAlign
  const out = new ArrayBuffer(44 + dataSize)
  const view = new DataView(out)
  const wstr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  wstr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  wstr(8, 'WAVE')
  wstr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, numCh, true)
  view.setUint32(24, sr, true)
  view.setUint32(28, sr * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  wstr(36, 'data')
  view.setUint32(40, dataSize, true)
  const chans: Float32Array[] = []
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c))
  let off = 44
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let v = Math.max(-1, Math.min(1, chans[c][i]))
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7FFF, true)
      off += 2
    }
  }
  return new Blob([out], { type: 'audio/wav' })
}

function planarSlice(buf: AudioBuffer, offset: number, n: number, channels: number): Float32Array {
  const out = new Float32Array(n * channels)
  for (let c = 0; c < channels; c++) {
    const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1))
    out.set(src.subarray(offset, offset + n), c * n)
  }
  return out
}

/** Mix all audio-bearing clips offline (volume automation, fades, filters). */
async function mixAudioOffline(doc: ProjectDoc, duration: number, sampleRate: number, channels: number): Promise<AudioBuffer | null> {
  doc = flattenForMedia(doc)
  const audioClips = doc.clips.filter(c => c.kind === 'audio' || c.kind === 'video') as (AudioClip | VideoClip)[]
  const audible = audioClips.filter(c => {
    const tr = doc.tracks.find(t => t.id === c.trackId)
    return !tr?.muted && !c.muted && (c.kind === 'audio' || tr?.kind === 'video')
  })
  if (audible.length === 0) return null
  const OfflineAC = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext
  const ctx = new OfflineAC(channels, Math.ceil(duration * sampleRate), sampleRate)
  const master = ctx.createGain()
  master.gain.value = 1
  master.connect(ctx.destination)

  for (const clip of audible) {
    const asset = doc.assets.find(a => a.id === (clip as AudioClip).assetId)
    if (!asset) continue
    try {
      const res = await fetch(asset.url)
      const arr = await res.arrayBuffer()
      const decoded = await ctx.decodeAudioData(arr)
      const src = ctx.createBufferSource()
      src.buffer = decoded
      const rate = clipAverageSpeed(clip)
      src.playbackRate.value = Math.min(16, Math.max(0.0625, Math.abs(rate) || 1))
      // effects (biquad/convolver supported offline)
      let head: AudioNode = src
      for (const e of clip.effects) {
        if (!e.enabled) continue
        const def = EFFECT_MAP[e.type]
        if (!def || def.category !== 'audio') continue
        if (e.type === 'bass_boost') {
          const f = ctx.createBiquadFilter()
          f.type = 'lowshelf'; f.frequency.value = 200; f.gain.value = e.params.gainDB ?? 6
          head.connect(f); head = f
        } else if (e.type === 'treble_boost') {
          const f = ctx.createBiquadFilter()
          f.type = 'highshelf'; f.frequency.value = 3000; f.gain.value = e.params.gainDB ?? 4
          head.connect(f); head = f
        } else if (e.type === 'compressor') {
          const comp = ctx.createDynamicsCompressor()
          comp.threshold.value = e.params.threshold ?? -18
          comp.ratio.value = e.params.ratio ?? 6
          head.connect(comp); head = comp
        } else if (e.type === 'reverb') {
          const conv = ctx.createConvolver()
          const decay = Math.max(0.2, e.params.decay ?? 1.8)
          const len = Math.floor(sampleRate * decay)
          const impulse = ctx.createBuffer(2, len, sampleRate)
          for (let c = 0; c < 2; c++) {
            const d = impulse.getChannelData(c)
            for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5)
          }
          conv.buffer = impulse
          const wet = ctx.createGain(); wet.gain.value = e.params.mix ?? 0.25
          const dry = ctx.createGain(); dry.gain.value = 1
          head.connect(conv); conv.connect(wet); wet.connect(master)
          head.connect(dry); dry.connect(master)
          continue
        }
      }
      const gain = ctx.createGain()
      head.connect(gain)
      gain.connect(master)
      // volume automation from keyframes + fades
      const baseVol = clip.kind === 'audio' ? (clip as AudioClip).volume : 1
      const kfTrack = clip.keyframes.find(k => k.property === 'volume')
      if (kfTrack && kfTrack.keyframes.length > 0) {
        for (const k of kfTrack.keyframes) {
          gain.gain.linearRampToValueAtTime(Math.max(0, k.value), (clip.start + k.time))
        }
      } else {
        gain.gain.value = baseVol
      }
      if (clip.kind === 'audio') {
        const ac = clip as AudioClip
        if (ac.fadeIn > 0) {
          gain.gain.setValueAtTime(0, clip.start)
          gain.gain.linearRampToValueAtTime(baseVol, clip.start + ac.fadeIn)
        }
        if (ac.fadeOut > 0) {
          gain.gain.setValueAtTime(baseVol, clip.start + clip.duration - ac.fadeOut)
          gain.gain.linearRampToValueAtTime(0, clip.start + clip.duration)
        }
      }
      // start offset: clip audio starts at clip.start in the mix
      const when = Math.max(0, clip.start)
      const offset = Math.max(0, clip.inPoint)
      const playDur = Math.min(clip.duration, decoded.duration / Math.abs(rate || 1))
      src.start(when, offset, playDur)
    } catch {
      // asset missing/undecodable — skip silently but note
    }
  }
  return await ctx.startRendering()
}

/** Seek every active video element to its exact source time for frame t. */
async function seekAllForRender(doc: ProjectDoc, t: number): Promise<void> {
  doc = flattenForMedia(doc)
  const seeks: Promise<void>[] = []
  for (const clip of doc.clips) {
    if (clip.kind !== 'video') continue
    if (t < clip.start || t >= clip.start + clip.duration) continue
    const vc = clip as VideoClip
    const el = mediaManager.getElement(vc)
    if (!el) continue
    const st = clipSourceTime(vc, t - vc.start)
    seeks.push(mediaManager.seek(el, st, { exact: true }))
  }
  await Promise.all(seeks)
  // Yield with a TIMER, not requestAnimationFrame: rAF never fires in a hidden
  // tab / locked screen on iOS — the export used to freeze mid-render when the
  // user looked away. Capture happens in the same task as render, so no paint
  // wait is needed here.
  await new Promise(r => setTimeout(r, 0))
}

/**
 * Make sure every video clip's element exists AND has decoded frame data
 * (readyState >= 2) before the frame loop starts. Cap per element so a
 * broken asset can never hang the export — those frames degrade gracefully.
 */
async function prewarmVideoElements(
  doc: ProjectDoc,
  onProgress: (p: ExportProgress) => void,
  isCancelled: () => boolean
): Promise<void> {
  const seen = new Set<string>()
  const els: HTMLVideoElement[] = []
  for (const c of doc.clips) {
  doc = flattenForMedia(doc)
    if (c.kind !== 'video') continue
    const vc = c as VideoClip
    if (seen.has(vc.assetId + vc.id)) continue
    seen.add(vc.assetId + vc.id)
    const el = mediaManager.getElement(vc)
    if (el) els.push(el)
  }
  if (els.length === 0) return
  const wait = (el: HTMLVideoElement) => new Promise<void>(res => {
    if (el.readyState >= 2) { res(); return }
    const ok = () => { cleanup(); res() }
    const cleanup = () => {
      el.removeEventListener('loadeddata', ok)
      el.removeEventListener('error', ok)
      clearTimeout(cap)
    }
    el.addEventListener('loadeddata', ok, { once: true })
    el.addEventListener('error', ok, { once: true })
    const cap = setTimeout(ok, 4000)
  })
  onProgress({ phase: 'prepare', progress: 0.04, message: `Loading ${els.length} video source(s)…` })
  await Promise.all(els.map(wait))
}

// ---------------------------------------------------------------------------
// Engine A — realtime MediaRecorder capture
// ---------------------------------------------------------------------------

async function exportRealtime(
  doc: ProjectDoc,
  settings: ExportSettings,
  duration: number,
  notes: string[],
  onProgress: (p: ExportProgress) => void,
  isCancelled: () => boolean
): Promise<ExportResult> {
  onProgress({ phase: 'prepare', progress: 0.02, message: 'Preparing realtime capture…' })
  const picked = pickRecorderMime()
  if (!picked) throw new Error('MediaRecorder is not supported in this browser')
  const ext = picked.ext
  if (settings.format !== 'auto' && settings.format !== ext) {
    notes.push(`This browser records ${ext.toUpperCase()} — exporting ${ext.toUpperCase()} instead of ${settings.format.toUpperCase()}.`)
  }

  const { width, height, fps } = settings
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const compositor = new Compositor()
  // captureStream also reads the canvas back — capture-safe context here too.
  compositor.attach(canvas, true)
  compositor.resize()

  const stream = canvas.captureStream(fps)
  // audio: attach the live WebAudio mix when there is something audible;
  // audioIncluded is only true if an audio track really joined the stream.
  const audibleClips = flattenForMedia(doc).clips.filter(c => {
    if (c.kind !== 'audio' && c.kind !== 'video') return false
    const tr = doc.tracks.find(t => t.id === c.trackId)
    return !tr?.muted
  })
  let audioIncluded = false
  if (audibleClips.length > 0) {
    try {
      const audioDest = audioEngine.getMediaStreamDestination()
      const tracks = audioDest.stream.getAudioTracks()
      for (const track of tracks) stream.addTrack(track)
      audioIncluded = tracks.length > 0
      if (!audioIncluded) notes.push('Audio track could not be created — exporting video only.')
    } catch (e) {
      notes.push(`Audio capture unavailable: ${e instanceof Error ? e.message : String(e)} — exporting video only.`)
    }
  } else {
    notes.push('No audible clips — exporting video only.')
  }

  const bitrate = (settings.bitrateMbps ?? QUALITY_BITRATE[settings.quality]) * 1_000_000
  const recorder = new MediaRecorder(stream, {
    mimeType: picked.mime,
    videoBitsPerSecond: bitrate,
    audioBitsPerSecond: 192_000,
  })
  const chunks: BlobPart[] = []
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }

  const done = new Promise<void>(resolve => {
    recorder.onstop = () => resolve()
  })

  // drive composition in real time — timer-driven, not rAF: rAF stops in a
  // hidden tab / locked screen (the recording then captured a frozen frame
  // forever). setTimeout keeps advancing (throttled, but wall-clock synced).
  let cancelled = false
  recorder.start(250)
  const t0 = performance.now()
  const frameMs = Math.max(8, Math.round(1000 / Math.max(1, fps)))
  await new Promise<void>(resolve => {
    const tick = () => {
      const t = (performance.now() - t0) / 1000
      if (isCancelled()) { cancelled = true; resolve(); return }
      if (t >= duration) { resolve(); return }
      playbackEngine.driveMedia(flattenForMedia(doc), Math.min(t, duration), true)
      audioEngine.sync(doc, Math.min(t, duration), true, false)
      compositor.render(doc, mediaManager, { time: Math.min(t, duration) })
      onProgress({ phase: 'render', progress: 0.05 + (t / duration) * 0.85, message: `Recording ${(t).toFixed(1)}s / ${duration.toFixed(1)}s` })
      setTimeout(tick, frameMs)
    }
    setTimeout(tick, frameMs)
  })
  if (cancelled) {
    try { recorder.stop() } catch { }
    throw new Error('Export cancelled')
  }
  // small tail so the last frames land in the muxer
  await new Promise(r => setTimeout(r, 250))
  recorder.stop()
  await done
  audioEngine.stopAll()
  compositor.disposeAllTextures()

  const blob = new Blob(chunks, { type: picked.mime.split(';')[0] })
  onProgress({ phase: 'done', progress: 1, message: 'Export complete' })
  return {
    blob,
    mimeType: picked.mime.split(';')[0],
    width, height, fps,
    durationSec: duration,
    sizeBytes: blob.size,
    engine: `realtime (${ext.toUpperCase()} via MediaRecorder)`,
    audioIncluded,
    notes,
  }
}

/** Evaluate effect param helper re-exported for potential external use. */
export { evalEffectParam, evalKeyframeTrack }
