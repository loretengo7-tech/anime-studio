'use client'
/**
 * ANIME STUDIO — Export dialog: real rendering with honest progress
 */
import { useRef, useState } from 'react'
import { useEditorStore } from '@/lib/store/editorStore'
import { projectDuration } from '@/lib/engine/types'
import { exportComposition } from '@/lib/engine/exporter'
import type { ExportSettings, ExportResult, ExportProgress } from '@/lib/engine/exporter'
import { ENHANCE_PRESETS } from '@/lib/engine/enhance'
import type { EnhancePreset } from '@/lib/engine/enhance'
import { playbackEngine } from '@/lib/engine/playback'
import { SectionTitle, Row } from './ui-bits'
import { Loader2, Download, TriangleAlert } from 'lucide-react'

const RES_PRESETS = [
  { label: '720p', w: 1280, h: 720 },
  { label: '1080p', w: 1920, h: 1080 },
  { label: '1440p', w: 2560, h: 1440 },
  { label: '4K', w: 3840, h: 2160 },
]

export function ExportDialog() {
  const doc = useEditorStore(s => s.doc)
  const toast = useEditorStore(s => s.toast)
  const duration = projectDuration(doc)
  const [settings, setSettings] = useState<ExportSettings>({
    format: 'auto',
    width: doc.composition.width,
    height: doc.composition.height,
    fps: doc.composition.fps,
    quality: 'medium',
    enhancePreset: null,
    engine: 'auto',
  })
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cancelledRef = useRef(false)

  const start = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    cancelledRef.current = false
    playbackEngine.pause()
    // stop the preview loop: it shares the <video> elements with the exporter
    playbackEngine.setSuspended(true)
    try {
      const res = await exportComposition(doc, settings, setProgress, () => cancelledRef.current)
      setResult(res)
      // debug/testing handle: last export result inspectable from the console
      ;(window as unknown as Record<string, unknown>).__AS = {
        ...((window as unknown as Record<string, unknown>).__AS ?? {}),
        lastExport: res,
      }
      toast({ kind: 'success', title: 'Export complete', detail: `${(res.sizeBytes / 1024 / 1024).toFixed(1)}MB · ${res.engine}` })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      setProgress({ phase: 'error', progress: 0, message: msg, error: msg })
      toast({ kind: 'error', title: 'Export failed', detail: msg })
    } finally {
      playbackEngine.setSuspended(false)
      setBusy(false)
    }
  }

  const download = () => {
    if (!result) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(result.blob)
    const ext = result.mimeType.includes('mp4') ? 'mp4' : 'webm'
    a.download = `${doc.name.replace(/\s+/g, '_')}_${result.width}x${result.height}.${ext}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  }

  const downloadWav = () => {
    if (!result?.audioWav) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(result.audioWav)
    a.download = `${doc.name.replace(/\s+/g, '_')}_audio.wav`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  }

  return (
    <div className="p-3 pb-10">
      <SectionTitle>Render & export</SectionTitle>
      <div className="text-[10px] text-zinc-500 mb-2 as-mono">{duration.toFixed(1)}s · {doc.clips.length} clips</div>

      <Row label="Resolution">
        <select
          className="flex-1 text-xs ginput rounded px-2 py-1.5"
          value={`${settings.width}`}
          onChange={e => {
            const p = RES_PRESETS.find(r => r.w === parseInt(e.target.value))
            if (p) setSettings(s => ({ ...s, width: p.w, height: p.h }))
          }}
        >
          {RES_PRESETS.map(p => <option key={p.label} value={p.w}>{p.label} ({p.w}×{p.h})</option>)}
          <option value={doc.composition.width}>Comp ({doc.composition.width}×{doc.composition.height})</option>
        </select>
      </Row>
      <Row label="Format">
        <select className="flex-1 text-xs ginput rounded px-2 py-1.5" value={settings.format} onChange={e => setSettings(s => ({ ...s, format: e.target.value as ExportSettings['format'] }))}>
          <option value="auto">Auto (best for this browser)</option>
          <option value="mp4">MP4 (H.264)</option>
          <option value="webm">WebM (VP9)</option>
        </select>
      </Row>
      <Row label="FPS">
        <select className="flex-1 text-xs ginput rounded px-2 py-1.5" value={settings.fps} onChange={e => setSettings(s => ({ ...s, fps: parseInt(e.target.value) }))}>
          {[24, 25, 30, 48, 50, 60, 90, 120, 144, 240].map(f => <option key={f} value={f}>{f}{f > 60 ? ' (high frame rate)' : ''}</option>)}
        </select>
      </Row>
      <Row label="Quality">
        <select className="flex-1 text-xs ginput rounded px-2 py-1.5" value={settings.quality} onChange={e => setSettings(s => ({ ...s, quality: e.target.value as ExportSettings['quality'] }))}>
          <option value="low">Low (2 Mbps)</option>
          <option value="medium">Medium (6 Mbps)</option>
          <option value="high">High (12 Mbps)</option>
          <option value="ultra">Ultra (24 Mbps)</option>
        </select>
      </Row>
      <Row label="Engine">
        <select className="flex-1 text-xs ginput rounded px-2 py-1.5" value={settings.engine} onChange={e => setSettings(s => ({ ...s, engine: e.target.value as ExportSettings['engine'] }))}>
          <option value="auto">Auto</option>
          <option value="precise">Frame-accurate (WebCodecs)</option>
          <option value="realtime">Realtime capture (MediaRecorder)</option>
        </select>
      </Row>
      <Row label="Detail restore">
        <select
          className="flex-1 text-xs ginput rounded px-2 py-1.5"
          value={settings.enhancePreset ?? ''}
          onChange={e => setSettings(s => ({ ...s, enhancePreset: (e.target.value || null) as EnhancePreset | null }))}
        >
          <option value="">None</option>
          {Object.entries(ENHANCE_PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
        </select>
      </Row>

      {busy && progress && (
        <div className="mt-3 p-3 rounded-lg border border-amber-500/40 bg-amber-500/5">
          <div className="flex items-center gap-2 text-xs text-amber-200 mb-2">
            <Loader2 size={13} className="animate-spin" /> {progress.message}
          </div>
          <div className="h-2 glass-soft rounded overflow-hidden">
            <div className="h-full bg-amber-500 transition-all" style={{ width: `${Math.round(progress.progress * 100)}%` }} />
          </div>
          <button className="mt-2 text-[11px] text-red-400 underline" onClick={() => { cancelledRef.current = true }}>Cancel export</button>
        </div>
      )}

      {error && (
        <div className="mt-3 p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-xs text-red-300 flex items-start gap-2">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="mt-3 p-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5">
          <div className="text-xs text-emerald-300 font-medium mb-1">Render complete</div>
          <div className="text-[10px] text-zinc-400 as-mono">
            {result.width}×{result.height} · {result.fps}fps · {(result.sizeBytes / 1024 / 1024).toFixed(1)}MB · {result.engine} · audio: {result.audioIncluded ? 'in video' : result.audioWav ? 'separate WAV ↓' : 'no'}
          </div>
          {result.notes.length > 0 && (
            <ul className="mt-1.5 text-[10px] text-amber-300/90 list-disc pl-4">
              {result.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}
          <button className="mt-2 w-full py-2.5 rounded-lg bg-emerald-500 text-black text-sm font-semibold flex items-center justify-center gap-2" onClick={download}>
            <Download size={14} /> Download video
          </button>
          {result.audioWav && (
            <button className="mt-1.5 w-full py-2.5 rounded-lg glass-soft border border-emerald-500/50 text-emerald-300 text-sm font-medium flex items-center justify-center gap-2" onClick={downloadWav}>
              <Download size={14} /> Download audio (WAV) {result.audioWavInfo ? `· ${result.audioWavInfo}` : ''}
            </button>
          )}
        </div>
      )}

      <button
        className="mt-3 w-full py-3 rounded-lg bg-amber-500 text-black text-sm font-semibold disabled:opacity-60"
        onClick={() => void start()}
        disabled={busy || duration <= 0}
      >
        {busy ? 'Rendering…' : 'Start render'}
      </button>
      <p className="text-[10px] text-zinc-600 mt-2">
        Audio guarantee: the mix is rendered offline first. If the video container can carry it (MP4+AAC / WebM+Opus) it is embedded; if the browser can't encode audio, the full mix is delivered as a separate WAV — the sound always comes out, never silently dropped.
      </p>
    </div>
  )
}
