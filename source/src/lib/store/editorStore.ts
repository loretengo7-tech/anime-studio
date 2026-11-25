/**
 * ANIME STUDIO — Editor Store
 *
 * Zustand store holding the committed project document plus:
 *  - Snapshot undo/redo (bounded), AI preview mode (draft overlay)
 *  - Selection state, panel state
 *  - Local autosave (localStorage) + server persistence
 */
import { create } from 'zustand'
import type { ProjectDoc, AIMessage, AIOperation, PreviewState, Clip } from '@/lib/engine/types'
import { createDefaultProject, uid } from '@/lib/engine/types'
import { executeOperations, validateOperations } from '@/lib/engine/aiTools'
import { playbackEngine } from '@/lib/engine/playback'
import { mediaManager } from '@/lib/media/mediaManager'
import { disposeInterpSession } from '@/lib/engine/interpolation'
import { writeAutosave, readAutosave } from '@/lib/media/autosave'

const MAX_UNDO = 80
const LS_KEY = 'anime-studio:project'
const LS_UI = 'anime-studio:ui'

export interface Toast {
  id: string
  kind: 'info' | 'success' | 'error' | 'ai'
  title: string
  detail?: string
}

interface EditorStore {
  doc: ProjectDoc
  past: ProjectDoc[]
  future: ProjectDoc[]
  selectedClipId: string | null
  /** All selected layers (AE multi-select). selectedClipId is the primary one. */
  selectedClipIds: string[]
  selectedKeyframeId: string | null
  /** Extra selected keyframes (Shift+click) — copy/paste/ease apply to all. */
  selectedKeyframeIds: string[]
  activePanel: 'assets' | 'effects' | 'plugins' | 'inspector' | 'graph' | 'speed' | 'audio' | 'text' | 'ai' | 'projects' | 'status' | 'enhance' | 'color' | 'comp' | 'tracker' | 'export' | 'settings' | 'beatsync' | 'cutout' | null
  preview: PreviewState | null
  aiBusy: boolean
  saveState: 'saved' | 'dirty' | 'saving'
  serverProjectId: string | null
  toasts: Toast[]
  jobs: JobInfo[]
  beatsDetecting: boolean
  /** Tracker pick mode: tap on the monitor arms a track point/quad corner. */
  trackerPick: { clipId: string; mode: 'point' | 'quad'; quadIndex?: number } | null
  /** Pen-mask point editing on the monitor for the given clip id. */
  maskEditing: string | null
  /** Latest tracking result for the monitor trail overlay (runtime only). */
  trackOverlay: { clipId: string; points: { x: number; y: number; time: number; confidence: number }[]; corners?: { x: number; y: number; time: number }[][] } | null

  // document mutations
  mutate: (fn: (doc: ProjectDoc) => void, label?: string) => void
  replaceDoc: (doc: ProjectDoc, keepHistory?: boolean) => void
  undo: () => void
  redo: () => void

  // selection
  select: (clipId: string | null) => void
  /** Ctrl/Cmd-click: add or remove a layer from the selection. */
  toggleSelect: (clipId: string) => void
  selectMany: (ids: string[]) => void
  selectKeyframe: (kfId: string | null, additive?: boolean) => void
  setPanel: (panel: EditorStore['activePanel']) => void

  // AI
  setAiBusy: (b: boolean) => void
  pushAIMessage: (msg: AIMessage) => void
  updateAIMessage: (id: string, patch: Partial<AIMessage>) => void
  commitAIExchange: (userMsg: AIMessage, aiMsg: AIMessage, ops: AIOperation[], mode: 'auto' | 'preview') => { applied: string[]; errors: string[]; validOps: AIOperation[] }
  applyAIOperations: (ops: AIOperation[], mode: 'auto' | 'preview', description: string) => { applied: string[]; errors: string[] }
  approvePreview: () => void
  rejectPreview: () => void

  // toasts / jobs
  toast: (t: Omit<Toast, 'id'>) => void
  dismissToast: (id: string) => void
  upsertJob: (j: JobInfo) => void
  setTrackerPick: (pick: { clipId: string; mode: 'point' | 'quad'; quadIndex?: number } | null) => void
  setMaskEditing: (clipId: string | null) => void
  setTrackOverlay: (overlay: { clipId: string; points: { x: number; y: number; time: number; confidence: number }[]; corners?: { x: number; y: number; time: number }[][] } | null) => void

  // persistence
  saveLocal: () => void
  saveToServer: () => Promise<void>
  loadFromServer: (id: string) => Promise<void>
  newProject: (name: string) => void
  renameProject: (name: string) => void
  duplicateProject: () => Promise<void>
  setServerProjectId: (id: string | null) => void
  setBeatsDetecting: (b: boolean) => void
}

export interface JobInfo {
  id: string
  kind: 'interp' | 'track' | 'enhance' | 'beat' | 'proxy'
  label: string
  status: 'running' | 'done' | 'error'
  progress: number
  message?: string
}

/** Migration applied to every doc that enters the store (boot, server load, .aeproject open). */
export function migrateDoc(doc: ProjectDoc): ProjectDoc {
  const comp = doc.composition ?? { width: 1920, height: 1080, fps: 30, duration: 30, background: '#000000' }
  const clips = (Array.isArray(doc.clips) ? doc.clips : []).map(c => ({
    ...c,
    // new-model defaults — only applied when the saved clip predates the field
    parentId: c.parentId ?? null,
    threeD: c.threeD ?? false,
    z: c.z ?? 0,
    trackMatte: c.trackMatte ?? null,
    // hard guards for fields every clip must have
    effects: Array.isArray(c.effects) ? c.effects : [],
    keyframes: Array.isArray(c.keyframes) ? c.keyframes : [],
    blendMode: c.blendMode ?? 'normal',
    x: c.x ?? 0, y: c.y ?? 0, scale: c.scale ?? 1, rotation: c.rotation ?? 0, opacity: c.opacity ?? 1,
    anchorX: c.anchorX ?? 0, anchorY: c.anchorY ?? 0,
    speed: c.speed ?? 1,
    timeRemap: c.timeRemap ?? null,
    mask: c.mask ?? null,
    name: c.name ?? 'Layer',
  }))
  return {
    ...doc,
    composition: comp,
    tracks: Array.isArray(doc.tracks) ? doc.tracks : [],
    clips,
    assets: Array.isArray(doc.assets) ? doc.assets : [],
    markers: Array.isArray(doc.markers) ? doc.markers : [],
    beats: Array.isArray(doc.beats) ? doc.beats : [],
    aiHistory: Array.isArray(doc.aiHistory) ? doc.aiHistory : [],
    version: 1,
  }
}

// ---------------------------------------------------------------------------
// Migration + persistence helpers (migrateDoc is exported for .aeproject open)
// ---------------------------------------------------------------------------

function loadLocal(): ProjectDoc | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const doc = JSON.parse(raw) as ProjectDoc
    if (doc && doc.composition && Array.isArray(doc.clips)) return migrateDoc(doc)
    return null
  } catch {
    return null
  }
}

function loadUI(): { panel?: EditorStore['activePanel'] } {
  try {
    return JSON.parse(localStorage.getItem(LS_UI) ?? '{}')
  } catch {
    return {}
  }
}

function persistUI(panel: EditorStore['activePanel']) {
  try { localStorage.setItem(LS_UI, JSON.stringify({ panel })) } catch { }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

export const useEditorStore = create<EditorStore>((set, get) => {
  const initial = loadLocal() ?? createDefaultProject('Untitled AMV')
  const ui = loadUI()
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    set({ saveState: 'dirty' })
    saveTimer = setTimeout(() => {
      get().saveLocal()
    }, 1200)
  }

  return {
    doc: initial,
    past: [],
    future: [],
    selectedClipId: null,
    selectedClipIds: [],
    selectedKeyframeId: null,
    selectedKeyframeIds: [],
    activePanel: ui.panel ?? null,
    preview: null,
    aiBusy: false,
    saveState: 'saved',
    serverProjectId: null,
    toasts: [],
    jobs: [],
    beatsDetecting: false,
    trackerPick: null,
    maskEditing: null,
    trackOverlay: null,

    setTrackerPick: (pick) => set({ trackerPick: pick }),
    setMaskEditing: (clipId) => set({ maskEditing: clipId }),
    setTrackOverlay: (overlay) => set({ trackOverlay: overlay }),

    mutate: (fn, _label) => {
      const { doc, past } = get()
      const next = JSON.parse(JSON.stringify(doc)) as ProjectDoc
      fn(next)
      next.updatedAt = Date.now()
      set({
        doc: next,
        past: [...past.slice(-MAX_UNDO), doc],
        future: [],
      })
      scheduleSave()
    },

    replaceDoc: (doc, keepHistory = true) => {
      const { doc: old } = get()
      set({
        doc,
        past: keepHistory ? [...get().past.slice(-MAX_UNDO), old] : [],
        future: [],
      })
      scheduleSave()
    },

    undo: () => {
      const { past, doc, future } = get()
      if (past.length === 0) return
      const prev = past[past.length - 1]
      set({ doc: prev, past: past.slice(0, -1), future: [doc, ...future].slice(0, MAX_UNDO), preview: null })
      scheduleSave()
    },

    redo: () => {
      const { future, doc, past } = get()
      if (future.length === 0) return
      const next = future[0]
      set({ doc: next, future: future.slice(1), past: [...past, doc] })
      scheduleSave()
    },

    select: (clipId) => {
      const cur = get()
      // keep a multi-selection when clicking one of its members (AE behaviour)
      if (clipId && cur.selectedClipIds.length > 1 && cur.selectedClipIds.includes(clipId)) {
        set({ selectedClipId: clipId, selectedKeyframeId: null, selectedKeyframeIds: [] })
        return
      }
      set({ selectedClipId: clipId, selectedClipIds: clipId ? [clipId] : [], selectedKeyframeId: null, selectedKeyframeIds: [] })
    },
    toggleSelect: (clipId) => {
      const ids = get().selectedClipIds
      const next = ids.includes(clipId) ? ids.filter(i => i !== clipId) : [...ids, clipId]
      set({ selectedClipIds: next, selectedClipId: next.length ? (next.includes(clipId) ? clipId : next[next.length - 1]) : null, selectedKeyframeId: null, selectedKeyframeIds: [] })
    },
    selectMany: (ids) => set({ selectedClipIds: ids, selectedClipId: ids[ids.length - 1] ?? null, selectedKeyframeId: null, selectedKeyframeIds: [] }),
    selectKeyframe: (kfId, additive = false) => {
      if (!kfId) { set({ selectedKeyframeId: null, selectedKeyframeIds: [] }); return }
      if (additive) {
        const ids = get().selectedKeyframeIds
        const base = ids.length ? ids : (get().selectedKeyframeId ? [get().selectedKeyframeId!] : [])
        const next = base.includes(kfId) ? base.filter(i => i !== kfId) : [...base, kfId]
        set({ selectedKeyframeId: next[next.length - 1] ?? null, selectedKeyframeIds: next })
        return
      }
      set({ selectedKeyframeId: kfId, selectedKeyframeIds: [kfId] })
    },
    setPanel: (panel) => {
      set({ activePanel: panel })
      persistUI(panel)
    },

    setAiBusy: (b) => set({ aiBusy: b }),

    /**
     * Atomic AI commit: user message + assistant message + executed
     * operations land as ONE undoable step.
     */
    commitAIExchange: (userMsg, aiMsg, ops, mode) => {
      const { doc } = get()
      const { valid, errors } = validateOperations(ops)
      const result = executeOperations(doc, valid)
      const nextDoc = JSON.parse(JSON.stringify(result.doc)) as ProjectDoc
      nextDoc.aiHistory = [...nextDoc.aiHistory, userMsg, aiMsg]
      nextDoc.updatedAt = Date.now()
      if (mode === 'auto') {
        set({
          doc: nextDoc,
          past: [...get().past.slice(-MAX_UNDO), doc],
          future: [],
        })
        scheduleSave()
      } else {
        // preview: messages commit instantly; ops stay staged
        get().mutate(d => {
          d.aiHistory.push(userMsg, aiMsg)
        })
        set({ preview: { ops: valid, draft: nextDoc, description: aiMsg.content, createdAt: Date.now() } })
      }
      return { applied: result.applied, errors: [...errors, ...result.errors], validOps: valid }
    },

    pushAIMessage: (msg) => {
      get().mutate(d => { d.aiHistory.push(msg) })
    },
    updateAIMessage: (id, patch) => {
      get().mutate(d => {
        const m = d.aiHistory.find(m => m.id === id)
        if (m) Object.assign(m, patch)
      })
    },

    applyAIOperations: (ops, mode, description) => {
      const { doc } = get()
      const { valid, errors } = validateOperations(ops)
      const result = executeOperations(doc, valid)
      if (mode === 'auto') {
        set({
          doc: result.doc,
          past: [...get().past.slice(-MAX_UNDO), doc],
          future: [],
        })
        scheduleSave()
      } else {
        set({ preview: { ops: valid, draft: result.doc, description, createdAt: Date.now() } })
      }
      return { applied: result.applied, errors: [...errors, ...result.errors] }
    },

    approvePreview: () => {
      const { preview, doc } = get()
      if (!preview) return
      set({
        doc: preview.draft,
        past: [...get().past.slice(-MAX_UNDO), doc],
        future: [],
        preview: null,
      })
      scheduleSave()
    },

    rejectPreview: () => set({ preview: null }),

    toast: (t) => {
      const id = uid('t')
      set({ toasts: [...get().toasts.slice(-4), { ...t, id }] })
      if (t.kind !== 'error') {
        setTimeout(() => get().dismissToast(id), 5200)
      }
    },
    dismissToast: (id) => set({ toasts: get().toasts.filter(t => t.id !== id) }),
    upsertJob: (j) => {
      const jobs = [...get().jobs]
      const i = jobs.findIndex(x => x.id === j.id)
      if (i >= 0) jobs[i] = j; else jobs.push(j)
      set({ jobs })
    },

    saveLocal: () => {
      const { doc } = get()
      let ok = true
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({ ...doc, aiHistory: doc.aiHistory.slice(-40) }))
      } catch {
        // localStorage full/blocked — IndexedDB below is the durable fallback
        ok = false
      }
      // IndexedDB autosave (durable, bigger quota) — failures are surfaced, never silent
      void writeAutosave({ ...doc, aiHistory: doc.aiHistory.slice(-40) })
        .then(() => {
          if (ok) set({ saveState: 'saved' })
        })
        .catch(() => {
          set({ saveState: ok ? 'saved' : 'dirty' })
          if (!ok) {
            get().toast({
              kind: 'error',
              title: 'Autosave failed',
              detail: 'Storage is full or blocked (private mode?). Export a .aeproject backup from the Projects panel to avoid losing edits.',
            })
          }
        })
      if (ok) return
      // localStorage failed but idb may still be running — it reports its own toast
      set({ saveState: 'saving' })
    },

    saveToServer: async () => {
      const { doc, serverProjectId } = get()
      set({ saveState: 'saving' })
      try {
        const payload = JSON.stringify({ ...doc, aiHistory: doc.aiHistory.slice(-60) })
        let id = serverProjectId
        if (id) {
          const res = await fetch(`/api/projects/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
          })
          if (!res.ok) throw new Error(await res.text())
        } else {
          const res = await fetch('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
          })
          if (!res.ok) throw new Error(await res.text())
          const json = await res.json()
          id = json.id
          set({ serverProjectId: id })
        }
        set({ saveState: 'saved' })
      } catch (e) {
        set({ saveState: 'dirty' })
        get().toast({ kind: 'error', title: 'Server save failed', detail: e instanceof Error ? e.message : String(e) })
      }
    },

    loadFromServer: async (id) => {
      try {
        const res = await fetch(`/api/projects/${id}`)
        if (!res.ok) throw new Error(await res.text())
        const raw = await res.json()
        const doc = migrateDoc(typeof raw.data === 'string' ? JSON.parse(raw.data) : raw)
        if (!doc?.composition) throw new Error('Invalid project document')
        playbackEngine.setDoc(doc)
        mediaManager.dispose()
        // re-register assets into runtime
        for (const a of doc.assets ?? []) mediaManager.registerAsset(a)
        set({ doc, serverProjectId: id, past: [], future: [], preview: null, selectedClipId: null, selectedClipIds: [] })
        get().saveLocal()
      } catch (e) {
        get().toast({ kind: 'error', title: 'Open failed', detail: e instanceof Error ? e.message : String(e) })
      }
    },

    newProject: (name) => {
      const fresh = createDefaultProject(name)
      playbackEngine.setDoc(fresh)
      mediaManager.dispose()
      // clear ALL interp sessions + the synthesis hook (before: only clip '' was
      // disposed, leaving stale sessions that kept consuming memory)
      void import('@/lib/engine/interpolation').then(({ listSessions }) => {
        for (const s of listSessions()) disposeInterpSession(s.clipId)
      })
      set({
        doc: fresh, past: [], future: [], preview: null,
        selectedClipId: null, selectedClipIds: [], serverProjectId: null,
      })
      get().saveLocal()
    },

    renameProject: (name) => {
      get().mutate(d => { d.name = name })
    },

    duplicateProject: async () => {
      const { doc } = get()
      const copy = JSON.parse(JSON.stringify({ ...doc, id: uid('proj'), name: `${doc.name} (copy)` })) as ProjectDoc
      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(copy),
        })
        if (res.ok) {
          const json = await res.json()
          get().toast({ kind: 'success', title: 'Project duplicated on server' })
          void json
        }
      } catch {
        get().toast({ kind: 'error', title: 'Duplicate failed' })
      }
    },

    setServerProjectId: (id) => set({ serverProjectId: id }),
    setBeatsDetecting: (b) => set({ beatsDetecting: b }),
  }
})

/**
 * Boot recovery: if the IndexedDB autosave is NEWER than what localStorage
 * provided (localStorage cleared / blocked while IndexedDB survived), swap it
 * in and tell the user. Also reports an honest error when recovery is
 * impossible. Called once from the Workspace boot effect.
 */
export async function recoverAutosave(): Promise<void> {
  try {
    const rec = await readAutosave()
    if (!rec?.doc?.composition) return
    const s = useEditorStore.getState()
    if (rec.at > s.doc.updatedAt + 1000 && rec.doc.updatedAt > s.doc.updatedAt) {
      const restored = migrateDoc(JSON.parse(JSON.stringify(rec.doc)) as ProjectDoc)
      playbackEngine.setDoc(restored)
      mediaManager.dispose()
      for (const a of restored.assets) mediaManager.registerAsset(a)
      useEditorStore.setState({ doc: restored, past: [], future: [], preview: null, selectedClipId: null, selectedClipIds: [] })
      s.toast({ kind: 'success', title: 'Recovered newer autosave', detail: `Restored from ${new Date(rec.at).toLocaleTimeString()} — ${restored.clips.length} layers.` })
    }
  } catch (e) {
    useEditorStore.getState().toast({
      kind: 'error',
      title: 'Autosave recovery failed',
      detail: e instanceof Error ? e.message : String(e),
    })
  }
}

// ---- selector helpers ----
export function selectedClip(s: EditorStore): Clip | null {
  return s.doc.clips.find(c => c.id === s.selectedClipId) ?? null
}
