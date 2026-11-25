'use client'
/**
 * ANIME STUDIO — AE-style layer timeline.
 *
 * Every clip is a numbered layer row (layer 1 = top of the stack) with the
 * A/V switches (eye, audio, solo, lock), label color, name, layer switches
 * (shy, fx, 3D), Mode / TrkMat and Parent & Link columns. Layers twirl open
 * into Transform / Effects / Audio property groups with stopwatches,
 * keyframe navigators and scrubbable blue values. The right side holds the
 * time ruler, work-area bar, blue CTI, layer bars and keyframe icons.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Clip, VideoClip, AudioClip, EffectInstance, Keyframe, ProjectDoc, BlendMode } from '@/lib/engine/types'
import { LABEL_COLORS, defaultLabel, uid } from '@/lib/engine/types'
import { useEditorStore } from '@/lib/store/editorStore'
import { useUIStore, type RevealProp } from '@/lib/store/uiStore'
import { playbackEngine } from '@/lib/engine/playback'
import { evalProperty, evalEffectParam } from '@/lib/engine/keyframes'
import { EFFECT_MAP, BLEND_MODES } from '@/lib/engine/effects'
import { getPluginEffectDefs } from '@/lib/engine/plugins'
import { GraphEditor } from '../GraphEditor'
import { Timeline as TrackTimeline } from '../Timeline'
import {
  layerOrder, TRANSFORM_PROPS, isPropAnimated, toggleStopwatch, toggleKeyAtCTI, jumpKeyframe,
  liveBegin, liveApply, liveEnd, writePropIn, tcAE, parseTime, moveLayerTo, addAssetLayer, openComp, addCompLayer,
} from './aeActions'
import { applyEffectToClip } from './AEPanels'
import { exprErrors, EXPRESSION_PRESETS } from '@/lib/engine/expressions'
import {
  Eye, EyeOff, Volume2, Lock, ChevronRight, ChevronDown, Search, Box, Timer, LineChart,
  Mountain, MountainSnow, Trash2, Rows3, Ghost, Zap,
} from 'lucide-react'

const ROW_H = 22
const PROP_H = 20
const RULER_H = 32
const AV_W = 80
const NUM_W = 44
const NAME_W = 178
const SW_W = 90
const MODE_W = 140
const PARENT_W = 112

type Row =
  | { kind: 'layer'; clip: Clip; index: number }
  | { kind: 'group'; clip: Clip; id: string; label: string; depth: number; open: boolean; onDelete?: () => void; fx?: EffectInstance }
  | { kind: 'prop'; clip: Clip; label: string; depth: number; props: PropSpec }
  | { kind: 'expr'; clip: Clip; group: string; depth: number }

type PropSpec =
  | { type: 'transform'; key: string; parts: typeof TRANSFORM_PROPS[number]['props'] }
  | { type: 'effect'; fxId: string; param: string; min: number; max: number; step: number }
  | { type: 'volume' }

function useCacheTick() {
  const [, setT] = useState(0)
  useEffect(() => {
    const h = () => setT(t => (t + 1) % 1e6)
    window.addEventListener('as-cache', h)
    return () => window.removeEventListener('as-cache', h)
  }, [])
}

/** AE green bar: frames held in the RAM preview cache */
function CacheBar({ pps }: { pps: number }) {
  useCacheTick()
  return (
    <>
      {playbackEngine.cacheRanges().map(([a, b], i) => (
        <div key={i} className="absolute top-[9px] h-[3px] bg-[#3ccf55] pointer-events-none" style={{ left: a * pps, width: Math.max(1, (b - a) * pps) }} />
      ))}
    </>
  )
}

function CacheInfo() {
  useCacheTick()
  const s = playbackEngine.cacheStats
  if (!s.frames) return null
  return (
    <button className="text-[10px] text-[#3ccf55] as-mono px-1 hover:underline whitespace-nowrap" title="Frames in RAM — click to purge the cache" onClick={() => playbackEngine.clearCache()}>
      RAM {s.frames}f · {s.mb}/{s.budgetMb}MB
    </button>
  )
}

function rowH(r: Row) { return r.kind === 'layer' ? ROW_H : r.kind === 'expr' ? 46 : PROP_H }

/** AE motion-blur switch glyph */
function MBIcon({ on = true }: { on?: boolean }) {
  return (
    <svg width="13" height="10" viewBox="0 0 13 10" style={{ opacity: on ? 1 : 0.35 }}>
      <circle cx="9" cy="5" r="3.2" fill="currentColor" />
      <path d="M0 3.5h4M1 5h3M0 6.5h4" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

function ExprCells({ clip, group, pad, onChange, onRemove }: { clip: Clip; group: string; pad: number; onChange: (c: string) => void; onRemove: () => void }) {
  const code = clip.expressions?.[group] ?? ''
  const [draft, setDraft] = useState(code)
  useEffect(() => setDraft(code), [code])
  const [, force] = useState(0)
  useEffect(() => playbackEngine.subscribeThrottled(() => force(n => (n + 1) % 1e6), 400), [])
  const err = exprErrors.get(`${clip.id}:${group}`)
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  return (
    <div className="flex items-start gap-1.5 h-full w-full py-[3px] pr-2" style={{ paddingLeft: pad }} onPointerDown={stop}>
      <span className="text-[11px] text-[#e0605c] font-mono mt-[3px] shrink-0" title="Expression">=</span>
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <textarea
          className={`aet-input !h-[24px] w-full font-mono !text-[11px] resize-none leading-[20px] ${err ? '!border-[#e0605c]' : ''}`}
          value={draft} spellCheck={false}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => { if (draft !== code) onChange(draft) }}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onChange(draft) } }}
        />
        <span className={`text-[10px] truncate ${err ? 'text-[#e0605c]' : 'text-zinc-500'}`}>{err ? `⚠ ${err}` : 'Enter aplica · wiggle(f,a) · loopOut() · shake() · beat(bpm) · time · value'}</span>
      </div>
      <select className="aet-input w-[18px] !px-0 shrink-0" value="" title="Expression presets" onChange={e => { if (e.target.value) onChange(e.target.value) }}>
        <option value="">▾</option>
        {EXPRESSION_PRESETS.filter(p => p.group === 'any' || p.group === group).map(p => <option key={p.label} value={p.code}>{p.label}</option>)}
      </select>
      <button className="aet-sw !w-4 shrink-0" title="Remove expression" onClick={onRemove}><Trash2 size={11} /></button>
    </div>
  )
}

function hexShade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f))
  const g = Math.min(255, Math.round(((n >> 8) & 255) * f))
  const b = Math.min(255, Math.round((n & 255) * f))
  return `rgb(${r},${g},${b})`
}

function labelOf(c: Clip) { return LABEL_COLORS[c.label ?? defaultLabel(c.kind)] ?? LABEL_COLORS[0] }

function allDefs() { return { ...EFFECT_MAP, ...Object.fromEntries(getPluginEffectDefs().map(d => [d.type, d])) } }

function revealKeyOf(key: string): RevealProp | null {
  return (['anchor', 'position', 'scale', 'rotation', 'opacity'] as const).find(k => k === key) ?? null
}

export function AETimeline() {
  const doc = useEditorStore(s => s.doc)
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const selectedKeyframeId = useEditorStore(s => s.selectedKeyframeId)
  const select = useEditorStore(s => s.select)
  const selectKeyframe = useEditorStore(s => s.selectKeyframe)
  const toggleSelect = useEditorStore(s => s.toggleSelect)
  const selectMany = useEditorStore(s => s.selectMany)
  const selectedClipIds = useEditorStore(s => s.selectedClipIds)
  const selectedKeyframeIds = useEditorStore(s => s.selectedKeyframeIds)
  const mutate = useEditorStore(s => s.mutate)
  const previewActive = useEditorStore(s => s.preview !== null)
  const openMap = useUIStore(s => s.open)
  const setOpen = useUIStore(s => s.setOpen)
  const reveal = useUIStore(s => s.reveal)
  const shyHidden = useUIStore(s => s.shyHidden)
  const toggleShy = useUIStore(s => s.toggleShy)
  const graphMode = useUIStore(s => s.graphMode)
  const setGraphMode = useUIStore(s => s.setGraphMode)
  const setFocus = useUIStore(s => s.setFocus)

  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({})
  const [showModes, setShowModes] = useState(true)
  const [query, setQuery] = useState('')
  const [trackView, setTrackView] = useState(false)
  const [pps, setPps] = useState(60)
  const [, setWaTick] = useState(0)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dropLine, setDropLine] = useState<number | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const ctiRef = useRef<HTMLDivElement>(null)
  const ctiHeadRef = useRef<HTMLDivElement>(null)
  const tcRef = useRef<HTMLSpanElement>(null)
  const frameRef = useRef<HTMLSpanElement>(null)

  const fps = Math.max(1, doc.composition.fps)
  const compDur = doc.composition.duration
  const duration = useMemo(() => {
    let end = compDur
    for (const c of doc.clips) end = Math.max(end, c.start + c.duration)
    return end
  }, [doc, compDur])
  const LW = AV_W + NUM_W + NAME_W + SW_W + (showModes ? MODE_W : 0) + PARENT_W
  const contentW = Math.max(400, duration * pps + 40)

  // fit comp to view on first mount / comp change
  const fitted = useRef<string>('')
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc || fitted.current === doc.id) return
    fitted.current = doc.id
    const avail = sc.clientWidth - LW - 30
    if (avail > 100) setPps(Math.max(4, Math.min(400, avail / Math.max(1, duration))))
  }, [doc.id, LW, duration])

  // work area changes come from shortcuts / menus
  useEffect(() => {
    const h = () => setWaTick(t => t + 1)
    window.addEventListener('as-workarea', h)
    return () => window.removeEventListener('as-workarea', h)
  }, [])

  // CTI + timecode: imperative (no React render per frame)
  useEffect(() => {
    const apply = (t: number) => {
      const x = t * pps
      if (ctiRef.current) ctiRef.current.style.transform = `translateX(${x}px)`
      if (ctiHeadRef.current) ctiHeadRef.current.style.transform = `translateX(${x}px)`
      if (tcRef.current) tcRef.current.textContent = tcAE(t, fps)
      if (frameRef.current) frameRef.current.textContent = `${String(Math.round(t * fps)).padStart(5, '0')} (${fps.toFixed(2)} fps)`
      const sc = scrollRef.current
      if (sc && playbackEngine.state.playing) {
        const left = sc.scrollLeft, right = left + sc.clientWidth - LW
        if (x < left || x > right - 30) sc.scrollLeft = Math.max(0, x - (sc.clientWidth - LW) * 0.2)
      }
    }
    apply(playbackEngine.currentTime)
    return playbackEngine.subscribe(apply)
  }, [pps, fps, LW])

  // ---- rows ----
  const layers = useMemo(() => layerOrder(doc), [doc])
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const q = query.trim().toLowerCase()
    const defs = allDefs()
    layers.forEach((clip, i) => {
      if (shyHidden && clip.shy) return
      if (q && !clip.name.toLowerCase().includes(q)) return
      out.push({ kind: 'layer', clip, index: i + 1 })
      const revealed = reveal && reveal.clipIds.includes(clip.id) ? reveal.props : null
      const hasTransform = clip.kind !== 'audio'
      if (revealed) {
        // P/S/R/T/A/U: properties directly under the layer, AE style
        for (const g of TRANSFORM_PROPS) {
          if (!hasTransform) break
          const rk = revealKeyOf(g.key)
          const show = revealed === 'animated' ? g.props.some(p => isPropAnimated(clip, p.p)) : !!rk && revealed.includes(rk)
          if (show || (revealed === 'animated' && clip.expressions?.[g.key])) {
            out.push({ kind: 'prop', clip, label: g.label, depth: 1, props: { type: 'transform', key: g.key, parts: g.props } })
            if (clip.expressions?.[g.key] !== undefined) out.push({ kind: 'expr', clip, group: g.key, depth: 1 })
          }
        }
        if (revealed === 'animated') {
          for (const fx of clip.effects) for (const [k, kfs] of Object.entries(fx.paramKeyframes ?? {})) {
            if (!kfs.length) continue
            const pd = defs[fx.type]?.params.find(p => p.key === k)
            out.push({ kind: 'prop', clip, label: `${defs[fx.type]?.name ?? fx.type} · ${pd?.label ?? k}`, depth: 1, props: { type: 'effect', fxId: fx.id, param: k, min: pd?.min ?? -1e4, max: pd?.max ?? 1e4, step: pd?.step ?? 0.01 } })
          }
          if (isPropAnimated(clip, 'volume')) out.push({ kind: 'prop', clip, label: 'Audio Levels', depth: 1, props: { type: 'volume' } })
        }
        return
      }
      if (!openMap[clip.id]) return
      if (clip.effects.length > 0) {
        const gid = `${clip.id}:effects`
        const gOpen = groupOpen[gid] ?? true
        out.push({ kind: 'group', clip, id: gid, label: 'Effects', depth: 1, open: gOpen })
        if (gOpen) for (const fx of clip.effects) {
          const def = defs[fx.type]
          const fid = `${clip.id}:fx:${fx.id}`
          const fOpen = groupOpen[fid] ?? false
          out.push({
            kind: 'group', clip, id: fid, label: def?.name ?? fx.type, depth: 2, open: fOpen, fx,
            onDelete: () => mutate(d => { const c = d.clips.find(c => c.id === clip.id); if (c) c.effects = c.effects.filter(e => e.id !== fx.id) }),
          })
          if (fOpen && def) for (const p of def.params) {
            out.push({ kind: 'prop', clip, label: p.label, depth: 3, props: { type: 'effect', fxId: fx.id, param: p.key, min: p.min, max: p.max, step: p.step } })
          }
        }
      }
      if (hasTransform) {
        const gid = `${clip.id}:transform`
        const gOpen = groupOpen[gid] ?? true
        out.push({ kind: 'group', clip, id: gid, label: 'Transform', depth: 1, open: gOpen })
        if (gOpen) for (const g of TRANSFORM_PROPS) {
          out.push({ kind: 'prop', clip, label: g.label, depth: 2, props: { type: 'transform', key: g.key, parts: g.props } })
          if (clip.expressions?.[g.key] !== undefined) out.push({ kind: 'expr', clip, group: g.key, depth: 2 })
        }
      }
      if (clip.kind === 'audio' || clip.kind === 'video') {
        const gid = `${clip.id}:audio`
        const gOpen = groupOpen[gid] ?? clip.kind === 'audio'
        out.push({ kind: 'group', clip, id: gid, label: 'Audio', depth: 1, open: gOpen })
        if (gOpen) out.push({ kind: 'prop', clip, label: 'Audio Levels', depth: 2, props: { type: 'volume' } })
      }
    })
    return out
  }, [layers, openMap, groupOpen, reveal, shyHidden, query, mutate])

  // ---- time helpers ----
  const xToTime = useCallback((clientX: number) => {
    const sc = scrollRef.current
    if (!sc) return 0
    const r = sc.getBoundingClientRect()
    return Math.max(0, (clientX - r.left + sc.scrollLeft - LW) / pps)
  }, [pps, LW])

  const snap = useCallback((t: number, ignore?: string, on = true) => {
    if (!on) return Math.max(0, Math.round(t * fps) / fps)
    const thr = 8 / pps
    const targets = [0, playbackEngine.currentTime, ...doc.markers.map(m => m.time)]
    for (const c of doc.clips) if (c.id !== ignore) targets.push(c.start, c.start + c.duration)
    let best = Math.round(t * fps) / fps, bd = thr
    for (const g of targets) { const d = Math.abs(g - t); if (d < bd) { bd = d; best = g } }
    return Math.max(0, best)
  }, [doc, fps, pps])

  // ---- ruler scrub ----
  const scrubbing = useRef(false)
  const onRulerDown = (e: React.PointerEvent) => {
    if (previewActive) return
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    scrubbing.current = true
    playbackEngine.pause()
    playbackEngine.seek(Math.round(xToTime(e.clientX) * fps) / fps)
  }
  const onRulerMove = (e: React.PointerEvent) => {
    if (!scrubbing.current) return
    playbackEngine.seek(Math.min(duration, Math.round(xToTime(e.clientX) * fps) / fps))
  }
  const onRulerUp = () => { scrubbing.current = false }

  // ---- work area ----
  const wa = { in: playbackEngine.state.inPoint ?? 0, out: playbackEngine.state.outPoint ?? compDur }
  const waDrag = useRef<{ edge: 'in' | 'out' | 'both'; x0: number; in0: number; out0: number } | null>(null)
  const onWaDown = (edge: 'in' | 'out' | 'both') => (e: React.PointerEvent) => {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    waDrag.current = { edge, x0: e.clientX, in0: wa.in, out0: wa.out }
  }
  const onWaMove = (e: React.PointerEvent) => {
    const d = waDrag.current
    if (!d) return
    const dt = (e.clientX - d.x0) / pps
    const s = playbackEngine.state
    const q = (t: number) => Math.round(t * fps) / fps
    if (d.edge === 'in') s.inPoint = q(Math.max(0, Math.min(d.out0 - 1 / fps, d.in0 + dt)))
    else if (d.edge === 'out') s.outPoint = q(Math.max(d.in0 + 1 / fps, Math.min(duration, d.out0 + dt)))
    else {
      const len = d.out0 - d.in0
      const ni = q(Math.max(0, Math.min(duration - len, d.in0 + dt)))
      s.inPoint = ni; s.outPoint = ni + len
    }
    setWaTick(t => t + 1)
  }
  const onWaUp = () => { waDrag.current = null }

  // ---- layer bar drag (move / trim) ----
  type BarDrag = { mode: 'move' | 'trimL' | 'trimR'; clipId: string; x0: number; start0: number; dur0: number; in0: number; moved: boolean; others: { id: string; start0: number }[] }
  const barDrag = useRef<BarDrag | null>(null)
  const onBarDown = (e: React.PointerEvent, clip: Clip, mode: BarDrag['mode']) => {
    if (previewActive || clip.locked) return
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    if (e.ctrlKey || e.metaKey) { toggleSelect(clip.id); return }
    select(clip.id)
    const multi = useEditorStore.getState().selectedClipIds
    const others = mode === 'move' && multi.length > 1 && multi.includes(clip.id)
      ? doc.clips.filter(c => multi.includes(c.id) && c.id !== clip.id && !c.locked).map(c => ({ id: c.id, start0: c.start }))
      : []
    barDrag.current = { mode, clipId: clip.id, x0: e.clientX, start0: clip.start, dur0: clip.duration, in0: (clip as VideoClip).inPoint ?? 0, moved: false, others }
  }
  const onBarMove = (e: React.PointerEvent) => {
    const d = barDrag.current
    if (!d) return
    const dt = (e.clientX - d.x0) / pps
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return
    if (!d.moved) { d.moved = true; liveBegin() }
    const snapOn = !e.shiftKey
    liveApply(doc2 => {
      const c = doc2.clips.find(c => c.id === d.clipId)
      if (!c) return
      if (d.mode === 'move') {
        let ns = snap(d.start0 + dt, c.id, snapOn)
        const endSnap = snap(d.start0 + dt + d.dur0, c.id, snapOn) - d.dur0
        if (snapOn && Math.abs(endSnap - (d.start0 + dt)) < Math.abs(ns - (d.start0 + dt))) ns = endSnap
        c.start = Math.max(0, ns)
        const delta = c.start - d.start0
        for (const o of d.others) { const oc = doc2.clips.find(x => x.id === o.id); if (oc) oc.start = Math.max(0, o.start0 + delta) }
      } else if (d.mode === 'trimL') {
        let ns = snap(d.start0 + dt, c.id, snapOn)
        if (c.kind === 'video' || c.kind === 'audio') ns = Math.max(ns, d.start0 - d.in0 / Math.max(0.05, c.speed || 1))
        ns = Math.max(0, Math.min(ns, d.start0 + d.dur0 - 1 / fps))
        const delta = ns - d.start0
        c.start = ns
        c.duration = d.dur0 - delta
        if (c.kind === 'video' || c.kind === 'audio') (c as VideoClip).inPoint = Math.max(0, d.in0 + delta * (c.speed || 1))
        for (const k of c.keyframes) k.keyframes = k.keyframes.map(kf => ({ ...kf, time: kf.time - delta }))
      } else {
        let ne = snap(d.start0 + d.dur0 + dt, c.id, snapOn)
        if (c.kind === 'video' || c.kind === 'audio') {
          const a = doc2.assets.find(a => a.id === (c as VideoClip).assetId)
          if (a && a.duration > 0) ne = Math.min(ne, d.start0 + (a.duration - d.in0) / Math.max(0.05, c.speed || 1))
        }
        c.duration = Math.max(1 / fps, ne - d.start0)
      }
    })
  }
  const onBarUp = () => {
    if (barDrag.current?.moved) liveEnd()
    barDrag.current = null
  }

  // ---- keyframe drag ----
  const kfDrag = useRef<{ clipId: string; kfId: string; x0: number; t0: number; moved: boolean; ids: Map<string, number> } | null>(null)
  const onKfDown = (e: React.PointerEvent, clip: Clip, kf: Keyframe, siblings: string[] = []) => {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    if (!useEditorStore.getState().selectedClipIds.includes(clip.id)) select(clip.id)
    const st0 = useEditorStore.getState()
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    const alreadySel = st0.selectedKeyframeIds.includes(kf.id)
    if (additive || !alreadySel) selectKeyframe(kf.id, additive)
    // every keyframe that moves with this one: same-time siblings (x+y) + the selection
    const sel = new Set([...(additive || alreadySel ? useEditorStore.getState().selectedKeyframeIds : [kf.id]), ...siblings])
    const ids = new Map<string, number>()
    for (const c of doc.clips) {
      for (const k of c.keyframes) for (const x of k.keyframes) if (sel.has(x.id)) ids.set(x.id, x.time)
      for (const fx of c.effects) for (const kfs of Object.values(fx.paramKeyframes ?? {})) for (const x of kfs) if (sel.has(x.id)) ids.set(x.id, x.time)
    }
    kfDrag.current = { clipId: clip.id, kfId: kf.id, x0: e.clientX, t0: kf.time, moved: false, ids }
  }
  const onKfMove = (e: React.PointerEvent) => {
    const d = kfDrag.current
    if (!d) return
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return
    if (!d.moved) { d.moved = true; liveBegin() }
    const clip = doc.clips.find(c => c.id === d.clipId)
    if (!clip) return
    const abs = snap(clip.start + d.t0 + (e.clientX - d.x0) / pps, undefined, !e.shiftKey)
    const delta = Math.max(0, abs - clip.start) - d.t0
    liveApply(doc2 => {
      for (const c of doc2.clips) {
        for (const k of c.keyframes) {
          let touched = false
          for (const kf of k.keyframes) { const t0 = d.ids.get(kf.id); if (t0 !== undefined) { kf.time = Math.max(0, t0 + delta); touched = true } }
          if (touched) k.keyframes.sort((a, b) => a.time - b.time)
        }
        for (const fx of c.effects) for (const kfs of Object.values(fx.paramKeyframes ?? {})) {
          for (const kf of kfs) { const t0 = d.ids.get(kf.id); if (t0 !== undefined) kf.time = Math.max(0, t0 + delta) }
          kfs.sort((a, b) => a.time - b.time)
        }
      }
    })
  }
  const onKfUp = () => {
    if (kfDrag.current?.moved) liveEnd()
    else if (kfDrag.current) {
      // click on a keyframe moves the CTI there (handy on touch)
      const c = doc.clips.find(c => c.id === kfDrag.current!.clipId)
      if (c) { playbackEngine.pause(); playbackEngine.seek(c.start + kfDrag.current.t0) }
    }
    kfDrag.current = null
  }

  // ---- layer reorder (drag the name) ----
  const reorder = useRef<{ clipId: string; y0: number; active: boolean } | null>(null)
  const layerRowTops = useRef<{ id: string; top: number; index: number }[]>([])
  const onNameDown = (e: React.PointerEvent, clip: Clip) => {
    if (e.button !== 0 || renaming) return
    reorder.current = { clipId: clip.id, y0: e.clientY, active: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onNameMove = (e: React.PointerEvent) => {
    const r = reorder.current
    if (!r) return
    if (!r.active && Math.abs(e.clientY - r.y0) < 6) return
    r.active = true
    const sc = scrollRef.current
    if (!sc) return
    const y = e.clientY - sc.getBoundingClientRect().top + sc.scrollTop - RULER_H
    const tops = layerRowTops.current
    let idx = tops.length
    for (let i = 0; i < tops.length; i++) if (y < tops[i].top + ROW_H / 2) { idx = i; break }
    setDropLine(idx)
  }
  const onNameUp = () => {
    const r = reorder.current
    reorder.current = null
    if (r?.active && dropLine !== null) {
      const tops = layerRowTops.current
      const from = tops.findIndex(t => t.id === r.clipId)
      let to = dropLine
      if (from >= 0 && to > from) to -= 1
      const target = tops[Math.min(tops.length - 1, Math.max(0, to))]
      if (target) moveLayerTo(r.clipId, target.index - 1)
    }
    setDropLine(null)
  }

  // ---- drops from Project / Effects & Presets ----
  const onDragOver = (e: React.DragEvent) => {
    const t = e.dataTransfer.types
    if (t.includes('application/x-as-asset') || t.includes('application/x-as-effect') || t.includes('application/x-as-comp')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }
  }
  const onDrop = (e: React.DragEvent, clip?: Clip) => {
    const compId = e.dataTransfer.getData('application/x-as-comp')
    if (compId) { e.preventDefault(); e.stopPropagation(); addCompLayer(compId, snap(xToTime(e.clientX))); return }
    const assetId = e.dataTransfer.getData('application/x-as-asset')
    const fx = e.dataTransfer.getData('application/x-as-effect')
    if (fx) {
      e.preventDefault(); e.stopPropagation()
      const target = clip ?? doc.clips.find(c => c.id === selectedClipId)
      if (target) { applyEffectToClip(target.id, fx); select(target.id) }
      return
    }
    if (assetId) {
      e.preventDefault(); e.stopPropagation()
      const a = doc.assets.find(a => a.id === assetId)
      if (a) addAssetLayer(a, snap(xToTime(e.clientX)))
    }
  }

  // ---- values ----
  const writeEffectParam = (d: ProjectDoc, clipId: string, fxId: string, param: string, v: number) => {
    const c = d.clips.find(c => c.id === clipId)
    const fx = c?.effects.find(e => e.id === fxId)
    if (!c || !fx) return
    const kfs = fx.paramKeyframes?.[param]
    if (kfs && kfs.length) {
      const lt = Math.max(0, Math.min(c.duration, playbackEngine.currentTime - c.start))
      const ex = kfs.find(k => Math.abs(k.time - lt) < 1 / (fps * 2))
      if (ex) ex.value = v
      else { kfs.push({ id: uid('kf'), time: lt, value: v, easing: 'linear' }); kfs.sort((a, b) => a.time - b.time) }
    } else fx.params[param] = v
  }
  const fxStopwatch = (clipId: string, fxId: string, param: string) => {
    mutate(d => {
      const c = d.clips.find(c => c.id === clipId)
      const fx = c?.effects.find(e => e.id === fxId)
      if (!c || !fx) return
      fx.paramKeyframes = fx.paramKeyframes ?? {}
      const lt = Math.max(0, Math.min(c.duration, playbackEngine.currentTime - c.start))
      if (fx.paramKeyframes[param]?.length) {
        fx.params[param] = evalEffectParam(fx, param, lt)
        delete fx.paramKeyframes[param]
      } else fx.paramKeyframes[param] = [{ id: uid('kf'), time: lt, value: fx.params[param] ?? 0, easing: 'linear' }]
    })
  }
  const fxToggleKey = (clipId: string, fxId: string, param: string) => {
    mutate(d => {
      const c = d.clips.find(c => c.id === clipId)
      const fx = c?.effects.find(e => e.id === fxId)
      if (!c || !fx) return
      fx.paramKeyframes = fx.paramKeyframes ?? {}
      const lt = Math.max(0, Math.min(c.duration, playbackEngine.currentTime - c.start))
      const arr = fx.paramKeyframes[param] ?? (fx.paramKeyframes[param] = [])
      const ex = arr.findIndex(k => Math.abs(k.time - lt) < 1 / (fps * 2))
      if (ex >= 0) arr.splice(ex, 1)
      else { arr.push({ id: uid('kf'), time: lt, value: evalEffectParam(fx, param, lt), easing: 'linear' }); arr.sort((a, b) => a.time - b.time) }
    })
  }
  const volWrite = (d: ProjectDoc, clipId: string, v: number) => {
    const c = d.clips.find(c => c.id === clipId)
    if (!c) return
    if (isPropAnimated(c, 'volume')) writePropIn(d, c, 'volume', v)
    else if (c.kind === 'audio') (c as AudioClip).volume = v
    else {
      // video layers have no static volume field: a single key holds the level
      c.keyframes = c.keyframes.filter(k => k.property !== 'volume')
      c.keyframes.push({ property: 'volume', keyframes: [{ id: uid('kf'), time: 0, value: v, easing: 'linear' }] })
    }
  }

  // ---- layer switches ----
  const flip = (clipId: string, key: 'hidden' | 'muted' | 'solo' | 'locked' | 'shy' | 'threeD' | 'motionBlur') =>
    mutate(d => { const c = d.clips.find(c => c.id === clipId); if (c) (c as unknown as Record<string, boolean>)[key] = !(c as unknown as Record<string, boolean>)[key] })

  const depthPad = (depth: number) => 8 + depth * 14

  // pre-compute layer row tops for drag reorder
  {
    let y = 0
    const tops: { id: string; top: number; index: number }[] = []
    for (const r of rows) {
      if (r.kind === 'layer') tops.push({ id: r.clip.id, top: y, index: r.index })
      y += rowH(r)
    }
    layerRowTops.current = tops
  }
  const dropY = dropLine === null ? null : (layerRowTops.current[dropLine]?.top ?? rows.reduce((s, r) => s + rowH(r), 0))

  const ticks = useMemo(() => rulerTicks(duration, pps, fps), [duration, pps, fps])

  if (trackView) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <div className="h-6 shrink-0 flex items-center px-2 gap-2 bg-[#1f1f1f] border-b border-black text-[11px] text-zinc-400">
          <span>Track view</span>
          <button className="ae-vb-btn ml-auto" onClick={() => setTrackView(false)}><Rows3 size={12} /> Layer view</button>
        </div>
        <div className="flex-1 min-h-0"><TrackTimeline /></div>
      </div>
    )
  }

  return (
    <div className="aet relative flex flex-col h-full min-h-0 no-select" data-testid="timeline" onPointerDown={() => setFocus('timeline')}>
      {/* ---------- header: timecode, search, switches ---------- */}
      <div className="h-[38px] shrink-0 flex items-center gap-2 px-2 border-b border-black/70 bg-[#232323]">
        <div className="flex flex-col leading-none cursor-text" style={{ width: AV_W + NUM_W + 40 }} title="Click to go to a time"
          onClick={() => {
            const raw = window.prompt('Go to time (0:00:00:00, frames or 3.5s)', tcAE(playbackEngine.currentTime, fps))
            if (raw == null) return
            const t = parseTime(raw, fps)
            if (t !== null) { playbackEngine.pause(); playbackEngine.seek(t) }
          }}>
          <span ref={tcRef} className="ae-timecode text-[19px] font-light tracking-wide">0:00:00:00</span>
          <span ref={frameRef} className="text-[10px] text-zinc-500 mt-0.5 as-mono">00000</span>
        </div>
        <div className="relative w-44">
          <Search size={12} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input className="ginput w-full !pl-6 !py-0.5 !text-[12px]" placeholder="Search layers" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        {(doc.compStack?.length ?? 0) > 0 && (
          <div className="flex items-center gap-1 text-[11px] min-w-0 overflow-hidden">
            {(doc.compStack ?? []).map(id => {
              const pc = doc.precomps?.find(p => p.id === id)
              const nm = id === 'main' ? (pc?.name ?? doc.name) : pc?.name ?? id
              return <span key={id} className="flex items-center gap-1 shrink-0"><button className="text-zinc-400 hover:text-white hover:underline" onClick={() => openComp(id)}>{nm}</button><span className="text-zinc-600">▸</span></span>
            })}
            <span className="text-amber-400 truncate">{doc.compName}</span>
          </div>
        )}
        <div className="flex-1" />
        <CacheInfo />
        <button className="tb-btn" title="RAM Preview (0 / Numpad 0): render the work area into memory, then play it in real time" onClick={() => void playbackEngine.ramPreview()}><Zap size={14} /></button>
        <button className="tb-btn" data-on={doc.composition.motionBlur !== false ? '1' : '0'} title="Enable Motion Blur for all layers with the Motion Blur switch set"
          onClick={() => mutate(d => { d.composition.motionBlur = d.composition.motionBlur === false })}><MBIcon /></button>
        <button className="tb-btn" data-on={shyHidden ? '1' : '0'} title="Hide all layers with the Shy switch set" onClick={toggleShy}><Ghost size={14} /></button>
        <button className="tb-btn" data-on={graphMode ? '1' : '0'} title="Graph Editor (Shift+F3)" onClick={() => setGraphMode(!graphMode)}><LineChart size={14} /></button>
        <button className="tb-btn" title="Classic track view" onClick={() => setTrackView(true)}><Rows3 size={14} /></button>
      </div>

      {/* ---------- body ---------- */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-auto as-scroll relative"
        onPointerMove={e => { onBarMove(e); onKfMove(e); onWaMove(e); onNameMove(e) }}
        onPointerUp={() => { onBarUp(); onKfUp(); onWaUp(); onNameUp() }}
        onPointerCancel={() => { onBarUp(); onKfUp(); onWaUp(); onNameUp() }}
        onDragOver={onDragOver}
        onDrop={e => onDrop(e)}
        onWheel={e => {
          if (e.ctrlKey || e.metaKey || e.altKey) {
            e.preventDefault()
            const t = xToTime(e.clientX)
            const next = Math.max(2, Math.min(800, pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
            setPps(next)
            const sc = scrollRef.current
            if (sc) requestAnimationFrame(() => { sc.scrollLeft = Math.max(0, t * next - (e.clientX - sc.getBoundingClientRect().left - LW)) })
          }
        }}
      >
        <div style={{ width: LW + (graphMode ? 0 : contentW), minHeight: '100%' }} className="relative">
          {/* column header + ruler (sticky top) */}
          <div className="sticky top-0 z-30 flex" style={{ height: RULER_H }}>
            <div className="sticky left-0 z-10 aet-colh !h-full !items-end pb-1 shrink-0 bg-[#1f1f1f]" style={{ width: LW }}>
              <div className="flex items-center justify-around shrink-0 text-zinc-500" style={{ width: AV_W }} title="Video · Audio · Solo · Lock">
                <Eye size={12} /><Volume2 size={12} /><span className="w-2.5 h-2.5 rounded-full border border-zinc-500" /><Lock size={11} />
              </div>
              <div className="shrink-0 flex items-center gap-1 pl-1" style={{ width: NUM_W }}><span className="w-3 h-2 rounded-[1px] bg-zinc-500" />#</div>
              <div className="shrink-0 pl-1" style={{ width: NAME_W }}>Layer Name</div>
              <div className="shrink-0 flex items-center justify-around text-zinc-500" style={{ width: SW_W }} title="Shy · Effects · 3D Layer">
                <Ghost size={12} /><span className="italic font-serif text-[12px]">fx</span><MBIcon /><Box size={12} />
              </div>
              {showModes && <div className="shrink-0 flex" style={{ width: MODE_W }}><span className="w-[76px] pl-1">Mode</span><span className="pl-1">TrkMat</span></div>}
              <div className="shrink-0 pl-1 flex items-center gap-1" style={{ width: PARENT_W }}>Parent &amp; Link</div>
            </div>
            {!graphMode && (
              <div
                className="relative bg-[#1f1f1f] border-b border-black cursor-ew-resize"
                style={{ width: contentW, touchAction: 'none' }}
                onPointerDown={onRulerDown}
                onPointerMove={onRulerMove}
                onPointerUp={onRulerUp}
                onPointerCancel={onRulerUp}
              >
                <CacheBar pps={pps} />
                {/* work area bar */}
                <div className="absolute left-0 right-0 top-0 h-[9px] bg-[#1a1a1a]">
                  <div className="absolute top-[1px] h-[7px] bg-[#5b6574] hover:bg-[#6c7787] cursor-grab" style={{ left: wa.in * pps, width: Math.max(4, (wa.out - wa.in) * pps) }}
                    onPointerDown={onWaDown('both')} title="Work area (B / N)">
                    <div className="absolute left-0 top-0 h-full w-[6px] bg-[#8b97a8] cursor-col-resize" onPointerDown={onWaDown('in')} />
                    <div className="absolute right-0 top-0 h-full w-[6px] bg-[#8b97a8] cursor-col-resize" onPointerDown={onWaDown('out')} />
                  </div>
                </div>
                {ticks.map(({ t, major, label }) => (
                  <div key={t} className="absolute bottom-0 pointer-events-none" style={{ left: t * pps }}>
                    <div className={major ? 'w-px h-[7px] bg-zinc-500' : 'w-px h-[4px] bg-zinc-600'} />
                    {label && <span className="absolute bottom-[8px] -translate-x-1/2 text-[10px] text-zinc-400 whitespace-nowrap">{label}</span>}
                  </div>
                ))}
                {/* comp end shade */}
                <div className="absolute top-[9px] bottom-0 bg-black/30 pointer-events-none" style={{ left: compDur * pps, right: 0 }} />
                {doc.markers.map(m => (
                  <div key={m.id} className="absolute bottom-0 pointer-events-none" style={{ left: m.time * pps - 4 }} title={m.label}>
                    <div className="w-2 h-3" style={{ background: m.color, clipPath: 'polygon(0 0,100% 0,100% 65%,50% 100%,0 65%)' }} />
                  </div>
                ))}
                {/* CTI head */}
                <div ref={ctiHeadRef} className="absolute bottom-0 left-0 pointer-events-none z-10" style={{ width: 0 }}>
                  <div className="absolute -left-[6px] bottom-0 w-[13px] h-[14px]" style={{ background: 'var(--ae-cti)', clipPath: 'polygon(0 0,100% 0,100% 60%,50% 100%,0 60%)' }} />
                </div>
              </div>
            )}
          </div>

          {/* rows */}
          <div className="relative">
            {rows.map((r, i) => {
              const isLayer = r.kind === 'layer'
              const sel = r.clip.id === selectedClipId || selectedClipIds.includes(r.clip.id)
              const lab = labelOf(r.clip)
              return (
                <div key={`${r.kind}-${r.clip.id}-${i}-${r.kind === 'group' ? r.id : r.kind === 'prop' ? r.label : r.kind === 'expr' ? r.group : ''}`} className="flex" style={{ height: rowH(r) }}>
                  {/* left columns */}
                  <div
                    className={`sticky left-0 z-20 shrink-0 ${isLayer ? 'aet-row' : 'aet-prop'}`}
                    style={{ width: LW }}
                    data-sel={isLayer && sel ? '1' : '0'}
                    onPointerDown={e => {
                      if (e.ctrlKey || e.metaKey) { toggleSelect(r.clip.id); return }
                      if (e.shiftKey && r.kind === 'layer') {
                        const ids = layers.map(c => c.id)
                        const a = ids.indexOf(useEditorStore.getState().selectedClipId ?? r.clip.id), b = ids.indexOf(r.clip.id)
                        selectMany(ids.slice(Math.min(a, b), Math.max(a, b) + 1))
                        return
                      }
                      select(r.clip.id)
                    }}
                    onDragOver={onDragOver}
                    onDrop={e => onDrop(e, r.clip)}
                  >
                    {r.kind === 'layer' && (
                      <LayerCells
                        clip={r.clip} index={r.index} label={lab.color} showModes={showModes} layers={layers}
                        open={!!openMap[r.clip.id]} onTwirl={() => setOpen(r.clip.id, !openMap[r.clip.id])}
                        flip={flip} renaming={renaming === r.clip.id}
                        onRenameStart={() => setRenaming(r.clip.id)}
                        onRename={name => { setRenaming(null); if (name && name !== r.clip.name) mutate(d => { const c = d.clips.find(c => c.id === r.clip.id); if (c) c.name = name }) }}
                        onNameDown={e => onNameDown(e, r.clip)}
                        mutate={mutate}
                      />
                    )}
                    {r.kind === 'group' && (
                      <div className="flex items-center h-full w-full" style={{ paddingLeft: AV_W + NUM_W - 30 + depthPad(r.depth) }}>
                        <button className="aet-sw !w-4" onClick={e => { e.stopPropagation(); setGroupOpen(g => ({ ...g, [r.id]: !r.open })) }}>
                          {r.open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </button>
                        {r.fx && (
                          <button className="aet-box !w-[13px] !h-[13px] mr-1.5 text-[8px] italic font-serif" title="Effect on/off"
                            onClick={e => { e.stopPropagation(); mutate(d => { const fx = d.clips.find(c => c.id === r.clip.id)?.effects.find(f => f.id === r.fx!.id); if (fx) fx.enabled = !fx.enabled }) }}>
                            {r.fx.enabled ? 'fx' : ''}
                          </button>
                        )}
                        <span className={`text-[12px] ${r.fx && !r.fx.enabled ? 'text-zinc-500 line-through' : 'text-zinc-200'}`}>{r.label}</span>
                        {r.depth === 1 && r.label === 'Transform' && (
                          <button className="ml-3 text-[11px] text-amber-400 hover:underline" onClick={e => {
                            e.stopPropagation()
                            mutate(d => {
                              const c = d.clips.find(c => c.id === r.clip.id)
                              if (!c) return
                              c.x = 0; c.y = 0; c.scale = 1; c.rotation = 0; c.opacity = 1; c.anchorX = 0; c.anchorY = 0
                              c.keyframes = c.keyframes.filter(k => !['x', 'y', 'scale', 'rotation', 'opacity', 'anchorX', 'anchorY'].includes(k.property))
                            })
                          }}>Reset</button>
                        )}
                        {r.onDelete && <button className="ml-auto mr-2 aet-sw" title="Remove effect" onClick={e => { e.stopPropagation(); r.onDelete!() }}><Trash2 size={11} /></button>}
                      </div>
                    )}
                    {r.kind === 'expr' && (
                      <ExprCells clip={r.clip} group={r.group} pad={AV_W + NUM_W - 30 + depthPad(r.depth) + 22}
                        onChange={code => mutate(d => { const c = d.clips.find(c => c.id === r.clip.id); if (c) c.expressions = { ...(c.expressions ?? {}), [r.group]: code } })}
                        onRemove={() => mutate(d => { const c = d.clips.find(c => c.id === r.clip.id); if (!c) return; const ex = { ...(c.expressions ?? {}) }; delete ex[r.group]; c.expressions = Object.keys(ex).length ? ex : undefined })} />
                    )}
                    {r.kind === 'prop' && (
                      <PropCells
                        row={r} fps={fps} pad={AV_W + NUM_W - 30 + depthPad(r.depth)}
                        onStopwatch={(alt) => {
                          const p = r.props
                          if (alt && p.type === 'transform') {
                            // Alt+click stopwatch = add/remove expression (AE)
                            mutate(d => {
                              const c = d.clips.find(c => c.id === r.clip.id)
                              if (!c) return
                              const ex = { ...(c.expressions ?? {}) }
                              if (ex[p.key] !== undefined) delete ex[p.key]
                              else ex[p.key] = p.key === 'position' || p.key === 'rotation' ? 'wiggle(3, 25)' : 'value'
                              c.expressions = Object.keys(ex).length ? ex : undefined
                            })
                            return
                          }
                          if (p.type === 'transform') toggleStopwatch(r.clip.id, p.parts.map(x => x.p))
                          else if (p.type === 'effect') fxStopwatch(r.clip.id, p.fxId, p.param)
                          else toggleStopwatch(r.clip.id, ['volume'])
                        }}
                        onToggleKey={() => {
                          const p = r.props
                          if (p.type === 'transform') toggleKeyAtCTI(r.clip.id, p.parts.map(x => x.p))
                          else if (p.type === 'effect') fxToggleKey(r.clip.id, p.fxId, p.param)
                          else toggleKeyAtCTI(r.clip.id, ['volume'])
                        }}
                        onJump={dir => {
                          const p = r.props
                          if (p.type === 'transform') jumpKeyframe(dir, r.clip, p.parts.map(x => x.p))
                          else if (p.type === 'volume') jumpKeyframe(dir, r.clip, ['volume'])
                          else {
                            const fx = r.clip.effects.find(e => e.id === p.fxId)
                            const times = (fx?.paramKeyframes?.[p.param] ?? []).map(k => r.clip.start + k.time)
                            const t = playbackEngine.currentTime, eps = 1 / (fps * 2)
                            const cand = dir > 0 ? times.filter(x => x > t + eps).sort((a, b) => a - b)[0] : times.filter(x => x < t - eps).sort((a, b) => b - a)[0]
                            if (cand !== undefined) { playbackEngine.pause(); playbackEngine.seek(cand) }
                          }
                        }}
                        onLive={(phase, partIdx, v) => {
                          if (phase === 'begin') { liveBegin(); return }
                          if (phase === 'end') { liveEnd(); return }
                          const p = r.props
                          liveApply(d => {
                            const c = d.clips.find(c => c.id === r.clip.id)
                            if (!c) return
                            if (p.type === 'transform') writePropIn(d, c, p.parts[partIdx].p, v / p.parts[partIdx].mul)
                            else if (p.type === 'effect') writeEffectParam(d, r.clip.id, p.fxId, p.param, v)
                            else volWrite(d, r.clip.id, v / 100)
                          })
                        }}
                      />
                    )}
                  </div>

                  {/* right lane */}
                  {!graphMode && (
                    <div
                      className={`relative shrink-0 ${isLayer ? (sel ? 'bg-[#2b2b2b]' : 'bg-[#232323]') : 'bg-[#1e1e1e]'} border-b border-[#191919]`}
                      style={{ width: contentW }}
                      onPointerDown={e => { if (e.target === e.currentTarget) select(isLayer ? r.clip.id : r.clip.id) }}
                      onDragOver={onDragOver}
                      onDrop={e => onDrop(e, isLayer ? r.clip : undefined)}
                    >
                      {r.kind === 'layer' && (
                        <LayerBar clip={r.clip} pps={pps} color={lab.color} sel={sel} doc={doc} onDown={onBarDown} />
                      )}
                      {r.kind === 'prop' && (
                        <PropKeys row={r} pps={pps} selected={selectedKeyframeIds.length ? selectedKeyframeIds : selectedKeyframeId ? [selectedKeyframeId] : []} onDown={onKfDown} />
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {rows.length === 0 && (
              <div className="sticky left-0 py-10 text-center text-zinc-500 text-[12px]" style={{ width: Math.min(LW + 400, 900) }}>
                {doc.clips.length === 0 ? 'Drag footage from the Project panel here, or double-click it.  Layer ▸ New ▸ Solid / Text / Shape adds generated layers.' : 'No layers match the search.'}
              </div>
            )}

            {/* drop indicator for layer reorder */}
            {dropY !== null && <div className="absolute left-0 h-[2px] bg-amber-500 z-40 pointer-events-none" style={{ top: dropY - 1, width: LW }} />}

            {/* CTI line */}
            {!graphMode && (
              <div className="absolute top-0 bottom-0 pointer-events-none z-30" style={{ left: LW }}>
                <div ref={ctiRef} className="absolute top-0 bottom-0 w-px" style={{ background: 'var(--ae-cti)', minHeight: 2000 }} />
              </div>
            )}
          </div>
        </div>

      </div>


      {/* ---------- bottom bar ---------- */}
      <div className="h-6 shrink-0 flex items-center gap-2 px-2 bg-[#1f1f1f] border-t border-black text-[11px] text-zinc-400">
        <button className="hover:text-white whitespace-nowrap" onClick={() => setShowModes(m => !m)} title="F4">Toggle Switches / Modes</button>
        <div className="flex-1" />
        <button className="tb-btn !w-6 !h-5" title="Zoom out (-)" onClick={() => setPps(p => Math.max(2, p / 1.4))}><Mountain size={11} /></button>
        <input type="range" className="as-range !h-4 w-40" min={0} max={100} value={Math.round(100 * Math.log(pps / 2) / Math.log(400))}
          onChange={e => setPps(2 * Math.pow(400, +e.target.value / 100))} aria-label="Timeline zoom" />
        <button className="tb-btn !w-6 !h-5" title="Zoom in (=)" onClick={() => setPps(p => Math.min(800, p * 1.4))}><MountainSnow size={13} /></button>
      </div>

      {graphMode && <GraphOverlay left={LW} />}
    </div>
  )
}

/** Graph editor fills the time area (AE toggles it in place of the layer bars). */
function GraphOverlay({ left }: { left: number }) {
  return (
    <div className="absolute z-40 bg-[#1c1c1c] border-l border-black overflow-auto as-scroll" style={{ left, right: 0, top: 38, bottom: 24 }}>
      <GraphEditor />
    </div>
  )
}

// ------------------------------------------------------------------ cells

function LayerCells({ clip, index, label, showModes, layers, open, onTwirl, flip, renaming, onRenameStart, onRename, onNameDown, mutate }: {
  clip: Clip; index: number; label: string; showModes: boolean; layers: Clip[]; open: boolean; onTwirl: () => void
  flip: (id: string, k: 'hidden' | 'muted' | 'solo' | 'locked' | 'shy' | 'threeD' | 'motionBlur') => void
  renaming: boolean; onRenameStart: () => void; onRename: (n: string) => void
  onNameDown: (e: React.PointerEvent) => void
  mutate: (fn: (d: ProjectDoc) => void) => void
}) {
  const hasAudio = clip.kind === 'audio' || clip.kind === 'video'
  const hasVideo = clip.kind !== 'audio'
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  const above = layers[index - 2]
  const descendants = new Set<string>()
  const collect = (id: string) => { for (const c of layers) if (c.parentId === id && !descendants.has(c.id)) { descendants.add(c.id); collect(c.id) } }
  collect(clip.id)
  return (
    <div className="flex items-center h-full w-full">
      <div className="flex items-center shrink-0" style={{ width: AV_W }} onPointerDown={stop}>
        <button className="aet-sw" data-on={!clip.hidden ? '1' : '0'} title="Video (eye)" onClick={() => hasVideo && flip(clip.id, 'hidden')}>{hasVideo ? (clip.hidden ? <EyeOff size={12} className="opacity-40" /> : <Eye size={12} />) : null}</button>
        <button className="aet-sw" data-on={!clip.muted ? '1' : '0'} title="Audio" onClick={() => hasAudio && flip(clip.id, 'muted')}>{hasAudio ? <Volume2 size={12} className={clip.muted ? 'opacity-25' : ''} /> : null}</button>
        <button className="aet-sw" title="Solo" onClick={() => flip(clip.id, 'solo')}><span className={`w-[9px] h-[9px] rounded-full border ${clip.solo ? 'bg-zinc-200 border-zinc-200' : 'border-zinc-600'}`} /></button>
        <button className="aet-sw" title="Lock" onClick={() => flip(clip.id, 'locked')}>{clip.locked ? <Lock size={11} className="text-zinc-200" /> : <span className="w-[11px]" />}</button>
      </div>
      <div className="flex items-center shrink-0 gap-1" style={{ width: NUM_W }}>
        <button className="aet-sw !w-4" onPointerDown={stop} onClick={onTwirl} aria-label="Twirl">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
        <button
          className="w-[11px] h-[11px] rounded-[1px] border border-black/60 shrink-0" style={{ background: label }} title="Label color (click to cycle)"
          onPointerDown={stop}
          onClick={() => mutate(d => { const c = d.clips.find(c => c.id === clip.id); if (c) c.label = ((c.label ?? defaultLabel(c.kind)) % (LABEL_COLORS.length - 1)) + 1 })}
        />
        <span className="text-[11px] text-zinc-400 w-4 text-right">{index}</span>
      </div>
      <div className="shrink-0 min-w-0 flex items-center gap-1 pl-1 pr-1 h-full cursor-grab" style={{ width: NAME_W }} onPointerDown={onNameDown} onDoubleClick={() => clip.kind === 'precomp' ? openComp(clip.precompId) : onRenameStart()} title={clip.kind === 'precomp' ? 'Double-click to open the pre-comp' : 'Drag to reorder · double-click to rename'}>
        <KindIcon clip={clip} />
        {renaming ? (
          <input autoFocus defaultValue={clip.name} className="aet-input flex-1 min-w-0" onPointerDown={stop}
            onKeyDown={e => { if (e.key === 'Enter') onRename((e.target as HTMLInputElement).value.trim()); if (e.key === 'Escape') onRename(clip.name) }}
            onBlur={e => onRename(e.target.value.trim())} />
        ) : (
          <span className={`aet-name truncate text-[12px] ${clip.hidden ? 'text-zinc-500' : 'text-zinc-200'}`}>{clip.name}</span>
        )}
      </div>
      <div className="flex items-center justify-around shrink-0" style={{ width: SW_W }} onPointerDown={stop}>
        <button className="aet-box" title="Shy" onClick={() => flip(clip.id, 'shy')}>{clip.shy ? <Ghost size={9} /> : null}</button>
        <button className="aet-box text-[9px] italic font-serif" title="Effects on/off" disabled={clip.effects.length === 0}
          onClick={() => mutate(d => { const c = d.clips.find(c => c.id === clip.id); if (!c) return; const on = c.effects.some(e => e.enabled); for (const e of c.effects) e.enabled = !on })}>
          {clip.effects.length > 0 ? (clip.effects.some(e => e.enabled) ? 'fx' : '') : ''}
        </button>
        <button className="aet-box" title="Motion Blur" disabled={!hasVideo} onClick={() => flip(clip.id, 'motionBlur')}>{clip.motionBlur ? <MBIcon /> : null}</button>
        <button className="aet-box" title="3D Layer" disabled={!hasVideo} onClick={() => flip(clip.id, 'threeD')}>{clip.threeD ? <Box size={9} /> : null}</button>
      </div>
      {showModes && (
        <div className="flex items-center shrink-0 gap-1 pl-1" style={{ width: MODE_W }} onPointerDown={stop}>
          <select className="aet-input w-[72px]" value={clip.blendMode} disabled={!hasVideo}
            onChange={e => mutate(d => { const c = d.clips.find(c => c.id === clip.id); if (c) c.blendMode = e.target.value as BlendMode })}>
            {BLEND_MODES.map(m => <option key={m} value={m}>{m[0].toUpperCase() + m.slice(1)}</option>)}
          </select>
          <select className="aet-input w-[60px]" value={clip.trackMatte?.mode ?? 'none'} disabled={!hasVideo || !above}
            title={above ? `Matte source: ${above.name}` : 'Needs a layer above'}
            onChange={e => mutate(d => {
              const c = d.clips.find(c => c.id === clip.id)
              if (!c) return
              const v = e.target.value
              c.trackMatte = v === 'none' || !above ? null : { sourceClipId: above.id, mode: v as 'alpha' | 'alphaInv' | 'luma' | 'lumaInv' }
            })}>
            <option value="none">None</option>
            <option value="alpha">Alpha</option>
            <option value="alphaInv">Alpha Inv</option>
            <option value="luma">Luma</option>
            <option value="lumaInv">Luma Inv</option>
          </select>
        </div>
      )}
      <div className="flex items-center shrink-0 pl-1 pr-1" style={{ width: PARENT_W }} onPointerDown={stop}>
        <select className="aet-input w-full" value={clip.parentId ?? ''} disabled={clip.kind === 'audio'}
          onChange={e => mutate(d => { const c = d.clips.find(c => c.id === clip.id); if (c) c.parentId = e.target.value || null })}>
          <option value="">None</option>
          {layers.map((l, i) => (l.id !== clip.id && !descendants.has(l.id) && l.kind !== 'audio') ? <option key={l.id} value={l.id}>{i + 1}. {l.name}</option> : null)}
        </select>
      </div>
    </div>
  )
}

function KindIcon({ clip }: { clip: Clip }) {
  const t: Record<string, string> = { video: '▶', image: '▣', audio: '♪', text: 'T', solid: '■', shape: '★', null: '□', camera: '◉', adjustment: '◐', precomp: '⧉' }
  return <span className="w-3.5 text-center text-[10px] text-zinc-400 shrink-0 font-bold">{t[clip.kind] ?? '•'}</span>
}

function PropCells({ row, fps, pad, onStopwatch, onToggleKey, onJump, onLive }: {
  row: Extract<Row, { kind: 'prop' }>; fps: number; pad: number
  onStopwatch: (alt: boolean) => void; onToggleKey: () => void; onJump: (dir: -1 | 1) => void
  onLive: (phase: 'begin' | 'move' | 'end', part: number, v: number) => void
}) {
  const clip = row.clip
  const p = row.props
  // re-render on CTI changes so values track the playhead (throttled)
  const [t, setT] = useState(playbackEngine.currentTime)
  useEffect(() => playbackEngine.subscribeThrottled(setT, 90), [])
  const lt = Math.max(0, Math.min(clip.duration, t - clip.start))
  let animated = false, onKey = false
  const values: { v: number; min: number; max: number; step: number; unit?: string }[] = []
  const tol = 1 / (fps * 2)
  if (p.type === 'transform') {
    animated = p.parts.some(x => isPropAnimated(clip, x.p))
    onKey = p.parts.some(x => clip.keyframes.find(k => k.property === x.p)?.keyframes.some(kf => Math.abs(kf.time - lt) < tol))
    for (const x of p.parts) values.push({ v: evalProperty(clip, x.p, lt) * x.mul, min: x.min, max: x.max, step: x.step, unit: x.unit })
  } else if (p.type === 'effect') {
    const fx = clip.effects.find(e => e.id === p.fxId)
    const kfs = fx?.paramKeyframes?.[p.param] ?? []
    animated = kfs.length > 0
    onKey = kfs.some(kf => Math.abs(kf.time - lt) < tol)
    values.push({ v: fx ? evalEffectParam(fx, p.param, lt) : 0, min: p.min, max: p.max, step: p.step })
  } else {
    animated = isPropAnimated(clip, 'volume')
    onKey = !!clip.keyframes.find(k => k.property === 'volume')?.keyframes.some(kf => Math.abs(kf.time - lt) < tol)
    const base = clip.kind === 'audio' ? (clip as AudioClip).volume : 1
    values.push({ v: (animated ? evalProperty(clip, 'volume', lt) : base) * 100, min: 0, max: 400, step: 1, unit: '%' })
  }
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  return (
    <div className="flex items-center h-full w-full">
      {/* keyframe navigator lives in the A/V column, like AE */}
      <div className="absolute left-0 flex items-center justify-center" style={{ width: AV_W }} onPointerDown={stop}>
        {animated && (
          <>
            <button className="aet-sw !w-4 text-[9px]" onClick={() => onJump(-1)} title="Previous keyframe">◀</button>
            <button className="aet-sw !w-4" onClick={onToggleKey} title="Add/remove keyframe at CTI">
              <span className="w-[8px] h-[8px] rotate-45 border border-zinc-300" style={{ background: onKey ? '#d4d4d4' : 'transparent' }} />
            </button>
            <button className="aet-sw !w-4 text-[9px]" onClick={() => onJump(1)} title="Next keyframe">▶</button>
          </>
        )}
      </div>
      <div className="flex items-center gap-1 min-w-0" style={{ paddingLeft: pad }}>
        <button className="aet-sw !w-5" data-on={animated ? '1' : '0'} onPointerDown={stop} onClick={e => onStopwatch(e.altKey)} title="Time-Vary Stopwatch — Alt+click adds an expression">
          <Timer size={12} className={animated ? 'text-amber-400' : ''} />
        </button>
        <span className="text-[12px] text-zinc-300 whitespace-nowrap">{row.label}</span>
        <span className="ml-3 flex items-center gap-1.5" onPointerDown={stop}>
          {values.map((v, i) => (
            <span key={i} className="flex items-center">
              <ScrubValue value={v.v} min={v.min} max={v.max} step={v.step} onLive={(ph, nv) => onLive(ph, i, nv)} expr={p.type === 'transform' && clip.expressions?.[p.key] !== undefined} />
              {v.unit && <span className="text-zinc-500 text-[11px] ml-px">{v.unit}</span>}
              {i < values.length - 1 && <span className="text-zinc-500">,</span>}
            </span>
          ))}
        </span>
      </div>
    </div>
  )
}

/** AE blue scrubbable value: drag horizontally to change, click to type. */
function ScrubValue({ value, min, max, step, onLive, expr }: {
  value: number; min: number; max: number; step: number; expr?: boolean
  onLive: (phase: 'begin' | 'move' | 'end', v: number) => void
}) {
  const [edit, setEdit] = useState(false)
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null)
  const dec = step >= 1 ? 1 : step >= 0.1 ? 1 : 2
  const clamp = (v: number) => Math.max(min, Math.min(max, v))
  const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(dec))
  if (edit) {
    return (
      <input autoFocus defaultValue={fmt(value)} inputMode="decimal" className="aet-input w-16"
        onKeyDown={e => {
          if (e.key === 'Enter') { const n = parseFloat((e.target as HTMLInputElement).value.replace(',', '.')); if (!isNaN(n)) { onLive('begin', 0); onLive('move', clamp(n)); onLive('end', 0) } setEdit(false) }
          if (e.key === 'Escape') setEdit(false)
        }}
        onBlur={e => { const n = parseFloat(e.target.value.replace(',', '.')); if (!isNaN(n) && Math.abs(n - value) > 1e-9) { onLive('begin', 0); onLive('move', clamp(n)); onLive('end', 0) } setEdit(false) }} />
    )
  }
  return (
    <span
      className={`aet-value text-[12px] select-none touch-none px-[1px] ${expr ? '!text-[#e0605c]' : ''}`}
      onPointerDown={e => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, v: value, moved: false } }}
      onPointerMove={e => {
        const d = drag.current
        if (!d) return
        const dx = e.clientX - d.x
        if (!d.moved && Math.abs(dx) < 3) return
        if (!d.moved) { d.moved = true; onLive('begin', 0) }
        const mul = e.shiftKey ? 10 : e.ctrlKey || e.metaKey ? 0.1 : 1
        onLive('move', clamp(d.v + dx * step * mul * (step >= 1 ? 1 : 2)))
      }}
      onPointerUp={() => { const d = drag.current; drag.current = null; if (d?.moved) onLive('end', 0); else setEdit(true) }}
      onPointerCancel={() => { if (drag.current?.moved) onLive('end', 0); drag.current = null }}
    >{fmt(value)}</span>
  )
}

function LayerBar({ clip, pps, color, sel, doc, onDown }: {
  clip: Clip; pps: number; color: string; sel: boolean; doc: ProjectDoc
  onDown: (e: React.PointerEvent, clip: Clip, mode: 'move' | 'trimL' | 'trimR') => void
}) {
  const left = clip.start * pps
  const width = Math.max(3, clip.duration * pps)
  // AE draws the possible (untrimmed) source range faintly for footage
  let srcL = 0, srcW = 0
  if (clip.kind === 'video' || clip.kind === 'audio') {
    const a = doc.assets.find(a => a.id === (clip as VideoClip).assetId)
    if (a && a.duration > 0 && !clip.timeRemap) {
      const sp = Math.max(0.05, clip.speed || 1)
      srcL = (clip.start - (clip as VideoClip).inPoint / sp) * pps
      srcW = (a.duration / sp) * pps
    }
  }
  const bg = sel ? hexShade(color, 1.08) : hexShade(color, 0.78)
  return (
    <>
      {srcW > 0 && <div className="absolute top-[6px] bottom-[6px] bg-white/[0.04] pointer-events-none" style={{ left: srcL, width: srcW }} />}
      <div
        className="aet-bar"
        data-sel={sel ? '1' : '0'}
        style={{ left, width, background: bg, opacity: clip.hidden ? 0.45 : 1, cursor: clip.locked ? 'not-allowed' : 'grab' }}
        onPointerDown={e => onDown(e, clip, 'move')}
        onDoubleClick={() => { if (clip.kind === 'precomp') openComp(clip.precompId) }}
        title={clip.kind === 'precomp' ? `${clip.name} — double-click to open` : clip.name}
      >
        {width > 60 && <span className="absolute left-1.5 top-0 bottom-0 flex items-center text-[10px] text-black/70 font-medium truncate pointer-events-none" style={{ maxWidth: width - 12 }}>{clip.name}</span>}
        {(clip.speed !== 1 || clip.timeRemap) && width > 40 && <span className="absolute right-2 top-0 bottom-0 flex items-center text-[9px] text-black/70 pointer-events-none">{(clip.timeRemap ? clip.timeRemap.sourceDuration / clip.duration : clip.speed).toFixed(2)}x</span>}
        <div className="absolute left-0 top-0 bottom-0 w-[6px] cursor-col-resize" onPointerDown={e => onDown(e, clip, 'trimL')} />
        <div className="absolute right-0 top-0 bottom-0 w-[6px] cursor-col-resize" onPointerDown={e => onDown(e, clip, 'trimR')} />
      </div>
    </>
  )
}

function PropKeys({ row, pps, selected, onDown }: {
  row: Extract<Row, { kind: 'prop' }>; pps: number; selected: string[]
  onDown: (e: React.PointerEvent, clip: Clip, kf: Keyframe, siblings: string[]) => void
}) {
  const clip = row.clip
  const p = row.props
  // merged keys: Position shows x+y keys at one time as ONE diamond (they move together)
  const groups: { kf: Keyframe; ids: string[] }[] = []
  const add = (kf: Keyframe) => {
    const g = groups.find(g => Math.abs(g.kf.time - kf.time) < 1e-4)
    if (g) g.ids.push(kf.id); else groups.push({ kf, ids: [kf.id] })
  }
  if (p.type === 'transform') {
    for (const part of p.parts) for (const kf of clip.keyframes.find(k => k.property === part.p)?.keyframes ?? []) add(kf)
  } else if (p.type === 'effect') (clip.effects.find(e => e.id === p.fxId)?.paramKeyframes?.[p.param] ?? []).forEach(add)
  else (clip.keyframes.find(k => k.property === 'volume')?.keyframes ?? []).forEach(add)
  return (
    <>
      <div className="absolute top-[9px] h-px bg-white/5 pointer-events-none" style={{ left: clip.start * pps, width: clip.duration * pps }} />
      {groups.map(({ kf, ids }) => {
        const ease = kf.easing === 'linear' ? 'linear' : kf.easing === 'hold' ? 'hold' : 'ease'
        const isSel = ids.some(id => selected.includes(id))
        return (
          <div key={kf.id} className="aet-kf" data-ease={ease} data-sel={isSel ? '1' : '0'}
            style={{ left: (clip.start + kf.time) * pps }}
            onPointerDown={e => onDown(e, clip, kf, ids)}
            title={`${kf.easing} · ${kf.time.toFixed(2)}s — Shift+click: add to selection · Ctrl+C / Ctrl+V`} />
        )
      })}
    </>
  )
}

function rulerTicks(duration: number, pps: number, fps: number): { t: number; major: boolean; label: string | null }[] {
  // choose a label spacing that keeps ~80px between labels
  const candidates = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
  const labelStep = candidates.find(s => s * pps >= 70) ?? 600
  const minor = labelStep / (labelStep >= 1 ? (labelStep === 2 || labelStep === 10 ? 2 : 5) : Math.max(1, Math.round(labelStep * fps)))
  const out: { t: number; major: boolean; label: string | null }[] = []
  const end = duration + labelStep
  const nMinor = Math.min(4000, Math.ceil(end / minor))
  for (let i = 0; i <= nMinor; i++) {
    const t = Math.round(i * minor * 1e6) / 1e6
    const isLabel = Math.abs(t / labelStep - Math.round(t / labelStep)) < 1e-6
    let label: string | null = null
    if (isLabel) {
      if (labelStep < 1) {
        const s = Math.floor(t + 1e-6), f = Math.round((t - s) * fps)
        label = f === 0 ? `${String(s).padStart(2, '0')}s` : `${f}f`
      } else {
        const s = Math.round(t)
        label = s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${String(s).padStart(2, '0')}s`
      }
    }
    out.push({ t, major: isLabel, label })
  }
  return out
}
