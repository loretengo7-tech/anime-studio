/**
 * ANIME STUDIO — AE command layer.
 * Every menu item, keyboard shortcut and timeline button of the AE-style
 * workspace goes through these functions so they behave identically.
 */
import type { AssetMeta, Clip, ProjectDoc, Track, VideoClip, KeyframeTrack, EasingName, TrackKind } from '@/lib/engine/types'
import { uid, makeClipBase, makeSolidClip, makeShapeClip, makeNullClip, makeCameraClip, defaultLabel } from '@/lib/engine/types'
import { useEditorStore } from '@/lib/store/editorStore'
import { useUIStore } from '@/lib/store/uiStore'
import { playbackEngine } from '@/lib/engine/playback'
import { mediaManager, importMediaFile } from '@/lib/media/mediaManager'
import { STATIC_MODE, localImportUpload } from '@/lib/media/staticMode'
import { evalProperty } from '@/lib/engine/keyframes'
import { projectDuration } from '@/lib/engine/types'
import { openCompIn } from '@/lib/engine/precomp'

const st = () => useEditorStore.getState()
const now = () => playbackEngine.currentTime

// ------------------------------------------------------------------ layers

/** Layers in AE order (index 0 = layer #1 = top of the stack). */
export function layerOrder(doc: ProjectDoc): Clip[] {
  const out: Clip[] = []
  for (const t of doc.tracks) {
    const cs = doc.clips.filter(c => c.trackId === t.id).sort((a, b) => b.start - a.start)
    out.push(...cs)
  }
  // orphans (track removed) at the end so they stay reachable
  for (const c of doc.clips) if (!out.includes(c)) out.push(c)
  return out
}

function trackKindFor(kind: Clip['kind']): TrackKind {
  if (kind === 'audio') return 'audio'
  if (kind === 'text') return 'text'
  if (kind === 'adjustment') return 'adjustment'
  return 'video'
}

/** Insert a fresh track for one layer (AE: every layer is its own row). */
function newTrackFor(d: ProjectDoc, kind: Clip['kind'], name: string, index = 0): Track {
  const tk = trackKindFor(kind)
  const track: Track = { id: uid('track'), kind: tk, name, locked: false, visible: true, muted: false, height: tk === 'audio' ? 56 : tk === 'text' ? 44 : 64 }
  if (tk === 'audio') d.tracks.push(track)
  else d.tracks.splice(Math.max(0, Math.min(index, d.tracks.length)), 0, track)
  return track
}

/** Put the selected layer's track index (new layers go above it, like AE). */
function insertIndex(d: ProjectDoc): number {
  const sel = st().selectedClipId
  const c = sel ? d.clips.find(c => c.id === sel) : null
  if (!c) return 0
  return Math.max(0, d.tracks.findIndex(t => t.id === c.trackId))
}

export type NewLayerKind = 'text' | 'solid' | 'shape' | 'ellipse' | 'null' | 'camera' | 'adjustment'

export function newLayer(kind: NewLayerKind) {
  let id: string | null = null
  st().mutate(d => {
    const at = Math.max(0, Math.min(now(), d.composition.duration - 0.1))
    const dur = Math.max(1, d.composition.duration - at)
    const idx = insertIndex(d)
    const realKind = kind === 'ellipse' ? 'shape' : kind
    const names: Record<string, string> = { text: 'Text', solid: 'Solid', shape: 'Shape Layer', null: 'Null', camera: 'Camera', adjustment: 'Adjustment Layer' }
    const n = d.clips.filter(c => c.kind === realKind).length + 1
    const track = newTrackFor(d, realKind as Clip['kind'], `${names[realKind]} ${n}`, idx)
    id = uid('clip')
    let clip: Clip
    if (kind === 'solid') clip = { ...makeSolidClip(track.id, at, dur, '#c0392b'), id, name: `Solid ${n}` }
    else if (kind === 'shape' || kind === 'ellipse') {
      const sc = makeShapeClip(track.id, at, dur, d.composition.width, d.composition.height)
      if (kind === 'ellipse') sc.shape.type = 'ellipse'
      clip = { ...sc, id, name: `Shape Layer ${n}` }
    }
    else if (kind === 'null') clip = { ...makeNullClip(track.id, at, dur), id, name: `Null ${n}` }
    else if (kind === 'camera') clip = { ...makeCameraClip(track.id, at, dur, d.composition.height), id, name: `Camera ${n}` }
    else if (kind === 'adjustment') clip = { ...makeClipBase(track.id, `Adjustment Layer ${n}`, at, dur), id, kind: 'adjustment', affectCount: 0 }
    else {
      clip = {
        ...makeClipBase(track.id, `Text ${n}`, at, Math.min(dur, 5)), id, kind: 'text',
        text: {
          content: 'Your Text', font: 'Inter', size: 96, color: '#ffffff', strokeColor: '#000000', strokeWidth: 0,
          weight: 800, align: 'center', letterSpacing: 0, shadow: true, animation: 'none', animationDuration: 0.5,
        },
      }
    }
    clip.label = defaultLabel(clip.kind)
    d.clips.push(clip)
  })
  if (id) st().select(id)
  return id
}

export function addAssetLayer(asset: AssetMeta, at = now()) {
  let id: string | null = null
  st().mutate(d => {
    const kind = asset.kind === 'audio' ? 'audio' : asset.kind === 'image' ? 'image' : 'video'
    const track = newTrackFor(d, kind, asset.name.slice(0, 28), insertIndex(d))
    id = uid('clip')
    const base = { ...makeClipBase(track.id, asset.name.slice(0, 40), Math.max(0, at), kind === 'image' ? 5 : Math.max(0.5, asset.duration)), id, label: defaultLabel(kind) }
    if (kind === 'audio') d.clips.push({ ...base, kind: 'audio', assetId: asset.id, inPoint: 0, fadeIn: 0, fadeOut: 0, volume: 1 })
    else if (kind === 'image') d.clips.push({ ...base, kind: 'image', assetId: asset.id })
    else d.clips.push({ ...base, kind: 'video', assetId: asset.id, inPoint: 0, tracking: null, trackingTarget: null })
    // first footage in an empty comp: match comp length like AE "New Comp from Footage"
    if (kind === 'video' && d.clips.filter(c => c.kind === 'video').length === 1 && asset.duration > d.composition.duration) {
      d.composition.duration = Math.ceil(asset.duration)
    }
  })
  if (id) st().select(id)
  return id
}

export async function importFiles(files: FileList | File[] | null, onBusy?: (name: string | null) => void) {
  if (!files || files.length === 0) return
  const { mutate, toast } = st()
  for (const file of Array.from(files)) {
    onBusy?.(file.name)
    try {
      const meta = await importMediaFile(file, STATIC_MODE
        ? localImportUpload
        : async (f, probe) => {
          const form = new FormData()
          form.append('file', f)
          form.append('kind', probe.kind)
          form.append('duration', String(probe.duration))
          form.append('width', String(probe.width))
          form.append('height', String(probe.height))
          form.append('fps', String(probe.fps))
          const res = await fetch('/api/media', { method: 'POST', body: form })
          if (!res.ok) throw new Error(await res.text())
          return await res.json() as { id: string; url: string }
        })
      mutate(d => { d.assets.push(meta) })
      mediaManager.registerAsset(meta)
      toast({ kind: 'success', title: `Imported ${meta.name}`, detail: `${meta.kind} · ${meta.duration.toFixed(1)}s` })
    } catch (e) {
      toast({ kind: 'error', title: `Import failed: ${file.name}`, detail: e instanceof Error ? e.message : String(e) })
    }
  }
  onBusy?.(null)
}

/** Opens the OS file picker (File > Import > File… / Ctrl+I). */
export function pickAndImport() {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = 'video/*,audio/*,image/*'
  input.onchange = () => { void importFiles(input.files) }
  input.click()
}

export function selectedClip(): Clip | null {
  const s = st()
  return s.doc.clips.find(c => c.id === s.selectedClipId) ?? null
}

export function deleteSelected() {
  const c = selectedClip()
  if (!c) return
  st().mutate(d => {
    d.clips = d.clips.filter(x => x.id !== c.id)
    for (const x of d.clips) if (x.parentId === c.id) x.parentId = null
  })
  st().select(null)
  mediaManager.releaseClip(c.id)
}

export function duplicateSelected() {
  const c = selectedClip()
  if (!c) return
  let id: string | null = null
  st().mutate(d => {
    const src = d.clips.find(x => x.id === c.id)
    if (!src) return
    const copy = JSON.parse(JSON.stringify(src)) as Clip
    id = uid('clip')
    copy.id = id
    const ti = d.tracks.findIndex(t => t.id === src.trackId)
    const track = newTrackFor(d, src.kind, `${src.name} copy`, Math.max(0, ti))
    copy.trackId = track.id
    d.clips.push(copy)
  })
  if (id) st().select(id)
}

/** Edit > Split Layer (Ctrl+Shift+D): the right half goes on a new layer above. */
export function splitSelected() {
  const c = selectedClip()
  if (!c) return
  const t = now()
  let newId: string | null = null
  st().mutate(d => {
    const clip = d.clips.find(x => x.id === c.id)
    if (!clip) return
    const local = t - clip.start
    if (local <= 0.02 || local >= clip.duration - 0.02) return
    const right = JSON.parse(JSON.stringify(clip)) as Clip
    newId = uid('clip')
    right.id = newId
    right.start = clip.start + local
    right.duration = clip.duration - local
    right.keyframes = right.keyframes.map(k => ({
      ...k,
      keyframes: k.keyframes.filter(kf => kf.time >= local).map(kf => ({ ...kf, time: kf.time - local })),
    })).filter(k => k.keyframes.length > 0)
    if ((right.kind === 'video' || right.kind === 'audio') && (clip.kind === 'video' || clip.kind === 'audio')) {
      right.inPoint = clip.inPoint + local * clip.speed
    }
    clip.duration = local
    const ti = d.tracks.findIndex(x => x.id === clip.trackId)
    const track = newTrackFor(d, clip.kind, `${clip.name} split`, Math.max(0, ti))
    right.trackId = track.id
    d.clips.push(right)
  })
  if (newId) st().select(newId)
}

/**
 * Give every layer its own track (AE model). Only runs when a reorder needs
 * it; projects made in the track timeline keep their tracks untouched otherwise.
 */
function isolate(d: ProjectDoc) {
  const out: Track[] = []
  for (const t of d.tracks) {
    const cs = d.clips.filter(c => c.trackId === t.id).sort((a, b) => b.start - a.start)
    if (cs.length <= 1) { out.push(t); continue }
    cs.forEach((c, i) => {
      if (i === 0) { out.push(t); c.trackId = t.id; return }
      const nt: Track = { ...t, id: uid('track'), name: c.name.slice(0, 28) }
      out.push(nt)
      c.trackId = nt.id
    })
  }
  d.tracks = out
}

/** Layer > Arrange: dir -1 = bring forward, +1 = send backward, ±Infinity = to front/back. */
export function moveLayer(clipId: string, dir: number) {
  st().mutate(d => {
    isolate(d)
    const c = d.clips.find(x => x.id === clipId)
    if (!c) return
    const visualTracks = d.tracks.filter(t => (t.kind === 'audio') === (c.kind === 'audio'))
    const ti = visualTracks.findIndex(t => t.id === c.trackId)
    if (ti < 0) return
    const tj = dir === -Infinity ? 0 : dir === Infinity ? visualTracks.length - 1 : Math.max(0, Math.min(visualTracks.length - 1, ti + dir))
    if (ti === tj) return
    const a = d.tracks.indexOf(visualTracks[ti])
    const b = d.tracks.indexOf(visualTracks[tj])
    const [t] = d.tracks.splice(a, 1)
    d.tracks.splice(b, 0, t)
  })
}

/** Move a layer to sit at visual index `toIndex` (drag reorder in the layer list). */
export function moveLayerTo(clipId: string, toIndex: number) {
  const order = layerOrder(st().doc)
  const from = order.findIndex(c => c.id === clipId)
  if (from < 0 || from === toIndex) return
  moveLayer(clipId, toIndex - from)
}

export function patchClip(clipId: string, fn: (c: Clip) => void) {
  st().mutate(d => {
    const c = d.clips.find(x => x.id === clipId)
    if (c) fn(c)
  })
}

// ------------------------------------------------------------------ keyframes

export const TRANSFORM_PROPS: { key: string; label: string; props: { p: 'x' | 'y' | 'anchorX' | 'anchorY' | 'scale' | 'rotation' | 'opacity'; mul: number; unit?: string; min: number; max: number; step: number }[] }[] = [
  { key: 'anchor', label: 'Anchor Point', props: [{ p: 'anchorX', mul: 1, min: -10000, max: 10000, step: 1 }, { p: 'anchorY', mul: 1, min: -10000, max: 10000, step: 1 }] },
  { key: 'position', label: 'Position', props: [{ p: 'x', mul: 1, min: -20000, max: 20000, step: 1 }, { p: 'y', mul: 1, min: -20000, max: 20000, step: 1 }] },
  { key: 'scale', label: 'Scale', props: [{ p: 'scale', mul: 100, unit: '%', min: -10000, max: 10000, step: 0.1 }] },
  { key: 'rotation', label: 'Rotation', props: [{ p: 'rotation', mul: 1, unit: '°', min: -36000, max: 36000, step: 0.1 }] },
  { key: 'opacity', label: 'Opacity', props: [{ p: 'opacity', mul: 100, unit: '%', min: 0, max: 100, step: 0.1 }] },
]

function localTime(c: Clip) { return Math.max(0, Math.min(c.duration, now() - c.start)) }
function fpsTol(d: ProjectDoc) { return 1 / (Math.max(1, d.composition.fps) * 2) }

export function isPropAnimated(c: Clip, p: string) {
  return !!c.keyframes.find(k => k.property === p)?.keyframes.length
}

/**
 * Write a transform value with AE semantics: animated property → keyframe at
 * the CTI (created or updated), otherwise the static value.
 */
export function writeProp(clipId: string, p: string, value: number) {
  st().mutate(d => {
    const c = d.clips.find(x => x.id === clipId)
    if (!c) return
    writePropIn(d, c, p, value)
  })
}

export function writePropIn(d: ProjectDoc, c: Clip, p: string, value: number) {
  if (isPropAnimated(c, p)) {
    const lt = localTime(c)
    const tr = c.keyframes.find(k => k.property === p)!
    const ex = tr.keyframes.find(kf => Math.abs(kf.time - lt) < fpsTol(d))
    if (ex) ex.value = value
    else {
      tr.keyframes.push({ id: uid('kf'), time: lt, value, easing: 'linear' })
      tr.keyframes.sort((a, b) => a.time - b.time)
    }
  } else {
    (c as unknown as Record<string, number>)[p] = value
  }
}

/** Stopwatch: start animating (keyframe at CTI) or remove all keyframes (AE). */
export function toggleStopwatch(clipId: string, props: string[]) {
  st().mutate(d => {
    const c = d.clips.find(x => x.id === clipId)
    if (!c) return
    const animated = props.some(p => isPropAnimated(c, p))
    const lt = localTime(c)
    for (const p of props) {
      if (animated) {
        // freeze the current value as the static value, like AE
        const v = evalProperty(c, p as never, lt)
        c.keyframes = c.keyframes.filter(k => k.property !== p)
        ;(c as unknown as Record<string, number>)[p] = v
      } else {
        const v = (c as unknown as Record<string, number>)[p] ?? (p === 'volume' || p === 'scale' || p === 'opacity' ? 1 : 0)
        const tr: KeyframeTrack = { property: p, keyframes: [{ id: uid('kf'), time: lt, value: v, easing: 'linear' }] }
        c.keyframes = c.keyframes.filter(k => k.property !== p)
        c.keyframes.push(tr)
      }
    }
  })
}

/** Keyframe navigator ◆: add (or remove when one sits at the CTI). */
export function toggleKeyAtCTI(clipId: string, props: string[]) {
  st().mutate(d => {
    const c = d.clips.find(x => x.id === clipId)
    if (!c) return
    const lt = localTime(c)
    const tol = fpsTol(d)
    const has = props.some(p => c.keyframes.find(k => k.property === p)?.keyframes.some(kf => Math.abs(kf.time - lt) < tol))
    for (const p of props) {
      let tr = c.keyframes.find(k => k.property === p)
      if (has) {
        if (tr) tr.keyframes = tr.keyframes.filter(kf => Math.abs(kf.time - lt) >= tol)
        continue
      }
      const v = evalProperty(c, p as never, lt)
      if (!tr) { tr = { property: p, keyframes: [] }; c.keyframes.push(tr) }
      tr.keyframes.push({ id: uid('kf'), time: lt, value: v, easing: 'linear' })
      tr.keyframes.sort((a, b) => a.time - b.time)
    }
    c.keyframes = c.keyframes.filter(k => k.keyframes.length > 0)
  })
}

/** J / K and the ◀ ▶ navigator arrows. */
export function jumpKeyframe(dir: -1 | 1, clip?: Clip | null, props?: string[]) {
  const c = clip ?? selectedClip()
  const d = st().doc
  const times: number[] = []
  const pool = c ? [c] : d.clips
  for (const x of pool) {
    for (const k of x.keyframes) {
      if (props && !props.includes(k.property)) continue
      for (const kf of k.keyframes) times.push(x.start + kf.time)
    }
    if (!props) for (const e of x.effects) for (const kfs of Object.values(e.paramKeyframes ?? {})) for (const kf of kfs) times.push(x.start + kf.time)
  }
  const t = now()
  const eps = 1 / (Math.max(1, d.composition.fps) * 2)
  const cand = dir > 0 ? times.filter(x => x > t + eps).sort((a, b) => a - b)[0] : times.filter(x => x < t - eps).sort((a, b) => b - a)[0]
  if (cand !== undefined) { playbackEngine.pause(); playbackEngine.seek(cand) }
}

/** Animation > Keyframe Assistant > Easy Ease (F9) on the selected keyframe(s). */
export function setSelectedKeyEasing(easing: EasingName) {
  const s = st()
  const kfId = s.selectedKeyframeId
  const c = selectedClip()
  if (!c) return
  s.mutate(d => {
    const clip = d.clips.find(x => x.id === c.id)
    if (!clip) return
    let touched = false
    for (const k of clip.keyframes) for (const kf of k.keyframes) {
      if (!kfId || kf.id === kfId) { kf.easing = easing; touched = true }
    }
    for (const e of clip.effects) for (const kfs of Object.values(e.paramKeyframes ?? {})) for (const kf of kfs) {
      if (!kfId || kf.id === kfId) { kf.easing = easing; touched = true }
    }
    void touched
  })
}

export function deleteSelectedKeyframe(): boolean {
  const s = st()
  const kfId = s.selectedKeyframeId
  if (!kfId) return false
  s.mutate(d => {
    for (const c of d.clips) {
      for (const k of c.keyframes) k.keyframes = k.keyframes.filter(kf => kf.id !== kfId)
      c.keyframes = c.keyframes.filter(k => k.keyframes.length > 0)
      for (const e of c.effects) for (const key of Object.keys(e.paramKeyframes ?? {})) {
        e.paramKeyframes[key] = e.paramKeyframes[key].filter(kf => kf.id !== kfId)
      }
    }
  })
  s.selectKeyframe(null)
  return true
}

// ------------------------------------------------------------------ time

/** B / N — work area begin / end. */
export function setWorkArea(which: 'in' | 'out') {
  const t = now()
  const s = playbackEngine.state
  if (which === 'in') { s.inPoint = t; if (s.outPoint !== null && s.outPoint <= t) s.outPoint = null }
  else { s.outPoint = t; if (s.inPoint !== null && s.inPoint >= t) s.inPoint = null }
  useUIStore.setState({})
  window.dispatchEvent(new Event('as-workarea'))
}

export function clearWorkArea() {
  playbackEngine.state.inPoint = null
  playbackEngine.state.outPoint = null
  window.dispatchEvent(new Event('as-workarea'))
}

/** [ / ] : move layer so its in/out point sits at the CTI. Alt+[ / Alt+] trim. */
export function layerToCTI(edge: 'in' | 'out', trim: boolean) {
  const c = selectedClip()
  if (!c) return
  const t = now()
  st().mutate(d => {
    const clip = d.clips.find(x => x.id === c.id)
    if (!clip) return
    if (!trim) {
      clip.start = Math.max(0, edge === 'in' ? t : t - clip.duration)
      return
    }
    if (edge === 'in') {
      const delta = t - clip.start
      if (delta <= 0 || delta >= clip.duration - 0.02) return
      clip.start = t
      clip.duration -= delta
      if (clip.kind === 'video' || clip.kind === 'audio') (clip as VideoClip).inPoint += delta * (clip.speed || 1)
      for (const k of clip.keyframes) k.keyframes = k.keyframes.filter(kf => kf.time >= delta).map(kf => ({ ...kf, time: kf.time - delta }))
    } else {
      const nd = t - clip.start
      if (nd > 0.02) clip.duration = nd
    }
  })
}

export function compEnd(): number {
  return projectDuration(st().doc)
}

/** Composition > Trim Comp to Work Area. */
export function trimCompToWorkArea() {
  const s = playbackEngine.state
  if (s.outPoint === null) return
  const out = s.outPoint
  st().mutate(d => { d.composition.duration = Math.max(0.5, out) })
}

/** File > Save frame as PNG (Composition > Save Frame As). */
export function saveFrameAs() {
  const comp = playbackEngine.compositor as unknown as { canvas: HTMLCanvasElement | null }
  const canvas = comp.canvas
  const d = st().doc
  if (!canvas) return
  // preserveDrawingBuffer is off for speed: re-render and read back in the same task
  playbackEngine.compositor.render(d, mediaManager, { time: now(), bypassEffects: playbackEngine.compareMode })
  canvas.toBlob(b => {
    if (!b) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(b)
    a.download = `${d.name.replace(/[^\w-]+/g, '_')}_${now().toFixed(2)}s.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  }, 'image/png')
}

// ------------------------------------------------------------------ live edits
/**
 * Live edits (value scrubbing, bar/keyframe drags): the document updates on
 * every pointer move so the viewer follows the drag, but only ONE undo step
 * is recorded when the gesture ends.
 */
let liveBase: ProjectDoc | null = null
export function liveBegin() { liveBase = st().doc }
export function liveApply(fn: (d: ProjectDoc) => void) {
  if (!liveBase) liveBegin()
  const next = JSON.parse(JSON.stringify(liveBase)) as ProjectDoc
  fn(next)
  next.updatedAt = Date.now()
  useEditorStore.setState({ doc: next, saveState: 'dirty' })
}
export function liveEnd() {
  const base = liveBase
  liveBase = null
  if (!base) return
  if (st().doc !== base) useEditorStore.setState(s => ({ past: [...s.past.slice(-80), base], future: [] }))
}
export function liveActive() { return liveBase !== null }

/** AE timecode 0:00:00:00 */
export function tcAE(t: number, fps: number): string {
  const f = Math.max(1, Math.round(fps))
  const total = Math.max(0, Math.round(t * fps + 1e-6))
  const fr = total % f
  const s = Math.floor(total / f)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(fr).padStart(2, '0')}`
}

/** Parse "1:02:15" / "0:00:03:12" / "125" (frames) / "4.5s" into seconds. */
export function parseTime(raw: string, fps: number): number | null {
  const s = raw.trim()
  if (!s) return null
  if (/^[\d.]+s$/.test(s)) return parseFloat(s)
  if (/^\d+$/.test(s)) return parseInt(s, 10) / fps
  const parts = s.split(/[:;.]/).map(p => parseInt(p, 10))
  if (parts.some(isNaN)) return null
  let h = 0, m = 0, sec = 0, fr = 0
  if (parts.length === 4) [h, m, sec, fr] = parts
  else if (parts.length === 3) [m, sec, fr] = parts
  else if (parts.length === 2) [sec, fr] = parts
  return h * 3600 + m * 60 + sec + fr / fps
}

// ------------------------------------------------------------------ multi-select
export function selectedClips(): Clip[] {
  const s = st()
  const ids = s.selectedClipIds.length ? s.selectedClipIds : s.selectedClipId ? [s.selectedClipId] : []
  return s.doc.clips.filter(c => ids.includes(c.id))
}

export function selectAllLayers() {
  st().selectMany(layerOrder(st().doc).map(c => c.id))
}

export function deleteSelectedLayers() {
  const cs = selectedClips()
  if (!cs.length) return
  const ids = new Set(cs.map(c => c.id))
  st().mutate(d => {
    d.clips = d.clips.filter(x => !ids.has(x.id))
    for (const x of d.clips) if (x.parentId && ids.has(x.parentId)) x.parentId = null
  })
  st().select(null)
  for (const id of ids) mediaManager.releaseClip(id)
}

export function duplicateSelectedLayers() {
  const cs = selectedClips()
  if (cs.length <= 1) { duplicateSelected(); return }
  const newIds: string[] = []
  st().mutate(d => {
    for (const src of cs) {
      const copy = JSON.parse(JSON.stringify(src)) as Clip
      copy.id = uid('clip')
      const ti = d.tracks.findIndex(t => t.id === src.trackId)
      const track = newTrackFor(d, src.kind, `${src.name} copy`, Math.max(0, ti))
      copy.trackId = track.id
      d.clips.push(copy)
      newIds.push(copy.id)
    }
  })
  st().selectMany(newIds)
}

// ------------------------------------------------------------------ clipboard
type KfClip = { kind: 'keyframes'; items: { prop: string; fxType?: string; dt: number; value: number; easing: EasingName; handles?: [{ x: number; y: number }, { x: number; y: number }] }[] }
type LayerClipboard = { kind: 'layers'; clips: Clip[]; t0: number }
let clipboard: KfClip | LayerClipboard | null = null

/** Ctrl+C — selected keyframes if any, otherwise the selected layers. */
export function copySelection(): string {
  const s = st()
  const kfIds = s.selectedKeyframeIds.length ? s.selectedKeyframeIds : s.selectedKeyframeId ? [s.selectedKeyframeId] : []
  if (kfIds.length) {
    const items: KfClip['items'] = []
    for (const c of s.doc.clips) {
      for (const k of c.keyframes) for (const kf of k.keyframes) if (kfIds.includes(kf.id)) items.push({ prop: k.property, dt: kf.time, value: kf.value, easing: kf.easing, handles: kf.handles })
      for (const fx of c.effects) for (const [p, kfs] of Object.entries(fx.paramKeyframes ?? {})) for (const kf of kfs) {
        if (kfIds.includes(kf.id)) items.push({ prop: p, fxType: fx.type, dt: kf.time, value: kf.value, easing: kf.easing, handles: kf.handles })
      }
    }
    if (items.length) {
      const t0 = Math.min(...items.map(i => i.dt))
      for (const i of items) i.dt -= t0
      clipboard = { kind: 'keyframes', items }
      return `${items.length} keyframe${items.length > 1 ? 's' : ''} copied`
    }
  }
  const cs = selectedClips()
  if (cs.length) {
    clipboard = { kind: 'layers', clips: JSON.parse(JSON.stringify(cs)), t0: Math.min(...cs.map(c => c.start)) }
    return `${cs.length} layer${cs.length > 1 ? 's' : ''} copied`
  }
  return ''
}

/** Ctrl+V — keyframes land at the CTI on the selected layer(s); layers paste at the CTI on top. */
export function pasteClipboard(): string {
  if (!clipboard) return ''
  const s = st()
  const t = now()
  if (clipboard.kind === 'keyframes') {
    const targets = selectedClips()
    if (!targets.length) return 'Select a layer to paste keyframes into'
    const items = clipboard.items
    const newKf: string[] = []
    s.mutate(d => {
      for (const tc of targets) {
        const c = d.clips.find(x => x.id === tc.id)
        if (!c) continue
        const lt0 = Math.max(0, t - c.start)
        for (const it of items) {
          const kf = { id: uid('kf'), time: lt0 + it.dt, value: it.value, easing: it.easing, handles: it.handles }
          newKf.push(kf.id)
          if (it.fxType) {
            const fx = c.effects.find(e => e.type === it.fxType)
            if (!fx) continue
            fx.paramKeyframes = fx.paramKeyframes ?? {}
            const arr = fx.paramKeyframes[it.prop] ?? (fx.paramKeyframes[it.prop] = [])
            const i = arr.findIndex(k => Math.abs(k.time - kf.time) < 1e-3)
            if (i >= 0) arr.splice(i, 1)
            arr.push(kf); arr.sort((a, b) => a.time - b.time)
          } else {
            let tr = c.keyframes.find(k => k.property === it.prop)
            if (!tr) { tr = { property: it.prop, keyframes: [] }; c.keyframes.push(tr) }
            tr.keyframes = tr.keyframes.filter(k => Math.abs(k.time - kf.time) >= 1e-3)
            tr.keyframes.push(kf); tr.keyframes.sort((a, b) => a.time - b.time)
          }
        }
      }
    })
    useEditorStore.setState({ selectedKeyframeIds: newKf, selectedKeyframeId: newKf[newKf.length - 1] ?? null })
    return `${items.length} keyframe${items.length > 1 ? 's' : ''} pasted`
  }
  const cb = clipboard
  const ids: string[] = []
  s.mutate(d => {
    const idx = insertIndex(d)
    const idMap = new Map<string, string>()
    for (const src of cb.clips) idMap.set(src.id, uid('clip'))
    // keep original stacking order: iterate bottom-up so the first ends on top
    for (const src of [...cb.clips].reverse()) {
      const copy = JSON.parse(JSON.stringify(src)) as Clip
      copy.id = idMap.get(src.id)!
      copy.start = Math.max(0, t + (src.start - cb.t0))
      if (copy.parentId && idMap.has(copy.parentId)) copy.parentId = idMap.get(copy.parentId)!
      const track = newTrackFor(d, copy.kind, copy.name.slice(0, 28), idx)
      copy.trackId = track.id
      d.clips.push(copy)
      ids.push(copy.id)
    }
  })
  s.selectMany(ids)
  return `${cb.clips.length} layer${cb.clips.length > 1 ? 's' : ''} pasted`
}

export function hasClipboard() { return clipboard?.kind ?? null }

// ------------------------------------------------------------------ pre-comps
/** Layer > Pre-compose (Ctrl+Shift+C): selected layers move into a new comp. */
export function precomposeSelected(name?: string): string | null {
  const cs = selectedClips()
  if (!cs.length) return null
  let newId: string | null = null
  st().mutate(d => {
    const ids = new Set(cs.map(c => c.id))
    const moving = d.clips.filter(c => ids.has(c.id))
    const t0 = Math.min(...moving.map(c => c.start))
    const t1 = Math.max(...moving.map(c => c.start + c.duration))
    // stacking: top-most selected track is where the pre-comp layer goes
    const trackIdx = Math.min(...moving.map(c => d.tracks.findIndex(t => t.id === c.trackId)).filter(i => i >= 0))
    const usedTracks = new Set(moving.map(c => c.trackId))
    const innerTracks = d.tracks.filter(t => usedTracks.has(t.id)).map(t => ({ ...t, id: uid('track') }))
    const trackMap = new Map<string, string>()
    d.tracks.filter(t => usedTracks.has(t.id)).forEach((t, i) => trackMap.set(t.id, innerTracks[i].id))
    const innerClips = moving.map(c => ({ ...JSON.parse(JSON.stringify(c)), trackId: trackMap.get(c.trackId)!, start: c.start - t0 }) as Clip)
    // parents outside the pre-comp can't be reached from inside
    for (const c of innerClips) if (c.parentId && !ids.has(c.parentId)) c.parentId = null
    const n = (d.precomps?.length ?? 0) + 1
    const pcId = uid('comp')
    d.precomps = [...(d.precomps ?? []), {
      id: pcId, name: name ?? `${moving.length === 1 ? moving[0].name : 'Pre-comp'} ${n}`,
      composition: { ...d.composition, duration: Math.max(0.5, t1 - t0) },
      tracks: innerTracks, clips: innerClips,
    }]
    d.clips = d.clips.filter(c => !ids.has(c.id))
    for (const c of d.clips) if (c.parentId && ids.has(c.parentId)) c.parentId = null
    // drop tracks that are now empty
    d.tracks = d.tracks.filter(t => !usedTracks.has(t.id) || d.clips.some(c => c.trackId === t.id))
    const track: Track = { id: uid('track'), kind: 'video', name: `Pre-comp ${n}`, locked: false, visible: true, muted: false, height: 64 }
    d.tracks.splice(Math.max(0, Math.min(trackIdx, d.tracks.length)), 0, track)
    newId = uid('clip')
    d.clips.push({ ...makeClipBase(track.id, d.precomps[d.precomps.length - 1].name, t0, t1 - t0), id: newId, kind: 'precomp', precompId: pcId, label: 15 })
  })
  if (newId) st().select(newId)
  return newId
}

/** Open a comp in the viewer/timeline (double-click a pre-comp layer or Project item). */
export function openComp(id: string) {
  const s = st()
  const cur = s.doc.compId ?? 'main'
  if (id === cur) return
  s.mutate(d => {
    const stack = d.compStack ?? []
    const at = stack.indexOf(id)
    const nd = openCompIn(d, id)
    Object.assign(d, nd)
    d.compStack = at >= 0 ? stack.slice(0, at) : [...stack, cur]
  })
  s.select(null)
  playbackEngine.pause()
  playbackEngine.seek(0)
}

export function closeComp() {
  const stack = st().doc.compStack ?? []
  if (stack.length) openComp(stack[stack.length - 1])
}

/** Add an existing comp as a layer of the open comp (drag from Project). */
export function addCompLayer(pcId: string, at = now()) {
  const s = st()
  const pc = s.doc.precomps?.find(p => p.id === pcId)
  if (!pc || pcId === (s.doc.compId ?? 'main')) return
  let id: string | null = null
  s.mutate(d => {
    const track = newTrackFor(d, 'precomp', pc.name, insertIndex(d))
    id = uid('clip')
    d.clips.push({ ...makeClipBase(track.id, pc.name, Math.max(0, at), pc.composition.duration), id, kind: 'precomp', precompId: pc.id, label: 15 })
  })
  if (id) s.select(id)
}
