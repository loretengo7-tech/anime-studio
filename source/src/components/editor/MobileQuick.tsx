'use client'
/**
 * ANIME STUDIO — Mobile quick sheets (CapCut-style): one-tap Filters,
 * Transitions, Stickers and Captions. Everything goes through the same
 * validated executeOperations() pipeline the AI assistant uses, so every
 * action is undoable and engine-safe.
 */
import { useState } from 'react'
import { X } from 'lucide-react'
import { useEditorStore } from '@/lib/store/editorStore'
import { playbackEngine } from '@/lib/engine/playback'
import { executeOperations } from '@/lib/engine/aiTools'
import { COLOR_PRESETS, EFFECT_DEFS } from '@/lib/engine/effects'
import { getPluginEffectDefs } from '@/lib/engine/plugins'
import type { AIOperation } from '@/lib/engine/types'

export type QuickTab = 'effects' | 'filters' | 'transitions' | 'stickers' | 'captions'

const TABS: { id: QuickTab; label: string }[] = [
  { id: 'effects', label: 'Effects' },
  { id: 'filters', label: 'Filters' },
  { id: 'transitions', label: 'Transitions' },
  { id: 'stickers', label: 'Stickers' },
  { id: 'captions', label: 'Captions' },
]
const TRANSITIONS: { id: 'crossfade' | 'dip_to_black' | 'whip_pan' | 'glitch_cut' | 'zoom_punch'; label: string; icon: string }[] = [
  { id: 'crossfade', label: 'Crossfade', icon: '◐' },
  { id: 'dip_to_black', label: 'Dip to Black', icon: '■' },
  { id: 'whip_pan', label: 'Whip Pan', icon: '➜' },
  { id: 'glitch_cut', label: 'Glitch Cut', icon: '▒' },
  { id: 'zoom_punch', label: 'Zoom Punch', icon: '⊕' },
]
const STICKERS = ['🔥', '✨', '💥', '⭐', '💫', '⚡', '❤️', '💖', '😂', '😎', '🥹', '😭', '👀', '💀', '🌸', '🍥', '⚔️', '🗡️', '🎌', '👑', '🌙', '☀️', '🎵', '💢']
const CAPTION_ANIMS = ['pop', 'typewriter', 'fadeIn', 'slideUp', 'karaoke', 'bounce']

function toast(kind: 'info' | 'success' | 'error', title: string, detail?: string) {
  useEditorStore.getState().toast({ kind, title, detail })
}

function run(ops: AIOperation[], okMsg: string) {
  const s = useEditorStore.getState()
  const r = executeOperations(s.doc, ops)
  if (r.errors.length > 0 && r.applied.length === 0) { toast('error', 'Could not apply', r.errors[0]); return }
  s.replaceDoc(r.doc, true)
  toast('success', okMsg)
}

export function MobileQuick({ tab, onTab, onClose }: { tab: QuickTab; onTab: (t: QuickTab) => void; onClose: () => void }) {
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const [intensity, setIntensity] = useState(1)
  const [caption, setCaption] = useState('')
  const [anim, setAnim] = useState('pop')
  const [cat, setCat] = useState('all')

  const allEffects = [...EFFECT_DEFS, ...getPluginEffectDefs()]
  const cats = ['all', ...Array.from(new Set(allEffects.map(e => e.category)))]
  const shownEffects = cat === 'all' ? allEffects : allEffects.filter(e => e.category === cat)

  const applyEffect = (type: string, name: string) => {
    if (!selectedClipId) { toast('info', 'Select a clip first', 'Tap a clip in the timeline, then pick an effect.'); return }
    run([{ op: 'apply_effect', clipId: selectedClipId, effect: type }], `${name} added`)
  }

  const applyFilter = (preset: string) => {
    const s = useEditorStore.getState()
    const targets = selectedClipId
      ? [selectedClipId]
      : s.doc.clips.filter(c => c.kind === 'video' || c.kind === 'image').map(c => c.id)
    if (targets.length === 0) { toast('info', 'Add a clip first'); return }
    run(targets.map(clipId => ({ op: 'apply_color_preset', clipId, preset, intensity }) as AIOperation),
      selectedClipId ? 'Filter applied to clip' : `Filter applied to ${targets.length} clips`)
  }

  const applyTransition = (type: (typeof TRANSITIONS)[number]['id']) => {
    const s = useEditorStore.getState()
    const sel = s.doc.clips.find(c => c.id === s.selectedClipId)
    if (!sel) { toast('info', 'Select a clip first', 'The transition goes between it and the next clip.'); return }
    const next = s.doc.clips
      .filter(c => c.id !== sel.id && c.trackId === sel.trackId && c.start > sel.start)
      .sort((a, b) => a.start - b.start)[0]
    if (!next) { toast('info', 'No next clip', 'Place another clip after this one on the same track.'); return }
    run([{ op: 'add_transition', clipAId: sel.id, clipBId: next.id, type, duration: 0.5 }], 'Transition added')
  }

  const addText = (text: string, size: number, animation: string, duration: number, msg: string) => {
    if (!text.trim()) return
    run([{ op: 'add_text', text, start: playbackEngine.currentTime, duration, size, animation }], msg)
  }

  const btn = 'rounded-xl bg-white/5 border border-white/10 active:scale-95 active:bg-amber-400/20 transition-all'

  return (
    <div className="absolute left-0 right-0 bottom-0 z-50 max-h-[62vh] rounded-t-[24px] glass-strong flex flex-col glass-in"
         style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="ae-grabber" />
      <div className="h-11 shrink-0 flex items-center px-2 border-b border-white/10">
        <div className="flex-1 flex gap-1 overflow-x-auto as-scroll">
          {TABS.map(t => (
            <button key={t.id} onClick={() => onTab(t.id)}
                    className={`px-3 h-8 rounded-full text-[12px] font-semibold whitespace-nowrap ${tab === t.id ? 'bg-amber-500 text-white' : 'text-zinc-400'}`}>
              {t.label}
            </button>
          ))}
        </div>
        <button className="tb-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>

      <div className="overflow-y-auto as-scroll min-h-0 flex-1 overscroll-contain p-3">
        {tab === 'effects' && (
          <>
            <div className="flex gap-1.5 overflow-x-auto as-scroll mb-2 pb-1">
              {cats.map(c => (
                <button key={c} onClick={() => setCat(c)}
                        className={`px-2.5 py-1 rounded-full text-[11px] whitespace-nowrap capitalize ${cat === c ? 'bg-amber-500 text-white font-semibold' : 'bg-white/5 text-zinc-300'}`}>{c}</button>
              ))}
            </div>
            <div className="text-[11px] text-zinc-500 mb-2">
              {selectedClipId ? 'Tap an effect to add it to the selected clip' : 'Select a clip in the timeline first'}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {shownEffects.map(e => (
                <button key={e.type} className={`${btn} py-3 px-1 text-[11px] text-zinc-200 leading-tight`} onClick={() => applyEffect(e.type, e.name)}>
                  {e.name}{e.heavy ? <span className="block text-[9px] text-amber-400/80 mt-0.5">heavy</span> : null}
                </button>
              ))}
            </div>
            <button className="mt-3 w-full h-9 rounded-xl bg-white/5 text-[11px] text-zinc-300"
                    onClick={() => useEditorStore.getState().setPanel('effects')}>
              Open full effects library (parameters &amp; keyframes)
            </button>
          </>
        )}

        {tab === 'filters' && (
          <>
            <div className="text-[11px] text-zinc-500 mb-2">
              {selectedClipId ? 'Applies to the selected clip' : 'No clip selected — applies to all video/image clips'}
            </div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[11px] text-zinc-400 w-16">Intensity</span>
              <input type="range" min={0} max={2} step={0.05} value={intensity} className="flex-1 accent-amber-400"
                     onChange={e => setIntensity(parseFloat(e.target.value))} />
              <span className="text-[11px] text-zinc-300 w-8 text-right as-mono">{intensity.toFixed(2)}</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {Object.entries(COLOR_PRESETS).map(([id, p]) => (
                <button key={id} className={`${btn} py-3 px-1 text-[11px] text-zinc-200`} onClick={() => applyFilter(id)}>{p.label}</button>
              ))}
            </div>
            <div className="text-[10px] text-zinc-500 mt-3">More looks (Film Fade, Split Tone, Neon Night, Beat Flash…) are in Effects → “Looks & Flash Pack”.</div>
          </>
        )}

        {tab === 'transitions' && (
          <>
            <div className="text-[11px] text-zinc-500 mb-2">Select a clip, then tap a transition: it is added between that clip and the next one on its track.</div>
            <div className="grid grid-cols-3 gap-2">
              {TRANSITIONS.map(t => (
                <button key={t.id} className={`${btn} py-3 flex flex-col items-center gap-1 text-zinc-200`} onClick={() => applyTransition(t.id)}>
                  <span className="text-xl leading-none">{t.icon}</span><span className="text-[11px]">{t.label}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {tab === 'stickers' && (
          <>
            <div className="text-[11px] text-zinc-500 mb-2">Tap to drop a sticker at the playhead (3 s). Move/resize it like any text layer.</div>
            <div className="grid grid-cols-6 gap-2">
              {STICKERS.map(e => (
                <button key={e} className={`${btn} aspect-square text-2xl`} onClick={() => addText(e, 220, 'pop', 3, 'Sticker added')}>{e}</button>
              ))}
            </div>
          </>
        )}

        {tab === 'captions' && (
          <>
            <div className="text-[11px] text-zinc-500 mb-2">Type a caption and add it at the playhead.</div>
            <textarea value={caption} onChange={e => setCaption(e.target.value)} rows={2} placeholder="Caption text…"
                      className="w-full rounded-xl bg-white/5 border border-white/10 p-2.5 text-sm text-zinc-100 outline-none focus:border-amber-400/60" />
            <div className="flex gap-1.5 flex-wrap my-2">
              {CAPTION_ANIMS.map(a => (
                <button key={a} onClick={() => setAnim(a)}
                        className={`px-2.5 py-1 rounded-full text-[11px] ${anim === a ? 'bg-amber-500 text-white font-semibold' : 'bg-white/5 text-zinc-300'}`}>{a}</button>
              ))}
            </div>
            <button className="w-full h-10 rounded-xl bg-amber-500 text-white text-sm font-bold active:scale-95 transition-transform"
                    onClick={() => { addText(caption, 72, anim, 3, 'Caption added'); setCaption('') }}>
              Add caption
            </button>
          </>
        )}
      </div>
    </div>
  )
}
