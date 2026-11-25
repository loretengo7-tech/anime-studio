'use client'
/**
 * ANIME STUDIO — Beat Sync panel: analyze a song layer, then turn its beats
 * into real keyframes (zoom punch, shake, RGB split, glow), flash frames,
 * jump cuts and markers on the selected layers.
 */
import { useEffect, useMemo, useState } from 'react'
import type { AudioClip, VideoClip, Clip } from '@/lib/engine/types'
import { useEditorStore } from '@/lib/store/editorStore'
import { playbackEngine } from '@/lib/engine/playback'
import { analyzeBeats, hitsInComp, applyBeatSync, type BeatAnalysis, type BeatSyncOptions } from '@/lib/engine/beatsync'
import { Activity, Loader2, Music } from 'lucide-react'

const DEFAULTS: BeatSyncOptions = { mode: 'beats', every: 1, offset: 0, intensity: 1, decay: 0.18, flash: true, zoom: true, shake: false, rgb: false, glow: false, cuts: false, markers: true }

export function BeatSyncPanel() {
  const doc = useEditorStore(s => s.doc)
  const selectedClipIds = useEditorStore(s => s.selectedClipIds)
  const mutate = useEditorStore(s => s.mutate)
  const toast = useEditorStore(s => s.toast)
  const sources = doc.clips.filter(c => c.kind === 'audio' || c.kind === 'video') as (AudioClip | VideoClip)[]
  const [srcId, setSrcId] = useState<string>(() => (sources.find(s => s.kind === 'audio') ?? sources[0])?.id ?? '')
  const [sens, setSens] = useState(1.3)
  const [busy, setBusy] = useState(false)
  const [an, setAn] = useState<BeatAnalysis | null>(null)
  const [o, setO] = useState<BeatSyncOptions>(DEFAULTS)
  useEffect(() => { if (!sources.find(s => s.id === srcId) && sources[0]) setSrcId(sources[0].id) }, [sources, srcId])
  const src = sources.find(s => s.id === srcId) ?? null
  const asset = src ? doc.assets.find(a => a.id === src.assetId) : null
  const hits = useMemo(() => (an && src ? hitsInComp(an, src, o) : []), [an, src, o])
  const targets = selectedClipIds.filter(id => doc.clips.find(c => c.id === id)?.kind !== 'audio')

  const analyze = async () => {
    if (!asset) return
    setBusy(true)
    try {
      const a = await analyzeBeats(asset.url, sens)
      setAn(a)
      toast({ kind: 'success', title: `${a.bpm} BPM · ${a.beats.length} beats · ${a.onsets.length} hits` })
    } catch (e) {
      toast({ kind: 'error', title: 'Beat analysis failed', detail: e instanceof Error ? e.message : String(e) })
    } finally { setBusy(false) }
  }
  const apply = () => {
    if (!hits.length) return
    if (!targets.length && !o.flash && !o.markers) { toast({ kind: 'error', title: 'Select the layers to animate', detail: 'Or keep only Flash / Markers on' }); return }
    let msg = ''
    mutate(d => { msg = applyBeatSync(d, hits, targets, o) })
    toast({ kind: 'success', title: 'Beat Sync applied', detail: `${msg} — Ctrl+Z to undo` })
  }
  const set = <K extends keyof BeatSyncOptions>(k: K, v: BeatSyncOptions[K]) => setO(p => ({ ...p, [k]: v }))
  const chk = (k: keyof BeatSyncOptions, label: string, hint: string) => (
    <label className="flex items-start gap-2 py-1 cursor-pointer" title={hint}>
      <input type="checkbox" className="mt-0.5" checked={o[k] as boolean} onChange={e => set(k, e.target.checked as never)} />
      <span><span className="text-zinc-200">{label}</span><span className="block text-[10px] text-zinc-500">{hint}</span></span>
    </label>
  )
  const dur = src ? src.duration : 0
  return (
    <div className="p-3 text-[12px] space-y-3">
      <div>
        <h3>Song</h3>
        {sources.length === 0 ? <p className="text-zinc-500">Add a song (audio) or video layer to the timeline first.</p> : (
          <div className="flex gap-2">
            <select className="ginput flex-1 min-w-0" value={srcId} onChange={e => { setSrcId(e.target.value); setAn(null) }}>
              {sources.map(s => <option key={s.id} value={s.id}>{s.kind === 'audio' ? '♪' : '▶'} {s.name}</option>)}
            </select>
            <button className="gbtn gbtn-accent px-3" disabled={busy || !asset} onClick={() => void analyze()}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />} {an ? 'Re-analyze' : 'Analyze'}
            </button>
          </div>
        )}
        <label className="flex items-center gap-2 mt-2 text-zinc-400">Sensitivity
          <input type="range" className="as-range flex-1" min={1} max={2.2} step={0.05} value={2.3 - sens} onChange={e => { setSens(2.3 - +e.target.value); setAn(null) }} />
        </label>
      </div>

      {an && src && (
        <div>
          <div className="flex items-center gap-2 text-zinc-400 mb-1"><Music size={12} /> <span className="text-[#3ccf55] font-semibold">{an.bpm} BPM</span> · {hits.length} hits in this layer</div>
          <div className="relative h-10 bg-[#161616] border border-[#333] overflow-hidden cursor-pointer"
            onClick={e => { const r = e.currentTarget.getBoundingClientRect(); playbackEngine.pause(); playbackEngine.seek(src.start + ((e.clientX - r.left) / r.width) * dur) }}>
            {hits.map((h, i) => (
              <span key={i} className="absolute bottom-0 w-px" style={{ left: `${((h.t - src.start) / Math.max(0.01, dur)) * 100}%`, height: `${20 + h.s * 80}%`, background: h.s > 0.8 ? '#3ccf55' : '#8aa' }} />
            ))}
          </div>
        </div>
      )}

      <div>
        <h3>Hits</h3>
        <div className="grid grid-cols-3 gap-1">
          {(['beats', 'downbeats', 'onsets'] as const).map(m => (
            <button key={m} className={`gbtn py-1 text-[11px] ${o.mode === m ? '!border-amber-500 !text-amber-300' : ''}`} onClick={() => set('mode', m)}>
              {m === 'beats' ? 'Every beat' : m === 'downbeats' ? 'Downbeats (1)' : 'Every hit'}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-[90px_1fr_40px] items-center gap-x-2 gap-y-1.5 mt-2 text-zinc-400">
          <span>Every N</span><input type="range" className="as-range" min={1} max={8} step={1} value={o.every} onChange={e => set('every', +e.target.value)} /><span className="as-mono">{o.every}</span>
          <span>Offset</span><input type="range" className="as-range" min={-0.1} max={0.1} step={0.005} value={o.offset} onChange={e => set('offset', +e.target.value)} /><span className="as-mono">{Math.round(o.offset * 1000)}ms</span>
          <span>Intensity</span><input type="range" className="as-range" min={0.1} max={2} step={0.05} value={o.intensity} onChange={e => set('intensity', +e.target.value)} /><span className="as-mono">{o.intensity.toFixed(2)}</span>
          <span>Decay</span><input type="range" className="as-range" min={0.05} max={0.6} step={0.01} value={o.decay} onChange={e => set('decay', +e.target.value)} /><span className="as-mono">{o.decay.toFixed(2)}s</span>
        </div>
      </div>

      <div>
        <h3>On each hit</h3>
        {chk('flash', 'Flash', 'White add-flash layer on top (opacity keyframes)')}
        {chk('zoom', 'Zoom punch', 'Scale pops and eases back — selected layers')}
        {chk('shake', 'Shake', 'Decaying camera shake — selected layers')}
        {chk('rgb', 'RGB split', 'Prism / Chromatic Aberration spike')}
        {chk('glow', 'Glow pulse', 'Deep Glow exposure pulse')}
        {chk('cuts', 'Jump cuts', 'Split the selected layers at every hit (AMV cuts)')}
        {chk('markers', 'Markers', 'Green comp markers on the hits')}
      </div>

      <button className="gbtn gbtn-accent w-full py-2" disabled={!hits.length} onClick={apply}>
        Apply to {targets.length ? `${targets.length} selected layer${targets.length > 1 ? 's' : ''}` : 'comp (flash / markers)'}
      </button>
      <p className="text-[10px] text-zinc-500">Everything becomes normal keyframes and layers — tweak them in the timeline or Graph Editor. Ctrl+Z undoes the whole sync.</p>
    </div>
  )
}

export type { Clip }
