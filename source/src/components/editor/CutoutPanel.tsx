'use client'
/**
 * ANIME STUDIO — AI Cut-out panel: tap the character in the viewer, bake the
 * matte for every frame, then refine with the "AI Cut-out" effect.
 * One-click "text behind character" builds the classic AMV layer sandwich.
 */
import { useEffect, useState } from 'react'
import type { Clip, VideoClip } from '@/lib/engine/types'
import { uid, defaultLabel } from '@/lib/engine/types'
import { useEditorStore } from '@/lib/store/editorStore'
import { useUIStore } from '@/lib/store/uiStore'
import { playbackEngine } from '@/lib/engine/playback'
import { clipSourceTime } from '@/lib/engine/speed'
import { bakeCutout, deleteMatte, hasMatte, shareMatte } from '@/lib/engine/cutout'
import { EFFECT_MAP } from '@/lib/engine/effects'
import { Scissors, Loader2, MousePointerClick, Type, Trash2 } from 'lucide-react'

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
        const n = await bakeCutout(s.doc, c, { x, y }, st, p => setProg(p), () => cancelled)
        s.mutate(d => { const cc = d.clips.find(k => k.id === clipId); if (cc) ensureCutoutFx(cc) })
        playbackEngine.clearCache()
        s.toast({ kind: 'success', title: `Cut-out ready (${n} frames)`, detail: 'Refine Choke / Feather in Effect Controls · AI Cut-out' })
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
            <button className={`gbtn w-full py-2 ${picking ? '!border-amber-500 !text-amber-300' : 'gbtn-accent'}`} onClick={() => setPick(picking ? null : clip!.id)}>
              <MousePointerClick size={14} /> {picking ? 'Now click / tap the character in the viewer… (click again to cancel)' : hasMatte(clip!.id) ? 'Re-pick character & bake' : 'Pick character & bake'}
            </button>
          ) : (
            <div>
              <div className="flex items-center gap-2 text-zinc-300"><Loader2 size={13} className="animate-spin" /> Segmenting frames… {Math.round(prog * 100)}%</div>
              <div className="h-1.5 bg-[#333] mt-1.5"><div className="h-full bg-[#3ccf55]" style={{ width: `${prog * 100}%` }} /></div>
              <button className="gbtn w-full py-1 mt-2" disabled={cancel} onClick={() => { setCancel(true); window.dispatchEvent(new Event('as-cutout-cancel')) }}>Cancel</button>
            </div>
          )}
          <div className="text-[10px] text-zinc-500 leading-4">Tip: pause on a frame where the character is clearly visible, then tap its body. The pick follows the character as it moves. Works best on clear silhouettes; refine with Choke / Feather.</div>
          <button className="gbtn w-full py-2" disabled={!hasMatte(clip!.id)} onClick={textBehind}><Type size={14} /> Text behind character</button>
          <button className="gbtn w-full py-1.5" disabled={!hasMatte(clip!.id)} onClick={() => { void deleteMatte(clip!.id); mutate(d => { const c = d.clips.find(c => c.id === clip!.id); if (c) c.effects = c.effects.filter(e => e.type !== 'sx_cutout') }); force(n => n + 1) }}><Trash2 size={13} /> Remove cut-out</button>
        </>
      )}
      <p className="text-[10px] text-zinc-600 flex items-center gap-1"><Scissors size={11} /> Runs on your device (MediaPipe, GPU). Nothing is uploaded.</p>
    </div>
  )
}
