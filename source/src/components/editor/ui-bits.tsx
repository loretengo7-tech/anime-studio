'use client'
/**
 * ANIME STUDIO — shared editor UI primitives
 */
import { ReactNode, useEffect, useRef, useState } from 'react'

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-2 mt-4 first:mt-0">
      <h3 className="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase">{children}</h3>
      {right}
    </div>
  )
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-zinc-400 w-24 shrink-0">{label}</span>
      <div className="flex-1 min-w-0 flex items-center gap-2">{children}</div>
    </div>
  )
}

function decimalsOf(step: number): number {
  const s = String(step)
  const i = s.indexOf('.')
  return i < 0 ? 0 : Math.min(4, s.length - i - 1)
}

/**
 * AE-style editable numeric value chip:
 *  - shows the current value; click (or double-tap) to type an exact value
 *  - Enter applies immediately, Esc cancels, blur commits the last valid value
 *  - ArrowUp/ArrowDown nudges by step (Shift = ×10)
 *  - horizontal drag on the chip scrubs the value (After Effects behavior)
 *  - inputMode="decimal" so mobile keyboards show the numeric pad
 */
export function NumberInput({
  value, min, max, step = 1, onChange, unit, className = '',
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  unit?: string
  className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const dragRef = useRef<{ x: number; v: number; moved: boolean } | null>(null)
  const decimals = decimalsOf(step)

  const clamp = (v: number) => Math.max(min, Math.min(max, v))

  const commit = (raw: string) => {
    const parsed = parseFloat(raw.replace(',', '.'))
    if (!Number.isNaN(parsed)) onChange(clamp(parsed))
  }

  const beginEdit = () => {
    setDraft(String(Number(value.toFixed(decimals))))
    setEditing(true)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }

  const onChipPointerDown = (e: React.PointerEvent) => {
    if (editing) return
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    dragRef.current = { x: e.clientX, v: value, moved: false }
  }
  const onChipPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.x
    if (!d.moved && Math.abs(dx) < 3) return
    d.moved = true
    const rate = step > 0 ? step : 0.1
    onChange(clamp(d.v + dx * rate * 0.5))
  }
  const onChipPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
    if (d && !d.moved) beginEdit()
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`as-mono text-[11px] w-16 text-right tabular-nums bg-black/60 border border-amber-500/70 rounded px-1 py-0.5 text-amber-200 outline-none ${className}`}
        inputMode="decimal"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onPointerDown={e => e.stopPropagation()}
        onDoubleClick={e => { e.stopPropagation(); (e.target as HTMLInputElement).select() }}
        onKeyDown={e => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(draft)
            setEditing(false)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setEditing(false)
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const cur = parseFloat(draft.replace(',', '.'))
            const base = Number.isNaN(cur) ? value : cur
            const mult = e.shiftKey ? 10 : 1
            const next = base + (e.key === 'ArrowUp' ? step * mult : -step * mult)
            setDraft(String(Number(clamp(next).toFixed(decimals))))
            onChange(clamp(next))
          }
        }}
        onBlur={() => { commit(draft); setEditing(false) }}
      />
    )
  }

  return (
    <span
      className={`as-mono text-[11px] text-zinc-300 w-16 text-right tabular-nums cursor-ew-resize hover:text-amber-300 hover:bg-white/5 rounded px-1 py-0.5 select-none ${className}`}
      title="Drag to scrub — click or double-click to type an exact value"
      onPointerDown={onChipPointerDown}
      onPointerMove={onChipPointerMove}
      onPointerUp={onChipPointerUp}
      onPointerCancel={onChipPointerUp}
      onDoubleClick={e => { e.stopPropagation(); dragRef.current = null; if (!editing) beginEdit() }}
    >
      {formatNum(value)}{unit ?? ''}
    </span>
  )
}

export function SliderRow({
  label, value, min, max, step = 1, onChange, unit, keyframed, onKeyframe, accent,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  unit?: string
  keyframed?: boolean
  onKeyframe?: () => void
  accent?: string
}) {
  return (
    <Row label={label}>
      <input
        className="as-range flex-1"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
      />
      <NumberInput value={value} min={min} max={max} step={step} onChange={onChange} unit={unit} />
      {onKeyframe && (
        <button
          className={`w-6 h-6 flex items-center justify-center shrink-0 ${keyframed ? 'opacity-100' : 'opacity-50'}`}
          onClick={onKeyframe}
          aria-label={`Keyframe ${label}`}
        >
          <span
            className="as-kf"
            style={{ background: keyframed ? (accent ?? '#f59e0b') : 'transparent', borderColor: keyframed ? (accent ?? '#f59e0b') : '#71717a' }}
          />
        </button>
      )}
    </Row>
  )
}

export function formatNum(n: number): string {
  if (Math.abs(n) >= 1000) return Math.round(n).toString()
  if (Number.isInteger(n)) return n.toString()
  return n.toFixed(Math.abs(n) < 10 ? 2 : 1)
}

export function timecode(t: number, fps: number): string {
  const sign = t < 0 ? '-' : ''
  const abs = Math.abs(t)
  const s = Math.floor(abs)
  const f = Math.floor((abs - s) * fps)
  const m = Math.floor(s / 60)
  const ss = s % 60
  return `${sign}${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}.${f.toString().padStart(fps > 99 ? 3 : 2, '0')}`
}

/** Renders a waveform into a canvas (peaks normalized 0..1). */
export function Waveform({ peaks, color = '#a1a1aa', height = 40 }: { peaks: number[]; color?: string; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const w = canvas.width = Math.max(64, peaks.length)
    const h = canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = color
    for (let i = 0; i < peaks.length; i++) {
      const v = peaks[i] * (h / 2 - 1)
      ctx.fillRect(i, h / 2 - v, 1, Math.max(1, v * 2))
    }
  }, [peaks, color, height])
  if (peaks.length === 0) return null
  return <canvas ref={ref} className="as-wave w-full h-full" style={{ height }} />
}

export function StatusChip({ status }: { status: 'full' | 'partial' | 'awaiting' | 'none' }) {
  const map = {
    full: { label: 'Fully implemented', cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
    partial: { label: 'Partial', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
    awaiting: { label: 'Awaiting integration', cls: 'bg-violet-500/15 text-violet-400 border-violet-500/30' },
    none: { label: 'Not implemented', cls: 'bg-red-500/15 text-red-400 border-red-500/30' },
  } as const
  const s = map[status]
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border ${s.cls}`}>{s.label}</span>
}
