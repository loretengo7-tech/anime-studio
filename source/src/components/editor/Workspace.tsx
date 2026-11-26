'use client'
/**
 * ANIME STUDIO — Workspace shell (AE-style)
 *
 * Desktop (≥1024px): After Effects layout — left Project dock, center viewer,
 * right Effects/Properties dock, bottom timeline. Docks resize, collapse and
 * remember their layout (localStorage).
 * Mobile (<1024px): proven bottom-sheet panels + tool rail.
 *
 * Keyboard: Space play/pause · ←/→ frame step (Shift = 10) · Home/End ·
 * Delete removes the selected layer · Ctrl/Cmd+Z / Shift+Z undo-redo ·
 * M adds a marker.
 */
import { useEffect, useRef, useState } from 'react'
import { useEditorStore } from '@/lib/store/editorStore'
import { playbackEngine } from '@/lib/engine/playback'
import { mediaManager } from '@/lib/media/mediaManager'
import { PreviewMonitor, TransportBar } from './PreviewMonitor'
import { Timeline } from './Timeline'
import { Inspector } from './Inspector'
import { GraphEditor } from './GraphEditor'
import { AIAssistant } from './AIAssistant'
import { ExportDialog } from './ExportDialog'
import { SpeedPanel } from './SpeedPanel'
import { AudioPanel } from './AudioPanel'
import { EnhancePanel } from './EnhancePanel'
import { TrackerPanel } from './TrackerPanel'
import { SettingsPanel } from './SettingsPanel'
import { MobileWorkspace } from './MobileWorkspace'
import { BeatSyncPanel } from './BeatSyncPanel'
import { CutoutPanel } from './CutoutPanel'
import { AEWorkspace } from './ae/AEWorkspace'
import {
  AssetsPanel, EffectsPanel, TextPanel, ColorPanel, CompPanel, ProjectsPanel, StatusPanel, PluginsPanel,
} from './panels'
import {
  Undo2, Redo2, Download, FolderOpen, Film, Wand2, SlidersHorizontal, AudioLines,
  Gauge, Type, Palette, Settings, CircleCheck, CheckCircle2, X, Layers, Sparkles, Info,
  Crosshair, Puzzle, PanelLeftClose, PanelRightClose, PanelLeftOpen, PanelRightOpen,
} from 'lucide-react'
import type { PanelKind } from './panelRegistry'
import { STATIC_MODE, restoreLocalAssets } from '@/lib/media/staticMode'
import { recoverAutosave } from '@/lib/store/editorStore'
import { restoreCustomFonts } from '@/lib/media/fonts'

type EditorStore = ReturnType<typeof useEditorStore.getState>

interface DockLayout { leftW: number; rightW: number; leftCollapsed: boolean; rightCollapsed: boolean; timelineH: number }
const DOCK_KEY = 'anime-studio:workspace'
const DEFAULT_DOCKS: DockLayout = { leftW: 280, rightW: 320, leftCollapsed: false, rightCollapsed: false, timelineH: 260 }

function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatch(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return match
}

export function Workspace() {
  const doc = useEditorStore(s => s.doc)
  const undo = useEditorStore(s => s.undo)
  const redo = useEditorStore(s => s.redo)
  const canUndo = useEditorStore(s => s.past.length > 0)
  const canRedo = useEditorStore(s => s.future.length > 0)
  const activePanel = useEditorStore(s => s.activePanel)
  const setPanel = useEditorStore(s => s.setPanel)
  const toasts = useEditorStore(s => s.toasts)
  const dismissToast = useEditorStore(s => s.dismissToast)
  const preview = useEditorStore(s => s.preview)
  const approvePreview = useEditorStore(s => s.approvePreview)
  const rejectPreview = useEditorStore(s => s.rejectPreview)
  const saveState = useEditorStore(s => s.saveState)
  const jobs = useEditorStore(s => s.jobs)

  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const [docks, setDocks] = useState<DockLayout>(() => {
    if (typeof window === 'undefined') return DEFAULT_DOCKS
    try {
      const raw = localStorage.getItem(DOCK_KEY)
      return raw ? { ...DEFAULT_DOCKS, ...JSON.parse(raw) } : DEFAULT_DOCKS
    } catch { return DEFAULT_DOCKS }
  })
  const persistDocks = (next: DockLayout) => {
    setDocks(next)
    try { localStorage.setItem(DOCK_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  }
  const dragRef = useRef<{ kind: 'left' | 'right' | 'timeline'; startPos: number; startSize: number } | null>(null)
  const [ready, setReady] = useState(false)

  // boot: register assets + set doc + autosave loop
  useEffect(() => {
    const store = useEditorStore.getState()
    playbackEngine.setDoc(store.doc)
    const register = (assets: typeof store.doc.assets) => {
      for (const a of assets) {
        mediaManagerRegister(a)
      }
    }
    if (STATIC_MODE) {
      // rebuild live blob URLs from IndexedDB so media survives reloads
      void restoreLocalAssets(store.doc.assets).then(patched => {
        const changed = patched.some((p, i) => p.url !== store.doc.assets[i].url)
        if (changed) {
          useEditorStore.setState(s => ({ doc: { ...s.doc, assets: patched } }))
        }
        register(patched)
        void import('@/lib/media/proxy').then(m => m.restoreLocalProxies(patched))
      })
    } else {
      register(store.doc.assets)
      void import('@/lib/media/proxy').then(m => m.restoreLocalProxies(store.doc.assets))
    }
    // iPhone Safari: block pinch/double-tap page zoom gestures inside the editor
    const preventGesture = (e: Event) => e.preventDefault()
    document.addEventListener('gesturestart', preventGesture, { passive: false })
    document.addEventListener('gesturechange', preventGesture, { passive: false })
    const preventDoubleTap = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target && target.closest('input, textarea, [contenteditable]')) return
      e.preventDefault()
    }
    document.addEventListener('dblclick', preventDoubleTap);
    // debug handle for console inspection
    (window as unknown as Record<string, unknown>).__AS = {
      ...((window as unknown as Record<string, unknown>).__AS ?? {}),
      playbackEngine,
      compositor: playbackEngine.compositor,
      store: useEditorStore,
      mediaManager,
    }
    setReady(true)
    // IndexedDB autosave recovery (localStorage may have been cleared/blocked)
    void recoverAutosave()
    // re-register fonts the user installed (FontFace + IndexedDB)
    void restoreCustomFonts().catch(() => { /* font restore is cosmetic — report via fonts module */ })
    const iv = setInterval(() => {
      const s = useEditorStore.getState()
      if (s.saveState === 'dirty') s.saveLocal()
    }, 5000)
    // iOS audio unlock on first touch
    const unlock = () => {
      void import('@/lib/engine/audio').then(({ audioEngine }) => audioEngine.unlock())
      window.removeEventListener('touchstart', unlock)
    }
    window.addEventListener('touchstart', unlock, { once: true })
    window.addEventListener('pointerdown', unlock, { once: true })
    // PWA service worker — production/static builds only (never in dev, HMR conflicts)
    // NEXT_PUBLIC_BASE_PATH keeps it working on GitHub Pages sub-path hosting too.
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator && !(window as unknown as { animeStudioDesktop?: unknown }).animeStudioDesktop && location.protocol !== 'app:') {
      const bp = process.env.NEXT_PUBLIC_BASE_PATH || ''
      navigator.serviceWorker.register(`${bp}/sw.js`).catch(() => { /* offline install is best-effort */ })
    }
    return () => {
      clearInterval(iv)
      document.removeEventListener('gesturestart', preventGesture)
      document.removeEventListener('gesturechange', preventGesture)
      document.removeEventListener('dblclick', preventDoubleTap)
    }
  }, [])

  // doc replacement (undo/redo/project switch) → re-sync engine.
  // AI preview mode renders the DRAFT for real (was only claimed before).
  useEffect(() => {
    if (ready) playbackEngine.setDoc(preview ? preview.draft : doc)
  }, [doc, preview, ready])

  // ---- global keyboard shortcuts (tablet/phone with keyboard; desktop uses AEWorkspace's AE set) ----
  useEffect(() => {
    if (isDesktop) return
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable || tgt.tagName === 'SELECT')) return
      const s = useEditorStore.getState()
      const fps = Math.max(1, s.doc.composition.fps)
      switch (e.key) {
        case ' ':
          e.preventDefault()
          playbackEngine.toggle()
          break
        case 'ArrowLeft':
          e.preventDefault()
          playbackEngine.pause()
          playbackEngine.stepFrame(e.shiftKey ? -10 : -1)
          break
        case 'ArrowRight':
          e.preventDefault()
          playbackEngine.pause()
          playbackEngine.stepFrame(e.shiftKey ? 10 : 1)
          break
        case 'Home':
          e.preventDefault()
          playbackEngine.pause()
          playbackEngine.seek(0)
          break
        case 'End': {
          e.preventDefault()
          playbackEngine.pause()
          let end = s.doc.composition.duration
          for (const c of s.doc.clips) end = Math.max(end, c.start + c.duration)
          playbackEngine.seek(end)
          break
        }
        case 'Delete':
        case 'Backspace': {
          if (!s.selectedClipId) return
          e.preventDefault()
          const id = s.selectedClipId
          s.mutate(d => { d.clips = d.clips.filter(c => c.id !== id) })
          s.select(null)
          mediaManager.releaseClip(id)
          break
        }
        case 'm':
        case 'M':
          s.mutate(d => { d.markers.push({ id: `mk_${Date.now()}`, time: playbackEngine.currentTime, label: 'Marker', color: '#f59e0b' }) })
          break
        case 'z':
        case 'Z':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            if (e.shiftKey) redo()
            else undo()
          }
          break
        case 'y':
        case 'Y':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); redo() }
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, isDesktop])

  // ---- dock resizing ----
  const onDockDown = (kind: 'left' | 'right' | 'timeline') => (e: React.PointerEvent) => {
    const startSize = kind === 'timeline' ? docks.timelineH : kind === 'left' ? docks.leftW : docks.rightW
    dragRef.current = { kind, startPos: kind === 'timeline' ? e.clientY : e.clientX, startSize }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onDockMove = (e: React.PointerEvent) => {
    const r = dragRef.current
    if (!r) return
    if (r.kind === 'timeline') {
      const next = Math.max(140, Math.min(window.innerHeight - 320, r.startSize - (e.clientY - r.startPos)))
      persistDocks({ ...docks, timelineH: next })
    } else if (r.kind === 'left') {
      const next = Math.max(200, Math.min(560, r.startSize + (e.clientX - r.startPos)))
      persistDocks({ ...docks, leftW: next })
    } else {
      const next = Math.max(240, Math.min(680, r.startSize - (e.clientX - r.startPos)))
      persistDocks({ ...docks, rightW: next })
    }
  }
  const onDockUp = () => { dragRef.current = null }

  const activeJob = jobs.find(j => j.status === 'running')

  const panels: Record<Exclude<PanelKind, null>, { title: string; el: React.ReactNode }> = {
    assets: { title: 'Assets & Media', el: <AssetsPanel /> },
    effects: { title: 'Effects Library', el: <EffectsPanel /> },
    plugins: { title: 'Plugin Manager', el: <PluginsPanel /> },
    inspector: { title: 'Inspector', el: <Inspector /> },
    graph: { title: 'Graph Editor', el: <GraphEditor /> },
    speed: { title: 'Speed & Velocity', el: <SpeedPanel /> },
    audio: { title: 'Audio & Beats', el: <AudioPanel /> },
    text: { title: 'Text Layers', el: <TextPanel /> },
    color: { title: 'Color & LUTs', el: <ColorPanel /> },
    enhance: { title: 'Detail Restore', el: <EnhancePanel /> },
    tracker: { title: 'Motion Tracker', el: <TrackerPanel /> },
    ai: { title: 'AI Assistant', el: <AIAssistant /> },
    projects: { title: 'Projects', el: <ProjectsPanel /> },
    status: { title: 'Feature Status', el: <StatusPanel /> },
    settings: { title: 'Settings', el: <SettingsPanel /> },
    comp: { title: 'Composition', el: <CompPanel /> },
    export: { title: 'Export & Render', el: <ExportDialog /> },
    beatsync: { title: 'Beat Sync', el: <BeatSyncPanel /> },
    cutout: { title: 'AI Cut-out', el: <CutoutPanel /> },
  }

  // which panels dock on the right (desktop); everything else opens as a sheet
  const rightDockPanels: PanelKind[] = ['inspector', 'effects', 'text', 'color', 'graph', 'speed', 'audio', 'enhance', 'tracker', 'ai']
  const rightContent = isDesktop && activePanel && rightDockPanels.includes(activePanel)
    ? panels[activePanel]
    : isDesktop
      ? { title: 'Inspector', el: <Inspector /> }
      : null

  // Mobile (<1024px): CapCut-style shell. Desktop falls through to the AE layout below, unchanged.
  if (!isDesktop) return <MobileWorkspace panels={panels} />
  return <AEWorkspace panels={panels} />
}

function mediaManagerRegister(a: Parameters<typeof import('@/lib/media/mediaManager')['mediaManager']['registerAsset']>[0]) {
  void import('@/lib/media/mediaManager').then(({ mediaManager }) => mediaManager.registerAsset(a))
}

// keep the type import used
export type { PanelKind }
