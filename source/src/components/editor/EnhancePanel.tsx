'use client'
/**
 * ANIME STUDIO — Enhancement panel (Topaz-style engine)
 * Presets + custom params, interactive before/after drag slider.
 */
import { useMemo, useRef, useState } from 'react'
import { useEditorStore } from '@/lib/store/editorStore'
import { uid } from '@/lib/engine/types'
import { enhanceFramePreview, ENHANCE_PRESETS } from '@/lib/engine/enhance'
import type { EnhancePreset, EnhanceParams } from '@/lib/engine/enhance'
import type { VideoClip, AudioClip } from '@/lib/engine/types'
import { SectionTitle, Row, SliderRow } from './ui-bits'
import { Loader2, Sparkles, MoveHorizontal, Wand2 } from 'lucide-react'

const PARAM_META: { key: keyof EnhanceParams; label: string; max: number; note: string }[] = [
  { key: 'denoise', label: 'Denoise', max: 1, note: 'edge-aware bilateral noise reduction' },
  { key: 'deblock', label: 'Deblock', max: 1, note: 'flat-area compression artifact removal' },
  { key: 'sharpen', label: 'Line sharpen', max: 1, note: 'edge-directed, protects flat areas' },
  { key: 'linePreserve', label: 'Line protect', max: 1, note: 'keep anime ink lines clean' },
  { key: 'detail', label: 'Detail recon', max: 1, note: 'high-frequency reinjection' },
]

export function EnhancePanel() {
  const doc = useEditorStore(s => s.doc)
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const toast = useEditorStore(s => s.toast)
  const clip = doc.clips.find(c => c.id === selectedClipId) as VideoClip | AudioClip | undefined
  const videoClip = clip && clip.kind === 'video' ? (clip as VideoClip) : undefined
  const asset = videoClip ? doc.assets.find(a => a.id === videoClip.assetId) : doc.assets.find(a => a.kind === 'video')
  const [preset, setPreset] = useState<EnhancePreset>('anime_hd')
  const [custom, setCustom] = useState<Partial<EnhanceParams>>({})
  const [busy, setBusy] = useState(false)
  const [split, setSplit] = useState(0.5)
  const [result, setResult] = useState<{ before: string; after: string } | null>(null)
  const [frameTime, setFrameTime] = useState(1)

  const params = useMemo<EnhanceParams>(() => ({
    ...ENHANCE_PRESETS[preset].params,
    ...custom,
  }), [preset, custom])

  const scaleLabel = useMemo(() => {
    const s = params.upscale
    const w = Math.round((asset?.width ?? 1920) * s)
    return s > 1 ? `${s}× → ${w}px wide` : 'no upscale'
  }, [params.upscale, asset?.width])

  const run = async () => {
    if (!asset) {
      toast({ kind: 'error', title: 'Select a video clip first' })
      return
    }
    setBusy(true)
    setResult(null)
    try {
      const time = Math.max(0.1, (videoClip?.inPoint ?? 0) + frameTime)
      const out = await enhanceFramePreview(asset.id, time, preset, custom)
      if (!out) throw new Error('Could not extract a frame from this clip')
      setResult({ before: out.before.toDataURL('image/jpeg', 0.92), after: out.after.toDataURL('image/jpeg', 0.92) })
    } catch (e) {
      toast({ kind: 'error', title: 'Enhancement failed', detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  /** Apply the restore LIVE on the clip (preview + RAM preview + export) as the Detail Restore effect. */
  const applyToClip = () => {
    if (!videoClip) {
      toast({ kind: 'error', title: 'Select a video clip in the timeline first' })
      return
    }
    const fxParams = {
      denoise: params.denoise, deblock: params.deblock, sharpen: params.sharpen,
      detail: params.detail, linePreserve: params.linePreserve,
    }
    useEditorStore.getState().mutate(d => {
      const c = d.clips.find(c => c.id === videoClip.id)
      if (!c) return
      const ex = c.effects.find(e => e.type === 'sx_enhance')
      if (ex) { ex.params = { ...ex.params, ...fxParams }; ex.enabled = true }
      else c.effects.push({ id: uid('fx'), type: 'sx_enhance', enabled: true, params: fxParams, paramKeyframes: {} })
    })
    toast({ kind: 'success', title: 'Detail Restore applied to clip', detail: 'Live in the preview and the export — tweak it in Effect Controls' })
  }
  const applied = !!videoClip?.effects.some(e => e.type === 'sx_enhance' && e.enabled)

  return (
    <div className="p-3 pb-10">
      <SectionTitle right={<span className="text-[10px] text-zinc-500">{scaleLabel}</span>}>
        <Sparkles size={11} className="inline mr-1 text-violet-400" /> Detail Restore
      </SectionTitle>
      <div className="text-[10px] text-zinc-500 mb-2">
        Source: {asset ? asset.name : 'select a video clip'} · progressive ≤2× bicubic chain with detail reinjection + edge-directed line reconstruction.
      </div>

      <Row label="Preset">
        <select className="ginput flex-1" value={preset} onChange={e => { setPreset(e.target.value as EnhancePreset); setCustom({}) }}>
          {Object.entries(ENHANCE_PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
        </select>
      </Row>
      <div className="text-[10px] text-zinc-600 mb-1">{ENHANCE_PRESETS[preset].description}</div>

      <SectionTitle>Custom parameters</SectionTitle>
      <SliderRow
        label="Frame time"
        value={frameTime}
        min={0.1}
        max={Math.max(1, (asset?.duration ?? 5) - 0.2)}
        step={0.1}
        onChange={setFrameTime}
        unit="s"
      />
      {PARAM_META.map(m => (
        <div key={m.key}>
          <SliderRow
            label={m.label}
            value={params[m.key] as number}
            min={0}
            max={m.max}
            step={0.01}
            onChange={v => setCustom(c => ({ ...c, [m.key]: v }))}
          />
          <div className="text-[9px] text-zinc-600 -mt-1 mb-1 pl-25">{m.note}</div>
        </div>
      ))}

      <button
        className="w-full mt-2 py-2.5 rounded-xl gbtn gbtn-violet text-sm font-semibold flex items-center justify-center gap-2"
        onClick={() => void run()}
        disabled={busy}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
        {busy ? 'Processing frame…' : 'Enhance frame (before / after)'}
      </button>

      <button
        className="w-full mt-2 py-2.5 rounded-xl gbtn text-sm font-semibold flex items-center justify-center gap-2"
        onClick={applyToClip}
        disabled={!videoClip}
        title={videoClip ? 'Adds / updates the Detail Restore effect on the selected clip' : 'Select a video clip first'}
      >
        <Wand2 size={14} />
        {applied ? 'Update enhance on clip' : 'Apply enhance to clip (live)'}
      </button>

      {result && (
        <div className="mt-3">
          <div className="text-[11px] text-zinc-400 mb-1.5 flex items-center gap-1.5">
            <MoveHorizontal size={12} className="text-amber-400" />
            Drag the divider — before / after
          </div>
          <BeforeAfterSlider before={result.before} after={result.after} split={split} onSplit={setSplit} />
          <p className="text-[10px] text-zinc-600 mt-2">
            Honest note: classical GPU pipeline (denoise → progressive upscale → edge-directed line sharpen → detail reinjection). Use “Apply enhance to clip” to run it live on the layer (preview + export), or pick an enhance preset in Export for the full upscale pass. Neural super-resolution awaits backend GPU integration.
          </p>
        </div>
      )}
    </div>
  )
}

function BeforeAfterSlider({ before, after, split, onSplit }: { before: string; after: string; split: number; onSplit: (v: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const update = (clientX: number) => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    onSplit(Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width))))
  }
  return (
    <div
      ref={ref}
      className="relative w-full rounded-xl overflow-hidden glass-inset select-none"
      style={{ touchAction: 'none' }}
      onPointerDown={e => { dragging.current = true; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); update(e.clientX) }}
      onPointerMove={e => { if (dragging.current) update(e.clientX) }}
      onPointerUp={() => { dragging.current = false }}
      onPointerCancel={() => { dragging.current = false }}
    >
      <img src={after} alt="After enhancement" className="w-full block" draggable={false} />
      <img
        src={before}
        alt="Before enhancement"
        className="absolute inset-0 w-full h-full object-cover"
        style={{ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }}
        draggable={false}
      />
      <div className="absolute top-0 bottom-0 w-0.5 bg-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.8)]" style={{ left: `${split * 100}%` }}>
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 left-0 w-7 h-7 rounded-full glass-strong flex items-center justify-center">
          <MoveHorizontal size={12} className="text-amber-400" />
        </div>
      </div>
      <span className="absolute bottom-1.5 left-2 text-[9px] text-zinc-400 as-mono">BEFORE</span>
      <span className="absolute bottom-1.5 right-2 text-[9px] text-emerald-400 as-mono">AFTER</span>
    </div>
  )
}
