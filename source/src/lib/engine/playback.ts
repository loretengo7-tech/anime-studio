/**
 * ANIME STUDIO — Playback Engine
 *
 * Coordinates the compositor, media elements and audio graph:
 *  - Realtime playback (constant-speed clips play natively with drift correction)
 *  - Seek-based playback for time-remapped / extreme-speed clips
 *  - Frame-accurate stepping and scrubbing
 *  - Time subscription for UI (playhead, timecode) without re-render storms
 */
import type { ProjectDoc, VideoClip } from './types'
import { projectDuration } from './types'
import { Compositor, setCompositorFps } from './compositor'
import { clipSourceTime, clipAverageSpeed } from './speed'
import { audioEngine } from './audio'
import { mediaManager } from '../media/mediaManager'

export interface PlaybackState {
  playing: boolean
  time: number
  rate: number
  loop: boolean
  inPoint: number | null
  outPoint: number | null
}

type Listener = (time: number) => void

class PlaybackEngine {
  compositor = new Compositor()
  doc: ProjectDoc | null = null
  state: PlaybackState = { playing: false, time: 0, rate: 1, loop: false, inPoint: null, outPoint: null }
  muted = false
  previewQuality: 'quarter' | 'half' | 'full' = 'half'
  compareMode = false
  private listeners = new Set<Listener>()
  private rafId = 0
  private lastFrameTime = 0
  private seekInFlight = new Set<string>()
  private statsFrames = 0
  private statsStart = 0
  private lastTrim = 0
  fps = 30
  /**
   * While true the preview loop does NOTHING (no seeks, no play(), no render).
   * The export engines share the same <video> elements as the preview; if the
   * preview keeps seeking them back to the playhead, export frames randomly
   * show the wrong source time (micro-shake), seeks never settle (freeze) and
   * readyState drops mid-seek (black frames).
   */
  suspended = false

  setSuspended(v: boolean) {
    this.suspended = v
    if (v) {
      this.state.playing = false
      audioEngine.stopAll()
    } else {
      this.lastFrameTime = 0
    }
  }

  get currentTime(): number {
    return this.state.time
  }

  setDoc(doc: ProjectDoc | null) {
    const old = this.doc
    this.doc = doc
    if (doc) {
      this.fps = doc.composition.fps
      setCompositorFps(doc.composition.fps)
    }
    if (old && doc && old.id !== doc.id) {
      // project switch: release all media elements
      mediaManager.dispose()
      this.compositor.disposeAllTextures()
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit() {
    for (const fn of this.listeners) fn(this.state.time)
  }

  /**
   * Like subscribe(), but while playing the callback runs at most every `ms`.
   * Use it for React state (inspector values, timecode, transport): re-rendering
   * big React trees 60x/s is what made the whole UI (and the preview) lag.
   */
  subscribeThrottled(fn: Listener, ms = 100): () => void {
    let last = 0
    return this.subscribe(t => {
      const n = now0()
      if (this.state.playing && n - last < ms) return
      last = n
      fn(t)
    })
  }

  // idle-render / emit gating (see tick)
  private rDoc: ProjectDoc | null = null
  private rTime = NaN
  private rCompare = false
  private rW = 0
  private rH = 0
  private rLast = 0
  private rFrame = -1
  private rChanged = 0
  private eTime = NaN
  private ePlaying = false
  private eLast = 0

  attach(canvas: HTMLCanvasElement) {
    this.compositor.attach(canvas)
    this.ensureLoop()
  }

  private renderScaleForQuality(): number {
    if (!this.doc) return 0.5
    const q = this.previewQuality
    const maxDim = q === 'quarter' ? 480 : q === 'half' ? 960 : 1920
    const srcMax = Math.max(this.doc.composition.width, this.doc.composition.height)
    return Math.min(1, maxDim / srcMax)
  }

  syncCanvasSize(canvas: HTMLCanvasElement) {
    if (!this.doc) return
    const scale = this.renderScaleForQuality()
    const w = Math.max(2, Math.round(this.doc.composition.width * scale))
    const h = Math.max(2, Math.round(this.doc.composition.height * scale))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
      this.compositor.resize()
    }
  }

  private ensureLoop() {
    if (this.rafId) return
    const tick = (now: number) => {
      this.rafId = requestAnimationFrame(tick)
      const dt = this.lastFrameTime ? (now - this.lastFrameTime) / 1000 : 0
      this.lastFrameTime = now
      this.tick(dt)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private tick(dt: number) {
    if (this.suspended) return
    const doc = this.doc
    if (!doc) return
    const canvas = (this.compositor as unknown as { canvas: HTMLCanvasElement | null }).canvas
    if (!canvas) return
    this.syncCanvasSize(canvas)

    if (this.state.playing) {
      // advance time by real dt * user rate
      const next = this.state.time + dt * this.state.rate
      const end = this.state.outPoint ?? projectDuration(doc)
      const start = this.state.inPoint ?? 0
      if (next >= end) {
        if (this.state.loop) {
          this.state.time = start
        } else {
          this.state.time = end
          this.pause()
        }
      } else {
        this.state.time = Math.max(start, next)
      }
    }

    // When paused and nothing changed (time, doc, size, compare) there is no
    // need to re-run the whole effect pipeline 60x/s: it burns the GPU/battery
    // (thermal throttling => the preview lags later). Keep a short grace after
    // each change (seeks/textures settling) and a slow refresh for late-loading media.
    const nowT = now0()
    // PERF: while playing, only re-composite when the COMPOSITION frame changes.
    // 120 Hz displays (ProMotion iPhone/iPad, gaming monitors) used to run the
    // whole WebGL effect pipeline 4x per 30 fps frame. Media + audio still sync
    // every tick so drift correction stays tight.
    const compFrame = Math.floor(this.state.time * Math.max(1, doc.composition.fps) + 1e-6)
    const newFrame = compFrame !== this.rFrame
    const dirty =
      (this.state.playing && newFrame) ||
      doc !== this.rDoc ||
      this.state.time !== this.rTime ||
      this.compareMode !== this.rCompare ||
      canvas.width !== this.rW ||
      canvas.height !== this.rH ||
      this.seekInFlight.size > 0
    if (dirty) this.rChanged = nowT
    if (this.state.playing && !dirty) {
      // between comp frames: keep media/audio in sync, skip the GPU work
      this.driveMedia(doc, this.state.time, true)
      audioEngine.sync(doc, this.state.time, true, this.muted)
    } else if (dirty || nowT - this.rChanged < 600 || nowT - this.rLast > 250) {
      this.rLast = nowT
      this.rFrame = compFrame
      this.rDoc = doc
      this.rTime = this.state.time
      this.rCompare = this.compareMode
      this.rW = canvas.width
      this.rH = canvas.height
      this.driveMedia(doc, this.state.time, this.state.playing)
      audioEngine.sync(doc, this.state.time, this.state.playing, this.muted)
      this.compositor.render(doc, mediaManager, {
        time: this.state.time,
        bypassEffects: this.compareMode,
      })
    }
    // mobile memory guard: every ~2s release GPU textures of clips far from the playhead
    const nowMs = now0()
    if (nowMs - this.lastTrim > 2000) {
      this.lastTrim = nowMs
      const active = new Set<string>()
      for (const c of doc.clips) {
        if (this.state.time >= c.start - 3 && this.state.time <= c.start + c.duration + 3) active.add(c.id)
      }
      this.compositor.trimUnusedTextures(active)
    }
    this.statsFrames++
    if (now0() - this.statsStart > 1000) {
      this.fpsMeasured = Math.round((this.statsFrames * 1000) / (now0() - this.statsStart))
      this.statsFrames = 0
      this.statsStart = now0()
    }
    // only notify when something observable changed (was: every frame, even idle)
    if (this.state.playing || this.state.time !== this.eTime || this.state.playing !== this.ePlaying || now0() - this.eLast > 500) {
      this.eTime = this.state.time
      this.ePlaying = this.state.playing
      this.eLast = now0()
      this.emit()
    }
  }

  fpsMeasured = 0

  /** Public so the realtime export can drive the shared video elements itself. */
  driveMedia(doc: ProjectDoc, time: number, playing: boolean) {
    for (const track of doc.tracks) {
      if (track.kind !== 'video') continue
      for (const clip of doc.clips) {
        if (clip.trackId !== track.id || clip.kind !== 'video') continue
        const vc = clip as VideoClip
        const active = time >= vc.start - 0.03 && time < vc.start + vc.duration
        const el = mediaManager.getElement(vc)
        if (!el) continue
        if (!active) {
          if (!el.paused) el.pause()
          continue
        }
        const local = time - vc.start
        const srcTime = clipSourceTime(vc, local)
        const avg = clipAverageSpeed(vc)
        const isNativeRate = !vc.timeRemap && !vc.reverse && avg >= 0.25 && avg <= 4
        const playBlocked = el.dataset.playBlocked === '1'
        if (playing && isNativeRate && !track.locked && !playBlocked) {
          void mediaManager.playAt(el, srcTime, avg * this.state.rate)
        } else {
          // seek-based (paused, scrubbing, remapped, reversed, extreme speed, or play() blocked)
          if (!playing && !el.paused) el.pause()
          const drift = Math.abs(el.currentTime - srcTime)
          const threshold = playing ? 0.12 : 0.02
          if (drift > threshold && !this.seekInFlight.has(vc.id)) {
            this.seekInFlight.add(vc.id)
            mediaManager.seek(el, srcTime).finally(() => this.seekInFlight.delete(vc.id))
          }
        }
      }
    }
  }

  // ---- public controls ----

  play() {
    void audioEngine.unlock()
    this.state.playing = true
    this.lastFrameTime = 0
  }

  pause() {
    this.state.playing = false
    audioEngine.stopAll()
    for (const [, pool] of (mediaManager as unknown as { pools: Map<string, Map<string, { el: HTMLVideoElement }>> }).pools) {
      for (const [, e] of pool) e.el.pause()
    }
  }

  toggle() {
    if (this.state.playing) this.pause(); else this.play()
  }

  seek(time: number) {
    const doc = this.doc
    if (!doc) return
    this.state.time = Math.max(0, Math.min(projectDuration(doc), time))
    this.emit()
  }

  stepFrame(frames: number) {
    const fps = this.doc?.composition.fps ?? 30
    this.pause()
    this.seek(this.state.time + frames / fps)
  }

  goToStart() {
    this.seek(this.state.inPoint ?? 0)
  }

  goToEnd() {
    const doc = this.doc
    if (!doc) return
    this.seek(this.state.outPoint ?? projectDuration(doc))
  }

  setRate(rate: number) {
    this.state.rate = Math.min(4, Math.max(0.1, rate))
  }

  setQuality(q: 'quarter' | 'half' | 'full') {
    this.previewQuality = q
    const canvas = (this.compositor as unknown as { canvas: HTMLCanvasElement | null }).canvas
    if (canvas && this.doc) {
      this.syncCanvasSize(canvas)
      this.compositor.resize()
    }
  }

  toggleCompare(): boolean {
    this.compareMode = !this.compareMode
    return this.compareMode
  }

  setLoop(loop: boolean) {
    this.state.loop = loop
  }

  toggleMute(): boolean {
    this.muted = !this.muted
    return this.muted
  }

  dispose() {
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
    audioEngine.dispose()
    mediaManager.dispose()
    this.compositor.disposeAllTextures()
  }
}

function now0(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export const playbackEngine = new PlaybackEngine()
