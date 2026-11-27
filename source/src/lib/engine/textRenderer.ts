/**
 * ANIME STUDIO — Text layer renderer
 *
 * Draws animated text into an offscreen 2D canvas (consumed by the compositor
 * as a texture). Animation presets are evaluated per frame; several presets
 * support per-character stagger (AE text-animator style, simplified as a
 * uniform range selector across the whole text).
 *
 * Fonts: `text.font` is a CSS font-family string — both the built-in device
 * families and custom fonts registered through the FontFace API (fonts.ts)
 * render correctly through canvas.
 */
import type { TextClip } from './types'

const cache = new Map<string, { canvas: HTMLCanvasElement; sig: string }>()

export const TEXT_ANIMATIONS = [
  'none', 'fadeIn', 'slideUp', 'slideLeft', 'pop', 'zoomIn',
  'typewriter', 'shake', 'karaoke', 'bounce', 'wave',
  'trackingIn', 'rotateIn', 'blurIn',
] as const

/** Presets drawn character-by-character (stagger applies). */
const CHAR_ANIMATIONS = new Set(['fadeIn', 'slideUp', 'slideLeft', 'pop', 'zoomIn', 'bounce', 'rotateIn', 'trackingIn', 'blurIn'])

export function renderTextCanvas(clip: TextClip, localTime: number, fps: number): HTMLCanvasElement | null {
  const t = clip.text
  const animDur = Math.max(0.01, t.animationDuration)
  const stagger = Math.max(0, Math.min(0.9, t.stagger ?? 0))
  // only animated text depends on the frame; static text is drawn ONCE
  // (it used to be redrawn + re-uploaded to the GPU on every frame)
  const animated = !!t.animation && t.animation !== 'none' && localTime <= animDur * (1 + stagger * Math.max(1, t.content.length)) + 0.5
  const frame = animated ? Math.floor(localTime * fps) : -1
  const grad = t.gradient
  const sig = [
    clip.id, frame, t.content, t.size, t.color, t.font, t.weight,
    t.strokeColor, t.strokeWidth, t.animation, t.align, t.letterSpacing,
    t.shadow, t.shadowColor ?? '', t.shadowBlur ?? -1, t.shadowOffsetX ?? 0, t.shadowOffsetY ?? 0,
    grad ? `${grad.enabled}|${grad.color2}|${grad.angle}` : '', t.stagger ?? 0,
    clip.scale, clip.opacity, animDur,
  ].join('|')
  const cached = cache.get(clip.id)
  if (cached && cached.sig === sig) return cached.canvas

  const dpr = 1
  const pad = Math.ceil(t.size * 1.4)
  const lines = t.content.split('\n')
  const meas = document.createElement('canvas').getContext('2d')!
  const fontStr = `${t.weight} ${t.size * dpr}px ${t.font}`
  meas.font = fontStr
  let maxW = 0
  for (const ln of lines) maxW = Math.max(maxW, meas.measureText(ln).width + t.letterSpacing * Math.max(0, ln.length - 1))

  const W = Math.max(8, Math.ceil(maxW + pad * 2))
  const H = Math.max(8, Math.ceil(lines.length * t.size * 1.3 + pad * 2))
  let canvas: HTMLCanvasElement
  // FIX: the canvas must be EXACTLY the text block. Re-using a bigger one after
  // shortening the text changed the layer's size/anchor → text jumped around.
  if (cached && cached.canvas.width === W && cached.canvas.height === H) {
    canvas = cached.canvas
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  } else {
    canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
  }
  const ctx = canvas.getContext('2d')!
  ctx.font = fontStr
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  if (t.letterSpacing) {
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${t.letterSpacing}px`
  }

  const cx = W / 2, cy = H / 2
  const shadowColor = t.shadowColor ?? 'rgba(0,0,0,0.75)'
  const shadowBlur = t.shadow ? (t.shadowBlur ?? t.size * 0.25) : 0
  const shadowOX = t.shadow ? (t.shadowOffsetX ?? 0) : 0
  const shadowOY = t.shadow ? (t.shadowOffsetY ?? t.size * 0.06) : 0

  // gradient paint across the whole block (angle in degrees, 0 = left→right)
  let paint: string | CanvasGradient = t.color
  if (grad?.enabled) {
    const rad = (grad.angle * Math.PI) / 180
    const dx = Math.cos(rad), dy = -Math.sin(rad)
    const len = Math.max(Math.abs(dx) * W, Math.abs(dy) * H)
    const g = ctx.createLinearGradient(cx - dx * len / 2, cy - dy * len / 2, cx + dx * len / 2, cy + dy * len / 2)
    g.addColorStop(0, t.color)
    g.addColorStop(1, grad.color2)
    paint = g
  }

  const applyShadow = () => {
    if (t.shadow) {
      ctx.shadowColor = shadowColor
      ctx.shadowBlur = shadowBlur
      ctx.shadowOffsetX = shadowOX
      ctx.shadowOffsetY = shadowOY
    } else {
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetX = 0
      ctx.shadowOffsetY = 0
    }
  }

  const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3)
  const easeOutBack = (x: number) => {
    const c1 = 1.70158, c3 = c1 + 1
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
  }
  const easeOutBounce = (x: number) => {
    const n1 = 7.5625, d1 = 2.75
    if (x < 1 / d1) return n1 * x * x
    if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75
    if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375
    return n1 * (x -= 2.625 / d1) * x + 0.984375
  }

  // whole-block animation envelope (used by shake / wave / karaoke / typewriter)
  const blockProgress = Math.min(1, localTime / animDur)
  const blockEased = easeOutCubic(blockProgress)
  ctx.save()
  let blockAlpha = 1
  if (t.animation === 'fadeIn') blockAlpha = blockEased
  else if (t.animation === 'shake') {
    const amp = (1 - blockProgress) * t.size * 0.25
    ctx.translate(Math.sin(localTime * 60) * amp, Math.cos(localTime * 47) * amp)
    blockAlpha = blockEased
  } else if (t.animation === 'karaoke') blockAlpha = blockEased
  ctx.globalAlpha = blockAlpha

  // anchor X per alignment (chars are drawn left-aligned manually for staggering)
  const totalChars = lines.reduce((n, l) => n + l.length, 0)
  let charCounter = 0

  lines.forEach((ln, li) => {
    const y = pad + t.size * 0.65 + li * t.size * 1.3
    const lineW = meas.measureText(ln).width + t.letterSpacing * Math.max(0, ln.length - 1)
    let x = t.align === 'left' ? pad : t.align === 'right' ? W - pad - lineW : cx - lineW / 2

    if (t.animation === 'typewriter') {
      const chars = Math.floor(ln.length * Math.min(1, localTime / Math.max(0.1, animDur * 0.8)))
      const text = ln.slice(0, chars)
      applyShadow()
      if (t.strokeWidth > 0) { ctx.lineWidth = t.strokeWidth; ctx.strokeStyle = t.strokeColor; ctx.lineJoin = 'round'; ctx.strokeText(text, x, y) }
      ctx.fillStyle = paint
      ctx.fillText(text, x, y)
      charCounter += ln.length
      return
    }
    if (t.animation === 'karaoke') {
      const words = ln.split(' ')
      const done = Math.floor(words.length * blockProgress)
      applyShadow()
      ctx.fillStyle = paint
      ctx.fillText(ln, x, y)
      ctx.save()
      ctx.shadowColor = 'transparent'
      ctx.fillStyle = '#ffd166'
      ctx.fillText(words.slice(0, done).join(' '), x, y)
      ctx.restore()
      charCounter += ln.length
      return
    }

    // ---- per-character rendering (stagger + char presets + wave) ----
    const perChar = t.animation === 'wave' || CHAR_ANIMATIONS.has(t.animation)
    if (!perChar) {
      applyShadow()
      if (t.strokeWidth > 0) { ctx.lineWidth = t.strokeWidth; ctx.strokeStyle = t.strokeColor; ctx.lineJoin = 'round'; ctx.strokeText(ln, x, y) }
      ctx.fillStyle = paint
      ctx.fillText(ln, x, y)
      charCounter += ln.length
      return
    }

    const chars = Array.from(ln)
    for (let ci = 0; ci < chars.length; ci++) {
      const ch = chars[ci]
      const idx = charCounter + ci
      const delay = (idx / Math.max(1, totalChars)) * stagger * animDur
      const p = Math.max(0, Math.min(1, (localTime - delay) / animDur))
      const e = easeOutCubic(p)
      const chW = meas.measureText(ch).width
      const chCx = x + chW / 2 + t.letterSpacing / 2
      ctx.save()
      ctx.translate(chCx, y)
      let alpha = 1
      if (t.animation === 'fadeIn') alpha = e
      else if (t.animation === 'slideUp') { ctx.translate(0, (1 - e) * t.size * 1.5); alpha = e }
      else if (t.animation === 'slideLeft') { ctx.translate((1 - e) * t.size * 2.2, 0); alpha = e }
      else if (t.animation === 'pop') { const s = 0.6 + 0.4 * easeOutBack(p); ctx.scale(s, s); alpha = Math.min(1, p * 2.5) }
      else if (t.animation === 'zoomIn') { const s = 0.4 + 0.6 * e; ctx.scale(s, s); alpha = e }
      else if (t.animation === 'bounce') { ctx.translate(0, -(1 - easeOutBounce(p)) * t.size * 1.6); alpha = Math.min(1, p * 3) }
      else if (t.animation === 'rotateIn') { ctx.rotate((1 - e) * Math.PI * 0.75); ctx.scale(e || 0.001, e || 0.001); alpha = e }
      else if (t.animation === 'trackingIn') {
        // letters converge from a spread-out start into their final tracking
        ctx.translate((1 - e) * (idx - totalChars / 2) * t.size * 0.14, 0)
        alpha = e
      }
      else if (t.animation === 'blurIn') alpha = e
      else if (t.animation === 'wave') {
        ctx.translate(0, Math.sin(localTime * 7 - idx * 0.55) * t.size * 0.18)
      }
      ctx.globalAlpha = Math.max(0, Math.min(1, blockAlpha * alpha))
      if (t.animation === 'blurIn') {
        const blur = (1 - e) * Math.max(1, t.size * 0.16)
        if (blur > 0.25) ctx.filter = `blur(${blur.toFixed(2)}px)`
      }
      applyShadow()
      if (t.strokeWidth > 0) { ctx.lineWidth = t.strokeWidth; ctx.strokeStyle = t.strokeColor; ctx.lineJoin = 'round'; ctx.strokeText(ch, 0, 0) }
      ctx.fillStyle = paint
      ctx.fillText(ch, 0, 0)
      ctx.restore()
      ctx.filter = 'none'
      x += chW + t.letterSpacing
    }
    charCounter += ln.length
  })
  ctx.restore()

  ;(canvas as HTMLCanvasElement & { __asVer?: number }).__asVer = ((canvas as HTMLCanvasElement & { __asVer?: number }).__asVer ?? 0) + 1
  cache.set(clip.id, { canvas, sig })
  return canvas
}

export function disposeTextCanvas(clipId: string) {
  cache.delete(clipId)
}
