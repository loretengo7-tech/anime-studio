'use client'
/**
 * ANIME STUDIO — Speed panel: velocity presets, custom curves, Twixtor-style interpolation
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { VideoClip, AudioClip } from '@/lib/engine/types'
import { useEditorStore } from '@/lib/store/editorStore'
import { playbackEngine } from '@/lib/engine/playback'
import { VELOCITY_PRESETS, clipAverageSpeed, clipSourceTime, generateVelocityPreset } from '@/lib/engine/speed'
import { buildInterpSession, getInterpSession, disposeInterpSession } from '@/lib/engine/interpolation'
import type { InterpQuality } from '@/lib/engine/interpolation'
import { SectionTitle, SliderRow, Row, formatNum } from './ui-bits'
import { Sparkles, Loader2, Trash2, Gauge, Film } from 'lucide-react'

const QUALITY_META: Record<InterpQuality, { label: string; detail: string }> = {
  fast: { label: 'Fast', detail: '384px analysis · 3 pyramid levels · quick passes' },
  balanced: { label: 'Balanced', detail: '512px analysis · 4 levels · recommended' },
  quality: { label: 'Quality', detail: '640px analysis · 5 levels · 16 HS iterations (heavier)' },
}

export function SpeedPanel() {
  const doc = useEditorStore(s => s.doc)
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const mutate = useEditorStore(s => s.mutate)
  const toast = useEditorStore(s => s.toast)
  const upsertJob = useEditorStore(s => s.upsertJob)
  const clip = doc.clips.find(c => c.id === selectedClipId) as VideoClip | AudioClip | undefined
  const editable = !!clip && (clip.kind === 'video' || clip.kind === 'audio')
  const [interpolating, setInterpolating] = useState(false)
  const [interpMsg, setInterpMsg] = useState('')
  const [interpProgress, setInterpProgress] = useState(0)
  const [quality, setQuality] = useState<InterpQuality>('balanced')
  const [sampleFps, setSampleFps] = useState(24)
  const session = clip && clip.kind === 'video' ? getInterpSession(clip.id) : null
  const interpActive = !!session && session.status === 'ready'

  const speed = clip ? clipAverageSpeed(clip) : 1
  const [localSpeed, setLocalSpeed] = useState(speed)
  useEffect(() => { if (clip) setLocalSpeed(clipAverageSpeed(clip)) }, [clip?.id, clip?.speed, clip?.timeRemap])

  // velocity curve preview canvas (declared before early return to keep hook order stable)
  const curveRef = useRef<HTMLCanvasElement>(null)
  const remap = clip?.timeRemap ?? null
  useEffect(() => {
    const canvas = curveRef.current
    if (!canvas || !clip || !remap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width = Math.max(300, canvas.clientWidth * 2)
    const h = canvas.height = 160
    ctx.fillStyle = 'rgba(10,10,16,0.9)'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    for (let i = 0; i <= 4; i++) {
      const y = (i / 4) * (h - 20) + 10
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()
    }
    ctx.strokeStyle = '#f59e0b'
    ctx.lineWidth = 3
    ctx.beginPath()
    const N = 120
    for (let i = 0; i <= N; i++) {
      const u = i / N
      const v = clipSourceTime(clip, u * clip.duration) - (clip as VideoClip).inPoint
      const nv = remap.sourceDuration > 0 ? Math.min(1, Math.max(0, v / remap.sourceDuration)) : u
      const x = u * w
      const y = h - 10 - nv * (h - 20)
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.fillStyle = '#fff'
    for (const p of remap.points) {
      ctx.beginPath()
      ctx.arc(p.u * w, h - 10 - p.v * (h - 20), 5, 0, Math.PI * 2)
      ctx.fill()
    }
  }, [remap, clip])

  const setSpeed = (v: number) => {
    if (!clip) return
    setLocalSpeed(v)
    mutate(d => {
      const c = d.clips.find(c => c.id === clip.id)
      if (c) { c.speed = v; c.timeRemap = null }
    })
  }

  const applyPreset = (key: string) => {
    if (!clip) return
    mutate(d => {
      const c = d.clips.find(c => c.id === clip.id)
      if (!c) return
      const used = c.duration * (c.timeRemap ? c.timeRemap.sourceDuration / c.duration : c.speed)
      c.timeRemap = generateVelocityPreset(key, used, 1)
    })
    toast({ kind: 'success', title: `${VELOCITY_PRESETS[key].label} applied`, detail: 'Playhead scrub to see the ramp' })
  }

  const clearRemap = () => {
    if (!clip) return
    mutate(d => {
      const c = d.clips.find(c => c.id === clip.id)
      if (c) c.timeRemap = null
    })
  }

  const toggleInterpolation = async () => {
    if (!clip || clip.kind !== 'video') return
    const vc = clip as VideoClip
    const existing = getInterpSession(vc.id)
    if (existing) {
      disposeInterpSession(vc.id)
      setInterpMsg('')
      toast({ kind: 'info', title: 'Interpolation disabled for this clip' })
      return
    }
    setInterpolating(true)
    setInterpProgress(0)
    const usedSource = vc.duration * (vc.timeRemap ? vc.timeRemap.sourceDuration / vc.duration : vc.speed)
    try {
      await buildInterpSession(vc, usedSource, sampleFps, p => {
        setInterpProgress(p.progress)
        setInterpMsg(p.message)
        upsertJob({ id: `interp-${vc.id}`, kind: 'interp', label: `Interpolate ${vc.name}`, status: 'running', progress: p.progress, message: p.message })
      }, quality)
      upsertJob({ id: `interp-${vc.id}`, kind: 'interp', label: `Interpolate ${vc.name}`, status: 'done', progress: 1, message: 'Motion interpolation ready' })
      const s = getInterpSession(vc.id)
      toast({
        kind: 'success',
        title: 'Interpolation engine ready',
        detail: `${s?.engine === 'gpu' ? 'GPU Horn–Schunck' : 'CPU fallback'} · ${s?.frames.length ?? 0} analyzed frames — preview now synthesizes in-between frames`,
      })
    } catch (e) {
      upsertJob({ id: `interp-${vc.id}`, kind: 'interp', label: `Interpolate ${vc.name}`, status: 'error', progress: 0, message: e instanceof Error ? e.message : String(e) })
      toast({ kind: 'error', title: 'Interpolation failed', detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setInterpolating(false)
    }
  }

  const sourceUsage = useMemo(() => {
    if (!clip) return 0
    return clip.duration * (clip.timeRemap ? clip.timeRemap.sourceDuration / clip.duration : clip.speed)
  }, [clip])

  if (!editable) {
    return <div className="p-4 text-xs text-zinc-500">Select a video or audio clip to edit its speed / velocity.</div>
  }

  return (
    <div className="p-3 pb-10">
      <SectionTitle>Speed</SectionTitle>
      <SliderRow label="Constant speed" value={localSpeed} min={0.1} max={8} step={0.05} onChange={setSpeed} unit="x" />
      <div className="text-[10px] text-zinc-500 mb-1">
        Timeline duration stays fixed; source usage = {sourceUsage.toFixed(2)}s of footage.
      </div>
      {clip.kind === 'audio' && (
        <p className="text-[10px] text-amber-500/80 mb-2">Audio uses playbackRate — very slow speeds will pitch/quality-shift (WebAudio preservesPitch on most browsers).</p>
      )}

      <SectionTitle>Velocity presets</SectionTitle>
      <div className="grid grid-cols-2 gap-2">
        {Object.entries(VELOCITY_PRESETS).map(([key, p]) => (
          <button key={key} className="text-left p-2.5 rounded-xl glass-soft active:bg-white/10" onClick={() => applyPreset(key)}>
            <div className="text-xs text-zinc-100 font-medium">{p.label}</div>
            <div className="text-[10px] text-zinc-500 mt-0.5">{p.description}</div>
          </button>
        ))}
      </div>

      {clip.timeRemap && (
        <>
          <SectionTitle right={<button className="text-[10px] text-red-400 flex items-center gap-1" onClick={clearRemap}><Trash2 size={10} /> clear</button>}>Source-time curve (velocity)</SectionTitle>
          <canvas ref={curveRef} className="w-full rounded-xl glass-inset" style={{ height: 160 }} />
          <p className="text-[10px] text-zinc-600 mt-1">X = clip time, Y = source position. Steep slope = fast. Flat = freeze. The AI can also set custom curves.</p>
        </>
      )}

      {clip.kind === 'video' && (
        <>
          <SectionTitle right={interpActive ? (
            <span className="text-[10px] text-emerald-400 flex items-center gap-1"><Gauge size={10} /> {session?.engine === 'gpu' ? 'GPU flow' : 'CPU flow'} · {session?.frames.length}f</span>
          ) : undefined}>
            <Film size={11} className="inline mr-1 text-violet-400" /> Smooth motion (frame interpolation)
          </SectionTitle>

          {/* quality tier */}
          <Row label="Quality">
            <div className="flex-1 grid grid-cols-3 gap-1.5">
              {(Object.keys(QUALITY_META) as InterpQuality[]).map(q => (
                <button
                  key={q}
                  className={`py-2 rounded-lg text-[11px] ${quality === q ? 'glass-accent text-amber-300' : 'gbtn text-zinc-400'}`}
                  onClick={() => setQuality(q)}
                >
                  {QUALITY_META[q].label}
                </button>
              ))}
            </div>
          </Row>
          <div className="text-[10px] text-zinc-600 mb-1">{QUALITY_META[quality].detail}</div>
          <SliderRow label="Sample rate" value={sampleFps} min={12} max={30} step={1} onChange={setSampleFps} unit=" fps" />

          <div className={`mt-2 rounded-xl border p-3 ${interpActive ? 'glass-accent' : 'glass-soft border-white/8'}`}>
            <div className="flex items-center gap-2">
              <Sparkles size={14} className={interpActive ? 'text-emerald-400' : 'text-violet-400'} />
              <div className="flex-1 text-xs text-zinc-200">
                {interpActive ? 'Smooth motion ACTIVE on this clip' : 'Dense GPU optical flow + occlusion-aware warping'}
              </div>
              <button
                className={`text-[11px] px-3 py-1.5 rounded-lg font-medium flex items-center gap-1 ${interpActive ? 'gbtn glass-danger text-red-300' : 'gbtn gbtn-violet'}`}
                onClick={() => void toggleInterpolation()}
                disabled={interpolating}
              >
                {interpolating && <Loader2 size={11} className="animate-spin" />}
                {interpolating ? 'Analyzing…' : interpActive ? 'Disable' : 'Enable'}
              </button>
            </div>
            {interpolating && (
              <div className="mt-2">
                <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-all" style={{ width: `${Math.round(interpProgress * 100)}%` }} />
                </div>
                <div className="text-[10px] text-zinc-500 mt-1">{interpMsg}</div>
              </div>
            )}
            <p className="text-[10px] text-zinc-600 mt-2">
              Real pyramidal Horn–Schunck optical flow (forward + backward) with occlusion checks and bidirectional GPU warping. Honest note: dramatically smoother than frame blending, but it is motion interpolation — not neural Twixtor/RIFE quality. No cloud model claims.
            </p>
          </div>
        </>
      )}
    </div>
  )
}

export function formatSpeed(n: number): string {
  return formatNum(n)
}
