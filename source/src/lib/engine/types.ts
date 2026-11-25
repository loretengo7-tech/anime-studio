/**
 * ANIME STUDIO — Engine Data Model
 *
 * The complete editing document. Everything in the project (composition,
 * tracks, clips, keyframes, effects, speed curves) is represented here.
 * This document is serialized for undo/redo, autosave and server sync.
 */

export type TrackKind = 'video' | 'audio' | 'text' | 'adjustment'
export type ClipKind = 'video' | 'audio' | 'text' | 'adjustment' | 'image' | 'solid' | 'shape' | 'null' | 'camera' | 'precomp'
export type BlendMode =
  | 'normal' | 'add' | 'screen' | 'multiply' | 'overlay' | 'lighten' | 'difference'

export type EasingName =
  | 'linear' | 'hold'
  | 'easeIn' | 'easeOut' | 'easeInOut'
  | 'easeOutBack' | 'easeInBack' | 'easeOutElastic'
  | 'expoOut' | 'expoIn' | 'circOut' | 'bezier'

/** Per-property animation channels on a clip. */
export type TransformProperty =
  | 'x' | 'y' | 'z' | 'scale' | 'rotation' | 'opacity' | 'anchorX' | 'anchorY'

export interface Keyframe {
  id: string
  /** Time in seconds relative to clip start (timeline-local). */
  time: number
  value: number
  easing: EasingName
  /** Bezier control point offsets when easing === 'bezier' (cubic, time/value deltas). */
  handles?: [{ x: number; y: number }, { x: number; y: number }]
}

export interface KeyframeTrack {
  property: string        // TransformProperty or effect param key like "effect:<instanceId>:<param>"
  keyframes: Keyframe[]
}

export interface EffectParamDef {
  key: string
  label: string
  min: number
  max: number
  step: number
  default: number
  /** Rendered as gradient picker etc. — reserved. */
  kind?: 'number' | 'toggle' | 'color'
  /** Shader uniform prefix used by the compositor. */
  uniform: string
}

export interface EffectInstance {
  id: string
  type: string            // EffectDef.type from the registry
  enabled: boolean
  params: Record<string, number>
  /** Keyframes for effect parameters (time is clip-local seconds). */
  paramKeyframes: Record<string, Keyframe[]>
}

export interface EffectDef {
  type: string
  name: string
  category: 'motion' | 'lighting' | 'distortion' | 'color' | 'anime' | 'audio' | 'stylize' | 'generate' | 'perspective' | 'time'
  description: string
  params: EffectParamDef[]
  /** Cost tier — heavy effects warn on low-power devices. */
  heavy?: boolean
  /** Effect pack name (groups the effect in Effects & Presets). */
  pack?: string
  /** When defined, the effect comes from an installed plugin. */
  pluginId?: string
  pluginName?: string
}

export interface MaskPoint {
  x: number  // comp pixels, y-up
  y: number
  /** Bezier handle offsets (same units). Both default to {0,0} (corner). */
  hIn?: { x: number; y: number }
  hOut?: { x: number; y: number }
}

export interface Mask {
  shape: 'rect' | 'ellipse' | 'pen'
  x: number   // normalized -1..1 relative to comp center
  y: number
  width: number  // normalized 0..2
  height: number
  feather: number // 0..1
  invert: boolean
  /** Pen mask vertices (comp pixels, y-up). Closed path. */
  points?: MaskPoint[]
  /** Shape keyframes for pen masks (clip-local seconds). Points count must match `points`. */
  shapeKeyframes?: { time: number; points: MaskPoint[] }[]
}

/**
 * Evaluate a pen mask's vertex list at clip-local time, interpolating
 * per-index between shape keyframes (linear). Falls back to the static shape.
 */
export function evalMaskPoints(mask: Mask, localTime: number): MaskPoint[] {
  const kfs = mask.shapeKeyframes
  if (!kfs || kfs.length === 0 || !mask.points || mask.points.length === 0) return mask.points ?? []
  const sorted = [...kfs].sort((a, b) => a.time - b.time)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (localTime <= first.time) return first.points
  if (localTime >= last.time) return last.points
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1]
    if (localTime >= a.time && localTime <= b.time) {
      const t = (localTime - a.time) / Math.max(1e-6, b.time - a.time)
      const pa = a.points, pb = b.points
      const n = Math.min(pa.length, pb.length)
      const out: MaskPoint[] = []
      for (let j = 0; j < n; j++) {
        const qa = pa[j] ?? a.points[j]
        const qb = pb[j] ?? a.points[j]
        if (!qa || !qb) continue
        out.push({
          x: qa.x + (qb.x - qa.x) * t,
          y: qa.y + (qb.y - qa.y) * t,
          hIn: qa.hIn && qb.hIn ? {
            x: qa.hIn.x + (qb.hIn.x - qa.hIn.x) * t,
            y: qa.hIn.y + (qb.hIn.y - qa.hIn.y) * t,
          } : undefined,
          hOut: qa.hOut && qb.hOut ? {
            x: qa.hOut.x + (qb.hOut.x - qa.hOut.x) * t,
            y: qa.hOut.y + (qb.hOut.y - qa.hOut.y) * t,
          } : undefined,
        })
      }
      return out
    }
  }
  return mask.points
}

/** Simple point-tracking result: per-sample comp-space position. */
export interface TrackPoint {
  time: number
  x: number
  y: number
  confidence: number
}

export interface SpeedCurvePoint {
  /** normalized time within the clip, 0..1 */
  u: number
  /** source-time offset within the used source range, 0..1 */
  v: number
}

export interface TimeRemap {
  /** Piecewise (monotone) source-time mapping. */
  points: SpeedCurvePoint[]
  /** Smooth the curve with Catmull-Rom when sampling. */
  smooth: boolean
  /** Source range that the remap covers, in source seconds. */
  sourceDuration: number
}

/** How a layer is gated by another layer's alpha or luminance (track matte). */
export interface TrackMatte {
  /** Clip that provides the matte (usually the layer above). */
  sourceClipId: string
  mode: 'alpha' | 'alphaInv' | 'luma' | 'lumaInv'
}

interface ClipBase {
  id: string
  trackId: string
  kind: ClipKind
  name: string
  start: number
  duration: number
  effects: EffectInstance[]
  blendMode: BlendMode
  /** Static fallback values when no keyframes exist. */
  x: number
  y: number
  /** 3D depth in comp units (used when threeD is enabled). */
  z: number
  scale: number
  rotation: number
  opacity: number
  anchorX: number
  anchorY: number
  keyframes: KeyframeTrack[]
  mask: Mask | null
  /** Constant speed multiplier (ignored when timeRemap present). */
  speed: number
  timeRemap: TimeRemap | null
  reverse: boolean
  /** Parent layer: this layer inherits the parent's transform (AE parenting). */
  parentId: string | null
  /** Layer lives in 3D space (z + camera projection). */
  threeD: boolean
  /** Track matte gating (AE track mattes). */
  trackMatte: TrackMatte | null
  /** AE layer switches (optional — older projects omit them). */
  hidden?: boolean
  solo?: boolean
  muted?: boolean
  locked?: boolean
  shy?: boolean
  /** AE label color index (see LABEL_COLORS). */
  label?: number
  /** AE motion blur switch (needs the comp's motion blur enabled too). */
  motionBlur?: boolean
  /**
   * AE-style expressions per transform group: 'position' | 'scale' | 'rotation' |
   * 'opacity' | 'anchor'. Evaluated in evalProperty (see expressions.ts).
   */
  expressions?: Record<string, string>
}

/** After-Effects-style label palette (index → color). */
export const LABEL_COLORS: { name: string; color: string }[] = [
  { name: 'None', color: '#6b6b6b' },
  { name: 'Red', color: '#b53838' },
  { name: 'Yellow', color: '#e4d84c' },
  { name: 'Aqua', color: '#a9cbc7' },
  { name: 'Pink', color: '#e5bcc9' },
  { name: 'Lavender', color: '#a9a9ca' },
  { name: 'Peach', color: '#e7c19e' },
  { name: 'Sea Foam', color: '#b3c7b3' },
  { name: 'Blue', color: '#677de0' },
  { name: 'Green', color: '#4aa44c' },
  { name: 'Purple', color: '#8e2c9a' },
  { name: 'Orange', color: '#e8920d' },
  { name: 'Brown', color: '#7f452a' },
  { name: 'Fuchsia', color: '#f46dd6' },
  { name: 'Cyan', color: '#3da2a5' },
  { name: 'Sandstone', color: '#a89677' },
  { name: 'Dark Green', color: '#1e401e' },
]

/** Default label per layer kind (mirrors AE's defaults loosely). */
export function defaultLabel(kind: ClipKind): number {
  switch (kind) {
    case 'video': return 3
    case 'image': return 5
    case 'audio': return 7
    case 'text': return 1
    case 'solid': return 1
    case 'shape': return 8
    case 'null': return 1
    case 'camera': return 4
    case 'adjustment': return 15
    default: return 0
  }
}

export interface VideoClip extends ClipBase {
  kind: 'video'
  assetId: string
  /** Source in-point in seconds. */
  inPoint: number
  /** Cached motion-tracking data (comp-space positions). */
  tracking: TrackPoint[] | null
  trackingTarget: string | null // property to drive, e.g. "x,y"
}

export interface AudioClip extends ClipBase {
  kind: 'audio'
  assetId: string
  inPoint: number
  fadeIn: number
  fadeOut: number
  /** Static volume 0..2 (keyframable via keyframes property "volume"). */
  volume: number
}

export interface TextClip extends ClipBase {
  kind: 'text'
  text: {
    content: string
    font: string
    size: number
    color: string
    strokeColor: string
    strokeWidth: number
    weight: number
    align: 'left' | 'center' | 'right'
    letterSpacing: number
    shadow: boolean
    /** Shadow customization — optional for backward compatibility with old projects. */
    shadowColor?: string
    shadowBlur?: number
    shadowOffsetX?: number
    shadowOffsetY?: number
    /** Two-color gradient fill over the text block. Optional (off by default). */
    gradient?: { enabled: boolean; color2: string; angle: number }
    /** Per-character stagger as a fraction of animationDuration (0 = whole block together). */
    stagger?: number
    animation:
      | 'none' | 'fadeIn' | 'slideUp' | 'slideLeft' | 'pop' | 'zoomIn'
      | 'typewriter' | 'shake' | 'karaoke' | 'bounce' | 'wave'
      | 'trackingIn' | 'rotateIn' | 'blurIn'
    animationDuration: number
  }
}

export interface AdjustmentClip extends ClipBase {
  kind: 'adjustment'
  /** How many layers below this one are affected (0 = all below). */
  affectCount: number
}

export interface ImageClip extends ClipBase {
  kind: 'image'
  assetId: string
}

/** Procedural color layer (AE Solid). */
export interface SolidClip extends ClipBase {
  kind: 'solid'
  color: string
}

/** Vector shape layer drawn procedurally (AE Shape layer). */
export interface ShapeClip extends ClipBase {
  kind: 'shape'
  shape: { type: 'rect' | 'ellipse' | 'polygon'; sides?: number; width: number; height: number; fill: string; stroke: string; strokeWidth: number; cornerRadius: number }
}

/** Invisible controller layer for parenting (AE Null Object). Never rendered. */
export interface NullClip extends ClipBase {
  kind: 'null'
}

export interface CameraSettings {
  positionX: number
  positionY: number
  positionZ: number
  rotationX: number
  rotationY: number
  rotationZ: number
  /** Focal length in comp px — smaller = wider FOV. */
  focalLength: number
  zoom: number
  /** Depth of field (0 = off). */
  depthOfField: number
  aperture: number
  focusDistance: number
}

/** 3D camera layer driving all threeD-enabled layers under it. */
export interface CameraClip extends ClipBase {
  kind: 'camera'
  camera: CameraSettings
}

/** A nested composition used as a layer (AE pre-comp). */
export interface PrecompClip extends ClipBase {
  kind: 'precomp'
  precompId: string
}

export type Clip = VideoClip | AudioClip | TextClip | AdjustmentClip | ImageClip | SolidClip | ShapeClip | NullClip | CameraClip | PrecompClip

/** Stored nested composition. The open comp lives in ProjectDoc.composition/tracks/clips. */
export interface Precomp {
  id: string
  name: string
  composition: Composition
  tracks: Track[]
  clips: Clip[]
}

export interface Track {
  id: string
  kind: TrackKind
  name: string
  locked: boolean
  visible: boolean
  muted: boolean
  height: number
}

export interface Composition {
  width: number
  height: number
  fps: number
  duration: number
  background: string
  /** AE "Enable Motion Blur" for all layers with the switch on (default on). */
  motionBlur?: boolean
  /** Shutter angle in degrees (AE default 180). */
  shutterAngle?: number
}

export interface AssetMeta {
  id: string
  name: string
  kind: 'video' | 'audio' | 'image'
  url: string        // server media URL
  proxyUrl?: string
  duration: number
  width: number
  height: number
  fps: number
  size: number
  /** Downscaled thumbnails (data URLs) for timeline clips. */
  thumbnails?: string[]
  /** Audio peaks for waveform rendering, normalized -1..1. */
  peaks?: number[]
}

export interface Marker {
  id: string
  time: number
  label: string
  color: string
}

export interface AIMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  ops?: AIOperation[]
  mode?: 'auto' | 'preview'
  createdAt: number
  status?: 'ok' | 'error' | 'pending' | 'preview'
  error?: string
}

export interface ProjectDoc {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  composition: Composition
  tracks: Track[]
  clips: Clip[]
  assets: AssetMeta[]
  markers: Marker[]
  beats: number[]
  bpm: number
  aiHistory: AIMessage[]
  version: number
  /** Nested compositions (pre-comps), including the root comp while a pre-comp is open. */
  precomps?: Precomp[]
  /** Id/name of the comp currently open in composition/tracks/clips ('main' = root). */
  compId?: string
  compName?: string
  /** Breadcrumb of comps entered (ids), root first. */
  compStack?: string[]
}

/** Preview-mode state: AI ops applied to a draft that the user approves or rejects. */
export interface PreviewState {
  ops: AIOperation[]
  draft: ProjectDoc
  description: string
  createdAt: number
}

// ---------------------------------------------------------------------------
// AI operations — the structured contract between the assistant and the engine
// ---------------------------------------------------------------------------

export type AIOperation =
  | { op: 'apply_effect'; clipId: string; effect: string; params?: Record<string, number>; paramKeyframes?: Record<string, { time: number; value: number; easing?: EasingName }[]> }
  | { op: 'remove_effect'; clipId: string; effectInstanceId?: string; effectType?: string }
  | { op: 'add_keyframes'; clipId: string; property: string; keyframes: { time: number; value: number; easing?: EasingName }[] }
  | { op: 'clear_property_keyframes'; clipId: string; property: string }
  | { op: 'set_transform'; clipId: string; x?: number; y?: number; scale?: number; rotation?: number; opacity?: number }
  | { op: 'set_speed'; clipId: string; speed: number }
  | { op: 'apply_velocity_preset'; clipId: string; preset: string; intensity?: number }
  | { op: 'set_time_remap'; clipId: string; points: SpeedCurvePoint[]; smooth?: boolean }
  | { op: 'apply_color_preset'; clipId: string; preset: string; intensity?: number }
  | { op: 'add_text'; text: string; start: number; duration: number; size?: number; color?: string; animation?: string; x?: number; y?: number; trackId?: string }
  | { op: 'move_clip'; clipId: string; start?: number; trackId?: string }
  | { op: 'trim_clip'; clipId: string; start?: number; duration?: number; inPoint?: number }
  | { op: 'split_clip'; clipId: string; atTime: number }
  | { op: 'duplicate_clip'; clipId: string; offset?: number }
  | { op: 'delete_clip'; clipId: string }
  | { op: 'add_transition'; clipAId: string; clipBId: string; type: string; duration: number }
  | { op: 'set_comp'; width?: number; height?: number; fps?: number; duration?: number; background?: string }
  | { op: 'sync_effects_to_beats'; clipId: string; effect: string; params?: Record<string, number>; offset?: number; everyNBeats?: number }
  | { op: 'camera_move'; clipId: string; type: string; duration?: number; intensity?: number; startAt?: number }
  | { op: 'impact_shake'; clipId: string; atTime: number; intensity?: number; duration?: number }
  | { op: 'motion_blur_from_motion'; clipId: string; shutterScale?: number }
  | { op: 'attach_tracking'; clipId: string; targetClipId: string; startTime: number; duration: number; offsetX?: number; offsetY?: number }
  | { op: 'add_marker'; time: number; label?: string; color?: string }

export interface AIResponse {
  reply: string
  operations: AIOperation[]
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

let uidCounter = 0
export function uid(prefix = 'id'): string {
  uidCounter += 1
  return `${prefix}_${Date.now().toString(36)}${uidCounter.toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

export function createDefaultProject(name = 'Untitled Project'): ProjectDoc {
  const now = Date.now()
  return {
    id: uid('proj'),
    name,
    createdAt: now,
    updatedAt: now,
    composition: { width: 1920, height: 1080, fps: 30, duration: 30, background: '#000000' },
    tracks: [
      { id: 'track_text', kind: 'text', name: 'Text', locked: false, visible: true, muted: false, height: 44 },
      { id: 'track_v2', kind: 'video', name: 'Video 2', locked: false, visible: true, muted: false, height: 64 },
      { id: 'track_v1', kind: 'video', name: 'Video 1', locked: false, visible: true, muted: false, height: 64 },
      { id: 'track_adj', kind: 'adjustment', name: 'Adjustment', locked: false, visible: true, muted: false, height: 36 },
      { id: 'track_a1', kind: 'audio', name: 'Audio 1', locked: false, visible: true, muted: false, height: 56 },
    ],
    clips: [],
    assets: [],
    markers: [],
    beats: [],
    bpm: 0,
    aiHistory: [],
    version: 1,
  }
}

export function projectDuration(doc: ProjectDoc): number {
  let end = doc.composition.duration
  for (const c of doc.clips) end = Math.max(end, c.start + c.duration)
  return end
}

/** Common defaults every new layer starts with (AE-like neutral transform). */
export function makeClipBase(trackId: string, name: string, start: number, duration: number): Omit<ClipBase, 'kind'> {
  return {
    id: uid('clip'),
    trackId,
    name,
    start,
    duration,
    effects: [],
    blendMode: 'normal',
    x: 0, y: 0, z: 0,
    scale: 1,
    rotation: 0,
    opacity: 1,
    anchorX: 0, anchorY: 0,
    keyframes: [],
    mask: null,
    speed: 1,
    timeRemap: null,
    reverse: false,
    parentId: null,
    threeD: false,
    trackMatte: null,
  }
}

export function makeSolidClip(trackId: string, start: number, duration: number, color = '#ffffff'): SolidClip {
  return { ...makeClipBase(trackId, 'Solid', start, duration), kind: 'solid', color }
}

export function makeShapeClip(trackId: string, start: number, duration: number, compW: number, compH: number): ShapeClip {
  const w = Math.round(compW * 0.4), h = Math.round(compH * 0.4)
  return {
    ...makeClipBase(trackId, 'Shape', start, duration), kind: 'shape',
    shape: { type: 'rect', width: w, height: h, fill: '#f5f5f4', stroke: '#a1a1aa', strokeWidth: 0, cornerRadius: 0 },
  }
}

export function makeNullClip(trackId: string, start: number, duration: number): NullClip {
  return { ...makeClipBase(trackId, 'Null', start, duration), kind: 'null' }
}

export function makeCameraClip(trackId: string, start: number, duration: number, compH: number): CameraClip {
  return {
    ...makeClipBase(trackId, 'Camera', start, duration), kind: 'camera',
    camera: {
      positionX: 0, positionY: 0, positionZ: -compH,
      rotationX: 0, rotationY: 0, rotationZ: 0,
      focalLength: Math.round(compH * 1.2), zoom: 1,
      depthOfField: 0, aperture: 0.4, focusDistance: compH,
    },
  }
}
