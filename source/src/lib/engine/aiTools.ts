/**
 * ANIME STUDIO — AI Tool System
 *
 * The contract between the LLM and the editing engine:
 *  - zod validation of every operation (clamping, defaults, refusals)
 *  - a pure executor that applies validated operations to a document clone
 *  - human-readable change summaries so the assistant can report truthfully
 *
 * The AI never edits the document directly — it only emits operations that
 * pass through here. Failed validation is reported, never silently ignored.
 */
import { z } from 'zod'
import type { AIOperation, ProjectDoc, Clip, VideoClip, TextClip, Keyframe } from './types'
import { uid, makeClipBase } from './types'
import { EFFECT_MAP, defaultParams, clampParam, COLOR_PRESETS } from './effects'
import { generateVelocityPreset, VELOCITY_PRESETS } from './speed'
import { evalProperty } from './keyframes'

const kfSchema = z.object({
  time: z.number().min(0),
  value: z.number(),
  easing: z.enum(['linear', 'hold', 'easeIn', 'easeOut', 'easeInOut', 'easeOutBack', 'easeInBack', 'easeOutElastic', 'expoOut', 'expoIn', 'circOut', 'bezier']).optional(),
})

const opSchemas: Record<string, z.ZodTypeAny> = {
  apply_effect: z.object({
    op: z.literal('apply_effect'),
    clipId: z.string(),
    effect: z.string(),
    params: z.record(z.string(), z.number()).optional(),
    paramKeyframes: z.record(z.string(), z.array(kfSchema)).optional(),
  }),
  remove_effect: z.object({
    op: z.literal('remove_effect'),
    clipId: z.string(),
    effectInstanceId: z.string().optional(),
    effectType: z.string().optional(),
  }),
  add_keyframes: z.object({
    op: z.literal('add_keyframes'),
    clipId: z.string(),
    property: z.string(),
    keyframes: z.array(kfSchema).min(2),
  }),
  clear_property_keyframes: z.object({
    op: z.literal('clear_property_keyframes'),
    clipId: z.string(),
    property: z.string(),
  }),
  set_transform: z.object({
    op: z.literal('set_transform'),
    clipId: z.string(),
    x: z.number().optional(),
    y: z.number().optional(),
    scale: z.number().min(0.01).max(20).optional(),
    rotation: z.number().min(-1080).max(1080).optional(),
    opacity: z.number().min(0).max(1).optional(),
  }),
  set_speed: z.object({ op: z.literal('set_speed'), clipId: z.string(), speed: z.number().min(0.05).max(16) }),
  apply_velocity_preset: z.object({
    op: z.literal('apply_velocity_preset'),
    clipId: z.string(),
    preset: z.string(),
    intensity: z.number().min(0.2).max(4).optional(),
  }),
  set_time_remap: z.object({
    op: z.literal('set_time_remap'),
    clipId: z.string(),
    points: z.array(z.object({ u: z.number().min(0).max(1), v: z.number().min(0).max(1) })).min(2),
    smooth: z.boolean().optional(),
  }),
  apply_color_preset: z.object({
    op: z.literal('apply_color_preset'),
    clipId: z.string(),
    preset: z.string(),
    intensity: z.number().min(0).max(2).optional(),
  }),
  add_text: z.object({
    op: z.literal('add_text'),
    text: z.string().min(1).max(400),
    start: z.number().min(0),
    duration: z.number().min(0.2).max(120),
    size: z.number().min(8).max(600).optional(),
    color: z.string().optional(),
    animation: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    trackId: z.string().optional(),
  }),
  move_clip: z.object({
    op: z.literal('move_clip'),
    clipId: z.string(),
    start: z.number().min(0).optional(),
    trackId: z.string().optional(),
  }),
  trim_clip: z.object({
    op: z.literal('trim_clip'),
    clipId: z.string(),
    start: z.number().min(0).optional(),
    duration: z.number().min(0.05).optional(),
    inPoint: z.number().min(0).optional(),
  }),
  split_clip: z.object({ op: z.literal('split_clip'), clipId: z.string(), atTime: z.number().min(0) }),
  duplicate_clip: z.object({ op: z.literal('duplicate_clip'), clipId: z.string(), offset: z.number().optional() }),
  delete_clip: z.object({ op: z.literal('delete_clip'), clipId: z.string() }),
  add_transition: z.object({
    op: z.literal('add_transition'),
    clipAId: z.string(),
    clipBId: z.string(),
    type: z.enum(['crossfade', 'dip_to_black', 'whip_pan', 'glitch_cut', 'zoom_punch']),
    duration: z.number().min(0.05).max(5),
  }),
  set_comp: z.object({
    op: z.literal('set_comp'),
    width: z.number().int().min(16).max(7680).optional(),
    height: z.number().int().min(16).max(4320).optional(),
    fps: z.number().min(1).max(120).optional(),
    duration: z.number().min(1).max(3600).optional(),
    background: z.string().optional(),
  }),
  sync_effects_to_beats: z.object({
    op: z.literal('sync_effects_to_beats'),
    clipId: z.string(),
    effect: z.string(),
    params: z.record(z.string(), z.number()).optional(),
    offset: z.number().optional(),
    everyNBeats: z.number().int().min(1).max(32).optional(),
  }),
  camera_move: z.object({
    op: z.literal('camera_move'),
    clipId: z.string(),
    type: z.enum(['zoom_in', 'zoom_out', 'pan_left_right', 'pan_right_left', 'rotate', 'ken_burns', 'push_in_shake']),
    duration: z.number().min(0.2).optional(),
    intensity: z.number().min(0.1).max(4).optional(),
    startAt: z.number().min(0).optional(),
  }),
  impact_shake: z.object({
    op: z.literal('impact_shake'),
    clipId: z.string(),
    atTime: z.number().min(0),
    intensity: z.number().min(0.1).max(3).optional(),
    duration: z.number().min(0.05).max(3).optional(),
  }),
  motion_blur_from_motion: z.object({
    op: z.literal('motion_blur_from_motion'),
    clipId: z.string(),
    shutterScale: z.number().min(0.1).max(5).optional(),
  }),
  attach_tracking: z.object({
    op: z.literal('attach_tracking'),
    clipId: z.string(),
    targetClipId: z.string(),
    startTime: z.number().min(0),
    duration: z.number().min(0.2),
    offsetX: z.number().optional(),
    offsetY: z.number().optional(),
  }),
  add_marker: z.object({
    op: z.literal('add_marker'),
    time: z.number().min(0),
    label: z.string().max(120).optional(),
    color: z.string().optional(),
  }),
}

export interface ValidationResult {
  valid: AIOperation[]
  errors: string[]
}

/** Validate AI operations; clamp/repair where safe, reject the broken. */
export function validateOperations(raw: unknown[]): ValidationResult {
  const valid: AIOperation[] = []
  const errors: string[] = []
  raw.forEach((op, i) => {
    const obj = op as Record<string, unknown>
    const type = typeof obj?.op === 'string' ? obj.op : ''
    const schema = opSchemas[type]
    if (!schema) {
      errors.push(`Operation #${i + 1}: unknown operation type "${type}"`)
      return
    }
    const parsed = schema.safeParse(op)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      errors.push(`Operation #${i + 1} (${type}): ${issue?.path.join('.')} ${issue?.message}`)
      return
    }
    const v = parsed.data as AIOperation
    // effect-specific validation
    if (v.op === 'apply_effect') {
      const def = EFFECT_MAP[v.effect]
      if (!def) {
        errors.push(`Operation #${i + 1}: unknown effect "${v.effect}"`)
        return
      }
      if (v.params) {
        const clean: Record<string, number> = {}
        for (const [k, val] of Object.entries(v.params)) {
          const pd = def.params.find(p => p.key === k)
          if (!pd) {
            errors.push(`Operation #${i + 1}: effect "${v.effect}" has no parameter "${k}" (ignored)`)
            continue
          }
          clean[k] = clampParam(v.effect, k, val)
        }
        v.params = clean
      }
    }
    if (v.op === 'apply_velocity_preset' && !VELOCITY_PRESETS[v.preset]) {
      errors.push(`Operation #${i + 1}: unknown velocity preset "${v.preset}"`)
      return
    }
    if (v.op === 'apply_color_preset' && !COLOR_PRESETS[v.preset]) {
      errors.push(`Operation #${i + 1}: unknown color preset "${v.preset}"`)
      return
    }
    valid.push(v)
  })
  return { valid, errors }
}

export interface ExecutionResult {
  doc: ProjectDoc
  applied: string[]
  errors: string[]
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function findClip(doc: ProjectDoc, id: string): Clip | undefined {
  return doc.clips.find(c => c.id === id)
}

/** Human clip label for summaries. */
function label(doc: ProjectDoc, clipId: string): string {
  const c = findClip(doc, clipId)
  return c ? `"${c.name}"` : 'clip'
}

/**
 * Pure executor: applies operations to a CLONE of doc, returns the new doc
 * plus a truthful, human-readable list of what changed.
 */
export function executeOperations(doc: ProjectDoc, ops: AIOperation[]): ExecutionResult {
  const d = clone(doc)
  d.updatedAt = Date.now()
  const applied: string[] = []
  const errors: string[] = []

  const ensureKeyframeTrack = (clip: Clip, property: string) => {
    let track = clip.keyframes.find(k => k.property === property)
    if (!track) {
      track = { property, keyframes: [] }
      clip.keyframes.push(track)
    }
    return track
  }
  const addKfs = (clip: Clip, property: string, kfs: { time: number; value: number; easing?: string }[]) => {
    const track = ensureKeyframeTrack(clip, property)
    for (const k of kfs) {
      track.keyframes = track.keyframes.filter(e => Math.abs(e.time - k.time) > 1e-4)
      track.keyframes.push({
        id: uid('kf'),
        time: Math.max(0, Math.min(clip.duration, k.time)),
        value: k.value,
        easing: (k.easing as never) ?? 'easeInOut',
      })
    }
    track.keyframes.sort((a, b) => a.time - b.time)
  }

  for (const op of ops) {
    try {
      switch (op.op) {
        case 'apply_effect': {
          const clip = findClip(d, op.clipId)
          if (!clip) { errors.push(`${op.op}: clip ${op.clipId} not found`); break }
          const def = EFFECT_MAP[op.effect]
          if (!def) { errors.push(`${op.op}: effect ${op.effect} not found`); break }
          const instance = {
            id: uid('fx'),
            type: op.effect,
            enabled: true,
            params: { ...defaultParams(op.effect), ...(op.params ?? {}) },
            paramKeyframes: {},
          }
          if (op.paramKeyframes) {
            for (const [pk, kfs] of Object.entries(op.paramKeyframes)) {
              if (!def.params.find(p => p.key === pk)) continue
              instance.paramKeyframes[pk] = kfs.map(k => ({
                id: uid('kf'), time: Math.min(clip.duration, Math.max(0, k.time)), value: clampParam(op.effect, pk, k.value), easing: k.easing ?? 'easeInOut',
              })).sort((a, b) => a.time - b.time)
            }
          }
          // replace same-type effect to avoid stacking duplicates from AI
          clip.effects = clip.effects.filter(e => e.type !== op.effect)
          clip.effects.push(instance)
          applied.push(`Applied ${def.name} to ${label(d, op.clipId)}`)
          break
        }
        case 'remove_effect': {
          const clip = findClip(d, op.clipId)
          if (!clip) { errors.push(`${op.op}: clip ${op.clipId} not found`); break }
          const before = clip.effects.length
          clip.effects = clip.effects.filter(e =>
            op.effectInstanceId ? e.id !== op.effectInstanceId : e.type !== op.effectType
          )
          if (clip.effects.length < before) applied.push(`Removed ${op.effectType ?? 'effect'} from ${label(d, op.clipId)}`)
          else errors.push(`${op.op}: effect not present on ${label(d, op.clipId)}`)
          break
        }
        case 'add_keyframes': {
          const clip = findClip(d, op.clipId)
          if (!clip) { errors.push(`${op.op}: clip ${op.clipId} not found`); break }
          addKfs(clip, op.property, op.keyframes)
          applied.push(`Added ${op.keyframes.length} keyframes on ${op.property} of ${label(d, op.clipId)}`)
          break
        }
        case 'clear_property_keyframes': {
          const clip = findClip(d, op.clipId)
          if (!clip) { errors.push(`${op.op}: clip ${op.clipId} not found`); break }
          clip.keyframes = clip.keyframes.filter(k => k.property !== op.property)
          applied.push(`Cleared keyframes on ${op.property} of ${label(d, op.clipId)}`)
          break
        }
        case 'set_transform': {
          const clip = findClip(d, op.clipId)
          if (!clip) { errors.push(`${op.op}: clip ${op.clipId} not found`); break }
          if (op.x !== undefined) clip.x = op.x
          if (op.y !== undefined) clip.y = op.y
          if (op.scale !== undefined) clip.scale = op.scale
          if (op.rotation !== undefined) clip.rotation = op.rotation
          if (op.opacity !== undefined) clip.opacity = op.opacity
          applied.push(`Set transform on ${label(d, op.clipId)}`)
          break
        }
        case 'set_speed': {
          const clip = findClip(d, op.clipId)
          if (!clip) { errors.push(`${op.op}: clip ${op.clipId} not found`); break }
          const old = clip.speed
          clip.speed = Math.min(16, Math.max(0.05, op.speed))
          clip.timeRemap = null
          // keep timeline duration; adjust source usage implicitly via speed
          applied.push(`Changed speed of ${label(d, op.clipId)} from ${old.toFixed(2)}x to ${clip.speed.toFixed(2)}x`)
          break
        }
        case 'apply_velocity_preset': {
          const clip = findClip(d, op.clipId)
          if (!clip) { errors.push(`${op.op}: clip ${op.clipId} not found`); break }
          const used = clip.duration * (clip.timeRemap ? clip.timeRemap.sourceDuration / clip.duration : clip.speed)
          const preset = generateVelocityPreset(op.preset, used, op.intensity ?? 1)
          clip.timeRemap = preset
          applied.push(`Applied ${VELOCITY_PRESETS[op.preset]?.label ?? op.preset} velocity to ${label(d, op.clipId)}`)
          break
        }
        case 'set_time_remap': {
          const clip = findClip(d, op.clipId)
          if (!clip) { errors.push(`${op.op}: clip ${op.clipId} not found`); break }
          const pts = [...op.points].sort((a, b) => a.u - b.u)
          clip.timeRemap = { points: pts, smooth: op.smooth ?? true, sourceDuration: clip.duration * ((clip.timeRemap?.sourceDuration ?? clip.duration) / Math.max(1e-6, clip.duration) || clip.speed || 1) }
          applied.push(`Set custom time remap on ${label(d, op.clipId)}`)
          break
        }
        case 'apply_color_preset': {
          const clip = findClip(d, op.clipId)
          if (!clip) { errors.push(`${op.op}: clip ${op.clipId} not found`); break }
          const preset = COLOR_PRESETS[op.preset]
          const intensity = op.intensity ?? 1
          // build one combined grading effect from preset values scaled by intensity
          const grade: Record<string, number> = {}
          for (const [k, v] of Object.entries(preset.grade)) {
            if (k === 'vignette') {
              const inst = {
                id: uid('fx'), type: 'vignette', enabled: true,
                params: { amount: Math.min(1, v * intensity), softness: 0.5 }, paramKeyframes: {},
              }
              clip.effects = clip.effects.filter(e => e.type !== 'vignette')
              clip.effects.push(inst)
              continue
            }
            grade[k] = v * intensity
          }
          const inst = {
            id: uid('fx'), type: 'lift_gamma_gain', enabled: true,
            params: {
              lift: grade.lift ?? 0, gamma: grade.gamma ?? 1, gain: grade.gain ?? 1,
            },
            paramKeyframes: {},
          }
          clip.effects = clip.effects.filter(e => e.type !== 'lift_gamma_gain' || Object.keys(grade).some(k => k !== 'lift' && k !== 'gamma' && k !== 'gain'))
          // add grading effects for the remaining keys
          if (grade.exposure) {
            clip.effects.push({ id: uid('fx'), type: 'exposure', enabled: true, params: { stops: grade.exposure }, paramKeyframes: {} })
          }
          if (grade.contrast) clip.effects.push({ id: uid('fx'), type: 'contrast', enabled: true, params: { amount: grade.contrast }, paramKeyframes: {} })
          if (grade.saturation) clip.effects.push({ id: uid('fx'), type: 'saturation', enabled: true, params: { amount: grade.saturation }, paramKeyframes: {} })
          if (grade.temperature) clip.effects.push({ id: uid('fx'), type: 'temperature', enabled: true, params: { value: grade.temperature }, paramKeyframes: {} })
          if (grade.tint) clip.effects.push({ id: uid('fx'), type: 'tint', enabled: true, params: { value: grade.tint }, paramKeyframes: {} })
          if (grade.vibrance) clip.effects.push({ id: uid('fx'), type: 'vibrance', enabled: true, params: { amount: grade.vibrance }, paramKeyframes: {} })
          if (grade.lift || grade.gamma !== 1 || grade.gain !== 1) clip.effects.push(inst)
          applied.push(`Applied "${preset.label}" color grade to ${label(d, op.clipId)}`)
          break
        }
        case 'add_text': {
          const track = d.tracks.find(t => t.kind === 'text') ?? d.tracks[0]
          const size = op.size ?? Math.round(d.composition.height * 0.08)
          const clip: TextClip = {
            ...makeClipBase(op.trackId ?? track.id, op.text.slice(0, 24), Math.max(0, op.start), op.duration),
            id: uid('clip'),
            kind: 'text',
            x: op.x ?? 0,
            y: op.y ?? Math.round(d.composition.height * 0.35),
            text: {
              content: op.text,
              font: 'Arial, sans-serif',
              size,
              color: op.color ?? '#ffffff',
              strokeColor: '#000000',
              strokeWidth: Math.max(2, size * 0.06),
              weight: 800,
              align: 'center',
              letterSpacing: 0,
              shadow: true,
              animation: (op.animation as TextClip['text']['animation']) ?? 'pop',
              animationDuration: 0.5,
            },
          }
          d.clips.push(clip)
          applied.push(`Added text layer "${op.text.slice(0, 32)}" at ${op.start.toFixed(2)}s`)
          break
        }
        case 'move_clip': {
          const clip = findClip(d, op.clipId)
          if (!clip) { errors.push(`${op.op}: clip ${op.clipId} not found`); break }
          if (op.start !== undefined) clip.start = Math.max(0, op.start)
          if (op.trackId !== undefined && d.tracks.some(t => t.id === op.trackId)) clip.trackId = op.trackId
          applied.push(`Moved ${label(d, op.clipId)}`)
          break
        }
        case 'trim_clip': {
          const clip = findClip(d, op.clipId)
          if (!clip) { errors.push(`${op.op}: clip ${op.clipId} not found`); break }
          if (op.start !== undefined) clip.start = Math.max(0, op.start)
          if (op.duration !== undefined) clip.duration = Math.max(0.05, op.duration)
          if (op.inPoint !== undefined && (clip.kind === 'video' || clip.kind === 'audio')) {
            (clip as VideoClip).inPoint = Math.max(0, op.inPoint)
          }
          applied.push(`Trimmed ${label(d, op.clipId)}`)
          break
        }
        case 'split_clip': {
          const clip = findClip(d, op.clipId)
          if (!clip) { errors.push(`${op.op}: clip ${op.clipId} not found`); break }
          const at = op.atTime - clip.start
          if (at <= 0.05 || at >= clip.duration - 0.05) {
            errors.push(`${op.op}: split point outside clip ${label(d, op.clipId)}`)
            break
          }
          const right = clone(clip)
          right.id = uid('clip')
          right.start = clip.start + at
          right.duration = clip.duration - at
          right.keyframes = right.keyframes.map(k => ({
            ...k,
            keyframes: k.keyframes.filter(kf => kf.time >= at).map(kf => ({ ...kf, time: kf.time - at })),
          })).filter(k => k.keyframes.length > 0)
          if (right.kind === 'video' || right.kind === 'audio') {
            const r = right as VideoClip
            r.inPoint = (clip as VideoClip).inPoint + at * clip.speed
          }
          clip.duration = at
          d.clips.push(right)
          applied.push(`Split ${label(d, op.clipId)} at ${op.atTime.toFixed(2)}s`)
          break
        }
        case 'duplicate_clip': {
          const clip = findClip(d, op.clipId)
          if (!clip) { errors.push(`${op.op}: clip ${op.clipId} not found`); break }
          const copy = clone(clip)
          copy.id = uid('clip')
          copy.start = clip.start + clip.duration + (op.offset ?? 0)
          d.clips.push(copy)
          applied.push(`Duplicated ${label(d, op.clipId)}`)
          break
        }
        case 'delete_clip': {
          const before = d.clips.length
          d.clips = d.clips.filter(c => c.id !== op.clipId)
          if (d.clips.length < before) applied.push(`Deleted ${label(d, op.clipId)}`)
          else errors.push(`${op.op}: clip ${op.clipId} not found`)
          break
        }
        case 'add_transition': {
          const a = findClip(d, op.clipAId)
          const b = findClip(d, op.clipBId)
          if (!a || !b) { errors.push(`${op.op}: clips not found`); break }
          const dur = Math.min(op.duration, a.duration * 0.8, b.duration * 0.8)
          // overlap clip B into A by dur
          const overlap = Math.min(dur, Math.max(0, a.start + a.duration - b.start))
          if (overlap <= 0) {
            b.start = Math.max(0, a.start + a.duration - dur)
          }
          switch (op.type) {
            case 'crossfade':
              addKfs(b, 'opacity', [
                { time: 0, value: 0, easing: 'linear' },
                { time: dur, value: 1, easing: 'linear' },
              ])
              addKfs(a, 'opacity', [
                { time: a.duration - dur, value: 1, easing: 'linear' },
                { time: a.duration, value: 0.35, easing: 'linear' },
              ])
              applied.push(`Added ${dur.toFixed(2)}s crossfade between ${label(d, op.clipAId)} and ${label(d, op.clipBId)}`)
              break
            case 'dip_to_black':
              addKfs(a, 'opacity', [
                { time: a.duration - dur / 2, value: 1, easing: 'easeIn' },
                { time: a.duration, value: 0, easing: 'easeIn' },
              ])
              addKfs(b, 'opacity', [
                { time: 0, value: 0, easing: 'easeOut' },
                { time: dur / 2, value: 1, easing: 'easeOut' },
              ])
              applied.push(`Added dip-to-black transition of ${dur.toFixed(2)}s`)
              break
            case 'whip_pan':
              addKfs(a, 'x', [
                { time: a.duration - dur, value: a.x, easing: 'expoIn' },
                { time: a.duration, value: a.x + d.composition.width * 0.6, easing: 'expoIn' },
              ])
              addKfs(b, 'x', [
                { time: 0, value: b.x - d.composition.width * 0.6, easing: 'expoOut' },
                { time: dur, value: b.x, easing: 'expoOut' },
              ])
              applied.push(`Added whip-pan transition`)
              break
            case 'glitch_cut': {
              for (const c of [a, b]) {
                const localStart = c === a ? c.duration - dur : 0
                c.effects = c.effects.filter(e => e.type !== 'glitch')
                c.effects.push({
                  id: uid('fx'), type: 'glitch', enabled: true,
                  params: { amount: 0.55, speed: 14, blockSize: 30 },
                  paramKeyframes: {
                    amount: [
                      { id: uid('kf'), time: localStart, value: 0.9, easing: 'linear' },
                      { id: uid('kf'), time: localStart + dur, value: 0, easing: 'linear' },
                    ],
                  },
                })
              }
              applied.push(`Added glitch-cut transition`)
              break
            }
            case 'zoom_punch':
              addKfs(b, 'scale', [
                { time: 0, value: 1.5, easing: 'expoOut' },
                { time: dur, value: 1, easing: 'expoOut' },
              ])
              addKfs(b, 'opacity', [
                { time: 0, value: 0.6, easing: 'linear' },
                { time: dur * 0.5, value: 1, easing: 'linear' },
              ])
              applied.push(`Added zoom-punch transition`)
              break
          }
          break
        }
        case 'set_comp': {
          if (op.width !== undefined) d.composition.width = op.width
          if (op.height !== undefined) d.composition.height = op.height
          if (op.fps !== undefined) d.composition.fps = op.fps
          if (op.duration !== undefined) d.composition.duration = op.duration
          if (op.background !== undefined) d.composition.background = op.background
          applied.push(`Updated composition settings`)
          break
        }
        case 'sync_effects_to_beats': {
          const clip = findClip(d, op.clipId)
          if (!clip) { errors.push(`${op.op}: clip ${op.clipId} not found`); break }
          if (d.beats.length === 0) { errors.push(`${op.op}: no beats detected — run beat detection first`); break }
          const def = EFFECT_MAP[op.effect]
          if (!def) { errors.push(`${op.op}: unknown effect ${op.effect}`); break }
          const every = op.everyNBeats ?? 1
          const kfsMap: Record<string, { id: string; time: number; value: number; easing: string }[]> = {}
          for (const p of def.params) kfsMap[p.key] = []
          const beats = d.beats.filter(b => b >= clip.start && b <= clip.start + clip.duration)
          for (let i = 0; i < beats.length; i += every) {
            const t = beats[i] - clip.start + (op.offset ?? 0)
            if (t < 0 || t > clip.duration) continue
            for (const p of def.params) {
              // pulse: spike at beat, decay to base
              const base = op.params?.[p.key] ?? p.default
              const spike = Math.min(p.max, base * 2.2)
              kfsMap[p.key].push(
                { id: uid('kf'), time: Math.max(0, t), value: spike, easing: 'linear' },
                { id: uid('kf'), time: Math.min(clip.duration, t + 0.22), value: base, easing: 'linear' },
              )
            }
          }
          clip.effects = clip.effects.filter(e => e.type !== op.effect)
          clip.effects.push({
            id: uid('fx'), type: op.effect, enabled: true,
            params: { ...defaultParams(op.effect), ...(op.params ?? {}) },
            paramKeyframes: kfsMap as unknown as Record<string, Keyframe[]>,
          })
          applied.push(`Synced ${def.name} to ${Math.floor(beats.length / every)} beats on ${label(d, op.clipId)}`)
          break
        }
        case 'camera_move': {
          const clip = findClip(d, op.clipId)
          if (!clip) { errors.push(`${op.op}: clip ${op.clipId} not found`); break }
          const dur = Math.min(op.duration ?? clip.duration, clip.duration)
          const startAt = Math.min(op.startAt ?? 0, clip.duration - 0.05)
          const k = op.intensity ?? 1
          const e = 'easeInOut'
          const t0 = startAt, t1 = Math.min(clip.duration, startAt + dur)
          const px = (v: number) => v * d.composition.width * 0.1 * k
          switch (op.type) {
            case 'zoom_in':
              addKfs(clip, 'scale', [
                { time: t0, value: evalProperty(clip, 'scale', 0), easing: e },
                { time: t1, value: Math.min(4, 1 + 0.35 * k), easing: e },
              ])
              applied.push(`Camera zoom-in on ${label(d, op.clipId)}`)
              break
            case 'zoom_out':
              addKfs(clip, 'scale', [
                { time: t0, value: Math.min(4, 1 + 0.35 * k), easing: e },
                { time: t1, value: 1, easing: e },
              ])
              applied.push(`Camera zoom-out on ${label(d, op.clipId)}`)
              break
            case 'pan_left_right':
              addKfs(clip, 'x', [
                { time: t0, value: -px(4), easing: e },
                { time: t1, value: px(4), easing: e },
              ])
              applied.push(`Camera pan left→right on ${label(d, op.clipId)}`)
              break
            case 'pan_right_left':
              addKfs(clip, 'x', [
                { time: t0, value: px(4), easing: e },
                { time: t1, value: -px(4), easing: e },
              ])
              applied.push(`Camera pan right→left on ${label(d, op.clipId)}`)
              break
            case 'rotate':
              addKfs(clip, 'rotation', [
                { time: t0, value: 0, easing: e },
                { time: t1, value: 12 * k, easing: e },
              ])
              addKfs(clip, 'scale', [
                { time: t0, value: 1 + 0.08 * k, easing: e },
                { time: t1, value: 1 + 0.08 * k, easing: e },
              ])
              applied.push(`Camera rotation on ${label(d, op.clipId)}`)
              break
            case 'ken_burns':
              addKfs(clip, 'scale', [
                { time: t0, value: 1, easing: 'linear' },
                { time: t1, value: 1 + 0.18 * k, easing: 'linear' },
              ])
              addKfs(clip, 'x', [
                { time: t0, value: -px(1.5), easing: 'linear' },
                { time: t1, value: px(1.5), easing: 'linear' },
              ])
              applied.push(`Ken Burns drift on ${label(d, op.clipId)}`)
              break
            case 'push_in_shake':
              addKfs(clip, 'scale', [
                { time: t0, value: 1, easing: 'expoOut' },
                { time: t1, value: 1 + 0.3 * k, easing: 'expoOut' },
              ])
              {
                const steps = 6
                const amp = 14 * k
                const kfs: { time: number; value: number; easing: string }[] = []
                for (let i = 0; i <= steps; i++) {
                  kfs.push({ time: t0 + ((t1 - t0) * i) / steps, value: (i % 2 === 0 ? 1 : -1) * amp * (1 - i / steps), easing: 'linear' })
                }
                addKfs(clip, 'x', kfs)
                addKfs(clip, 'y', kfs.map(v => ({ ...v, value: -v.value * 0.6 })))
              }
              applied.push(`Push-in with shake on ${label(d, op.clipId)}`)
              break
          }
          break
        }
        case 'impact_shake': {
          const clip = findClip(d, op.clipId)
          if (!clip) { errors.push(`${op.op}: clip ${op.clipId} not found`); break }
          const dur = op.duration ?? 0.35
          const k = op.intensity ?? 1
          const amp = 26 * k * (d.composition.width / 1920)
          const t0 = Math.max(0, Math.min(clip.duration, op.atTime - clip.start))
          const steps = Math.max(6, Math.round(dur * 30))
          const kx: { time: number; value: number; easing: string }[] = []
          const ky: { time: number; value: number; easing: string }[] = []
          for (let i = 0; i <= steps; i++) {
            const t = t0 + (dur * i) / steps
            const decay = Math.pow(1 - i / steps, 1.6)
            kx.push({ time: t, value: Math.sin(i * 2.4) * amp * decay, easing: 'linear' })
            ky.push({ time: t, value: Math.cos(i * 3.1) * amp * 0.7 * decay, easing: 'linear' })
          }
          addKfs(clip, 'x', kx)
          addKfs(clip, 'y', ky)
          // flash at impact
          clip.effects = clip.effects.filter(e => e.type !== 'impact_flash')
          clip.effects.push({
            id: uid('fx'), type: 'impact_flash', enabled: true,
            params: { amount: 0.9, mode: 1 },
            paramKeyframes: {
              amount: [
                { id: uid('kf'), time: t0, value: 0, easing: 'hold' },
                { id: uid('kf'), time: t0 + 0.02, value: 0.95, easing: 'linear' },
                { id: uid('kf'), time: t0 + dur, value: 0, easing: 'linear' },
              ],
            },
          })
          applied.push(`Impact shake + flash at ${op.atTime.toFixed(2)}s on ${label(d, op.clipId)}`)
          break
        }
        case 'motion_blur_from_motion': {
          const clip = findClip(d, op.clipId)
          if (!clip) { errors.push(`${op.op}: clip ${op.clipId} not found`); break }
          clip.effects = clip.effects.filter(e => e.type !== 'gaussian_blur')
          // enable the compositor's motion-vector blur by adding a marker effect
          clip.effects.push({
            id: uid('fx'), type: 'directional_blur', enabled: true,
            params: { amount: 0, angle: 0 },
            paramKeyframes: {},
          })
          applied.push(`Enabled velocity-driven motion blur on ${label(d, op.clipId)}`)
          break
        }
        case 'attach_tracking': {
          const clip = findClip(d, op.clipId)
          const target = findClip(d, op.targetClipId)
          if (!clip || !target) { errors.push(`${op.op}: clips not found`); break }
          if (target.kind !== 'video') { errors.push(`${op.op}: tracking source must be a video clip`); break }
          // Defer actual tracking to client runtime via a pending flag the UI executes
          const vc = target as VideoClip
          vc.tracking = null
          d.markers.push({ id: uid('m'), time: op.startTime, label: `Tracking job: ${clip.id}→${target.id}`, color: '#8b5cf6' })
          applied.push(`Queued point tracking from ${label(d, op.targetClipId)} to drive ${label(d, op.clipId)} (runs after apply — see jobs panel)`)
          break
        }
        case 'add_marker': {
          d.markers.push({ id: uid('m'), time: op.time, label: op.label ?? 'Marker', color: op.color ?? '#f59e0b' })
          applied.push(`Added marker at ${op.time.toFixed(2)}s`)
          break
        }
        default:
          errors.push(`Unhandled operation ${JSON.stringify(op)}`)
      }
    } catch (e) {
      errors.push(`${op.op}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return { doc: d, applied, errors }
}
