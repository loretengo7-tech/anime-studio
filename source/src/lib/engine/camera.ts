/**
 * ANIME STUDIO — 3D camera + projection math
 *
 * Minimal, dependency-free 3D pipeline for layer-level perspective:
 * layers with `threeD` enabled get their 4 corners projected through the
 * active Camera layer (position + euler rotation + focal length), producing a
 * per-layer HOMOGRAPHY that is passed to the compositor as `u_matrix` (the
 * vertex shader uses its z row as gl_Position.w, so the GPU interpolates UVs
 * perspective-correctly across the warped quad).
 *
 * Conventions (match the compositor):
 *  - comp space is px, y-up, origin at comp center for x/y; z grows away from
 *    the viewer (layers at z=0, camera defaults to z = -compHeight).
 *  - output is pre-flip NDC [-1,1]² (the compositor applies its FBO Y-flip).
 */

export interface CamState {
  px: number; py: number; pz: number
  rx: number; ry: number; rz: number // degrees
  focalLength: number // comp px
  zoom: number
}

function deg2rad(d: number): number { return (d * Math.PI) / 180 }

/** Rotate v by euler XYZ (applied Z, then Y, then X — matches AE-ish order). */
function eulerRotate(v: [number, number, number], rx: number, ry: number, rz: number): [number, number, number] {
  let [x, y, z] = v
  if (rz !== 0) {
    const c = Math.cos(deg2rad(rz)), s = Math.sin(deg2rad(rz))
    ;[x, y] = [x * c - y * s, x * s + y * c]
  }
  if (ry !== 0) {
    const c = Math.cos(deg2rad(ry)), s = Math.sin(deg2rad(ry))
    ;[x, z] = [x * c + z * s, -x * s + z * c]
  }
  if (rx !== 0) {
    const c = Math.cos(deg2rad(rx)), s = Math.sin(deg2rad(rx))
    ;[y, z] = [y * c - z * s, y * s + z * c]
  }
  return [x, y, z]
}

/** Project a comp-space point through the camera. Returns NDC or null if behind the camera. */
export function projectPoint(
  p: [number, number, number], cam: CamState, compW: number, compH: number
): [number, number] | null {
  // world → camera space
  let x = p[0] - cam.px
  let y = p[1] - cam.py
  let z = p[2] - cam.pz
  ;[x, y, z] = eulerRotate([x, y, z], -cam.rx, -cam.ry, -cam.rz)
  // camera looks along +z
  if (z <= 0.01) return null
  const focal = Math.max(16, cam.focalLength) / Math.max(0.01, cam.zoom)
  const ndcX = (x / z) * (focal / (compW / 2))
  const ndcY = (y / z) * (focal / (compH / 2))
  return [ndcX, ndcY]
}

/**
 * Solve the homography mapping the unit quad (-1,-1)(1,-1)(1,1)(-1,1) onto the
 * four projected corners via 8-unknown DLT (Gaussian elimination). Returns
 * row-major mat3, or null if degenerate (any corner behind camera).
 */
export function squareToQuad(dst: [number, number][]): number[] | null {
  if (dst.length !== 4) return null
  // src corners in the same order
  const src: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
  // unknowns h11..h32 (8): for each correspondence
  // x' = (h11 x + h12 y + h13) / (h31 x + h32 y + 1)
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]
    const [X, Y] = dst[i]
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X)
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y)
  }
  // Gaussian elimination with partial pivoting
  const n = 8
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r
    if (Math.abs(A[piv][col]) < 1e-10) return null
    ;[A[col], A[piv]] = [A[piv], A[col]]
    ;[b[col], b[piv]] = [b[piv], b[col]]
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / A[col][col]
      if (f === 0) continue
      for (let c2 = col; c2 < n; c2++) A[r][c2] -= f * A[col][c2]
      b[r] -= f * b[col]
    }
  }
  const h = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]
    for (let c2 = r + 1; c2 < n; c2++) s -= A[r][c2] * h[c2]
    h[r] = s / A[r][r]
  }
  // mat3 row-major (column-vector convention used by the compositor):
  // [h11 h12 h13; h21 h22 h23; h31 h32 1]
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]
}

/**
 * Full per-layer homography: layer corners (fitted size, rotated by the layer's
 * own 2D transform and offset by its x/y/z) projected through the camera.
 * Returns a pre-flip NDC homography or null to fall back to the 2D path.
 */
export function layerHomography(
  opts: {
    cx: number; cy: number; cz: number          // layer position (comp px, y-up)
    w: number; h: number                        // fitted layer size in comp px
    rotationDeg: number
    cam: CamState | null
    compW: number; compH: number
  }
): number[] | null {
  const { cx, cy, cz, w, h, rotationDeg, cam, compW, compH } = opts
  if (!cam) return null
  const r = deg2rad(rotationDeg)
  const cos = Math.cos(r), sin = Math.sin(r)
  // local corners (y-up, centered), rotated in-plane then placed in world
  const local: [number, number][] = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
  const world = local.map(([lx, ly]) => [
    cx + lx * cos - ly * sin,
    cy + lx * sin + ly * cos,
    cz,
  ] as [number, number, number])
  const proj = world.map(p => projectPoint(p, cam, compW, compH))
  for (const p of proj) if (!p) return null // behind camera → skip layer
  return squareToQuad(proj as [number, number][])
}
