'use client'
/**
 * ANIME STUDIO — AI Editing Assistant
 * Browser-direct LLM (user's own key, device-local) → validated operations → engine.
 */
import { useRef, useState, useEffect } from 'react'
import type { AIOperation, AIMessage } from '@/lib/engine/types'
import { uid } from '@/lib/engine/types'
import { useEditorStore } from '@/lib/store/editorStore'
import { playbackEngine } from '@/lib/engine/playback'
import { trackPoint } from '@/lib/engine/tracker'
import { runAIEdit } from '@/lib/ai/aiClient'
import { loadAISettings } from '@/lib/ai/settings'
import type { VideoClip } from '@/lib/engine/types'
import { Send, Loader2, Sparkles, Check, X, Bot, CircleAlert, Settings2 } from 'lucide-react'

const SUGGESTIONS = [
  'Create a cinematic velocity edit',
  'Add smooth slow motion to this clip',
  'Make it look cinematic',
  'Impact shake when the beat drops',
  'Camera zoom in with acceleration',
  'Glow the highlights blue',
  'Add a title: ANIME STUDIO',
  'Sync glow to the music',
]

export function AIAssistant() {
  const doc = useEditorStore(s => s.doc)
  const mutate = useEditorStore(s => s.mutate)
  const aiBusy = useEditorStore(s => s.aiBusy)
  const setAiBusy = useEditorStore(s => s.setAiBusy)
  const toast = useEditorStore(s => s.toast)
  const setPanel = useEditorStore(s => s.setPanel)
  const approvePreview = useEditorStore(s => s.approvePreview)
  const rejectPreview = useEditorStore(s => s.rejectPreview)
  const preview = useEditorStore(s => s.preview)
  const upsertJob = useEditorStore(s => s.upsertJob)

  const [mode, setMode] = useState<'auto' | 'preview'>('auto')
  const [input, setInput] = useState('')
  const [localBusy, setLocalBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const appliedRef = useRef<string[]>([])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [doc.aiHistory.length])

  const buildContext = () => {
    const trackById = new Map(doc.tracks.map(t => [t.id, t]))
    return {
      projectName: doc.name,
      composition: doc.composition,
      tracks: doc.tracks.map(t => ({ id: t.id, kind: t.kind, name: t.name, locked: t.locked, muted: t.muted, visible: t.visible })),
      clips: doc.clips.map(c => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        track: trackById.get(c.trackId)?.name ?? '?',
        start: Math.round(c.start * 100) / 100,
        duration: Math.round(c.duration * 100) / 100,
        speed: Math.round((c.timeRemap ? c.timeRemap.sourceDuration / c.duration : c.speed) * 100) / 100,
        effects: c.effects.map(e => e.type),
        animated: c.keyframes.filter(k => k.keyframes.length > 0).map(k => k.property),
        inPoint: c.kind === 'video' || c.kind === 'audio' ? Math.round((c as VideoClip).inPoint * 100) / 100 : undefined,
        assetDuration: c.kind === 'video' || c.kind === 'audio'
          ? doc.assets.find(a => a.id === (c as VideoClip).assetId)?.duration : undefined,
        text: c.kind === 'text' ? (c as { text?: { content: string } }).text?.content.slice(0, 40) : undefined,
      })),
      assets: doc.assets.map(a => ({ id: a.id, name: a.name, kind: a.kind, duration: Math.round(a.duration * 100) / 100 })),
      selectedClipId: useEditorStore.getState().selectedClipId,
      playhead: Math.round(playbackEngine.currentTime * 100) / 100,
      beats: doc.beats.length,
      bpm: doc.bpm,
      recentHistory: doc.aiHistory.slice(-6).map(m => ({ role: m.role, content: m.content.slice(0, 160) })),
    }
  }

  /** Client-side follow-through: run real motion tracking queued by attach_tracking ops. */
  const runTrackingJobs = async (ops: AIOperation[]) => {
    const jobs = ops.filter(o => o.op === 'attach_tracking') as Extract<AIOperation, { op: 'attach_tracking' }>[]
    for (const job of jobs) {
      const target = doc.clips.find(c => c.id === job.targetClipId) as VideoClip | undefined
      const driver = doc.clips.find(c => c.id === job.clipId)
      if (!target || target.kind !== 'video' || !driver) continue
      upsertJob({ id: `track-${job.clipId}`, kind: 'track', label: `Tracking ${target.name}`, status: 'running', progress: 0 })
      try {
        const points = await trackPoint(target, doc.composition.width, doc.composition.height, job.startTime, job.duration, doc.composition.width / 2, doc.composition.height / 2, p => {
          upsertJob({ id: `track-${job.clipId}`, kind: 'track', label: `Tracking ${target.name}`, status: 'running', progress: p.progress, message: p.message })
        })
        // convert to keyframes on the driver clip (offset by its current position)
        const kfx = points.map(p => ({ time: p.time - target.start, value: Math.round(p.x + (job.offsetX ?? 0)) }))
        const kfy = points.map(p => ({ time: p.time - target.start, value: Math.round(p.y + (job.offsetY ?? 0)) }))
        mutate(d => {
          const c = d.clips.find(c => c.id === job.clipId)
          if (!c) return
          for (const [prop, kfs] of [['x', kfx], ['y', kfy]] as const) {
            let tr = c.keyframes.find(k => k.property === prop)
            if (!tr) { tr = { property: prop, keyframes: [] }; c.keyframes.push(tr) }
            tr.keyframes = kfs.map(k => ({ id: uid('kf'), time: k.time, value: k.value, easing: 'linear' as const }))
          }
        })
        upsertJob({ id: `track-${job.clipId}`, kind: 'track', label: `Tracking ${target.name}`, status: 'done', progress: 1, message: `${points.length} samples` })
        toast({ kind: 'success', title: 'Motion tracking complete', detail: `${driver.name} now follows ${target.name}` })
      } catch (e) {
        upsertJob({ id: `track-${job.clipId}`, kind: 'track', label: `Tracking ${target.name}`, status: 'error', progress: 0, message: e instanceof Error ? e.message : String(e) })
        toast({ kind: 'error', title: 'Tracking failed', detail: e instanceof Error ? e.message : String(e) })
      }
    }
  }

  const send = async (text?: string) => {
    const message = (text ?? input).trim()
    if (!message || aiBusy) return
    const settings = loadAISettings()
    if (!settings.apiKey) {
      toast({
        kind: 'error',
        title: 'AI needs your API key',
        detail: 'Open Settings (gear icon) → AI (Claude) and paste your key. It stays on this device only.',
      })
      setPanel('settings')
      return
    }
    setInput('')
    setAiBusy(true)
    setLocalBusy(true)
    const optimisticId = uid('ai')

    try {
      const json = await runAIEdit(message, mode, buildContext())
      const reply: string = json.reply
      const ops: AIOperation[] = Array.isArray(json.operations) ? json.operations : []

      const aiMsg: AIMessage = {
        id: uid('ai'),
        role: 'assistant',
        content: reply || 'Done.',
        ops,
        mode,
        createdAt: Date.now(),
        status: 'ok',
      }
      const userMsg: AIMessage = { id: optimisticId, role: 'user', content: message, createdAt: Date.now(), status: 'ok' }
      const { applied, errors } = useEditorStore.getState().commitAIExchange(userMsg, aiMsg, ops, mode)
      appliedRef.current = applied

      // Report the true execution outcome honestly in the assistant message
      if (errors.length > 0 || (mode === 'auto' && ops.length > 0 && applied.length === 0)) {
        const note = errors.length > 0
          ? `\n\n⚠ Honest status: ${errors.length} operation(s) could not be applied (${errors.slice(0, 2).join('; ')}). Nothing was faked — adjust the request or the project and try again.`
          : '\n\n⚠ Honest status: the generated operations did not match this project and nothing was applied.'
        useEditorStore.getState().updateAIMessage(aiMsg.id, { content: reply + note })
      }

      if (mode === 'auto' && applied.length > 0) {
        toast({ kind: 'success', title: `AI applied ${applied.length} change${applied.length > 1 ? 's' : ''}`, detail: applied.slice(0, 3).join(' · ') })
        void runTrackingJobs(ops)
      }
      if (mode === 'preview' && ops.length > 0) {
        toast({ kind: 'info', title: 'AI preview staged', detail: 'Scrub the timeline, then approve or discard' })
      }
      if (errors.length > 0) {
        toast({ kind: 'error', title: `${errors.length} operation(s) rejected`, detail: errors[0] })
      }
    } catch (e) {
      const errMsg: AIMessage = {
        id: uid('ai'),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      }
      mutate(d => { d.aiHistory.push(errMsg) })
      toast({ kind: 'error', title: 'AI request failed', detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setAiBusy(false)
      setLocalBusy(false)
    }
  }

  return (
    <div className="flex flex-col h-[70vh]">
      {/* provider status line */}
      <ProviderStatusLine />
      {/* preview banner */}
      {preview && (
        <div className="mx-3 mt-2 p-2.5 rounded-lg border border-violet-500/60 bg-violet-500/10">
          <div className="text-[11px] text-violet-300 font-medium mb-1.5">AI PREVIEW — staged changes (not committed)</div>
          <div className="flex gap-2">
            <button className="flex-1 py-2 rounded bg-emerald-500 text-black text-xs font-semibold flex items-center justify-center gap-1" onClick={approvePreview}>
              <Check size={13} /> Approve
            </button>
            <button className="flex-1 py-2 rounded glass-soft border border-zinc-600 text-zinc-200 text-xs flex items-center justify-center gap-1" onClick={rejectPreview}>
              <X size={13} /> Discard
            </button>
          </div>
        </div>
      )}

      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto as-scroll p-3 space-y-2.5">
        {doc.aiHistory.length === 0 && (
          <div className="text-xs text-zinc-500 py-4 leading-relaxed">
            <div className="flex items-center gap-1.5 text-violet-400 mb-1"><Sparkles size={13} /> AI Editing Assistant</div>
            Describe the edit you want. It reads your project (tracks, clips, selection, beats, playhead) and <b className="text-zinc-300">executes real operations</b> — effects, keyframes, speed ramps, text, transitions. Every change is undoable.
          </div>
        )}
        {doc.aiHistory.map(m => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed ${m.role === 'user'
              ? 'bg-amber-500/15 border border-amber-500/30 text-amber-100'
              : m.status === 'error'
                ? 'bg-red-500/10 border border-red-500/40 text-red-300'
                : 'glass-soft/80 border border-white/12 text-zinc-200'}`}>
              {m.role === 'assistant' && m.status !== 'error' && (
                <div className="flex items-center gap-1 text-[9px] text-zinc-500 mb-1 uppercase tracking-wider">
                  <Bot size={10} /> assistant {m.mode ? `· ${m.mode}` : ''}
                </div>
              )}
              {m.status === 'error' ? (
                <div className="flex items-start gap-1.5"><CircleAlert size={13} className="mt-0.5 shrink-0" /><span>{m.error}</span></div>
              ) : (
                <>
                  <div>{m.content}</div>
                  {m.role === 'assistant' && appliedRef.current.length > 0 && m.id === doc.aiHistory[doc.aiHistory.length - 1]?.id && doc.aiHistory[doc.aiHistory.length - 1]?.id === m.id && null}
                  {m.ops && m.ops.length > 0 && (
                    <div className="mt-1.5 pt-1.5 border-t border-white/12/60 text-[10px] text-zinc-400">
                      {m.ops.length} operation{m.ops.length > 1 ? 's' : ''} emitted
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
        {(aiBusy || localBusy) && (
          <div className="flex items-center gap-2 text-violet-300 text-xs px-2">
            <Loader2 size={13} className="animate-spin" /> thinking…
          </div>
        )}
      </div>

      {/* suggestions */}
      <div className="px-3 pb-1.5 flex gap-1.5 overflow-x-auto as-scroll">
        {SUGGESTIONS.map(s => (
          <button key={s} className="text-[10px] px-2.5 py-1 rounded-full border border-white/12 text-zinc-400 shrink-0 active:glass-soft" onClick={() => void send(s)}>
            {s}
          </button>
        ))}
      </div>

      {/* input */}
      <div className="p-3 pt-1.5 border-t border-white/8">
        <div className="flex items-center gap-1.5 mb-2">
          <button
            className={`text-[10px] px-2.5 py-1 rounded-full border font-medium ${mode === 'auto' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50' : 'text-zinc-500 border-white/12'}`}
            onClick={() => setMode('auto')}
          >AUTO</button>
          <button
            className={`text-[10px] px-2.5 py-1 rounded-full border font-medium ${mode === 'preview' ? 'bg-violet-500/20 text-violet-300 border-violet-500/50' : 'text-zinc-500 border-white/12'}`}
            onClick={() => setMode('preview')}
          >PREVIEW</button>
          <span className="text-[9px] text-zinc-600 ml-1">{mode === 'auto' ? 'applies instantly (undoable)' : 'stage first, approve after'}</span>
        </div>
        <div className="flex gap-2">
          <textarea
            className="flex-1 ginput rounded-lg-xl px-3 py-2.5 text-sm text-zinc-200 resize-none"
            rows={2}
            placeholder="e.g. Make this character move smoothly from left to right…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <button
            className="px-3.5 rounded-xl bg-violet-500 text-white disabled:opacity-50"
            onClick={() => void send()}
            disabled={aiBusy || !input.trim()}
            aria-label="Send to AI"
          >
            {aiBusy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Small header row: provider + remaining requests today (honest, live). */
function ProviderStatusLine() {
  const setPanel = useEditorStore(s => s.setPanel)
  // reads localStorage at mount; the panel remounts on every open so it is current
  const s = loadAISettings()
  if (!s.apiKey) {
    return (
      <button
        className="mx-3 mt-2 p-2.5 rounded-lg glass-violet text-[11px] text-violet-100 flex items-center gap-2 text-left"
        onClick={() => setPanel('settings')}
      >
        <Settings2 size={13} className="shrink-0" />
        <span className="flex-1">AI runs on your device with your own Claude key — tap to set it up in Settings.</span>
      </button>
    )
  }
  return (
    <div className="mx-3 mt-2 flex items-center gap-2 text-[10px] text-zinc-500">
      <span className="glass-soft rounded px-2 py-1">{s.baseUrl ? 'custom endpoint' : 'Claude'} · {s.model}</span>
      <span className="glass-soft rounded px-2 py-1">{Math.max(0, s.dailyRequestCap - s.usageCount)}/{s.dailyRequestCap} left today</span>
      <button className="text-violet-300 underline" onClick={() => setPanel('settings')}>settings</button>
    </div>
  )
}
