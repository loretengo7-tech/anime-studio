'use client'
/**
 * ANIME STUDIO — Inspector (Effect Controls / Properties)
 * Per-layer properties: transform (+ keyframes — writing an animated property
 * inserts/updates a keyframe at the playhead, AE behavior), 3D + camera,
 * parenting, track mattes, masks, effects stack (reorder / duplicate / reset /
 * enable / keyframe), text, audio.
 */
import { useEffect, useState } from 'react'
import type { Clip, AudioClip, TextClip, SolidClip, ShapeClip, CameraClip } from '@/lib/engine/types'
import { uid } from '@/lib/engine/types'
import { defaultParams } from '@/lib/engine/effects'
import { useEditorStore } from '@/lib/store/editorStore'
import { evalProperty, evalEffectParam } from '@/lib/engine/keyframes'
import { EFFECT_MAP, clampParam } from '@/lib/engine/effects'
import { playbackEngine } from '@/lib/engine/playback'
import { mediaManager } from '@/lib/media/mediaManager'
import { TEXT_ANIMATIONS } from '@/lib/engine/textRenderer'
import { allFonts, addCustomFont, deleteCustomFont, getCustomFonts, subscribeFonts, type FontOption } from '@/lib/media/fonts'
import { SectionTitle, SliderRow, Row } from './ui-bits'
import { Trash2, Eye, EyeOff, ArrowUp, ArrowDown, Copy, RotateCcw } from 'lucide-react'

const KF_COLORS: Record<string, string> = {
  x: '#f59e0b', y: '#10b981', z: '#22d3ee', scale: '#38bdf8', rotation: '#a78bfa', opacity: '#f472b6',
  anchorX: '#94a3b8', anchorY: '#94a3b8', volume: '#34d399',
}

/** Subscribes to the playhead so property values refresh live. */
function usePlayhead(): number {
  const [t, setT] = useState(0)
  useEffect(() => playbackEngine.subscribeThrottled(setT, 120), [])
  return t
}

export function Inspector() {
  const doc = useEditorStore(s => s.doc)
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const mutate = useEditorStore(s => s.mutate)
  const toast = useEditorStore(s => s.toast)
  const select = useEditorStore(s => s.select)
  const now = usePlayhead()
  const clip = doc.clips.find(c => c.id === selectedClipId) ?? null

  if (!clip) {
    return (
      <div className="p-4 text-xs text-zinc-500">
        Select a layer on the timeline to edit its properties, effects and keyframes.
      </div>
    )
  }

  const localTime = Math.max(0, Math.min(clip.duration, now - clip.start))
  const fps = Math.max(1, doc.composition.fps)

  // ---- keyframe helpers (AE semantics) ----
  const hasKfAt = (property: string) => {
    const track = clip.keyframes.find(k => k.property === property)
    return !!track?.keyframes.some(kf => Math.abs(kf.time - localTime) < 1 / (fps * 2))
  }
  const isAnimated = (property: string) => {
    const track = clip.keyframes.find(k => k.property === property)
    return !!track && track.keyframes.length > 0
  }

  /** Insert or update a keyframe at the playhead. */
  const writeKf = (d: Clip, property: string, value: number) => {
    let track = d.keyframes.find(k => k.property === property)
    if (!track) {
      track = { property, keyframes: [] }
      d.keyframes.push(track)
    }
    const existing = track.keyframes.find(kf => Math.abs(kf.time - localTime) < 1 / (fps * 2))
    if (existing) existing.value = value
    else {
      track.keyframes.push({ id: uid('kf'), time: localTime, value, easing: 'easeInOut' })
      track.keyframes.sort((a, b) => a.time - b.time)
    }
  }

  /**
   * Write a property value. Static property → set the field. Animated property
   * → write a keyframe at the playhead (AE behavior: editing an animated value
   * creates a keyframe instead of being ignored — this was a bug before).
   */
  const setProp = (property: string, value: number) => {
    mutate(d => {
      const c = d.clips.find(c => c.id === clip.id)
      if (!c) return
      if (isAnimated(property)) writeKf(c, property, value)
      else {
        switch (property) {
          case 'x': c.x = value; break
          case 'y': c.y = value; break
          case 'z': c.z = value; break
          case 'scale': c.scale = value; break
          case 'rotation': c.rotation = value; break
          case 'opacity': c.opacity = value; break
          case 'anchorX': c.anchorX = value; break
          case 'anchorY': c.anchorY = value; break
          case 'volume': if (c.kind === 'audio') c.volume = value; break
        }
      }
    })
  }

  const toggleKeyframe = (property: string, value: number) => {
    mutate(d => {
      const c = d.clips.find(c => c.id === clip.id)
      if (!c) return
      const track = c.keyframes.find(k => k.property === property)
      const existing = track?.keyframes.find(kf => Math.abs(kf.time - localTime) < 1 / (fps * 2))
      if (existing && track) track.keyframes = track.keyframes.filter(kf => kf.id !== existing.id)
      else writeKf(c, property, value)
    })
  }

  const val = (p: string) => evalProperty(clip, p as never, localTime)

  // ---- effect stack ops ----
  const updateEffectParam = (fxId: string, key: string, value: number, defType: string) => {
    const clamped = clampParam(defType, key, value)
    mutate(d => {
      const c = d.clips.find(c => c.id === clip.id)
      const fx = c?.effects.find(e => e.id === fxId)
      if (!fx) return
      // animated param → keyframe at playhead; static → set field
      const kfs = fx.paramKeyframes[key]
      if (kfs && kfs.length > 0) {
        const existing = kfs.find(kf => Math.abs(kf.time - localTime) < 1 / (fps * 2))
        if (existing) existing.value = clamped
        else {
          kfs.push({ id: uid('kf'), time: localTime, value: clamped, easing: 'easeInOut' })
          kfs.sort((a, b) => a.time - b.time)
        }
      } else {
        fx.params[key] = clamped
      }
    })
  }

  const toggleEffectParamKf = (fxId: string, key: string, value: number) => {
    mutate(d => {
      const c = d.clips.find(c => c.id === clip.id)
      const fx = c?.effects.find(e => e.id === fxId)
      if (!fx) return
      const existing = fx.paramKeyframes[key]?.find(kf => Math.abs(kf.time - localTime) < 1 / (fps * 2))
      if (existing) fx.paramKeyframes[key] = fx.paramKeyframes[key].filter(kf => kf.id !== existing.id)
      else {
        if (!fx.paramKeyframes[key]) fx.paramKeyframes[key] = []
        fx.paramKeyframes[key].push({ id: uid('kf'), time: localTime, value, easing: 'easeInOut' })
        fx.paramKeyframes[key].sort((a, b) => a.time - b.time)
      }
    })
  }

  const moveEffect = (fxId: string, dir: -1 | 1) => {
    mutate(d => {
      const c = d.clips.find(c => c.id === clip.id)
      if (!c) return
      const i = c.effects.findIndex(e => e.id === fxId)
      const j = i + dir
      if (i < 0 || j < 0 || j >= c.effects.length) return
      const [e] = c.effects.splice(i, 1)
      c.effects.splice(j, 0, e)
    })
  }

  const duplicateEffect = (fxId: string) => {
    mutate(d => {
      const c = d.clips.find(c => c.id === clip.id)
      if (!c) return
      const i = c.effects.findIndex(e => e.id === fxId)
      if (i < 0) return
      const copy = JSON.parse(JSON.stringify(c.effects[i]))
      copy.id = uid('fx')
      c.effects.splice(i + 1, 0, copy)
    })
  }

  const resetEffect = (fxId: string) => {
    mutate(d => {
      const c = d.clips.find(c => c.id === clip.id)
      const fx = c?.effects.find(e => e.id === fxId)
      if (!fx) return
      fx.params = defaultParams(fx.type)
      fx.paramKeyframes = {}
    })
  }

  const deleteClip = () => {
    mutate(d => { d.clips = d.clips.filter(c => c.id !== clip.id) })
    select(null)
    mediaManager.releaseClip(clip.id)
    toast({ kind: 'info', title: `Layer deleted: ${clip.name}` })
  }

  // ---- parenting candidates: any non-audio clip except self and descendants ----
  const isDescendantOf = (candidate: Clip, ancestorId: string, depth = 0): boolean => {
    if (depth > 8 || !candidate.parentId) return false
    if (candidate.parentId === ancestorId) return true
    const p = doc.clips.find(c => c.id === candidate.parentId)
    return p ? isDescendantOf(p, ancestorId, depth + 1) : false
  }
  const parentCandidates = doc.clips.filter(c =>
    c.id !== clip.id && c.kind !== 'audio' && !isDescendantOf(c, clip.id)
  )
  // children that follow THIS layer (used for the null controller hint)
  const children = doc.clips.filter(c => c.parentId === clip.id)

  const setParent = (newParentId: string | null) => {
    const prev = clip.parentId ? doc.clips.find(c => c.id === clip.parentId)?.name ?? 'None' : 'None'
    const next = newParentId ? doc.clips.find(c => c.id === newParentId)?.name ?? '?' : 'None'
    mutate(d => {
      const c = d.clips.find(c => c.id === clip.id)
      if (c) c.parentId = newParentId
    })
    if (newParentId) {
      toast({
        kind: 'success',
        title: `${clip.name} now follows "${next}"`,
        detail: 'Move/rotate/scale the parent layer and this one inherits it. To control layers with a Null: select the LAYER and set its Parent to the Null.',
      })
    } else if (clip.parentId) {
      toast({ kind: 'info', title: `${clip.name} unlinked from "${prev}"` })
    }
  }

  const toggle3D = () => {
    mutate(d => {
      const c = d.clips.find(c => c.id === clip.id)
      if (c) c.threeD = !c.threeD
    })
  }

  return (
    <div className="p-3 pb-10">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-sm text-zinc-200 font-medium truncate">{clip.name}</div>
          <div className="text-[10px] text-zinc-500 as-mono">
            {clip.kind} · {clip.start.toFixed(2)}s → {(clip.start + clip.duration).toFixed(2)}s ({clip.duration.toFixed(2)}s)
          </div>
        </div>
        <button className="p-2 text-red-400" onClick={deleteClip} aria-label="Delete layer"><Trash2 size={16} /></button>
      </div>

      {/* ---------------- Parent & Link ---------------- */}
      <SectionTitle>Parent &amp; Link</SectionTitle>
      <Row label="Parent">
        <select
          className="flex-1 text-xs ginput rounded px-2 py-1.5"
          value={clip.parentId ?? ''}
          onChange={e => setParent(e.target.value || null)}
        >
          <option value="">None</option>
          {parentCandidates.map(c => <option key={c.id} value={c.id}>{c.name} ({c.kind})</option>)}
        </select>
      </Row>
      {clip.kind === 'null' ? (
        <div className="text-[10px] text-zinc-500 mt-1 leading-relaxed">
          {children.length > 0
            ? <>Controls {children.length} layer{children.length > 1 ? 's' : ''}: {children.map(c => c.name).join(', ')}. Move/rotate/scale this Null (drag its marker in the viewer) and they follow.</>
            : <>This Null controls nothing yet. To make layers follow it: select the LAYER, then set <b className="text-zinc-400">Parent = this Null</b> above. Drag the Null's marker in the viewer to move everything.</>}
        </div>
      ) : (
        <div className="text-[10px] text-zinc-500 mt-1">This layer follows its parent's move/rotate/scale. Use a Null (timeline toolbar ∅) as parent to control several layers at once.</div>
      )}

      {/* ---------------- Transform ---------------- */}
      <SectionTitle>Transform · t={localTime.toFixed(2)}s</SectionTitle>
      <SliderRow label="Position X" value={val('x')} min={-doc.composition.width * 2} max={doc.composition.width * 2} onChange={v => setProp('x', v)} unit="px" keyframed={hasKfAt('x')} accent={KF_COLORS.x} onKeyframe={() => toggleKeyframe('x', val('x'))} />
      <SliderRow label="Position Y" value={val('y')} min={-doc.composition.height * 2} max={doc.composition.height * 2} onChange={v => setProp('y', v)} unit="px" keyframed={hasKfAt('y')} accent={KF_COLORS.y} onKeyframe={() => toggleKeyframe('y', val('y'))} />
      <SliderRow label="Scale" value={val('scale')} min={0.05} max={4} step={0.01} onChange={v => setProp('scale', v)} unit="x" keyframed={hasKfAt('scale')} accent={KF_COLORS.scale} onKeyframe={() => toggleKeyframe('scale', val('scale'))} />
      <SliderRow label="Rotation" value={val('rotation')} min={-360} max={360} onChange={v => setProp('rotation', v)} unit="°" keyframed={hasKfAt('rotation')} accent={KF_COLORS.rotation} onKeyframe={() => toggleKeyframe('rotation', val('rotation'))} />
      <SliderRow label="Opacity" value={val('opacity')} min={0} max={1} step={0.01} onChange={v => setProp('opacity', v)} keyframed={hasKfAt('opacity')} accent={KF_COLORS.opacity} onKeyframe={() => toggleKeyframe('opacity', val('opacity'))} />
      <Row label="3D Layer">
        <button className={`text-xs px-2 py-1 rounded ${clip.threeD ? 'glass-accent text-cyan-300' : 'glass-soft text-zinc-300'}`} onClick={toggle3D}>
          {clip.threeD ? '3D enabled' : '2D'}
        </button>
        {clip.threeD && <span className="text-[10px] text-zinc-500">projected by the active Camera (Z)</span>}
      </Row>
      {clip.threeD && (
        <SliderRow label="Position Z" value={val('z')} min={-doc.composition.height * 4} max={doc.composition.height * 4} onChange={v => setProp('z', v)} unit="px" keyframed={hasKfAt('z')} accent={KF_COLORS.z} onKeyframe={() => toggleKeyframe('z', val('z'))} />
      )}
      <details className="mt-1">
        <summary className="text-[11px] text-zinc-500 cursor-pointer select-none">Anchor Point</summary>
        <SliderRow label="Anchor X" value={val('anchorX')} min={-doc.composition.width} max={doc.composition.width} onChange={v => setProp('anchorX', v)} unit="px" keyframed={hasKfAt('anchorX')} onKeyframe={() => toggleKeyframe('anchorX', val('anchorX'))} />
        <SliderRow label="Anchor Y" value={val('anchorY')} min={-doc.composition.height} max={doc.composition.height} onChange={v => setProp('anchorY', v)} unit="px" keyframed={hasKfAt('anchorY')} onKeyframe={() => toggleKeyframe('anchorY', val('anchorY'))} />
      </details>

      {/* ---------------- Solid ---------------- */}
      {clip.kind === 'solid' && (
        <>
          <SectionTitle>Solid</SectionTitle>
          <Row label="Color">
            <input type="color" value={(clip as SolidClip).color} onChange={e => mutate(d => { const c = d.clips.find(c => c.id === clip.id) as SolidClip | undefined; if (c && c.kind === 'solid') c.color = e.target.value })} className="w-8 h-8 bg-transparent" />
            <span className="text-[10px] text-zinc-500 as-mono">{(clip as SolidClip).color}</span>
          </Row>
        </>
      )}

      {/* ---------------- Shape ---------------- */}
      {clip.kind === 'shape' && (
        <>
          <SectionTitle>Shape</SectionTitle>
          <Row label="Type">
            <select
              className="flex-1 text-xs ginput rounded px-2 py-1.5"
              value={(clip as ShapeClip).shape.type}
              onChange={e => mutate(d => {
                const c = d.clips.find(c => c.id === clip.id) as ShapeClip | undefined
                if (c && c.kind === 'shape') c.shape.type = e.target.value as ShapeClip['shape']['type']
              })}
            >
              {['rect', 'ellipse', 'polygon'].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </Row>
          {(clip as ShapeClip).shape.type === 'polygon' && (
            <SliderRow label="Sides" value={(clip as ShapeClip).shape.sides ?? 6} min={3} max={24} onChange={v => mutate(d => { const c = d.clips.find(c => c.id === clip.id) as ShapeClip | undefined; if (c && c.kind === 'shape') c.shape.sides = Math.round(v) })} />
          )}
          <SliderRow label="Width" value={(clip as ShapeClip).shape.width} min={4} max={doc.composition.width * 2} onChange={v => mutate(d => { const c = d.clips.find(c => c.id === clip.id) as ShapeClip | undefined; if (c && c.kind === 'shape') c.shape.width = v })} unit="px" />
          <SliderRow label="Height" value={(clip as ShapeClip).shape.height} min={4} max={doc.composition.height * 2} onChange={v => mutate(d => { const c = d.clips.find(c => c.id === clip.id) as ShapeClip | undefined; if (c && c.kind === 'shape') c.shape.height = v })} unit="px" />
          <Row label="Fill">
            <input type="color" value={(clip as ShapeClip).shape.fill} onChange={e => mutate(d => { const c = d.clips.find(c => c.id === clip.id) as ShapeClip | undefined; if (c && c.kind === 'shape') c.shape.fill = e.target.value })} className="w-8 h-8 bg-transparent" />
          </Row>
          <SliderRow label="Stroke" value={(clip as ShapeClip).shape.strokeWidth} min={0} max={40} onChange={v => mutate(d => { const c = d.clips.find(c => c.id === clip.id) as ShapeClip | undefined; if (c && c.kind === 'shape') c.shape.strokeWidth = v })} unit="px" />
          {(clip as ShapeClip).shape.strokeWidth > 0 && (
            <Row label="Stroke color">
              <input type="color" value={(clip as ShapeClip).shape.stroke} onChange={e => mutate(d => { const c = d.clips.find(c => c.id === clip.id) as ShapeClip | undefined; if (c && c.kind === 'shape') c.shape.stroke = e.target.value })} className="w-8 h-8 bg-transparent" />
            </Row>
          )}
          {(clip as ShapeClip).shape.type === 'rect' && (
            <SliderRow label="Roundness" value={(clip as ShapeClip).shape.cornerRadius} min={0} max={200} onChange={v => mutate(d => { const c = d.clips.find(c => c.id === clip.id) as ShapeClip | undefined; if (c && c.kind === 'shape') c.shape.cornerRadius = v })} unit="px" />
          )}
        </>
      )}

      {/* ---------------- Camera ---------------- */}
      {clip.kind === 'camera' && (
        <>
          <SectionTitle>Camera (3D)</SectionTitle>
          {([
            ['positionX', 'Position X', -doc.composition.width * 3, doc.composition.width * 3, 'px'],
            ['positionY', 'Position Y', -doc.composition.height * 3, doc.composition.height * 3, 'px'],
            ['positionZ', 'Position Z', -doc.composition.height * 6, doc.composition.height * 2, 'px'],
            ['rotationX', 'Rotation X', -180, 180, '°'],
            ['rotationY', 'Rotation Y', -180, 180, '°'],
            ['rotationZ', 'Rotation Z', -180, 180, '°'],
            ['zoom', 'Zoom', 0.1, 4, 'x'],
            ['focalLength', 'Focal Length', 100, 8000, 'px'],
            ['depthOfField', 'DOF Amount', 0, 10, ''],
            ['aperture', 'Aperture', 0.05, 4, ''],
            ['focusDistance', 'Focus Distance', 50, doc.composition.height * 6, 'px'],
          ] as const).map(([key, label, min, max, unit]) => (
            <SliderRow
              key={key}
              label={label}
              value={(clip as CameraClip).camera[key]}
              min={min}
              max={max}
              step={key === 'zoom' || key === 'depthOfField' || key === 'aperture' ? 0.05 : 1}
              unit={unit}
              onChange={v => mutate(d => {
                const c = d.clips.find(c => c.id === clip.id) as CameraClip | undefined
                if (c && c.kind === 'camera') c.camera[key] = v
              })}
            />
          ))}
          <div className="text-[10px] text-zinc-500 mt-1">Animate the camera via keyframes on Position X/Y/Z (Transform section) or Orbit tool presets. DOF is an approximation.</div>
        </>
      )}

      {/* ---------------- Track Matte ---------------- */}
      {clip.kind !== 'audio' && (
        <>
          <SectionTitle>Track Matte</SectionTitle>
          <Row label="Mode">
            <select
              className="flex-1 text-xs ginput rounded px-2 py-1.5"
              value={clip.trackMatte?.mode ?? ''}
              onChange={e => mutate(d => {
                const c = d.clips.find(c => c.id === clip.id)
                if (!c) return
                const mode = e.target.value as 'alpha' | 'alphaInv' | 'luma' | 'lumaInv' | ''
                if (!mode) c.trackMatte = null
                else {
                  // default source: the layer above this one on its track
                  const above = d.clips.find(o => o.trackId === c.trackId && o.start < c.start && o.start + o.duration > c.start)
                  const prev = c.trackMatte?.sourceClipId
                  c.trackMatte = { sourceClipId: prev ?? above?.id ?? '', mode }
                }
              })}
            >
              <option value="">No matte</option>
              <option value="alpha">Alpha Matte</option>
              <option value="alphaInv">Alpha Inverted</option>
              <option value="luma">Luma Matte</option>
              <option value="lumaInv">Luma Inverted</option>
            </select>
          </Row>
          {clip.trackMatte && (
            <Row label="Matte source">
              <select
                className="flex-1 text-xs ginput rounded px-2 py-1.5"
                value={clip.trackMatte.sourceClipId}
                onChange={e => mutate(d => { const c = d.clips.find(c => c.id === clip.id); if (c?.trackMatte) c.trackMatte.sourceClipId = e.target.value })}
              >
                <option value="">—</option>
                {doc.clips.filter(c => c.id !== clip.id && c.kind !== 'audio').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Row>
          )}
        </>
      )}

      {/* ---------------- Mask ---------------- */}
      <SectionTitle>Mask</SectionTitle>
      {!clip.mask ? (
        <button className="text-xs px-3 py-1.5 rounded glass-soft text-zinc-300" onClick={() => mutate(d => {
          const c = d.clips.find(c => c.id === clip.id)
          if (c) c.mask = { shape: 'ellipse', x: 0, y: 0, width: 1, height: 1, feather: 0.15, invert: false }
        })}>Add mask</button>
      ) : (
        <>
          <Row label="Shape">
            <button className="text-xs px-2 py-1 rounded glass-soft" onClick={() => mutate(d => {
              const c = d.clips.find(c => c.id === clip.id)
              if (!c?.mask) return
              const order: ('ellipse' | 'rect' | 'pen')[] = ['ellipse', 'rect', 'pen']
              const next = order[(order.indexOf(c.mask.shape) + 1) % 3]
              if (next === 'pen' && (!c.mask.points || c.mask.points.length < 3)) {
                // seed a generous diamond around frame center (comp px, y-up)
                const w = d.composition.width * 0.3
                const h = d.composition.height * 0.3
                c.mask.points = [
                  { x: -w, y: h }, { x: w, y: h }, { x: w, y: -h }, { x: -w, y: -h },
                ]
              }
              c.mask.shape = next
              if (next !== 'pen') useEditorStore.getState().setMaskEditing(null)
            })}>
              {clip.mask.shape}
            </button>
            {clip.mask.shape === 'pen' && (
              <MaskEditButton clipId={clip.id} pointCount={clip.mask.points?.length ?? 0} />
            )}
            <button className="p-1 text-zinc-500" onClick={() => { useEditorStore.getState().setMaskEditing(null); mutate(d => { const c = d.clips.find(c => c.id === clip.id); if (c) c.mask = null }) }} aria-label="Remove mask"><EyeOff size={14} /></button>
          </Row>
          {clip.mask.shape === 'pen' && (
            <>
              <div className="text-[10px] text-zinc-500 mb-1.5 leading-relaxed">
                Drag points on the monitor. Tap an edge midpoint to add a point. Double-tap a point to delete it.
              </div>
              <Row label="Shape keyframes">
                <button className="text-xs px-2 py-1 rounded glass-soft" onClick={() => mutate(d => {
                  const c = d.clips.find(c => c.id === clip.id)
                  if (!c?.mask?.points) return
                  if (!c.mask.shapeKeyframes) c.mask.shapeKeyframes = []
                  const pts = JSON.parse(JSON.stringify(c.mask.points))
                  const existing = c.mask.shapeKeyframes.find(k => Math.abs(k.time - localTime) < 0.03)
                  if (existing) existing.points = pts
                  else {
                    c.mask.shapeKeyframes.push({ time: localTime, points: pts })
                    c.mask.shapeKeyframes.sort((a, b) => a.time - b.time)
                  }
                })}>Set @ {localTime.toFixed(2)}s</button>
                <span className="text-[10px] text-zinc-500">{clip.mask.shapeKeyframes?.length ?? 0} kf</span>
                {(clip.mask.shapeKeyframes?.length ?? 0) > 0 && (
                  <button className="text-[10px] px-1.5 py-1 rounded text-red-400" onClick={() => mutate(d => { const c = d.clips.find(c => c.id === clip.id); if (c?.mask) c.mask.shapeKeyframes = [] })}>clear</button>
                )}
              </Row>
            </>
          )}
          {clip.mask.shape !== 'pen' && (
            <>
              <SliderRow label="Center X" value={clip.mask.x} min={-1} max={1} step={0.01} onChange={v => mutate(d => { const c = d.clips.find(c => c.id === clip.id); if (c?.mask) c.mask.x = v })} />
              <SliderRow label="Center Y" value={clip.mask.y} min={-1} max={1} step={0.01} onChange={v => mutate(d => { const c = d.clips.find(c => c.id === clip.id); if (c?.mask) c.mask.y = v })} />
              <SliderRow label="Width" value={clip.mask.width} min={0.05} max={2} step={0.01} onChange={v => mutate(d => { const c = d.clips.find(c => c.id === clip.id); if (c?.mask) c.mask.width = v })} />
              <SliderRow label="Height" value={clip.mask.height} min={0.05} max={2} step={0.01} onChange={v => mutate(d => { const c = d.clips.find(c => c.id === clip.id); if (c?.mask) c.mask.height = v })} />
            </>
          )}
          <SliderRow label="Feather" value={clip.mask.feather} min={0.01} max={1} step={0.01} onChange={v => mutate(d => { const c = d.clips.find(c => c.id === clip.id); if (c?.mask) c.mask.feather = v })} />
          <Row label="Invert">
            <button className="text-xs px-2 py-1 rounded glass-soft" onClick={() => mutate(d => { const c = d.clips.find(c => c.id === clip.id); if (c?.mask) c.mask.invert = !c.mask.invert })}>
              {clip.mask.invert ? 'Yes' : 'No'}
            </button>
          </Row>
        </>
      )}

      {/* ---------------- Text ---------------- */}
      {clip.kind === 'text' && <TextSection clip={clip as TextClip} />}

      {/* ---------------- Audio ---------------- */}
      {clip.kind === 'audio' && (
        <>
          <SectionTitle>Audio</SectionTitle>
          <SliderRow label="Volume" value={evalProperty(clip, 'volume', localTime)} min={0} max={2} step={0.01} onChange={v => setProp('volume', v)} keyframed={hasKfAt('volume')} accent={KF_COLORS.volume} onKeyframe={() => toggleKeyframe('volume', evalProperty(clip, 'volume', localTime))} />
          <SliderRow label="Fade in" value={(clip as AudioClip).fadeIn} min={0} max={10} step={0.1} onChange={v => mutate(d => { const c = d.clips.find(c => c.id === clip.id) as AudioClip | undefined; if (c) c.fadeIn = v })} unit="s" />
          <SliderRow label="Fade out" value={(clip as AudioClip).fadeOut} min={0} max={10} step={0.1} onChange={v => mutate(d => { const c = d.clips.find(c => c.id === clip.id) as AudioClip | undefined; if (c) c.fadeOut = v })} unit="s" />
        </>
      )}

      {/* ---------------- Effects (AE Effect Controls stack) ---------------- */}
      <SectionTitle right={<span className="text-[10px] text-zinc-600">{clip.effects.length} applied</span>}>Effects</SectionTitle>
      {clip.effects.length === 0 && <div className="text-xs text-zinc-600">No effects — add from the Effects panel.</div>}
      {clip.effects.map((fx, fi) => {
        const def = EFFECT_MAP[fx.type]
        if (!def) return null
        return (
          <div key={fx.id} className="mb-3 rounded-lg border glass-soft p-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-zinc-200 font-medium truncate">{def.name}</span>
              <div className="flex items-center gap-0.5 shrink-0">
                <button className="p-1 text-zinc-500 disabled:opacity-30" disabled={fi === 0} onClick={() => moveEffect(fx.id, -1)} aria-label="Move effect up"><ArrowUp size={12} /></button>
                <button className="p-1 text-zinc-500 disabled:opacity-30" disabled={fi === clip.effects.length - 1} onClick={() => moveEffect(fx.id, 1)} aria-label="Move effect down"><ArrowDown size={12} /></button>
                <button className="p-1 text-zinc-500" onClick={() => duplicateEffect(fx.id)} aria-label="Duplicate effect"><Copy size={12} /></button>
                <button className="p-1 text-zinc-500" onClick={() => resetEffect(fx.id)} aria-label="Reset effect"><RotateCcw size={12} /></button>
                <button className="p-1" onClick={() => mutate(d => { const c = d.clips.find(c => c.id === clip.id); const f = c?.effects.find(e => e.id === fx.id); if (f) f.enabled = !f.enabled })} aria-label="Toggle effect">
                  {fx.enabled ? <Eye size={13} className="text-emerald-400" /> : <EyeOff size={13} className="text-zinc-600" />}
                </button>
                <button className="p-1 text-red-400" onClick={() => mutate(d => { const c = d.clips.find(c => c.id === clip.id); if (c) c.effects = c.effects.filter(e => e.id !== fx.id) })} aria-label="Remove effect"><Trash2 size={13} /></button>
              </div>
            </div>
            {def.params.map(p => {
              const v = evalEffectParam(fx, p.key, localTime)
              const kfs = fx.paramKeyframes[p.key] ?? []
              return (
                <SliderRow
                  key={p.key}
                  label={p.label}
                  value={v}
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  onChange={nv => updateEffectParam(fx.id, p.key, nv, fx.type)}
                  keyframed={kfs.length > 0}
                  onKeyframe={() => toggleEffectParamKf(fx.id, p.key, v)}
                />
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

/** Live font list (built-in device fonts + user-uploaded custom fonts). */
function useFonts(): FontOption[] {
  const [, setTick] = useState(0)
  useEffect(() => {
    void import('@/lib/media/fonts').then(m => { void m.restoreCustomFonts() })
    return subscribeFonts(() => setTick(t => t + 1))
  }, [])
  return allFonts()
}

/** Full text styling/animation controls (AE Character-lite + text animators). */
function TextSection({ clip }: { clip: TextClip }) {
  const mutate = useEditorStore(s => s.mutate)
  const toast = useEditorStore(s => s.toast)
  const fonts = useFonts()
  const t = clip.text
  const setText = (patch: Partial<TextClip['text']>) => {
    mutate(d => {
      const c = d.clips.find(c => c.id === clip.id) as TextClip | undefined
      if (c && c.kind === 'text') Object.assign(c.text, patch)
    })
  }
  const grad = t.gradient ?? { enabled: false, color2: '#ff6b9d', angle: 0 }
  const onUploadFont = async (file: File) => {
    try {
      const opt = await addCustomFont(file)
      toast({ kind: 'success', title: `Font "${opt.label}" installed`, detail: 'Saved in this browser — it survives reloads and exports.' })
    } catch (e) {
      toast({ kind: 'error', title: 'Font install failed', detail: e instanceof Error ? e.message : String(e) })
    }
  }
  return (
    <>
      <SectionTitle>Text</SectionTitle>
      <textarea
        className="w-full ginput rounded p-2 text-sm text-zinc-200"
        rows={2}
        value={t.content}
        onChange={e => setText({ content: e.target.value })}
      />
      <Row label="Font">
        <select
          className="flex-1 text-xs ginput rounded px-2 py-1.5 min-w-0"
          value={fonts.some(f => f.family === t.font) ? t.font : fonts[0]?.family ?? ''}
          onChange={e => setText({ font: e.target.value })}
        >
          {getCustomFonts().length > 0 && <optgroup label="My fonts (uploaded)">
            {getCustomFonts().map(f => <option key={f.family} value={f.family}>{f.label}</option>)}
          </optgroup>}
          <optgroup label="Device fonts">
            {fonts.filter(f => !f.custom).map(f => <option key={f.family} value={f.family}>{f.label}</option>)}
          </optgroup>
        </select>
        <label className="p-1.5 rounded-lg gbtn text-[10px] cursor-pointer" title="Install a .ttf/.otf/.woff font">
          +
          <input type="file" accept=".ttf,.otf,.woff,.woff2" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void onUploadFont(f) }} />
        </label>
        {t.font.startsWith('custom-') && (
          <button className="p-1.5 rounded-lg gbtn text-red-400 text-[10px]" onClick={() => void deleteCustomFont(t.font)} title="Uninstall this font">del</button>
        )}
      </Row>
      <Row label="Weight">
        <select className="flex-1 text-xs ginput rounded px-2 py-1.5" value={t.weight} onChange={e => setText({ weight: parseInt(e.target.value) })}>
          {[300, 400, 600, 700, 800, 900].map(w => <option key={w} value={w}>{w}</option>)}
        </select>
        <select className="flex-1 text-xs ginput rounded px-2 py-1.5" value={t.align} onChange={e => setText({ align: e.target.value as TextClip['text']['align'] })}>
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>
      </Row>
      <SliderRow label="Size" value={t.size} min={12} max={400} onChange={v => setText({ size: v })} unit="px" />
      <SliderRow label="Tracking" value={t.letterSpacing} min={-10} max={60} step={0.5} onChange={v => setText({ letterSpacing: v })} unit="px" />
      <Row label="Fill / Stroke">
        <input type="color" value={t.color} onChange={e => setText({ color: e.target.value })} className="w-8 h-8 bg-transparent" />
        <input type="color" value={t.strokeColor} onChange={e => setText({ strokeColor: e.target.value })} className="w-8 h-8 bg-transparent" title="Stroke" />
        <span className="text-[10px] text-zinc-500">fill / stroke</span>
      </Row>
      <SliderRow label="Stroke" value={t.strokeWidth} min={0} max={20} onChange={v => setText({ strokeWidth: v })} unit="px" />
      <Row label="Gradient">
        <button
          className={`text-xs px-2 py-1 rounded ${grad.enabled ? 'glass-accent text-amber-300' : 'glass-soft text-zinc-300'}`}
          onClick={() => setText({ gradient: { ...grad, enabled: !grad.enabled } })}
        >
          {grad.enabled ? 'On' : 'Off'}
        </button>
        {grad.enabled && (
          <>
            <input type="color" value={grad.color2} onChange={e => setText({ gradient: { ...grad, color2: e.target.value } })} className="w-8 h-8 bg-transparent" title="Gradient second color" />
            <span className="text-[10px] text-zinc-500">{t.color} → {grad.color2}</span>
          </>
        )}
      </Row>
      {grad.enabled && <SliderRow label="Gradient angle" value={grad.angle} min={0} max={360} onChange={v => setText({ gradient: { ...grad, angle: v } })} unit="°" />}
      <Row label="Shadow">
        <button
          className={`text-xs px-2 py-1 rounded ${t.shadow ? 'glass-accent text-amber-300' : 'glass-soft text-zinc-300'}`}
          onClick={() => setText({ shadow: !t.shadow })}
        >
          {t.shadow ? 'On' : 'Off'}
        </button>
        {t.shadow && <input type="color" value={t.shadowColor ?? '#000000'} onChange={e => setText({ shadowColor: e.target.value })} className="w-8 h-8 bg-transparent" title="Shadow color" />}
      </Row>
      {t.shadow && (
        <>
          <SliderRow label="Shadow blur" value={t.shadowBlur ?? t.size * 0.25} min={0} max={60} onChange={v => setText({ shadowBlur: v })} unit="px" />
          <SliderRow label="Shadow offset X" value={t.shadowOffsetX ?? 0} min={-40} max={40} onChange={v => setText({ shadowOffsetX: v })} unit="px" />
          <SliderRow label="Shadow offset Y" value={t.shadowOffsetY ?? t.size * 0.06} min={-40} max={40} onChange={v => setText({ shadowOffsetY: v })} unit="px" />
        </>
      )}
      <Row label="Animation">
        <select
          className="flex-1 text-xs ginput rounded px-2 py-1.5"
          value={t.animation}
          onChange={e => setText({ animation: e.target.value as TextClip['text']['animation'] })}
        >
          {TEXT_ANIMATIONS.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
      </Row>
      {t.animation !== 'none' && (
        <>
          <SliderRow label="Anim duration" value={t.animationDuration} min={0.1} max={8} step={0.05} onChange={v => setText({ animationDuration: v })} unit="s" />
          <SliderRow
            label="Char stagger"
            value={t.stagger ?? 0}
            min={0}
            max={0.9}
            step={0.05}
            onChange={v => setText({ stagger: v })}
            unit="×dur"
          />
          <div className="text-[10px] text-zinc-500 -mt-1">Stagger animates letters one after another (0 = whole block together). Applies to fadeIn, slides, pop, zoom, bounce, rotate, tracking, blur.</div>
        </>
      )}
    </>
  )
}

/** Toggle button that arms pen-mask point editing on the preview monitor. */
function MaskEditButton({ clipId, pointCount }: { clipId: string; pointCount: number }) {
  const maskEditing = useEditorStore(s => s.maskEditing)
  const setMaskEditing = useEditorStore(s => s.setMaskEditing)
  const active = maskEditing === clipId
  return (
    <button
      className={`text-xs px-2 py-1 rounded ${active ? 'glass-accent text-amber-300' : 'glass-soft text-zinc-300'}`}
      onClick={() => setMaskEditing(active ? null : clipId)}
    >
      {active ? 'Done editing' : `Edit points (${pointCount})`}
    </button>
  )
}
