'use client'
/**
 * ANIME STUDIO — Motion Tracker panel
 * Real NCC pyramid point tracking + corner-pin tracking:
 *  - Pick a point (or up to 4 quad corners) by tapping the preview monitor
 *  - Track across the clip with progress reporting
 *  - Apply the result: drive another layer's position (attach), or stabilize
 *    the source clip (inverse motion keyframes); corner-pin drives
 *    position + scale + rotation (similarity transform)
 */
import { useEffect, useState } from 'react'
import { useEditorStore } from '@/lib/store/editorStore'
import type { VideoClip, AudioClip, TrackPoint } from '@/lib/engine/types'
import { uid } from '@/lib/engine/types'
import { trackPoint, trackCornerPin, stabilizeFromTrack } from '@/lib/engine/tracker'
import { onTrackerPick } from './trackerBridge'
import { SectionTitle, Row, SliderRow, formatNum } from './ui-bits'
import { Crosshair, Loader2, Play, Scissors, Trash2, Sparkles } from 'lucide-react'

type Mode = 'point' | 'quad'

export function TrackerPanel() {
  const doc = useEditorStore(s => s.doc)
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const mutate = useEditorStore(s => s.mutate)
  const toast = useEditorStore(s => s.toast)
  const upsertJob = useEditorStore(s => s.upsertJob)
  const trackerPick = useEditorStore(s => s.trackerPick)
  const setTrackerPick = useEditorStore(s => s.setTrackerPick)
  const setTrackOverlay = useEditorStore(s => s.setTrackOverlay)
  const trackOverlay = useEditorStore(s => s.trackOverlay)

  const clip = (doc.clips.find(c => c.id === selectedClipId && c.kind === 'video') ?? doc.clips.find(c => c.kind === 'video')) as VideoClip | undefined
  const asset = clip ? doc.assets.find(a => a.id === clip.assetId) : undefined

  const [mode, setMode] = useState<Mode>('point')
  const [start, setStart] = useState(0)
  const [duration, setDuration] = useState(3)
  const [pickPoint, setPickPoint] = useState<{ x: number; y: number } | null>(null)
  const [pickCorners, setPickCorners] = useState<{ x: number; y: number }[]>([])
  const [tracking, setTracking] = useState(false)
  const [msg, setMsg] = useState('')
  const [progress, setProgress] = useState(0)
  const [smooth, setSmooth] = useState(0.35)
  const [targetClipId, setTargetClipId] = useState<string>('')
  const [nextCorner, setNextCorner] = useState(0)

  const comp = doc.composition
  const editable = !!clip && !!asset

  // default target: first other video clip
  useEffect(() => {
    if (!targetClipId && doc.clips.length) {
      const other = doc.clips.find(c => c.id !== clip?.id && c.kind !== 'audio')
      setTargetClipId(other?.id ?? '')
    }
  }, [doc.clips.length, clip?.id, targetClipId])

  // listen to monitor picks
  useEffect(() => {
    return onTrackerPick(p => {
      if (!trackerPick || p.clipId !== clip?.id) return
      if (trackerPick.mode === 'point') {
        setPickPoint({ x: p.x, y: p.y })
        setTrackerPick(null)
        toast({ kind: 'success', title: `Track point set at ${p.x}, ${p.y}` })
      } else {
        setPickCorners(prev => {
          const next = [...prev]
          next[trackerPick.quadIndex ?? next.length] = { x: p.x, y: p.y }
          return next.slice(0, 4)
        })
        const done = (trackerPick.quadIndex ?? 0) >= 3
        if (done) {
          setTrackerPick(null)
          toast({ kind: 'success', title: 'Quad corners set (4/4)' })
        } else {
          setNextCorner((trackerPick.quadIndex ?? 0) + 1)
        }
      }
    })
  }, [trackerPick, clip?.id, setTrackerPick, toast])

  const armPick = (m: Mode, idx = 0) => {
    if (!clip) return
    setMode(m)
    setTrackerPick({ clipId: clip.id, mode: m, quadIndex: m === 'quad' ? idx : undefined })
  }

  const clearPicks = () => {
    setPickPoint(null)
    setPickCorners([])
    setNextCorner(0)
    setTrackerPick(null)
    setTrackOverlay(null)
  }

  const runTrack = async () => {
    if (!clip || !asset) return
    const compFps = comp.fps
    setTracking(true)
    setProgress(0)
    try {
      if (mode === 'point') {
        if (!pickPoint) throw new Error('Pick a track point on the preview first')
        const pts = await trackPoint(clip, comp.width, comp.height, start, duration, Math.round(pickPoint.x), Math.round(pickPoint.y), p => {
          setProgress(p.progress)
          setMsg(p.message)
          upsertJob({ id: `track-${clip.id}`, kind: 'track', label: `Track ${clip.name}`, status: 'running', progress: p.progress, message: p.message })
        })
        upsertJob({ id: `track-${clip.id}`, kind: 'track', label: `Track ${clip.name}`, status: 'done', progress: 1 })
        setTrackOverlay({ clipId: clip.id, points: pts })
        const conf = pts.reduce((s, p) => s + p.confidence, 0) / Math.max(1, pts.length)
        toast({
          kind: 'success',
          title: `Tracked ${pts.length} samples`,
          detail: `Mean confidence ${(conf * 100).toFixed(0)}% — now apply it to a layer`,
        })
      } else {
        if (pickCorners.length < 2) throw new Error('Pick at least 2 corners (4 recommended)')
        const r = await trackCornerPin(clip, comp.width, comp.height, start, duration, pickCorners, p => {
          setProgress(p.progress)
          setMsg(p.message)
          upsertJob({ id: `track-${clip.id}`, kind: 'track', label: `Corner-pin ${clip.name}`, status: 'running', progress: p.progress, message: p.message })
        })
        upsertJob({ id: `track-${clip.id}`, kind: 'track', label: `Corner-pin ${clip.name}`, status: 'done', progress: 1 })
        setTrackOverlay({ clipId: clip.id, points: [], corners: r.tracks })
        toast({
          kind: 'success',
          title: `Quad tracked across ${r.frames.length} samples`,
          detail: 'Apply to a target layer to drive position/scale/rotation',
        })
      }
    } catch (e) {
      upsertJob({ id: `track-${clip.id}`, kind: 'track', label: 'Track', status: 'error', progress: 0, message: e instanceof Error ? e.message : String(e) })
      toast({ kind: 'error', title: 'Tracking failed', detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setTracking(false)
      void compFps
    }
  }

  /** Apply single-point track: drive target clip position or stabilize source. */
  const applyPointTrack = (stabilize: boolean) => {
    const pts = trackOverlay?.points ?? []
    if (pts.length < 2) {
      toast({ kind: 'error', title: 'Track first, then apply' })
      return
    }
    mutate(d => {
      const targetId = stabilize ? clip!.id : targetClipId
      const c = d.clips.find(c => c.id === targetId)
      if (!c) return
      if (stabilize) {
        const s = stabilizeFromTrack(pts, smooth)
        setOrPushKF(c.keyframes, 'x', s.times.map((t, i) => ({ time: t - c.start, value: s.x[i] })))
        setOrPushKF(c.keyframes, 'y', s.times.map((t, i) => ({ time: t - c.start, value: s.y[i] })))
      } else {
        const anchor = pts[0]
        setOrPushKF(c.keyframes, 'x', pts.map(p => ({ time: p.time - c.start, value: p.x - anchor.x })))
        setOrPushKF(c.keyframes, 'y', pts.map(p => ({ time: p.time - c.start, value: p.y - anchor.y })))
      }
    })
    toast({
      kind: 'success',
      title: stabilize ? 'Stabilization applied to source clip' : `Track attached to target layer`,
      detail: 'Keyframes written — scrub the timeline to see it follow',
    })
  }

  /** Apply corner-pin similarity transforms to the target clip. */
  const applyCornerPin = () => {
    const corners = trackOverlay?.corners
    if (!corners || corners.length === 0) {
      toast({ kind: 'error', title: 'Run a quad track first' })
      return
    }
    // rebuild similarity frames from tracked corner trails
    const n = corners[0].length
    if (n < 2) return
    const base = pickCorners
    mutate(d => {
      const c = d.clips.find(c => c.id === targetClipId)
      if (!c) return
      const kx: { time: number; value: number }[] = []
      const ky: { time: number; value: number }[] = []
      const ks: { time: number; value: number }[] = []
      const kr: { time: number; value: number }[] = []
      for (let i = 0; i < n; i++) {
        const t = corners[0][i].time - c.start
        const now = corners.map(tr => ({ x: tr[i].x, y: tr[i].y }))
        // least-squares similarity from the picked quad to the tracked quad
        let mf = { x: 0, y: 0 }, mt = { x: 0, y: 0 }
        const m = Math.min(base.length, now.length)
        for (let k = 0; k < m; k++) {
          mf = { x: mf.x + base[k].x / m, y: mf.y + base[k].y / m }
          mt = { x: mt.x + now[k].x / m, y: mt.y + now[k].y / m }
        }
        let a = 0, b = 0, dd = 0
        for (let k = 0; k < m; k++) {
          const fx = base[k].x - mf.x, fy = base[k].y - mf.y
          const tx = now[k].x - mt.x, ty = now[k].y - mt.y
          a += fx * tx + fy * ty
          b += fx * ty - fy * tx
          dd += fx * fx + fy * fy
        }
        if (dd < 1e-6) continue
        const scale = Math.max(0.01, Math.min(20, a / dd))
        const rot = Math.atan2(b, a) * (180 / Math.PI)
        kx.push({ time: t, value: mt.x - mf.x })
        ky.push({ time: t, value: mt.y - mf.y })
        ks.push({ time: t, value: scale })
        kr.push({ time: t, value: rot })
      }
      setOrPushKF(c.keyframes, 'x', kx)
      setOrPushKF(c.keyframes, 'y', ky)
      setOrPushKF(c.keyframes, 'scale', ks)
      setOrPushKF(c.keyframes, 'rotation', kr)
    })
    toast({ kind: 'success', title: 'Corner-pin applied', detail: 'Position + scale + rotation keyframes on the target layer' })
  }

  const otherClips = doc.clips.filter(c => c.id !== clip?.id && c.kind !== 'audio')

  if (!editable) {
    return (
      <div className="p-4 text-xs text-zinc-500">
        Add a video clip to the timeline and select it to start tracking.
      </div>
    )
  }

  return (
    <div className="p-3 pb-10 space-y-1">
      <SectionTitle right={trackOverlay ? (
        <button className="text-[10px] text-red-400 flex items-center gap-1" onClick={() => setTrackOverlay(null)}>
          <Trash2 size={10} /> clear trail
        </button>
      ) : undefined}>
        <Crosshair size={11} className="inline mr-1 text-cyan-400" /> Motion Tracker
      </SectionTitle>

      <div className="rounded-xl glass-soft p-2.5 text-[11px] text-zinc-400">
        Source: <span className="text-zinc-200">{clip!.name}</span> · {asset!.width}×{asset!.height} · tracking at 15 samples/s with NCC pyramid + sub-pixel refinement.
      </div>

      <Row label="Pick mode">
        <button className={`flex-1 py-2 rounded-lg text-xs ${mode === 'point' ? 'glass-accent text-amber-300' : 'gbtn'}`} onClick={() => armPick('point')}>
          Single point
        </button>
        <button className={`flex-1 py-2 rounded-lg text-xs ${mode === 'quad' ? 'glass-accent text-amber-300' : 'gbtn'}`} onClick={() => armPick('quad', nextCorner)}>
          Corner pin (4-pt)
        </button>
      </Row>

      {mode === 'point' && (
        <div className="rounded-xl glass-soft p-2.5 flex items-center gap-2 text-xs">
          {pickPoint ? (
            <span className="text-cyan-300 as-mono">point @ {pickPoint.x}, {pickPoint.y}</span>
          ) : (
            <span className="text-zinc-500">Tap the preview to place the track point</span>
          )}
        </div>
      )}
      {mode === 'quad' && (
        <div className="rounded-xl glass-soft p-2.5 text-xs">
          {trackerPick?.mode === 'quad'
            ? <span className="text-amber-300">Tap corner {(trackerPick.quadIndex ?? 0) + 1} of 4 on the preview…</span>
            : pickCorners.length === 4 ? <span className="text-cyan-300 as-mono">4 corners set</span>
              : <span className="text-zinc-500">{pickCorners.length}/4 corners picked — tap the preview</span>}
        </div>
      )}

      <SectionTitle>Track range</SectionTitle>
      <SliderRow label="Start" value={start} min={0} max={Math.max(0.5, (asset?.duration ?? 5) - 0.5)} step={0.1} onChange={setStart} unit="s" />
      <SliderRow label="Duration" value={duration} min={0.5} max={Math.max(1, (asset?.duration ?? 5) - start)} step={0.1} onChange={setDuration} unit="s" />

      <button
        className={`w-full mt-2 py-2.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 ${tracking ? 'gbtn' : 'gbtn gbtn-violet'}`}
        onClick={() => void runTrack()}
        disabled={tracking}
      >
        {tracking ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        {tracking ? `Tracking… ${Math.round(progress * 100)}%` : mode === 'point' ? 'Track point' : 'Track quad'}
      </button>
      {tracking && (
        <div className="h-1.5 rounded bg-white/10 overflow-hidden mt-2">
          <div className="h-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {msg && <div className="text-[10px] text-zinc-500 mt-1">{msg}</div>}

      {trackOverlay && trackOverlay.clipId === clip!.id && (
        <>
          <SectionTitle>Apply result</SectionTitle>
          {trackOverlay.points.length > 1 ? (
            <>
              <Row label="Stabilize">
                <div className="flex-1 flex items-center gap-2">
                  <input className="as-range flex-1" type="range" min={0.05} max={0.95} step={0.05} value={smooth} onChange={e => setSmooth(parseFloat(e.target.value))} />
                  <span className="as-mono text-[11px] text-zinc-400 w-10">{formatNum(smooth)}</span>
                </div>
              </Row>
              <div className="grid grid-cols-2 gap-2 mt-1">
                <button className="py-2 rounded-xl gbtn text-xs" onClick={() => applyPointTrack(true)}>
                  <Scissors size={12} /> Stabilize source
                </button>
                <button className="py-2 rounded-xl gbtn gbtn-accent text-xs" onClick={() => applyPointTrack(false)}>
                  <Sparkles size={12} /> Attach to layer
                </button>
              </div>
              <Row label="Target">
                <select className="ginput flex-1" value={targetClipId} onChange={e => setTargetClipId(e.target.value)}>
                  {otherClips.map(c => <option key={c.id} value={c.id}>{c.name} ({c.kind})</option>)}
                </select>
              </Row>
            </>
          ) : (
            <>
              <Row label="Target">
                <select className="ginput flex-1" value={targetClipId} onChange={e => setTargetClipId(e.target.value)}>
                  {otherClips.map(c => <option key={c.id} value={c.id}>{c.name} ({c.kind})</option>)}
                </select>
              </Row>
              <button className="w-full py-2.5 rounded-xl gbtn gbtn-accent text-xs mt-1" onClick={applyCornerPin}>
                <Sparkles size={12} /> Apply corner-pin to target
              </button>
            </>
          )}
        </>
      )}

      <SectionTitle>Notes</SectionTitle>
      <button className="w-full py-2 rounded-xl gbtn text-[11px] text-red-300 flex items-center justify-center gap-1" onClick={clearPicks}>
        <Trash2 size={11} /> Reset picks
      </button>

      <p className="text-[10px] text-zinc-600 mt-2">
        Genuine template tracking: zero-mean NCC, coarse-to-fine pyramid, parabolic sub-pixel fit, confidence-gated template refresh. Corner-pin solves a similarity transform (translate/scale/rotate) from the quad — honest AE-style approximation without perspective shear.
      </p>
    </div>
  )
}

function setOrPushKF(
  tracks: { property: string; keyframes: { id: string; time: number; value: number; easing: string }[] }[],
  property: string,
  kfs: { time: number; value: number }[]
) {
  let track = tracks.find(t => t.property === property)
  if (!track) {
    track = { property, keyframes: [] }
    tracks.push(track)
  }
  track.keyframes = kfs
    .filter(k => Number.isFinite(k.time) && Number.isFinite(k.value))
    .map(k => ({ id: uid('kf'), time: Math.max(0, k.time), value: k.value, easing: 'linear' }))
    .sort((a, b) => a.time - b.time)
}
