'use client'
/**
 * ANIME STUDIO — desktop workspace in the After Effects layout.
 *
 *  ┌ menu bar ─────────────────────────────────────────────────────────┐
 *  ├ tools ─────────────────────────────────────── workspaces · export ┤
 *  │ Project | Effect Controls │ Composition viewer │ Info / Preview /  │
 *  │                           │                    │ Effects & Presets │
 *  ├───────────────────────────┴────────────────────┴───────────────────┤
 *  │ Timeline (layers, switches, transform, keyframes, CTI)            │
 *  └───────────────────────────────────────────────────────────────────┘
 * Panels resize with the gutters and remember their layout; floating
 * windows (Composition Settings, Render Queue, Preferences…) open from menus.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useEditorStore } from '@/lib/store/editorStore'
import { useUIStore, type ToolId, type WorkspaceId, type RevealProp } from '@/lib/store/uiStore'
import { playbackEngine } from '@/lib/engine/playback'
import { EFFECT_DEFS } from '@/lib/engine/effects'
import { PreviewMonitor } from '../PreviewMonitor'
import { Inspector } from '../Inspector'
import { downloadProjectFile } from '@/lib/media/projectFile'
import { AETimeline } from './AETimeline'
import {
  ProjectPanel, EffectsPresetsPanel, InfoPanel, PreviewPanel, AlignPanel, CompSettingsDialog, ShortcutsPanel,
  applyEffectToClip, useOutsideClick,
} from './AEPanels'
import {
  newLayer, splitSelected, moveLayer, selectedClip, jumpKeyframe,
  setSelectedKeyEasing, deleteSelectedKeyframe, setWorkArea, clearWorkArea, layerToCTI, trimCompToWorkArea,
  saveFrameAs, pickAndImport, patchClip, copySelection, pasteClipboard, selectAllLayers, deleteSelectedLayers,
  duplicateSelectedLayers, precomposeSelected, closeComp, selectedClips, toggleKeyAtCTI, newComposition, fitLayersToComp, workAreaToSelection,
} from './aeActions'
import {
  MousePointer2, Hand, ZoomIn, RotateCw, Move, Square, Circle, PenTool, Type, Home, Download,
  ChevronDown, ChevronRight, X, Sparkles, CheckCircle2, AlertTriangle, Undo2, Redo2,
} from 'lucide-react'

type PanelEl = { title: string; el: ReactNode }

interface Docks { leftW: number; rightW: number; timelineH: number; leftTab: string; rightTab: string; rightCollapsed: boolean; infoOpen: boolean; previewOpen: boolean; alignOpen: boolean }
const DOCK_KEY = 'anime-studio:ae-docks'
const PRESETS: Record<WorkspaceId, Partial<Docks>> = {
  default: { leftW: 300, rightW: 300, timelineH: 300, leftTab: 'project', rightTab: 'effects', rightCollapsed: false },
  animation: { leftW: 330, rightW: 280, timelineH: 420, leftTab: 'controls', rightTab: 'effects', rightCollapsed: false },
  effects: { leftW: 380, rightW: 320, timelineH: 280, leftTab: 'controls', rightTab: 'effects', rightCollapsed: false },
  minimal: { leftW: 260, rightW: 300, timelineH: 280, leftTab: 'project', rightTab: 'effects', rightCollapsed: true },
}
const DEFAULT_DOCKS: Docks = { leftW: 300, rightW: 300, timelineH: 300, leftTab: 'project', rightTab: 'effects', rightCollapsed: false, infoOpen: true, previewOpen: true, alignOpen: false }

// right-column tab group (AE stacks these on the right)
const RIGHT_TABS: { id: string; title: string; panel?: string }[] = [
  { id: 'effects', title: 'Effects & Presets' },
  { id: 'text', title: 'Character', panel: 'text' },
  { id: 'color', title: 'Lumetri Color', panel: 'color' },
  { id: 'beatsync', title: 'Beat Sync', panel: 'beatsync' },
  { id: 'cutout', title: 'AI Cut-out', panel: 'cutout' },
  { id: 'audio', title: 'Audio', panel: 'audio' },
  { id: 'tracker', title: 'Tracker', panel: 'tracker' },
  { id: 'speed', title: 'Time Remap', panel: 'speed' },
  { id: 'enhance', title: 'Detail Restore', panel: 'enhance' },
  { id: 'ai', title: 'AI Assistant', panel: 'ai' },
  { id: 'plugins', title: 'Plugins', panel: 'plugins' },
]

// floating windows
const DIALOGS: Record<string, string> = {
  comp: 'Composition Settings', export: 'Render Queue', projects: 'Projects', settings: 'Preferences',
  status: 'Feature Status', shortcuts: 'Keyboard Shortcuts', graph: 'Graph Editor', about: 'About ANIME STUDIO',
}

export function AEWorkspace({ panels }: { panels: Record<string, PanelEl> }) {
  const doc = useEditorStore(s => s.doc)
  const undo = useEditorStore(s => s.undo)
  const redo = useEditorStore(s => s.redo)
  const canUndo = useEditorStore(s => s.past.length > 0)
  const canRedo = useEditorStore(s => s.future.length > 0)
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const saveState = useEditorStore(s => s.saveState)
  const toasts = useEditorStore(s => s.toasts)
  const dismissToast = useEditorStore(s => s.dismissToast)
  const preview = useEditorStore(s => s.preview)
  const approvePreview = useEditorStore(s => s.approvePreview)
  const rejectPreview = useEditorStore(s => s.rejectPreview)
  const activePanel = useEditorStore(s => s.activePanel)
  const setPanel = useEditorStore(s => s.setPanel)
  const jobs = useEditorStore(s => s.jobs)

  const tool = useUIStore(s => s.tool)
  const setTool = useUIStore(s => s.setTool)
  const workspace = useUIStore(s => s.workspace)
  const setWorkspace = useUIStore(s => s.setWorkspace)
  const focus = useUIStore(s => s.focus)
  const setFocus = useUIStore(s => s.setFocus)
  const dialog = useUIStore(s => s.dialog)
  const [maximized, setMaximized] = useState<'viewer' | 'timeline' | null>(null)
  const setDialog = useUIStore(s => s.setDialog)

  const [docks, setDocksState] = useState<Docks>(() => {
    try { return { ...DEFAULT_DOCKS, ...JSON.parse(localStorage.getItem(DOCK_KEY) ?? '{}') } } catch { return DEFAULT_DOCKS }
  })
  const setDocks = useCallback((patch: Partial<Docks>) => {
    setDocksState(d => {
      const n = { ...d, ...patch }
      try { localStorage.setItem(DOCK_KEY, JSON.stringify(n)) } catch { /* private */ }
      return n
    })
  }, [])

  // legacy "setPanel" calls (from panels/AI) route into the AE layout
  useEffect(() => {
    if (!activePanel) return
    const tab = RIGHT_TABS.find(t => t.panel === activePanel)
    if (tab) setDocks({ rightTab: tab.id, rightCollapsed: false })
    else if (activePanel === 'inspector') setDocks({ leftTab: 'controls' })
    else if (activePanel === 'assets') setDocks({ leftTab: 'project' })
    else if (activePanel === 'effects') setDocks({ rightTab: 'effects', rightCollapsed: false })
    else if (activePanel === 'graph') useUIStore.getState().setGraphMode(true)
    else if (DIALOGS[activePanel]) setDialog(activePanel)
    setPanel(null)
  }, [activePanel, setPanel, setDocks, setDialog])

  // selecting a layer with effects → Effect Controls like AE (only once per selection)
  const lastSel = useRef<string | null>(null)
  useEffect(() => {
    if (selectedClipId && selectedClipId !== lastSel.current && workspace !== 'default') setDocks({ leftTab: 'controls' })
    lastSel.current = selectedClipId
  }, [selectedClipId, workspace, setDocks])

  const applyWorkspace = (w: WorkspaceId) => { setWorkspace(w); setDocks(PRESETS[w]) }

  // ---------------------------------------------------------------- gutters
  const drag = useRef<{ k: 'left' | 'right' | 'tl'; p0: number; s0: number } | null>(null)
  const gDown = (k: 'left' | 'right' | 'tl') => (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { k, p0: k === 'tl' ? e.clientY : e.clientX, s0: k === 'left' ? docks.leftW : k === 'right' ? docks.rightW : docks.timelineH }
  }
  const gMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (d.k === 'left') setDocks({ leftW: Math.max(200, Math.min(720, d.s0 + e.clientX - d.p0)) })
    else if (d.k === 'right') setDocks({ rightW: Math.max(220, Math.min(640, d.s0 - (e.clientX - d.p0))) })
    else setDocks({ timelineH: Math.max(150, Math.min(window.innerHeight - 260, d.s0 - (e.clientY - d.p0))) })
  }
  const gUp = () => { drag.current = null }

  // ---------------------------------------------------------------- shortcuts
  useEffect(() => {
    const reveal = (p: RevealProp | 'animated', add: boolean) => {
      const s = useEditorStore.getState()
      const ui = useUIStore.getState()
      const ids = s.selectedClipId ? [s.selectedClipId] : s.doc.clips.map(c => c.id)
      const cur = ui.reveal
      if (p === 'animated') {
        ui.setReveal(cur && cur.props === 'animated' && cur.clipIds.join() === ids.join() ? null : { props: 'animated', clipIds: ids })
        return
      }
      if (add && cur && Array.isArray(cur.props)) {
        const props = cur.props.includes(p) ? cur.props.filter(x => x !== p) : [...cur.props, p]
        ui.setReveal(props.length ? { props, clipIds: [...new Set([...cur.clipIds, ...ids])] } : null)
        return
      }
      const same = cur && Array.isArray(cur.props) && cur.props.length === 1 && cur.props[0] === p && cur.clipIds.join() === ids.join()
      ui.setReveal(same ? null : { props: [p], clipIds: ids })
    }
    let lastU = 0
    const ids = () => selectedClips().map(c => c.id)
    const toast = (m: string) => { if (m) useEditorStore.getState().toast({ kind: 'info', title: m }) }
    const zoomV = (d: number | 'fit') => window.dispatchEvent(new CustomEvent('as-viewer-zoom', { detail: d }))
    const nudgeTime = (frames: number) => {
      const s = useEditorStore.getState(); const fps = Math.max(1, s.doc.composition.fps)
      for (const id of ids()) patchClip(id, c => { c.start = Math.max(0, c.start + frames / fps) })
    }
    const nudgePos = (dx: number, dy: number) => {
      for (const id of ids()) patchClip(id, c => {
        const ax = c.keyframes.some(t => t.property === 'x' && t.keyframes.length), ay = c.keyframes.some(t => t.property === 'y' && t.keyframes.length)
        if (!ax) c.x += dx
        if (!ay) c.y += dy
      })
    }
    // ---------------------------------------------------------------
    // After Effects default keyboard map (Windows; Cmd = Ctrl on macOS)
    // ---------------------------------------------------------------
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable || tgt.tagName === 'SELECT')) return
      const s = useEditorStore.getState()
      const mod = e.ctrlKey || e.metaKey
      const k = e.key, code = e.code
      const lower = k.length === 1 ? k.toLowerCase() : k
      const run = (fn: () => void) => { e.preventDefault(); fn() }
      const hasSel = ids().length > 0
      if (mod) {
        const sh = e.shiftKey, al = e.altKey
        if (lower === 'z') return run(() => (sh ? redo() : undo()))
        if (lower === 'y' && sh && al) return run(() => newLayer('null'))
        if (lower === 'y' && al) return run(() => newLayer('adjustment'))
        if (lower === 'y') return run(() => newLayer('solid'))
        if (lower === 't' && sh && al) return run(() => newLayer('text'))
        if (lower === 'c' && sh && al) return run(() => newLayer('camera'))
        if (lower === 't') return run(() => setTool('text'))
        if (lower === 'd' && sh) return run(splitSelected)
        if (lower === 'd') return run(duplicateSelectedLayers)
        if (lower === 'c' && sh) return run(() => { if (!precomposeSelected()) toast('Select layers to pre-compose') })
        if (lower === 'c') return run(() => toast(copySelection()))
        if (lower === 'x') return run(() => { const m = copySelection(); if (m) { if (!deleteSelectedKeyframe()) deleteSelectedLayers() } toast(m.replace('copied', 'cut')) })
        if (lower === 'v') return run(() => toast(pasteClipboard()))
        if (lower === 'a' && sh) return run(() => s.select(null))
        if (lower === 'a') return run(selectAllLayers)
        if (lower === 'n' && al) return run(() => setDialog('projects'))
        if (lower === 'n') return run(() => newComposition())
        if (lower === 'o') return run(() => setDialog('projects'))
        if (lower === 'k') return run(() => setDialog('comp'))
        if (lower === 'm') return run(() => setDialog('export'))
        if (lower === 'i') return run(pickAndImport)
        if (lower === 's' && sh) return run(() => void downloadProjectFile(s.doc))
        if (lower === 's') return run(() => { s.saveLocal(); s.toast({ kind: 'success', title: 'Project saved', detail: 'Saved on this device. Ctrl+Shift+S downloads a project file.' }) })
        if (lower === 'e' && sh) return run(() => { for (const id of ids()) patchClip(id, c => { c.effects = [] }) })
        if (lower === 'r' && al) return run(() => { for (const id of ids()) patchClip(id, c => { c.reverse = !c.reverse }) })
        if (lower === 't' && al) return run(() => setDocks({ rightTab: 'speed', rightCollapsed: false }))
        if (lower === 'h' && al) return run(() => setSelectedKeyEasing('hold'))
        if (lower === 'f' && al) return run(() => fitLayersToComp())
        if (lower === 'b' && al) return run(() => workAreaToSelection())
        if (k === 'Home') return run(() => { for (const id of ids()) patchClip(id, c => { c.x = 0; c.y = 0; c.keyframes = c.keyframes.filter(t => t.property !== 'x' && t.property !== 'y') }) })
        if (k === 'ArrowRight' || k === 'ArrowLeft') return run(() => playbackEngine.stepFrame((k === 'ArrowRight' ? 1 : -1) * (sh ? 10 : 1)))
        if (k === "'" ) return run(() => useUIStore.getState().setGuides({ grid: !useUIStore.getState().guides.grid }))
        if (k === '[' || k === ']' || code === 'BracketLeft' || code === 'BracketRight') {
          const c = selectedClip(); const fwd = k === ']' || code === 'BracketRight'
          if (c) return run(() => moveLayer(c.id, fwd ? (sh ? -Infinity : -1) : (sh ? Infinity : 1)))
        }
        if (k === '0') return run(() => zoomV('fit'))
        return
      }
      if (e.altKey) {
        if (k === '[' || code === 'BracketLeft') return run(() => layerToCTI('in', true))
        if (k === ']' || code === 'BracketRight') return run(() => layerToCTI('out', true))
        if (k === 'PageUp') return run(() => nudgeTime(e.shiftKey ? -10 : -1))
        if (k === 'PageDown') return run(() => nudgeTime(e.shiftKey ? 10 : 1))
        if (k === 'Home') return run(() => { for (const id of ids()) patchClip(id, c => { c.start = 0 }) })
        if (k === 'End') return run(() => { const end = s.doc.composition.duration; for (const id of ids()) patchClip(id, c => { c.start = Math.max(0, end - c.duration) }) })
        if (e.shiftKey && hasSel) {
          const map: Record<string, string[]> = { p: ['x', 'y'], s: ['scale'], r: ['rotation'], t: ['opacity'], a: ['anchorX', 'anchorY'] }
          const props = map[code.replace('Key', '').toLowerCase()]
          if (props) return run(() => { for (const id of ids()) toggleKeyAtCTI(id, props) })
        }
      }
      if (code === 'Numpad0' || (k === '0' && !e.shiftKey)) return run(() => { if (playbackEngine.ramBuilding) playbackEngine.cancelRamPreview(); else void playbackEngine.ramPreview() })
      if (code === 'NumpadMultiply' || k === '*') return run(() => s.mutate(d => { d.markers.push({ id: `mk_${Date.now()}`, time: playbackEngine.currentTime, label: 'Marker', color: '#a9cbc7' }) }))
      switch (k) {
        case ' ': return run(() => playbackEngine.toggle())
        case 'Home': return run(() => { playbackEngine.pause(); playbackEngine.seek(e.shiftKey ? (playbackEngine.state.inPoint ?? 0) : 0) })
        case 'End': return run(() => { playbackEngine.pause(); if (e.shiftKey && playbackEngine.state.outPoint !== null) playbackEngine.seek(playbackEngine.state.outPoint); else playbackEngine.goToEnd() })
        case 'PageUp': return run(() => playbackEngine.stepFrame(e.shiftKey ? -10 : -1))
        case 'PageDown': return run(() => playbackEngine.stepFrame(e.shiftKey ? 10 : 1))
        case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
          const n = e.shiftKey ? 10 : 1
          // AE: arrows nudge the selected layers 1 px (Shift = 10). Without a selection ←/→ step frames.
          if (!hasSel) { if (k === 'ArrowLeft' || k === 'ArrowRight') return run(() => playbackEngine.stepFrame(k === 'ArrowRight' ? n : -n)); return }
          return run(() => nudgePos(k === 'ArrowLeft' ? -n : k === 'ArrowRight' ? n : 0, k === 'ArrowUp' ? n : k === 'ArrowDown' ? -n : 0))
        }
        case 'Delete': case 'Backspace': return run(() => { if (!deleteSelectedKeyframe()) deleteSelectedLayers() })
        case 'F9': return run(() => setSelectedKeyEasing(e.shiftKey ? 'easeIn' : 'easeInOut'))
        case 'F2': return run(() => s.select(null))
        case 'F3': return run(() => { if (e.shiftKey) useUIStore.getState().setGraphMode(!useUIStore.getState().graphMode); else setDocks({ leftTab: 'controls' }) })
        case 'F4': return run(() => window.dispatchEvent(new Event('as-toggle-modes')))
        case '[': return run(() => layerToCTI('in', false))
        case ']': return run(() => layerToCTI('out', false))
        case '?': return run(() => zoomV('fit'))
        case '`': case '~': return run(() => setMaximized(m => (m ? null : useUIStore.getState().focus === 'timeline' ? 'timeline' : 'viewer')))
        case "'": return run(() => useUIStore.getState().setGuides({ safe: !useUIStore.getState().guides.safe }))
        case '.': return run(() => zoomV(1))
        case ',': return run(() => zoomV(-1))
        case '=': case '+': return run(() => window.dispatchEvent(new CustomEvent('as-tl-zoom', { detail: 1 })))
        case '-': return run(() => window.dispatchEvent(new CustomEvent('as-tl-zoom', { detail: -1 })))
        case 'Escape': return run(() => { if (playbackEngine.ramBuilding) { playbackEngine.cancelRamPreview(); return } useUIStore.getState().setCutoutPick(null); s.select(null); useUIStore.getState().setReveal(null) })
      }
      if (e.shiftKey && 'psrta'.includes(lower)) {
        const m: Record<string, RevealProp> = { p: 'position', s: 'scale', r: 'rotation', t: 'opacity', a: 'anchor' }
        return run(() => reveal(m[lower], true))
      }
      switch (lower) {
        case 'v': return run(() => setTool('select'))
        case 'h': return run(() => setTool('hand'))
        case 'z': return run(() => setTool('zoom'))
        case 'w': return run(() => setTool('rotate'))
        case 'y': return run(() => setTool('anchor'))
        case 'q': return run(() => setTool(useUIStore.getState().tool === 'rect' ? 'ellipse' : 'rect'))
        case 'g': return run(() => setTool('pen'))
        case 'j': return run(() => jumpKeyframe(-1))
        case 'k': return run(() => jumpKeyframe(1))
        case 'i': return run(() => { const c = selectedClip(); if (c) { playbackEngine.pause(); playbackEngine.seek(c.start) } })
        case 'o': return run(() => { const c = selectedClip(); if (c) { playbackEngine.pause(); playbackEngine.seek(c.start + c.duration - 1 / Math.max(1, s.doc.composition.fps)) } })
        case 'b': return run(() => setWorkArea('in'))
        case 'n': return run(() => setWorkArea('out'))
        case 'p': return run(() => reveal('position', false))
        case 's': return run(() => reveal('scale', false))
        case 'r': return run(() => reveal('rotation', false))
        case 't': return run(() => reveal('opacity', false))
        case 'a': return run(() => reveal('anchor', false))
        case 'u': { const now = Date.now(); const dbl = now - lastU < 450; lastU = now; return run(() => { if (dbl) useUIStore.getState().setReveal({ props: 'animated', clipIds: ids().length ? ids() : s.doc.clips.map(c => c.id) }); else reveal('animated', false) }) }
        case 'e': return run(() => { const ui = useUIStore.getState(); for (const c of (ids().length ? selectedClips() : s.doc.clips)) if (c.effects.length) ui.setOpen(c.id, !ui.open[c.id]); ui.setReveal(null) })
        case 'l': return run(() => { const ui = useUIStore.getState(); for (const id of ids()) ui.setOpen(id, true); ui.setReveal(null) })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, setDialog, setTool, setDocks])

  // ---------------------------------------------------------------- menus
  const sel = doc.clips.find(c => c.id === selectedClipId) ?? null
  const hasSel = !!sel
  const effectCats = [...new Set(EFFECT_DEFS.map(e => e.category))]
  const menus: Menu[] = [
    {
      label: 'File', items: [
        { label: 'New Project…', sc: 'Ctrl+Alt+N', action: () => setDialog('projects') },
        { label: 'Open Project…', sc: 'Ctrl+O', action: () => setDialog('projects') },
        { sep: true },
        { label: 'Save', sc: 'Ctrl+S', action: () => { useEditorStore.getState().saveLocal(); useEditorStore.getState().toast({ kind: 'success', title: 'Project saved' }) } },
        { label: 'Save As… (download project file)', sc: 'Ctrl+Shift+S', action: () => void downloadProjectFile(useEditorStore.getState().doc) },
        { sep: true },
        { label: 'Import File…', sc: 'Ctrl+I', action: pickAndImport },
        { sep: true },
        { label: 'Export ▸ Add to Render Queue', sc: 'Ctrl+M', action: () => setDialog('export') },
        { sep: true },
        { label: 'Preferences…', action: () => setDialog('settings') },
      ],
    },
    {
      label: 'Edit', items: [
        { label: 'Undo', sc: 'Ctrl+Z', action: undo, disabled: !canUndo },
        { label: 'Redo', sc: 'Ctrl+Shift+Z', action: redo, disabled: !canRedo },
        { sep: true },
        { label: 'Copy', sc: 'Ctrl+C', action: () => { const m = copySelection(); if (m) useEditorStore.getState().toast({ kind: 'info', title: m }) }, disabled: !hasSel },
        { label: 'Paste', sc: 'Ctrl+V', action: () => { const m = pasteClipboard(); if (m) useEditorStore.getState().toast({ kind: 'info', title: m }) } },
        { label: 'Select All', sc: 'Ctrl+A', action: selectAllLayers },
        { sep: true },
        { label: 'Duplicate', sc: 'Ctrl+D', action: duplicateSelectedLayers, disabled: !hasSel },
        { label: 'Split Layer', sc: 'Ctrl+Shift+D', action: splitSelected, disabled: !hasSel },
        { label: 'Clear', sc: 'Delete', action: () => { if (!deleteSelectedKeyframe()) deleteSelectedLayers() }, disabled: !hasSel },
        { sep: true },
        { label: 'Deselect All', sc: 'Esc', action: () => useEditorStore.getState().select(null) },
        { label: 'Keyboard Shortcuts', sc: '?', action: () => setDialog('shortcuts') },
        { label: 'Preferences…', action: () => setDialog('settings') },
      ],
    },
    {
      label: 'Composition', items: [
        { label: 'New Composition…', sc: 'Ctrl+N', action: newComposition },
        { label: 'Composition Settings…', sc: 'Ctrl+K', action: () => setDialog('comp') },
        { label: 'Trim Comp to Work Area', action: trimCompToWorkArea },
        { label: 'Clear Work Area', action: clearWorkArea },
        { sep: true },
        { label: 'Add to Render Queue', sc: 'Ctrl+M', action: () => setDialog('export') },
        { label: 'Save Frame As ▸ PNG…', sc: 'Ctrl+Alt+S', action: saveFrameAs },
        { sep: true },
        { label: 'Preview ▸ Play Current Preview', sc: 'Space', action: () => playbackEngine.toggle() },
        { label: 'Preview ▸ RAM Preview', sc: '0', action: () => void playbackEngine.ramPreview() },
        { label: 'Purge ▸ Image Cache Memory', action: () => playbackEngine.clearCache() },
        { sep: true },
        { label: 'Enable Motion Blur', checked: doc.composition.motionBlur !== false, action: () => useEditorStore.getState().mutate(d => { d.composition.motionBlur = d.composition.motionBlur === false }) },
        { label: 'Close Pre-comp (go up)', disabled: !(doc.compStack?.length), action: closeComp },
      ],
    },
    {
      label: 'Layer', items: [
        { header: 'New' },
        { label: 'Text', sc: 'Ctrl+Alt+Shift+T', action: () => newLayer('text') },
        { label: 'Solid…', sc: 'Ctrl+Y', action: () => newLayer('solid') },
        { label: 'Shape Layer', action: () => newLayer('shape') },
        { label: 'Null Object', sc: 'Ctrl+Alt+Shift+Y', action: () => newLayer('null') },
        { label: 'Camera…', action: () => newLayer('camera') },
        { label: 'Adjustment Layer', sc: 'Ctrl+Alt+Y', action: () => newLayer('adjustment') },
        { sep: true },
        { label: 'Pre-compose…', sc: 'Ctrl+Shift+C', disabled: !hasSel, action: () => { precomposeSelected() } },
        { label: 'Open Pre-comp', disabled: sel?.kind !== 'precomp', action: () => { if (sel?.kind === 'precomp') import('./aeActions').then(m => m.openComp(sel.precompId)) } },
        { sep: true },
        { label: 'Motion Blur', checked: !!sel?.motionBlur, disabled: !hasSel || sel?.kind === 'audio', action: () => { for (const c of selectedClips()) patchClip(c.id, x => { x.motionBlur = !sel?.motionBlur }) } },
        { label: '3D Layer', checked: !!sel?.threeD, disabled: !hasSel || sel?.kind === 'audio', action: () => sel && patchClip(sel.id, c => { c.threeD = !c.threeD }) },
        { label: 'Hide (Video switch)', checked: !!sel?.hidden, disabled: !hasSel, action: () => sel && patchClip(sel.id, c => { c.hidden = !c.hidden }) },
        { label: 'Lock', checked: !!sel?.locked, disabled: !hasSel, action: () => sel && patchClip(sel.id, c => { c.locked = !c.locked }) },
        { label: 'Shy', checked: !!sel?.shy, disabled: !hasSel, action: () => sel && patchClip(sel.id, c => { c.shy = !c.shy }) },
        { sep: true },
        { label: 'Time ▸ Time Remap / Speed…', action: () => setDocks({ rightTab: 'speed', rightCollapsed: false }), disabled: !hasSel },
        { label: 'Time ▸ Time-Reverse Layer', checked: !!sel?.reverse, disabled: !hasSel, action: () => sel && patchClip(sel.id, c => { c.reverse = !c.reverse }) },
        { sep: true },
        { header: 'Arrange' },
        { label: 'Bring Layer to Front', sc: 'Ctrl+Shift+]', disabled: !hasSel, action: () => sel && moveLayer(sel.id, -Infinity) },
        { label: 'Bring Layer Forward', sc: 'Ctrl+]', disabled: !hasSel, action: () => sel && moveLayer(sel.id, -1) },
        { label: 'Send Layer Backward', sc: 'Ctrl+[', disabled: !hasSel, action: () => sel && moveLayer(sel.id, 1) },
        { label: 'Send Layer to Back', sc: 'Ctrl+Shift+[', disabled: !hasSel, action: () => sel && moveLayer(sel.id, Infinity) },
      ],
    },
    {
      label: 'Effect', items: [
        { label: 'Effect Controls', sc: 'F3', action: () => setDocks({ leftTab: 'controls' }) },
        { label: 'Remove All', sc: 'Ctrl+Shift+E', disabled: !sel?.effects.length, action: () => sel && patchClip(sel.id, c => { c.effects = [] }) },
        { sep: true },
        ...effectCats.map(cat => ({
          label: cat[0].toUpperCase() + cat.slice(1),
          sub: EFFECT_DEFS.filter(e => e.category === cat).map(e => ({ label: e.name, disabled: !hasSel, action: () => sel && applyEffectToClip(sel.id, e.type) })),
        })),
      ],
    },
    {
      label: 'Animation', items: [
        { label: 'Keyframe Assistant ▸ Easy Ease', sc: 'F9', action: () => setSelectedKeyEasing('easeInOut'), disabled: !hasSel },
        { label: 'Keyframe Assistant ▸ Easy Ease In', action: () => setSelectedKeyEasing('easeIn'), disabled: !hasSel },
        { label: 'Keyframe Assistant ▸ Easy Ease Out', action: () => setSelectedKeyEasing('easeOut'), disabled: !hasSel },
        { label: 'Toggle Hold Keyframe', action: () => setSelectedKeyEasing('hold'), disabled: !hasSel },
        { label: 'Linear Keyframe', action: () => setSelectedKeyEasing('linear'), disabled: !hasSel },
        { sep: true },
        { label: 'Previous Keyframe', sc: 'J', action: () => jumpKeyframe(-1) },
        { label: 'Next Keyframe', sc: 'K', action: () => jumpKeyframe(1) },
        { label: 'Add Expression ▸ wiggle(3, 25) on Position', disabled: !hasSel, action: () => { for (const c of selectedClips()) patchClip(c.id, x => { x.expressions = { ...(x.expressions ?? {}), position: 'wiggle(3, 25)' } }); if (sel) useUIStore.getState().setReveal({ props: 'animated', clipIds: selectedClips().map(c => c.id) }) } },
        { label: 'Copy Keyframes', sc: 'Ctrl+C', action: () => { const m = copySelection(); if (m) useEditorStore.getState().toast({ kind: 'info', title: m }) } },
        { label: 'Paste Keyframes at CTI', sc: 'Ctrl+V', action: () => { const m = pasteClipboard(); if (m) useEditorStore.getState().toast({ kind: 'info', title: m }) } },
        { sep: true },
        { label: 'Reveal Animated Properties', sc: 'U', action: () => useUIStore.getState().setReveal(sel ? { props: 'animated', clipIds: [sel.id] } : null) },
        { sep: true },
        { label: 'Track Motion', action: () => setDocks({ rightTab: 'tracker', rightCollapsed: false }) },
        { label: 'Graph Editor', sc: 'Shift+F3', action: () => useUIStore.getState().setGraphMode(!useUIStore.getState().graphMode) },
      ],
    },
    {
      label: 'View', items: [
        { label: 'Zoom In', sc: '.', action: () => window.dispatchEvent(new CustomEvent('as-viewer-zoom', { detail: 1 })) },
        { label: 'Zoom Out', sc: ',', action: () => window.dispatchEvent(new CustomEvent('as-viewer-zoom', { detail: -1 })) },
        { label: 'Fit', sc: 'Ctrl+0', action: () => window.dispatchEvent(new CustomEvent('as-viewer-zoom', { detail: 'fit' })) },
        { sep: true },
        { header: 'Resolution' },
        ...(['full', 'half', 'quarter'] as const).map(q => ({ label: q[0].toUpperCase() + q.slice(1), checked: playbackEngine.previewQuality === q, action: () => { playbackEngine.setQuality(q); window.dispatchEvent(new Event('as-quality')) } })),
        { sep: true },
        { label: 'Show Grid', checked: useUIStore.getState().guides.grid, action: () => useUIStore.getState().setGuides({ grid: !useUIStore.getState().guides.grid }) },
        { label: 'Title/Action Safe', checked: useUIStore.getState().guides.safe, action: () => useUIStore.getState().setGuides({ safe: !useUIStore.getState().guides.safe }) },
        { label: 'Transparency Grid', checked: useUIStore.getState().guides.checker, action: () => useUIStore.getState().setGuides({ checker: !useUIStore.getState().guides.checker }) },
      ],
    },
    {
      label: 'Window', items: [
        { header: 'Workspace' },
        ...(['default', 'animation', 'effects', 'minimal'] as const).map(w => ({ label: w[0].toUpperCase() + w.slice(1), checked: workspace === w, action: () => applyWorkspace(w) })),
        { label: 'Reset Workspace', action: () => applyWorkspace(workspace) },
        { sep: true },
        { label: 'Align', checked: docks.alignOpen, action: () => setDocks({ alignOpen: !docks.alignOpen, rightCollapsed: false }) },
        { label: 'Effect Controls', sc: 'F3', action: () => setDocks({ leftTab: 'controls' }) },
        { label: 'Info', checked: docks.infoOpen, action: () => setDocks({ infoOpen: !docks.infoOpen, rightCollapsed: false }) },
        { label: 'Preview', checked: docks.previewOpen, action: () => setDocks({ previewOpen: !docks.previewOpen, rightCollapsed: false }) },
        { label: 'Project', action: () => setDocks({ leftTab: 'project' }) },
        ...RIGHT_TABS.map(t => ({ label: t.title, checked: docks.rightTab === t.id && !docks.rightCollapsed, action: () => setDocks({ rightTab: t.id, rightCollapsed: false }) })),
        { sep: true },
        { label: 'Render Queue', sc: 'Ctrl+M', action: () => setDialog('export') },
        { label: 'Feature Status', action: () => setDialog('status') },
      ],
    },
    {
      label: 'Help', items: [
        { label: 'Keyboard Shortcuts', sc: '?', action: () => setDialog('shortcuts') },
        { label: 'Feature Status', action: () => setDialog('status') },
        { label: 'About ANIME STUDIO', action: () => setDialog('about') },
      ],
    },
  ]

  const rightTabDef = RIGHT_TABS.find(t => t.id === docks.rightTab) ?? RIGHT_TABS[0]
  const rightBody = rightTabDef.id === 'effects' ? <EffectsPresetsPanel /> : panels[rightTabDef.panel!]?.el
  const activeJob = jobs.find(j => j.status === 'running')

  const tools: { id: ToolId; icon: ReactNode; tip: string }[] = [
    { id: 'select', icon: <MousePointer2 size={15} />, tip: 'Selection Tool (V)' },
    { id: 'hand', icon: <Hand size={15} />, tip: 'Hand Tool (H)' },
    { id: 'zoom', icon: <ZoomIn size={15} />, tip: 'Zoom Tool (Z) — Alt-click zooms out' },
    { id: 'rotate', icon: <RotateCw size={15} />, tip: 'Rotation Tool (W)' },
    { id: 'anchor', icon: <Move size={15} />, tip: 'Pan Behind (Anchor Point) Tool (Y)' },
    { id: 'rect', icon: <Square size={15} />, tip: 'Rectangle Tool (Q)' },
    { id: 'ellipse', icon: <Circle size={15} />, tip: 'Ellipse Tool (Q)' },
    { id: 'pen', icon: <PenTool size={15} />, tip: 'Pen Tool (G) — draws a mask on the selected layer' },
    { id: 'text', icon: <Type size={15} />, tip: 'Horizontal Type Tool (Ctrl+T)' },
  ]

  return (
    <div
      className="ae-app fixed inset-0 flex flex-col"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      onPointerMove={gMove} onPointerUp={gUp} onPointerCancel={gUp}
    >
      {/* ---------- menu bar ---------- */}
      <MenuBar menus={menus} right={
        <div className="flex items-center gap-2 pr-2 text-[11px]">
          {activeJob && <span className="text-zinc-400 as-mono">{activeJob.label} {Math.round(activeJob.progress * 100)}%</span>}
          <span className={saveState === 'saved' ? 'text-zinc-500' : 'text-amber-400'}>{saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Edited'}</span>
          <span className="text-zinc-300 max-w-[220px] truncate">{doc.name}</span>
        </div>
      } />

      {/* ---------- tools ---------- */}
      <div className="ae-toolbar shrink-0 flex items-center px-1.5 gap-0.5 no-select">
        <button className="ae-tool" title="Home: Projects" onClick={() => setDialog('projects')}><Home size={15} /></button>
        <span className="w-px h-5 bg-[#3a3a3a] mx-1" />
        {tools.map(t => (
          <button key={t.id} className="ae-tool" data-on={tool === t.id ? '1' : '0'} title={t.tip} onClick={() => setTool(t.id)}>{t.icon}</button>
        ))}
        <span className="w-px h-5 bg-[#3a3a3a] mx-1" />
        <button className="ae-tool" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}><Undo2 size={15} /></button>
        <button className="ae-tool" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}><Redo2 size={15} /></button>
        <div className="flex-1" />
        <div className="hidden lg:flex items-center gap-0.5 mr-2">
          {(['default', 'animation', 'effects', 'minimal'] as const).map(w => (
            <button key={w} className="ae-ws-btn" data-on={workspace === w ? '1' : '0'} onClick={() => applyWorkspace(w)}>{w[0].toUpperCase() + w.slice(1)}</button>
          ))}
        </div>
        <button className="gbtn gbtn-accent h-[24px] px-3 text-[12px]" onClick={() => setDialog('export')} title="Add to Render Queue (Ctrl+M)"><Download size={13} /> Export</button>
      </div>

      {preview && (
        <div className="shrink-0 h-8 flex items-center gap-2 px-3 bg-[#2a2442] border-b border-black text-[12px] text-violet-100">
          <Sparkles size={13} />
          <span className="flex-1 truncate">AI preview — the viewer shows the staged draft</span>
          <button className="gbtn gbtn-accent px-3 py-0.5 text-[11px]" onClick={approvePreview}>Apply</button>
          <button className="gbtn px-3 py-0.5 text-[11px]" onClick={rejectPreview}>Discard</button>
        </div>
      )}

      {/* ---------- upper frame ---------- */}
      <div className="flex-1 min-h-0 flex px-[3px] pt-[3px]" style={{ display: maximized === 'timeline' ? 'none' : undefined }}>
        {/* left: Project | Effect Controls */}
        {maximized !== 'viewer' && <><Panel
          style={{ width: docks.leftW }} active={focus === 'left'} onFocus={() => setFocus('left')}
          tabs={[{ id: 'project', title: 'Project' }, { id: 'controls', title: sel ? `Effect Controls ${sel.name}` : 'Effect Controls' }]}
          tab={docks.leftTab} onTab={id => setDocks({ leftTab: id })}
        >
          {docks.leftTab === 'project' ? <ProjectPanel /> : <div className="h-full overflow-auto as-scroll ae-sheet"><Inspector /></div>}
        </Panel>
        <div className="ae-gutter ae-gutter-v" onPointerDown={gDown('left')} /></>}

        {/* center: composition viewer */}
        <Panel
          className="flex-1" active={focus === 'viewer'} onFocus={() => setFocus('viewer')}
          tabs={[{ id: 'comp', title: `Composition ${doc.compName ?? doc.name}` }]} tab="comp" onTab={() => { }}
        >
          <PreviewMonitor ae />
        </Panel>

        {/* right column */}
        {maximized === 'viewer' ? null : !docks.rightCollapsed ? (
          <>
            <div className="ae-gutter ae-gutter-v" onPointerDown={gDown('right')} />
            <div className="flex flex-col min-h-0 gap-[3px]" style={{ width: docks.rightW }}>
              {docks.infoOpen && <Section title="Info" onClose={() => setDocks({ infoOpen: false })}><InfoPanel /></Section>}
              {docks.previewOpen && <Section title="Preview" onClose={() => setDocks({ previewOpen: false })}><PreviewPanel /></Section>}
              {docks.alignOpen && <Section title="Align" onClose={() => setDocks({ alignOpen: false })}><AlignPanel /></Section>}
              <Panel
                className="flex-1" active={focus === 'right'} onFocus={() => setFocus('right')}
                tabs={RIGHT_TABS.map(t => ({ id: t.id, title: t.title }))} tab={docks.rightTab} onTab={id => setDocks({ rightTab: id })}
                onClose={() => setDocks({ rightCollapsed: true })}
              >
                <div className="h-full min-h-0 overflow-auto as-scroll ae-sheet">{rightBody}</div>
              </Panel>
            </div>
          </>
        ) : (
          <button className="w-[22px] ml-[3px] ae-panel items-center justify-start pt-2 text-zinc-500 hover:text-white" title="Show panels" onClick={() => setDocks({ rightCollapsed: false })}>
            <ChevronDown size={12} className="rotate-90" />
          </button>
        )}
      </div>

      {maximized === null && <div className="ae-gutter ae-gutter-h mx-[3px]" onPointerDown={gDown('tl')} />}

      {/* ---------- timeline ---------- */}
      <div className={`px-[3px] pb-[3px] min-h-0 ${maximized === 'timeline' ? 'flex-1 pt-[3px]' : 'shrink-0'}`} style={{ height: maximized === 'timeline' ? undefined : docks.timelineH, display: maximized === 'viewer' ? 'none' : undefined }}>
        <Panel
          className="h-full" active={focus === 'timeline'} onFocus={() => setFocus('timeline')}
          tabs={[{ id: 'tl', title: doc.compName ?? doc.name }]} tab="tl" onTab={() => { }} tabIcon
        >
          <AETimeline />
        </Panel>
      </div>

      {/* ---------- floating windows ---------- */}
      {dialog && (
        <FloatingWindow title={DIALOGS[dialog] ?? dialog} onClose={() => setDialog(null)}>
          {dialog === 'comp' ? <CompSettingsDialog onClose={() => setDialog(null)} />
            : dialog === 'shortcuts' ? <ShortcutsPanel />
              : dialog === 'about' ? <About />
                : <div className="w-[480px] max-w-full ae-sheet">{panels[dialog]?.el}</div>}
        </FloatingWindow>
      )}

      {/* ---------- toasts ---------- */}
      <div className="absolute bottom-3 right-3 z-[300] w-[340px] space-y-1.5 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} onClick={() => dismissToast(t.id)}
            className="pointer-events-auto flex items-start gap-2 px-3 py-2 bg-[#2d2d2d] border border-black shadow-[0_6px_20px_rgba(0,0,0,0.5)] text-[12px] rounded-[3px]"
            style={{ borderLeft: `3px solid ${t.kind === 'error' ? '#e05656' : t.kind === 'success' ? '#4aa44c' : t.kind === 'ai' ? '#8b6cf0' : '#2d8ceb'}` }}>
            {t.kind === 'error' ? <AlertTriangle size={14} className="text-red-400 mt-0.5 shrink-0" /> : t.kind === 'success' ? <CheckCircle2 size={14} className="text-emerald-400 mt-0.5 shrink-0" /> : <Sparkles size={14} className="text-amber-400 mt-0.5 shrink-0" />}
            <div className="min-w-0">
              <div className="text-zinc-100">{t.title}</div>
              {t.detail && <div className="text-[11px] text-zinc-400 mt-0.5 break-words">{t.detail}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ chrome

function Panel({ tabs, tab, onTab, children, className = '', style, active, onFocus, onClose, tabIcon }: {
  tabs: { id: string; title: string }[]; tab: string; onTab: (id: string) => void; children: ReactNode
  className?: string; style?: React.CSSProperties; active?: boolean; onFocus?: () => void; onClose?: () => void; tabIcon?: boolean
}) {
  return (
    <div className={`ae-panel ${className}`} style={style} data-active={active ? '1' : '0'} onPointerDownCapture={onFocus}>
      <div className="ae-tabs">
        {tabs.map(t => (
          <button key={t.id} className="ae-tab" data-on={t.id === tab ? '1' : '0'} onClick={() => onTab(t.id)}>
            {tabIcon && <span className="w-[9px] h-[9px] rounded-[1px] bg-[#a89677]" />}
            <span className="truncate max-w-[220px]">{t.title}</span>
            {onClose && t.id === tab && <X size={11} className="ae-tab-x" onClick={e => { e.stopPropagation(); onClose() }} />}
          </button>
        ))}
        <div className="flex-1" />
        <span className="px-2 flex items-center text-zinc-600 text-[13px] select-none" title="Panel menu">≡</span>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </div>
  )
}

function Section({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="ae-panel shrink-0">
      <div className="ae-section-h" onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown size={12} className="text-zinc-500" /> : <ChevronRight size={12} className="text-zinc-500" />}
        <span className="flex-1">{title}</span>
        <X size={11} className="text-zinc-600 hover:text-white" onClick={e => { e.stopPropagation(); onClose() }} />
      </div>
      {open && children}
    </div>
  )
}

function FloatingWindow({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="absolute inset-0 z-[250] bg-black/35" onPointerDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div
        ref={ref}
        className="absolute bg-[#262626] border border-black shadow-[0_18px_60px_rgba(0,0,0,0.7)] rounded-[4px] flex flex-col max-h-[86vh] max-w-[96vw]"
        style={pos ? { left: pos.x, top: pos.y } : { left: '50%', top: '10vh', transform: 'translateX(-50%)' }}
      >
        <div
          className="h-8 shrink-0 flex items-center px-3 bg-[#1f1f1f] border-b border-black text-[12px] text-zinc-200 cursor-move select-none rounded-t-[4px]"
          onPointerDown={e => {
            const r = ref.current!.getBoundingClientRect()
            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
            drag.current = { x: e.clientX, y: e.clientY, px: r.left, py: r.top }
          }}
          onPointerMove={e => { const d = drag.current; if (d) setPos({ x: d.px + e.clientX - d.x, y: Math.max(0, d.py + e.clientY - d.y) }) }}
          onPointerUp={() => { drag.current = null }}
        >
          <span className="flex-1">{title}</span>
          <button className="tb-btn !w-6 !h-6" onPointerDown={e => e.stopPropagation()} onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>
        <div className="overflow-auto as-scroll min-h-0">{children}</div>
      </div>
    </div>
  )
}

function About() {
  return (
    <div className="p-5 w-[380px] text-[12px] text-zinc-300 leading-5">
      <div className="text-[18px] font-semibold text-white tracking-wide">ANIME<span className="text-amber-400">STUDIO</span></div>
      <p className="mt-2">Motion graphics &amp; anime video editor that runs in your browser — on desktop, iPhone, iPad and Android.</p>
      <p className="mt-2 text-zinc-500">WebGL compositor · keyframes &amp; graph editor · track mattes · parenting · 3D camera · tracker · AI assistant · real MP4 export.</p>
    </div>
  )
}

// ------------------------------------------------------------------ menu bar

type MenuItem =
  | { sep: true }
  | { header: string }
  | { label: string; sc?: string; action?: () => void; disabled?: boolean; checked?: boolean; sub?: { label: string; action: () => void; disabled?: boolean }[] }
type Menu = { label: string; items: MenuItem[] }

function MenuBar({ menus, right }: { menus: Menu[]; right?: ReactNode }) {
  const [open, setOpen] = useState<number | null>(null)
  const [sub, setSub] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => { setOpen(null); setSub(null) }, [])
  useOutsideClick(ref, close, open !== null)
  useEffect(() => {
    if (open === null) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [open, close])
  return (
    <div ref={ref} className="ae-menubar shrink-0 flex items-center no-select relative z-[210]">
      <span className="px-2.5 text-[12px] font-bold tracking-wide text-zinc-200">A<span className="text-amber-400">S</span></span>
      {menus.map((m, i) => (
        <div key={m.label} className="relative">
          <button className="ae-menu-btn" data-open={open === i ? '1' : '0'}
            onPointerDown={e => { e.preventDefault(); setOpen(open === i ? null : i); setSub(null) }}
            onPointerEnter={() => { if (open !== null && open !== i) { setOpen(i); setSub(null) } }}>
            {m.label}
          </button>
          {open === i && (
            <div className="ae-menu left-0 top-[26px] max-h-[80vh] overflow-y-auto as-scroll">
              {m.items.map((it, j) => {
                if ('sep' in it) return <div key={j} className="ae-menu-sep" />
                if ('header' in it) return <div key={j} className="px-[26px] pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-zinc-500">{it.header}</div>
                return (
                  <div key={j} className="relative" onPointerEnter={() => setSub(it.sub ? j : null)}>
                    <button className="ae-menu-item" data-disabled={it.disabled ? '1' : '0'}
                      onClick={() => { if (it.disabled || it.sub) { if (it.sub) setSub(j); return } close(); it.action?.() }}>
                      {it.checked && <span className="ae-check">✓</span>}
                      <span>{it.label}</span>
                      {it.sc && <span className="ae-sc">{it.sc}</span>}
                      {it.sub && <span className="ae-sc">▸</span>}
                    </button>
                    {it.sub && sub === j && (
                      <div className="ae-menu left-full top-0 -mt-1 max-h-[70vh] overflow-y-auto as-scroll">
                        {it.sub.map((s, k) => (
                          <button key={k} className="ae-menu-item" data-disabled={s.disabled ? '1' : '0'} onClick={() => { if (s.disabled) return; close(); s.action() }}>{s.label}</button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ))}
      <div className="flex-1" />
      {right}
    </div>
  )
}
