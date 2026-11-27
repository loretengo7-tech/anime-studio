'use client'
/**
 * ANIME STUDIO — AI Video Lab
 * Topaz-style enhancement + Flowframes-style frame interpolation for whole
 * clips, rendered to a new file that can replace the clip on the timeline.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useEditorStore } from '@/lib/store/editorStore'
import { ENHANCE_PRESETS, enhanceFramePreview, type EnhanceParams, type EnhancePreset } from '@/lib/engine/enhance'
import { runVideoLab, labMotionPreview, labOutputSize, hasFfmpegLab, neuralTools, neuralFramePreview, type InterpMethod, type LabOptions, type NeuralModel } from '@/lib/engine/videolab'
import type { InterpQuality } from '@/lib/engine/interpolation'
import type { AssetMeta, VideoClip } from '@/lib/engine/types'
import { clipAverageSpeed } from '@/lib/engine/speed'
import { importFiles } from './ae/aeActions'
import { Sparkles, Film, Gauge, Play, Square, Wand2, Loader2, MoveHorizontal, Cpu } from 'lucide-react'

// ---------------------------------------------------------------- job store (survives closing the window)
interface LabJob { running: boolean; progress: number; message: string; fps?: number; eta?: number; error?: string; doneName?: string }
let job: LabJob = { running: false, progress: 0, message: '' }
let cancelFlag = false
const subs = new Set<() => void>()
const setJob = (j: Partial<LabJob>) => { job = { ...job, ...j }; subs.forEach(f => f()) }
const useJob = () => useSyncExternalStore(cb => { subs.add(cb); return () => subs.delete(cb) }, () => job, () => job)

const UPSCALES = [1, 1.5, 2, 4]
const FPS_PRESETS = [48, 60, 120, 144, 240]
const METHODS: { id: InterpMethod; label: string; note: string; desktop?: boolean; neural?: boolean }[] = [
  { id: 'rife', label: 'RIFE 4.6 — neural network (AI)', note: 'The model Flowframes uses: best quality for anime and fast motion. Desktop app, GPU with Vulkan.', desktop: true, neural: true },
  { id: 'flow', label: 'Flow — GPU optical flow', note: 'Dense pyramidal optical flow, occlusion-aware warp. Any device.' },
  { id: 'mci', label: 'MCI — motion compensated (ffmpeg)', note: 'Block motion compensation with overlapped blocks, bidirectional search. Desktop app.', desktop: true },
  { id: 'blend', label: 'Blend — frame mixing', note: 'Cross-fades neighbours. Fast, ghosting on motion.' },
  { id: 'dup', label: 'Duplicate — no new frames', note: 'Only changes the frame rate (repeats frames).' },
]

export function VideoLab({ wide = false }: { wide?: boolean }) {
  const doc = useEditorStore(s => s.doc)
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const toast = useEditorStore(s => s.toast)
  const desktop = hasFfmpegLab()
  const j = useJob()

  const videos = doc.assets.filter(a => a.kind === 'video')
  const selClip = doc.clips.find(c => c.id === selectedClipId && c.kind === 'video') as VideoClip | undefined
  const [assetId, setAssetId] = useState<string>(selClip?.assetId ?? videos[0]?.id ?? '')
  useEffect(() => { if (selClip) setAssetId(selClip.assetId) }, [selClip?.assetId]) // eslint-disable-line react-hooks/exhaustive-deps
  const asset: AssetMeta | undefined = videos.find(a => a.id === assetId) ?? videos[0]
  const clipForAsset = selClip && selClip.assetId === asset?.id ? selClip : doc.clips.find(c => c.kind === 'video' && (c as VideoClip).assetId === asset?.id) as VideoClip | undefined

  // ---- settings
  const [enhOn, setEnhOn] = useState(true)
  const [preset, setPreset] = useState<EnhancePreset>('anime_hd')
  const [custom, setCustom] = useState<Partial<EnhanceParams>>({})
  const enh: EnhanceParams = useMemo(() => ({ ...ENHANCE_PRESETS[preset].params, ...custom }), [preset, custom])
  const [interpOn, setInterpOn] = useState(true)
  const [targetFps, setTargetFps] = useState(60)
  const [method, setMethod] = useState<InterpMethod>('flow')
  const [quality, setQuality] = useState<InterpQuality>('quality')
  const [sceneDetect, setSceneDetect] = useState(true)
  const [slowmo, setSlowmo] = useState(false)
  const [bitrate, setBitrate] = useState(40)
  const [useClipRange, setUseClipRange] = useState(true)
  const [replace, setReplace] = useState(true)
  const [matchComp, setMatchComp] = useState(false)
  // enhancement engine: classic GPU chain or a neural model (desktop)
  const [engineSel, setEngineSel] = useState<'classic' | NeuralModel>('classic')
  const [neuralScale, setNeuralScale] = useState(2)
  const [nt, setNt] = useState({ esrgan: false, rife: false })
  useEffect(() => { void neuralTools().then(setNt) }, [])
  useEffect(() => { if (nt.rife) setMethod(m => (m === 'flow' ? 'rife' : m)) }, [nt.rife])

  const srcFps = asset?.fps || 30
  const range = useMemo(() => {
    if (!asset) return { start: 0, end: 0 }
    if (useClipRange && clipForAsset) {
      const s = clipForAsset.inPoint
      return { start: s, end: Math.min(asset.duration, s + clipForAsset.duration * clipAverageSpeed(clipForAsset)) }
    }
    return { start: 0, end: asset.duration }
  }, [asset, clipForAsset, useClipRange])
  const opts: LabOptions = {
    enhance: enhOn ? enh : null,
    targetFps: interpOn ? targetFps : null,
    slowmo: interpOn && slowmo,
    method, quality, sceneDetect,
    start: range.start, end: range.end,
    bitrateMbps: bitrate,
    neuralUpscale: enhOn && engineSel !== 'classic' ? { model: engineSel, scale: engineSel === 'realesrgan-x4plus-anime' ? 4 : neuralScale } : null,
    engine: (interpOn && (method === 'mci' || method === 'rife')) || (enhOn && engineSel !== 'classic') ? 'ffmpeg' : 'gpu',
  }
  const out = asset ? labOutputSize(asset, opts) : { w: 0, h: 0 }
  const factor = interpOn ? targetFps / srcFps : 1
  const outFrames = Math.round((range.end - range.start) * srcFps * factor)
  const mciBlocked = (interpOn && ((method === 'mci' && !desktop) || (method === 'rife' && !nt.rife))) || (enhOn && engineSel !== 'classic' && !nt.esrgan)
  const nothing = !enhOn && !interpOn

  // ---- previews
  const [pvTab, setPvTab] = useState<'enhance' | 'motion'>('enhance')
  const [pvTime, setPvTime] = useState(0)
  useEffect(() => { setPvTime(range.start + Math.min(1, (range.end - range.start) / 2)) }, [range.start, range.end])
  const [pvBusy, setPvBusy] = useState(false)
  const [ba, setBa] = useState<{ before: string; after: string } | null>(null)
  const [split, setSplit] = useState(0.5)
  const [motion, setMotion] = useState<{ frames: string[]; engine: string } | null>(null)
  const [mIdx, setMIdx] = useState(0)
  useEffect(() => {
    if (!motion) return
    const iv = setInterval(() => setMIdx(i => (i + 1) % motion.frames.length), 140)
    return () => clearInterval(iv)
  }, [motion])

  const runPreview = async () => {
    if (!asset) return
    setPvBusy(true)
    try {
      if (pvTab === 'enhance' && engineSel !== 'classic') {
        setBa(await neuralFramePreview(asset, Math.max(0, pvTime), engineSel, neuralScale))
      } else if (pvTab === 'enhance') {
        const r = await enhanceFramePreview(asset.id, Math.max(0.05, pvTime), preset, custom)
        if (!r) throw new Error('Could not read a frame from this clip')
        setBa({ before: r.before.toDataURL('image/jpeg', 0.9), after: r.after.toDataURL('image/jpeg', 0.9) })
      } else {
        const steps = Math.max(2, Math.min(8, Math.round(factor)))
        setMotion(await labMotionPreview(asset, Math.max(0, pvTime), steps, quality))
        setMIdx(0)
      }
    } catch (e) {
      toast({ kind: 'error', title: 'Preview failed', detail: e instanceof Error ? e.message : String(e) })
    } finally { setPvBusy(false) }
  }

  const render = async () => {
    if (!asset || job.running) return
    cancelFlag = false
    const up = useEditorStore.getState().upsertJob
    const label = `Video Lab ${asset.name}`
    setJob({ running: true, progress: 0, message: 'Starting…', error: undefined, doneName: undefined, fps: undefined, eta: undefined })
    up({ id: 'videolab', kind: 'enhance', label, status: 'running', progress: 0 })
    const clipId = clipForAsset?.id
    const snapshotOpts = { ...opts }
    try {
      const file = await runVideoLab(asset, snapshotOpts, p => {
        setJob({ progress: p.progress, message: p.message, fps: p.fps, eta: p.eta })
        up({ id: 'videolab', kind: 'enhance', label, status: 'running', progress: p.progress, message: p.message })
      }, () => cancelFlag)
      setJob({ message: 'Importing result…' })
      const [meta] = await importFiles([file])
      if (!meta) throw new Error('The rendered file could not be imported')
      if (replace && clipId && useClipRange) {
        const slowF = snapshotOpts.slowmo && snapshotOpts.targetFps ? snapshotOpts.targetFps / srcFps : 1
        useEditorStore.getState().mutate(d => {
          const c = d.clips.find(x => x.id === clipId) as VideoClip | undefined
          if (!c) return
          c.assetId = meta.id
          c.inPoint = 0
          if (slowF > 1) c.duration = c.duration * slowF
        })
      }
      if (matchComp && snapshotOpts.targetFps && !snapshotOpts.slowmo) {
        useEditorStore.getState().mutate(d => { d.composition.fps = snapshotOpts.targetFps! })
      }
      setJob({ running: false, progress: 1, message: 'Done', doneName: meta.name })
      up({ id: 'videolab', kind: 'enhance', label, status: 'done', progress: 1 })
      toast({ kind: 'success', title: 'Video Lab finished', detail: `${meta.name} · ${meta.width}×${meta.height} · ${Math.round(meta.fps)} fps${replace && clipId && useClipRange ? ' — clip replaced on the timeline' : ' — added to Project'}` })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setJob({ running: false, error: msg, message: msg })
      up({ id: 'videolab', kind: 'enhance', label, status: 'error', progress: 0, message: msg })
      if (msg !== 'Cancelled') toast({ kind: 'error', title: 'Video Lab failed', detail: msg })
    }
  }

  if (!asset) {
    return <div className="p-6 text-[12px] text-zinc-400">Import a video clip first — the Video Lab enhances and interpolates whole clips.</div>
  }

  const fmtT = (s?: number) => s === undefined || !isFinite(s) ? '—' : s > 90 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`

  const settings = (
    <div className="space-y-3 text-[12px]">
      {/* source */}
      <div className="vl-card">
        <div className="vl-h"><Film size={13} /> Source</div>
        <select className="ginput w-full" value={asset.id} onChange={e => setAssetId(e.target.value)}>
          {videos.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <div className="text-zinc-500 mt-1 as-mono text-[11px]">{asset.width}×{asset.height} · {Math.round(srcFps * 100) / 100} fps · {asset.duration.toFixed(2)} s</div>
        <label className="flex items-center gap-2 mt-1.5 text-zinc-300">
          <input type="checkbox" checked={useClipRange} disabled={!clipForAsset} onChange={e => setUseClipRange(e.target.checked)} />
          Only the part used by the clip {clipForAsset ? `(${range.start.toFixed(2)}–${range.end.toFixed(2)} s)` : ''}
        </label>
      </div>

      {/* enhancement */}
      <div className="vl-card" data-off={enhOn ? '0' : '1'}>
        <label className="vl-h cursor-pointer"><input type="checkbox" checked={enhOn} onChange={e => setEnhOn(e.target.checked)} /><Sparkles size={13} className="text-violet-400" /> Enhancement</label>
        <div className="vl-body">
          <div className="text-zinc-500 text-[11px] mb-1">AI model</div>
          <select className="ginput w-full" value={engineSel === 'classic' ? `c:${preset}` : `n:${engineSel}`}
            onChange={e => {
              const v = e.target.value
              if (v.startsWith('n:')) setEngineSel(v.slice(2) as NeuralModel)
              else { setEngineSel('classic'); setPreset(v.slice(2) as EnhancePreset); setCustom({}) }
            }}>
            <optgroup label={nt.esrgan ? 'Neural (Real-ESRGAN, GPU)' : 'Neural (Real-ESRGAN) — desktop app'}>
              <option value="n:realesr-animevideov3" disabled={!nt.esrgan}>Real-ESRGAN AnimeVideo v3 — anime video (2×/3×/4×)</option>
              <option value="n:realesrgan-x4plus-anime" disabled={!nt.esrgan}>Real-ESRGAN x4plus Anime — max detail (4×)</option>
            </optgroup>
            <optgroup label="Classic GPU (any device)">
              {(Object.keys(ENHANCE_PRESETS) as EnhancePreset[]).map(k => <option key={k} value={`c:${k}`}>{ENHANCE_PRESETS[k].label}</option>)}
            </optgroup>
          </select>
          <div className="text-zinc-500 text-[10.5px] mt-1">
            {engineSel === 'classic' ? ENHANCE_PRESETS[preset].description : engineSel === 'realesr-animevideov3' ? 'Neural network trained for anime video: rebuilds line art and removes compression in one pass.' : 'Heavier neural model with the most detail reconstruction (slow).'}
          </div>

          <div className="text-zinc-500 text-[11px] mt-2.5 mb-1">Output scale</div>
          <div className="flex gap-1">
            {engineSel === 'classic'
              ? UPSCALES.map(u => <button key={u} className="vl-chip" data-on={Math.abs(enh.upscale - u) < 0.01 ? '1' : '0'} onClick={() => setCustom(c => ({ ...c, upscale: u }))}>{u}×</button>)
              : (engineSel === 'realesrgan-x4plus-anime' ? [4] : [2, 3, 4]).map(u => <button key={u} className="vl-chip" data-on={(engineSel === 'realesrgan-x4plus-anime' ? 4 : neuralScale) === u ? '1' : '0'} onClick={() => setNeuralScale(u)}>{u}×</button>)}
          </div>

          {/* Topaz-style model settings — always visible */}
          <div className="flex items-center mt-3 mb-1">
            <span className="text-zinc-300 text-[11.5px] font-medium flex-1">Model settings</span>
            <button className="text-[10.5px] text-[#2d8ceb]" onClick={() => setCustom(c => ({ upscale: c.upscale }))}>Auto</button>
          </div>
          {([
            ['denoise', 'Reduce noise'],
            ['deblock', 'Fix compression'],
            ['detail', 'Improve detail'],
            ['sharpen', 'Sharpen'],
            ['linePreserve', 'Anti-alias / lines'],
          ] as const).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 mt-1">
              <span className="w-[104px] text-zinc-400">{label}</span>
              <input type="range" className="flex-1" min={0} max={1} step={0.01} value={enh[k]} onChange={e => setCustom(c => ({ ...c, [k]: Number(e.target.value) }))} />
              <span className="w-8 text-right as-mono text-zinc-400">{Math.round(enh[k] * 100)}</span>
            </label>
          ))}
          {engineSel !== 'classic' && <div className="text-[10.5px] text-zinc-500 mt-1.5">With neural models, noise/compression are cleaned before the network and sharpen/detail are applied after it.</div>}
        </div>
      </div>

      {/* interpolation */}
      <div className="vl-card" data-off={interpOn ? '0' : '1'}>
        <label className="vl-h cursor-pointer"><input type="checkbox" checked={interpOn} onChange={e => setInterpOn(e.target.checked)} /><Gauge size={13} className="text-sky-400" /> Frame interpolation</label>
        <div className="vl-body">
          <div className="text-zinc-500 text-[11px] mb-1">Multiplier</div>
          <div className="flex gap-1 flex-wrap">
            {[2, 4, 8].map(m => <button key={m} className="vl-chip" data-on={Math.abs(factor - m) < 0.01 ? '1' : '0'} onClick={() => setTargetFps(Math.round(srcFps * m * 1000) / 1000)}>{m}×</button>)}
          </div>
          <div className="text-zinc-500 text-[11px] mt-2 mb-1">Target frame rate</div>
          <div className="flex gap-1 flex-wrap items-center">
            {FPS_PRESETS.map(f => <button key={f} className="vl-chip" data-on={targetFps === f ? '1' : '0'} onClick={() => setTargetFps(f)}>{f}</button>)}
            <input className="ginput w-[64px] as-mono" type="number" min={1} max={480} value={targetFps} onChange={e => setTargetFps(Math.max(1, Math.min(480, Number(e.target.value) || srcFps)))} />
            <span className="text-zinc-500">fps</span>
          </div>
          <div className="text-zinc-500 text-[11px] mt-2 mb-1">Method</div>
          <div className="grid gap-1">
            {METHODS.map(m => (
              <button key={m.id} className="vl-opt" data-on={method === m.id ? '1' : '0'} disabled={(m.desktop && !desktop) || (m.neural && !nt.rife)} onClick={() => setMethod(m.id)} title={m.desktop && !desktop ? 'Available in the AnimeStudio desktop app' : ''}>
                <span className="font-medium">{m.label}{(m.desktop && !desktop) || (m.neural && !nt.rife) ? ' · desktop app' : ''}</span>
                <span className="text-zinc-500 text-[10.5px]">{m.note}</span>
              </button>
            ))}
          </div>
          {method === 'flow' && (
            <div className="flex items-center gap-2 mt-2">
              <span className="text-zinc-400 w-[86px]">Flow quality</span>
              <select className="ginput flex-1" value={quality} onChange={e => setQuality(e.target.value as InterpQuality)}>
                <option value="fast">Fast</option><option value="balanced">Balanced</option><option value="quality">Quality</option>
              </select>
            </div>
          )}
          <label className="flex items-center gap-2 mt-2 text-zinc-300"><input type="checkbox" checked={sceneDetect} onChange={e => setSceneDetect(e.target.checked)} /> Scene-change detection (no morphing across cuts)</label>
          <label className="flex items-center gap-2 mt-1 text-zinc-300"><input type="checkbox" checked={slowmo} onChange={e => setSlowmo(e.target.checked)} /> Slow motion ({Math.round(factor * 10) / 10}× slower at {Math.round(srcFps)} fps, no audio)</label>
        </div>
      </div>

      {/* output */}
      <div className="vl-card">
        <div className="vl-h"><Cpu size={13} /> Output</div>
        <div className="flex items-center gap-2">
          <span className="text-zinc-400 w-[86px]">Bitrate</span>
          <input type="range" className="flex-1" min={8} max={160} step={2} value={bitrate} onChange={e => setBitrate(Number(e.target.value))} />
          <span className="w-16 text-right as-mono text-zinc-400">{bitrate} Mb/s</span>
        </div>
        <label className="flex items-center gap-2 mt-1.5 text-zinc-300"><input type="checkbox" checked={replace} disabled={!clipForAsset || !useClipRange} onChange={e => setReplace(e.target.checked)} /> Replace the clip on the timeline</label>
        <label className="flex items-center gap-2 mt-1 text-zinc-300"><input type="checkbox" checked={matchComp} disabled={!interpOn || slowmo} onChange={e => setMatchComp(e.target.checked)} /> Set the composition to {targetFps} fps</label>
        <div className="mt-2 text-[11px] as-mono text-zinc-400 leading-5">
          {asset.width}×{asset.height} @ {Math.round(srcFps)} → <span className="text-zinc-100">{out.w}×{out.h} @ {interpOn ? (slowmo ? `${Math.round(srcFps)} (${Math.round(factor * 10) / 10}× slow-mo)` : targetFps) : Math.round(srcFps)}</span> · {outFrames} frames
          <br />Engine: {[opts.neuralUpscale ? 'Real-ESRGAN' : '', interpOn && method === 'rife' ? 'RIFE 4.6' : '', opts.engine === 'ffmpeg' ? 'ffmpeg' : 'GPU (WebGL + WebCodecs)'].filter(Boolean).join(' + ')}
        </div>
      </div>
    </div>
  )

  const preview = (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex items-center gap-1 mb-2">
        <button className="vl-chip" data-on={pvTab === 'enhance' ? '1' : '0'} onClick={() => setPvTab('enhance')}><Sparkles size={11} /> Before / after</button>
        <button className="vl-chip" data-on={pvTab === 'motion' ? '1' : '0'} onClick={() => setPvTab('motion')}><Gauge size={11} /> Motion (in-betweens)</button>
        <div className="flex-1" />
        <span className="text-[11px] text-zinc-500 as-mono">{pvTime.toFixed(2)} s</span>
      </div>
      <input type="range" className="w-full mb-2" min={range.start} max={Math.max(range.start + 0.01, range.end - 0.05)} step={0.01} value={pvTime} onChange={e => setPvTime(Number(e.target.value))} />
      <div className="flex-1 min-h-[180px] rounded-[4px] bg-black/60 border border-black flex items-center justify-center overflow-hidden relative">
        {pvTab === 'enhance' ? (ba ? <BeforeAfter before={ba.before} after={ba.after} split={split} onSplit={setSplit} /> : <span className="text-zinc-600 text-[12px]">Pick a frame and press Preview</span>)
          : motion ? (
            <div className="w-full h-full flex flex-col">
              <img src={motion.frames[mIdx]} alt="Interpolated frame" className="flex-1 min-h-0 object-contain w-full" />
              <div className="flex gap-0.5 p-1 bg-black/60">
                {motion.frames.map((f, i) => <img key={i} src={f} alt="" className="h-10 flex-1 object-cover" style={{ outline: i === mIdx ? '1px solid #2d8ceb' : 'none', opacity: i === 0 || i === motion.frames.length - 1 ? 1 : 0.85 }} />)}
              </div>
              <div className="text-[10.5px] text-zinc-400 px-2 pb-1">First and last are real frames, the {motion.frames.length - 2} in the middle are generated ({motion.engine === 'gpu' ? 'GPU optical flow' : 'CPU flow'}).</div>
            </div>
          ) : <span className="text-zinc-600 text-[12px]">Preview generated in-between frames</span>}
      </div>
      <button className="gbtn mt-2 h-8 text-[12px] flex items-center justify-center gap-2" onClick={() => void runPreview()} disabled={pvBusy}>
        {pvBusy ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />} Preview this frame
      </button>
    </div>
  )

  const footer = (
    <div className="vl-card mt-3">
      {j.running || j.progress > 0 || j.error ? (
        <div className="mb-2">
          <div className="h-2 rounded bg-black/60 overflow-hidden"><div className="h-full bg-[#2d8ceb] transition-[width]" style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>
          <div className="flex text-[11px] mt-1 text-zinc-400 as-mono gap-3">
            <span className="flex-1 truncate">{j.error ? <span className="text-red-400">{j.error}</span> : j.doneName && !j.running ? <span className="text-emerald-400">✓ {j.doneName}</span> : j.message}</span>
            {j.running && <><span>{Math.round(j.progress * 100)}%</span><span>{j.fps ? `${j.fps.toFixed(1)} fps` : ''}</span><span>ETA {fmtT(j.eta)}</span></>}
          </div>
        </div>
      ) : null}
      <div className="flex gap-2">
        {j.running ? (
          <button className="gbtn flex-1 h-9 text-[13px] flex items-center justify-center gap-2" onClick={() => { cancelFlag = true }}><Square size={13} /> Cancel</button>
        ) : (
          <button className="gbtn gbtn-accent flex-1 h-9 text-[13px] font-semibold flex items-center justify-center gap-2" disabled={nothing || mciBlocked} onClick={() => void render()}>
            <Play size={13} /> Render {interpOn ? `${slowmo ? 'slow motion' : `${targetFps} fps`}` : ''}{interpOn && enhOn ? ' + ' : ''}{enhOn ? `${out.h}p enhance` : ''}
          </button>
        )}
      </div>
      {method === 'mci' && interpOn && targetFps >= 120 && <div className="text-[10.5px] text-amber-400/80 mt-1.5">High frame rates with motion compensation take a while (ffmpeg works on the CPU). Short clips first!</div>}
    </div>
  )

  return (
    <div className={wide ? 'p-3 w-[1080px] max-w-[94vw]' : 'p-3 pb-10'}>
      {wide ? (
        <>
          <div className="grid grid-cols-[1fr_360px] gap-3 h-[min(70vh,680px)]">
            <div className="min-h-0">{preview}</div>
            <div className="min-h-0 overflow-y-auto as-scroll pr-1">{settings}</div>
          </div>
          {footer}
        </>
      ) : (
        <>
          <div className="h-[300px] mb-3">{preview}</div>
          {settings}
          {footer}
        </>
      )}
    </div>
  )
}

function BeforeAfter({ before, after, split, onSplit }: { before: string; after: string; split: number; onSplit: (v: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef(false)
  const upd = (x: number) => { const r = ref.current?.getBoundingClientRect(); if (r) onSplit(Math.min(1, Math.max(0, (x - r.left) / Math.max(1, r.width)))) }
  return (
    <div ref={ref} className="relative w-full h-full select-none" style={{ touchAction: 'none' }}
      onPointerDown={e => { drag.current = true; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); upd(e.clientX) }}
      onPointerMove={e => { if (drag.current) upd(e.clientX) }} onPointerUp={() => { drag.current = false }}>
      <img src={after} alt="After" className="absolute inset-0 w-full h-full object-contain" draggable={false} />
      <img src={before} alt="Before" className="absolute inset-0 w-full h-full object-contain" style={{ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }} draggable={false} />
      <div className="absolute top-0 bottom-0 w-0.5 bg-amber-400" style={{ left: `${split * 100}%` }}>
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-7 h-7 rounded-full bg-[#222] border border-amber-400 flex items-center justify-center"><MoveHorizontal size={12} className="text-amber-400" /></div>
      </div>
      <span className="absolute bottom-1.5 left-2 text-[10px] text-zinc-300 as-mono bg-black/50 px-1">BEFORE</span>
      <span className="absolute bottom-1.5 right-2 text-[10px] text-emerald-400 as-mono bg-black/50 px-1">AFTER</span>
    </div>
  )
}
