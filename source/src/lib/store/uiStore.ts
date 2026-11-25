/**
 * ANIME STUDIO — UI-only state for the AE-style desktop workspace
 * (active tool, workspace preset, focused panel, timeline reveal state, …).
 * Kept apart from editorStore so it never enters undo history or autosave.
 */
import { create } from 'zustand'

export type ToolId = 'select' | 'hand' | 'zoom' | 'rotate' | 'anchor' | 'rect' | 'ellipse' | 'pen' | 'text'
export type WorkspaceId = 'default' | 'animation' | 'effects' | 'minimal'
export type RevealProp = 'anchor' | 'position' | 'scale' | 'rotation' | 'opacity'

export interface ViewerGuides { grid: boolean; safe: boolean; checker: boolean }

interface UIStore {
  tool: ToolId
  setTool: (t: ToolId) => void
  workspace: WorkspaceId
  setWorkspace: (w: WorkspaceId) => void
  /** Which panel has keyboard focus (blue frame in AE). */
  focus: string
  setFocus: (f: string) => void
  /** Timeline: twirled-open layers. */
  open: Record<string, boolean>
  setOpen: (clipId: string, v: boolean) => void
  /** Timeline: when set, only these properties are revealed (P/S/R/T/A/U). */
  reveal: { props: RevealProp[] | 'animated' | null; clipIds: string[] } | null
  setReveal: (r: UIStore['reveal']) => void
  shyHidden: boolean
  toggleShy: () => void
  graphMode: boolean
  setGraphMode: (v: boolean) => void
  guides: ViewerGuides
  setGuides: (g: Partial<ViewerGuides>) => void
  /** Window menu: modal panel shown as floating window (AE dialogs). */
  dialog: string | null
  setDialog: (d: string | null) => void
  /** Cursor position over the viewer in comp pixels (Info panel). */
  cursor: { x: number; y: number } | null
  setCursor: (c: { x: number; y: number } | null) => void
}

const KEY = 'anime-studio:ae-ui'
function load(): Partial<UIStore> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') } catch { return {} }
}
function save(s: Partial<UIStore>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ workspace: s.workspace, guides: s.guides, shyHidden: s.shyHidden }))
  } catch { /* private mode */ }
}

export const useUIStore = create<UIStore>((set, get) => {
  const init = typeof window !== 'undefined' ? load() : {}
  const persist = () => save(get())
  return {
    tool: 'select',
    setTool: tool => set({ tool }),
    workspace: (init.workspace as WorkspaceId) ?? 'default',
    setWorkspace: workspace => { set({ workspace }); persist() },
    focus: 'timeline',
    setFocus: focus => { if (get().focus !== focus) set({ focus }) },
    open: {},
    setOpen: (id, v) => set(s => ({ open: { ...s.open, [id]: v } })),
    reveal: null,
    setReveal: reveal => set({ reveal }),
    shyHidden: init.shyHidden ?? false,
    toggleShy: () => { set(s => ({ shyHidden: !s.shyHidden })); persist() },
    graphMode: false,
    setGraphMode: graphMode => set({ graphMode }),
    guides: { grid: false, safe: false, checker: false, ...(init.guides ?? {}) },
    setGuides: g => { set(s => ({ guides: { ...s.guides, ...g } })); persist() },
    dialog: null,
    setDialog: dialog => set({ dialog }),
    cursor: null,
    setCursor: cursor => set({ cursor }),
  }
})
