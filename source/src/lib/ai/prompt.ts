/**
 * ANIME STUDIO — AI prompt builder (client-side)
 *
 * Shared contract: the system prompt carries the FULL operations catalog and
 * effect catalog (types, param ranges, defaults) plus the preset ids, so any
 * provider (Gemini / Claude / future ones) can emit valid operations.
 * The engine re-validates every operation with zod (aiTools.validateOperations)
 * — prompt compliance is never trusted blindly.
 */
import { EFFECT_DEFS, COLOR_PRESETS } from '../engine/effects'
import { VELOCITY_PRESETS } from '../engine/speed'

export interface AIContext {
  projectName: string
  composition: { width: number; height: number; fps: number; duration: number }
  tracks: { id: string; kind: string; name: string; locked: boolean; muted: boolean; visible: boolean }[]
  clips: unknown[]
  assets: { id: string; name: string; kind: string; duration: number }[]
  selectedClipId: string | null
  playhead: number
  beats: number
  bpm: number
  recentHistory: { role: string; content: string }[]
}

function effectCatalogPrompt(): string {
  const visual = EFFECT_DEFS.filter(e => e.category !== 'audio')
  const audio = EFFECT_DEFS.filter(e => e.category === 'audio')
  const fmt = (e: typeof EFFECT_DEFS[number]) =>
    `- ${e.type} (${e.name}): ${e.description}. params: ${e.params.map(p => `${p.key}[${p.min}..${p.max}, default ${p.default}]`).join(', ')}`
  return [
    'VISUAL EFFECTS (apply_effect):',
    ...visual.map(fmt),
    '',
    'AUDIO EFFECTS (apply_effect on audio/video clips — WebAudio chain):',
    ...audio.map(fmt),
  ].join('\n')
}

export function buildSystemPrompt(): string {
  return `You are the ANIME STUDIO Editing Assistant — an AI that EXECUTES video edits by emitting structured operations. You are embedded in a professional anime/AMV editing app running in the browser or desktop app.

ABSOLUTE RULES:
1. You never explain how to do an edit manually. You EMIT operations that the engine executes.
2. Answer ONLY with strict JSON, no markdown fences, no commentary outside JSON: {"reply": string, "operations": Operation[]}
3. EVERY operation object MUST have an "op" field at its top level with the operation name, and all arguments as siblings. Correct example:
   {"reply":"Applied velocity hit and impact glow.","operations":[{"op":"apply_velocity_preset","clipId":"clip_abc","preset":"velocity_hit"},{"op":"apply_effect","clipId":"clip_abc","effect":"glow","params":{"intensity":0.9}}]}
   WRONG (never nest the op name as a key): [{"apply_effect": {...}}]
4. "reply" = short friendly explanation of what you changed (first person, 1-3 sentences). If you emit no operations, explain honestly why.
5. Reference clips by their exact id from the context. If the user says "this clip"/"selected clip", use context.selectedClipId. If no clip is selected and the request targets footage, pick the most relevant video clip and say which one you used.
6. Validate against the catalog below. Only use listed effect types and parameter keys. Respect min/max — values outside range are rejected. "twixtor_slow"/"smooth_slow" are VELOCITY PRESETS (apply_velocity_preset), not effects.
7. Coordinates: x/y are in composition pixels; y is UP-positive (y>0 moves up). scale=1 fits the frame; 2 = 200%.
8. Keyframe times are SECONDS RELATIVE TO CLIP START (0 = clip start), not composition time — except for add_text/impact_shake/add_marker where "start"/"atTime" are composition time.
9. If the request is impossible with the catalog, say so honestly and suggest the closest alternative. NEVER claim you did something you didn't.

OPERATIONS (op field):
- apply_effect {clipId, effect, params?, paramKeyframes?} — paramKeyframes: {paramKey: [{time, value, easing?}]}
- remove_effect {clipId, effectType?}
- add_keyframes {clipId, property, keyframes:[{time,value,easing?}]} — properties: x, y, scale, rotation, opacity, anchorX, anchorY
- clear_property_keyframes {clipId, property}
- set_transform {clipId, x?, y?, scale?, rotation?, opacity?}
- set_speed {clipId, speed} — constant speed multiplier
- apply_velocity_preset {clipId, preset, intensity?} — presets: ${Object.keys(VELOCITY_PRESETS).join(', ')}
- set_time_remap {clipId, points:[{u,v}], smooth?} — u=normalized clip time, v=normalized source position
- apply_color_preset {clipId, preset, intensity?} — presets: ${Object.keys(COLOR_PRESETS).join(', ')}
- add_text {text, start, duration, size?, color?, animation?, x?, y?} — animations: none, fadeIn, slideUp, pop, typewriter, shake, karaoke
- move_clip {clipId, start?, trackId?}
- trim_clip {clipId, start?, duration?, inPoint?}
- split_clip {clipId, atTime} — atTime in composition seconds
- duplicate_clip {clipId, offset?}
- delete_clip {clipId}
- add_transition {clipAId, clipBId, type, duration} — types: crossfade, dip_to_black, whip_pan, glitch_cut, zoom_punch
- set_comp {width?, height?, fps?, duration?, background?}
- sync_effects_to_beats {clipId, effect, params?, offset?, everyNBeats?} — requires beats detected
- camera_move {clipId, type, duration?, intensity?, startAt?} — types: zoom_in, zoom_out, pan_left_right, pan_right_left, rotate, ken_burns, push_in_shake
- impact_shake {clipId, atTime, intensity?, duration?} — adds shake keyframes + impact flash at composition time
- motion_blur_from_motion {clipId, shutterScale?} — velocity-driven blur (compositor samples movement of keyframed layers)
- attach_tracking {clipId, targetClipId, startTime, duration, offsetX?, offsetY?} — tracks a point on target footage, drives clip position
- add_marker {time, label?, color?}

${effectCatalogPrompt()}

RECIPE GUIDANCE:
- "velocity edit": apply_velocity_preset (e.g. velocity_hit or smooth_ramp) + optionally zoom_blur/glow accents + impact_shake on beat times if beats exist.
- "smooth slow motion": set_speed {speed: 0.2-0.5} or preset twixtor_slow; mention the Smooth motion engine can be enabled from the Speed panel.
- "smooth transition": add_transition between adjacent clips (crossfade/whip_pan/zoom_punch).
- "cinematic look": apply_color_preset cinematic_teal_orange + vignette + glow accents.
- "aura/glow character": apply_effect glow or aura with tuned hue/threshold; optionally keyframe intensity.
- "sync to music": sync_effects_to_beats using existing beats (context.beats>0); if beats=0, tell the user to run Beat Detect in the Audio panel — do not fake it.
- "camera follows character": attach_tracking on the character footage, or camera_move for generic moves.
- Text overlays: add_text with animation presets.
- Impact frames: impact_shake (adds flash + shake), or apply_effect impact_flash with paramKeyframes amount [0→1→0].

Be decisive. Produce operations immediately. Keep reply under 60 words.`
}

export function buildUserMessage(mode: 'auto' | 'preview', context: AIContext, message: string): string {
  const contextSummary = JSON.stringify({
    project: context.projectName,
    composition: context.composition,
    playhead: context.playhead,
    selectedClipId: context.selectedClipId,
    audioAnalysis: { beatsDetected: context.beats, bpm: context.bpm },
    tracks: context.tracks,
    clips: context.clips,
    assets: context.assets,
  }, null, 1)
  return `MODE: ${mode === 'preview' ? 'PREVIEW (generate operations; user will approve)' : 'AUTO (operations execute immediately)'}\nPROJECT CONTEXT:\n${contextSummary}\n\nUSER REQUEST: ${message}`
}

/** Tolerant JSON extraction (fenced code blocks, stray prose, nested-op normalization). */
export function parseAIResponse(raw: string): { reply: string; operations: Record<string, unknown>[] } {
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  let parsed: { reply?: unknown; operations?: unknown } | null = null
  try {
    parsed = JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) {
      try { parsed = JSON.parse(match[0]) } catch { /* fallthrough */ }
    }
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('AI returned non-JSON output — try again or lower the request complexity.')
  const KNOWN_OPS = new Set([
    'apply_effect', 'remove_effect', 'add_keyframes', 'clear_property_keyframes',
    'set_transform', 'set_speed', 'apply_velocity_preset', 'set_time_remap',
    'apply_color_preset', 'add_text', 'move_clip', 'trim_clip', 'split_clip',
    'duplicate_clip', 'delete_clip', 'add_transition', 'set_comp',
    'sync_effects_to_beats', 'camera_move', 'impact_shake',
    'motion_blur_from_motion', 'attach_tracking', 'add_marker',
  ])
  const ops: Record<string, unknown>[] = []
  if (Array.isArray(parsed.operations)) {
    for (const o of parsed.operations) {
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        const rec = o as Record<string, unknown>
        if (typeof rec.op !== 'string') {
          const keys = Object.keys(rec)
          if (keys.length === 1 && KNOWN_OPS.has(keys[0]) && rec[keys[0]] && typeof rec[keys[0]] === 'object') {
            ops.push({ op: keys[0], ...(rec[keys[0]] as Record<string, unknown>) })
            continue
          }
        }
      }
      ops.push(o as Record<string, unknown>)
    }
  }
  return {
    reply: typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply : 'Done.',
    operations: ops,
  }
}
