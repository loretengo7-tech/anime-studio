/**
 * ANIME STUDIO — Audio Engine
 *
 * Real WebAudio pipeline:
 *  - MediaElementSource per audio-bearing clip → effect chain → gain
 *    (volume keyframes + fades evaluated per render tick) → master → output
 *  - Beat detection: onset energy flux + adaptive threshold + BPM
 *    autocorrelation. Produces real beat timestamps for sync features.
 */
import type { AudioClip, ProjectDoc, VideoClip, EffectInstance } from './types'
import { evalKeyframeTrack } from './keyframes'
import { EFFECT_MAP } from './effects'
import { clipAverageSpeed, clipSourceTime } from './speed'
import { mediaManager } from '../media/mediaManager'

interface ClipAudioNode {
  el: HTMLMediaElement
  source: MediaElementAudioSourceNode
  gain: GainNode
  filterNodes: AudioNode[]
  clipId: string
}

export class AudioEngine {
  ctx: AudioContext | null = null
  master: GainNode | null = null
  private nodes = new Map<string, ClipAudioNode>()
  /**
   * A media element can be wrapped by createMediaElementSource() only ONCE for
   * its whole life. We used to drop the source when a clip stopped being
   * audible and create a new one when it became audible again: the 2nd call
   * threw InvalidStateError, was swallowed, and the clip stayed SILENT forever
   * (that's why audio died after the first pass / after going back to 0).
   * Now the source is cached per element and only re-wired.
   */
  private srcCache = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>()

  private dropNode(node: ClipAudioNode) {
    try { node.source.disconnect() } catch { }
    try { node.gain.disconnect() } catch { }
    for (const n of node.filterNodes) { try { n.disconnect() } catch { } }
  }
  private mediaStreamDest: MediaStreamAudioDestinationNode | null = null

  ensureContext(): AudioContext {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.ctx = new AC()
      this.master = this.ctx.createGain()
      this.master.gain.value = 1
      this.master.connect(this.ctx.destination)
      mediaManager.setAudioContext(this.ctx)
    }
    return this.ctx
  }

  /** Unlock audio on iOS — call from a user gesture. */
  async unlock() {
    const ctx = this.ensureContext()
    if (ctx.state === 'suspended') {
      try { await ctx.resume() } catch { /* ignore */ }
    }
  }

  getMediaStreamDestination(): MediaStreamAudioDestinationNode {
    const ctx = this.ensureContext()
    if (!this.mediaStreamDest) {
      this.mediaStreamDest = ctx.createMediaStreamDestination()
      this.master!.connect(this.mediaStreamDest)
    }
    return this.mediaStreamDest
  }

  /** Build effect chain nodes for a clip's audio effects. */
  private buildEffectChain(effects: EffectInstance[], source: AudioNode): { head: AudioNode; nodes: AudioNode[] } {
    const ctx = this.ensureContext()
    const nodes: AudioNode[] = []
    let head: AudioNode = source
    for (const e of effects) {
      if (!e.enabled) continue
      const def = EFFECT_MAP[e.type]
      if (!def || def.category !== 'audio') continue
      if (e.type === 'bass_boost') {
        const f = ctx.createBiquadFilter()
        f.type = 'lowshelf'
        f.frequency.value = 200
        f.gain.value = e.params.gainDB ?? 6
        head.connect(f); head = f; nodes.push(f)
      } else if (e.type === 'treble_boost') {
        const f = ctx.createBiquadFilter()
        f.type = 'highshelf'
        f.frequency.value = 3000
        f.gain.value = e.params.gainDB ?? 4
        head.connect(f); head = f; nodes.push(f)
      } else if (e.type === 'reverb') {
        const conv = ctx.createConvolver()
        const decay = Math.max(0.2, e.params.decay ?? 1.8)
        const rate = ctx.sampleRate
        const len = Math.floor(rate * decay)
        const impulse = ctx.createBuffer(2, len, rate)
        for (let c = 0; c < 2; c++) {
          const d = impulse.getChannelData(c)
          for (let i = 0; i < len; i++) {
            d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5)
          }
        }
        conv.buffer = impulse
        const wet = ctx.createGain()
        wet.gain.value = e.params.mix ?? 0.25
        const dry = ctx.createGain()
        dry.gain.value = 1 - (e.params.mix ?? 0.25) * 0.5
        head.connect(conv)
        conv.connect(wet)
        wet.connect(masterOf(this))
        head.connect(dry)
        dry.connect(masterOf(this))
        nodes.push(conv, wet, dry)
        // keep chain flowing: head continues as dry path
      } else if (e.type === 'compressor') {
        const comp = ctx.createDynamicsCompressor()
        comp.threshold.value = e.params.threshold ?? -18
        comp.ratio.value = e.params.ratio ?? 6
        head.connect(comp); head = comp; nodes.push(comp)
      }
    }
    return { head, nodes }
  }

  /**
   * Sync audio graph to the document at a given time.
   * Called every render tick; creates/disposes nodes lazily, sets volume.
   */
  sync(doc: ProjectDoc, time: number, playing: boolean, muted: boolean) {
    const ctx = this.ensureContext()
    if (playing && ctx.state !== 'running') { void ctx.resume().catch(() => { }) }
    const audibleClips: { clip: AudioClip | VideoClip; gain: number }[] = []
    for (const track of doc.tracks) {
      if (track.muted || !track.visible && track.kind !== 'audio') continue
      if (track.kind !== 'audio' && track.kind !== 'video') continue
      for (const clip of doc.clips) {
        if (clip.trackId !== track.id) continue
        if (clip.kind !== 'audio' && clip.kind !== 'video') continue
        if (time < clip.start - 0.001 || time >= clip.start + clip.duration) continue
        const local = time - clip.start
        const baseVol = clip.kind === 'audio' ? (clip as AudioClip).volume : 1
        const kf = evalKeyframeTrack(clip.keyframes.find(k => k.property === 'volume'), local, baseVol) ?? baseVol
        let gain = kf
        if (clip.kind === 'audio') {
          const ac = clip as AudioClip
          if (ac.fadeIn > 0 && local < ac.fadeIn) gain *= local / ac.fadeIn
          const outStart = clip.duration - ac.fadeOut
          if (ac.fadeOut > 0 && local > outStart) gain *= Math.max(0, (clip.duration - local) / ac.fadeOut)
        }
        audibleClips.push({ clip: clip as AudioClip | VideoClip, gain })
      }
    }

    const liveIds = new Set(audibleClips.map(a => a.clip.id))
    // dispose nodes for clips no longer audible
    for (const [id, node] of this.nodes) {
      if (!liveIds.has(id)) {
        this.dropNode(node)
        this.nodes.delete(id)
      }
    }

    for (const { clip, gain } of audibleClips) {
      const assetId = (clip as AudioClip).assetId
      const asset = doc.assets.find(a => a.id === assetId) ?? mediaManager.assets.get(assetId)
      if (!asset) continue
      let node = this.nodes.get(clip.id)
      if (node && node.el !== mediaManager.getElement(clip as unknown as VideoClip)) {
        this.dropNode(node)
        this.nodes.delete(clip.id)
        node = undefined
      }
      const el = mediaManager.getElement(clip as unknown as VideoClip)
      if (!el) continue
      if (!node) {
        try {
          let source = this.srcCache.get(el)
          if (source) { try { source.disconnect() } catch { } }
          else { source = ctx.createMediaElementSource(el); this.srcCache.set(el, source) }
          const gainNode = ctx.createGain()
          const chain = this.buildEffectChain(clip.effects, source)
          chain.head.connect(gainNode)
          gainNode.connect(this.master!)
          node = { el, source, gain: gainNode, filterNodes: chain.nodes, clipId: clip.id }
          this.nodes.set(clip.id, node)
        } catch {
          // element already attached to another context or unsupported
          continue
        }
      }
      // volume
      const target = muted ? 0 : gain
      node.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.02)
      // rate + position handled by playback engine (video elements) / here for audio
      if (clip.kind === 'audio') {
        const ac = clip as AudioClip
        const srcTime = clipSourceTime(ac, time - ac.start)
        const rate = clipAverageSpeed(ac) * (ac.reverse ? -1 : 1)
        const rateClamped = Math.min(16, Math.max(0.0625, Math.abs(rate) || 1))
        if (Math.abs(el.playbackRate - rateClamped) > 0.01) {
          try { el.playbackRate = rateClamped } catch { }
        }
        if (playing) {
          if (Math.abs(el.currentTime - srcTime) > 0.15) {
            try { el.currentTime = srcTime } catch { }
          }
          if (el.paused) { el.play().catch(() => { }) }
        } else {
          if (!el.paused) el.pause()
          if (Math.abs(el.currentTime - srcTime) > 0.02) {
            try { el.currentTime = srcTime } catch { }
          }
        }
      }
    }
  }

  stopAll() {
    for (const [, node] of this.nodes) {
      if (!node.el.paused) node.el.pause()
    }
  }

  dispose() {
    for (const [, node] of this.nodes) this.dropNode(node)
    this.nodes.clear()
  }
}

function masterOf(engine: AudioEngine): AudioNode {
  engine.ensureContext()
  return engine.master!
}

// ---------------------------------------------------------------------------
// Beat detection (real DSP, runs on decoded AudioBuffer)
// ---------------------------------------------------------------------------

export interface BeatResult {
  beats: number[]
  bpm: number
}

/**
 * Onset-based beat detection:
 *  1. Downmix + compute short-window RMS energy (spectral-flux-like via
 *     positive energy deltas)
 *  2. Adaptive threshold peak picking → onset times
 *  3. BPM via autocorrelation of the onset strength envelope
 */
export async function detectBeats(url: string, opts?: { sensitivity?: number }): Promise<BeatResult> {
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ctx = new AC()
  try {
    const res = await fetch(url)
    const buf = await res.arrayBuffer()
    const audio = await ctx.decodeAudioData(buf)
    const ch0 = audio.getChannelData(0)
    const ch1 = audio.numberOfChannels > 1 ? audio.getChannelData(1) : ch0
    const sr = audio.sampleRate
    const win = Math.floor(sr * 0.01) // 10ms windows
    const n = Math.floor(ch0.length / win)
    const energy = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let sum = 0
      const s = i * win
      for (let j = 0; j < win; j++) {
        const v = (ch0[s + j] + ch1[s + j]) / 2
        sum += v * v
      }
      energy[i] = Math.sqrt(sum / win)
    }
    // flux: positive delta
    const flux = new Float32Array(n)
    for (let i = 1; i < n; i++) flux[i] = Math.max(0, energy[i] - energy[i - 1])
    // smooth
    const smooth = new Float32Array(n)
    const k = 3
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0
      for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) { s += flux[j]; c++ }
      smooth[i] = s / c
    }
    // adaptive threshold peak picking
    const sensitivity = opts?.sensitivity ?? 1.4
    const beats: number[] = []
    const w = Math.floor(0.35 / 0.01) // 350ms local window (~35)
    for (let i = 2; i < n - 2; i++) {
      const localMean = avgAround(smooth, i, w)
      const thresh = localMean * sensitivity + 1e-4
      if (smooth[i] > thresh && smooth[i] >= smooth[i - 1] && smooth[i] >= smooth[i + 1]) {
        const t = i * 0.01
        if (beats.length === 0 || t - beats[beats.length - 1] > 0.12) {
          beats.push(t)
        }
      }
    }
    // BPM via autocorrelation of onset envelope (60–200 BPM range)
    let bestBpm = 0
    let bestScore = 0
    const fpsEnv = 100 // 10ms windows
    for (let bpm = 60; bpm <= 200; bpm += 0.5) {
      const lag = Math.round((60 / bpm) * fpsEnv)
      let score = 0
      for (let i = 0; i + lag < n; i++) score += smooth[i] * smooth[i + lag]
      if (score > bestScore) { bestScore = score; bestBpm = bpm }
    }
    void ctx.close()
    return { beats, bpm: bestBpm }
  } catch {
    void ctx.close()
    return { beats: [], bpm: 0 }
  }
}

function avgAround(arr: Float32Array, i: number, w: number): number {
  const a = Math.max(0, i - w), b = Math.min(arr.length - 1, i + w)
  let s = 0
  for (let j = a; j <= b; j++) s += arr[j]
  return s / (b - a + 1)
}

export const audioEngine = new AudioEngine()
