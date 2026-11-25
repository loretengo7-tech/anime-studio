/**
 * ANIME STUDIO — Plugin System (After Effects-style)
 *
 * A real, extensible effect-plugin architecture:
 *  - Plugins are JSON manifests with parametrized GLSL color-processing
 *    effects (`vec3 pl_main(vec3 col, vec2 uv, vec2 res, float time)`)
 *  - The compositor compiles installed plugin effects into the mega shader
 *    at program-build time and hot-reloads when plugins install/uninstall
 *  - Manifests are validated (structure + GLSL sanity checks) before install;
 *    a plugin that fails to compile is quarantined, never crashing the editor
 *  - Installed plugins persist in localStorage and merge into the effects
 *    registry exposed to the UI, the Inspector, the Export pipeline and the
 *    AI assistant tool system
 *
 * Ships with four sample packs demonstrating the API.
 */
import type { EffectDef } from './types'

export type PluginCategory = EffectDef['category']

export interface PluginEffectSpec {
  type: string
  name: string
  description: string
  params: {
    key: string
    label: string
    min: number
    max: number
    step: number
    default: number
  }[]
  /**
   * GLSL color-processing function. MUST define:
   *   vec3 pl_main(vec3 col, vec2 uv, vec2 res, float time)
   * Params are referenced as `u_p_<key>` (rewritten per-plugin at compile).
   * WebGL1 GLSL ES 1.0 — color transforms and procedural generation only
   * (no texture access; UV-warp work belongs to built-in effects).
   */
  shader: string
}

export interface StudioPlugin {
  id: string
  name: string
  version: string
  author: string
  category: PluginCategory
  description: string
  effects: PluginEffectSpec[]
}

interface InstalledPlugin extends StudioPlugin {
  installedAt: number
}

const LS_KEY = 'anime-studio:plugins'
const MAX_SHADER_LEN = 8000
const MAX_EFFECTS = 8
const MAX_PARAMS = 8

const VALID_CATEGORIES: PluginCategory[] = [
  'motion', 'lighting', 'distortion', 'color', 'anime', 'stylize', 'generate', 'perspective', 'time', 'audio',
]

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

let installed: InstalledPlugin[] = []
let loaded = false
const changeListeners = new Set<() => void>()
let chunkCache: string | null = null
let selectionCache: Map<string, number> | null = null

function load() {
  if (loaded || typeof window === 'undefined') return
  loaded = true
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const arr = JSON.parse(raw) as InstalledPlugin[]
      if (Array.isArray(arr)) installed = arr.filter(p => p && p.id && Array.isArray(p.effects))
    }
  } catch { /* corrupted store — start clean */ }
  // first run: install the sample packs; later runs: add sample packs shipped in newer versions
  if (installed.length === 0) {
    installed = SAMPLE_PLUGINS.map(p => ({ ...p, installedAt: Date.now() }))
    persist()
  } else {
    const have = new Set(installed.map(p => p.id))
    const missing = SAMPLE_PLUGINS.filter(p => !have.has(p.id))
    if (missing.length > 0) {
      installed = [...installed, ...missing.map(p => ({ ...p, installedAt: Date.now() }))]
      persist()
    }
  }
}

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(installed))
  } catch { /* storage full — keep in memory */ }
}

function notify() {
  chunkCache = null
  selectionCache = null
  for (const cb of changeListeners) cb()
}

export function listInstalledPlugins(): InstalledPlugin[] {
  load()
  return [...installed]
}

export function onPluginsChanged(cb: () => void): () => void {
  changeListeners.add(cb)
  return () => changeListeners.delete(cb)
}

// ---------------------------------------------------------------------------
// Validation + install/uninstall
// ---------------------------------------------------------------------------

export interface InstallResult {
  ok: boolean
  error?: string
  plugin?: StudioPlugin
}

function validateShader(shader: string): string | null {
  if (shader.length > MAX_SHADER_LEN) return 'Shader too long (max 8000 chars)'
  if (!/vec3\s+pl_main\s*\(/.test(shader)) return 'Shader must define vec3 pl_main(...)'
  // balanced braces
  let depth = 0
  for (const ch of shader) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
    if (depth < 0) return 'Unbalanced braces in shader'
  }
  if (depth !== 0) return 'Unbalanced braces in shader'
  // forbidden directives that would break the mega shader
  if (/^\s*#version/m.test(shader)) return 'Shader must not contain #version'
  if (/^\s*precision/m.test(shader)) return 'Shader must not redeclare precision'
  if (/uniform\s+sampler2D/.test(shader)) return 'Shader must not declare samplers (color-in/color-out only)'
  if (/texture2D\s*\(\s*u_tex/.test(shader)) return 'Shader must not sample u_tex (color-in/color-out only)'
  return null
}

export function installPluginFromJSON(json: unknown): InstallResult {
  load()
  let p: StudioPlugin
  try {
    p = (typeof json === 'string' ? JSON.parse(json) : json) as StudioPlugin
  } catch {
    return { ok: false, error: 'Invalid JSON manifest' }
  }
  if (!p || typeof p !== 'object') return { ok: false, error: 'Manifest is not an object' }
  if (!p.id || typeof p.id !== 'string' || !/^[a-z0-9_]{2,40}$/.test(p.id)) {
    return { ok: false, error: 'Plugin id must be a slug (a-z0-9_, 2-40 chars)' }
  }
  if (!p.name || typeof p.name !== 'string') return { ok: false, error: 'Missing plugin name' }
  if (!VALID_CATEGORIES.includes(p.category)) {
    return { ok: false, error: `Category must be one of: ${VALID_CATEGORIES.join(', ')}` }
  }
  if (!Array.isArray(p.effects) || p.effects.length === 0) return { ok: false, error: 'Plugin must declare at least one effect' }
  if (p.effects.length > MAX_EFFECTS) return { ok: false, error: `Max ${MAX_EFFECTS} effects per plugin` }
  for (const e of p.effects) {
    if (!e.type || typeof e.type !== 'string') return { ok: false, error: 'Effect missing type' }
    if (!e.name || typeof e.name !== 'string') return { ok: false, error: `Effect ${e.type} missing name` }
    const shErr = validateShader(e.shader ?? '')
    if (shErr) return { ok: false, error: `Effect ${e.type}: ${shErr}` }
    if (!Array.isArray(e.params)) e.params = []
    if (e.params.length > MAX_PARAMS) return { ok: false, error: `Effect ${e.type}: max ${MAX_PARAMS} params` }
    for (const param of e.params) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,23}$/.test(param.key)) {
        return { ok: false, error: `Effect ${e.type}: invalid param key "${param.key}"` }
      }
      if (typeof param.min !== 'number' || typeof param.max !== 'number' || typeof param.default !== 'number') {
        return { ok: false, error: `Effect ${e.type}: param ${param.key} needs numeric min/max/default` }
      }
    }
  }
  if (installed.some(x => x.id === p.id)) {
    return { ok: false, error: `Plugin "${p.id}" is already installed` }
  }
  installed.push({ ...p, installedAt: Date.now() })
  persist()
  notify()
  return { ok: true, plugin: p }
}

export function uninstallPlugin(id: string): boolean {
  load()
  const before = installed.length
  installed = installed.filter(p => p.id !== id)
  if (installed.length !== before) {
    persist()
    notify()
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// GLSL generation + selection indexing
// ---------------------------------------------------------------------------

export function sanitizeParamKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, 'p$1')
}

/** Ordered list of all installed plugin effect slots (index 0 → u_pl0_*). */
function pluginSlots(): { pluginId: string; pluginName: string; effect: PluginEffectSpec }[] {
  load()
  const slots: { pluginId: string; pluginName: string; effect: PluginEffectSpec }[] = []
  for (const p of installed) {
    for (const e of p.effects) slots.push({ pluginId: p.id, pluginName: p.name, effect: e })
  }
  return slots
}

/** 1-based selection index for u_pluginSel, or 0 if not installed. */
export function pluginSelectionIndex(pluginId: string, effectType: string): number {
  if (!selectionCache) {
    selectionCache = new Map()
    pluginSlots().forEach((s, i) => selectionCache!.set(`${s.pluginId}:${s.effect.type}`, i + 1))
  }
  return selectionCache.get(`${pluginId}:${effectType}`) ?? 0
}

/**
 * Generate the GLSL chunk compiled into the compositor mega shader:
 * per-slot uniforms + rewritten pl_main functions + applyPlugin dispatch.
 */
export function getPluginShaderChunk(): string {
  if (chunkCache) return chunkCache
  load()
  const slots = pluginSlots()
  if (slots.length === 0) {
    chunkCache = 'vec3 applyPlugin(vec3 col, vec2 uv, vec2 res, float time) { return col; }'
    return chunkCache
  }
  const parts: string[] = []
  const dispatch: string[] = ['vec3 applyPlugin(vec3 col, vec2 uv, vec2 res, float time) {', '  if (u_pluginSel < 0.5) return col;']
  slots.forEach((s, i) => {
    let code = s.effect.shader
    // rewrite param uniforms and function name to slot-unique names
    for (const param of s.effect.params) {
      code = code.split(`u_p_${param.key}`).join(`u_pl${i}_${sanitizeParamKey(param.key)}`)
    }
    code = code.split('pl_main').join(`pl${i}_main`)
    // uniforms (declared once per slot)
    for (const param of s.effect.params) {
      parts.push(`uniform float u_pl${i}_${sanitizeParamKey(param.key)};`)
    }
    parts.push(`// plugin: ${s.pluginId} :: ${s.effect.type}`)
    parts.push(code)
  })
  // dispatch chain: sel is 1-based
  const lines: string[] = []
  slots.forEach((_s, i) => {
    lines.push(`  if (u_pluginSel < ${(i + 1).toFixed(1)}) return pl${i}_main(col, uv, res, time);`)
  })
  dispatch.length = 2
  dispatch.push(...lines)
  dispatch.push('  return col;', '}')
  chunkCache = [...parts, ...dispatch].join('\n')
  return chunkCache
}

/** Plugin effect defs merged into the EffectDef registry (UI / AI / export). */
export function getPluginEffectDefs(): EffectDef[] {
  load()
  const defs: EffectDef[] = []
  for (const s of pluginSlots()) {
    const owner = installed.find(p => p.id === s.pluginId)
    defs.push({
      type: s.effect.type,
      name: s.effect.name,
      category: owner?.category ?? 'stylize',
      description: s.effect.description,
      params: s.effect.params.map(p => ({ ...p, uniform: sanitizeParamKey(p.key) })),
      pluginId: s.pluginId,
      pluginName: s.pluginName,
    })
  }
  return defs
}

// ---------------------------------------------------------------------------
// Sample plugins — demonstrate the manifest API with real working effects
// ---------------------------------------------------------------------------

export const SAMPLE_PLUGINS: StudioPlugin[] = [
  {
    id: 'vhs_pack',
    name: 'VHS Damage Pack',
    version: '1.2.0',
    author: 'Anime Studio Labs',
    category: 'distortion',
    description: 'Analog tape artifacts: wavy tracking warp and chroma bleed.',
    effects: [
      {
        type: 'vhs_tape_warp',
        name: 'VHS Tape Warp',
        description: 'Horizontal tracking wobble with occasional head-switch jump.',
        params: [
          { key: 'wobble', label: 'Wobble', min: 0, max: 1, step: 0.01, default: 0.35 },
          { key: 'jump', label: 'Head Switch', min: 0, max: 1, step: 0.01, default: 0.25 },
          { key: 'speed', label: 'Speed', min: 0.5, max: 12, step: 0.1, default: 4 },
        ],
        shader: `vec3 pl_main(vec3 col, vec2 uv, vec2 res, float time) {
  // NOTE: uv-warp approximation via luminance wave (color-level only)
  float t = floor(time * u_p_speed * 3.0);
  float band = floor(uv.y * 18.0);
  float w = (fract(sin(dot(vec2(band, t), vec2(12.9898, 78.233))) * 43758.5453) - 0.5)
          * u_p_wobble * 0.35;
  float jumpRow = step(0.98 - u_p_jump * 0.08, fract(sin(t * 91.7) * 43758.5453));
  float j = jumpRow * step(0.96, fract(uv.y * 9.0 + t)) * 0.08;
  float wave = sin(uv.y * 40.0 + time * 2.0) * 0.02 * u_p_wobble;
  float shift = w + j + wave;
  // emulate horizontal smear: mix toward a horizontally-offset luma tint
  vec3 shifted = vec3(col.r * (1.0 + shift * 6.0), col.g, col.b * (1.0 - shift * 4.0));
  float tapeNoise = fract(sin(dot(uv * res + time * 7.0, vec2(93.989, 67.345))) * 43758.5453) - 0.5;
  shifted += tapeNoise * u_p_wobble * 0.18;
  return clamp(shifted, 0.0, 1.0);
}`,
      },
      {
        type: 'vhs_chroma_bleed',
        name: 'VHS Chroma Bleed',
        description: 'Color separation smear + scanline darkening.',
        params: [
          { key: 'bleed', label: 'Bleed', min: 0, max: 1, step: 0.01, default: 0.4 },
          { key: 'scan', label: 'Scanlines', min: 0, max: 1, step: 0.01, default: 0.3 },
        ],
        shader: `vec3 pl_main(vec3 col, vec2 uv, vec2 res, float time) {
  vec3 c = col;
  c.r = mix(c.r, dot(c, vec3(0.4, 0.5, 0.1)), u_p_bleed * 0.5);
  c.b = mix(c.b, dot(c, vec3(0.1, 0.2, 0.7)), u_p_bleed * 0.5);
  c *= 1.0 - u_p_scan * 0.45 * step(0.5, fract(uv.y * res.y / 2.5));
  return clamp(c, 0.0, 1.0);
}`,
      },
    ],
  },
  {
    id: 'datamosh_pack',
    name: 'Datamosh Pack',
    version: '1.0.1',
    author: 'Anime Studio Labs',
    category: 'distortion',
    description: 'Compression-artifact aesthetics: block smearing and pixel bleeding.',
    effects: [
      {
        type: 'datamosh_blocks',
        name: 'Datamosh',
        description: 'Animated block displacement that melts the image.',
        params: [
          { key: 'amount', label: 'Melt', min: 0, max: 1, step: 0.01, default: 0.45 },
          { key: 'block', label: 'Block Size', min: 4, max: 64, step: 1, default: 16 },
          { key: 'speed', label: 'Speed', min: 0.5, max: 16, step: 0.5, default: 6 },
        ],
        shader: `vec3 pl_main(vec3 col, vec2 uv, vec2 res, float time) {
  float t = floor(time * u_p_speed);
  vec2 cell = floor(uv * res / u_p_block);
  float r1 = fract(sin(dot(cell, vec2(127.1, 311.7)) + t) * 43758.5453);
  float r2 = fract(sin(dot(cell, vec2(269.5, 183.3)) + t * 1.7) * 43758.5453);
  vec2 drift = vec2(r1 - 0.5, r2 - 0.5) * u_p_amount * u_p_block / res;
  // smear: neighbor-cell average tinted by drift magnitude
  float mag = length(drift) * res.x;
  vec3 smeared = mix(col, col.gbr, clamp(mag * 0.08, 0.0, 1.0));
  vec3 outc = mix(smeared, vec3(dot(smeared, vec3(0.333))), clamp(u_p_amount * (r2 - 0.6) * 2.0, 0.0, 1.0));
  return clamp(outc, 0.0, 1.0);
}`,
      },
    ],
  },
  {
    id: 'holo_pack',
    name: 'Hologram Pack',
    version: '1.1.0',
    author: 'Anime Studio Labs',
    category: 'stylize',
    description: 'Sci-fi hologram treatments: scan shimmer and fresnel edge tint.',
    effects: [
      {
        type: 'holo_scan',
        name: 'Hologram Scan',
        description: 'Ghostly cyan scan shimmer with flicker.',
        params: [
          { key: 'intensity', label: 'Intensity', min: 0, max: 1, step: 0.01, default: 0.5 },
          { key: 'speed', label: 'Scan Speed', min: 0.5, max: 12, step: 0.1, default: 3 },
          { key: 'flicker', label: 'Flicker', min: 0, max: 1, step: 0.01, default: 0.4 },
        ],
        shader: `vec3 pl_main(vec3 col, vec2 uv, vec2 res, float time) {
  float scan = exp(-abs(fract(uv.y * 3.0 - time * u_p_speed) - 0.5) * 9.0);
  float lines = step(0.5, fract(uv.y * res.y / 3.0));
  float flick = 1.0 - u_p_flicker * 0.4 * fract(sin(time * 47.0) * 43758.5453);
  vec3 hcol = vec3(0.35, 0.95, 1.0);
  vec3 c = col * flick;
  c += hcol * scan * u_p_intensity * 0.8;
  c = mix(c, c * (0.75 + 0.25 * lines), u_p_intensity * 0.6);
  return clamp(c, 0.0, 1.0);
}`,
      },
    ],
  },
  {
    id: 'snowfall_pack',
    name: 'Snowfall Pack',
    version: '1.0.0',
    author: 'Anime Studio Labs',
    category: 'generate',
    description: 'Gentle procedural snow with depth layers and drift.',
    effects: [
      {
        type: 'snowfall_overlay',
        name: 'Snowfall',
        description: 'Two-layer drifting snow flakes.',
        params: [
          { key: 'density', label: 'Density', min: 0, max: 1, step: 0.01, default: 0.45 },
          { key: 'speed', label: 'Fall Speed', min: 0.1, max: 3, step: 0.05, default: 0.6 },
          { key: 'drift', label: 'Wind Drift', min: 0, max: 2, step: 0.05, default: 0.5 },
          { key: 'size', label: 'Flake Size', min: 0.5, max: 4, step: 0.1, default: 1.5 },
        ],
        shader: `vec3 pl_main(vec3 col, vec2 uv, vec2 res, float time) {
  vec3 c = col;
  for (int layer = 0; layer < 2; layer++) {
    float fl = float(layer);
    vec2 g = uv * vec2(14.0 + fl * 8.0, 10.0 + fl * 5.0);
    g.y += time * u_p_speed * (1.4 + fl * 0.7);
    g.x += sin(time * 0.7 + fl * 2.1) * u_p_drift * 0.6;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    float rnd = fract(sin(dot(id + fl * 13.0, vec2(12.9898, 78.233))) * 43758.5453);
    if (rnd < u_p_density * 0.4) {
      vec2 off = (vec2(fract(rnd * 57.0), fract(rnd * 113.0)) - 0.5) * 0.55;
      float d = length((f - off) / max(u_p_size * 0.11, 0.02));
      c += vec3(0.95, 0.97, 1.0) * smoothstep(1.0, 0.15, d) * (0.55 - fl * 0.15);
    }
  }
  return clamp(c, 0.0, 1.0);
}`,
      },
    ],
  },
  {
    id: 'capcut_looks_pack',
    name: 'Looks & Flash Pack',
    version: '1.0.0',
    author: 'Anime Studio Labs',
    category: 'color',
    description: 'One-tap cinematic looks, beat flash, flicker, negative pulse and cinema bars.',
    effects: [
      {
        type: 'film_fade', name: 'Film Fade', description: 'Lifted blacks and muted color — faded film look.',
        params: [
          { key: 'fade', label: 'Fade', min: 0, max: 1, step: 0.01, default: 0.35 },
          { key: 'sat', label: 'Saturation', min: 0, max: 1.5, step: 0.01, default: 0.75 },
        ],
        shader: `vec3 pl_main(vec3 col, vec2 uv, vec2 res, float time) {
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  vec3 c = mix(vec3(l), col, u_p_sat);
  c = c * (1.0 - u_p_fade * 0.35) + vec3(0.06, 0.05, 0.07) * u_p_fade * 1.6;
  return clamp(c, 0.0, 1.0);
}`,
      },
      {
        type: 'split_tone', name: 'Split Tone', description: 'Teal shadows, orange highlights.',
        params: [
          { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.6 },
          { key: 'balance', label: 'Balance', min: 0, max: 1, step: 0.01, default: 0.5 },
        ],
        shader: `vec3 pl_main(vec3 col, vec2 uv, vec2 res, float time) {
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  float w = smoothstep(0.0, 1.0, l + (u_p_balance - 0.5));
  vec3 tone = mix(vec3(0.10, 0.45, 0.55), vec3(1.0, 0.62, 0.30), w);
  vec3 c = mix(col, col * tone * 1.6, u_p_amount * 0.6);
  return clamp(c, 0.0, 1.0);
}`,
      },
      {
        type: 'neon_night', name: 'Neon Night', description: 'Cyberpunk blue/magenta night grade.',
        params: [
          { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.7 },
          { key: 'punch', label: 'Punch', min: 0, max: 1, step: 0.01, default: 0.4 },
        ],
        shader: `vec3 pl_main(vec3 col, vec2 uv, vec2 res, float time) {
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  vec3 neon = mix(vec3(0.15, 0.55, 1.0), vec3(1.0, 0.2, 0.75), smoothstep(0.25, 0.8, l));
  vec3 c = mix(col, col * neon * 1.8, u_p_amount);
  c = (c - 0.5) * (1.0 + u_p_punch * 0.6) + 0.5;
  return clamp(c, 0.0, 1.0);
}`,
      },
      {
        type: 'beat_flash', name: 'Beat Flash', description: 'White flash that pulses at a steady rate.',
        params: [
          { key: 'rate', label: 'Rate (Hz)', min: 0.5, max: 8, step: 0.1, default: 2 },
          { key: 'power', label: 'Power', min: 0, max: 1, step: 0.01, default: 0.6 },
        ],
        shader: `vec3 pl_main(vec3 col, vec2 uv, vec2 res, float time) {
  float ph = fract(time * u_p_rate);
  float f = pow(1.0 - ph, 6.0) * u_p_power;
  return clamp(col + vec3(f), 0.0, 1.0);
}`,
      },
      {
        type: 'color_flicker', name: 'Color Flicker', description: 'Random per-step color tint flicker.',
        params: [
          { key: 'speed', label: 'Speed', min: 0.5, max: 20, step: 0.1, default: 8 },
          { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.4 },
        ],
        shader: `vec3 pl_main(vec3 col, vec2 uv, vec2 res, float time) {
  float n = floor(time * u_p_speed);
  float r = fract(sin(n * 91.345) * 43758.5453);
  vec3 tint = vec3(1.0) + (vec3(fract(r * 7.0), fract(r * 13.0), fract(r * 29.0)) - 0.5) * u_p_amount;
  return clamp(col * tint, 0.0, 1.0);
}`,
      },
      {
        type: 'negative_pulse', name: 'Negative Pulse', description: 'Alternates between normal and inverted colors.',
        params: [
          { key: 'rate', label: 'Rate (Hz)', min: 0.2, max: 8, step: 0.1, default: 1.5 },
          { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 1 },
        ],
        shader: `vec3 pl_main(vec3 col, vec2 uv, vec2 res, float time) {
  float s = step(0.5, fract(time * u_p_rate));
  return mix(col, vec3(1.0) - col, s * u_p_amount);
}`,
      },
      {
        type: 'cinema_bars', name: 'Cinema Bars', description: 'Black letterbox bars top and bottom.',
        params: [
          { key: 'size', label: 'Bar Size', min: 0, max: 0.3, step: 0.005, default: 0.12 },
          { key: 'soft', label: 'Softness', min: 0, max: 0.05, step: 0.001, default: 0.004 },
        ],
        shader: `vec3 pl_main(vec3 col, vec2 uv, vec2 res, float time) {
  float top = smoothstep(u_p_size, u_p_size + u_p_soft + 0.001, uv.y);
  float bot = smoothstep(u_p_size, u_p_size + u_p_soft + 0.001, 1.0 - uv.y);
  return col * top * bot;
}`,
      },
      {
        type: 'dream_haze', name: 'Dream Haze', description: 'Soft lifted haze with a warm pastel tint.',
        params: [
          { key: 'haze', label: 'Haze', min: 0, max: 1, step: 0.01, default: 0.4 },
          { key: 'warm', label: 'Warmth', min: 0, max: 1, step: 0.01, default: 0.3 },
        ],
        shader: `vec3 pl_main(vec3 col, vec2 uv, vec2 res, float time) {
  vec3 c = col + (vec3(1.0) - col) * u_p_haze * 0.28;
  c = mix(c, c * vec3(1.06, 1.0, 0.92), u_p_warm);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, 1.0 - u_p_haze * 0.25);
  return clamp(c, 0.0, 1.0);
}`,
      },
    ],
  },
]
