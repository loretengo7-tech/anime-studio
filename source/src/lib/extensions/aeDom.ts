/**
 * ANIME STUDIO — ExtendScript host (After Effects scripting DOM emulation)
 *
 * Runs After Effects .jsx scripts and the ExtendScript side of CEP panels
 * (.zxp) against the AnimeStudio project. Implements the parts of the AE
 * object model that keyframe / easing / rigging tools use:
 *
 *   app.project.activeItem (CompItem) → layers, selectedLayers,
 *   selectedProperties, time, frameRate…
 *   Layer → Transform (Anchor Point, Position, Scale, Rotation, Opacity),
 *   Effects (each effect's parameters), expressions, parenting, in/out…
 *   Property → numKeys, keyTime/keyValue, keySelected/setSelectedAtKey,
 *   addKey/removeKey, setValueAtTime/setValueAtKey, valueAtTime,
 *   setInterpolationTypeAtKey, setTemporalEaseAtKey/keyIn|OutTemporalEase
 *   (KeyframeEase speed/influence → real cubic-bezier keyframes)…
 *   app.beginUndoGroup/endUndoGroup (one undo step), alert/confirm/prompt,
 *   $.writeln, File/Folder stubs, ScriptUI (Window/Panel/controls).
 *
 * Everything a script changes is applied to a working copy and committed as
 * ONE undoable edit when the call returns.
 */
import { useEditorStore } from '@/lib/store/editorStore'
import { playbackEngine } from '@/lib/engine/playback'
import { evalKeyframeTrack } from '@/lib/engine/keyframes'
import { EFFECT_MAP } from '@/lib/engine/effects'
import type { Clip, Keyframe, KeyframeTrack, ProjectDoc } from '@/lib/engine/types'
import { uid } from '@/lib/engine/types'
import { layerOrder, newLayer } from '@/components/editor/ae/aeActions'
import { ScriptUIWindow, makeScriptUI } from './scriptui'

// ------------------------------------------------------------------ enums (AE values)
export const PropertyType = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 }
export const PropertyValueType = { NO_VALUE: 6412, ThreeD_SPATIAL: 6413, ThreeD: 6414, TwoD_SPATIAL: 6415, TwoD: 6416, OneD: 6417, COLOR: 6418, CUSTOM_VALUE: 6419, MARKER: 6420, LAYER_INDEX: 6421, MASK_INDEX: 6422, SHAPE: 6423, TEXT_DOCUMENT: 6424 }
export const KeyframeInterpolationType = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 }
const KIT = KeyframeInterpolationType

export class KeyframeEase {
  speed: number
  influence: number
  constructor(speed: number, influence: number) { this.speed = Number(speed) || 0; this.influence = Math.max(0.1, Math.min(100, Number(influence) || 16.67)) }
}

/** AE per-key ease state we keep on our keyframes (all dims of a key share it). */
interface AeKeyState { inSpeed?: number; inInfl?: number; outSpeed?: number; outInfl?: number; inType?: number; outType?: number }
type KF = Keyframe & { ae?: AeKeyState }

// ------------------------------------------------------------------ working copy / commit
class HostSession {
  private work: ProjectDoc | null = null
  depth = 0
  doc(): ProjectDoc { return this.work ?? useEditorStore.getState().doc }
  /** Mutable doc for writes (cloned once per top-level call). */
  w(): ProjectDoc {
    if (!this.work) this.work = structuredClone(useEditorStore.getState().doc) as ProjectDoc
    return this.work
  }
  flush() {
    const work = this.work
    this.work = null
    if (!work) return
    useEditorStore.getState().mutate(d => {
      const dd = d as unknown as Record<string, unknown>
      for (const k of Object.keys(work)) dd[k] = (work as unknown as Record<string, unknown>)[k]
    }, 'Script')
  }
  discard() { this.work = null }
  run<T>(fn: () => T): T {
    this.depth++
    let failed: unknown = null
    try { return fn() } catch (e) { failed = e; throw e } finally {
      this.depth--
      if (this.depth === 0) {
        // a script waiting for a file dialog is replayed with the answer: drop its partial edits
        if (failed instanceof NeedDialog || dialogState.pending) { this.discard(); pendingImports.length = 0 }
        else { this.flush(); void drainPendingImports() }
      }
    }
  }
}
export const hostSession = new HostSession()

// ------------------------------------------------------------------ file dialogs (replay model)
// ExtendScript dialogs block; the browser's don't. A script that asks for a file
// throws NeedDialog, we show the real picker, then REPLAY the call with the
// answer queued, so File.openDialog()/Folder.selectDialog() "return" it.
export interface PickedFile { name: string; path: string; file: File | null; text: string | null; isFolder?: boolean; children?: PickedFile[] }
export class NeedDialog extends Error {
  constructor(public kind: 'open' | 'folder' | 'save', public multi: boolean, public filter: string, public defaultName = '') { super('__AS_NEEDS_DIALOG__') }
}
const dialogState = { answers: [] as (PickedFile[] | null)[], cursor: 0, pending: null as NeedDialog | null }
function takeDialog(d: NeedDialog): PickedFile[] | null {
  if (dialogState.cursor < dialogState.answers.length) return dialogState.answers[dialogState.cursor++]
  dialogState.pending = d
  throw d
}
function pickFiles(d: NeedDialog): Promise<PickedFile[] | null> {
  if (d.kind === 'save') return Promise.resolve([{ name: d.defaultName || 'output.txt', path: d.defaultName || 'output.txt', file: null, text: null }])
  return new Promise(res => {
    const i = document.createElement('input')
    i.type = 'file'
    if (d.multi) i.multiple = true
    if (d.kind === 'folder') (i as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true
    let done = false
    i.addEventListener('cancel', () => { if (!done) { done = true; res(null) } })
    i.onchange = async () => {
      done = true
      const files = [...(i.files ?? [])]
      const read = async (f: File): Promise<PickedFile> => ({
        name: f.name, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, file: f,
        text: f.size < 4 * 1024 * 1024 && !/^(video|audio|image)\//.test(f.type) ? await f.text().catch(() => null) : null,
      })
      const picked = await Promise.all(files.map(read))
      if (d.kind === 'folder') {
        const root = picked[0]?.path.split('/')[0] ?? 'Folder'
        res([{ name: root, path: root, file: null, text: null, isFolder: true, children: picked }])
      } else res(picked.length ? picked : null)
    }
    const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
    if (!ua || ua.isActive) { i.click(); return }
    // no user gesture (e.g. the script ran when its panel opened): ask with a button
    const box = document.createElement('div')
    box.style.cssText = 'position:fixed;left:50%;top:18%;transform:translateX(-50%);z-index:9999;background:#262626;border:1px solid #000;border-radius:6px;box-shadow:0 18px 60px rgba(0,0,0,.7);padding:16px 18px;color:#ddd;font:12px Inter,system-ui,sans-serif;min-width:300px'
    box.innerHTML = `<div style="font-weight:600;color:#fff;margin-bottom:6px">The script needs ${d.kind === 'folder' ? 'a folder' : d.multi ? 'files' : 'a file'}</div><div style="color:#999;margin-bottom:12px">${d.filter ? String(d.filter).replace(/[<>&]/g, '') : 'Choose what to use, like After Effects\' dialog.'}</div>`
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end'
    const ok = document.createElement('button'); ok.textContent = 'Choose…'; ok.style.cssText = 'background:#2d8ceb;color:#fff;border:0;border-radius:3px;padding:5px 14px'
    const no = document.createElement('button'); no.textContent = 'Cancel'; no.style.cssText = 'background:#3a3a3a;color:#eee;border:0;border-radius:3px;padding:5px 14px'
    ok.onclick = () => { box.remove(); i.click() }
    no.onclick = () => { box.remove(); done = true; res(null) }
    row.append(no, ok); box.append(row); document.body.append(box)
  })
}
/** Run a script call; if it asked for a dialog, show it and replay (up to 8 dialogs). */
export async function runWithDialogs<T>(fn: () => T): Promise<T> {
  dialogState.answers = []
  for (let n = 0; n < 9; n++) {
    dialogState.cursor = 0
    dialogState.pending = null
    let out: T | undefined
    let err: unknown = null
    try { out = fn() } catch (e) { err = e }
    const need = err instanceof NeedDialog ? err : dialogState.pending
    if (need) {
      dialogState.pending = null
      dialogState.answers.push(await pickFiles(need))
      continue
    }
    if (err) throw err
    return out as T
  }
  throw new Error('Too many dialogs in one script call')
}
export function dialogPending() { return !!dialogState.pending }

// ------------------------------------------------------------------ imports requested by scripts
const pendingImports: { file: File; addToComp: boolean; ref: { meta?: unknown } }[] = []
async function drainPendingImports() {
  if (!pendingImports.length) return
  const list = pendingImports.splice(0)
  const { importFiles, addAssetLayer } = await import('@/components/editor/ae/aeActions')
  for (const it of list) {
    const [meta] = await importFiles([it.file])
    it.ref.meta = meta
    if (meta && it.addToComp) addAssetLayer(meta)
  }
}

const S = () => useEditorStore.getState()
const comp = () => hostSession.doc().composition

// ------------------------------------------------------------------ properties

interface DimSpec { p: string; mul: number }
interface PropSpec { name: string; matchName: string; dims: DimSpec[]; vt: number; spatial: boolean; exprKey?: string }

const TRANSFORM_SPECS: PropSpec[] = [
  { name: 'Anchor Point', matchName: 'ADBE Anchor Point', dims: [{ p: 'anchorX', mul: 1 }, { p: 'anchorY', mul: 1 }], vt: PropertyValueType.TwoD_SPATIAL, spatial: true, exprKey: 'anchor' },
  { name: 'Position', matchName: 'ADBE Position', dims: [{ p: 'x', mul: 1 }, { p: 'y', mul: 1 }], vt: PropertyValueType.TwoD_SPATIAL, spatial: true, exprKey: 'position' },
  { name: 'Scale', matchName: 'ADBE Scale', dims: [{ p: 'scale', mul: 100 }, { p: 'scale', mul: 100 }], vt: PropertyValueType.TwoD, spatial: false, exprKey: 'scale' },
  { name: 'Rotation', matchName: 'ADBE Rotate Z', dims: [{ p: 'rotation', mul: 1 }], vt: PropertyValueType.OneD, spatial: false, exprKey: 'rotation' },
  { name: 'Opacity', matchName: 'ADBE Opacity', dims: [{ p: 'opacity', mul: 100 }], vt: PropertyValueType.OneD, spatial: false, exprKey: 'opacity' },
]

const EPS = 1e-4

function clipOf(id: string): Clip | undefined { return hostSession.doc().clips.find(c => c.id === id) }
function wClip(id: string): Clip { const c = hostSession.w().clips.find(c => c.id === id); if (!c) throw new Error('Layer no longer exists'); return c }

export class AEProperty {
  readonly propertyType = PropertyType.PROPERTY
  readonly clipId: string
  readonly spec: PropSpec
  readonly parentProperty: AEPropertyGroup
  readonly propertyIndex: number
  constructor(clipId: string, spec: PropSpec, parent: AEPropertyGroup, index: number) { this.clipId = clipId; this.spec = spec; this.parentProperty = parent; this.propertyIndex = index }
  get name() { return this.spec.name }
  get matchName() { return this.spec.matchName }
  get propertyDepth() { return this.parentProperty.propertyDepth + 1 }
  get propertyValueType() { return this.spec.vt }
  get isSpatial() { return this.spec.spatial }
  get dimensionsSeparated() { return false }
  set dimensionsSeparated(_v: boolean) { /* position is always separable internally */ }
  get isSeparationLeader() { return false }
  get isSeparationFollower() { return false }
  getSeparationFollower(_d: number) { return this }
  get canVaryOverTime() { return true }
  get canSetExpression() { return !!this.spec.exprKey }
  get enabled() { return true }
  get active() { return true }
  get elided() { return false }
  get isModified() { return this.numKeys > 0 }
  get unitsText() { return '' }
  get hasMin() { return false }
  get hasMax() { return false }

  // ---- helpers
  private uniqDims(): DimSpec[] { const seen = new Set<string>(); return this.spec.dims.filter(d => (seen.has(d.p) ? false : (seen.add(d.p), true))) }
  private tracks(c = clipOf(this.clipId)): (KeyframeTrack | undefined)[] {
    return this.uniqDims().map(d => c?.keyframes.find(k => k.property === d.p))
  }
  private staticVal(c: Clip, d: DimSpec): number {
    if (d.p.startsWith('effect:')) {
      const [, id, key] = d.p.split(':')
      return c.effects.find(e => e.id === id)?.params[key] ?? 0
    }
    return (c as unknown as Record<string, number>)[d.p] ?? 0
  }
  /** Unique key times (clip-local), merged over dimensions. */
  private keyTimes(): number[] {
    const out: number[] = []
    for (const t of this.tracks()) for (const k of t?.keyframes ?? []) if (!out.some(x => Math.abs(x - k.time) < EPS)) out.push(k.time)
    return out.sort((a, b) => a - b)
  }
  private kfsAt(local: number, c = clipOf(this.clipId)): (KF | undefined)[] {
    return this.tracks(c).map(t => t?.keyframes.find(k => Math.abs(k.time - local) < EPS) as KF | undefined)
  }
  private start(c = clipOf(this.clipId)) { return c?.start ?? 0 }
  private idx(k: number): number {
    const n = this.numKeys
    k = Math.round(Number(k))
    if (k < 1 || k > n) throw new Error(`Key index ${k} out of range (1..${n})`)
    return k
  }
  private toVal(arr: number[]): number | number[] { return this.spec.dims.length === 1 ? arr[0] : arr }
  private fromVal(v: unknown): number[] {
    const a = Array.isArray(v) ? v.map(Number) : [Number(v)]
    return this.spec.dims.map((_, i) => a[Math.min(i, a.length - 1)] ?? 0)
  }

  // ---- values
  get numKeys() { return this.keyTimes().length }
  get isTimeVarying() { return this.numKeys > 0 || !!this.expression }
  get value() { return this.valueAtTime(S().doc === hostSession.doc() ? playbackEngine.currentTime : playbackEngine.currentTime, false) }
  valueAtTime(t: number, _preExpression?: boolean) {
    const c = clipOf(this.clipId)
    if (!c) return this.toVal(this.spec.dims.map(() => 0))
    const local = Number(t) - c.start
    return this.toVal(this.spec.dims.map(d => (evalKeyframeTrack(c.keyframes.find(k => k.property === d.p), local, this.staticVal(c, d)) ?? 0) * d.mul))
  }
  setValue(v: unknown) {
    const vals = this.fromVal(v)
    const c = wClip(this.clipId)
    this.spec.dims.forEach((d, i) => {
      const tr = c.keyframes.find(k => k.property === d.p)
      if (tr && tr.keyframes.length) {
        // AE throws here; be forgiving: write at the current time
        this.writeKey(c, d, playbackEngine.currentTime - c.start, vals[i] / d.mul)
      } else this.setStatic(c, d, vals[i] / d.mul)
    })
  }
  private setStatic(c: Clip, d: DimSpec, v: number) {
    if (d.p.startsWith('effect:')) {
      const [, id, key] = d.p.split(':')
      const e = c.effects.find(e => e.id === id)
      if (e) e.params[key] = v
    } else (c as unknown as Record<string, number>)[d.p] = v
  }
  private writeKey(c: Clip, d: DimSpec, local: number, v: number): KF {
    let tr = c.keyframes.find(k => k.property === d.p)
    if (!tr) { tr = { property: d.p, keyframes: [] }; c.keyframes.push(tr) }
    let kf = tr.keyframes.find(k => Math.abs(k.time - local) < EPS) as KF | undefined
    if (kf) kf.value = v
    else {
      kf = { id: uid('kf'), time: local, value: v, easing: 'linear' }
      tr.keyframes.push(kf)
      tr.keyframes.sort((a, b) => a.time - b.time)
    }
    return kf
  }
  setValueAtTime(t: number, v: unknown) {
    const vals = this.fromVal(v)
    const c = wClip(this.clipId)
    const local = Number(t) - c.start
    this.spec.dims.forEach((d, i) => { this.writeKey(c, d, local, vals[i] / d.mul) })
    this.rebuildAround(this.nearestKeyIndex(t))
  }
  setValuesAtTimes(ts: number[], vs: unknown[]) { ts.forEach((t, i) => this.setValueAtTime(t, vs[i])) }
  addKey(t: number): number {
    const v = this.valueAtTime(t)
    this.setValueAtTime(t, v)
    return this.nearestKeyIndex(t)
  }
  removeKey(k: number) {
    const i = this.idx(k)
    const local = this.keyTimes()[i - 1]
    const c = wClip(this.clipId)
    for (const d of this.uniqDims()) {
      const tr = c.keyframes.find(x => x.property === d.p)
      if (tr) tr.keyframes = tr.keyframes.filter(x => Math.abs(x.time - local) >= EPS)
    }
    c.keyframes = c.keyframes.filter(t => t.keyframes.length > 0)
    if (i > 1) this.rebuildAround(i - 1)
  }
  nearestKeyIndex(t: number): number {
    const times = this.keyTimes()
    if (!times.length) return 0
    const local = Number(t) - this.start()
    let best = 0, bd = Infinity
    times.forEach((x, i) => { const d = Math.abs(x - local); if (d < bd) { bd = d; best = i } })
    return best + 1
  }
  keyTime(k: number): number { return this.keyTimes()[this.idx(k) - 1] + this.start() }
  keyValue(k: number) {
    const local = this.keyTimes()[this.idx(k) - 1]
    const c = clipOf(this.clipId)!
    return this.toVal(this.spec.dims.map(d => {
      const kf = c.keyframes.find(t => t.property === d.p)?.keyframes.find(x => Math.abs(x.time - local) < EPS)
      return (kf ? kf.value : evalKeyframeTrack(c.keyframes.find(t => t.property === d.p), local, this.staticVal(c, d)) ?? 0) * d.mul
    }))
  }
  setValueAtKey(k: number, v: unknown) { this.setValueAtTime(this.keyTime(k), v) }

  // ---- selection (AE timeline key selection ↔ AnimeStudio selectedKeyframeIds)
  keySelected(k: number): boolean {
    const local = this.keyTimes()[this.idx(k) - 1]
    const sel = new Set(S().selectedKeyframeIds.length ? S().selectedKeyframeIds : S().selectedKeyframeId ? [S().selectedKeyframeId!] : [])
    return this.kfsAt(local, clipOf(this.clipId)).some(kf => kf && sel.has(kf.id))
  }
  setSelectedAtKey(k: number, on: boolean) {
    hostSession.flush()
    const local = this.keyTimes()[this.idx(k) - 1]
    const ids = this.kfsAt(local).filter(Boolean).map(kf => kf!.id)
    const cur = new Set(S().selectedKeyframeIds)
    for (const id of ids) on ? cur.add(id) : cur.delete(id)
    const arr = [...cur]
    useEditorStore.setState({ selectedKeyframeIds: arr, selectedKeyframeId: arr[arr.length - 1] ?? null })
  }
  get selectedKeys(): number[] { const out: number[] = []; for (let k = 1; k <= this.numKeys; k++) if (this.keySelected(k)) out.push(k); return out }
  get selected() { return this.selectedKeys.length > 0 }
  set selected(_v: boolean) { }

  // ---- interpolation & temporal ease
  private segSpeed(c: Clip, k: number): { D: number; V: number } {
    // segment k → k+1 (1-based); V = value change in AE units (spatial: path length)
    const times = this.keyTimes()
    if (k < 1 || k >= times.length) return { D: 1, V: 0 }
    const a = this.keyValue(k), b = this.keyValue(k + 1)
    const av = Array.isArray(a) ? a : [a], bv = Array.isArray(b) ? b : [b]
    const D = times[k] - times[k - 1]
    let V: number
    if (this.spec.spatial) V = Math.hypot(...av.map((x, i) => bv[i] - x))
    else V = bv[0] - av[0]
    void c
    return { D: Math.max(1e-6, D), V }
  }
  private state(k: number): AeKeyState {
    const local = this.keyTimes()[k - 1]
    const kf = this.kfsAt(local).find(Boolean)
    return { ...(kf?.ae ?? {}) }
  }
  private setState(k: number, patch: AeKeyState) {
    const c = wClip(this.clipId)
    const local = this.keyTimes()[k - 1]
    for (const kf of this.kfsAt(local, c)) if (kf) kf.ae = { ...(kf.ae ?? {}), ...patch }
  }
  keyInInterpolationType(k: number): number {
    const i = this.idx(k); const s = this.state(i)
    if (s.inType) return s.inType
    if (i === 1) return KIT.LINEAR
    const prev = this.kfsAt(this.keyTimes()[i - 2]).find(Boolean)
    return prev?.easing === 'hold' ? KIT.HOLD : prev?.easing === 'linear' ? KIT.LINEAR : KIT.BEZIER
  }
  keyOutInterpolationType(k: number): number {
    const i = this.idx(k); const s = this.state(i)
    if (s.outType) return s.outType
    const kf = this.kfsAt(this.keyTimes()[i - 1]).find(Boolean)
    return kf?.easing === 'hold' ? KIT.HOLD : kf?.easing === 'linear' || !kf ? KIT.LINEAR : KIT.BEZIER
  }
  setInterpolationTypeAtKey(k: number, inType: number, outType?: number) {
    const i = this.idx(k)
    this.setState(i, { inType: Number(inType), outType: Number(outType ?? inType) })
    this.rebuildAround(i)
  }
  keyInTemporalEase(k: number): KeyframeEase[] {
    const i = this.idx(k); const s = this.state(i)
    const c = clipOf(this.clipId)!
    if (s.inSpeed !== undefined && s.inInfl !== undefined) return this.easeArr(new KeyframeEase(s.inSpeed, s.inInfl))
    if (i === 1) return this.easeArr(new KeyframeEase(0, 16.666667))
    const { D, V } = this.segSpeed(c, i - 1)
    const prev = this.kfsAt(this.keyTimes()[i - 2]).find(Boolean)
    if (prev?.easing === 'bezier' && prev.handles) {
      const h2 = prev.handles[1]; const infl = Math.max(0.001, 1 - h2.x)
      return this.easeArr(new KeyframeEase(((1 - h2.y) / infl) * V / D, infl * 100))
    }
    return this.easeArr(new KeyframeEase(prev?.easing === 'hold' ? 0 : V / D, 16.666667))
  }
  keyOutTemporalEase(k: number): KeyframeEase[] {
    const i = this.idx(k); const s = this.state(i)
    const c = clipOf(this.clipId)!
    if (s.outSpeed !== undefined && s.outInfl !== undefined) return this.easeArr(new KeyframeEase(s.outSpeed, s.outInfl))
    if (i === this.numKeys) return this.easeArr(new KeyframeEase(0, 16.666667))
    const { D, V } = this.segSpeed(c, i)
    const kf = this.kfsAt(this.keyTimes()[i - 1]).find(Boolean)
    if (kf?.easing === 'bezier' && kf.handles) {
      const h1 = kf.handles[0]; const infl = Math.max(0.001, h1.x)
      return this.easeArr(new KeyframeEase((h1.y / infl) * V / D, infl * 100))
    }
    return this.easeArr(new KeyframeEase(kf?.easing === 'hold' ? 0 : V / D, 16.666667))
  }
  private easeArr(e: KeyframeEase): KeyframeEase[] {
    const n = this.spec.spatial ? 1 : this.spec.dims.length
    return Array.from({ length: n }, () => new KeyframeEase(e.speed, e.influence))
  }
  setTemporalEaseAtKey(k: number, inEase: KeyframeEase[] | KeyframeEase, outEase?: KeyframeEase[] | KeyframeEase) {
    const i = this.idx(k)
    const first = (x: KeyframeEase[] | KeyframeEase | undefined) => (Array.isArray(x) ? x[0] : x)
    const ie = first(inEase), oe = first(outEase ?? inEase)
    const st = this.state(i)
    this.setState(i, {
      inSpeed: ie?.speed, inInfl: ie?.influence, outSpeed: oe?.speed, outInfl: oe?.influence,
      inType: st.inType === KIT.HOLD ? KIT.HOLD : KIT.BEZIER, outType: st.outType === KIT.HOLD ? KIT.HOLD : KIT.BEZIER,
    })
    this.rebuildAround(i)
  }
  setTemporalContinuousAtKey() { }
  setTemporalAutoBezierAtKey() { }
  setSpatialTangentsAtKey() { }
  setSpatialContinuousAtKey() { }
  setSpatialAutoBezierAtKey() { }
  setRovingAtKey() { }
  keyTemporalContinuous() { return false }
  keyTemporalAutoBezier() { return false }
  keyRoving() { return false }
  keyInSpatialTangent() { return this.spec.dims.map(() => 0) }
  keyOutSpatialTangent() { return this.spec.dims.map(() => 0) }

  /** Re-derive our easing/handles for the segments touching key i (AE ease → cubic bezier). */
  private rebuildAround(i: number) {
    if (i < 1) return
    for (const seg of [i - 1, i]) this.rebuildSegment(seg)
  }
  private rebuildSegment(k: number) {
    const n = this.numKeys
    if (k < 1 || k >= n) return
    const c = wClip(this.clipId)
    const times = this.keyTimes()
    const a = this.kfsAt(times[k - 1], c), b = this.kfsAt(times[k], c)
    const sa = a.find(Boolean)?.ae ?? {}, sb = b.find(Boolean)?.ae ?? {}
    const outType = sa.outType ?? (sa.outSpeed !== undefined ? KIT.BEZIER : undefined)
    const inType = sb.inType ?? (sb.inSpeed !== undefined ? KIT.BEZIER : undefined)
    if (outType === undefined && inType === undefined) return // untouched by the script: keep ours
    const { D, V } = this.segSpeed(c, k)
    let easing: Keyframe['easing'] = 'bezier'
    let handles: Keyframe['handles']
    if (outType === KIT.HOLD) easing = 'hold'
    else if ((outType ?? KIT.LINEAR) === KIT.LINEAR && (inType ?? KIT.LINEAR) === KIT.LINEAR) easing = 'linear'
    else {
      const lin = V / D
      const oi = outType === KIT.LINEAR ? 1 / 3 : Math.max(0.001, Math.min(1, (sa.outInfl ?? 33.333) / 100))
      const os = outType === KIT.LINEAR ? lin : (sa.outSpeed ?? 0)
      const ii = inType === KIT.LINEAR ? 1 / 3 : Math.max(0.001, Math.min(1, (sb.inInfl ?? 33.333) / 100))
      const is = inType === KIT.LINEAR ? lin : (sb.inSpeed ?? 0)
      const y1 = Math.abs(V) > 1e-9 ? os * oi * D / V : 0
      const y2 = Math.abs(V) > 1e-9 ? 1 - is * ii * D / V : 1
      handles = [{ x: oi, y: y1 }, { x: 1 - ii, y: y2 }]
    }
    for (const kf of a) if (kf) { kf.easing = easing; if (handles) kf.handles = handles.map(h => ({ ...h })) as Keyframe['handles']; else delete kf.handles }
  }

  // ---- expressions
  get expression(): string { return (this.spec.exprKey && clipOf(this.clipId)?.expressions?.[this.spec.exprKey]) || '' }
  set expression(v: string) {
    if (!this.spec.exprKey) return
    const c = wClip(this.clipId)
    c.expressions = { ...(c.expressions ?? {}) }
    if (v && String(v).trim()) c.expressions[this.spec.exprKey] = String(v)
    else delete c.expressions[this.spec.exprKey]
  }
  get expressionEnabled() { return !!this.expression }
  set expressionEnabled(on: boolean) { if (!on) this.expression = '' }
  get expressionError() { return '' }
  propertyGroup(n = 1): AEPropertyGroup | AELayer { let g: AEPropertyGroup | AELayer = this.parentProperty; for (let i = 1; i < n && g instanceof AEPropertyGroup; i++) g = g.parentProperty; return g }
  duplicate() { return this }
  remove() { }
  moveTo() { }
}

export class AEPropertyGroup {
  propertyType: number
  name: string
  matchName: string
  parentProperty: AEPropertyGroup | AELayer
  propertyIndex: number
  private kids: () => (AEProperty | AEPropertyGroup)[]
  constructor(name: string, matchName: string, parent: AEPropertyGroup | AELayer, index: number, kids: (g: AEPropertyGroup) => (AEProperty | AEPropertyGroup)[], type = PropertyType.NAMED_GROUP) {
    this.name = name; this.matchName = matchName; this.parentProperty = parent; this.propertyIndex = index; this.propertyType = type
    this.kids = () => kids(this)
  }
  get propertyDepth(): number { return this.parentProperty instanceof AEPropertyGroup ? this.parentProperty.propertyDepth + 1 : 1 }
  get numProperties() { return this.kids().length }
  get enabled() { return true }
  get selected() { return false }
  property(q: number | string): AEProperty | AEPropertyGroup | null {
    const k = this.kids()
    if (typeof q === 'number') return k[q - 1] ?? null
    return k.find(p => p.name === q || p.matchName === q) ?? null
  }
  canAddProperty(_m: string) { return this.matchName === 'ADBE Effect Parade' }
  addProperty(matchName: string) { return addEffectByMatchName(this, matchName) }
  propertyGroup(n = 1) { let g: AEPropertyGroup | AELayer = this.parentProperty; for (let i = 1; i < n && g instanceof AEPropertyGroup; i++) g = g.parentProperty; return g }
  get isModified() { return true }
  remove() {
    // effect groups can be removed
    if (this.matchName.startsWith('fx:')) {
      const layer = this.propertyGroup(this.propertyDepth) as AELayer
      const c = wClip(layer.clipId)
      c.effects = c.effects.filter(e => e.id !== this.matchName.slice(3))
    }
  }
}

import { MATCH_TO_TYPE } from './matchNames'
export { MATCH_TO_TYPE }
function addEffectByMatchName(group: AEPropertyGroup, matchName: string) {
  const layer = group.parentProperty as AELayer
  const c = wClip(layer.clipId)
  const type = (MATCH_TO_TYPE[matchName] && EFFECT_MAP[MATCH_TO_TYPE[matchName]] ? MATCH_TO_TYPE[matchName] : undefined)
    ?? Object.keys(EFFECT_MAP).find(t => t === matchName || EFFECT_MAP[t].name === matchName)
  if (!type) throw new Error(`Effect "${matchName}" is not available in AnimeStudio`)
  const def = EFFECT_MAP[type]
  c.effects.push({ id: uid('fx'), type, enabled: true, params: Object.fromEntries(def.params.map(p => [p.key, p.default])), paramKeyframes: {} })
  return group.property(group.numProperties)
}

// ------------------------------------------------------------------ layers

export class AELayer {
  readonly clipId: string
  readonly propertyType = PropertyType.INDEXED_GROUP
  readonly parentProperty = null
  readonly propertyDepth = 0
  constructor(clipId: string) { this.clipId = clipId }
  private c() { const c = clipOf(this.clipId); if (!c) throw new Error('Layer was deleted'); return c }
  get name() { return this.c().name }
  set name(v: string) { wClip(this.clipId).name = String(v) }
  get matchName() { const k = this.c().kind; return k === 'text' ? 'ADBE Text Layer' : k === 'shape' ? 'ADBE Vector Layer' : k === 'camera' ? 'ADBE Camera Layer' : 'ADBE AV Layer' }
  get index() { return layerOrder(hostSession.doc()).findIndex(c => c.id === this.clipId) + 1 }
  get id() { return this.clipId }
  get selected() { return S().selectedClipIds.includes(this.clipId) || S().selectedClipId === this.clipId }
  set selected(on: boolean) {
    const cur = new Set(S().selectedClipIds)
    on ? cur.add(this.clipId) : cur.delete(this.clipId)
    S().selectMany([...cur])
  }
  get enabled() { return !this.c().hidden }
  set enabled(v: boolean) { wClip(this.clipId).hidden = !v }
  get solo() { return !!this.c().solo }
  set solo(v: boolean) { wClip(this.clipId).solo = !!v }
  get locked() { return !!this.c().locked }
  set locked(v: boolean) { wClip(this.clipId).locked = !!v }
  get shy() { return !!this.c().shy }
  set shy(v: boolean) { wClip(this.clipId).shy = !!v }
  get label() { return this.c().label ?? 0 }
  set label(v: number) { wClip(this.clipId).label = Number(v) }
  get motionBlur() { return !!this.c().motionBlur }
  set motionBlur(v: boolean) { wClip(this.clipId).motionBlur = !!v }
  get threeDLayer() { return !!this.c().threeD }
  set threeDLayer(v: boolean) { wClip(this.clipId).threeD = !!v }
  get nullLayer() { return this.c().kind === 'null' }
  get adjustmentLayer() { return this.c().kind === 'adjustment' }
  get hasVideo() { return this.c().kind !== 'audio' }
  get hasAudio() { return this.c().kind === 'audio' || this.c().kind === 'video' }
  get inPoint() { return this.c().start }
  set inPoint(v: number) { const c = wClip(this.clipId); const end = c.start + c.duration; c.start = Number(v); c.duration = Math.max(0.01, end - c.start) }
  get outPoint() { const c = this.c(); return c.start + c.duration }
  set outPoint(v: number) { const c = wClip(this.clipId); c.duration = Math.max(0.01, Number(v) - c.start) }
  get startTime() { return this.c().start }
  set startTime(v: number) { wClip(this.clipId).start = Number(v) }
  get stretch() { return 100 / (this.c().speed || 1) }
  set stretch(v: number) { wClip(this.clipId).speed = 100 / (Number(v) || 100) }
  get time() { return playbackEngine.currentTime - this.c().start }
  get width() { return comp().width }
  get height() { return comp().height }
  get containingComp() { return new CompItem() }
  get parent(): AELayer | null { const p = this.c().parentId; return p ? new AELayer(p) : null }
  set parent(l: AELayer | null) { wClip(this.clipId).parentId = l ? l.clipId : null }
  setParentWithJump(l: AELayer | null) { this.parent = l }
  get source() { const c = this.c() as Clip & { assetId?: string }; const a = c.assetId ? hostSession.doc().assets.find(x => x.id === c.assetId) : null; return a ? { name: a.name, width: a.width, height: a.height, duration: a.duration, frameRate: a.fps, id: a.id } : null }
  sourceRectAtTime() { return { left: -comp().width / 2, top: -comp().height / 2, width: comp().width, height: comp().height } }
  activeAtTime(t: number) { const c = this.c(); return t >= c.start && t < c.start + c.duration }

  // property tree
  private transformGroup = (): AEPropertyGroup => new AEPropertyGroup('Transform', 'ADBE Transform Group', this, 1, g => TRANSFORM_SPECS.map((sp, i) => new AEProperty(this.clipId, sp, g, i + 1)))
  private effectsGroup = (): AEPropertyGroup => new AEPropertyGroup('Effects', 'ADBE Effect Parade', this, 2, g => this.c().effects.map((e, i) => {
    const def = EFFECT_MAP[e.type]
    const name = def?.name ?? e.type
    return new AEPropertyGroup(name, `fx:${e.id}`, g, i + 1, eg => Object.keys(e.params).map((key, j) => {
      const pdef = def?.params.find(p => p.key === key)
      return new AEProperty(this.clipId, { name: pdef?.label ?? key, matchName: `${e.type}-${key}`, dims: [{ p: `effect:${e.id}:${key}`, mul: 1 }], vt: PropertyValueType.OneD, spatial: false }, eg, j + 1)
    }))
  }), PropertyType.INDEXED_GROUP)
  private markerProp = (): AEPropertyGroup => new AEPropertyGroup('Marker', 'ADBE Marker', this, 3, () => [])
  get numProperties() { return 3 }
  property(q: number | string): AEPropertyGroup | AEProperty | null {
    if (q === 1 || q === 'Transform' || q === 'ADBE Transform Group' || q === 'transform') return this.transformGroup()
    if (q === 2 || q === 'Effects' || q === 'ADBE Effect Parade' || q === 'effect') return this.effectsGroup()
    if (q === 3 || q === 'Marker' || q === 'ADBE Marker') return this.markerProp()
    // AE shortcut lookups: layer.property("Position") works too
    return this.transformGroup().property(q as string)
  }
  get transform() { return this.transformGroup() }
  get Effects() { return this.effectsGroup() }
  get effect() { return this.effectsGroup() }
  get position() { return this.transformGroup().property('Position') }
  get anchorPoint() { return this.transformGroup().property('Anchor Point') }
  get scale() { return this.transformGroup().property('Scale') }
  get rotation() { return this.transformGroup().property('Rotation') }
  get opacity() { return this.transformGroup().property('Opacity') }
  get marker() { return this.markerProp() }
  get selectedProperties(): (AEProperty | AEPropertyGroup)[] {
    const out: (AEProperty | AEPropertyGroup)[] = []
    for (const g of [this.transformGroup(), this.effectsGroup()]) {
      const walk = (grp: AEPropertyGroup) => {
        for (let i = 1; i <= grp.numProperties; i++) {
          const p = grp.property(i)
          if (p instanceof AEProperty) { if (p.selected) out.push(p) } else if (p) walk(p)
        }
      }
      walk(g)
    }
    return out
  }
  duplicate() { hostSession.flush(); const s = S(); s.select(this.clipId); return this }
  remove() { const d = hostSession.w(); d.clips = d.clips.filter(c => c.id !== this.clipId) }
  moveToBeginning() { }
  moveToEnd() { }
  moveBefore() { }
  moveAfter() { }
  applyPreset() { throw new Error('Animation presets (.ffx) are not supported') }
}
export class AVLayer extends AELayer { }
export class ShapeLayer extends AELayer { }
export class TextLayer extends AELayer { }
export class CameraLayer extends AELayer { }
export class LightLayer extends AELayer { }
function wrapLayer(c: Clip): AELayer {
  return c.kind === 'text' ? new TextLayer(c.id) : c.kind === 'shape' ? new ShapeLayer(c.id) : c.kind === 'camera' ? new CameraLayer(c.id) : new AVLayer(c.id)
}

// ------------------------------------------------------------------ comp / project

class LayerCollection {
  [i: number]: AELayer
  get length() { return layerOrder(hostSession.doc()).length }
  addNull(_dur?: number) { return this.addKind('null') }
  /** comp.layers.add(footageItem): pending imports land on the timeline when imported */
  add(item: unknown) {
    if (item instanceof PendingFootage) {
      const p = pendingImports.find(x => x.ref === item.ref)
      if (p) p.addToComp = true
      return null
    }
    if (item instanceof FootageItem) {
      hostSession.flush()
      const a = hostSession.doc().assets.find(x => x.id === item.id)
      if (a) void import('@/components/editor/ae/aeActions').then(m => m.addAssetLayer(a))
    }
    return null
  }
  addSolid(_color?: number[], name?: string) { const l = this.addKind('solid'); if (name) l.name = name; return l }
  addText(text?: string) { const l = this.addKind('text'); if (text !== undefined) { const c = wClip(l.clipId) as Clip & { text?: { content: string } }; if (c.text) c.text.content = String(text) } return l }
  addShape() { return this.addKind('shape') }
  addCamera(name?: string) { const l = this.addKind('camera'); if (name) l.name = name; return l }
  addLight() { return this.addKind('null') }
  byName(n: string) { const c = layerOrder(hostSession.doc()).find(c => c.name === n); return c ? wrapLayer(c) : null }
  private addKind(k: 'null' | 'solid' | 'text' | 'shape' | 'camera'): AELayer {
    hostSession.flush()
    const id = newLayer(k)
    if (!id) throw new Error('Could not add layer')
    return wrapLayer(clipOf(id)!)
  }
}
function layerCollection(): LayerCollection {
  const col = new LayerCollection()
  return new Proxy(col, {
    get(t, p, r) {
      if (typeof p === 'string' && /^\d+$/.test(p)) { const c = layerOrder(hostSession.doc())[Number(p) - 1]; return c ? wrapLayer(c) : undefined }
      return Reflect.get(t, p, r)
    },
  })
}

export class CompItem {
  get name() { return hostSession.doc().compName ?? hostSession.doc().name }
  set name(v: string) { hostSession.w().compName = String(v) }
  get id() { return 1 }
  get typeName() { return 'Composition' }
  get width() { return comp().width }
  get height() { return comp().height }
  get pixelAspect() { return 1 }
  get frameRate() { return comp().fps }
  set frameRate(v: number) { hostSession.w().composition.fps = Number(v) }
  get frameDuration() { return 1 / Math.max(1, comp().fps) }
  get duration() { return comp().duration }
  set duration(v: number) { hostSession.w().composition.duration = Number(v) }
  get displayStartTime() { return 0 }
  get time() { return playbackEngine.currentTime }
  set time(t: number) { playbackEngine.seek(Number(t)) }
  get workAreaStart() { return playbackEngine.state.inPoint ?? 0 }
  get workAreaDuration() { return (playbackEngine.state.outPoint ?? comp().duration) - (playbackEngine.state.inPoint ?? 0) }
  get bgColor() { return [0, 0, 0] }
  get motionBlur() { return comp().motionBlur !== false }
  set motionBlur(v: boolean) { hostSession.w().composition.motionBlur = !!v }
  get numLayers() { return layerOrder(hostSession.doc()).length }
  layer(q: number | string | AELayer, rel?: number): AELayer | null {
    const list = layerOrder(hostSession.doc())
    if (q instanceof AELayer) { const i = q.index + (rel ?? 0); const c = list[i - 1]; return c ? wrapLayer(c) : null }
    const c = typeof q === 'number' ? list[q - 1] : list.find(c => c.name === q)
    return c ? wrapLayer(c) : null
  }
  get layers() { return layerCollection() }
  get selectedLayers(): AELayer[] {
    const ids = new Set(S().selectedClipIds.length ? S().selectedClipIds : S().selectedClipId ? [S().selectedClipId!] : [])
    return layerOrder(hostSession.doc()).filter(c => ids.has(c.id)).map(wrapLayer)
  }
  get selectedProperties() {
    const out: (AEProperty | AEPropertyGroup)[] = []
    // AE: properties with selected keys are selected, on any layer
    for (const c of layerOrder(hostSession.doc())) out.push(...wrapLayer(c).selectedProperties)
    return out
  }
  openInViewer() { return null }
  duplicate() { return this }
}
/** Footage a script just imported (real asset arrives when the call returns). */
export class PendingFootage {
  name: string; ref: { meta?: unknown }; parentFolder: unknown = null; label = 0; comment = ''
  constructor(name: string, ref: { meta?: unknown }) { this.name = name; this.ref = ref }
  get typeName() { return 'Footage' }
  get mainSource() { return { file: null, isStill: false } }
}
export class FootageItem {
  constructor(public name: string, public width: number, public height: number, public duration: number, public frameRate: number, public id: string) { }
  get typeName() { return 'Footage' }
}

function projectApi() {
  return {
    get activeItem() { return new CompItem() },
    get numItems() { return hostSession.doc().assets.length + 1 },
    item(i: number) {
      if (i === 1) return new CompItem()
      const a = hostSession.doc().assets[i - 2]
      return a ? new FootageItem(a.name, a.width, a.height, a.duration, a.fps, a.id) : null
    },
    get items() {
      const self = this
      const base = {
        get length() { return self.numItems },
        addFolder: (name: string) => ({ name, typeName: 'Folder', items: [], numItems: 0, parentFolder: null }),
        addComp: (name: string) => { const c = new CompItem(); try { c.name = name } catch { } return c },
      } as Record<string, unknown>
      return new Proxy(base, { get(t, p) { return typeof p === 'string' && /^\d+$/.test(p) ? self.item(Number(p)) : t[p as string] } })
    },
    get file() { return null },
    get selection() { return [] },
    save() { return true },
    /** app.project.importFile(new ImportOptions(file)) — the media is imported after the call */
    importFile(io: { file?: { __file?: File | null; name?: string } } | null) {
      const f = io?.file?.__file
      if (!f) throw new Error('File not found: ' + (io?.file?.name ?? ''))
      const ref: { meta?: unknown } = {}
      pendingImports.push({ file: f, addToComp: false, ref })
      return new PendingFootage(f.name, ref)
    },
    importFileWithDialog() {
      const r = takeDialog(new NeedDialog('open', true, ''))
      if (!r) return null
      return r.filter(x => x.file).map(x => { const ref = {}; pendingImports.push({ file: x.file!, addToComp: false, ref }); return new PendingFootage(x.name, ref) })
    },
    importPlaceholder(name: string) { return new PendingFootage(name, {}) },
    get rootFolder() { return { name: 'Root', numItems: 0, items: [] } },
    activeComp: undefined,
    get bitsPerChannel() { return 8 },
  }
}

// ------------------------------------------------------------------ the scope a script sees

export interface HostCallbacks {
  log: (msg: string) => void
  alert: (msg: string, title?: string) => void
  openWindow?: (w: ScriptUIWindow) => void
  /** the docked panel container for `this` / thisObj (ScriptUI dockable scripts) */
  panel?: ScriptUIWindow | null
}

export function makeScope(cb: HostCallbacks): Record<string, unknown> {
  const settings = new Map<string, string>()
  const ui = makeScriptUI(cb)
  const app = {
    get project() { return projectApi() },
    version: '24.0x99',
    buildName: 'AnimeStudio',
    buildNumber: 1,
    language: 0,
    isWatchFolder: false,
    isRenderEngine: false,
    beginUndoGroup(_n?: string) { /* one commit per call already */ },
    endUndoGroup() { },
    beginSuppressDialogs() { },
    endSuppressDialogs() { },
    executeCommand(_id: number) { },
    findMenuCommandId(_n: string) { return 0 },
    scheduleTask(code: string, delay: number, repeat: boolean) {
      const run = () => { try { (scope.__exec as (c: string) => unknown)(code) } catch { } }
      return repeat ? (setInterval(run, delay) as unknown as number) : (setTimeout(run, delay) as unknown as number)
    },
    cancelTask(id: number) { clearInterval(id); clearTimeout(id) },
    settings: {
      haveSetting: (s: string, k: string) => settings.has(`${s}/${k}`),
      getSetting: (s: string, k: string) => settings.get(`${s}/${k}`) ?? '',
      saveSetting: (s: string, k: string, v: string) => { settings.set(`${s}/${k}`, String(v)) },
    },
    preferences: { getPrefAsLong: () => 0, getPrefAsString: () => '', getPrefAsBool: () => false, savePrefAsLong() { }, savePrefAsString() { }, savePrefAsBool() { }, havePref: () => false },
    purge() { },
    activate() { },
    quit() { },
  }
  const dollar = {
    writeln: (...a: unknown[]) => cb.log(a.map(String).join(' ')),
    write: (...a: unknown[]) => cb.log(a.map(String).join(' ')),
    get global() { return scope },
    os: typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? 'Macintosh OS 14' : 'Windows/64 10',
    version: '4.5.6',
    build: 'AnimeStudio',
    level: 0,
    fileName: '',
    engineName: 'main',
    locale: 'en_US',
    sleep() { },
    gc() { },
    getenv: () => '',
    evalFile: () => { throw new Error('$.evalFile is not available') },
    hiresTimer: 0,
    screens: [{ left: 0, top: 0, right: typeof window !== 'undefined' ? window.innerWidth : 1920, bottom: typeof window !== 'undefined' ? window.innerHeight : 1080 }],
  }
  class FileStub {
    name: string; fsName: string; exists = false; encoding = 'UTF-8'; lineFeed = 'Windows'; eof = true; error = ''
    __file: File | null = null; __text: string | null = null; __buf: string | null = null; __pos = 0; __mode = ''
    constructor(p?: string | PickedFile) {
      if (p && typeof p === 'object') { this.fsName = p.path; this.name = p.name; this.__file = p.file; this.__text = p.text; this.exists = !!p.file }
      else { this.fsName = String(p ?? ''); this.name = this.fsName.split(/[\\/]/).pop() ?? '' }
    }
    get displayName() { return this.name }
    get absoluteURI() { return this.fsName }
    get fullName() { return this.fsName }
    get path() { return this.fsName.split('/').slice(0, -1).join('/') }
    get length() { return this.__file?.size ?? (this.__text?.length ?? 0) }
    get modified() { return new Date(this.__file?.lastModified ?? Date.now()) }
    get created() { return this.modified }
    open(mode = 'r') { this.__mode = String(mode); this.__pos = 0; if (this.__mode.startsWith('w') || this.__mode.startsWith('a')) { this.__buf = this.__mode.startsWith('a') ? (this.__text ?? '') : ''; return true } this.eof = !(this.__text && this.__text.length); return this.__text !== null }
    read(n?: number) { const t = this.__text ?? ''; const out = n === undefined ? t.slice(this.__pos) : t.slice(this.__pos, this.__pos + n); this.__pos += out.length; this.eof = this.__pos >= t.length; return out }
    readln() { const t = this.__text ?? ''; let e = t.indexOf('\n', this.__pos); if (e < 0) e = t.length; const line = t.slice(this.__pos, e).replace(/\r$/, ''); this.__pos = e + 1; this.eof = this.__pos >= t.length; return line }
    write(...a: unknown[]) { if (this.__buf === null) return false; this.__buf += a.map(String).join(''); return true }
    writeln(...a: unknown[]) { return this.write(...a, '\n') }
    close() {
      if (this.__buf !== null && (this.__mode.startsWith('w') || this.__mode.startsWith('a'))) {
        const url = URL.createObjectURL(new Blob([this.__buf], { type: 'text/plain' }))
        const a = document.createElement('a'); a.href = url; a.download = this.name || 'output.txt'; a.click()
        setTimeout(() => URL.revokeObjectURL(url), 4000)
        this.__text = this.__buf; this.__buf = null
      }
      return true
    }
    seek(p: number) { this.__pos = Number(p) || 0; return true }
    tell() { return this.__pos }
    remove() { return false } rename() { return false } copy() { return false } execute() { return false } resolve() { return this }
    getRelativeURI() { return this.fsName }
    openDlg(_t?: string, filter = '', multi = false) { return FileStub.openDialog(_t, filter, multi) }
    saveDlg(_t?: string, _f?: string) { return FileStub.saveDialog(_t, _f, this.name) }
    get parent() { return new FolderStub(this.path) }
    static openDialog(_t?: string, filter: unknown = '', multi: unknown = false) {
      const r = takeDialog(new NeedDialog('open', !!multi, String(filter ?? '')))
      if (!r) return null
      const files = r.map(x => new FileStub(x))
      return multi ? files : files[0]
    }
    static saveDialog(_t?: string, _f?: string, name = '') {
      const r = takeDialog(new NeedDialog('save', false, '', name))
      return r ? new FileStub(r[0]) : null
    }
    static decode(s: string) { return decodeURIComponent(s) }
    static encode(s: string) { return encodeURIComponent(s) }
    static get fs() { return 'Windows' }
  }
  class FolderStub {
    name: string; fsName: string; exists = false; __entries: PickedFile[] = []
    constructor(p?: string | PickedFile) {
      if (p && typeof p === 'object') { this.fsName = p.path; this.name = p.name; this.__entries = p.children ?? []; this.exists = true }
      else { this.fsName = String(p ?? ''); this.name = this.fsName.split(/[\\/]/).pop() ?? '' }
    }
    get displayName() { return this.name }
    get absoluteURI() { return this.fsName }
    get fullName() { return this.fsName }
    get parent() { return new FolderStub(this.fsName.split('/').slice(0, -1).join('/')) }
    /** Direct children (files + sub-folders) of a picked folder; mask like "*.mp4" or a function. */
    getFiles(mask?: unknown) {
      const base = this.fsName.replace(/\/$/, '') + '/'
      const direct = new Map<string, FileStub | FolderStub>()
      for (const e of this.__entries) {
        if (!e.path.startsWith(base)) continue
        const rest = e.path.slice(base.length)
        const seg = rest.split('/')
        if (seg.length === 1) direct.set(rest, new FileStub(e))
        else if (!direct.has(seg[0])) direct.set(seg[0], new FolderStub({ name: seg[0], path: base + seg[0], file: null, text: null, isFolder: true, children: this.__entries }))
      }
      let out = [...direct.values()]
      if (typeof mask === 'function') out = out.filter(f => (mask as (f: unknown) => boolean)(f))
      else if (typeof mask === 'string' && mask && mask !== '*') {
        const res = mask.split(/[;,]/).map(m => new RegExp('^' + m.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'))
        out = out.filter(f => f instanceof FolderStub || res.some(r => r.test(f.name)))
      }
      return out
    }
    create() { return false } execute() { return false } remove() { return false } resolve() { return this }
    selectDlg() { return FolderStub.selectDialog() }
    static get myDocuments() { return new FolderStub('~/Documents') }
    static get desktop() { return new FolderStub('~/Desktop') }
    static get temp() { return new FolderStub('/tmp') }
    static get userData() { return new FolderStub('~/AppData') }
    static get appData() { return new FolderStub('~/AppData') }
    static get current() { return new FolderStub('.') }
    static selectDialog(_t?: string) {
      const r = takeDialog(new NeedDialog('folder', false, ''))
      return r && r[0] ? new FolderStub(r[0]) : null
    }
    static decode(s: string) { return decodeURIComponent(s) }
    static encode(s: string) { return encodeURIComponent(s) }
    static get fs() { return 'Windows' }
  }
  class ImportOptions {
    file: FileStub | null; importAs = 1; sequence = false; forceAlphabetical = false; rangeStart = 0; rangeEnd = 0
    constructor(f?: FileStub) { this.file = f ?? null }
    canImportAs() { return true }
  }
  const scope: Record<string, unknown> = {
    app, $: dollar,
    CompItem, FootageItem, AVLayer, ShapeLayer, TextLayer, CameraLayer, LightLayer, Layer: AELayer,
    Property: AEProperty, PropertyGroup: AEPropertyGroup, PropertyBase: AEProperty, MaskPropertyGroup: AEPropertyGroup,
    PropertyType, PropertyValueType, KeyframeInterpolationType, KeyframeEase,
    BlendingMode: { NORMAL: 5212, ADD: 5220, SCREEN: 5218, MULTIPLY: 5216 }, TrackMatteType: { NO_TRACK_MATTE: 5012, ALPHA: 5013 },
    CloseOptions: { DO_NOT_SAVE_CHANGES: 1, PROMPT_TO_SAVE_CHANGES: 2, SAVE_CHANGES: 3 },
    File: FileStub, Folder: FolderStub, ImportOptions,
    ImportAsType: { COMP_CROPPED_LAYERS: 1, FOOTAGE: 2, COMP: 3, PROJECT: 4 },
    alert: (m: unknown, t?: string) => { if (!dialogPending() && !String(m).includes('__AS_NEEDS_DIALOG__')) cb.alert(String(m), t) },
    confirm: (m: unknown) => (typeof window !== 'undefined' ? window.confirm(String(m)) : false),
    prompt: (m: unknown, d?: string) => (typeof window !== 'undefined' ? window.prompt(String(m), d ?? '') : null),
    system: { callSystem: () => '', osName: 'AnimeStudio', userName: '' },
    isValid: (o: unknown) => !!o,
    timeToCurrentFormat: (t: number, fps: number) => { const f = Math.round(t * fps); const s = Math.floor(f / fps); return `0:00:${String(s % 60).padStart(2, '0')}:${String(f % Math.round(fps)).padStart(2, '0')}` },
    currentFormatToTime: (s: string, fps: number) => { const p = String(s).split(':').map(Number); const fr = p.pop() ?? 0; const sec = p.reverse().reduce((a, v, i) => a + v * Math.pow(60, i), 0); return sec + fr / fps },
    generateRandomNumber: () => Math.random(),
    ...ui,
  }
  return scope
}

// ------------------------------------------------------------------ engine

export interface ScriptEngine {
  /** Run code in the persistent script scope; returns the completion value. */
  exec(code: string): unknown
  scope: Record<string, unknown>
}

/** Strip ExtendScript preprocessor lines (#target, #include, #targetengine…). */
export function preprocess(src: string): string {
  return src.replace(/^\s*#(target|targetengine|include|includepath|script|strict|engine)\b.*$/gm, '')
}

export function createEngine(cb: HostCallbacks): ScriptEngine {
  const scope = makeScope(cb)
  // A sloppy-mode generator keeps ONE variable environment alive: functions
  // declared by the host .jsx stay callable from later evalScript() calls.
  const factory = new Function('__scope', `
    return (function* () {
      var __r, __c;
      with (__scope) {
        while (true) {
          __c = yield __r;
          try { __r = { ok: true, v: eval(__c) }; } catch (e) { __r = { ok: false, e: e }; }
        }
      }
    })();
  `) as (s: Record<string, unknown>) => Generator<unknown, unknown, string>
  const gen = factory(scope)
  gen.next()
  const exec = (code: string) => hostSession.run(() => {
    const r = gen.next(preprocess(code)).value as { ok: boolean; v?: unknown; e?: unknown }
    if (!r.ok) throw r.e
    return r.v
  })
  scope.__exec = exec
  return { exec, scope }
}
