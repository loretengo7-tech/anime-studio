'use client'
/**
 * Plugins panel › OpenFX: plug-ins installed on this PC (.ofx.bundle) — Sapphire, RSMB,
 * Neat Video… in their OpenFX versions. Desktop app only.
 */
import { useEffect, useState } from 'react'
import { useEditorStore } from '@/lib/store/editorStore'
import { ofxAvailable, ofxLastScan, onOfxChange, rescanOfx, addOfxFolder, openOfxFolder, type OfxScanResult } from '@/lib/engine/ofx'
import { FolderPlus, RefreshCw, FolderOpen, Loader2 } from 'lucide-react'

export function OfxSection() {
  const toast = useEditorStore(s => s.toast)
  const [scan, setScan] = useState<OfxScanResult | null>(ofxLastScan())
  const [busy, setBusy] = useState(false)
  useEffect(() => onOfxChange(() => setScan(ofxLastScan())), [])
  const run = async (fn: () => Promise<OfxScanResult | null | string>) => {
    setBusy(true)
    try { await fn() } catch (e) { toast({ kind: 'error', title: 'OpenFX', detail: e instanceof Error ? e.message : String(e) }) }
    finally { setBusy(false); setScan(ofxLastScan()) }
  }
  if (!ofxAvailable()) {
    return (
      <div className="rounded-xl glass-soft p-2.5 text-[11px] text-zinc-400 leading-4 mb-4">
        <b className="text-zinc-200">OpenFX plug-ins</b> (Sapphire, ReelSmart Motion Blur, Neat Video… in their OFX versions) work in the <b>desktop app</b> for Windows. After Effects-only plug-ins (.aex) can&apos;t be loaded by any other program.
      </div>
    )
  }
  const plugins = scan?.results.flatMap(r => r.plugins) ?? []
  const problems = scan?.results.filter(r => r.err || r.skipped.length) ?? []
  return (
    <div className="mb-5">
      <div className="flex items-center gap-1.5 mb-2">
        <div className="text-[12px] font-semibold text-zinc-200 flex-1">OpenFX plug-ins <span className="text-zinc-500 font-normal">({plugins.length})</span></div>
        {busy && <Loader2 size={13} className="animate-spin text-zinc-400" />}
        <button className="gbtn h-7 px-2 text-[11px] flex items-center gap-1" disabled={busy} title="Scan the plug-in folders again" onClick={() => void run(() => rescanOfx(true))}><RefreshCw size={12} /> Rescan</button>
        <button className="gbtn h-7 px-2 text-[11px] flex items-center gap-1" disabled={busy} title="Add a folder that contains .ofx.bundle plug-ins" onClick={() => void run(addOfxFolder)}><FolderPlus size={12} /> Add folder</button>
        <button className="gbtn h-7 px-2 text-[11px] flex items-center gap-1" title="Open AnimeStudio's own OFX plug-in folder (copy .ofx.bundle folders here)" onClick={() => void run(async () => (await openOfxFolder()) ?? '')}><FolderOpen size={12} /></button>
      </div>
      {!scan?.hostOk && scan && <div className="text-[11px] text-amber-300 mb-2">The OpenFX host is missing from this install — reinstall AnimeStudio.</div>}
      {plugins.length === 0 && <div className="text-[11px] text-zinc-500 leading-4 mb-2">No OpenFX plug-ins found. Install the <b>OFX version</b> of a plug-in (the one made for DaVinci Resolve / Vegas / Nuke), then press Rescan. Standard folder: <span className="as-mono">C:\Program Files\Common Files\OFX\Plugins</span>.</div>}
      <div className="space-y-1">
        {plugins.map(p => (
          <div key={p.bundle + p.index} className="rounded-lg glass-soft px-2.5 py-1.5 text-[11px]">
            <div className="text-zinc-200 font-medium truncate">{p.label}</div>
            <div className="text-zinc-500 truncate">{p.group || 'OpenFX'} · {p.params.length} controls{p.temporal ? ' · needs other frames (may render partially)' : ''}</div>
          </div>
        ))}
      </div>
      {problems.length > 0 && (
        <details className="mt-2 text-[11px] text-zinc-500">
          <summary className="cursor-pointer text-amber-300/90">{problems.length} bundle{problems.length > 1 ? 's' : ''} with problems</summary>
          {problems.map(r => (
            <div key={r.bundle} className="mt-1 leading-4"><span className="text-zinc-300">{r.bundle.split(/[\\/]/).pop()}</span>: {r.err ?? r.skipped.map(s => `${s.id} — ${s.reason}`).join('; ')}</div>
          ))}
        </details>
      )}
      <div className="text-[10px] text-zinc-600 mt-2 leading-4">Applied from Effects & Presets like any effect. Each plug-in runs in a separate process: if one crashes it is disabled and the editor keeps working. Commercial plug-ins need their own OFX licence.</div>
    </div>
  )
}
