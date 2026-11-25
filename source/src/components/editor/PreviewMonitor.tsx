'use client'
/**
 * ANIME STUDIO — Preview Monitor + Transport (Glass)
 * Real-time compositor output with quality, zoom, compare, fullscreen,
 * tracker tap-picking, tracked-path overlay and pen-mask point editing.
 */
import { useEffect, useRef, useState } from 'react'
import { playbackEngine } from '@/lib/engine/playback'
import { useEditorStore } from '@/lib/store/editorStore'
import { evalMaskPoints, uid } from '@/lib/engine/types'
import type { MaskPoint, Clip } from '@/lib/engine/types'
import { EFFECT_MAP } from '@/lib/engine/effects'
import { layerCenterNDC, layerCornersNDC } from '@/lib/engine/layerMath'
import { useUIStore } from '@/lib/store/uiStore'
import { evalProperty } from '@/lib/engine/keyframes'
import { newLayer, liveBegin, liveApply, liveEnd, writePropIn, tcAE, saveFrameAs } from './ae/aeActions'
import { timecode } from './ui-bits'
import { emitTrackerPick } from './trackerBridge'
import {
  Play, Pause, SkipBack, SkipForward, ChevronFirst, ChevronLast,
  Repeat, Volume2, VolumeX, Maximize2, Columns2, Camera, Grid3x3, Square, Zap,
} from 'lucide-react'
import type { VideoClip } from '@/lib/engine/types'

const ZOOMS = [0.125, 0.25, 0.333, 0.5, 0.667, 1, 2, 4, 8]

export function PreviewMonitor({ ae = false }: { ae?: boolean } = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState<'fit' | number>('fit')
  const [fps, setFps] = useState(0)
  const doc = useEditorStore(s => s.doc)
  const compare = useEditorStore(s => s.preview !== null)
  const trackerPick = useEditorStore(s => s.trackerPick)
  const trackOverlay = useEditorStore(s => s.trackOverlay)
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const maskEditing = useEditorStore(s => s.maskEditing)
  const mutate = useEditorStore(s => s.mutate)

  // ---- pen mask point editing ----
  const selectedClip: Clip | null = doc?.clips.find(c => c.id === selectedClipId) ?? null
  const maskEditActive = !!maskEditing && maskEditing === selectedClipId && selectedClip?.mask?.shape === 'pen'
  const penMask = maskEditActive && selectedClip ? selectedClip.mask! : null
  const [dragPoints, setDragPoints] = useState<MaskPoint[] | null>(null)
  const dragRef = useRef<{ idx: number; lastTap: number } | null>(null)
  const [drawTick, setDrawTick] = useState(0)

  // ---- null layer overlay + drag (AE-style null markers in the viewer) ----
  // Nulls are controller layers the compositor never renders; without markers
  // they are invisible and feel broken. Markers respect parenting and drag
  // writes position (keyframe at playhead when the property is animated).
  const dragNullRef = useRef<{ clipId: string } | null>(null)
  const [dragNull, setDragNull] = useState<string | null>(null)
  const [nullTick, setNullTick] = useState(0)
  const nullsLive = !!doc?.clips.some(c =>
    c.kind === 'null' &&
    c.keyframes.some(k => (k.property === 'x' || k.property === 'y') && k.keyframes.length > 0))
  useEffect(() => {
    if (!nullsLive && !dragNull) return
    return playbackEngine.subscribeThrottled(() => setNullTick(t => (t + 1) % 1000000), 33)
  }, [nullsLive, dragNull])

  const visibleNulls = (d: typeof doc) => {
    if (!d) return []
    const t = playbackEngine.currentTime
    return d.clips.filter(c => {
      if (c.kind !== 'null') return false
      const track = d.tracks.find(tr => tr.id === c.trackId)
      if (track && !track.visible) return false
      return t >= c.start - 1e-6 && t < c.start + c.duration - 1e-6
    })
  }

  const nullCenterCss = (clip: Clip, w: number, h: number): [number, number] | null => {
    const d = useEditorStore.getState().doc
    const comp = d.composition
    const c = layerCenterNDC(d, clip, playbackEngine.currentTime, comp)
    if (!c) return null
    return [(c.x * 0.5 + 0.5) * w, (0.5 - c.y * 0.5) * h]
  }

  const drawNullMarkers = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const d = useEditorStore.getState().doc
    const sel = useEditorStore.getState().selectedClipId
    for (const n of visibleNulls(d)) {
      const pt = nullCenterCss(n, w, h)
      if (!pt) continue
      const [px, py] = pt
      const isSel = n.id === sel || n.id === dragNull
      const color = isSel ? '#f59e0b' : '#22d3ee'
      const s = 11
      ctx.save()
      ctx.strokeStyle = color
      ctx.fillStyle = isSel ? 'rgba(245, 158, 11, 0.18)' : 'rgba(34, 211, 238, 0.10)'
      ctx.lineWidth = isSel ? 2 : 1.5
      ctx.beginPath()
      ctx.rect(px - s, py - s, s * 2, s * 2)
      ctx.fill()
      ctx.stroke()
      // crosshair
      ctx.beginPath()
      ctx.moveTo(px - s * 0.6, py); ctx.lineTo(px + s * 0.6, py)
      ctx.moveTo(px, py - s * 0.6); ctx.lineTo(px, py + s * 0.6)
      ctx.stroke()
      // label
      ctx.fillStyle = color
      ctx.font = '600 10px system-ui'
      ctx.fillText(`${n.name}${n.parentId ? ' ↗' : ''}`, px + s + 3, py - s + 2)
      ctx.restore()
    }
  }

  /** Position write with AE semantics: animated property → keyframe at playhead. */
  const setNullPosition = (clipId: string, x: number, y: number) => {
    const s = useEditorStore.getState()
    const clip = s.doc.clips.find(c => c.id === clipId)
    if (!clip) return
    const fps = Math.max(1, s.doc.composition.fps)
    const lt = Math.max(0, Math.min(clip.duration, playbackEngine.currentTime - clip.start))
    s.mutate(d => {
      const c = d.clips.find(c => c.id === clipId)
      if (!c) return
      const animated = (prop: string) => !!c.keyframes.find(k => k.property === prop)?.keyframes.length
      const write = (prop: string, value: number) => {
        let track = c.keyframes.find(k => k.property === prop)
        if (!track) { track = { property: prop, keyframes: [] }; c.keyframes.push(track) }
        const existing = track.keyframes.find(kf => Math.abs(kf.time - lt) < 1 / (fps * 2))
        if (existing) existing.value = value
        else {
          track.keyframes.push({ id: uid('kf'), time: lt, value, easing: 'easeInOut' })
          track.keyframes.sort((a, b) => a.time - b.time)
        }
      }
      if (animated('x')) write('x', x); else c.x = x
      if (animated('y')) write('y', y); else c.y = y
    })
  }

  const onNullDragDown = (e: React.PointerEvent<HTMLCanvasElement>): boolean => {
    const d = useEditorStore.getState().doc
    if (!d) return false
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const w = rect.width || 1, h = rect.height || 1
    let hit: Clip | null = null
    let bestD = 26
    for (const n of visibleNulls(d)) {
      const pt = nullCenterCss(n, w, h)
      if (!pt) continue
      const dist = Math.hypot(pt[0] - cx, pt[1] - cy)
      if (dist < bestD) { bestD = dist; hit = n }
    }
    if (!hit) return false
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragNullRef.current = { clipId: hit.id }
    setDragNull(hit.id)
    useEditorStore.getState().select(hit.id)
    return true
  }

  const onNullDragMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragNullRef.current) return
    const p = compFromEvent(e)
    setNullPosition(dragNullRef.current.clipId, p.x, p.y)
  }

  const onNullDragUp = () => {
    if (dragNullRef.current) {
      dragNullRef.current = null
      setDragNull(null)
    }
  }

  // live redraw while editing (shape keyframes depend on playhead time)
  useEffect(() => {
    if (!maskEditActive) return
    return playbackEngine.subscribeThrottled(() => setDrawTick(t => (t + 1) % 1000000), 33)
  }, [maskEditActive])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      playbackEngine.attach(canvas)
    } catch (e) {
      console.error('WebGL attach failed', e)
    }
    // PERF: was subscribe() → a React render of the whole monitor every frame
    const unsub = playbackEngine.subscribeThrottled(() => setFps(f => (f === playbackEngine.fpsMeasured ? f : playbackEngine.fpsMeasured)), 500)
    return () => { unsub() }
  }, [])

  useEffect(() => {
    playbackEngine.compositor.renderScale = 1
  }, [doc])

  const [quality, setQualityState] = useState(playbackEngine.previewQuality)
  const setQuality = (q: 'quarter' | 'half' | 'full') => {
    playbackEngine.setQuality(q)
    setQualityState(q)
  }

  // canvas CSS size: fit into wrapper preserving aspect
  const [canvasStyle, setCanvasStyle] = useState<React.CSSProperties>({})
  const [fitPct, setFitPct] = useState(1)
  const [cssSize, setCssSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const compute = () => {
      const wrap = wrapRef.current
      const canvas = canvasRef.current
      if (!wrap || !canvas || !doc) return
      const ar = doc.composition.width / doc.composition.height
      const ww = wrap.clientWidth - 16
      const wh = wrap.clientHeight - 16
      let w = ww, h = ww / ar
      if (h > wh) { h = wh; w = wh * ar }
      const scale = zoom === 'fit' ? 1 : ae ? (zoom * doc.composition.width) / Math.max(1, w) : zoom
      setFitPct(w / Math.max(1, doc.composition.width))
      setCanvasStyle({ width: w * scale, height: h * scale })
      setCssSize({ w: w * scale, h: h * scale })
    }
    compute()
    const ro = new ResizeObserver(compute)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [doc?.composition.width, doc?.composition.height, zoom, ae])

  // ---- fps drop warning (once per session) ----
  const lowFpsWarned = useRef(false)
  useEffect(() => {
    if (!doc) return
    if (fps > 0 && fps < Math.min(24, doc.composition.fps * 0.6) && quality !== 'quarter' && !lowFpsWarned.current) {
      lowFpsWarned.current = true
      useEditorStore.getState().toast({
        kind: 'info',
        title: 'Preview running slow',
        detail: 'Set Resolution to Half or Quarter (viewer bar), create a proxy, or disable heavy GPU effects.',
      })
    }
  }, [fps, quality, doc])

  // heavy GPU effects active near the playhead (effects guarded — old saved
  // projects or malformed docs must not crash the monitor)
  const heavyActive = doc
    ? doc.clips.filter(c =>
      (c.effects ?? []).some(e => e.enabled && EFFECT_MAP[e.type]?.heavy) &&
      playbackEngine.currentTime >= c.start - 0.1 && playbackEngine.currentTime < c.start + c.duration
    ).length
    : 0

  const compFromEvent = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect()
    const nx = (e.clientX - rect.left) / (rect.width || 1)
    const ny = (e.clientY - rect.top) / (rect.height || 1)
    return {
      x: Math.round((nx - 0.5) * (doc?.composition.width ?? 0)),
      y: Math.round((0.5 - ny) * (doc?.composition.height ?? 0)),
    }
  }

  const maskLocalTime = () =>
    selectedClip ? Math.max(0, Math.min(selectedClip.duration, playbackEngine.currentTime - selectedClip.start)) : 0

  const onMaskPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!penMask || !doc || !selectedClip) return
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const comp = doc.composition
    const w = rect.width || 1
    const h = rect.height || 1
    const toCssPt = (q: { x: number; y: number }): [number, number] => [
      (q.x / comp.width + 0.5) * w,
      (0.5 - q.y / comp.height) * h,
    ]
    const pts = dragPoints ?? evalMaskPoints(penMask, maskLocalTime())
    if (!pts || pts.length < 3) return
    // nearest vertex?
    let bestI = -1
    let bestD = 30
    pts.forEach((q, i) => {
      const [px, py] = toCssPt(q)
      const d = Math.hypot(px - cx, py - cy)
      if (d < bestD) { bestD = d; bestI = i }
    })
    const now = performance.now()
    if (bestI >= 0) {
      const last = dragRef.current
      // double-tap on a vertex → delete it
      if (last && last.idx === bestI && last.lastTap > 0 && now - last.lastTap < 340 && pts.length > 3) {
        mutate(d => {
          const c = d.clips.find(c => c.id === selectedClip.id)
          if (c?.mask?.points) c.mask.points.splice(bestI, 1)
          if (c?.mask) c.mask.shapeKeyframes = []
        })
        setDragPoints(null)
        dragRef.current = null
        return
      }
      dragRef.current = { idx: bestI, lastTap: now }
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ok */ }
      return
    }
    // nearest edge midpoint → insert a point there
    let bestEdge = -1
    let bestED = 26
    for (let i = 0; i < pts.length; i++) {
      const a = toCssPt(pts[i])
      const b = toCssPt(pts[(i + 1) % pts.length])
      const d = Math.hypot((a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cy)
      if (d < bestED) { bestED = d; bestEdge = i }
    }
    if (bestEdge >= 0 && pts.length < 24) {
      const idx = bestEdge + 1
      const p = compFromEvent(e)
      mutate(d => {
        const c = d.clips.find(c => c.id === selectedClip.id)
        if (!c?.mask) return
        const arr = c.mask.points ?? (c.mask.points = [])
        arr.splice(idx, 0, { x: p.x, y: p.y })
        c.mask.shapeKeyframes = []
      })
      dragRef.current = { idx, lastTap: 0 }
    }
  }

  const onMaskPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!penMask || !selectedClip || !dragRef.current) return
    const idx = dragRef.current.idx
    const pts = (dragPoints ?? evalMaskPoints(penMask, maskLocalTime())).map(q => ({ ...q }))
    if (!pts || idx >= pts.length) return
    pts[idx] = compFromEvent(e)
    setDragPoints(pts)
  }

  const onMaskPointerUp = () => {
    if (!penMask || !selectedClip || !dragRef.current) { dragRef.current = null; return }
    if (dragPoints) {
      const idx = dragRef.current.idx
      const finalPts = dragPoints
      mutate(d => {
        const c = d.clips.find(c => c.id === selectedClip.id)
        if (!c?.mask) return
        const arr = c.mask.points ?? (c.mask.points = [])
        if (idx < arr.length) arr[idx] = { x: finalPts[idx].x, y: finalPts[idx].y }
        c.mask.shapeKeyframes = []
      })
    }
    setDragPoints(null)
    dragRef.current = null
  }

  // ---- tracked path overlay ----
  useEffect(() => {
    const cv = overlayRef.current
    if (!cv || !doc) return
    const comp = doc.composition
    const w = Math.max(2, Math.round(cssSize.w))
    const h = Math.max(2, Math.round(cssSize.h))
    if (cv.width !== w || cv.height !== h) {
      cv.width = w
      cv.height = h
    }
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    const toCss = (x: number, y: number): [number, number] => [
      (x / comp.width + 0.5) * w,
      (0.5 - y / comp.height) * h,
    ]
    const overlay = trackOverlay
    if (overlay && overlay.clipId === selectedClipId) {
      // corner trails
      if (overlay.corners) {
        const colors = ['#22d3ee', '#f472b6', '#a3e635', '#fb923c']
        overlay.corners.forEach((pts, ci) => {
          if (pts.length < 1) return
          ctx.strokeStyle = colors[ci % 4]
          ctx.lineWidth = 1.5
          ctx.beginPath()
          pts.forEach((p, i) => {
            const [px, py] = toCss(p.x, p.y)
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
          })
          ctx.stroke()
          const last = pts[pts.length - 1]
          const [lx, ly] = toCss(last.x, last.y)
          ctx.fillStyle = colors[ci % 4]
          ctx.beginPath()
          ctx.arc(lx, ly, 4, 0, Math.PI * 2)
          ctx.fill()
        })
      }
      // single-point trail
      const pts = overlay.points
      if (pts.length > 1) {
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.9)'
        ctx.lineWidth = 2
        ctx.shadowColor = 'rgba(34, 211, 238, 0.8)'
        ctx.shadowBlur = 6
        ctx.beginPath()
        pts.forEach((p, i) => {
          const [px, py] = toCss(p.x, p.y)
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
        })
        ctx.stroke()
        ctx.shadowBlur = 0
        const last = pts[pts.length - 1]
        const [lx, ly] = toCss(last.x, last.y)
        ctx.fillStyle = '#22d3ee'
        ctx.beginPath()
        ctx.arc(lx, ly, 5, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    // pick crosshair
    if (trackerPick) {
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.9)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([6, 4])
      ctx.strokeRect(4, 4, w - 8, h - 8)
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(245, 158, 11, 0.95)'
      ctx.font = '600 11px system-ui'
      const label = trackerPick.mode === 'quad'
        ? `Pick corner ${trackerPick.quadIndex ?? 0 + 1}/4`
        : 'Tap the point to track'
      ctx.fillText(label, 12, 20)
    }
    // pen-mask point editing overlay (drawn last, same canvas, after clearRect)
    if (maskEditActive && penMask && selectedClip) {
      const compW = comp.width, compH = comp.height
      const toCssPt = (q: { x: number; y: number }): [number, number] => [
        (q.x / compW + 0.5) * w,
        (0.5 - q.y / compH) * h,
      ]
      const lt = Math.max(0, Math.min(selectedClip.duration, playbackEngine.currentTime - selectedClip.start))
      const pts = dragPoints ?? evalMaskPoints(penMask, lt)
      if (pts && pts.length >= 2) {
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.95)'
        ctx.lineWidth = 2
        ctx.beginPath()
        pts.forEach((p, i) => {
          const [x, y] = toCssPt(p)
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
        })
        ctx.closePath()
        ctx.stroke()
        ctx.fillStyle = 'rgba(56, 189, 248, 0.9)'
        for (let i = 0; i < pts.length; i++) {
          const a = toCssPt(pts[i])
          const b = toCssPt(pts[(i + 1) % pts.length])
          ctx.fillRect((a[0] + b[0]) / 2 - 3.5, (a[1] + b[1]) / 2 - 3.5, 7, 7)
        }
        pts.forEach(p => {
          const [x, y] = toCssPt(p)
          ctx.fillStyle = 'rgba(245, 158, 11, 0.95)'
          ctx.beginPath()
          ctx.arc(x, y, 6, 0, Math.PI * 2)
          ctx.fill()
        })
        ctx.fillStyle = 'rgba(245, 158, 11, 0.95)'
        ctx.font = '600 11px system-ui'
        ctx.fillText('Pen mask: drag points · tap edge square to add · double-tap to delete', 10, h - 10)
      }
      void drawTick
    }
    // null layer markers (AE-style controller overlays) — always on top
    drawNullMarkers(ctx, w, h)
    void nullTick
  }, [cssSize, trackOverlay, trackerPick, doc, selectedClipId, maskEditActive, penMask, selectedClip, dragPoints, drawTick, nullTick, dragNull])

  // ---- tracker pick taps ----
  const onCanvasPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!trackerPick || !doc) return
    const rect = e.currentTarget.getBoundingClientRect()
    const cssW = rect.width || 1
    const cssH = rect.height || 1
    const nx = (e.clientX - rect.left) / cssW
    const ny = (e.clientY - rect.top) / cssH
    const comp = doc.composition
    const x = Math.round((nx - 0.5) * comp.width)
    const y = Math.round((0.5 - ny) * comp.height)
    emitTrackerPick({ x, y, clipId: trackerPick.clipId })
  }

  // ================= AE tools on the viewer =================
  const tool = useUIStore(s => s.tool)
  const guides = useUIStore(s => s.guides)
  const setGuides = useUIStore(s => s.setGuides)
  const setCursor = useUIStore(s => s.setCursor)
  const setFocus = useUIStore(s => s.setFocus)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [penPts, setPenPts] = useState<{ x: number; y: number }[]>([])
  const [rubber, setRubber] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const aeOverlayRef = useRef<HTMLCanvasElement>(null)
  const cacheRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    playbackEngine.attachCacheOverlay(cacheRef.current)
    return () => playbackEngine.attachCacheOverlay(null)
  }, [])
  type AEDrag =
    | { kind: 'move'; clipId: string; sx: number; sy: number; x0: number; y0: number; moved: boolean; others: { id: string; x0: number; y0: number }[] }
    | { kind: 'rotate'; clipId: string; cx: number; cy: number; a0: number; r0: number; moved: boolean }
    | { kind: 'anchor'; clipId: string; sx: number; sy: number; ax0: number; ay0: number; x0: number; y0: number; moved: boolean }
    | { kind: 'pan'; sx: number; sy: number; px: number; py: number }
    | { kind: 'shape'; sx: number; sy: number }
  const aeDrag = useRef<AEDrag | null>(null)
  const pinch = useRef<{ pts: Map<number, { x: number; y: number }>; d0: number; z0: number } | null>(null)
  useEffect(() => { if (zoom === 'fit') setPan({ x: 0, y: 0 }) }, [zoom])
  useEffect(() => { if (tool !== 'pen') setPenPts([]) }, [tool])

  // keep the resolution select in sync with the Preview panel / View menu
  useEffect(() => {
    const h = () => setQualityState(playbackEngine.previewQuality)
    window.addEventListener('as-quality', h)
    return () => window.removeEventListener('as-quality', h)
  }, [])
  // View menu zoom commands
  useEffect(() => {
    const h = (e: Event) => {
      const dir = (e as CustomEvent<number | 'fit'>).detail
      if (dir === 'fit') { setZoom('fit'); return }
      setZoom(z => {
        const cur = z === 'fit' ? fitPct : z
        if (dir > 0) return ZOOMS.find(v => v > cur + 1e-3) ?? 8
        return [...ZOOMS].reverse().find(v => v < cur - 1e-3) ?? 0.125
      })
    }
    window.addEventListener('as-viewer-zoom', h)
    return () => window.removeEventListener('as-viewer-zoom', h)
  }, [fitPct])

  const sizeOf = (c: Clip): [number, number] | null => {
    const d = useEditorStore.getState().doc
    if (c.kind === 'video' || c.kind === 'image') {
      const a = d.assets.find(a => a.id === (c as VideoClip).assetId)
      return a && a.width > 0 ? [a.width, a.height] : [d.composition.width, d.composition.height]
    }
    if (c.kind === 'solid' || c.kind === 'adjustment' || c.kind === 'shape' || c.kind === 'text') return [d.composition.width, d.composition.height]
    if (c.kind === 'precomp') { const pc = d.precomps?.find(p => p.id === c.precompId); return pc ? [pc.composition.width, pc.composition.height] : null }
    return null
  }
  const visualLayersTopFirst = () => {
    const d = useEditorStore.getState().doc
    const t = playbackEngine.currentTime
    const out: Clip[] = []
    for (const tr of d.tracks) {
      if (tr.kind === 'audio' || !tr.visible) continue
      for (const c of d.clips) if (c.trackId === tr.id && !c.hidden && c.kind !== 'camera' && c.kind !== 'audio' && t >= c.start && t < c.start + c.duration) out.push(c)
    }
    return out
  }
  const ndcToCss = (p: [number, number], w: number, h: number): [number, number] => [(p[0] * 0.5 + 0.5) * w, (0.5 - p[1] * 0.5) * h]
  const pointInPoly = (x: number, y: number, poly: [number, number][]) => {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j]
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside
    }
    return inside
  }
  const hitLayer = (cx: number, cy: number, w: number, h: number): Clip | null => {
    const d = useEditorStore.getState().doc
    const t = playbackEngine.currentTime
    for (const c of visualLayersTopFirst()) {
      if (c.kind === 'text' || c.kind === 'shape' || c.kind === 'null' || c.kind === 'adjustment') {
        const ctr = layerCenterNDC(d, c, t, d.composition)
        if (!ctr) continue
        const [px, py] = ndcToCss([ctr.x, ctr.y], w, h)
        const r = c.kind === 'shape' ? Math.max(30, (c.shape.width * evalProperty(c, 'scale', t - c.start) / d.composition.width) * w / 2) : 60
        if (Math.hypot(px - cx, py - cy) < r) return c
        continue
      }
      const sz = sizeOf(c)
      if (!sz) continue
      const poly = layerCornersNDC(d, c, t, d.composition, sz[0], sz[1]).map(p => ndcToCss(p, w, h))
      if (pointInPoly(cx, cy, poly)) return c
    }
    return null
  }

  const drawAEOverlay = () => {
    const cv = aeOverlayRef.current
    if (!cv || !ae) return
    const d = useEditorStore.getState().doc
    const w = Math.max(2, Math.round(cssSize.w)), h = Math.max(2, Math.round(cssSize.h))
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr }
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const g = useUIStore.getState().guides
    if (g.grid) {
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let i = 1; i < 3; i++) { ctx.moveTo((w * i) / 3, 0); ctx.lineTo((w * i) / 3, h); ctx.moveTo(0, (h * i) / 3); ctx.lineTo(w, (h * i) / 3) }
      ctx.stroke()
    }
    if (g.safe) {
      ctx.strokeStyle = 'rgba(160,200,255,0.55)'
      ctx.setLineDash([4, 3])
      ctx.strokeRect(w * 0.05, h * 0.05, w * 0.9, h * 0.9)
      ctx.strokeRect(w * 0.1, h * 0.1, w * 0.8, h * 0.8)
      ctx.setLineDash([])
      ctx.beginPath(); ctx.moveTo(w / 2 - 8, h / 2); ctx.lineTo(w / 2 + 8, h / 2); ctx.moveTo(w / 2, h / 2 - 8); ctx.lineTo(w / 2, h / 2 + 8); ctx.stroke()
    }
    const t = playbackEngine.currentTime
    const selIds = useEditorStore.getState().selectedClipIds
    for (const sel of d.clips.filter(c => selIds.includes(c.id) || c.id === useEditorStore.getState().selectedClipId))
    if (sel && sel.kind !== 'audio' && sel.kind !== 'camera' && sel.kind !== 'null' && t >= sel.start && t < sel.start + sel.duration) {
      const sz = sizeOf(sel)
      ctx.strokeStyle = '#4f9ff0'
      ctx.lineWidth = 1
      if (sz && sel.kind !== 'text' && sel.kind !== 'shape' && sel.kind !== 'adjustment') {
        const poly = layerCornersNDC(d, sel, t, d.composition, sz[0], sz[1]).map(p => ndcToCss(p, w, h))
        ctx.beginPath()
        poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
        ctx.closePath(); ctx.stroke()
        // 8 handles
        const pts: [number, number][] = []
        for (let i = 0; i < 4; i++) { const a = poly[i], b = poly[(i + 1) % 4]; pts.push(a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]) }
        ctx.fillStyle = '#4f9ff0'
        for (const [x, y] of pts) ctx.fillRect(x - 3, y - 3, 6, 6)
      }
      const ctr = layerCenterNDC(d, sel, t, d.composition)
      if (ctr) {
        const [ax, ay] = ndcToCss([ctr.x, ctr.y], w, h)
        ctx.beginPath(); ctx.arc(ax, ay, 6, 0, Math.PI * 2); ctx.moveTo(ax - 10, ay); ctx.lineTo(ax + 10, ay); ctx.moveTo(ax, ay - 10); ctx.lineTo(ax, ay + 10); ctx.stroke()
      }
    }
    if (penPts.length) {
      ctx.strokeStyle = '#f2c94c'; ctx.fillStyle = '#f2c94c'; ctx.lineWidth = 1.5
      ctx.beginPath()
      penPts.forEach((p, i) => { const x = (p.x / d.composition.width + 0.5) * w, y = (0.5 - p.y / d.composition.height) * h; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y) })
      ctx.stroke()
      for (const p of penPts) { const x = (p.x / d.composition.width + 0.5) * w, y = (0.5 - p.y / d.composition.height) * h; ctx.fillRect(x - 3, y - 3, 6, 6) }
      ctx.font = '11px system-ui'
      ctx.fillText('Pen: click to add points · click the first point or press Enter to close · Esc cancels', 8, h - 8)
    }
    if (rubber) {
      ctx.strokeStyle = '#4f9ff0'; ctx.setLineDash([3, 3])
      ctx.strokeRect(Math.min(rubber.x0, rubber.x1), Math.min(rubber.y0, rubber.y1), Math.abs(rubber.x1 - rubber.x0), Math.abs(rubber.y1 - rubber.y0))
      ctx.setLineDash([])
    }
  }
  const drawRef = useRef(drawAEOverlay)
  drawRef.current = drawAEOverlay
  useEffect(() => { drawRef.current() })
  useEffect(() => {
    if (!ae) return
    return playbackEngine.subscribeThrottled(() => drawRef.current(), 40)
  }, [ae])

  // pen: Enter closes, Esc cancels
  useEffect(() => {
    if (!ae || tool !== 'pen') return
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPenPts([])
      if (e.key === 'Enter') commitPen()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  const commitPen = () => {
    const sel = useEditorStore.getState().selectedClipId
    if (!sel || penPts.length < 3) { setPenPts([]); return }
    const pts = penPts
    mutate(d => {
      const c = d.clips.find(c => c.id === sel)
      if (c) c.mask = { shape: 'pen', x: 0, y: 0, width: 1, height: 1, feather: 0.02, invert: false, points: pts.map(p => ({ x: p.x, y: p.y })) }
    })
    useEditorStore.getState().setMaskEditing(sel)
    setPenPts([])
  }

  const cssPt = (e: React.PointerEvent) => {
    const r = (canvasRef.current as HTMLCanvasElement).getBoundingClientRect()
    return { cx: e.clientX - r.left, cy: e.clientY - r.top, w: r.width || 1, h: r.height || 1 }
  }

  const onAEDown = (e: React.PointerEvent<HTMLCanvasElement>): boolean => {
    if (!ae || !doc) return false
    setFocus('viewer')
    const { cx, cy, w, h } = cssPt(e)
    const comp = doc.composition
    const cp = { x: (cx / w - 0.5) * comp.width, y: (0.5 - cy / h) * comp.height }
    if (e.pointerType === 'touch') {
      const pm = pinch.current ?? { pts: new Map(), d0: 0, z0: 1 }
      pm.pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      pinch.current = pm
      if (pm.pts.size === 2) {
        const [a, b] = [...pm.pts.values()]
        pm.d0 = Math.hypot(a.x - b.x, a.y - b.y)
        pm.z0 = zoom === 'fit' ? fitPct : zoom
        if (aeDrag.current && 'clipId' in aeDrag.current && aeDrag.current.moved) liveEnd()
        aeDrag.current = null
        return true
      }
    }
    const t = tool
    const middle = e.button === 1
    if (t === 'hand' || middle || (e.button === 0 && e.altKey && t === 'select' && zoom !== 'fit')) {
      e.currentTarget.setPointerCapture?.(e.pointerId)
      aeDrag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y }
      return true
    }
    if (t === 'zoom') {
      window.dispatchEvent(new CustomEvent('as-viewer-zoom', { detail: e.altKey ? -1 : 1 }))
      return true
    }
    if (t === 'text') { const id = newLayer('text'); if (id) mutate(d => { const c = d.clips.find(c => c.id === id); if (c) { c.x = Math.round(cp.x); c.y = Math.round(cp.y) } }); useUIStore.getState().setTool('select'); return true }
    if (t === 'rect' || t === 'ellipse') {
      e.currentTarget.setPointerCapture?.(e.pointerId)
      aeDrag.current = { kind: 'shape', sx: cx, sy: cy }
      setRubber({ x0: cx, y0: cy, x1: cx, y1: cy })
      return true
    }
    if (t === 'pen') {
      if (!useEditorStore.getState().selectedClipId) { useEditorStore.getState().toast({ kind: 'info', title: 'Select a layer first', detail: 'The Pen tool draws a mask on the selected layer' }); return true }
      if (penPts.length >= 3) {
        const f = penPts[0]
        const fx = (f.x / comp.width + 0.5) * w, fy = (0.5 - f.y / comp.height) * h
        if (Math.hypot(fx - cx, fy - cy) < 10) { commitPen(); return true }
      }
      setPenPts(p => [...p, { x: Math.round(cp.x), y: Math.round(cp.y) }])
      return true
    }
    // selection / rotation / pan-behind: hit test topmost layer
    const s = useEditorStore.getState()
    let target = hitLayer(cx, cy, w, h)
    const selClip = s.doc.clips.find(c => c.id === s.selectedClipId)
    if ((t === 'rotate' || t === 'anchor') && selClip) target = selClip
    if (!target) { if (t === 'select') s.select(null); return true }
    if (target.locked) return true
    if (e.shiftKey || e.ctrlKey || e.metaKey) { s.toggleSelect(target.id); return true }
    s.select(target.id) // keeps an existing multi-selection when clicking one of its members
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const lt = playbackEngine.currentTime - target.start
    if (t === 'rotate') {
      const ctr = layerCenterNDC(s.doc, target, playbackEngine.currentTime, comp)
      const [ccx, ccy] = ctr ? ndcToCss([ctr.x, ctr.y], w, h) : [w / 2, h / 2]
      aeDrag.current = { kind: 'rotate', clipId: target.id, cx: ccx, cy: ccy, a0: Math.atan2(cy - ccy, cx - ccx), r0: evalProperty(target, 'rotation', lt), moved: false }
    } else if (t === 'anchor') {
      aeDrag.current = { kind: 'anchor', clipId: target.id, sx: cx, sy: cy, ax0: evalProperty(target, 'anchorX', lt), ay0: evalProperty(target, 'anchorY', lt), x0: evalProperty(target, 'x', lt), y0: evalProperty(target, 'y', lt), moved: false }
    } else {
      const multi = useEditorStore.getState().selectedClipIds
      const t0 = playbackEngine.currentTime
      const others = multi.length > 1 ? s.doc.clips.filter(c => multi.includes(c.id) && c.id !== target!.id && !c.locked && c.kind !== 'audio')
        .map(c => ({ id: c.id, x0: evalProperty(c, 'x', t0 - c.start), y0: evalProperty(c, 'y', t0 - c.start) })) : []
      aeDrag.current = { kind: 'move', clipId: target.id, sx: cx, sy: cy, x0: evalProperty(target, 'x', lt), y0: evalProperty(target, 'y', lt), moved: false, others }
    }
    return true
  }

  const onAEMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ae || !doc) return
    const { cx, cy, w, h } = cssPt(e)
    const comp = doc.composition
    setCursor({ x: (cx / w - 0.5) * comp.width, y: (0.5 - cy / h) * comp.height })
    const pm = pinch.current
    if (pm && pm.pts.has(e.pointerId)) {
      pm.pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pm.pts.size === 2 && pm.d0 > 0) {
        const [a, b] = [...pm.pts.values()]
        const z = Math.max(0.1, Math.min(8, pm.z0 * Math.hypot(a.x - b.x, a.y - b.y) / pm.d0))
        setZoom(z)
        return
      }
    }
    const d = aeDrag.current
    if (!d) return
    if (d.kind === 'pan') { setPan({ x: d.px + e.clientX - d.sx, y: d.py + e.clientY - d.sy }); return }
    if (d.kind === 'shape') { setRubber(r => r ? { ...r, x1: cx, y1: cy } : r); return }
    const kx = comp.width / w, ky = comp.height / h
    if (!d.moved) {
      const dist = d.kind === 'rotate' ? Math.abs(Math.atan2(cy - d.cy, cx - d.cx) - d.a0) * 40 : Math.hypot(cx - d.sx, cy - d.sy)
      if (dist < 2) return
      d.moved = true
      liveBegin()
    }
    liveApply(doc2 => {
      const c = doc2.clips.find(c => c.id === d.clipId)
      if (!c) return
      if (d.kind === 'move') {
        let nx = d.x0 + (cx - d.sx) * kx, ny = d.y0 - (cy - d.sy) * ky
        if (e.shiftKey) { if (Math.abs(nx - d.x0) > Math.abs(ny - d.y0)) ny = d.y0; else nx = d.x0 }
        writePropIn(doc2, c, 'x', Math.round(nx))
        writePropIn(doc2, c, 'y', Math.round(ny))
        for (const o of d.others) {
          const oc = doc2.clips.find(x => x.id === o.id)
          if (!oc) continue
          writePropIn(doc2, oc, 'x', Math.round(o.x0 + (nx - d.x0)))
          writePropIn(doc2, oc, 'y', Math.round(o.y0 + (ny - d.y0)))
        }
      } else if (d.kind === 'rotate') {
        let r = d.r0 - ((Math.atan2(cy - d.cy, cx - d.cx) - d.a0) * 180) / Math.PI
        if (e.shiftKey) r = Math.round(r / 45) * 45
        writePropIn(doc2, c, 'rotation', Math.round(r * 10) / 10)
      } else if (d.kind === 'anchor') {
        // Pan Behind: move the anchor and compensate position so the layer stays put
        const dx = (cx - d.sx) * kx, dy = -(cy - d.sy) * ky
        writePropIn(doc2, c, 'anchorX', Math.round(d.ax0 + dx))
        writePropIn(doc2, c, 'anchorY', Math.round(d.ay0 - dy))
        writePropIn(doc2, c, 'x', Math.round(d.x0 + dx))
        writePropIn(doc2, c, 'y', Math.round(d.y0 + dy))
      }
    })
  }

  const onAEUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ae) return
    pinch.current?.pts.delete(e.pointerId)
    if (pinch.current && pinch.current.pts.size === 0) pinch.current = null
    const d = aeDrag.current
    aeDrag.current = null
    if (!d || !doc) return
    if (d.kind === 'shape') {
      const r = rubber
      setRubber(null)
      const { w, h } = cssPt(e)
      const comp = doc.composition
      const id = newLayer(tool === 'ellipse' ? 'ellipse' : 'shape')
      if (id && r) {
        const bw = Math.abs(r.x1 - r.x0) * comp.width / w, bh = Math.abs(r.y1 - r.y0) * comp.height / h
        const mx = ((r.x0 + r.x1) / 2 / w - 0.5) * comp.width, my = (0.5 - (r.y0 + r.y1) / 2 / h) * comp.height
        mutate(dd => {
          const c = dd.clips.find(c => c.id === id)
          if (c && c.kind === 'shape' && bw > 6 && bh > 6) {
            c.shape.width = Math.round(bw); c.shape.height = Math.round(bh)
            c.x = Math.round(mx); c.y = Math.round(my)
          }
        })
      }
      return
    }
    if ('moved' in d && d.moved) liveEnd()
  }

  const onMainPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!trackerPick && onNullDragDown(e)) return
    if (!trackerPick && onAEDown(e)) return
    onCanvasPointer(e)
  }

  const onMainPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    onNullDragMove(e)
    onAEMove(e)
  }

  const onMainPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    onNullDragUp()
    onAEUp(e)
  }

  const toolCursor = !ae ? undefined : tool === 'hand' ? (aeDrag.current?.kind === 'pan' ? 'grabbing' : 'grab') : tool === 'zoom' ? 'zoom-in' : tool === 'text' ? 'text' : tool === 'select' ? 'default' : 'crosshair'
  const zoomPct = Math.round((zoom === 'fit' ? fitPct : zoom) * 1000) / 10

  return (
    <div className={`relative flex-1 min-h-0 flex flex-col ${ae ? 'ae-viewer' : ''}`} onPointerDown={() => setFocus('viewer')}>
    <div
      ref={wrapRef}
      className={`relative flex-1 min-h-0 flex items-center justify-center overflow-hidden ${ae ? '' : 'monitor-glow'}`}
      onWheel={e => {
        if (!ae) return
        if (e.ctrlKey || e.metaKey || e.altKey) {
          window.dispatchEvent(new CustomEvent('as-viewer-zoom', { detail: e.deltaY < 0 ? 1 : -1 }))
        } else if (zoom !== 'fit') {
          setPan(p => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }))
        }
      }}
      onPointerLeave={() => ae && setCursor(null)}
    >
      <div className="relative" style={{ lineHeight: 0, transform: ae ? `translate(${pan.x}px, ${pan.y}px)` : undefined }}>
        <canvas
          ref={canvasRef}
          className={ae ? 'block bg-black touch-none' : 'max-w-full max-h-full bg-black rounded-lg shadow-[0_10px_40px_rgba(0,0,0,0.55)]'}
          style={{ ...canvasStyle, cursor: trackerPick ? 'crosshair' : toolCursor }}
          aria-label="Video preview"
          onPointerDown={onMainPointerDown}
          onPointerMove={onMainPointerMove}
          onPointerUp={onMainPointerUp}
          onPointerCancel={onMainPointerUp}
          onDoubleClick={() => { if (ae && tool === 'select') { const s = useEditorStore.getState(); const c = s.doc.clips.find(c => c.id === s.selectedClipId); if (c?.kind === 'text') s.setPanel('text') } }}
          {...(trackerPick ? { 'data-picking': '1' } : {})}
        />
        <canvas ref={cacheRef} className={`absolute left-0 top-0 z-[2] pointer-events-none ${ae ? '' : 'rounded-lg'}`} style={{ width: cssSize.w || undefined, height: cssSize.h || undefined, visibility: 'hidden' }} aria-hidden="true" />
        {ae && guides.checker && <div className="absolute inset-0 -z-10 ae-checker" />}
        {ae && (
          <canvas ref={aeOverlayRef} className="absolute left-0 top-0 z-[4] pointer-events-none" style={{ width: cssSize.w || undefined, height: cssSize.h || undefined }} />
        )}
        <canvas
          ref={overlayRef}
          className={`absolute left-0 top-0 z-[5] ${maskEditActive ? 'touch-none' : 'pointer-events-none'}`}
          style={{
            width: cssSize.w || undefined,
            height: cssSize.h || undefined,
            ...(trackerPick || maskEditActive ? { cursor: 'crosshair' } : {}),
          }}
          onPointerDown={onMaskPointerDown}
          onPointerMove={onMaskPointerMove}
          onPointerUp={onMaskPointerUp}
        />
      </div>
      {trackerPick && (
        <div
          className="absolute inset-0 z-[4] pointer-events-none"
          style={{ cursor: 'crosshair' }}
        />
      )}
      {compare && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 glass-violet text-violet-100 text-[11px] px-3 py-1 rounded-full z-10">
          AI PREVIEW — approve or discard below
        </div>
      )}
      {heavyActive >= 2 && (
        <div className="absolute top-2 left-2 glass-strong text-amber-200 text-[10px] px-2 py-1 rounded z-10 border border-amber-500/40">
          {heavyActive} heavy FX active — lower Resolution if it lags
        </div>
      )}
      {!ae && (
        <>
          <div className="absolute top-2 right-2 flex items-center gap-1 z-10">
            {(['quarter', 'half', 'full'] as const).map(q => (
              <button
                key={q}
                className={`text-[10px] px-2 py-1 rounded-md border ${quality === q ? 'glass-accent text-amber-400' : 'gbtn text-zinc-400'}`}
                onClick={() => setQuality(q)}
              >{q[0].toUpperCase()}</button>
            ))}
            <button
              className="text-[10px] px-2 py-1.5 rounded-md gbtn text-zinc-300"
              onClick={() => { playbackEngine.toggleCompare() }}
              aria-label="Before/after compare"
            ><Columns2 size={12} /></button>
            <button
              className="text-[10px] px-2 py-1.5 rounded-md gbtn text-zinc-300"
              onClick={() => {
                const el = wrapRef.current
                if (!el) return
                if (document.fullscreenElement) void document.exitFullscreen()
                else void el.requestFullscreen?.().catch(() => { })
              }}
              aria-label="Fullscreen preview"
            ><Maximize2 size={12} /></button>
          </div>
          <div className="absolute bottom-2 left-2 flex items-center gap-1 z-10">
            <select
              className="text-[10px] glass rounded-md px-1 py-0.5 text-zinc-300"
              value={zoom === 'fit' ? 'fit' : String(zoom)}
              onChange={e => setZoom(e.target.value === 'fit' ? 'fit' : parseFloat(e.target.value))}
              aria-label="Zoom"
            >
              <option value="fit">Fit</option>
              <option value="1">100%</option>
              <option value="1.5">150%</option>
              <option value="2">200%</option>
            </select>
            <span className="text-[10px] text-zinc-500 as-mono">{fps} fps · {quality}</span>
          </div>
          {doc && (
            <div className="absolute bottom-2 right-2 text-[10px] text-zinc-500 as-mono z-10">
              {doc.composition.width}×{doc.composition.height} · {doc.composition.fps}fps
            </div>
          )}
        </>
      )}
    </div>
    {ae && doc && (
      <div className="ae-viewer-bar shrink-0 overflow-x-auto as-scroll" style={{ scrollbarWidth: 'none' }}>
        <select className="ae-vb-select" value={zoom === 'fit' ? 'fit' : String(zoom)} title="Magnification ratio"
          onChange={e => setZoom(e.target.value === 'fit' ? 'fit' : parseFloat(e.target.value))} aria-label="Magnification">
          <option value="fit">Fit ({Math.round(fitPct * 100)}%)</option>
          {ZOOMS.map(z => <option key={z} value={z}>{Math.round(z * 1000) / 10}%</option>)}
          {zoom !== 'fit' && !ZOOMS.includes(zoom) && <option value={zoom}>{zoomPct}%</option>}
        </select>
        <select className="ae-vb-select" value={quality} title="Resolution / down sample factor"
          onChange={e => { setQuality(e.target.value as 'quarter' | 'half' | 'full'); window.dispatchEvent(new Event('as-quality')) }} aria-label="Resolution">
          <option value="full">Full</option>
          <option value="half">Half</option>
          <option value="quarter">Quarter</option>
        </select>
        <span className="w-px h-4 bg-[#3a3a3a] mx-1" />
        <button className="ae-vb-btn" data-on={guides.checker ? '1' : '0'} title="Toggle Transparency Grid" onClick={() => setGuides({ checker: !guides.checker })}><Grid3x3 size={13} className="opacity-60" /></button>
        <button className="ae-vb-btn" data-on={guides.grid ? '1' : '0'} title="Rule-of-thirds grid" onClick={() => setGuides({ grid: !guides.grid })}><Grid3x3 size={13} /></button>
        <button className="ae-vb-btn" data-on={guides.safe ? '1' : '0'} title="Title/Action Safe" onClick={() => setGuides({ safe: !guides.safe })}><Square size={13} /></button>
        <span className="w-px h-4 bg-[#3a3a3a] mx-1" />
        <ViewerTimecode fps={doc.composition.fps} />
        <button className="ae-vb-btn" title="Take Snapshot (save frame as PNG)" onClick={saveFrameAs}><Camera size={14} /></button>
        <button className="ae-vb-btn" title="Fast Previews: toggle effects (compare before/after)" onClick={() => { playbackEngine.toggleCompare(); setDrawTick(t => t + 1) }} data-on={playbackEngine.compareMode ? '1' : '0'}><Zap size={13} /></button>
        <span className="w-px h-4 bg-[#3a3a3a] mx-1" />
        <span className={`as-mono text-[10px] px-1 ${fps > 0 && fps < Math.min(24, doc.composition.fps * 0.6) ? 'text-red-400' : 'text-zinc-500'}`} title="Measured preview frame rate">{fps} fps</span>
        <div className="flex-1" />
        <span className="text-[10px] text-zinc-500 as-mono px-1 whitespace-nowrap">{doc.composition.width}×{doc.composition.height}</span>
        <button className="ae-vb-btn" title="Full screen preview" onClick={() => {
          const el = wrapRef.current
          if (!el) return
          if (document.fullscreenElement) void document.exitFullscreen()
          else void el.requestFullscreen?.().catch(() => { })
        }}><Maximize2 size={13} /></button>
      </div>
    )}
    </div>
  )
}

function ViewerTimecode({ fps }: { fps: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => playbackEngine.subscribeThrottled(t => { if (ref.current) ref.current.textContent = tcAE(t, fps) }, 50), [fps])
  return <span ref={ref} className="ae-timecode text-[12px] px-1.5 cursor-default" title="Current time">{tcAE(playbackEngine.currentTime, fps)}</span>
}

export function TransportBar() {
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [loop, setLoop] = useState(false)
  const [muted, setMuted] = useState(false)
  const doc = useEditorStore(s => s.doc)
  const fps = doc?.composition.fps ?? 30
  const duration = doc?.composition.duration ?? 0

  useEffect(() => {
    return playbackEngine.subscribeThrottled(t => { setTime(t); setPlaying(playbackEngine.state.playing) }, 100)
  }, [])

  useEffect(() => {
    playbackEngine.setLoop(loop)
  }, [loop])

  const toggle = () => {
    playbackEngine.toggle()
    setPlaying(playbackEngine.state.playing)
  }

  return (
    <div className="h-12 shrink-0 border-t border-white/8 glass-strong flex items-center px-2 gap-1 no-select">
      <button className="p-2 text-zinc-400 hover:text-white" onClick={() => { playbackEngine.goToStart() }} aria-label="Go to start"><ChevronFirst size={18} /></button>
      <button className="p-2 text-zinc-400 hover:text-white" onClick={() => playbackEngine.stepFrame(-1)} aria-label="Previous frame"><SkipBack size={16} /></button>
      <button
        className="p-2 rounded-full bg-amber-500 text-white mx-0.5"
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
      </button>
      <button className="p-2 text-zinc-400 hover:text-white" onClick={() => playbackEngine.stepFrame(1)} aria-label="Next frame"><SkipForward size={16} /></button>
      <button className="p-2 text-zinc-400 hover:text-white" onClick={() => playbackEngine.goToEnd()} aria-label="Go to end"><ChevronLast size={18} /></button>

      <span className="as-mono text-[11px] text-zinc-300 ml-1 tabular-nums whitespace-nowrap">
        {timecode(time, fps)} <span className="text-zinc-600">/ {timecode(duration, fps)}</span>
      </span>

      <div className="flex-1" />

      <select
        className="text-[11px] glass rounded-md px-1 py-1 text-zinc-300"
        onChange={e => playbackEngine.setRate(parseFloat(e.target.value))}
        defaultValue="1"
        aria-label="Playback rate"
      >
        {[0.25, 0.5, 1, 1.5, 2].map(r => <option key={r} value={r}>{r}x</option>)}
      </select>
      <button className={`p-2 ${loop ? 'text-amber-400' : 'text-zinc-500'}`} onClick={() => setLoop(l => !l)} aria-label="Loop"><Repeat size={16} /></button>
      <button className="p-2 text-[#3ccf55]" onClick={() => { if (playbackEngine.ramBuilding) playbackEngine.cancelRamPreview(); else { setLoop(true); void playbackEngine.ramPreview() } }} aria-label="RAM preview" title="RAM Preview: render to memory, then play smooth"><Zap size={16} /></button>
      <button
        className={`p-2 ${muted ? 'text-red-400' : 'text-zinc-400'}`}
        onClick={() => { setMuted(playbackEngine.toggleMute()); void import('@/lib/engine/audio').then(({ audioEngine }) => audioEngine.unlock()) }}
        aria-label="Mute"
      >
        {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </button>
    </div>
  )
}
