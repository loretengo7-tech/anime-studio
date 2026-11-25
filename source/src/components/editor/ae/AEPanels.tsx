'use client'
/**
 * ANIME STUDIO — AE-style panels: Project, Effects & Presets, Info, Preview,
 * Align, Composition Settings, Keyboard Shortcuts.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AssetMeta, Clip, VideoClip } from '@/lib/engine/types'
import { uid, LABEL_COLORS } from '@/lib/engine/types'
import { useEditorStore } from '@/lib/store/editorStore'
import { useUIStore } from '@/lib/store/uiStore'
import { playbackEngine } from '@/lib/engine/playback'
import { mediaManager } from '@/lib/media/mediaManager'
import { generateLocalProxy } from '@/lib/media/proxy'
import { STATIC_MODE, deleteLocalFile } from '@/lib/media/staticMode'
import { EFFECT_DEFS } from '@/lib/engine/effects'
import { getPluginEffectDefs } from '@/lib/engine/plugins'
import { evalProperty } from '@/lib/engine/keyframes'
import { timecode } from '../ui-bits'
import { addAssetLayer, importFiles, pickAndImport, writeProp, openComp } from './aeActions'
import {
  Film, Music, ImageIcon, Trash2, Search, ChevronRight, ChevronDown, Zap, FolderPlus, Clapperboard,
  Play, Pause, SkipBack, SkipForward, ChevronFirst, ChevronLast, Repeat, Volume2, VolumeX, Upload,
  AlignHorizontalJustifyStart, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
} from 'lucide-react'

export function usePlayheadTime(ms = 80) {
  const [t, setT] = useState(playbackEngine.currentTime)
  useEffect(() => playbackEngine.subscribeThrottled(setT, ms), [ms])
  return t
}

function fmtSize(b: number) {
  if (b > 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(b / 1024)} KB`
}

// ============================================================ Project

export function ProjectPanel() {
  const doc = useEditorStore(s => s.doc)
  const mutate = useEditorStore(s => s.mutate)
  const toast = useEditorStore(s => s.toast)
  const setDialog = useUIStore(s => s.setDialog)
  const [sel, setSel] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const jobs = useEditorStore(s => s.jobs)

  const asset = doc.assets.find(a => a.id === sel) ?? null
  const list = doc.assets.filter(a => !q || a.name.toLowerCase().includes(q.toLowerCase()))
  const usedCount = (a: AssetMeta) => doc.clips.filter(c => (c as VideoClip).assetId === a.id).length

  const removeAsset = (a: AssetMeta) => {
    if (usedCount(a) > 0) { toast({ kind: 'error', title: 'Footage is used in the composition', detail: 'Delete its layers first' }); return }
    mutate(d => { d.assets = d.assets.filter(x => x.id !== a.id) })
    mediaManager.removeAsset(a.id)
    if (STATIC_MODE) void deleteLocalFile(a.id)
    setSel(null)
  }

  const makeProxy = async (a: AssetMeta) => {
    const upsertJob = useEditorStore.getState().upsertJob
    const id = `proxy-${a.id}`
    upsertJob({ id, kind: 'proxy', label: `Proxy ${a.name}`, status: 'running', progress: 0 })
    try {
      const r = await generateLocalProxy(a, p => upsertJob({ id, kind: 'proxy', label: `Proxy ${a.name}`, status: 'running', progress: p.progress, message: p.message }))
      upsertJob({ id, kind: 'proxy', label: `Proxy ${a.name}`, status: 'done', progress: 1, message: fmtSize(r.sizeBytes) })
      toast({ kind: 'success', title: 'Proxy ready', detail: 'Preview uses the light proxy. Render always reads the original.' })
    } catch (e) {
      upsertJob({ id, kind: 'proxy', label: `Proxy ${a.name}`, status: 'error', progress: 0 })
      toast({ kind: 'error', title: 'Proxy failed', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div
      className="flex flex-col h-full min-h-0 text-[12px]"
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true) } }}
      onDragLeave={() => setDropping(false)}
      onDrop={e => { e.preventDefault(); setDropping(false); void importFiles(e.dataTransfer.files, setBusy) }}
    >
      {/* footage preview header (AE shows a thumbnail + info of the selected item) */}
      <div className="flex gap-2 p-2 border-b border-black/60 shrink-0" style={{ minHeight: 76 }}>
        <div className="w-[92px] h-[56px] bg-black/60 shrink-0 flex items-center justify-center overflow-hidden border border-[#333]">
          {asset?.kind === 'video' && asset.thumbnails?.[0] ? <img src={asset.thumbnails[0]} alt="" className="w-full h-full object-cover" />
            : asset?.kind === 'image' ? <img src={asset.url} alt="" className="w-full h-full object-cover" />
              : asset?.kind === 'audio' ? <Music size={18} className="text-zinc-500" /> : <Clapperboard size={18} className="text-zinc-600" />}
        </div>
        <div className="min-w-0 text-[11px] leading-[15px] text-zinc-400">
          {asset ? (
            <>
              <div className="text-zinc-100 truncate font-medium">{asset.name}{usedCount(asset) > 0 && <span className="text-zinc-500 font-normal"> , used {usedCount(asset)} time{usedCount(asset) > 1 ? 's' : ''}</span>}</div>
              {asset.width > 0 && <div>{asset.width} x {asset.height} (1.00)</div>}
              {asset.duration > 0 && <div>Δ {timecode(asset.duration, asset.fps || doc.composition.fps)}{asset.fps ? `, ${asset.fps} fps` : ''}</div>}
              <div>{fmtSize(asset.size)}{mediaManager.hasLocalProxy(asset.id) && <span className="text-amber-400"> · proxy on</span>}</div>
            </>
          ) : (
            <>
              <div className="text-zinc-100 font-medium">{doc.name}</div>
              <div>{doc.composition.width} x {doc.composition.height} · {doc.composition.fps} fps</div>
              <div>Δ {timecode(doc.composition.duration, doc.composition.fps)}</div>
              <div>{doc.assets.length} item{doc.assets.length === 1 ? '' : 's'}</div>
            </>
          )}
        </div>
      </div>

      <div className="px-2 py-1.5 shrink-0 border-b border-black/60">
        <div className="relative">
          <Search size={12} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input className="ginput w-full !pl-6 !py-0.5 !text-[12px]" placeholder="Search" value={q} onChange={e => setQ(e.target.value)} />
        </div>
      </div>

      {/* column headers */}
      <div className="aet-colh shrink-0 px-2 gap-2">
        <span className="flex-1">Name</span>
        <span className="w-4" />
        <span className="w-11">Type</span>
        <span className="w-16 text-right">Duration</span>
      </div>

      <div className={`flex-1 min-h-0 overflow-auto as-scroll ${dropping ? 'outline outline-2 -outline-offset-2 outline-amber-500' : ''}`} onClick={() => setSel(null)}>
        {/* the composition itself, like AE's comp item */}
        <div className="flex items-center gap-2 px-2 h-[22px] text-zinc-200 hover:bg-[#2c2c2c]" onDoubleClick={() => setDialog('comp')} title="Double-click: Composition Settings">
          <Clapperboard size={13} className="text-zinc-400 shrink-0" />
          <span className="flex-1 truncate">{doc.compName ?? doc.name}{doc.compId && doc.compId !== 'main' ? ' (open)' : ''}</span>
          <span className="w-4 h-3 rounded-[1px]" style={{ background: LABEL_COLORS[15].color }} />
          <span className="w-11 text-zinc-500 text-[11px]">Comp</span>
          <span className="w-16 text-right text-zinc-400 as-mono text-[11px]">{timecode(doc.composition.duration, doc.composition.fps)}</span>
        </div>
        {(doc.precomps ?? []).filter(p => p.id !== 'main').map(pc => (
          <div key={pc.id} draggable
            onDragStart={e => { e.dataTransfer.setData('application/x-as-comp', pc.id); e.dataTransfer.effectAllowed = 'copy' }}
            className="flex items-center gap-2 px-2 h-[22px] text-zinc-200 hover:bg-[#2c2c2c] cursor-default"
            onDoubleClick={() => openComp(pc.id)} title="Double-click to open · drag to the timeline to nest">
            <Clapperboard size={13} className="text-zinc-400 shrink-0" />
            <span className="flex-1 truncate">{pc.name}</span>
            <span className="w-4 h-3 rounded-[1px]" style={{ background: LABEL_COLORS[15].color }} />
            <span className="w-11 text-zinc-500 text-[11px]">Comp</span>
            <span className="w-16 text-right text-zinc-400 as-mono text-[11px]">{timecode(pc.composition.duration, pc.composition.fps)}</span>
          </div>
        ))}
        {doc.compId && doc.compId !== 'main' && (
          <div className="flex items-center gap-2 px-2 h-[22px] text-zinc-400 hover:bg-[#2c2c2c] cursor-default" onDoubleClick={() => openComp('main')}>
            <Clapperboard size={13} className="shrink-0" />
            <span className="flex-1 truncate">{doc.precomps?.find(p => p.id === 'main')?.name ?? 'Main'} (main)</span>
          </div>
        )}
        {list.map(a => (
          <div
            key={a.id}
            draggable
            onDragStart={e => { e.dataTransfer.setData('application/x-as-asset', a.id); e.dataTransfer.effectAllowed = 'copy' }}
            className={`flex items-center gap-2 px-2 h-[22px] cursor-default ${sel === a.id ? 'bg-[#3d4b5c] text-white' : 'text-zinc-300 hover:bg-[#2c2c2c]'}`}
            onClick={e => { e.stopPropagation(); setSel(a.id) }}
            onDoubleClick={() => addAssetLayer(a)}
            title="Double-click or drag to the timeline to add a layer"
          >
            {a.kind === 'video' ? <Film size={13} className="text-zinc-400 shrink-0" /> : a.kind === 'audio' ? <Music size={13} className="text-zinc-400 shrink-0" /> : <ImageIcon size={13} className="text-zinc-400 shrink-0" />}
            <span className="flex-1 truncate">{a.name}</span>
            <span className="w-4 h-3 rounded-[1px]" style={{ background: LABEL_COLORS[a.kind === 'audio' ? 7 : a.kind === 'image' ? 5 : 3].color }} />
            <span className="w-11 text-zinc-500 text-[11px]">{a.kind === 'video' ? 'Video' : a.kind === 'audio' ? 'Audio' : 'Image'}</span>
            <span className="w-16 text-right text-zinc-400 as-mono text-[11px]">{a.duration > 0 ? timecode(a.duration, a.fps || doc.composition.fps) : ''}</span>
          </div>
        ))}
        {doc.assets.length === 0 && (
          <button className="m-3 w-[calc(100%-24px)] py-6 border border-dashed border-[#444] text-zinc-500 text-[12px] hover:text-zinc-200 hover:border-zinc-500 flex flex-col items-center gap-1.5" onClick={pickAndImport}>
            <Upload size={18} />
            Double-click / drop files here to import footage
          </button>
        )}
        {busy && <div className="px-2 py-1 text-[11px] text-amber-400">Importing {busy}…</div>}
        {jobs.filter(j => j.status === 'running' && j.kind === 'proxy').map(j => (
          <div key={j.id} className="px-2 py-1 text-[11px] text-zinc-400">{j.label} — {Math.round(j.progress * 100)}%</div>
        ))}
      </div>

      {/* bottom bar */}
      <div className="h-7 shrink-0 flex items-center gap-0.5 px-1 border-t border-black/60 bg-[#202020]">
        <button className="tb-btn !w-7 !h-6" title="Import File… (Ctrl+I)" onClick={pickAndImport}><Upload size={13} /></button>
        <button className="tb-btn !w-7 !h-6" title="Composition Settings (Ctrl+K)" onClick={() => setDialog('comp')}><FolderPlus size={13} /></button>
        <button className="tb-btn !w-7 !h-6" title="Create Proxy (lighter preview)" disabled={!asset || asset.kind !== 'video'} onClick={() => asset && void makeProxy(asset)}><Zap size={13} /></button>
        <button className="tb-btn !w-7 !h-6" title="Add to Composition" disabled={!asset} onClick={() => asset && addAssetLayer(asset)}><Clapperboard size={13} /></button>
        <div className="flex-1" />
        <span className="text-[10px] text-zinc-600 mr-1">{STATIC_MODE ? 'stored on device' : ''}</span>
        <button className="tb-btn !w-7 !h-6" title="Delete" disabled={!asset} onClick={() => asset && removeAsset(asset)}><Trash2 size={13} /></button>
      </div>
    </div>
  )
}

// ============================================================ Effects & Presets

const CAT_NAMES: Record<string, string> = {
  anime: 'Anime', motion: 'Blur & Motion', color: 'Color Correction', distortion: 'Distort', generate: 'Generate',
  lighting: 'Light & Glow', perspective: 'Perspective', stylize: 'Stylize', time: 'Time', audio: 'Audio',
}

export function applyEffectToClip(clipId: string, type: string) {
  const defs = [...EFFECT_DEFS, ...getPluginEffectDefs()]
  const def = defs.find(e => e.type === type)
  if (!def) return
  useEditorStore.getState().mutate(d => {
    const c = d.clips.find(c => c.id === clipId)
    if (!c) return
    c.effects.push({ id: uid('fx'), type, enabled: true, params: Object.fromEntries(def.params.map(p => [p.key, p.default])), paramKeyframes: {} })
  })
  useEditorStore.getState().toast({ kind: 'success', title: `${def.name} applied`, detail: 'Edit it in Effect Controls' })
}

export function EffectsPresetsPanel() {
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const toast = useEditorStore(s => s.toast)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({ anime: true })
  const defs = useMemo(() => [...EFFECT_DEFS, ...getPluginEffectDefs()], [])
  const groups = useMemo(() => {
    const m = new Map<string, typeof defs>()
    for (const d of defs) {
      const k = d.pluginId ? `plugin:${d.pluginName ?? 'Plugins'}` : d.category
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(d)
    }
    return [...m.entries()].sort((a, b) => (CAT_NAMES[a[0]] ?? a[0]).localeCompare(CAT_NAMES[b[0]] ?? b[0]))
  }, [defs])
  const query = q.trim().toLowerCase()
  const apply = (type: string) => {
    if (!selectedClipId) { toast({ kind: 'error', title: 'Select a layer first', detail: 'Or drag the effect onto a layer in the timeline' }); return }
    applyEffectToClip(selectedClipId, type)
  }
  return (
    <div className="flex flex-col h-full min-h-0 text-[12px]">
      <div className="px-2 py-1.5 shrink-0">
        <div className="relative">
          <Search size={12} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input className="ginput w-full !pl-6 !py-0.5 !text-[12px]" placeholder="Search effects" value={q} onChange={e => setQ(e.target.value)} />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto as-scroll pb-2">
        {groups.map(([cat, items]) => {
          const shown = query ? items.filter(d => d.name.toLowerCase().includes(query) || d.description.toLowerCase().includes(query)) : items
          if (query && shown.length === 0) return null
          const isOpen = query ? true : !!open[cat]
          return (
            <div key={cat}>
              <button className="w-full flex items-center gap-1 h-[21px] px-1 text-zinc-300 hover:bg-[#2c2c2c]" onClick={() => setOpen(o => ({ ...o, [cat]: !o[cat] }))}>
                {isOpen ? <ChevronDown size={12} className="text-zinc-500" /> : <ChevronRight size={12} className="text-zinc-500" />}
                <span className="truncate">{cat.startsWith('plugin:') ? cat.slice(7) : CAT_NAMES[cat] ?? cat}</span>
              </button>
              {isOpen && shown.map(d => (
                <div
                  key={d.type}
                  draggable
                  onDragStart={e => { e.dataTransfer.setData('application/x-as-effect', d.type); e.dataTransfer.effectAllowed = 'copy' }}
                  onDoubleClick={() => apply(d.type)}
                  onClick={e => { if ((e.nativeEvent as PointerEvent).pointerType === 'touch') apply(d.type) }}
                  className="flex items-center gap-1.5 h-[21px] pl-6 pr-2 text-zinc-300 hover:bg-[#3d4b5c] hover:text-white cursor-default"
                  title={`${d.description}\nDouble-click to apply to the selected layer, or drag onto a layer`}
                >
                  <span className="text-[9px] font-bold px-[3px] rounded-[2px] bg-[#5b4a8a] text-white leading-[13px]">fx</span>
                  <span className="truncate">{d.name}</span>
                  {d.heavy && <span className="ml-auto text-[9px] text-zinc-500">GPU</span>}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ============================================================ Info

export function InfoPanel() {
  const cursor = useUIStore(s => s.cursor)
  const doc = useEditorStore(s => s.doc)
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const t = usePlayheadTime(120)
  const clip = doc.clips.find(c => c.id === selectedClipId) ?? null
  const fps = doc.composition.fps
  return (
    <div className="px-3 py-2 text-[11px] leading-[17px] grid grid-cols-2 gap-x-3 as-mono">
      <div className="text-zinc-400">X: <span className="text-zinc-200">{cursor ? Math.round(cursor.x + doc.composition.width / 2) : '—'}</span></div>
      <div className="text-zinc-400">Y: <span className="text-zinc-200">{cursor ? Math.round(doc.composition.height / 2 - cursor.y) : '—'}</span></div>
      <div className="col-span-2 mt-1 font-sans text-zinc-200 truncate">{clip ? clip.name : 'No layer selected'}</div>
      {clip && (
        <>
          <div className="text-zinc-500">In: <span className="text-zinc-300">{timecode(clip.start, fps)}</span></div>
          <div className="text-zinc-500">Out: <span className="text-zinc-300">{timecode(clip.start + clip.duration, fps)}</span></div>
          <div className="text-zinc-500">Dur: <span className="text-zinc-300">{timecode(clip.duration, fps)}</span></div>
          <div className="text-zinc-500">Speed: <span className="text-zinc-300">{clip.speed.toFixed(2)}x</span></div>
        </>
      )}
      <div className="col-span-2 text-zinc-500 mt-1">CTI: <span className="ae-timecode">{timecode(t, fps)}</span></div>
    </div>
  )
}

// ============================================================ Preview

export function PreviewPanel() {
  const [playing, setPlaying] = useState(playbackEngine.state.playing)
  const [loop, setLoop] = useState(playbackEngine.state.loop)
  const [muted, setMuted] = useState(playbackEngine.muted)
  const [rate, setRate] = useState(playbackEngine.state.rate)
  const [quality, setQuality] = useState(playbackEngine.previewQuality)
  useEffect(() => playbackEngine.subscribeThrottled(() => setPlaying(playbackEngine.state.playing), 200), [])
  const btn = 'tb-btn !w-8 !h-8'
  return (
    <div className="px-2 py-2 text-[11px]">
      <div className="flex items-center justify-center gap-0.5">
        <button className={btn} title="First Frame (Home)" onClick={() => playbackEngine.goToStart()}><ChevronFirst size={16} /></button>
        <button className={btn} title="Previous Frame (Page Up)" onClick={() => playbackEngine.stepFrame(-1)}><SkipBack size={15} /></button>
        <button className={`${btn} !w-10`} title="Play/Stop (Space)" onClick={() => { playbackEngine.toggle(); setPlaying(playbackEngine.state.playing) }}>
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button className={btn} title="Next Frame (Page Down)" onClick={() => playbackEngine.stepFrame(1)}><SkipForward size={15} /></button>
        <button className={btn} title="Last Frame (End)" onClick={() => playbackEngine.goToEnd()}><ChevronLast size={16} /></button>
        <button className={btn} data-on={loop ? '1' : '0'} title="Loop" onClick={() => { playbackEngine.setLoop(!loop); setLoop(!loop) }}><Repeat size={14} /></button>
        <button className={btn} data-on={muted ? '1' : '0'} title="Mute Audio" onClick={() => setMuted(playbackEngine.toggleMute())}>{muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
      </div>
      <RamPreviewBox />
      <div className="grid grid-cols-[80px_1fr] gap-y-1.5 items-center mt-2 text-zinc-400">
        <span>Frame Rate</span>
        <select className="ae-vb-select" value={rate} onChange={e => { const r = parseFloat(e.target.value); playbackEngine.setRate(r); setRate(r) }}>
          {[0.25, 0.5, 1, 1.5, 2].map(r => <option key={r} value={r}>{r === 1 ? '(Auto) 1x' : `${r}x`}</option>)}
        </select>
        <span>Resolution</span>
        <select className="ae-vb-select" value={quality} onChange={e => { const q = e.target.value as typeof quality; playbackEngine.setQuality(q); setQuality(q); window.dispatchEvent(new Event('as-quality')) }}>
          <option value="full">Full</option>
          <option value="half">Half</option>
          <option value="quarter">Quarter</option>
        </select>
        <span>Effects</span>
        <label className="flex items-center gap-1.5 text-zinc-300"><input type="checkbox" defaultChecked={!playbackEngine.compareMode} onChange={() => playbackEngine.toggleCompare()} /> Render effects</label>
      </div>
    </div>
  )
}

function RamPreviewBox() {
  const [prog, setProg] = useState<number | null>(null)
  const [, setT] = useState(0)
  useEffect(() => {
    const h = () => setT(t => (t + 1) % 1e6)
    window.addEventListener('as-cache', h)
    return () => window.removeEventListener('as-cache', h)
  }, [])
  const st = playbackEngine.cacheStats
  const run = async () => {
    if (playbackEngine.ramBuilding) { playbackEngine.cancelRamPreview(); return }
    setProg(0)
    await playbackEngine.ramPreview(p => setProg(p))
    setProg(null)
  }
  return (
    <div className="mt-2 p-2 rounded-[3px] bg-[#1d1d1d] border border-[#333]">
      <div className="flex items-center gap-2">
        <button className="gbtn gbtn-accent !px-3 !py-1 text-[11px] flex-1" onClick={() => void run()} title="Render the work area into RAM, then play it in real time (0)">
          {prog !== null ? `Rendering… ${Math.round(prog * 100)}% (Esc cancels)` : 'RAM Preview (0)'}
        </button>
        <button className="gbtn !px-2 !py-1 text-[11px]" title="Purge cache" onClick={() => playbackEngine.clearCache()}>Purge</button>
      </div>
      {prog !== null && <div className="h-[3px] mt-1.5 bg-[#333]"><div className="h-full bg-[#3ccf55]" style={{ width: `${prog * 100}%` }} /></div>}
      <div className="mt-1 text-[10px] text-zinc-500 as-mono">
        <span className="text-[#3ccf55]">{st.frames}</span> frames cached · {st.mb}/{st.budgetMb} MB
        <div className="text-zinc-600 font-sans mt-0.5">Frames you play once replay from RAM. Lower Resolution = more frames fit.</div>
      </div>
    </div>
  )
}

// ============================================================ Align

function layerSize(clip: Clip): [number, number] | null {
  const d = useEditorStore.getState().doc
  if (clip.kind === 'video' || clip.kind === 'image') {
    const a = d.assets.find(a => a.id === (clip as VideoClip).assetId)
    if (!a || !a.width) return null
    // the compositor fits footage to the comp height-wise like AE "fit"; use source size × scale
    return [a.width * clip.scale, a.height * clip.scale]
  }
  if (clip.kind === 'shape') return [clip.shape.width * clip.scale, clip.shape.height * clip.scale]
  if (clip.kind === 'solid' || clip.kind === 'adjustment') return [d.composition.width * clip.scale, d.composition.height * clip.scale]
  return null
}

export function AlignPanel() {
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const doc = useEditorStore(s => s.doc)
  const clip = doc.clips.find(c => c.id === selectedClipId) ?? null
  const W = doc.composition.width, H = doc.composition.height
  const align = (axis: 'x' | 'y', where: -1 | 0 | 1) => {
    if (!clip) return
    const size = layerSize(clip)
    const half = size ? (axis === 'x' ? size[0] : size[1]) / 2 : 0
    const lim = (axis === 'x' ? W : H) / 2
    // comp coordinates are centre-origin, y-up
    let v = 0
    if (where !== 0) v = axis === 'x' ? where * (lim - half) : -where * (lim - half)
    writeProp(clip.id, axis, Math.round(v))
  }
  const b = 'tb-btn !w-8 !h-8'
  return (
    <div className="px-2 py-2 text-[11px] text-zinc-400">
      <div className="mb-1">Align Layers to: <span className="text-zinc-200">Composition</span></div>
      <div className="flex gap-0.5">
        <button className={b} disabled={!clip} title="Align Left" onClick={() => align('x', -1)}><AlignHorizontalJustifyStart size={15} /></button>
        <button className={b} disabled={!clip} title="Align Horizontal Center" onClick={() => align('x', 0)}><AlignHorizontalJustifyCenter size={15} /></button>
        <button className={b} disabled={!clip} title="Align Right" onClick={() => align('x', 1)}><AlignHorizontalJustifyEnd size={15} /></button>
        <span className="w-2" />
        <button className={b} disabled={!clip} title="Align Top" onClick={() => align('y', -1)}><AlignVerticalJustifyStart size={15} /></button>
        <button className={b} disabled={!clip} title="Align Vertical Center" onClick={() => align('y', 0)}><AlignVerticalJustifyCenter size={15} /></button>
        <button className={b} disabled={!clip} title="Align Bottom" onClick={() => align('y', 1)}><AlignVerticalJustifyEnd size={15} /></button>
      </div>
      {clip && <div className="mt-1 text-zinc-500">Position {Math.round(evalProperty(clip, 'x', playbackEngine.currentTime - clip.start))}, {Math.round(evalProperty(clip, 'y', playbackEngine.currentTime - clip.start))}</div>}
    </div>
  )
}

// ============================================================ Composition Settings (Ctrl+K)

const PRESETS = [
  { name: 'HD·1080 30', w: 1920, h: 1080, fps: 30 },
  { name: 'HD·1080 24', w: 1920, h: 1080, fps: 24 },
  { name: 'HD·1080 60', w: 1920, h: 1080, fps: 60 },
  { name: 'Vertical 1080×1920 30', w: 1080, h: 1920, fps: 30 },
  { name: 'Square 1080 30', w: 1080, h: 1080, fps: 30 },
  { name: 'UHD 4K 30', w: 3840, h: 2160, fps: 30 },
  { name: 'HD·720 30', w: 1280, h: 720, fps: 30 },
]

export function CompSettingsDialog({ onClose }: { onClose: () => void }) {
  const doc = useEditorStore(s => s.doc)
  const mutate = useEditorStore(s => s.mutate)
  const renameProject = useEditorStore(s => s.renameProject)
  const [name, setName] = useState(doc.name)
  const [w, setW] = useState(doc.composition.width)
  const [h, setH] = useState(doc.composition.height)
  const [fps, setFps] = useState(doc.composition.fps)
  const [dur, setDur] = useState(doc.composition.duration)
  const [bg, setBg] = useState(doc.composition.background)
  const [shutter, setShutter] = useState(doc.composition.shutterAngle ?? 180)
  const [lock, setLock] = useState(true)
  const ar = doc.composition.width / doc.composition.height
  const preset = PRESETS.find(p => p.w === w && p.h === h && p.fps === fps)?.name ?? 'Custom'
  const ok = () => {
    if (name.trim() && name !== doc.name) renameProject(name.trim())
    mutate(d => {
      d.composition.width = Math.max(16, Math.min(8192, Math.round(w)))
      d.composition.height = Math.max(16, Math.min(8192, Math.round(h)))
      d.composition.fps = Math.max(1, Math.min(120, fps))
      d.composition.duration = Math.max(0.5, Math.min(3600, dur))
      d.composition.background = bg
      d.composition.shutterAngle = Math.max(0, Math.min(720, shutter))
    })
    onClose()
  }
  const lbl = 'text-zinc-400 text-right pr-2'
  return (
    <div className="p-4 text-[12px] w-[440px] max-w-full">
      <div className="grid grid-cols-[130px_1fr] items-center gap-y-2">
        <span className={lbl}>Composition Name:</span>
        <input className="ginput" value={name} onChange={e => setName(e.target.value)} />
        <span className={lbl}>Preset:</span>
        <select className="ginput" value={preset} onChange={e => { const p = PRESETS.find(p => p.name === e.target.value); if (p) { setW(p.w); setH(p.h); setFps(p.fps) } }}>
          {PRESETS.map(p => <option key={p.name}>{p.name}</option>)}
          <option>Custom</option>
        </select>
        <span className={lbl}>Width:</span>
        <div className="flex items-center gap-2">
          <input className="ginput w-20" type="number" value={w} onChange={e => { const v = +e.target.value; setW(v); if (lock) setH(Math.round(v / ar)) }} /> px
          <label className="flex items-center gap-1 text-zinc-400 ml-2"><input type="checkbox" checked={lock} onChange={e => setLock(e.target.checked)} /> Lock Aspect Ratio</label>
        </div>
        <span className={lbl}>Height:</span>
        <div className="flex items-center gap-2"><input className="ginput w-20" type="number" value={h} onChange={e => { const v = +e.target.value; setH(v); if (lock) setW(Math.round(v * ar)) }} /> px</div>
        <span className={lbl}>Frame Rate:</span>
        <select className="ginput w-32" value={fps} onChange={e => setFps(+e.target.value)}>
          {[12, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60].map(f => <option key={f} value={f}>{f}</option>)}
        </select>
        <span className={lbl}>Duration:</span>
        <div className="flex items-center gap-2"><input className="ginput w-24" type="number" step={0.5} value={dur} onChange={e => setDur(+e.target.value)} /> s <span className="ae-timecode text-[11px]">{timecode(dur, fps)}</span></div>
        <span className={lbl}>Shutter Angle:</span>
        <div className="flex items-center gap-2"><input className="ginput w-20" type="number" min={0} max={720} value={shutter} onChange={e => setShutter(+e.target.value)} /> ° <span className="text-zinc-500 text-[11px]">motion blur length (180 = film look)</span></div>
        <span className={lbl}>Background Color:</span>
        <div className="flex items-center gap-2"><input type="color" value={bg} onChange={e => setBg(e.target.value)} className="w-8 h-6 bg-transparent" /><span className="as-mono text-zinc-500">{bg}</span></div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button className="gbtn px-4 py-1" onClick={onClose}>Cancel</button>
        <button className="gbtn gbtn-accent px-5 py-1" onClick={ok}>OK</button>
      </div>
    </div>
  )
}

// ============================================================ Keyboard shortcuts

export const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / stop preview'],
  ['Home / End', 'Go to start / end'],
  ['Page Up / Page Down, ← / →', 'Previous / next frame (Shift = 10 frames)'],
  ['J / K', 'Previous / next keyframe'],
  ['B / N', 'Set work area start / end'],
  ['V · H · Z · W · Y · Q · G · Ctrl+T', 'Selection · Hand · Zoom · Rotation · Pan Behind · Rectangle · Pen · Type'],
  ['P · S · R · T · A · U', 'Reveal Position · Scale · Rotation · Opacity · Anchor · animated props'],
  ['Shift + P/S/R/T/A', 'Add property to the revealed set'],
  ['[ / ]', 'Move layer in / out point to CTI'],
  ['Alt + [ / ]', 'Trim layer in / out point to CTI'],
  ['Ctrl + [ / ]', 'Send backward / bring forward'],
  ['Ctrl+D', 'Duplicate layer(s)'],
  ['Ctrl+C / Ctrl+V', 'Copy / paste keyframes (at the CTI) or layers'],
  ['Ctrl+A · Ctrl/Shift+click', 'Select all layers · add to selection'],
  ['Ctrl+Shift+C', 'Pre-compose selected layers'],
  ['0 / Numpad 0', 'RAM Preview (render work area to memory, play real time)'],
  ['Alt+click stopwatch', 'Add / remove expression'],
  ['Ctrl+Shift+D', 'Split layer'],
  ['Ctrl+Y', 'New solid'],
  ['Ctrl+Alt+Shift+T / Y', 'New text layer / null object'],
  ['Ctrl+Alt+Y', 'New adjustment layer'],
  ['Ctrl+K', 'Composition settings'],
  ['Ctrl+M', 'Add to render queue (export)'],
  ['Ctrl+I', 'Import file'],
  ['Ctrl+S', 'Save project'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
  ['F9', 'Easy ease selected keyframe'],
  ['F3', 'Effect controls'],
  ['Delete', 'Delete selected keyframe or layer'],
  ['M', 'Add marker'],
  ['Ctrl + wheel / + −', 'Zoom viewer'],
  ['Shift+/ (?)', 'This list'],
]

export function ShortcutsPanel() {
  return (
    <div className="p-3 text-[12px] w-[560px] max-w-full">
      {SHORTCUTS.map(([k, v]) => (
        <div key={k} className="flex gap-3 py-[3px] border-b border-[#2c2c2c]">
          <span className="w-56 shrink-0 as-mono text-[11px] text-amber-300">{k}</span>
          <span className="text-zinc-300">{v}</span>
        </div>
      ))}
    </div>
  )
}

export function useOutsideClick(ref: React.RefObject<HTMLElement | null>, fn: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return
    const h = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) fn() }
    window.addEventListener('pointerdown', h, true)
    return () => window.removeEventListener('pointerdown', h, true)
  }, [ref, fn, active])
}

export function useNoop() { return useRef(null) }
