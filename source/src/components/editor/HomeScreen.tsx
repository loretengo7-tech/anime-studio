'use client'
/**
 * ANIME STUDIO — Home (like After Effects' start screen): new project, open,
 * and the recent projects library. Every project is saved on its own.
 */
import { useEffect, useRef, useState } from 'react'
import { useEditorStore, migrateDoc } from '@/lib/store/editorStore'
import { listLibrary, loadFromLibrary, deleteFromLibrary, renameInLibrary, duplicateInLibrary, onLibraryChange, saveToLibrary, type LibraryEntry } from '@/lib/store/projectLibrary'
import { parseProject } from '@/lib/media/projectFile'
import { restoreLocalAssets, listStoredMediaIds, STATIC_MODE } from '@/lib/media/staticMode'
import { mediaManager } from '@/lib/media/mediaManager'
import { playbackEngine } from '@/lib/engine/playback'
import type { AssetMeta, ProjectDoc } from '@/lib/engine/types'
import { createDefaultProject } from '@/lib/engine/types'
import { Plus, FolderOpen, Film, Copy, Trash2, Pencil, X, Clock } from 'lucide-react'

const HOME_KEY = 'anime-studio:show-home'
export function homeOnStart(): boolean { try { return localStorage.getItem(HOME_KEY) !== '0' } catch { return true } }

/** Open a project doc as the current project (current one stays in the library). */
export async function openProjectDoc(doc: ProjectDoc) {
  const st = useEditorStore.getState()
  try { await saveToLibrary(st.doc) } catch { /* best effort */ }
  playbackEngine.pause()
  mediaManager.dispose()
  const d = migrateDoc(doc)
  useEditorStore.setState({ selectedClipId: null, selectedClipIds: [], selectedKeyframeId: null, selectedKeyframeIds: [], preview: null })
  st.replaceDoc(d, false)
  let patched: AssetMeta[] = d.assets ?? []
  try { if (STATIC_MODE) patched = await restoreLocalAssets(patched) } catch { }
  useEditorStore.setState(s => ({ doc: { ...s.doc, assets: patched } }))
  for (const a of patched) mediaManager.registerAsset(a)
  playbackEngine.setDoc(useEditorStore.getState().doc)
  playbackEngine.clearCache()
  if (STATIC_MODE) {
    try {
      const ids = await listStoredMediaIds()
      const missing = (d.assets ?? []).filter(a => !a.missingPath && !ids.has(a.id))
      if (missing.length) st.toast({ kind: 'error', title: `${missing.length} missing footage item${missing.length > 1 ? 's' : ''}`, detail: `Re-import: ${missing.map(a => a.name).join(', ')}` })
    } catch { }
  }
}

export async function newProjectFromHome(name = 'Untitled Project') {
  const st = useEditorStore.getState()
  try { await saveToLibrary(st.doc) } catch { }
  st.newProject(name)
}

function ago(t: number) {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(t).toLocaleDateString()
}

export function HomeScreen({ onClose }: { onClose: () => void }) {
  const current = useEditorStore(s => s.doc.id)
  const toast = useEditorStore(s => s.toast)
  const [items, setItems] = useState<LibraryEntry[]>([])
  const [showOnStart, setShowOnStart] = useState(homeOnStart())
  const [renaming, setRenaming] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const load = () => void listLibrary().then(setItems)
    load()
    return onLibraryChange(load)
  }, [])

  const open = async (id: string) => {
    if (id === current) { onClose(); return }
    const doc = await loadFromLibrary(id)
    if (!doc) { toast({ kind: 'error', title: 'Project not found' }); return }
    await openProjectDoc(doc)
    onClose()
  }
  const openFile = async (f: File) => {
    try {
      if (/\.(aep|aepx)$/i.test(f.name)) {
        const { importAfterEffectsProject } = await import('@/lib/media/aepImport')
        const doc = await importAfterEffectsProject(f)
        await openProjectDoc(doc)
        toast({ kind: 'success', title: `Imported "${doc.name}" from After Effects`, detail: `${doc.clips.length} layers · relink footage by importing the files (matched by name)` })
      } else {
        const { doc } = parseProject(await f.text())
        await openProjectDoc({ ...doc, id: doc.id || createDefaultProject().id })
      }
      onClose()
    } catch (e) { toast({ kind: 'error', title: 'Could not open the project', detail: e instanceof Error ? e.message : String(e) }) }
  }

  return (
    <div className="absolute inset-0 z-[270] bg-[#161616]/97 backdrop-blur-sm flex text-[13px]">
      <div className="w-[260px] shrink-0 border-r border-black bg-[#1b1b1b] p-5 flex flex-col gap-2">
        <div className="text-[22px] font-semibold tracking-wide text-white mb-4">ANIME<span className="text-amber-400">STUDIO</span></div>
        <button className="gbtn gbtn-accent h-10 flex items-center justify-center gap-2 text-[13px] font-semibold" onClick={() => void newProjectFromHome().then(onClose)}><Plus size={16} /> New Project</button>
        <button className="gbtn h-10 flex items-center justify-center gap-2 text-[13px]" onClick={() => fileRef.current?.click()}><FolderOpen size={16} /> Open Project…</button>
        <input ref={fileRef} type="file" accept=".aeproject,.json,.aep,.aepx" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void openFile(f); e.target.value = '' }} />
        <div className="text-[11px] text-zinc-500 mt-1 leading-4">Opens AnimeStudio projects (.aeproject) and After Effects projects (.aep / .aepx).</div>
        <div className="flex-1" />
        <label className="flex items-center gap-2 text-[12px] text-zinc-400">
          <input type="checkbox" checked={showOnStart} onChange={e => { setShowOnStart(e.target.checked); try { localStorage.setItem(HOME_KEY, e.target.checked ? '1' : '0') } catch { } }} />
          Show Home on start
        </label>
      </div>
      <div className="flex-1 min-w-0 p-6 overflow-auto as-scroll">
        <div className="flex items-center mb-4">
          <div className="text-[18px] font-semibold text-zinc-100 flex items-center gap-2"><Clock size={16} className="text-zinc-400" /> Recent projects</div>
          <div className="flex-1" />
          <button className="tb-btn !w-8 !h-8" onClick={onClose} title="Close (Esc)" aria-label="Close"><X size={16} /></button>
        </div>
        {items.length === 0 && <div className="text-zinc-500 py-10">No saved projects yet — create one with New Project.</div>}
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {items.map(p => (
            <div key={p.id} className="group rounded-[6px] bg-[#222] border border-black hover:border-[#2d8ceb] overflow-hidden cursor-pointer" onClick={() => void open(p.id)}>
              <div className="aspect-video bg-black/70 flex items-center justify-center relative">
                {p.thumb ? <img src={p.thumb} alt="" className="w-full h-full object-cover" /> : <Film size={28} className="text-zinc-600" />}
                {p.id === current && <span className="absolute left-2 top-2 text-[10px] font-semibold bg-[#2d8ceb] text-white px-1.5 py-0.5 rounded">OPEN</span>}
                <div className="absolute right-1.5 top-1.5 hidden group-hover:flex gap-1" onClick={e => e.stopPropagation()}>
                  <button className="tb-btn !w-7 !h-7 bg-black/70" title="Rename" onClick={() => setRenaming(p.id)}><Pencil size={13} /></button>
                  <button className="tb-btn !w-7 !h-7 bg-black/70" title="Duplicate" onClick={() => void duplicateInLibrary(p.id)}><Copy size={13} /></button>
                  <button className="tb-btn !w-7 !h-7 bg-black/70" title="Delete" disabled={p.id === current} onClick={() => { if (window.confirm(`Delete "${p.name}"? This can't be undone.`)) void deleteFromLibrary(p.id) }}><Trash2 size={13} /></button>
                </div>
              </div>
              <div className="p-2.5">
                {renaming === p.id ? (
                  <input autoFocus defaultValue={p.name} className="ginput w-full" onClick={e => e.stopPropagation()}
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null) }}
                    onBlur={e => { const v = e.target.value.trim(); setRenaming(null); if (v && v !== p.name) { void renameInLibrary(p.id, v); if (p.id === current) useEditorStore.getState().mutate(d => { d.name = v }) } }} />
                ) : <div className="text-zinc-100 font-medium truncate">{p.name}</div>}
                <div className="text-[11px] text-zinc-500 mt-0.5">{ago(p.updatedAt)} · {p.width}×{p.height} · {p.fps} fps · {p.layers} layer{p.layers === 1 ? '' : 's'}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
