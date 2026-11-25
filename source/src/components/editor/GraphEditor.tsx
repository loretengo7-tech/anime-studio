'use client'
/**
 * ANIME STUDIO — Graph Editor
 * Canvas curve editor: value vs time for any animated property, draggable
 * keyframes, editable bezier interpolation handles, easing presets.
 */
import { useEffect, useRef, useState, useMemo } from 'react'
import type { Clip, Keyframe, EasingName } from '@/lib/engine/types'
import { uid } from '@/lib/engine/types'
import { useEditorStore } from '@/lib/store/editorStore'
import { evalKeyframeTrack } from '@/lib/engine/keyframes'
import { cubicBezierY } from '@/lib/engine/keyframes'
import { playbackEngine } from '@/lib/engine/playback'

const PROPS = ['x', 'y', 'scale', 'rotation', 'opacity', 'anchorX', 'anchorY', 'volume']
const COLORS: Record<string, string> = {
  x: '#f59e0b', y: '#10b981', scale: '#38bdf8', rotation: '#a78bfa',
  opacity: '#f472b6', anchorX: '#94a3b8', anchorY: '#94a3b8', volume: '#34d399',
}
const EASINGS: EasingName[] = ['linear', 'hold', 'easeIn', 'easeOut', 'easeInOut', 'easeOutBack', 'easeOutElastic', 'expoOut', 'circOut', 'bezier']

type Hit =
  | { kind: 'kf'; kfId: string; prop: string }
  | { kind: 'handle'; kfId: string; prop: string; idx: 0 | 1 }
  | null

export function GraphEditor() {
  const doc = useEditorStore(s => s.doc)
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const selectedKeyframeId = useEditorStore(s => s.selectedKeyframeId)
  const selectKeyframe = useEditorStore(s => s.selectKeyframe)
  const mutate = useEditorStore(s => s.mutate)
  const clip = doc.clips.find(c => c.id === selectedClipId) ?? null

  const animatedProps = useMemo(() => {
    if (!clip) return []
    const out: string[] = []
    for (const t of clip.keyframes) {
      if (t.keyframes.length > 0 && PROPS.includes(t.property)) out.push(t.property)
    }
    return out
  }, [clip])
  const [propPref, setProp] = useState<string>('scale')
  const prop = animatedProps.includes(propPref) ? propPref : (animatedProps[0] ?? 'scale')

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ kind: 'kf' | 'handle'; kfId: string; idx?: 0 | 1; startX: number; startY: number; origTime: number; origVal: number; origHandles?: Keyframe['handles'] } | null>(null)

  const view = useMemo(() => {
    const track = clip?.keyframes.find(k => k.property === prop)
    const kfs = track?.keyframes ?? []
    let tMin = 0, tMax = clip?.duration ?? 1
    let vMin = 0, vMax = 1
    if (kfs.length > 0) {
      const vals = kfs.map(k => k.value)
      vMin = Math.min(...vals)
      vMax = Math.max(...vals)
      if (vMax - vMin < 1e-6) { vMin -= 1; vMax += 1 }
      const pad = (vMax - vMin) * 0.15
      vMin -= pad; vMax += pad
    } else {
      vMax = 1; vMin = 0
    }
    return { tMin, tMax, vMin, vMax, kfs }
  }, [clip, prop])

  const toPx = (t: number, v: number, w: number, h: number) => ({
    x: 44 + ((t - view.tMin) / Math.max(1e-6, view.tMax - view.tMin)) * (w - 56),
    y: h - 28 - ((v - view.vMin) / Math.max(1e-6, view.vMax - view.vMin)) * (h - 44),
  })
  const fromPx = (x: number, y: number, w: number, h: number) => ({
    t: view.tMin + ((x - 44) / Math.max(1, w - 56)) * (view.tMax - view.tMin),
    v: view.vMin + ((h - 28 - y) / Math.max(1, h - 44)) * (view.vMax - view.vMin),
  })

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap || !clip) return
    const w = canvas.width = wrap.clientWidth
    const h = canvas.height = Math.max(220, wrap.clientHeight)
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.fillStyle = '#0c0c0e'
    ctx.fillRect(0, 0, w, h)
    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1
    for (let i = 0; i <= 4; i++) {
      const y = 16 + (i / 4) * (h - 44)
      ctx.beginPath(); ctx.moveTo(44, y); ctx.lineTo(w - 12, y); ctx.stroke()
    }
    for (let i = 0; i <= 6; i++) {
      const x = 44 + (i / 6) * (w - 56)
      ctx.beginPath(); ctx.moveTo(x, 16); ctx.lineTo(x, h - 28); ctx.stroke()
    }
    // axis labels
    ctx.fillStyle = '#71717a'
    ctx.font = '9px ui-monospace'
    ctx.fillText(view.vMax.toFixed(1), 6, 20)
    ctx.fillText(view.vMin.toFixed(1), 6, h - 30)
    ctx.fillText('0', 44, h - 14)
    ctx.fillText(`${view.tMax.toFixed(1)}s`, w - 44, h - 14)

    const track = clip.keyframes.find(k => k.property === prop)
    const kfs = track?.keyframes ?? []
    const color = COLORS[prop] ?? '#f59e0b'

    // curve
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.beginPath()
    const N = 160
    for (let i = 0; i <= N; i++) {
      const t = view.tMin + (i / N) * (view.tMax - view.tMin)
      const v = evalKeyframeTrack(track, t, kfs.length === 1 ? kfs[0].value : undefined)
      if (v === undefined) continue
      const p = toPx(t, v, w, h)
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y)
    }
    ctx.stroke()

    // bezier handles for bezier segments
    for (let i = 0; i < kfs.length - 1; i++) {
      const a = kfs[i]
      if (a.easing !== 'bezier' || !a.handles) continue
      const [h1, h2] = a.handles
      const pA = toPx(a.time, a.value, w, h)
      const pH1 = toPx(a.time + h1.x * Math.max(1e-3, kfs[i + 1].time - a.time), a.value + h1.y * (kfs[i + 1].value - a.value), w, h)
      const pH2 = toPx(a.time + h2.x * Math.max(1e-3, kfs[i + 1].time - a.time), a.value + h2.y * (kfs[i + 1].value - a.value), w, h)
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(pA.x, pA.y); ctx.lineTo(pH1.x, pH1.y); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(pH1.x, pH1.y); ctx.lineTo(pH2.x, pH2.y); ctx.stroke()
      for (const p of [pH1, pH2]) {
        ctx.fillStyle = '#fff'
        ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill()
      }
    }

    // keyframes
    for (const kf of kfs) {
      const p = toPx(kf.time, kf.value, w, h)
      const selected = kf.id === selectedKeyframeId
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(Math.PI / 4)
      ctx.fillStyle = selected ? '#fff' : color
      ctx.strokeStyle = '#18181b'
      ctx.lineWidth = 1.5
      ctx.fillRect(-5, -5, 10, 10)
      ctx.strokeRect(-5, -5, 10, 10)
      ctx.restore()
    }

    // playhead
    const playT = playbackEngine.currentTime - (clip?.start ?? 0)
    if (playT >= view.tMin && playT <= view.tMax) {
      const p = toPx(playT, view.vMin, w, h)
      ctx.strokeStyle = 'rgba(245,158,11,0.7)'
      ctx.beginPath(); ctx.moveTo(p.x, 12); ctx.lineTo(p.x, h - 24); ctx.stroke()
    }
  }, [clip, prop, view, selectedKeyframeId, doc])

  const hitTest = (x: number, y: number, w: number, h: number): Hit => {
    const track = clip?.keyframes.find(k => k.property === prop)
    if (!track) return null
    for (const kf of track.keyframes) {
      const p = toPx(kf.time, kf.value, w, h)
      if (Math.hypot(p.x - x, p.y - y) < 11) return { kind: 'kf', kfId: kf.id, prop }
    }
    // handles
    for (let i = 0; i < track.keyframes.length - 1; i++) {
      const kf = track.keyframes[i]
      if (kf.easing !== 'bezier' || !kf.handles) continue
      const next = track.keyframes[i + 1]
      const [h1, h2] = kf.handles
      const pts = [h1, h2]
      for (let idx = 0; idx < 2; idx++) {
        const hp = toPx(kf.time + pts[idx].x * Math.max(1e-3, next.time - kf.time), kf.value + pts[idx].y * (next.value - kf.value), w, h)
        if (Math.hypot(hp.x - x, hp.y - y) < 9) return { kind: 'handle', kfId: kf.id, prop, idx: idx as 0 | 1 }
      }
    }
    return null
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const canvas = canvasRef.current
    if (!canvas || !clip) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left, y = e.clientY - rect.top
    const hit = hitTest(x, y, canvas.width, canvas.height)
    if (hit?.kind === 'kf') {
      selectKeyframe(hit.kfId)
      const kf = clip.keyframes.find(t => t.property === prop)?.keyframes.find(k => k.id === hit.kfId)
      if (kf) dragRef.current = { kind: 'kf', kfId: kf.id, startX: x, startY: y, origTime: kf.time, origVal: kf.value }
      canvas.setPointerCapture(e.pointerId)
    } else if (hit?.kind === 'handle') {
      const kf = clip.keyframes.find(t => t.property === prop)?.keyframes.find(k => k.id === hit.kfId)
      if (kf?.handles) {
        dragRef.current = { kind: 'handle', kfId: kf.id, idx: hit.idx, startX: x, startY: y, origTime: kf.time, origVal: kf.value, origHandles: JSON.parse(JSON.stringify(kf.handles)) }
        canvas.setPointerCapture(e.pointerId)
      }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    const canvas = canvasRef.current
    if (!drag || !canvas || !clip) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left, y = e.clientY - rect.top
    const { t, v } = fromPx(x, y, canvas.width, canvas.height)
    mutate(d => {
      const c = d.clips.find(c => c.id === clip.id)
      const track = c?.keyframes.find(k => k.property === prop)
      const kf = track?.keyframes.find(k => k.id === drag.kfId)
      if (!kf) return
      if (drag.kind === 'kf') {
        kf.time = Math.max(0, Math.min(clip.duration, t))
        kf.value = v
        track!.keyframes.sort((a, b) => a.time - b.time)
      } else if (drag.kind === 'handle' && kf.easing === 'bezier' && kf.handles && drag.origHandles) {
        const idx = drag.idx!
        kf.handles[idx] = {
          x: Math.max(0.02, Math.min(0.98, drag.origHandles[idx].x + (x - drag.startX) / (canvas.width - 56))),
          y: Math.max(-1.2, Math.min(2.2, drag.origHandles[idx].y + (drag.startY - y) / (canvas.height - 44))),
        }
      }
    })
  }

  const onPointerUp = () => { dragRef.current = null }

  const selKf = clip?.keyframes.find(t => t.property === prop)?.keyframes.find(k => k.id === selectedKeyframeId)
  const nextKf = selKf && clip ? clip.keyframes.find(t => t.property === prop)?.keyframes.filter(k => k.time > selKf.time)[0] : null

  const setEasing = (easing: EasingName) => {
    if (!selKf) return
    mutate(d => {
      const c = d.clips.find(c => c.id === clip!.id)
      const kf = c?.keyframes.find(t => t.property === prop)?.keyframes.find(k => k.id === selKf.id)
      if (!kf) return
      kf.easing = easing
      if (easing === 'bezier' && !kf.handles) {
        kf.handles = [{ x: 0.33, y: 0.33 }, { x: 0.67, y: 0.67 }]
      }
    })
  }

  const addKeyframeHere = () => {
    if (!clip) return
    const t = Math.max(0, Math.min(clip.duration, playbackEngine.currentTime - clip.start))
    const track = clip.keyframes.find(k => k.property === prop)
    const v = evalKeyframeTrack(track, t, 0) ?? 0
    mutate(d => {
      const c = d.clips.find(c => c.id === clip.id)
      let tr = c?.keyframes.find(k => k.property === prop)
      if (c && !tr) {
        tr = { property: prop, keyframes: [] }
        c.keyframes.push(tr)
      }
      if (tr) {
        const id = uid('kf')
        tr.keyframes.push({ id, time: t, value: v, easing: 'easeInOut' })
        tr.keyframes.sort((a, b) => a.time - b.time)
        selectKeyframe(id)
      }
    })
  }

  if (!clip) {
    return <div className="p-4 text-xs text-zinc-500">Select a clip, then keyframe a property (diamond buttons in the Inspector) to edit its curve here.</div>
  }
  if (animatedProps.length === 0) {
    return <div className="p-4 text-xs text-zinc-500">No animated properties yet. Use the diamond buttons next to transform sliders in the Inspector, or let the AI generate keyframes.</div>
  }

  return (
    <div className="p-3">
      <div className="flex gap-1.5 mb-2 overflow-x-auto as-scroll pb-1">
        {animatedProps.map(p => (
          <button
            key={p}
            className={`text-[11px] px-2.5 py-1 rounded-full border shrink-0 ${p === prop ? 'text-black' : 'text-zinc-300'}`}
            style={{ background: p === prop ? (COLORS[p] ?? '#f59e0b') : 'transparent', borderColor: COLORS[p] ?? '#f59e0b' }}
            onClick={() => setProp(p)}
          >
            {p}
          </button>
        ))}
        <button className="text-[11px] px-2.5 py-1 rounded-full border border-zinc-600 text-zinc-300 shrink-0" onClick={addKeyframeHere}>+ keyframe @ playhead</button>
      </div>

      <div ref={wrapRef} className="rounded-lg overflow-hidden border border-white/8">
        <canvas
          ref={canvasRef}
          className="w-full touch-none"
          style={{ height: 240 }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>

      {selKf && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-zinc-500 as-mono">t={selKf.time.toFixed(2)}s v={selKf.value.toFixed(2)}{nextKf ? ` → ${nextKf.time.toFixed(2)}s` : ''}</span>
          {EASINGS.map(e => (
            <button
              key={e}
              className={`text-[10px] px-2 py-0.5 rounded border ${selKf.easing === e ? 'bg-amber-500 text-black border-amber-500' : 'text-zinc-400 border-white/12'}`}
              onClick={() => setEasing(e)}
            >
              {e === 'bezier' ? '✦ bezier' : e}
            </button>
          ))}
          <button className="text-[10px] px-2 py-0.5 rounded border border-red-500/50 text-red-400" onClick={() => {
            mutate(d => {
              const c = d.clips.find(c => c!.id === clip.id)
              const tr = c?.keyframes.find(t => t.property === prop)
              if (tr) tr.keyframes = tr.keyframes.filter(k => k.id !== selKf.id)
            })
            selectKeyframe(null)
          }}>delete</button>
        </div>
      )}
      <p className="text-[10px] text-zinc-600 mt-2">Drag diamonds to retime/revalue. Select a diamond to set easing; with ✦ bezier, drag the white handles to shape acceleration.</p>
    </div>
  )
}
