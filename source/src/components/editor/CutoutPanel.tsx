'use client'
/**
 * ANIME STUDIO — AI Cut-out panel: tap the character in the viewer, bake the
 * matte for every frame, then refine with the "AI Cut-out" effect.
 * One-click "text behind character" builds the classic AMV layer sandwich.
 */
import { useEffect, useRef, useState } from 'react'
import type { Clip, VideoClip } from '@/lib/engine/types'
import { uid, defaultLabel } from '@/lib/engine/types'
import { useEditorStore } from '@/lib/store/editorStore'
import { useUIStore } from '@/lib/store/uiStore'
import { playbackEngine } from '@/lib/engine/playback'
import { clipSourceTime } from '@/lib/engine/speed'
import { bakeCutout, deleteMatte, hasMatte, shareMatte } from '@/lib/engine/cutout'
import { EFFECT_MAP } from '@/lib/engine/effects'
import { Scissors, Loader2, MousePointerClick, Type, Trash2, Plus, SlidersHorizontal } from 'lucide-react'

function ensureCutoutFx(c: Clip, invert = 0) {
  let fx = c.effects.find(e => e.type === 'sx_cutout')
  if (!fx) {
    const def = EFFECT_MAP.sx_cutout
    fx = { id: uid('fx'), type: 'sx_cutout', enabled: true, params: Object.fromEntries(def.params.map(p => [p.key, p.default])), paramKeyframes: {} }
    c.effects.unshift(fx) // matte first, then the rest of the stack
  }
  fx.enabled = true
  fx.params.invert = invert
}

/** Keyer-style refine presets for the AI Cut-out effect. */
const PRESETS: { name: string; tip: string; v: Record<string, number> }[] = [
  { name: 'Balanced', tip: 'Good default for most anime clips', v: { choke: 0.5, feather: 0.12, grow: 0, fill: 4, smooth: 2, keyMode: 1, keyAssist: 0.6, despill: 0.6, decontam: 0.5, edgeR: 10, temporal: 0.35 } },
  { name: 'Green screen', tip: 'Footage shot / rendered on a green screen', v: { choke: 0.45, feather: 0.1, grow: -1, fill: 8, smooth: 2, keyMode: 2, keyAssist: 0.9, despill: 0.9, decontam: 0.7, edgeR: 8, temporal: 0.3 } },
  { name: 'Blue screen', tip: 'Footage on a blue screen', v: { choke: 0.45, feather: 0.1, grow: -1, fill: 8, smooth: 2, keyMode: 3, keyAssist: 0.9, despill: 0.9, decontam: 0.7, edgeR: 8, temporal: 0.3 } },
  { name: 'Clean edges', tip: 'Tighter, crisper outline for cel-shaded characters', v: { choke: 0.6, feather: 0.06, grow: -1.5, fill: 10, smooth: 1, keyMode: 1, keyAssist: 0.5, despill: 0.7, decontam: 0.6, edgeR: 6, temporal: 0.5 } },
  { name: 'Soft hair', tip: 'Keeps wispy hair and soft edges', v: { choke: 0.35, feather: 0.22, grow: 1, fill: 6, smooth: 4, keyMode: 1, keyAssist: 0.4, despill: 0.6, decontam: 0.8, edgeR: 14, temporal: 0.35 } },
]

function RefineControls({ clipId }: { clipId: string }) {
  const fx = useEditorStore(s => s.doc.clips.find(c => c.id === clipId)?.effects.find(e => e.type === 'sx_cutout'))
  const mutate = useEditorStore(s => s.mutate)
  if (!fx) return null
  const def = EFFECT_MAP.sx_cutout
  const val = (k: string) => fx.params[k] ?? def.params.find(p => p.key === k)?.default ?? 0
  const set = (vals: Record<string, number>) => {
    mutate(d => { const e = d.clips.find(c => c.id === clipId)?.effects.find(e => e.type === 'sx_cutout'); if (e) Object.assign(e.params, vals) })
    playbackEngine.clearCache()
  }
  // plain function (not a component): a nested component would remount and drop the slider drag
  const row = (k: string, label: string, fmt?: (v: number) => string) => {
    const p = def.params.find(x => x.key === k)!
    return (
      <label key={k} className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5">
        <span className="text-zinc-400 truncate">{label}</span>
        <span className="text-zinc-300 as-mono text-[11px]">{fmt ? fmt(val(k)) : val(k).toFixed(p.step < 1 ? 2 : 0)}</span>
        <input type="range" className="col-span-2 accent-[#2d8ceb]" min={p.min} max={p.max} step={p.step} value={val(k)} onChange={e => set({ [k]: Number(e.target.value) })} />
      </label>
    )
  }
  const seg = (k: string, opts: string[]) => (
    <div className="flex gap-1">
      {opts.map((o, i) => <button key={o} className={`flex-1 h-6 text-[11px] rounded-[3px] border ${val(k) === i ? 'border-[#2d8ceb] bg-[#2d8ceb]/20 text-white' : 'border-[#3a3a3a] text-zinc-400 hover:text-zinc-200'}`} onClick={() => set({ [k]: i })}>{o}</button>)}
    </div>
  )
  return (
    <div className="space-y-2.5 border-t border-[#333] pt-3">
      <div className="flex items-center gap-1.5 text-zinc-200 font-medium"><SlidersHorizontal size={13} /> Refine (like a chroma key)</div>
      <div className="flex flex-wrap gap-1">
        {PRESETS.map(p => <button key={p.name} title={p.tip} className="px-2 h-6 text-[11px] rounded-[3px] border border-[#3a3a3a] text-zinc-300 hover:border-[#2d8ceb] hover:text-white" onClick={() => set(p.v)}>{p.name}</button>)}
      </div>
      <div><div className="text-zinc-500 mb-1">View</div>{seg('view', ['Final', 'Matte', 'Status'])}</div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 pt-1">Matte</div>
      {row('choke', 'Threshold')}
      {row('feather', 'Softness')}
      {row('grow', 'Grow / Shrink', v => `${v > 0 ? '+' : ''}${v.toFixed(1)} px`)}
      {row('fill', 'Fill holes', v => `${v.toFixed(1)} px`)}
      {row('smooth', 'Smooth edges', v => `${v.toFixed(1)} px`)}
      {row('temporal', 'Temporal smoothing (less flicker)')}
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 pt-1">Screen key & spill</div>
      <div><div className="text-zinc-500 mb-1">Screen color</div>{seg('keyMode', ['Off', 'Auto', 'Green', 'Blue'])}</div>
      {row('keyAssist', 'Key strength')}
      {row('despill', 'Spill suppression')}
      {row('decontam', 'Edge color fix')}
      {row('edgeR', 'Edge sample radius', v => `${v.toFixed(0)} px`)}
      <label className="flex items-center gap-2 text-zinc-300"><input type="checkbox" checked={val('invert') > 0.5} onChange={e => set({ invert: e.target.checked ? 1 : 0 })} /> Invert (keep the background)</label>
      <div className="text-[10px] text-zinc-500 leading-4">Status view: white = solid, black = removed, blue = semi-transparent edge. Fill holes closes gaps (e.g. dark spots in hair); Spill suppression removes the green/blue fringe.</div>
    </div>
  )
}

export function CutoutPanel() {
  const doc = useEditorStore(s => s.doc)
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const mutate = useEditorStore(s => s.mutate)
  const toast = useEditorStore(s => s.toast)
  const picking = useUIStore(s => s.cutoutPick)
  const setPick = useUIStore(s => s.setCutoutPick)
  const clip = doc.clips.find(c => c.id === selectedClipId) ?? null
  const ok = clip && (clip.kind === 'video' || clip.kind === 'image')
  const [prog, setProg] = useState<number | null>(null)
  const [cancel, setCancel] = useState(false)
  const [, force] = useState(0)
  const [quality, setQuality] = useState<512 | 768 | 1024>(768)
  const mode = useRef<'replace' | 'add'>('replace')
  const qRef = useRef(quality); qRef.current = quality

  useEffect(() => {
    const h = async (e: Event) => {
      const { x, y, clipId } = (e as CustomEvent<{ x: number; y: number; clipId: string }>).detail
      setPick(null)
      const s = useEditorStore.getState()
      const c = s.doc.clips.find(c => c.id === clipId)
      if (!c) return
      const st = c.kind === 'video' ? clipSourceTime(c as VideoClip, Math.max(0, playbackEngine.currentTime - c.start)) : 0
      setProg(0); setCancel(false)
      let cancelled = false
      const off = () => { cancelled = true }
      window.addEventListener('as-cutout-cancel', off)
      try {
        playbackEngine.pause()
        const add = mode.current === 'add' && hasMatte(clipId)
        const n = await bakeCutout(s.doc, c, { x, y }, st, p => setProg(p), () => cancelled, { maxD: qRef.current, merge: add })
        s.mutate(d => { const cc = d.clips.find(k => k.id === clipId); if (cc) ensureCutoutFx(cc) })
        playbackEngine.clearCache()
        s.toast({ kind: 'success', title: add ? `Added to the cut-out (${n} frames)` : `Cut-out ready (${n} frames)`, detail: 'Refine it below (Threshold, Fill holes, Spill…)' })
      } catch (err) {
        s.toast({ kind: 'error', title: 'Cut-out failed', detail: err instanceof Error ? err.message : String(err) })
      } finally {
        window.removeEventListener('as-cutout-cancel', off)
        setProg(null); force(n => n + 1)
      }
    }
    window.addEventListener('as-cutout-pick', h as EventListener)
    return () => window.removeEventListener('as-cutout-pick', h as EventListener)
  }, [setPick])

  const textBehind = () => {
    if (!clip) return
    let textId: string | null = null
    let topId: string | null = null
    mutate(d => {
      const src = d.clips.find(c => c.id === clip.id)
      if (!src) return
      const ti = d.tracks.findIndex(t => t.id === src.trackId)
      // top: the character (copy with the cut-out), middle: text, bottom: the original plate
      const top = JSON.parse(JSON.stringify(src)) as Clip
      top.id = uid('clip'); top.name = `${src.name} (character)`
      topId = top.id
      ensureCutoutFx(top)
      const topTrack = { id: uid('track'), kind: 'video' as const, name: top.name, locked: false, visible: true, muted: false, height: 64 }
      const txtTrack = { id: uid('track'), kind: 'text' as const, name: 'Text behind', locked: false, visible: true, muted: false, height: 44 }
      d.tracks.splice(Math.max(0, ti), 0, topTrack, txtTrack)
      top.trackId = topTrack.id
      top.muted = true // audio stays on the original
      top.mediaLink = src.mediaLink || src.id // same decoder as the plate: never out of sync
      src.effects = src.effects.filter(e => e.type !== 'sx_cutout')
      textId = uid('clip')
      d.clips.push(top, {
        id: textId, trackId: txtTrack.id, kind: 'text', name: 'Text behind', start: src.start, duration: src.duration,
        effects: [], blendMode: 'normal', x: 0, y: 0, z: 0, scale: 1.6, rotation: 0, opacity: 1, anchorX: 0, anchorY: 0, keyframes: [], mask: null,
        speed: 1, timeRemap: null, reverse: false, parentId: null, threeD: false, trackMatte: null, label: defaultLabel('text'),
        text: { content: 'ANIME', font: 'Inter', size: 260, color: '#ffffff', strokeColor: '#000000', strokeWidth: 0, weight: 900, align: 'center', letterSpacing: 0, shadow: false, animation: 'none', animationDuration: 0.5 },
      } as Clip)
    })
    if (topId) shareMatte(clip.id, topId)
    playbackEngine.clearCache()
    toast({ kind: 'success', title: 'Text placed behind the character', detail: 'Edit the text in Character · the plate stays below, the character on top' })
    if (textId) useEditorStore.getState().select(textId)
  }

  return (
    <div className="p-3 text-[12px] space-y-3">
      <h3>AI Cut-out</h3>
      <p className="text-zinc-400 leading-5">Separates the character from the background on every frame — for text behind the character, glows only on the character, or new backgrounds.</p>
      {!ok ? <p className="text-amber-300">Select a video or image layer.</p> : (
        <>
          <div className="text-zinc-300">Layer: <b>{clip!.name}</b> {hasMatte(clip!.id) && <span className="text-[#3ccf55]">· matte baked</span>}</div>
          {prog === null ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-zinc-400">Quality
                <select className="ae-vb-select flex-1" value={quality} onChange={e => setQuality(Number(e.target.value) as 512 | 768 | 1024)}>
                  <option value={512}>Fast (512 px)</option><option value={768}>High (768 px)</option><option value={1024}>Best (1024 px, slower)</option>
                </select>
              </div>
              <button className={`gbtn w-full py-2 ${picking && mode.current === 'replace' ? '!border-amber-500 !text-amber-300' : 'gbtn-accent'}`} onClick={() => { mode.current = 'replace'; setPick(picking ? null : clip!.id) }}>
                <MousePointerClick size={14} /> {picking && mode.current === 'replace' ? 'Now click / tap the character in the viewer… (click again to cancel)' : hasMatte(clip!.id) ? 'Re-pick character & bake' : 'Pick character & bake'}
              </button>
              {hasMatte(clip!.id) && (
                <button className={`gbtn w-full py-1.5 ${picking && mode.current === 'add' ? '!border-amber-500 !text-amber-300' : ''}`} title="Pick another part (hair, a weapon, a second character) and add it to the cut-out" onClick={() => { mode.current = 'add'; setPick(picking ? null : clip!.id) }}>
                  <Plus size={13} /> {picking && mode.current === 'add' ? 'Click the part to add… (click again to cancel)' : 'Add part to cut-out (hair, props…)'}
                </button>
              )}
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 text-zinc-300"><Loader2 size={13} className="animate-spin" /> Segmenting frames… {Math.round(prog * 100)}%</div>
              <div className="h-1.5 bg-[#333] mt-1.5"><div className="h-full bg-[#3ccf55]" style={{ width: `${prog * 100}%` }} /></div>
              <button className="gbtn w-full py-1 mt-2" disabled={cancel} onClick={() => { setCancel(true); window.dispatchEvent(new Event('as-cutout-cancel')) }}>Cancel</button>
            </div>
          )}
          <div className="text-[10px] text-zinc-500 leading-4">Tip: pause on a frame where the character is clearly visible, then tap its body. The pick follows the character as it moves. Missing hair or a prop? Use “Add part”.</div>
          {hasMatte(clip!.id) && <RefineControls clipId={clip!.id} />}
          <button className="gbtn w-full py-2" disabled={!hasMatte(clip!.id)} onClick={textBehind}><Type size={14} /> Text behind character</button>
          <button className="gbtn w-full py-1.5" disabled={!hasMatte(clip!.id)} onClick={() => { void deleteMatte(clip!.id); mutate(d => { const c = d.clips.find(c => c.id === clip!.id); if (c) c.effects = c.effects.filter(e => e.type !== 'sx_cutout') }); force(n => n + 1) }}><Trash2 size={13} /> Remove cut-out</button>
        </>
      )}
      <p className="text-[10px] text-zinc-600 flex items-center gap-1"><Scissors size={11} /> Runs on your device (MediaPipe, GPU). Nothing is uploaded.</p>
    </div>
  )
}
