'use client'
/**
 * ANIME STUDIO — Mobile workspace (CapCut-style).
 *
 * Rendered ONLY by Workspace.tsx when the viewport is < 1024px. The desktop
 * (After Effects) layout is untouched. Reuses the same engine, store, Timeline,
 * PreviewMonitor and panels — this file is just a different shell:
 *   preview (top) → transport → timeline → bottom tool strip.
 * With a clip selected the strip switches to that clip's contextual tools.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useEditorStore } from '@/lib/store/editorStore'
import { playbackEngine } from '@/lib/engine/playback'
import { mediaManager } from '@/lib/media/mediaManager'
import { uid } from '@/lib/engine/types'
import { PreviewMonitor, TransportBar } from './PreviewMonitor'
import { Timeline } from './Timeline'
import { MobileQuick, type QuickTab } from './MobileQuick'
import {
  Undo2, Redo2, FolderOpen, Film, Wand2, SlidersHorizontal, AudioLines, Gauge, Type,
  Palette, Settings, Sparkles, Puzzle, Crosshair, Layers, Scissors, Trash2, Copy,
  ChevronLeft, X, Check, Upload, Smile, Subtitles, Blend, Snowflake,
  MousePointer2, Hand, RotateCw, Square, PenTool,
} from 'lucide-react'
import { useUIStore, type ToolId } from '@/lib/store/uiStore'

const MOBILE_TOOLS: { id: ToolId; label: string; icon: ReactNode }[] = [
  { id: 'select', label: 'Selection tool', icon: <MousePointer2 size={16} /> },
  { id: 'hand', label: 'Hand tool', icon: <Hand size={16} /> },
  { id: 'rotate', label: 'Rotation tool', icon: <RotateCw size={16} /> },
  { id: 'rect', label: 'Rectangle tool', icon: <Square size={16} /> },
  { id: 'pen', label: 'Pen tool', icon: <PenTool size={16} /> },
  { id: 'text', label: 'Type tool', icon: <Type size={16} /> },
]

type PanelMap = Record<string, { title: string; el: ReactNode }>
type Tool = { id: string; label: string; icon: ReactNode; onClick: () => void; danger?: boolean; accent?: boolean }

export function MobileWorkspace({ panels }: { panels: PanelMap }) {
  const undo = useEditorStore(s => s.undo)
  const redo = useEditorStore(s => s.redo)
  const canUndo = useEditorStore(s => s.past.length > 0)
  const canRedo = useEditorStore(s => s.future.length > 0)
  const activePanel = useEditorStore(s => s.activePanel)
  const setPanel = useEditorStore(s => s.setPanel)
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const select = useEditorStore(s => s.select)
  const mutate = useEditorStore(s => s.mutate)
  const toasts = useEditorStore(s => s.toasts)
  const dismissToast = useEditorStore(s => s.dismissToast)
  const preview = useEditorStore(s => s.preview)
  const approvePreview = useEditorStore(s => s.approvePreview)
  const rejectPreview = useEditorStore(s => s.rejectPreview)

  const [quick, setQuick] = useState<QuickTab | null>(null)
  const tool = useUIStore(s => s.tool)
  const setTool = useUIStore(s => s.setTool)
  const open = (p: string) => () => { setQuick(null); setPanel(p as never) }
  const openQuick = (t: QuickTab) => () => { setPanel(null); setQuick(t) }
  // a panel opened from elsewhere (e.g. timeline) replaces the quick sheet
  useEffect(() => { if (activePanel) setQuick(null) }, [activePanel])

  const splitAtPlayhead = () => {
    const id = selectedClipId
    if (!id) return
    const t = playbackEngine.currentTime
    mutate(d => {
      const clip = d.clips.find(c => c.id === id)
      if (!clip) return
      const at = t - clip.start
      if (at <= 0.05 || at >= clip.duration - 0.05) return
      const right = JSON.parse(JSON.stringify(clip))
      right.id = uid('clip')
      right.start = clip.start + at
      right.duration = clip.duration - at
      right.keyframes = (right.keyframes ?? [])
        .map((k: { keyframes: { time: number }[] }) => ({
          ...k, keyframes: k.keyframes.filter(kf => kf.time >= at).map(kf => ({ ...kf, time: kf.time - at })),
        }))
        .filter((k: { keyframes: unknown[] }) => k.keyframes.length > 0)
      // NOTE: right is a clone of clip, so its kind matches; TS still needs
      // clip narrowed to VideoClip|AudioClip before touching clip.inPoint.
      if (right.kind === 'video' || right.kind === 'audio') {
        if (clip.kind === 'video' || clip.kind === 'audio') right.inPoint = clip.inPoint + at * clip.speed
      }
      clip.duration = at
      d.clips.push(right)
    })
  }
  /** Freeze frame: holds the frame at the playhead for 1.5 s (near-still: speed floor is 0.05x) and ripples later clips. */
  const freezeFrame = () => {
    const id = selectedClipId
    if (!id) return
    const t = playbackEngine.currentTime
    const HOLD = 1.5
    const res = { ok: false }
    mutate(d => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clip: any = d.clips.find(c => c.id === id)
      if (!clip || (clip.kind !== 'video' && clip.kind !== 'image')) return
      const at = t - clip.start
      if (at <= 0.05 || at >= clip.duration - 0.05) return
      const tailStart = clip.start + clip.duration
      const mid = JSON.parse(JSON.stringify(clip))
      const right = JSON.parse(JSON.stringify(clip))
      mid.id = uid('clip'); right.id = uid('clip')
      mid.start = t; mid.duration = HOLD; mid.speed = 0.05; mid.timeRemap = null; mid.keyframes = []
      if ('volume' in mid) mid.volume = 0
      right.start = t + HOLD; right.duration = clip.duration - at
      if (clip.kind === 'video') { const ip = clip.inPoint + at * clip.speed; mid.inPoint = ip; right.inPoint = ip }
      right.keyframes = (clip.keyframes ?? [])
        .map((k: { keyframes: { time: number }[] }) => ({
          ...k, keyframes: k.keyframes.filter(kf => kf.time >= at).map(kf => ({ ...kf, time: kf.time - at })),
        }))
        .filter((k: { keyframes: unknown[] }) => k.keyframes.length > 0)
      for (const c of d.clips) if (c.id !== id && c.trackId === clip.trackId && c.start >= tailStart - 0.001) c.start += HOLD
      clip.duration = at
      d.clips.push(mid, right)
      res.ok = true
    })
    useEditorStore.getState().toast(res.ok
      ? { kind: 'success', title: 'Freeze frame added', detail: '1.5 s hold at the playhead' }
      : { kind: 'info', title: 'Move the playhead inside the selected video/image clip' })
  }
  const duplicate = () => {
    const id = selectedClipId
    if (!id) return
    mutate(d => {
      const clip = d.clips.find(c => c.id === id)
      if (!clip) return
      const copy = JSON.parse(JSON.stringify(clip))
      copy.id = uid('clip')
      copy.start = clip.start + clip.duration
      d.clips.push(copy)
    })
  }
  const remove = () => {
    const id = selectedClipId
    if (!id) return
    mutate(d => { d.clips = d.clips.filter(c => c.id !== id) })
    select(null)
    mediaManager.releaseClip(id)
  }

  const mainTools: Tool[] = [
    { id: 'assets', label: 'Media', icon: <Film size={20} />, onClick: open('assets') },
    { id: 'audio', label: 'Audio', icon: <AudioLines size={20} />, onClick: open('audio') },
    { id: 'text', label: 'Text', icon: <Type size={20} />, onClick: open('text') },
    { id: 'captions', label: 'Captions', icon: <Subtitles size={20} />, onClick: openQuick('captions') },
    { id: 'stickers', label: 'Stickers', icon: <Smile size={20} />, onClick: openQuick('stickers') },
    { id: 'effects', label: 'Effects', icon: <Wand2 size={20} />, onClick: openQuick('effects') },
    { id: 'filters', label: 'Filters', icon: <Palette size={20} />, onClick: openQuick('filters') },
    { id: 'enhance', label: 'Video Lab', icon: <Sparkles size={20} />, onClick: open('videolab') },
    { id: 'extensions', label: 'Scripts', icon: <Sparkles size={20} />, onClick: open('extensions') },
    { id: 'plugins', label: 'Plugins', icon: <Puzzle size={20} />, onClick: open('plugins') },
    { id: 'beatsync', label: 'Beat Sync', icon: <AudioLines size={20} />, onClick: open('beatsync') },
    { id: 'ai', label: 'AI Edit', icon: <Wand2 size={20} />, onClick: open('ai'), accent: true },
    { id: 'settings', label: 'Settings', icon: <Settings size={20} />, onClick: open('settings') },
  ]
  const clipTools: Tool[] = [
    { id: 'back', label: 'Back', icon: <ChevronLeft size={20} />, onClick: () => select(null) },
    { id: 'split', label: 'Split', icon: <Scissors size={20} />, onClick: splitAtPlayhead },
    { id: 'freeze', label: 'Freeze', icon: <Snowflake size={20} />, onClick: freezeFrame },
    { id: 'transition', label: 'Transition', icon: <Blend size={20} />, onClick: openQuick('transitions') },
    { id: 'speed', label: 'Speed', icon: <Gauge size={20} />, onClick: open('speed') },
    { id: 'audio', label: 'Volume', icon: <AudioLines size={20} />, onClick: open('audio') },
    { id: 'effects', label: 'Effects', icon: <Wand2 size={20} />, onClick: openQuick('effects') },
    { id: 'color', label: 'Adjust', icon: <Palette size={20} />, onClick: open('color') },
    { id: 'inspector', label: 'Edit', icon: <SlidersHorizontal size={20} />, onClick: open('inspector') },
    { id: 'graph', label: 'Curve', icon: <Layers size={20} />, onClick: open('graph') },
    { id: 'tracker', label: 'Track', icon: <Crosshair size={20} />, onClick: open('tracker') },
    { id: 'cutout', label: 'Cut-out', icon: <Scissors size={20} />, onClick: open('cutout') },
    { id: 'enhance', label: 'Video Lab', icon: <Sparkles size={20} />, onClick: open('videolab') },
    { id: 'extensions', label: 'Scripts', icon: <Sparkles size={20} />, onClick: open('extensions') },
    { id: 'dup', label: 'Duplicate', icon: <Copy size={20} />, onClick: duplicate },
    { id: 'del', label: 'Delete', icon: <Trash2 size={20} />, onClick: remove, danger: true },
  ]
  const tools = selectedClipId ? clipTools : mainTools
  const sheet = activePanel ? panels[activePanel] : null

  return (
    <div
      className="ae-app fixed inset-0 flex flex-col text-zinc-200"
      style={{
        paddingTop: 'env(safe-area-inset-top)', paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)', paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {/* top bar */}
      <header className="h-12 shrink-0 flex items-center gap-1 px-2 no-select bg-[#262626] border-b border-black">
        <button className="tb-btn" onClick={open('projects')} aria-label="Projects"><FolderOpen size={18} /></button>
        <div className="flex-1 flex items-center justify-center gap-0.5">
          {MOBILE_TOOLS.map(t => (
            <button key={t.id} className="ae-tool !w-8 !h-8" data-on={tool === t.id ? '1' : '0'} onClick={() => setTool(t.id)} aria-label={t.label}>{t.icon}</button>
          ))}
        </div>
        <button className="tb-btn" disabled={!canUndo} onClick={undo} aria-label="Undo"><Undo2 size={18} /></button>
        <button className="tb-btn" disabled={!canRedo} onClick={redo} aria-label="Redo"><Redo2 size={18} /></button>
        <button
          className="ml-1 h-8 px-3 rounded-[4px] bg-amber-500 text-white text-xs font-semibold flex items-center gap-1.5 active:scale-95 transition-transform"
          onClick={open('export')}
        >
          <Upload size={14} /> Export
        </button>
      </header>

      {/* AI draft approve / reject */}
      {preview && (
        <div className="shrink-0 mx-2 mb-1 flex items-center gap-2 px-3 py-1.5 rounded-xl bg-violet-950/80 border border-violet-500/40 text-xs text-violet-200">
          <Sparkles size={14} /> <span className="flex-1">AI draft preview</span>
          <button className="px-2.5 py-1 rounded-lg bg-emerald-500/90 text-zinc-950 font-semibold flex items-center gap-1" onClick={() => approvePreview()}><Check size={12} />Keep</button>
          <button className="px-2.5 py-1 rounded-lg bg-white/10 flex items-center gap-1" onClick={() => rejectPreview()}><X size={12} />Discard</button>
        </div>
      )}

      {/* preview + transport — must be flex so PreviewMonitor's flex-1 fills the height */}
      <div className="flex-1 min-h-0 relative flex flex-col"><PreviewMonitor ae /></div>
      <div className="shrink-0"><TransportBar /></div>

      {/* timeline */}
      <div className="shrink-0 min-h-0 border-t border-white/10" style={{ height: '34vh' }}><Timeline /></div>

      {/* tool strip */}
      <nav className="h-[64px] shrink-0 flex items-stretch overflow-x-auto as-scroll no-select bg-[#262626] border-t border-black">
        {tools.map(t => (
          <button
            key={t.id}
            onClick={t.onClick}
            className={`min-w-[66px] flex flex-col items-center justify-center gap-1 active:scale-90 transition-transform ${
              t.danger ? 'text-red-400' : t.accent ? 'text-violet-300' : 'text-zinc-300'}`}
          >
            {t.icon}
            <span className="text-[10px] leading-none">{t.label}</span>
          </button>
        ))}
      </nav>

      {/* bottom sheet: preview stays visible above it */}
      {sheet && !quick && (
        <div className="absolute left-0 right-0 bottom-0 z-50 max-h-[62vh] rounded-t-[24px] glass-strong flex flex-col glass-in"
             style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <div className="ae-grabber" />
          <div className="h-11 shrink-0 flex items-center px-4 border-b border-white/10">
            <span className="text-[12px] font-semibold text-zinc-100 flex-1">{sheet.title}</span>
            <button className="tb-btn" onClick={() => setPanel(null)} aria-label="Close"><X size={18} /></button>
          </div>
          <div className="ae-sheet overflow-y-auto as-scroll min-h-0 flex-1 overscroll-contain px-1">{sheet.el}</div>
        </div>
      )}

      {quick && <MobileQuick tab={quick} onTab={setQuick} onClose={() => setQuick(null)} />}

      {/* toasts */}
      <div className="absolute top-12 right-2 left-2 z-[60] space-y-1.5 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} onClick={() => dismissToast(t.id)}
               className={`pointer-events-auto p-2.5 rounded-[4px] glass-strong text-xs ${
                 t.kind === 'error' ? '!bg-red-950/85 text-red-200' : t.kind === 'success' ? '!bg-emerald-950/85 text-emerald-200'
                 : t.kind === 'ai' ? '!bg-violet-950/85 text-violet-200' : 'text-zinc-200'}`}>
            <div className="font-medium">{t.title}</div>
            {t.detail && <div className="text-[10px] opacity-80 mt-0.5 break-words">{t.detail}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
