'use client'
/**
 * ANIME STUDIO — Timeline
 *
 * Professional multitrack timeline for touch:
 *  - tap select, drag move (horizontal=time, vertical=track), edge trim handles
 *  - keyframe lane on the selected clip (drag keyframes)
 *  - pinch-to-zoom, snapping (grid / clip edges / playhead / beats)
 *  - audio waveforms, video thumbnails, beat markers
 *  - playhead scrubbing on the ruler, follow-playhead while playing
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Clip, VideoClip, AudioClip, TextClip } from '@/lib/engine/types'
import { uid, makeClipBase, makeSolidClip, makeShapeClip, makeNullClip, makeCameraClip } from '@/lib/engine/types'
import { useEditorStore } from '@/lib/store/editorStore'
import { playbackEngine } from '@/lib/engine/playback'
import { mediaManager } from '@/lib/media/mediaManager'
import { timecode, Waveform } from './ui-bits'
import {
  Scissors, Copy, Trash2, Magnet, ZoomIn, ZoomOut, Maximize,
  Lock, LockOpen, Eye, EyeOff, Volume2, VolumeX, Type, MapPin,
  ChevronsUpDown, ChevronUp, ChevronDown, Plus,
} from 'lucide-react'

const HEADER_W = 78
const RULER_H = 26
const KF_LANE_H = 20
const MIN_PPS = 6
const MAX_PPS = 240

type DragState =
  | { mode: 'move'; clipId: string; startX: number; startY: number; origStart: number; origTrack: string; moved: boolean; pointerId: number }
  | { mode: 'trimL' | 'trimR'; clipId: string; startX: number; origStart: number; origDuration: number; origIn: number; pointerId: number }
  | { mode: 'kf'; clipId: string; kfId: string; startX: number; origTime: number; pointerId: number }
  | null

type GhostState = { start: number; trackId: string; dur?: number }

export function Timeline() {
  const doc = useEditorStore(s => s.doc)
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const selectedKeyframeId = useEditorStore(s => s.selectedKeyframeId)
  const select = useEditorStore(s => s.select)
  const selectKeyframe = useEditorStore(s => s.selectKeyframe)
  const mutate = useEditorStore(s => s.mutate)
  const previewActive = useEditorStore(s => s.preview !== null)

  const [pxPerSec, setPxPerSec] = useState(48)
  const [snapOn, setSnapOn] = useState(true)
  const [drag, setDrag] = useState<DragState>(null)
  const [ghost, setGhost] = useState<GhostState | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const pinchRef = useRef<{ d0: number; pps0: number; cx: number; anchorTime: number } | null>(null)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())

  const duration = useMemo(() => {
    let end = doc.composition.duration
    for (const c of doc.clips) end = Math.max(end, c.start + c.duration)
    return end
  }, [doc])
  const contentWidth = Math.max(600, (duration + 6) * pxPerSec)

  // follow playhead without re-render storms: the playhead element and the
  // autoscroll are driven imperatively; the timecode badge subscribes on its own.
  useEffect(() => {
    const apply = (t: number) => {
      const ph = playheadRef.current
      if (ph) ph.style.transform = `translateX(${t * pxPerSec}px)`
      const sc = scrollRef.current
      if (sc && playbackEngine.state.playing) {
        const x = t * pxPerSec
        const left = sc.scrollLeft
        const right = left + sc.clientWidth - HEADER_W
        if (x < left || x > right - 40) {
          sc.scrollLeft = Math.max(0, x - sc.clientWidth * 0.3)
        }
      }
    }
    apply(playbackEngine.currentTime)
    return playbackEngine.subscribe(apply)
  }, [pxPerSec])

  const snapTime = useCallback((t: number, ignoreClipId?: string): number => {
    if (!snapOn) return Math.max(0, t)
    const threshold = 12 / pxPerSec
    const targets: number[] = [0]
    for (const c of doc.clips) {
      if (c.id === ignoreClipId) continue
      targets.push(c.start, c.start + c.duration)
    }
    targets.push(playbackEngine.currentTime)
    for (const m of doc.markers) targets.push(m.time)
    for (const b of doc.beats) targets.push(b)
    let best = t, bestD = threshold
    for (const g of targets) {
      const d = Math.abs(g - t)
      if (d < bestD) { bestD = d; best = g }
    }
    // frame grid — snap to whole frames of the composition for frame-accurate edits
    const fps = Math.max(1, doc.composition.fps)
    const g = Math.round(t * fps) / fps
    if (Math.abs(g - t) < bestD) best = g
    return Math.max(0, best)
  }, [snapOn, pxPerSec, doc])

  // ---- pointer interactions ----
  const onClipPointerDown = (e: React.PointerEvent, clip: Clip, mode: 'move' | 'trimL' | 'trimR') => {
    if (previewActive) return
    const track = doc.tracks.find(t => t.id === clip.trackId)
    if (track?.locked) return
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    select(clip.id)
    if (mode === 'move') {
      setDrag({ mode, clipId: clip.id, startX: e.clientX, startY: e.clientY, origStart: clip.start, origTrack: clip.trackId, moved: false, pointerId: e.pointerId })
    } else {
      const vc = clip as VideoClip
      setDrag({ mode, clipId: clip.id, startX: e.clientX, origStart: clip.start, origDuration: clip.duration, origIn: (clip.kind === 'video' || clip.kind === 'audio') ? vc.inPoint : 0, pointerId: e.pointerId })
    }
  }

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag) return
    if (drag.mode === 'move') {
      const dx = (e.clientX - drag.startX) / pxPerSec
      const dy = e.clientY - drag.startY
      const newStart = Math.max(0, drag.origStart + dx)
      // vertical track change (same-kind tracks only).
      // tracks[0] is the visually TOP row, so dragging DOWN (dy>0) must move to
      // a LATER index. (This was inverted before — dragging down moved the clip up.)
      let trackId = drag.origTrack
      if (Math.abs(dy) > 28) {
        const currentTrack = doc.tracks.find(t => t.id === drag.origTrack)
        const candidates = doc.tracks.filter(t => t.kind === currentTrack?.kind && !t.locked)
        const idx = candidates.findIndex(t => t.id === drag.origTrack)
        const shift = dy > 0 ? 1 : -1
        const target = candidates[Math.max(0, Math.min(candidates.length - 1, idx + shift))]
        if (target) trackId = target.id
      }
      const snapped = snapTime(newStart, drag.clipId)
      setGhost({ start: snapped, trackId })
    } else if (drag.mode === 'trimL') {
      const dx = (e.clientX - drag.startX) / pxPerSec
      let newStart = Math.max(0, drag.origStart + dx)
      // never grow past the start of the source media (would freeze the first frame)
      const c0 = doc.clips.find(c => c.id === drag.clipId)
      if (c0 && (c0.kind === 'video' || c0.kind === 'audio')) {
        const minStart = drag.origStart - (drag.origIn / Math.max(0.05, c0.speed || 1))
        newStart = Math.max(newStart, Math.max(0, minStart))
      }
      const maxGrow = drag.origStart + drag.origDuration - 0.1
      const clampedStart = Math.min(newStart, maxGrow)
      const snapped = snapTime(clampedStart, drag.clipId)
      setGhost({ start: snapped, trackId: '', dur: Math.max(0.1, drag.origStart + drag.origDuration - snapped) })
    } else if (drag.mode === 'trimR') {
      const dx = (e.clientX - drag.startX) / pxPerSec
      const minDur = 0.1
      const asset = (() => {
        const c = doc.clips.find(c => c.id === drag.clipId)
        if (c && (c.kind === 'video' || c.kind === 'audio')) {
          const a = doc.assets.find(a => a.id === (c as VideoClip).assetId)
          return a
        }
        return null
      })()
      let newDur = drag.origDuration + dx
      if (asset && asset.duration > 0) {
        const maxDur = (asset.duration - drag.origIn) / Math.max(0.05, doc.clips.find(c => c.id === drag.clipId)?.speed || 1)
        newDur = Math.min(newDur, maxDur)
      }
      setGhost({ start: drag.origStart, trackId: '', dur: Math.max(minDur, snapTime(drag.origStart + Math.max(minDur, newDur), drag.clipId) - drag.origStart) })
    } else if (drag.mode === 'kf') {
      const dx = (e.clientX - drag.startX) / pxPerSec
      const newTime = Math.max(0, drag.origTime + dx)
      setGhost({ start: snapTime(newTime), trackId: `kf:${drag.kfId}` })
    }
  }, [drag, pxPerSec, doc, snapTime])

  const onPointerUp = useCallback(() => {
    if (!drag) { setGhost(null); return }
    const clip = doc.clips.find(c => c.id === drag.clipId)
    if (clip && ghost) {
      if (drag.mode === 'move' && ghost.trackId && !ghost.trackId.startsWith('kf:')) {
        mutate(d => {
          const c = d.clips.find(c => c.id === drag.clipId)
          if (c) { c.start = ghost.start; c.trackId = ghost.trackId }
        })
      } else if (drag.mode === 'move') {
        mutate(d => {
          const c = d.clips.find(c => c.id === drag.clipId)
          if (c) c.start = ghost.start
        })
      } else if (drag.mode === 'trimL') {
        const delta = ghost.start - drag.origStart
        mutate(d => {
          const c = d.clips.find(c => c.id === drag.clipId)
          if (!c) return
          const newDur = c.duration - delta
          if (newDur > 0.1) {
            c.start = ghost.start
            c.duration = newDur
            if (c.kind === 'video' || c.kind === 'audio') {
              ;(c as VideoClip).inPoint = Math.max(0, (c as VideoClip).inPoint + delta * (c.speed || 1))
            }
            // shift keyframes left
            for (const k of c.keyframes) {
              k.keyframes = k.keyframes.filter(kf => kf.time >= delta).map(kf => ({ ...kf, time: kf.time - delta }))
            }
          }
        })
      } else if (drag.mode === 'trimR') {
        const newDur = (ghost as { dur?: number }).dur ?? clip.duration
        mutate(d => {
          const c = d.clips.find(c => c.id === drag.clipId)
          if (c) c.duration = Math.max(0.1, newDur)
        })
      } else if (drag.mode === 'kf' && ghost.trackId.startsWith('kf:')) {
        // commit the dragged keyframe time (this was a no-op before — the ghost
        // rendered but the new time was never saved)
        const newTime = ghost.start
        mutate(d => {
          for (const k of d.clips.find(c => c.id === drag.clipId)?.keyframes ?? []) {
            const kf = k.keyframes.find(kf => kf.id === drag.kfId)
            if (kf) kf.time = newTime
          }
          for (const c of d.clips) {
            for (const e of c.effects) {
              const kfs = e.paramKeyframes?.[Object.keys(e.paramKeyframes ?? {}).find(pk => e.paramKeyframes![pk]?.some(kf => kf.id === drag.kfId)) ?? '']
              const kf = kfs?.find(kf => kf.id === drag.kfId)
              if (kf) kf.time = newTime
            }
          }
        })
        selectKeyframe(drag.kfId)
      }
    }
    setDrag(null)
    setGhost(null)
  }, [drag, ghost, doc, mutate, selectKeyframe])

  const onKfPointerDown = (e: React.PointerEvent, clipId: string, kfId: string, origTime: number) => {
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    selectKeyframe(kfId)
    setDrag({ mode: 'kf', clipId, kfId, startX: e.clientX, origTime, pointerId: e.pointerId })
  }

  // pinch zoom on the scroll area
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]]
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      const cx = (a.clientX + b.clientX) / 2
      const sc = scrollRef.current
      const rect = sc?.getBoundingClientRect()
      const anchorX = rect ? cx - rect.left + (sc?.scrollLeft ?? 0) - HEADER_W : 0
      pinchRef.current = { d0: d, pps0: pxPerSec, cx, anchorTime: anchorX / pxPerSec }
    } else {
      pinchRef.current = null
    }
  }
  const onTouchMove = (e: React.TouchEvent) => {
    const pinch = pinchRef.current
    if (e.touches.length === 2 && pinch) {
      const [a, b] = [e.touches[0], e.touches[1]]
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      const factor = d / Math.max(1, pinch.d0)
      const next = Math.max(MIN_PPS, Math.min(MAX_PPS, pinch.pps0 * factor))
      const sc = scrollRef.current
      if (sc) {
        sc.scrollLeft = Math.max(0, pinch.anchorTime * next - (pinch.cx - (sc.getBoundingClientRect().left)) + HEADER_W)
      }
      setPxPerSec(next)
    }
  }

  // Playhead scrubbing — pointer-captured so the drag keeps working when the
  // finger/cursor leaves the 26px ruler strip (the classic "playhead freezes"
  // bug). Works with mouse, pen and touch.
  const scrubbingRef = useRef(false)
  const rulerScrub = (e: React.PointerEvent) => {
    const sc = scrollRef.current
    if (!sc) return
    const rect = sc.getBoundingClientRect()
    const x = e.clientX - rect.left + sc.scrollLeft - HEADER_W
    playbackEngine.pause()
    playbackEngine.seek(Math.max(0, Math.min(duration, x / pxPerSec)))
  }
  const onRulerPointerDown = (e: React.PointerEvent) => {
    if (previewActive) return
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    scrubbingRef.current = true
    rulerScrub(e)
  }
  const onRulerPointerMove = (e: React.PointerEvent) => {
    if (!scrubbingRef.current) return
    rulerScrub(e)
  }
  const onRulerPointerUp = (e: React.PointerEvent) => {
    scrubbingRef.current = false
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
  }

  const selClip = doc.clips.find(c => c.id === selectedClipId) ?? null

  const addTrack = (kind: 'video' | 'audio' | 'text') => {
    mutate(d => {
      const n = d.tracks.filter(t => t.kind === kind).length + 1
      const track = { id: uid('track'), kind, name: `${kind === 'video' ? 'Video' : kind === 'audio' ? 'Audio' : 'Text'} ${n}`, locked: false, visible: true, muted: false, height: kind === 'audio' ? 56 : kind === 'text' ? 44 : 64 }
      if (kind === 'video') d.tracks.splice(1, 0, track)
      else if (kind === 'text') d.tracks.unshift(track)
      else d.tracks.push(track)
    })
  }

  // AE-style new layer menu: solid / shape / null / camera / adjustment at the playhead
  const addLayerClip = (kind: 'solid' | 'shape' | 'null' | 'camera' | 'adjustment') => {
    let newId: string | null = null
    mutate(d => {
      const track = d.tracks.find(t => t.kind === 'video' && !t.locked) ?? d.tracks.find(t => t.kind === 'video')
      if (!track) return
      const at = playbackEngine.currentTime
      const dur = Math.max(2, d.composition.duration - at)
      newId = uid('clip')
      if (kind === 'solid') d.clips.push({ ...makeSolidClip(track.id, at, dur, '#ffffff'), id: newId })
      else if (kind === 'shape') d.clips.push({ ...makeShapeClip(track.id, at, dur, d.composition.width, d.composition.height), id: newId })
      else if (kind === 'null') d.clips.push({ ...makeNullClip(track.id, at, dur), id: newId })
      else if (kind === 'camera') d.clips.push({ ...makeCameraClip(track.id, at, dur, d.composition.height), id: newId })
      else d.clips.push({ ...makeClipBase(track.id, 'Adjustment', at, dur), id: newId, kind: 'adjustment', affectCount: 0 })
    })
    if (newId) select(newId)
  }

  const moveTrack = (trackId: string, dir: -1 | 1) => {
    mutate(d => {
      const i = d.tracks.findIndex(t => t.id === trackId)
      const j = i + dir
      if (i < 0 || j < 0 || j >= d.tracks.length) return
      const [t] = d.tracks.splice(i, 1)
      d.tracks.splice(j, 0, t)
    })
  }

  return (
    <div className="flex flex-col h-full min-h-0 glass-inset no-select" data-testid="timeline">
      {/* toolbar */}
      <div className="h-10 shrink-0 flex items-center gap-1 px-2 border-b border-white/8 glass overflow-x-auto as-scroll">
        <button className="tl-btn" onClick={() => {
          if (!selClip) return
          playbackEngine.pause()
          mutate(d => {
            const clip = d.clips.find(c => c.id === selClip.id)
            if (!clip) return
            const at = playbackEngine.currentTime
            const local = at - clip.start
            if (local <= 0.05 || local >= clip.duration - 0.05) return
            const right = JSON.parse(JSON.stringify(clip)) as Clip
            right.id = uid('clip')
            right.start = clip.start + local
            right.duration = clip.duration - local
            right.keyframes = right.keyframes.map(k => ({
              ...k,
              keyframes: k.keyframes.filter(kf => kf.time >= local).map(kf => ({ ...kf, time: kf.time - local })),
            })).filter(k => k.keyframes.length > 0)
            if (right.kind === 'video' || right.kind === 'audio') {
              ;(right as VideoClip).inPoint = (clip as VideoClip).inPoint + local * clip.speed
            }
            clip.duration = local
            d.clips.push(right)
          })
        }} disabled={!selClip} aria-label="Split clip"><Scissors size={14} /></button>
        <button className="tl-btn" disabled={!selClip} onClick={() => {
          if (!selClip) return
          mutate(d => {
            const clip = d.clips.find(c => c.id === selClip.id)
            if (!clip) return
            const copy = JSON.parse(JSON.stringify(clip)) as Clip
            copy.id = uid('clip')
            copy.start = clip.start + clip.duration
            d.clips.push(copy)
          })
        }} aria-label="Duplicate clip"><Copy size={14} /></button>
        <button className="tl-btn text-red-400" disabled={!selClip} onClick={() => {
          if (!selClip) return
          mutate(d => { d.clips = d.clips.filter(c => c.id !== selClip.id) })
          select(null)
          mediaManager.releaseClip(selClip.id)
        }} aria-label="Delete clip"><Trash2 size={14} /></button>
        <div className="w-px h-5 bg-zinc-700 mx-1" />
        <button className={`tl-btn ${snapOn ? 'text-amber-400' : ''}`} onClick={() => setSnapOn(s => !s)} aria-label="Toggle snapping"><Magnet size={14} /></button>
        <button className="tl-btn" onClick={() => setPxPerSec(p => Math.max(MIN_PPS, p / 1.4))} aria-label="Zoom out"><ZoomOut size={14} /></button>
        <button className="tl-btn" onClick={() => setPxPerSec(p => Math.min(MAX_PPS, p * 1.4))} aria-label="Zoom in"><ZoomIn size={14} /></button>
        <button className="tl-btn" onClick={() => setPxPerSec(p => {
          const sc = scrollRef.current?.clientWidth ?? 800
          return Math.max(MIN_PPS, Math.min(MAX_PPS, (sc - 120) / Math.max(2, duration)))
        })} aria-label="Fit"><Maximize size={14} /></button>
        <div className="w-px h-5 bg-zinc-700 mx-1" />
        <button className="tl-btn" onClick={() => addTrack('video')} aria-label="Add video track"><Plus size={14} />V</button>
        <button className="tl-btn" onClick={() => addTrack('audio')} aria-label="Add audio track"><Plus size={14} />A</button>
        <button className="tl-btn" onClick={() => addTrack('text')} aria-label="Add text track"><Type size={14} /></button>
        <div className="w-px h-5 bg-zinc-700 mx-1" />
        <button className="tl-btn" onClick={() => addLayerClip('solid')} aria-label="New solid layer" title="New Solid">▣</button>
        <button className="tl-btn" onClick={() => addLayerClip('shape')} aria-label="New shape layer" title="New Shape">◇</button>
        <button className="tl-btn" onClick={() => addLayerClip('null')} aria-label="New null object" title="New Null">∅</button>
        <button className="tl-btn" onClick={() => addLayerClip('camera')} aria-label="New 3D camera" title="New Camera">◎</button>
        <button className="tl-btn" onClick={() => addLayerClip('adjustment')} aria-label="New adjustment layer" title="New Adjustment">◐</button>
        <button className="tl-btn" onClick={() => {
          mutate(d => {
            d.markers.push({ id: uid('m'), time: playbackEngine.currentTime, label: 'Marker', color: '#f59e0b' })
          })
        }} aria-label="Add marker"><MapPin size={14} /></button>
        <span className="ml-auto text-[10px] text-zinc-500 as-mono pr-1"><TimecodeBadge fps={doc.composition.fps} /></span>
      </div>

      {/* scrollable timeline body */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-auto as-scroll as-timeline relative"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div ref={contentRef} style={{ width: contentWidth + HEADER_W }} className="relative min-h-full">
          {/* ruler */}
          <div
            className="sticky top-0 z-30 glass-strong border-b border-white/8 cursor-ew-resize"
            style={{ height: RULER_H, width: contentWidth + HEADER_W, touchAction: 'none' }}
            onPointerDown={onRulerPointerDown}
            onPointerMove={onRulerPointerMove}
            onPointerUp={onRulerPointerUp}
            onPointerCancel={onRulerPointerUp}
          >
            <div style={{ marginLeft: HEADER_W, height: '100%', position: 'relative' }}>
              {rulerTicks(duration + 6, pxPerSec, doc.composition.fps).map(({ t, major }) => (
                <div key={t} className="absolute top-0 h-full flex flex-col justify-end pointer-events-none" style={{ left: t * pxPerSec }}>
                  <div className={major ? 'w-px h-2.5 bg-zinc-500' : 'w-px h-1 bg-zinc-700'} />
                  {major && <span className="as-mono text-[9px] text-zinc-500 -translate-x-0.5">{formatTick(t)}</span>}
                </div>
              ))}
              {doc.markers.map(m => (
                <div key={m.id} className="absolute top-0 pointer-events-none" style={{ left: m.time * pxPerSec }}>
                  <MapPin size={10} style={{ color: m.color }} />
                </div>
              ))}
            </div>
          </div>

          {/* tracks */}
          {doc.tracks.map((track, ti) => {
            const clips = doc.clips.filter(c => c.trackId === track.id)
            const isSelTrack = selClip?.trackId === track.id
            return (
              <div key={track.id} className="flex border-b border-white/8/60" style={{ height: track.height + (isSelTrack && selClip && hasKeyframes(selClip) ? KF_LANE_H : 0) }}>
                {/* header */}
                <div
                  className="sticky left-0 z-20 glass border-r border-white/8 flex items-center gap-1 px-1.5 shrink-0"
                  style={{ width: HEADER_W }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] text-zinc-300 truncate leading-tight">{track.name}</div>
                    <div className="flex items-center gap-0.5 mt-0.5">
                      <button className={`p-0.5 ${track.locked ? 'text-amber-400' : 'text-zinc-600'}`} onClick={() => mutate(d => { const t = d.tracks.find(t => t.id === track.id); if (t) t.locked = !t.locked })} aria-label="Lock track">
                        {track.locked ? <Lock size={10} /> : <LockOpen size={10} />}
                      </button>
                      <button className={`p-0.5 ${track.visible ? 'text-zinc-400' : 'text-red-400'}`} onClick={() => mutate(d => { const t = d.tracks.find(t => t.id === track.id); if (t) t.visible = !t.visible })} aria-label="Show/hide track">
                        {track.visible ? <Eye size={10} /> : <EyeOff size={10} />}
                      </button>
                      {(track.kind === 'video' || track.kind === 'audio') && (
                        <button className={`p-0.5 ${track.muted ? 'text-red-400' : 'text-zinc-600'}`} onClick={() => mutate(d => { const t = d.tracks.find(t => t.id === track.id); if (t) t.muted = !t.muted })} aria-label="Mute track">
                          {track.muted ? <VolumeX size={10} /> : <Volume2 size={10} />}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col">
                    <button className="p-0.5 text-zinc-600 hover:text-zinc-300" onClick={() => moveTrack(track.id, -1)} aria-label="Move track up"><ChevronUp size={9} /></button>
                    <button className="p-0.5 text-zinc-600 hover:text-zinc-300" onClick={() => moveTrack(track.id, 1)} aria-label="Move track down"><ChevronDown size={9} /></button>
                  </div>
                </div>

                {/* lane */}
                <div
                  className="relative flex-1"
                  style={{ background: ti % 2 === 0 ? 'rgba(255,255,255,0.015)' : 'transparent' }}
                  onPointerDown={() => select(null)}
                >
                  {clips.map(clip => {
                    const selected = clip.id === selectedClipId
                    const shown = ghost && drag?.clipId === clip.id ? ghost : null
                    const left = (shown && !shown.trackId.startsWith('kf:') ? shown.start : clip.start) * pxPerSec
                    const width = Math.max(8, ((shown && (shown as { dur?: number }).dur ? (shown as { dur?: number }).dur! : clip.duration)) * pxPerSec)
                    const asset = (clip.kind === 'video' || clip.kind === 'audio' || clip.kind === 'image') ? doc.assets.find(a => a.id === (clip as VideoClip).assetId) : null
                    return (
                      <div key={clip.id}>
                        <div
                          className={`as-clip absolute rounded-md overflow-hidden ${selected ? 'as-selected' : ''}`}
                          style={{
                            // NOTE: the lane already starts AFTER the 78px track
                            // header (flex row), so x here must be plain time*pps.
                            // Adding HEADER_W again drew every clip ~78px (≈2s)
                            // too far right — the "clip stuck at second 2" bug.
                            left: left,
                            width,
                            top: 3,
                            height: track.height - 6,
                            background: clip.kind === 'audio' ? '#1c2a22' : clip.kind === 'text' ? '#2b2233' : clip.kind === 'adjustment' ? '#26303a' : clip.kind === 'image' ? '#14303a' : clip.kind === 'solid' ? '#1f2937' : clip.kind === 'shape' ? '#312137' : clip.kind === 'null' ? '#1e2530' : '#233044',
                            border: '1px solid rgba(255,255,255,0.12)',
                            touchAction: 'none',
                          }}
                          onPointerDown={e => onClipPointerDown(e, clip, 'move')}
                          data-testid={`clip-${clip.name}`}
                        >
                          {/* clip content */}
                          <div className="absolute inset-0 flex items-center pointer-events-none px-1.5 gap-1">
                            {clip.kind === 'video' && asset?.thumbnails && asset.thumbnails.length > 0 && (
                              <div
                                className="absolute inset-0 opacity-60"
                                style={{
                                  backgroundImage: `url(${asset.thumbnails[0]})`,
                                  backgroundSize: 'auto 100%',
                                  backgroundRepeat: 'repeat-x',
                                }}
                              />
                            )}
                            {clip.kind === 'image' && asset && (
                              <div
                                className="absolute inset-0 opacity-70"
                                style={{
                                  backgroundImage: `url(${asset.url})`,
                                  backgroundSize: 'cover',
                                  backgroundPosition: 'center',
                                }}
                              />
                            )}
                            {clip.kind === 'audio' && asset?.peaks && asset.peaks.length > 0 && (
                              <div className="absolute inset-x-0 bottom-0 top-3 opacity-70">
                                <ClipWaveform peaks={asset.peaks} inPoint={(clip as AudioClip).inPoint} duration={clip.duration} assetDuration={asset.duration} color="#34d399" height={track.height - 10} />
                              </div>
                            )}
                            <span className="relative text-[10px] text-zinc-100 truncate drop-shadow z-10 max-w-full">
                              {clip.kind === 'text' ? (clip as TextClip).text.content.slice(0, 20) : clip.name}
                              {clip.speed !== 1 || clip.timeRemap ? <span className="text-amber-400 ml-1">{(clip.timeRemap ? (clip.timeRemap.sourceDuration / clip.duration) : clip.speed).toFixed(2)}x</span> : null}
                              {clip.effects.length > 0 && <span className="text-violet-300 ml-1">ƒ{clip.effects.length}</span>}
                            </span>
                          </div>
                          {/* trim handles (visible when selected) */}
                          {selected && (
                            <>
                              <div
                                className="absolute left-0 top-0 h-full w-3 bg-amber-500/80 cursor-col-resize z-20 flex items-center justify-center"
                                style={{ touchAction: 'none' }}
                                onPointerDown={e => onClipPointerDown(e, clip, 'trimL')}
                              >
                                <div className="w-0.5 h-3 bg-black/60 rounded" />
                              </div>
                              <div
                                className="absolute right-0 top-0 h-full w-3 bg-amber-500/80 cursor-col-resize z-20 flex items-center justify-center"
                                style={{ touchAction: 'none' }}
                                onPointerDown={e => onClipPointerDown(e, clip, 'trimR')}
                              >
                                <div className="w-0.5 h-3 bg-black/60 rounded" />
                              </div>
                            </>
                          )}
                        </div>
                        {/* keyframe lane */}
                        {selected && hasKeyframes(clip) && (
                          <div
                            className="absolute left-0 right-0 glass border-t border-white/8"
                            style={{ top: track.height - 2, height: KF_LANE_H }}
                          >
                            {clip.keyframes.flatMap(kt =>
                              kt.keyframes.map(kf => {
                                const color = KF_COLORS[kt.property] ?? '#f59e0b'
                                const isSel = kf.id === selectedKeyframeId
                                const dragging = ghost && drag?.mode === 'kf' && drag.kfId === kf.id && ghost.trackId === `kf:${kf.id}`
                                const kfLeft = (dragging ? ghost.start : kf.time) * pxPerSec
                                return (
                                  <button
                                    key={kf.id}
                                    className="absolute"
                                    style={{ left: kfLeft - 6, top: 4, touchAction: 'none' }}
                                    onPointerDown={e => onKfPointerDown(e, clip.id, kf.id, kf.time)}
                                    aria-label={`Keyframe ${kt.property} at ${kf.time.toFixed(2)}s`}
                                  >
                                    <span
                                      className="as-kf block"
                                      style={{ background: isSel ? '#fff' : color, borderColor: color, transform: 'rotate(45deg)' }}
                                    />
                                  </button>
                                )
                              })
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {/* ghost drag outline */}
                  {ghost && drag && drag.clipId === selClip?.id && !ghost.trackId.startsWith('kf:') && drag.mode === 'move' && ghost.trackId === track.id && (
                    <div className="absolute rounded-md border-2 border-dashed border-amber-400/70 pointer-events-none" style={{ left: ghost.start * pxPerSec, width: Math.max(8, (selClip?.duration ?? 0) * pxPerSec), top: 3, height: track.height - 6 }}>
                      <span className="absolute -top-4 left-0 as-mono text-[9px] text-amber-300 bg-black/70 px-1 rounded whitespace-nowrap">{timecode(ghost.start, doc.composition.fps)}</span>
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          {doc.clips.length === 0 && (
            <div className="flex items-center justify-center py-8 text-zinc-600 text-xs" style={{ paddingLeft: HEADER_W }}>
              Timeline is empty — import media from the Assets panel and tap “Add to timeline”
            </div>
          )}

          {/* playhead */}
          <div
            ref={playheadRef}
            className="absolute top-0 bottom-0 z-40 pointer-events-none"
            style={{ left: HEADER_W, width: 2 }}
          >
            <div className="w-[2px] h-full bg-amber-400" />
            <div className="w-3 h-3 -ml-[5px] rounded-b-sm bg-amber-400" style={{ clipPath: 'polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%)' }} />
          </div>
        </div>
      </div>
    </div>
  )
}

function hasKeyframes(clip: Clip): boolean {
  return clip.keyframes.some(k => k.keyframes.length > 0) ||
    clip.effects.some(e => Object.values(e.paramKeyframes ?? {}).some(kfs => kfs.length > 0))
}

/** Playhead timecode — self-subscribing so the Timeline body never re-renders per frame. */
function TimecodeBadge({ fps }: { fps: number }) {
  const [t, setT] = useState(0)
  useEffect(() => playbackEngine.subscribeThrottled(setT, 66), [])
  return <>{timecode(t, fps)}</>
}

const KF_COLORS: Record<string, string> = {
  x: '#f59e0b', y: '#10b981', scale: '#38bdf8', rotation: '#a78bfa',
  opacity: '#f472b6', anchorX: '#94a3b8', anchorY: '#94a3b8', volume: '#34d399',
}

function rulerTicks(duration: number, pxPerSec: number, fps: number): { t: number; major: boolean }[] {
  const step = pxPerSec > 120 ? 0.5 : pxPerSec > 48 ? 1 : pxPerSec > 20 ? 2 : pxPerSec > 10 ? 5 : 10
  const ticks: { t: number; major: boolean }[] = []
  for (let t = 0; t <= duration + step; t += step) {
    ticks.push({ t: Math.round(t * 100) / 100, major: Math.abs(t % (step * 2)) < 1e-6 || step >= 1 })
  }
  void fps
  return ticks
}

function formatTick(t: number): string {
  const s = Math.floor(t)
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
}

/** Waveform slice for an audio clip segment. */
function ClipWaveform({ peaks, inPoint, duration, assetDuration, color, height }: {
  peaks: number[]; inPoint: number; duration: number; assetDuration: number; color: string; height: number
}) {
  const slice = useMemo(() => {
    if (assetDuration <= 0 || peaks.length === 0) return []
    const start = Math.floor((inPoint / assetDuration) * peaks.length)
    const end = Math.ceil(((inPoint + duration * 1) / assetDuration) * peaks.length)
    return peaks.slice(start, Math.min(end, peaks.length))
  }, [peaks, inPoint, duration, assetDuration])
  if (slice.length === 0) return null
  return <Waveform peaks={slice} color={color} height={height} />
}
