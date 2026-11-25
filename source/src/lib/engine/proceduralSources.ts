/**
 * ANIME STUDIO — procedural layer sources (Solid & Shape layers)
 *
 * Renders solid colors and vector shapes into offscreen canvases at
 * COMPOSITION resolution so the compositor's default fit-scale places them
 * 1:1 in comp space (the user then transforms them like any other layer).
 * Canvases are cached per clip and invalidated when the visual signature
 * changes.
 */

const solidCache = new Map<string, { sig: string; canvas: HTMLCanvasElement }>()
const shapeCache = new Map<string, { sig: string; canvas: HTMLCanvasElement }>()

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.arcTo(x + w, y, x + w, y + rr, rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr)
  ctx.lineTo(x + rr, y + h)
  ctx.arcTo(x, y + h, x, y + h - rr, rr)
  ctx.lineTo(x, y + rr)
  ctx.arcTo(x, y, x + rr, y, rr)
  ctx.closePath()
}

export function getSolidCanvas(clipId: string, color: string, w: number, h: number): HTMLCanvasElement | null {
  const sig = `${color}|${w}x${h}`
  const hit = solidCache.get(clipId)
  if (hit && hit.sig === sig) return hit.canvas
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, w)
  canvas.height = Math.max(2, h)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = color
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  solidCache.set(clipId, { sig, canvas })
  return canvas
}

export function getShapeCanvas(
  clipId: string,
  shape: { type: 'rect' | 'ellipse' | 'polygon'; sides?: number; width: number; height: number; fill: string; stroke: string; strokeWidth: number; cornerRadius: number },
  w: number,
  h: number
): HTMLCanvasElement | null {
  const sig = JSON.stringify(shape) + `|${w}x${h}`
  const hit = shapeCache.get(clipId)
  if (hit && hit.sig === sig) return hit.canvas
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, w)
  canvas.height = Math.max(2, h)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const cx = canvas.width / 2
  const cy = canvas.height / 2
  const hw = Math.max(1, shape.width / 2)
  const hh = Math.max(1, shape.height / 2)
  ctx.beginPath()
  if (shape.type === 'rect') {
    roundedRectPath(ctx, cx - hw, cy - hh, hw * 2, hh * 2, shape.cornerRadius)
  } else if (shape.type === 'ellipse') {
    ctx.ellipse(cx, cy, hw, hh, 0, 0, Math.PI * 2)
  } else {
    const sides = Math.max(3, Math.min(24, Math.round(shape.sides ?? 6)))
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 - Math.PI / 2
      const px = cx + Math.cos(a) * hw
      const py = cy + Math.sin(a) * hh
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.closePath()
  }
  if (shape.strokeWidth > 0) {
    ctx.strokeStyle = shape.stroke
    ctx.lineWidth = shape.strokeWidth
    ctx.stroke()
  }
  if (shape.fill !== 'none') {
    ctx.fillStyle = shape.fill
    ctx.fill()
  }
  shapeCache.set(clipId, { sig, canvas })
  return canvas
}

export function disposeProcedural(clipId: string) {
  solidCache.delete(clipId)
  shapeCache.delete(clipId)
}
