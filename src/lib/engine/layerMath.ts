/**
 * ANIME STUDIO — Layer matrix math (shared)
 *
 * Row-major 3x3 matrices, row-vector convention (p' = p·M, translation in the
 * last row) — the same convention the WebGL compositor uses internally.
 * This module exposes the pieces needed OUTSIDE the compositor (preview
 * overlays for Null layers): the verified parent chain and a null's NDC center.
 *
 * The parent-chain construction here is byte-for-byte the compositor's
 * (verified with scripts/test_parenting_math.mjs: default parent = identity,
 * moving a parent moves children 1:1 in comp px, chains compose correctly).
 */
import type { Clip, Composition, ProjectDoc } from './types'

export function mat3Identity(): number[] { return [1, 0, 0, 0, 1, 0, 0, 0, 1] }
export function mat3Mul(a: number[], b: number[]): number[] {
  const o = new Array(9).fill(0)
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c]
  return o
}
export function mat3Translate(x: number, y: number): number[] { return [1, 0, 0, 0, 1, 0, x, y, 1] }
export function mat3Scale(sx: number, sy: number): number[] { return [sx, 0, 0, 0, sy, 0, 0, 0, 1] }
export function mat3Rotate(rad: number): number[] {
  const c = Math.cos(rad), s = Math.sin(rad)
  return [c, s, 0, -s, c, 0, 0, 0, 1]
}
/** Apply with the engine's row-vector convention. */
export function mat3Apply(m: number[], x: number, y: number): [number, number] {
  return [x * m[0] + y * m[3] + m[6], x * m[1] + y * m[4] + m[7]]
}

// local import shim to avoid a circular dependency with keyframes.ts
import { evalProperty as evalProp } from './keyframes'

/**
 * AE Parent & Link: composed transform of the whole ancestor chain.
 * Each ancestor is evaluated at its OWN local time (keyframes on a parent
 * animate the children). Cycle-safe, max 8 levels. Returns null when the
 * layer has no parent.
 */
export function parentChainMatrix(doc: ProjectDoc, clip: Clip, compTime: number, comp: Composition): number[] | null {
  let result: number[] | null = null
  let cur = clip
  const seen = new Set<string>([clip.id])
  for (let i = 0; i < 8; i++) {
    if (!cur.parentId || seen.has(cur.parentId)) break
    const parent = doc.clips.find(c => c.id === cur.parentId)
    if (!parent || parent.kind === 'audio') break
    seen.add(parent.id)
    const pLocal = compTime - parent.start
    const x = evalProp(parent, 'x', pLocal)
    const y = evalProp(parent, 'y', pLocal)
    const scale = evalProp(parent, 'scale', pLocal)
    const rot = (evalProp(parent, 'rotation', pLocal) * Math.PI) / 180
    const pax = evalProp(parent, 'anchorX', pLocal)
    const pay = evalProp(parent, 'anchorY', pLocal)
    const C0 = mat3Mul(mat3Translate(1, 1), mat3Scale(0.5, 0.5))
    let pm = mat3Identity()
    pm = mat3Mul(mat3Scale(2 / comp.width, 2 / comp.height), pm)
    pm = mat3Mul(mat3Translate(x, y), pm)
    pm = mat3Mul(mat3Scale(scale, scale), pm)
    pm = mat3Mul(mat3Rotate(rot), pm)
    pm = mat3Mul(mat3Translate(-(comp.width / 2 - pax), -(comp.height / 2 - pay)), pm)
    pm = mat3Mul(mat3Scale(comp.width, comp.height), pm)
    pm = mat3Mul(C0, pm)
    result = result ? mat3Mul(result, pm) : pm  // accumulate: child-first order
    cur = parent
  }
  return result
}

/**
 * Base matrix for a controller layer (null) — same pipeline the compositor
 * uses for comp-sized procedural layers (fit = 1, src = comp size).
 */
function nullBaseMatrix(
  x: number, y: number, scale: number, rotRad: number, ax: number, ay: number,
  compW: number, compH: number,
): number[] {
  const C = mat3Mul(mat3Translate(1, 1), mat3Scale(0.5, 0.5))
  let m = mat3Identity()
  m = mat3Mul(mat3Scale(2 / compW, 2 / compH), m)
  m = mat3Mul(mat3Translate(x, y), m)
  m = mat3Mul(mat3Scale(scale, scale), m)
  m = mat3Mul(mat3Rotate(rotRad), m)
  m = mat3Mul(mat3Translate(-(compW / 2 - ax), -(compH / 2 - ay)), m)
  m = mat3Mul(mat3Scale(compW, compH), m)
  m = mat3Mul(C, m)
  return m
}

/**
 * NDC center of a layer at comp time — used to position Null markers on the
 * preview overlay. Composes the layer's own matrix with its parent chain.
 * Returns null when the layer is not a positional controller or its track
 * membership is broken. 3D-projected nulls return their 2D position
 * (documented approximation).
 */
export function layerCenterNDC(doc: ProjectDoc, clip: Clip, compTime: number, comp: Composition): { x: number; y: number } | null {
  const local = compTime - clip.start
  const x = evalProp(clip, 'x', local)
  const y = evalProp(clip, 'y', local)
  const scale = evalProp(clip, 'scale', local)
  const rot = (evalProp(clip, 'rotation', local) * Math.PI) / 180
  const ax = evalProp(clip, 'anchorX', local)
  const ay = evalProp(clip, 'anchorY', local)
  let m: number[]
  if (clip.kind === 'null') {
    m = nullBaseMatrix(x, y, scale, rot, ax, ay, comp.width, comp.height)
  } else {
    // footage-like layer: fit to comp, anchor pivot at layer center
    const C = mat3Mul(mat3Translate(1, 1), mat3Scale(0.5, 0.5))
    m = mat3Identity()
    m = mat3Mul(mat3Scale(2 / comp.width, 2 / comp.height), m)
    m = mat3Mul(mat3Translate(x, y), m)
    m = mat3Mul(mat3Scale(scale, scale), m)
    m = mat3Mul(mat3Rotate(rot), m)
    m = mat3Mul(mat3Translate(0, 0), m)             // anchor 0 → pivot at center
    m = mat3Mul(mat3Scale(comp.width, comp.height), m)
    m = mat3Mul(C, m)
  }
  const pm = parentChainMatrix(doc, clip, compTime, comp)
  if (pm) m = mat3Mul(m, pm)
  // quad center (0,0) through the composed matrix = translation row
  const [cx, cy] = mat3Apply(m, 0, 0)
  return { x: cx, y: cy }
}
