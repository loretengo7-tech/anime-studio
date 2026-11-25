'use client'
/**
 * ANIME STUDIO — Audio panel: beat detection, BPM, markers, beat-synced effects,
 * waveform view, and honest modular vocal/instrumental stem separation.
 */
import { useState } from 'react'
import type { AudioClip, VideoClip, AssetMeta } from '@/lib/engine/types'
import { useEditorStore } from '@/lib/store/editorStore'
import { detectBeats } from '@/lib/engine/audio'
import { SectionTitle, Row, Waveform } from './ui-bits'
import { Loader2, Activity, Mic2 } from 'lucide-react'
import { uid, makeClipBase } from '@/lib/engine/types'
import { playbackEngine } from '@/lib/engine/playback'
import { STATIC_MODE } from '@/lib/media/staticMode'

export function AudioPanel() {
  const doc = useEditorStore(s => s.doc)
  const mutate = useEditorStore(s => s.mutate)
  const toast = useEditorStore(s => s.toast)
  const beatsDetecting = useEditorStore(s => s.beatsDetecting)
  const setBeatsDetecting = useEditorStore(s => s.setBeatsDetecting)
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const selectedClip = doc.clips.find(c => c.id === selectedClipId)

  // pick audio source: selected audio clip's asset, else first audio clip asset, else first audio asset
  const audioAssetId = (() => {
    if (selectedClip && (selectedClip.kind === 'audio' || selectedClip.kind === 'video')) {
      return (selectedClip as AudioClip).assetId
    }
    const firstAudioClip = doc.clips.find(c => c.kind === 'audio') as AudioClip | undefined
    if (firstAudioClip) return firstAudioClip.assetId
    const asset = doc.assets.find(a => a.kind === 'audio')
    return asset?.id
  })()
  const asset = doc.assets.find(a => a.id === audioAssetId)

  const runBeatDetect = async () => {
    if (!asset) {
      toast({ kind: 'error', title: 'No audio asset found', detail: 'Import music and add it to the timeline' })
      return
    }
    setBeatsDetecting(true)
    try {
      const { beats, bpm } = await detectBeats(asset.url)
      if (beats.length === 0) {
        toast({ kind: 'error', title: 'No beats found', detail: 'Audio may be too quiet or not rhythmic' })
      } else {
        mutate(d => { d.beats = beats; d.bpm = bpm })
        toast({ kind: 'success', title: `${beats.length} beats detected`, detail: `Estimated BPM: ${bpm || '—'}` })
      }
    } catch (e) {
      toast({ kind: 'error', title: 'Beat detection failed', detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setBeatsDetecting(false)
    }
  }

  const snapCutsToBeats = () => {
    if (doc.beats.length === 0) return
    mutate(d => {
      for (const clip of d.clips) {
        // move clip starts to the nearest beat within 0.6s
        const nearest = d.beats.reduce((best, b) => Math.abs(b - clip.start) < Math.abs(best - clip.start) ? b : best, d.beats[0])
        if (Math.abs(nearest - clip.start) < 0.6) clip.start = Math.max(0, nearest)
      }
    })
    toast({ kind: 'success', title: 'Clip starts snapped to beats' })
  }

  const syncGlowToBeats = () => {
    const clipId = selectedClip?.id ?? doc.clips.find(c => c.kind === 'video')?.id
    if (!clipId) { toast({ kind: 'error', title: 'No video clip to sync' }); return }
    if (doc.beats.length === 0) { toast({ kind: 'error', title: 'Run Beat Detect first' }); return }
    const { applyAIOperations } = useEditorStore.getState()
    const { applied, errors } = applyAIOperations(
      [{ op: 'sync_effects_to_beats', clipId, effect: 'glow', params: { threshold: 0.5, intensity: 1.1, radius: 14 } } as never],
      'auto',
      'beat-synced glow'
    )
    if (errors.length) toast({ kind: 'error', title: 'Sync failed', detail: errors.join('; ') })
    else toast({ kind: 'success', title: applied[0] ?? 'Synced' })
  }

  // ---- vocal / instrumental separation (real Demucs via local server) ----
  const [stemBusy, setStemBusy] = useState(false)
  const runStemSeparation = async () => {
    if (!asset) { toast({ kind: 'error', title: 'No audio asset selected' }); return }
    setStemBusy(true)
    try {
      const res = await fetch('/api/stems', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: asset.id }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.detail ? `${json.error}: ${json.detail}` : json.error ?? 'server error')
      // register both stems as project assets + import them to the timeline
      const mk = (id: string, url: string, suffix: string): AssetMeta => ({
        id, name: `${asset.name} — ${suffix}`, kind: 'audio', url,
        duration: asset.duration, width: 0, height: 0, fps: 0, size: 0,
      })
      const vocalsMeta = mk(json.vocalsId, json.vocalsUrl, 'vocals')
      const instMeta = mk(json.instrumentalId, json.instrumentalUrl, 'instrumental')
      mutate(d => {
        d.assets.push(vocalsMeta, instMeta)
        const track = d.tracks.find(t => t.kind === 'audio' && !t.locked)
        if (track) {
          const at = playbackEngine.currentTime
          d.clips.push({
            ...makeClipBase(track.id, vocalsMeta.name, at, Math.max(0.5, vocalsMeta.duration)),
            kind: 'audio', assetId: vocalsMeta.id, inPoint: 0, fadeIn: 0, fadeOut: 0, volume: 1,
          })
          d.clips.push({
            ...makeClipBase(track.id, instMeta.name, at, Math.max(0.5, instMeta.duration)),
            kind: 'audio', assetId: instMeta.id, inPoint: 0, fadeIn: 0, fadeOut: 0, volume: 1,
          })
        }
      })
      void import('@/lib/media/mediaManager').then(({ mediaManager }) => {
        mediaManager.registerAsset(vocalsMeta)
        mediaManager.registerAsset(instMeta)
      })
      toast({ kind: 'success', title: 'Stems ready', detail: 'Vocals + instrumental added as separate audio tracks' })
    } catch (e) {
      toast({ kind: 'error', title: 'Stem separation unavailable', detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setStemBusy(false)
    }
  }

  return (
    <div className="p-3 pb-10">
      <SectionTitle>Audio analysis</SectionTitle>
      <div className="text-[11px] text-zinc-400 mb-2">
        Source: {asset ? asset.name : 'no audio asset'} {doc.bpm > 0 && <span className="text-emerald-400">· {doc.bpm} BPM · {doc.beats.length} beats</span>}
      </div>
      {asset?.peaks && asset.peaks.length > 0 && (
        <div className="rounded-lg border glass-soft p-2 mb-3 relative">
          <Waveform peaks={asset.peaks} color="#34d399" height={64} />
          {doc.beats.length > 0 && (
            <div className="absolute inset-x-2 bottom-2 top-2 pointer-events-none">
              {doc.beats.slice(0, 400).map((b, i) => {
                const x = (b / Math.max(0.01, asset.duration)) * 100
                return <div key={i} className="absolute top-0 bottom-0 w-px bg-amber-400/50" style={{ left: `${x}%` }} />
              })}
            </div>
          )}
        </div>
      )}
      <button
        className="w-full py-2.5 rounded-lg bg-emerald-500 text-black text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
        onClick={() => void runBeatDetect()}
        disabled={beatsDetecting}
      >
        {beatsDetecting ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />}
        {beatsDetecting ? 'Analyzing audio…' : doc.beats.length > 0 ? 'Re-run beat detection' : 'Beat detect (onset + BPM)'}
      </button>

      <SectionTitle>Beat actions</SectionTitle>
      <div className="grid grid-cols-1 gap-2">
        <button className="py-2.5 rounded-lg border border-zinc-700 text-sm text-zinc-200" onClick={snapCutsToBeats} disabled={doc.beats.length === 0}>Snap clip starts to beats</button>
        <button className="py-2.5 rounded-lg border border-zinc-700 text-sm text-zinc-200" onClick={syncGlowToBeats} disabled={doc.beats.length === 0}>Pulse glow on every beat (selected clip)</button>
        <button className="py-2.5 rounded-lg border border-zinc-700 text-sm text-zinc-200" onClick={() => {
          mutate(d => {
            for (const b of d.beats.filter(b => b <= d.composition.duration)) {
              if (!d.markers.some(m => Math.abs(m.time - b) < 0.01)) {
                d.markers.push({ id: uid('m'), time: b, label: 'beat', color: '#f59e0b' })
              }
            }
          })
          toast({ kind: 'info', title: 'Beat markers added to timeline' })
        }} disabled={doc.beats.length === 0}>Show beats as timeline markers</button>
      </div>

      <SectionTitle>Playback</SectionTitle>
      <Row label="Mute all">
        <button className="text-xs px-3 py-1.5 rounded glass-soft border border-zinc-700" onClick={() => { const m = playbackEngine.toggleMute(); toast({ kind: 'info', title: m ? 'Muted' : 'Unmuted' }) }}>
          Toggle
        </button>
      </Row>

      <SectionTitle>Vocals / Instrumental</SectionTitle>
      <button
        className="w-full py-2.5 rounded-lg border border-violet-400/40 text-violet-200 text-sm flex items-center justify-center gap-2 disabled:opacity-60"
        onClick={() => void runStemSeparation()}
        disabled={stemBusy}
      >
        {stemBusy ? <Loader2 size={14} className="animate-spin" /> : <Mic2 size={14} />}
        {stemBusy ? 'Separating (Demucs model)…' : 'Separate vocals from instrumental'}
      </button>
      <p className="text-[10px] text-zinc-600 mt-2 leading-relaxed">
        {STATIC_MODE
          ? 'You are on the static app (PWA/Pages): separation runs on a server, so it is unavailable here. Options: run the editor locally (npm run dev + pip install demucs) or import pre-separated stems as two audio files — both appear as independent tracks.'
          : 'Real source separation with Meta Demucs. Needs Python on the server: pip install demucs. First run downloads the model (~80 MB). Two independent tracks are added to the timeline.'}
      </p>

      <p className="text-[10px] text-zinc-600 mt-2">
        Audio mixes through WebAudio: per-clip effect chains (bass/treble/reverb/compressor), keyframed volume and fades. iOS requires one tap on the player before sound starts — normal Safari behavior.
      </p>
    </div>
  )
}
