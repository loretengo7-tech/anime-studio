'use client'
/**
 * ANIME STUDIO — AI Templates: turn a reference edit into a template, then fill it
 * with your own clips.
 */
import { useMemo, useRef, useState } from 'react'
import { useEditorStore } from '@/lib/store/editorStore'
import type { AssetMeta } from '@/lib/engine/types'
import { ProGate } from './AccountPanel'
import {
  analyzeReference, requestTemplate, buildTemplateProject, fillTemplate, clearTemplate,
  listTemplates, saveTemplate, deleteTemplate, type EditAnalysis, type TemplateSpec, type SavedTemplate,
} from '@/lib/ai/editTemplate'
import { importFiles } from './ae/aeActions'
import { mediaManager } from '@/lib/media/mediaManager'
import { playbackEngine } from '@/lib/engine/playback'
import { Wand2, Loader2, Upload, Shuffle, Eraser, Sparkles, Trash2, Film , Square } from 'lucide-react'

export function AITemplatesPanel() {
  return <ProGate feature="AI Templates"><AITemplatesInner /></ProGate>
}

function AITemplatesInner() {
  const doc = useEditorStore(s => s.doc)
  const toast = useEditorStore(s => s.toast)
  const videos = doc.assets.filter(a => a.kind === 'video' && !a.missingPath)
  const [refId, setRefId] = useState<string>('')
  const ref = videos.find(v => v.id === refId) ?? videos[0]
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState<{ phase: string; progress: number } | null>(null)
  const [result, setResult] = useState<{ spec: TemplateSpec; analysis: EditAnalysis; ref: AssetMeta } | null>(null)
  const [lib, setLib] = useState<SavedTemplate[]>(() => listTemplates())
  const abort = useRef<AbortController | null>(null)
  const cancelled = useRef(false)
  const hasKey = true // access is checked by ProGate + the server

  const slots = doc.clips.filter(c => c.templateSlot)
  const filled = slots.filter(c => c.kind !== 'solid').length
  const refInDoc = new Set(doc.clips.filter(c => c.kind === 'audio').map(c => (c as { assetId?: string }).assetId))
  const userClips = useMemo(() => doc.assets.filter(a => (a.kind === 'video' || a.kind === 'image') && !a.missingPath && !refInDoc.has(a.id)), [doc.assets, doc.clips]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    if (!ref) return
    cancelled.current = false
    abort.current = new AbortController()
    try {
      setBusy({ phase: 'Opening the edit…', progress: 0.02 })
      const analysis = await analyzeReference(ref, p => setBusy({ phase: p.phase, progress: p.progress * 0.5 }), () => cancelled.current)
      setBusy({ phase: `Claude is studying ${analysis.segments.length} shots, ${analysis.frames.length} frames…`, progress: 0.55 })
      const spec = await requestTemplate(analysis, notes, abort.current.signal)
      setResult({ spec, analysis, ref })
      setLib([saveTemplate(spec, analysis, ref), ...lib.filter(x => x.id !== '')].slice(0, 30))
      toast({ kind: 'ai', title: `Template ready: ${spec.name}`, detail: `${spec.segments.length} slots · ${analysis.bpm ? `${analysis.bpm} BPM` : 'no beat detected'} — press “Create template project”` })
    } catch (e) {
      if (!cancelled.current) toast({ kind: 'error', title: 'Template failed', detail: e instanceof Error ? e.message : String(e) })
    } finally { setBusy(null); abort.current = null }
  }
  const stop = () => { cancelled.current = true; abort.current?.abort() }

  const create = async (spec: TemplateSpec, analysis: Omit<EditAnalysis, 'frames'> & { frames?: EditAnalysis['frames'] }, refAsset: AssetMeta) => {
    const built = buildTemplateProject(spec, { ...analysis, frames: analysis.frames ?? [] }, refAsset)
    const { openProjectDoc } = await import('./HomeScreen')
    await openProjectDoc(built)
    toast({ kind: 'success', title: `Opened “${built.name}”`, detail: 'Import your clips (drop them anywhere) and press “Fill slots with my clips”.' })
  }

  const fill = (shuffle: boolean) => {
    const s = useEditorStore.getState()
    const r = fillTemplate(s.doc, userClips, { shuffle })
    if (!r.filled) { toast({ kind: 'error', title: 'Nothing to fill', detail: userClips.length ? 'This project has no template slots.' : 'Import your clips first (drop them anywhere).' }); return }
    for (const a of userClips) mediaManager.registerAsset(a)
    s.replaceDoc(r.doc, true)
    playbackEngine.clearCache()
    toast({ kind: 'success', title: `Filled ${r.filled} slots`, detail: `${userClips.length} clip${userClips.length > 1 ? 's' : ''} · press Shuffle for another mix` })
  }
  const clear = () => { const s = useEditorStore.getState(); s.replaceDoc(clearTemplate(s.doc), true); playbackEngine.clearCache() }
  const importClips = () => {
    const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.accept = 'video/*,image/*,.mkv,.mov'
    i.onchange = () => { if (i.files?.length) void importFiles(i.files) }
    i.click()
  }

  return (
    <div className="p-3 text-[12px] space-y-3 pb-10">
      <h3 className="flex items-center gap-1.5"><Sparkles size={14} className="text-violet-400" /> AI Templates</h3>
      <p className="text-zinc-400 leading-5">Give it an edit you like: the AI measures its cuts, flashes and beats, looks at every shot and rebuilds it as a template. Then drop your clips in and it fills every slot with the same moves, effects and speed ramps.</p>


      {/* ---- 1. reference */}
      <div className="space-y-1.5">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">1 · Reference edit</div>
        {videos.length ? (
          <select className="ae-vb-select w-full" value={ref?.id ?? ''} onChange={e => setRefId(e.target.value)}>
            {videos.map(v => <option key={v.id} value={v.id}>{v.name} · {v.duration.toFixed(1)}s</option>)}
          </select>
        ) : <div className="text-zinc-500">Import the edit you want to copy (drop it anywhere).</div>}
        <button className="gbtn w-full py-1.5 flex items-center justify-center gap-1.5" onClick={importClips}><Upload size={13} /> Import video…</button>
        <textarea className="ginput w-full text-[12px] p-2 rounded h-14 resize-none" placeholder="Optional notes: “more aggressive”, “keep it calm”, “add glow on drops”…" value={notes} onChange={e => setNotes(e.target.value)} />
        {busy ? (
          <div>
            <div className="flex items-center gap-2 text-zinc-300"><Loader2 size={13} className="animate-spin" /> {busy.phase}</div>
            <div className="h-1.5 bg-[#333] mt-1.5"><div className="h-full bg-violet-500 transition-all" style={{ width: `${Math.round(busy.progress * 100)}%` }} /></div>
            <button className="gbtn w-full py-1 mt-2 flex items-center justify-center gap-1" onClick={stop}><Square size={11} /> Cancel</button>
          </div>
        ) : (
          <button className="gbtn gbtn-accent w-full py-2 flex items-center justify-center gap-1.5 font-semibold" disabled={!ref || !hasKey} onClick={() => void run()}>
            <Wand2 size={14} /> Analyze &amp; create template
          </button>
        )}
      </div>

      {/* ---- 2. result */}
      {result && (
        <div className="rounded-lg border border-violet-500/40 bg-violet-500/5 p-2.5 space-y-2">
          <div className="text-zinc-100 font-semibold">{result.spec.name}</div>
          {result.spec.summary && <div className="text-zinc-400 leading-4">{result.spec.summary}</div>}
          <div className="flex flex-wrap gap-1">{result.spec.style.map(s => <span key={s} className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-200">{s}</span>)}</div>
          <div className="text-[11px] text-zinc-500">{result.spec.segments.length} slots · {result.analysis.flashes.length} flashes · {result.analysis.bpm ? `${result.analysis.bpm} BPM` : 'no beat'} · {result.analysis.duration.toFixed(1)}s</div>
          <div className="max-h-48 overflow-auto as-scroll space-y-0.5">
            {result.spec.segments.map((s, k) => {
              const seg = result.analysis.segments[k]
              return (
                <div key={k} className="text-[11px] text-zinc-300 flex gap-1.5">
                  <span className="text-zinc-500 as-mono w-10 shrink-0">{seg.start.toFixed(2)}</span>
                  <span className="truncate"><b className="text-zinc-200">{s.role}</b> · {s.slotHint}{s.camera.type !== 'none' ? ` · ${s.camera.type}` : ''}{s.shake > 0.05 ? ' · shake' : ''}{s.velocity.preset !== 'none' ? ` · ${s.velocity.preset}` : ''}{s.flashIn ? ' · flash' : ''}{s.effects.length ? ` · ${s.effects.map(e => e.type).join(', ')}` : ''}</span>
                </div>
              )
            })}
          </div>
          <button className="gbtn gbtn-accent w-full py-2 flex items-center justify-center gap-1.5 font-semibold" onClick={() => void create(result.spec, result.analysis, result.ref)}><Film size={14} /> Create template project</button>
        </div>
      )}

      {/* ---- 3. fill */}
      {slots.length > 0 && (
        <div className="space-y-1.5 border-t border-[#333] pt-3">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">2 · Your clips</div>
          <div className="text-zinc-400">{slots.length} slots in this project · {filled} filled · {userClips.length} clip{userClips.length === 1 ? '' : 's'} imported</div>
          <button className="gbtn w-full py-1.5 flex items-center justify-center gap-1.5" onClick={importClips}><Upload size={13} /> Import my clips…</button>
          <button className="gbtn gbtn-accent w-full py-2 flex items-center justify-center gap-1.5 font-semibold" disabled={!userClips.length} onClick={() => fill(false)}><Wand2 size={14} /> Fill slots with my clips</button>
          <div className="flex gap-1.5">
            <button className="gbtn flex-1 py-1.5 flex items-center justify-center gap-1" disabled={!userClips.length} onClick={() => fill(true)}><Shuffle size={13} /> Shuffle</button>
            <button className="gbtn flex-1 py-1.5 flex items-center justify-center gap-1" disabled={!filled} onClick={clear}><Eraser size={13} /> Clear</button>
          </div>
          <div className="text-[10px] text-zinc-500 leading-4">Each slot keeps the template’s zooms, shakes, effects and speed ramp. To place a specific clip, select the slot in the timeline and swap it like any layer.</div>
        </div>
      )}

      {/* ---- library */}
      {lib.length > 0 && (
        <div className="space-y-1 border-t border-[#333] pt-3">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">My templates</div>
          {lib.map(t => (
            <div key={t.id} className="flex items-center gap-1.5 rounded-md glass-soft px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="text-zinc-200 truncate">{t.spec.name}</div>
                <div className="text-[10px] text-zinc-500 truncate">{t.spec.segments.length} slots · {t.ref.name}</div>
              </div>
              <button className="gbtn h-7 px-2 text-[11px]" title="Create a project from this template" onClick={() => void create(t.spec, t.analysis, t.ref)}>Use</button>
              <button className="p-1 text-zinc-500 hover:text-red-400" title="Delete" onClick={() => { deleteTemplate(t.id); setLib(listTemplates()) }}><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      )}
      <p className="text-[10px] text-zinc-600 leading-4">The edit is measured on your device; only small frames (256 px) and the measurements are sent to the AI. Each template counts toward your monthly Pro quota.</p>
    </div>
  )
}
