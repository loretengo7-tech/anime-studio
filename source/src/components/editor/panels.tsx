'use client'
/**
 * ANIME STUDIO — Panels: Assets, Effects, Plugins, Text, Color, Composition, Projects, Feature Status
 */
import { useEffect, useRef, useState } from 'react'
import type { AssetMeta, VideoClip, AudioClip, TextClip } from '@/lib/engine/types'
import { uid, makeClipBase } from '@/lib/engine/types'
import { useEditorStore } from '@/lib/store/editorStore'
import { mediaManager, importMediaFile } from '@/lib/media/mediaManager'
import { generateLocalProxy } from '@/lib/media/proxy'
import { STATIC_MODE, localImportUpload, deleteLocalFile, restoreLocalAssets, listStoredMediaIds } from '@/lib/media/staticMode'
import { downloadProjectFile, parseProject, PROJECT_EXT } from '@/lib/media/projectFile'
import { playbackEngine } from '@/lib/engine/playback'
import { EFFECT_DEFS, COLOR_PRESETS } from '@/lib/engine/effects'
import { TEXT_ANIMATIONS } from '@/lib/engine/textRenderer'
import { listInstalledPlugins, installPluginFromJSON, uninstallPlugin, getPluginEffectDefs, SAMPLE_PLUGINS } from '@/lib/engine/plugins'
import { SectionTitle, Row, StatusChip, formatNum } from './ui-bits'
import { Upload, Film, Music, ImageIcon, Trash2, Cloud, Plus, Search, Puzzle, PackageOpen, Zap } from 'lucide-react'

// ============================================================ Assets

export function AssetsPanel() {
  const doc = useEditorStore(s => s.doc)
  const mutate = useEditorStore(s => s.mutate)
  const toast = useEditorStore(s => s.toast)
  const [busy, setBusy] = useState<string | null>(null)
  const [cloudBusy, setCloudBusy] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const importFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      setBusy(file.name)
      try {
        const meta = await importMediaFile(file, STATIC_MODE
          ? localImportUpload
          : async (f, probe) => {
            const form = new FormData()
            form.append('file', f)
            form.append('kind', probe.kind)
            form.append('duration', String(probe.duration))
            form.append('width', String(probe.width))
            form.append('height', String(probe.height))
            form.append('fps', String(probe.fps))
            const res = await fetch('/api/media', { method: 'POST', body: form })
            if (!res.ok) throw new Error(await res.text())
            return await res.json() as { id: string; url: string }
          })
        mutate(d => { d.assets.push(meta) })
        toast({ kind: 'success', title: `Imported ${meta.name}`, detail: `${meta.kind} · ${meta.duration.toFixed(1)}s` })
      } catch (e) {
        toast({ kind: 'error', title: `Import failed: ${file.name}`, detail: e instanceof Error ? e.message : String(e) })
      } finally {
        setBusy(null)
      }
    }
  }

  const addToTimeline = (asset: AssetMeta) => {
    let newClipId: string | null = null
    mutate(d => {
      if (asset.kind === 'audio') {
        const track = d.tracks.find(t => t.kind === 'audio' && !t.locked) ?? d.tracks[d.tracks.length - 1]
        if (!track) return
        newClipId = uid('clip')
        d.clips.push({
          ...makeClipBase(track.id, asset.name.slice(0, 28), playbackEngine.currentTime, Math.max(0.5, asset.duration)),
          id: newClipId, kind: 'audio',
          assetId: asset.id, inPoint: 0, fadeIn: 0, fadeOut: 0, volume: 1,
        })
      } else if (asset.kind === 'image') {
        // Real image layer: rendered by the WebGL compositor with the full
        // transform / opacity / blend / keyframes / mask / effects pipeline.
        const track = d.tracks.find(t => t.kind === 'video' && !t.locked)
        if (!track) return
        newClipId = uid('clip')
        d.clips.push({
          ...makeClipBase(track.id, asset.name.slice(0, 28), playbackEngine.currentTime, 5),
          id: newClipId, kind: 'image',
          assetId: asset.id,
        })
      } else {
        const track = d.tracks.find(t => t.kind === 'video' && !t.locked)
        if (!track) return
        newClipId = uid('clip')
        d.clips.push({
          ...makeClipBase(track.id, asset.name.slice(0, 28), playbackEngine.currentTime, Math.max(0.5, asset.duration)),
          id: newClipId, kind: 'video',
          assetId: asset.id, inPoint: 0, tracking: null, trackingTarget: null,
        })
      }
    })
    if (newClipId) useEditorStore.getState().select(newClipId)
    toast({ kind: 'success', title: `${asset.name} added at playhead` })
  }

  const makeProxy = async (asset: AssetMeta) => {
    setCloudBusy(asset.id)
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'proxy', payload: { assetId: asset.id } }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'job failed')
      toast({ kind: 'info', title: 'Cloud proxy job queued', detail: 'Re-open this panel in a few seconds' })
      setTimeout(async () => {
        try {
          const st = await fetch(`/api/jobs?id=${json.id}`).then(r => r.json())
          if (st.status === 'done') {
            mutate(d => {
              const a = d.assets.find(a => a.id === asset.id)
              if (a) a.proxyUrl = st.result?.url
            })
            toast({ kind: 'success', title: 'Proxy ready — smoother scrubbing enabled' })
          } else if (st.status === 'error') {
            toast({ kind: 'error', title: 'Proxy failed', detail: st.error?.slice(0, 140) })
          }
        } catch { /* ignore */ }
        setCloudBusy(null)
      }, 6000)
    } catch (e) {
      toast({ kind: 'error', title: 'Cloud job failed', detail: e instanceof Error ? e.message : String(e) })
      setCloudBusy(null)
    }
  }

  const makeLocalProxy = async (asset: AssetMeta) => {
    const upsertJob = useEditorStore.getState().upsertJob
    upsertJob({ id: `proxy-${asset.id}`, kind: 'proxy', label: `Local proxy ${asset.name}`, status: 'running', progress: 0 })
    try {
      const r = await generateLocalProxy(asset, p => upsertJob({ id: `proxy-${asset.id}`, kind: 'proxy', label: `Local proxy ${asset.name}`, status: 'running', progress: p.progress, message: p.message }))
      upsertJob({ id: `proxy-${asset.id}`, kind: 'proxy', label: `Local proxy ${asset.name}`, status: 'done', progress: 1, message: `${(r.sizeBytes / 1024 / 1024).toFixed(1)}MB` })
      toast({ kind: 'success', title: 'Local proxy ready', detail: 'Preview & scrubbing now use it. Export always reads the original.' })
    } catch (e) {
      upsertJob({ id: `proxy-${asset.id}`, kind: 'proxy', label: `Local proxy ${asset.name}`, status: 'error', progress: 0, message: e instanceof Error ? e.message : String(e) })
      toast({ kind: 'error', title: 'Local proxy failed', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  const removeAsset = (asset: AssetMeta) => {
    const used = doc.clips.some(c => (c.kind === 'video' || c.kind === 'audio' || c.kind === 'image') && (c as VideoClip).assetId === asset.id)
    if (used) {
      toast({ kind: 'error', title: 'Asset in use', detail: 'Remove its clips from the timeline first' })
      return
    }
    mutate(d => { d.assets = d.assets.filter(a => a.id !== asset.id) })
    mediaManager.removeAsset(asset.id)
    if (STATIC_MODE) void deleteLocalFile(asset.id)
  }

  return (
    <div className="p-3 pb-10">
      <input ref={fileRef} type="file" multiple accept="video/*,audio/*,image/*,.mkv,.mov,.avi,.webm,.m4v,.flac,.ogg,.opus,.wav" className="hidden" onChange={e => importFiles(e.target.files)} />
      <button
        className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl border-2 border-dashed border-white/15 text-zinc-300 text-sm mb-3 gbtn"
        onClick={() => fileRef.current?.click()}
        disabled={busy !== null}
      >
        <Upload size={16} />
        {busy ? `Importing ${busy}…` : 'Import video / audio / images'}
      </button>

      {doc.assets.length === 0 && <div className="text-xs text-zinc-600 text-center py-6">No media yet. Import anime footage and music to start editing.</div>}

      {doc.assets.map(a => (
        <div key={a.id} className="flex items-center gap-2 p-2 rounded-xl glass-soft mb-2">
          <div className="w-14 h-10 rounded-lg glass-inset overflow-hidden shrink-0 flex items-center justify-center">
            {a.kind === 'video' && a.thumbnails?.[0]
              ? <img src={a.thumbnails[0]} alt="" className="w-full h-full object-cover" />
              : a.kind === 'audio' ? <Music size={16} className="text-emerald-400" /> : a.kind === 'image' ? <ImageIcon size={16} className="text-zinc-400" /> : <Film size={16} className="text-sky-400" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-zinc-200 truncate">{a.name}</div>
            <div className="text-[10px] text-zinc-500 as-mono">
              {a.kind} · {a.duration > 0 ? `${a.duration.toFixed(1)}s` : 'still'} {a.width > 0 ? `· ${a.width}×${a.height}` : ''} · {(a.size / 1024 / 1024).toFixed(1)}MB
            </div>
          </div>
          <button className="text-[11px] px-2 py-1.5 rounded-lg gbtn-accent font-medium" onClick={() => addToTimeline(a)}>+ add</button>
          <div className="flex flex-col gap-1">
            {a.kind === 'video' && (
              <button
                className={`p-1 ${mediaManager.hasLocalProxy(a.id) ? 'text-sky-400' : 'text-zinc-500 hover:text-sky-400'}`}
                title="Generate a local 480p proxy in this browser (stored on device, no server)"
                onClick={() => void makeLocalProxy(a)}
                disabled={busy === `proxy-${a.id}`}
              >
                <Zap size={13} />
              </button>
            )}
            {(a.kind === 'video' || a.kind === 'audio') && !STATIC_MODE && (
              <button className="p-1 text-zinc-500 hover:text-sky-400" title="Generate cloud proxy (ffmpeg)" onClick={() => makeProxy(a)} disabled={cloudBusy === a.id}>
                <Cloud size={13} className={a.proxyUrl ? 'text-sky-400' : ''} />
              </button>
            )}
            <button className="p-1 text-zinc-600 hover:text-red-400" onClick={() => removeAsset(a)} aria-label="Remove asset"><Trash2 size={13} /></button>
          </div>
        </div>
      ))}
      <p className="text-[10px] text-zinc-600 mt-2">
        {STATIC_MODE
          ? 'Offline mode: media stays on your device (saved in the browser). Nothing is uploaded anywhere. The lightning icon builds a 480p local proxy so scrubbing stays smooth on iPhone.'
          : 'The lightning icon builds a 480p proxy inside your browser (no upload). The cloud icon uses the server ffmpeg proxy instead.'}
      </p>
    </div>
  )
}

// ============================================================ Effects

const CATEGORY_LABELS: Record<string, string> = {
  motion: 'Motion', lighting: 'Lighting', distortion: 'Distortion', color: 'Color',
  anime: 'Anime', stylize: 'Stylize', generate: 'Generate', perspective: 'Perspective',
  time: 'Time', audio: 'Audio',
}

export function EffectsPanel() {
  const doc = useEditorStore(s => s.doc)
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const mutate = useEditorStore(s => s.mutate)
  const toast = useEditorStore(s => s.toast)
  const setPanel = useEditorStore(s => s.setPanel)
  const [cat, setCat] = useState<string>('motion')
  const [query, setQuery] = useState('')
  const clip = doc.clips.find(c => c.id === selectedClipId) ?? null
  const allDefs = [...EFFECT_DEFS, ...getPluginEffectDefs()]
  const cats = Object.keys(CATEGORY_LABELS)

  const apply = (type: string) => {
    if (!clip) {
      toast({ kind: 'error', title: 'Select a clip first' })
      return
    }
    if (cat === 'audio' && clip.kind !== 'audio' && clip.kind !== 'video') {
      toast({ kind: 'error', title: 'Audio effects apply to audio/video clips' })
      return
    }
    mutate(d => {
      const c = d.clips.find(c => c.id === clip.id)
      if (!c) return
      // replace same type
      c.effects = c.effects.filter(e => e.type !== type)
      const def = allDefs.find(e => e.type === type)
      if (!def) return
      c.effects.push({
        id: uid('fx'), type, enabled: true,
        params: Object.fromEntries(def.params.map(p => [p.key, p.default])),
        paramKeyframes: {},
      })
    })
    toast({ kind: 'success', title: `${allDefs.find(e => e.type === type)?.name ?? type} applied`, detail: 'Adjust parameters in the Inspector' })
  }

  const q = query.trim().toLowerCase()
  const shown = allDefs.filter(e =>
    (q ? e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q) || e.type.includes(q) : e.category === cat)
  )

  // ---- user presets: save / apply / delete effect stacks (localStorage) ----
  const PRESET_KEY = 'anime-studio:userPresets'
  const [presets, setPresets] = useState<{ name: string; effects: unknown[] }[]>(() => {
    try { return JSON.parse(localStorage.getItem(PRESET_KEY) ?? '[]') } catch { return [] }
  })
  const savePreset = () => {
    if (!clip || clip.effects.length === 0) {
      toast({ kind: 'error', title: 'Nothing to save', detail: 'Apply effects to the selected clip first' })
      return
    }
    const name = window.prompt('Preset name', `My preset ${presets.length + 1}`)
    if (!name) return
    const next = [...presets, { name, effects: JSON.parse(JSON.stringify(clip.effects)) }]
    setPresets(next)
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(next)) } catch { /* private mode */ }
    toast({ kind: 'success', title: `Preset saved: ${name}` })
  }
  const applyPreset = (i: number) => {
    if (!clip) {
      toast({ kind: 'error', title: 'Select a clip first' })
      return
    }
    mutate(d => {
      const c = d.clips.find(c => c.id === clip.id)
      if (!c) return
      const copy = JSON.parse(JSON.stringify(presets[i].effects)) as typeof c.effects
      for (const fx of copy) fx.id = uid('fx')
      c.effects = [...c.effects, ...copy]
    })
    toast({ kind: 'success', title: `Preset applied: ${presets[i].name}` })
  }
  const deletePreset = (i: number) => {
    const next = presets.filter((_, idx) => idx !== i)
    setPresets(next)
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  }

  return (
    <div className="p-3 pb-10">
      <div className="flex items-center gap-2 mb-2">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            className="ginput w-full pl-7"
            placeholder={`Search ${allDefs.length} effects…`}
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="flex gap-1.5 mb-3 overflow-x-auto as-scroll pb-1">
        {cats.map(c => (
          <button
            key={c}
            className={`text-[11px] px-3 py-1.5 rounded-full border shrink-0 ${c === cat && !q ? 'gbtn-accent font-medium' : 'gbtn'}`}
            onClick={() => { setCat(c); setQuery('') }}
          >
            {CATEGORY_LABELS[c]}
          </button>
        ))}
      </div>
      <div className="text-[10px] text-zinc-500 mb-2">
        {clip ? <>Applying to <span className="text-amber-400">{clip.name}</span></> : 'Select a clip on the timeline first'}
        {q && <> · {shown.length} results for “{query}”</>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {shown.map(e => {
          const applied = clip?.effects.some(f => f.type === e.type)
          return (
            <button
              key={e.type}
              className={`text-left p-2.5 rounded-xl border ${applied ? 'glass-accent' : 'glass-soft active:bg-white/10'}`}
              onClick={() => apply(e.type)}
            >
              <div className="text-xs text-zinc-100 font-medium flex items-center gap-1">
                {e.name}
                {e.heavy && <span className="text-[9px] text-red-400 font-mono">GPU</span>}
                {applied && <span className="text-[9px] text-amber-400">✓</span>}
              </div>
              <div className="text-[10px] text-zinc-500 mt-0.5 leading-tight">{e.description}</div>
              {e.pluginName && <div className="text-[9px] text-violet-300 mt-1 flex items-center gap-1"><Puzzle size={9} /> {e.pluginName}</div>}
              <div className="text-[9px] text-zinc-600 mt-1 as-mono">{e.params.map(p => p.key).join(' · ')}</div>
            </button>
          )
        })}
        {shown.length === 0 && <div className="text-xs text-zinc-600 col-span-2 text-center py-6">No effects match. Install a plugin pack or try another search.</div>}
      </div>
      <button className="w-full mt-3 py-2 rounded-xl gbtn text-[11px] flex items-center justify-center gap-1.5" onClick={() => setPanel('plugins')}>
        <PackageOpen size={12} /> Manage plugin packs in the Plugins tab
      </button>

      {/* ---- user presets ---- */}
      <SectionTitle>My Presets</SectionTitle>
      <button className="w-full py-2 rounded-xl gbtn-accent text-[11px] mb-2" onClick={savePreset}>
        Save selected clip's effects as preset
      </button>
      {presets.length === 0 && <div className="text-[10px] text-zinc-600">No presets yet — build an effect stack, then save it and reuse it on any clip or project.</div>}
      <div className="space-y-1.5">
        {presets.map((p, i) => (
          <div key={i} className="flex items-center gap-2 p-2 rounded-lg glass-soft">
            <span className="text-xs text-zinc-200 flex-1 truncate">{p.name}</span>
            <span className="text-[9px] text-zinc-500 as-mono">{p.effects.length} fx</span>
            <button className="text-[10px] px-2 py-1 rounded glass-accent text-amber-300" onClick={() => applyPreset(i)}>Apply</button>
            <button className="text-[10px] px-1.5 py-1 rounded text-red-400" onClick={() => deletePreset(i)}>✕</button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ============================================================ Plugins

export function PluginsPanel() {
  const toast = useEditorStore(s => s.toast)
  const [, tick] = useState(0)
  const [manifest, setManifest] = useState('')
  const plugins = listInstalledPlugins()
  const pluginEffectCount = getPluginEffectDefs().length

  const refresh = () => tick(n => n + 1)

  const install = (json: string) => {
    const res = installPluginFromJSON(json)
    if (res.ok) {
      toast({ kind: 'success', title: `Installed ${res.plugin?.name}`, detail: 'Effects are live — check the Effects library' })
      setManifest('')
      refresh()
    } else {
      toast({ kind: 'error', title: 'Install failed', detail: res.error })
    }
  }

  return (
    <div className="p-3 pb-10">
      <SectionTitle right={<span className="text-[10px] text-zinc-500">{pluginEffectCount} plugin effects</span>}>
        <Puzzle size={11} className="inline mr-1 text-violet-400" /> Installed plugins
      </SectionTitle>
      <div className="space-y-2">
        {plugins.map(p => (
          <div key={p.id} className="rounded-xl glass-soft p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs text-zinc-100 font-medium">{p.name} <span className="text-zinc-500 as-mono text-[10px]">v{p.version}</span></div>
                <div className="text-[10px] text-zinc-500">by {p.author} · {p.effects.length} effect{p.effects.length > 1 ? 's' : ''} · {p.category}</div>
                <div className="text-[10px] text-zinc-400 mt-1">{p.description}</div>
                <div className="text-[9px] text-violet-300 as-mono mt-1">{p.effects.map(e => e.name).join(' · ')}</div>
              </div>
              {!SAMPLE_PLUGINS.some(s => s.id === p.id) && (
                <button className="p-1.5 text-zinc-500 hover:text-red-400 shrink-0" aria-label="Uninstall plugin" onClick={() => { uninstallPlugin(p.id); refresh() }}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          </div>
        ))}
        {plugins.length === 0 && <div className="text-xs text-zinc-600 text-center py-4">No plugins installed.</div>}
      </div>

      <SectionTitle>Install plugin (paste manifest JSON)</SectionTitle>
      <textarea
        className="w-full ginput as-mono text-[10px] rounded-lg p-2"
        rows={6}
        placeholder='{ "id": "my_pack", "name": "My Pack", "version": "1.0.0", "author": "you", "category": "stylize", "description": "…", "effects": [{ "type": "my_fx", "name": "My FX", "description": "…", "params": [{"key":"amount","label":"Amount","min":0,"max":1,"step":0.01,"default":0.5}], "shader": "vec3 pl_main(vec3 col, vec2 uv, vec2 res, float time) { return col; }" }] }'
        value={manifest}
        onChange={e => setManifest(e.target.value)}
      />
      <button className="w-full mt-2 py-2.5 rounded-xl gbtn gbtn-violet text-sm font-semibold" onClick={() => install(manifest)} disabled={!manifest.trim()}>
        Install plugin
      </button>

      <SectionTitle right={<button className="text-[10px] text-violet-300" onClick={() => setManifest(JSON.stringify(SAMPLE_PLUGINS[2], null, 1))}>load example</button>}>
        Manifest format
      </SectionTitle>
      <p className="text-[10px] text-zinc-500">
        Effects compile into the GPU pipeline as color-processing GLSL (WebGL1-safe): define <span className="as-mono text-zinc-300">vec3 pl_main(vec3 col, vec2 uv, vec2 res, float time)</span> and reference params as <span className="as-mono text-zinc-300">u_p_&lt;key&gt;</span>. Manifests are validated (structure, brace balance, forbidden directives) before install; a plugin that fails to compile is quarantined without breaking the editor. UV warps belong to built-in effects — plugins handle color & procedural generation.
      </p>
    </div>
  )
}

// ============================================================ Text

export function TextPanel() {
  const doc = useEditorStore(s => s.doc)
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const editing = doc.clips.find(c => c.id === selectedClipId && c.kind === 'text') as TextClip | undefined
  return (
    <div className="p-3 pb-10">
      <TextForm
        key={editing?.id ?? 'new'}
        editing={editing ?? null}
      />
    </div>
  )
}

function TextForm({ editing }: { editing: TextClip | null }) {
  const mutate = useEditorStore(s => s.mutate)
  const toast = useEditorStore(s => s.toast)
  const [content, setContent] = useState(editing?.text.content ?? '')
  const [duration, setDuration] = useState(3)
  const [size, setSize] = useState(editing?.text.size ?? 80)
  const [animation, setAnimation] = useState(editing?.text.animation ?? 'pop')
  const [color, setColor] = useState(editing?.text.color ?? '#ffffff')

  const add = () => {
    if (!content.trim()) return
    mutate(d => {
      const track = d.tracks.find(t => t.kind === 'text') ?? d.tracks[0]
      d.clips.push({
        ...makeClipBase(track.id, content.slice(0, 24), playbackEngine.currentTime, duration),
        id: uid('clip'), kind: 'text',
        y: Math.round(d.composition.height * 0.32),
        text: {
          content, font: 'Arial, sans-serif', size, color, strokeColor: '#000000',
          strokeWidth: Math.max(2, size * 0.06), weight: 800, align: 'center', letterSpacing: 0,
          shadow: true, animation: animation as TextClip['text']['animation'], animationDuration: 0.5,
        },
      })
    })
    toast({ kind: 'success', title: 'Text layer added at playhead' })
    setContent('')
  }

  return (
    <>
      <SectionTitle>{editing ? 'Edit selected text' : 'Add text layer'}</SectionTitle>
      <textarea
        className="w-full ginput rounded-lg p-2 text-sm text-zinc-200 mb-2"
        rows={2} placeholder="Enter text… (multi-line supported)"
        value={content}
        onChange={e => {
          setContent(e.target.value)
          if (editing) mutate(d => { const c = d.clips.find(c => c.id === editing.id) as TextClip | undefined; if (c && c.kind === 'text') c.text.content = e.target.value })
        }}
      />
      <Row label="Size"><input className="as-range flex-1" type="range" min={16} max={400} value={size} onChange={e => { setSize(parseInt(e.target.value)); if (editing) mutate(d => { const c = d.clips.find(c => c.id === editing.id) as TextClip | undefined; if (c && c.kind === 'text') c.text.size = parseInt(e.target.value) }) }} /><span className="as-mono text-[11px] text-zinc-400 w-12">{size}</span></Row>
      <Row label="Color">
        <input type="color" value={color} onChange={e => { setColor(e.target.value); if (editing) mutate(d => { const c = d.clips.find(c => c.id === editing.id) as TextClip | undefined; if (c && c.kind === 'text') c.text.color = e.target.value }) }} className="w-8 h-8 bg-transparent" />
        <select className="ginput flex-1" value={animation} onChange={e => setAnimation(e.target.value as typeof animation)}>
          {TEXT_ANIMATIONS.map(a => <option key={a}>{a}</option>)}
        </select>
      </Row>
      {!editing && (
        <Row label="Duration">
          <input className="as-range flex-1" type="range" min={0.5} max={12} step={0.1} value={duration} onChange={e => setDuration(parseFloat(e.target.value))} />
          <span className="as-mono text-[11px] text-zinc-400 w-12">{duration.toFixed(1)}s</span>
        </Row>
      )}
      <button className="w-full mt-2 py-2.5 rounded-xl gbtn-accent text-sm font-semibold flex items-center justify-center gap-1.5" onClick={add}>
        <Plus size={14} /> Add text at playhead
      </button>
      <p className="text-[10px] text-zinc-600 mt-2">Text renders through the same GPU pipeline — position/scale/opacity keyframes apply like any layer.</p>
    </>
  )
}

// ============================================================ Color

export function ColorPanel() {
  const doc = useEditorStore(s => s.doc)
  const selectedClipId = useEditorStore(s => s.selectedClipId)
  const mutate = useEditorStore(s => s.mutate)
  const toast = useEditorStore(s => s.toast)
  const clip = doc.clips.find(c => c.id === selectedClipId)
  const lutRef = useRef<HTMLInputElement>(null)

  const applyPreset = (key: string) => {
    if (!clip) { toast({ kind: 'error', title: 'Select a clip first' }); return }
    const preset = COLOR_PRESETS[key]
    mutate(d => {
      const c = d.clips.find(c => c.id === clip.id)
      if (!c) return
      const g = preset.grade
      const setFx = (type: string, params: Record<string, number>) => {
        c.effects = c.effects.filter(e => e.type !== type)
        c.effects.push({ id: uid('fx'), type, enabled: true, params, paramKeyframes: {} })
      }
      if (g.exposure) setFx('exposure', { stops: g.exposure })
      if (g.contrast) setFx('contrast', { amount: g.contrast })
      if (g.saturation !== undefined) setFx('saturation', { amount: g.saturation })
      if (g.temperature) setFx('temperature', { value: g.temperature })
      if (g.tint) setFx('tint', { value: g.tint })
      if (g.vibrance) setFx('vibrance', { amount: g.vibrance })
      if (g.lift || g.gamma !== 1 || g.gain !== 1) setFx('lift_gamma_gain', { lift: g.lift ?? 0, gamma: g.gamma ?? 1, gain: g.gain ?? 1 })
      if (g.vignette) setFx('vignette', { amount: g.vignette, softness: 0.5 })
    })
    toast({ kind: 'success', title: `${preset.label} applied` })
  }

  const loadLut = async (file: File) => {
    try {
      const text = await file.text()
      const ok = playbackEngine.compositor.loadLUT(text)
      if (ok) toast({ kind: 'success', title: `LUT loaded (${file.name})`, detail: 'Applied to the whole composition' })
      else toast({ kind: 'error', title: 'Invalid .cube LUT' })
    } catch (e) {
      toast({ kind: 'error', title: 'LUT load failed', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className="p-3 pb-10">
      <SectionTitle>Color grades {clip ? `→ ${clip.name}` : '(select a clip)'}</SectionTitle>
      <div className="grid grid-cols-2 gap-2">
        {Object.entries(COLOR_PRESETS).map(([key, p]) => (
          <button key={key} className="text-left p-2.5 rounded-xl glass-soft active:bg-white/10" onClick={() => applyPreset(key)}>
            <div className="text-xs text-zinc-200 font-medium">{p.label}</div>
            <div className="flex gap-0.5 mt-1.5">
              {[p.grade.temperature ?? 0, p.grade.saturation ?? 0, p.grade.contrast ?? 0].map((v, i) => (
                <div key={i} className="h-1.5 flex-1 rounded" style={{ background: v >= 0 ? `rgba(245,158,11,${0.3 + v * 2})` : `rgba(56,189,248,${0.3 + Math.abs(v) * 2})` }} />
              ))}
            </div>
            <div className="text-[9px] text-zinc-600 mt-1">{Object.keys(p.grade).join(' · ')}</div>
          </button>
        ))}
      </div>

      <SectionTitle>LUT (.cube)</SectionTitle>
      <input ref={lutRef} type="file" accept=".cube,text/plain" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) loadLut(f) }} />
      <button className="w-full py-2.5 rounded-xl gbtn text-zinc-300 text-sm" onClick={() => lutRef.current?.click()}>Import .cube LUT (applies to whole comp)</button>
      <button className="w-full py-2 mt-2 rounded-xl gbtn text-red-400 text-xs" onClick={() => { playbackEngine.compositor.clearLUT(); toast({ kind: 'info', title: 'LUT cleared' }) }}>Clear LUT</button>
    </div>
  )
}

// ============================================================ Composition

export function CompPanel() {
  const doc = useEditorStore(s => s.doc)
  const mutate = useEditorStore(s => s.mutate)
  return (
    <div className="p-3 pb-10">
      <SectionTitle>Composition settings</SectionTitle>
      <Row label="Preset">
        <select
          className="ginput flex-1"
          value={`${doc.composition.width}x${doc.composition.height}`}
          onChange={e => {
            const [w, h] = e.target.value.split('x').map(Number)
            mutate(d => { d.composition.width = w; d.composition.height = h })
          }}
        >
          <option value="1920x1080">1920 × 1080 (16:9)</option>
          <option value="1080x1920">1080 × 1920 (9:16 vertical)</option>
          <option value="1080x1080">1080 × 1080 (1:1)</option>
          <option value="3840x2160">3840 × 2160 (4K)</option>
          <option value="1280x720">1280 × 720</option>
        </select>
      </Row>
      <Row label="FPS">
        <select className="ginput flex-1" value={doc.composition.fps} onChange={e => mutate(d => { d.composition.fps = parseInt(e.target.value) })}>
          {[24, 25, 30, 50, 60, 120, 240].map(f => <option key={f} value={f}>{f}</option>)}
        </select>
      </Row>
      <Row label="Duration">
        <input className="as-range flex-1" type="range" min={5} max={180} value={doc.composition.duration} onChange={e => mutate(d => { d.composition.duration = parseInt(e.target.value) })} />
        <span className="as-mono text-[11px] text-zinc-400 w-14">{formatNum(doc.composition.duration)}s</span>
      </Row>
      <Row label="Background">
        <input type="color" value={doc.composition.background} onChange={e => mutate(d => { d.composition.background = e.target.value })} className="w-8 h-8 bg-transparent" />
        <span className="as-mono text-[11px] text-zinc-500">{doc.composition.background}</span>
      </Row>
    </div>
  )
}

// ============================================================ Projects

export function ProjectsPanel() {
  const doc = useEditorStore(s => s.doc)
  const mutate = useEditorStore(s => s.mutate)
  const saveToServer = useEditorStore(s => s.saveToServer)
  const loadFromServer = useEditorStore(s => s.loadFromServer)
  const newProject = useEditorStore(s => s.newProject)
  const duplicateProject = useEditorStore(s => s.duplicateProject)
  const saveState = useEditorStore(s => s.saveState)
  const serverId = useEditorStore(s => s.serverProjectId)
  const toast = useEditorStore(s => s.toast)
  const [serverProjects, setServerProjects] = useState<{ id: string; name: string; clipCount: number; updatedAt: string }[]>([])
  const [name, setName] = useState(doc.name)

  const refresh = async () => {
    try {
      const res = await fetch('/api/projects')
      setServerProjects(await res.json())
    } catch { }
  }
  useEffect(() => { void refresh() }, [])

  const exportJson = () => {
    try {
      downloadProjectFile(doc)
      toast({
        kind: 'success',
        title: `Project saved as ${PROJECT_EXT}`,
        detail: 'Opens on THIS device with all footage. On another device, re-import the media files (they live in this browser).',
      })
    } catch (e) {
      toast({ kind: 'error', title: 'Save failed', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  const importJson = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const { doc: parsed } = parseProject(reader.result as string)
        const prevName = doc.name
        newProject(parsed.name ?? 'Imported')
        useEditorStore.getState().replaceDoc(parsed, false)
        // rebuild playable blob URLs for footage stored on this device + list missing
        void (async () => {
          let patched = parsed.assets ?? []
          try {
            patched = await restoreLocalAssets(patched)
          } catch { /* restore is best-effort; missing footage is reported below */ }
          let missing: AssetMeta[] = []
          try {
            const ids = await listStoredMediaIds()
            missing = (parsed.assets ?? []).filter(a => !ids.has(a.id))
          } catch { /* device without the media DB (server edition) */ }
          useEditorStore.setState(s => ({ doc: { ...s.doc, assets: patched } }))
          for (const a of patched) mediaManager.registerAsset(a)
          playbackEngine.setDoc(useEditorStore.getState().doc)
          if (missing.length > 0) {
            toast({
              kind: 'error',
              title: `${missing.length} missing footage item${missing.length > 1 ? 's' : ''}`,
              detail: `Re-import from the Assets panel: ${missing.map(a => a.name).join(', ')}`,
            })
          } else {
            toast({ kind: 'success', title: `Project "${parsed.name}" opened`, detail: `Replaced "${prevName}" — all footage relinked.` })
          }
        })()
      } catch (e) {
        toast({ kind: 'error', title: 'Open failed', detail: e instanceof Error ? e.message : String(e) })
      }
    }
    reader.onerror = () => toast({ kind: 'error', title: 'Could not read the file' })
    reader.readAsText(file)
  }

  return (
    <div className="p-3 pb-10">
      <SectionTitle right={<span className={`text-[10px] ${saveState === 'saved' ? 'text-emerald-400' : 'text-amber-400'}`}>{saveState}</span>}>Project</SectionTitle>
      <div className="flex gap-2 mb-2">
        <input
          className="flex-1 ginput text-sm text-zinc-200"
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={() => mutate(d => { d.name = name || 'Untitled' })}
        />
        <button className="px-3 rounded-xl gbtn text-xs" onClick={() => newProject('Untitled AMV')}>New</button>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-3">
        {!STATIC_MODE && <button className="py-2.5 rounded-xl gbtn-accent text-sm font-semibold" onClick={() => void saveToServer()}>{serverId ? 'Save to server' : 'Save to server (creates)'}</button>}
        {!STATIC_MODE && <button className="py-2.5 rounded-xl gbtn text-sm" onClick={() => void duplicateProject()}>Duplicate (server)</button>}
        <button className="py-2.5 rounded-xl gbtn-accent text-sm font-semibold col-span-2" onClick={exportJson}>Save project file ({PROJECT_EXT})</button>
        <label className="py-2.5 rounded-xl gbtn text-sm text-center cursor-pointer col-span-2">
          Open project file ({PROJECT_EXT})
          <input type="file" accept=".aeproject,.json,application/json" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) importJson(f) }} />
        </label>
      </div>

      {!STATIC_MODE && (
        <>
          <SectionTitle right={<button className="text-[10px] text-sky-400" onClick={() => void refresh()}>refresh</button>}>Server projects</SectionTitle>
          {serverProjects.length === 0 && <div className="text-xs text-zinc-600">No server-saved projects yet.</div>}
          <div className="space-y-1.5 max-h-72 overflow-y-auto as-scroll">
            {serverProjects.map(p => (
              <div key={p.id} className="flex items-center gap-2 p-2 rounded-xl glass-soft">
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-zinc-200 truncate">{p.name}</div>
                  <div className="text-[10px] text-zinc-500">{p.clipCount} clips · {new Date(p.updatedAt).toLocaleString()}</div>
                </div>
                <button className="text-[11px] px-2 py-1.5 rounded-lg gbtn" onClick={() => void loadFromServer(p.id)}>Open</button>
                <button className="p-1.5 text-zinc-600 hover:text-red-400" onClick={async () => {
                  await fetch(`/api/projects/${p.id}`, { method: 'DELETE' })
                  void refresh()
                }} aria-label="Delete project"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        </>
      )}
      {STATIC_MODE && (
        <div className="p-3 rounded-xl glass-violet text-[11px] text-violet-100 mb-2">
          Offline edition: projects autosave to IndexedDB in this browser (with recovery points). Save a {PROJECT_EXT} file to back up or move a project — footage relinks automatically on this device.
        </div>
      )}
      <p className="text-[10px] text-zinc-600 mt-2">
        Autosave runs locally every ~1.2s after edits. Server save gives durable storage and project recovery across devices.
      </p>
    </div>
  )
}

// ============================================================ Feature status (honesty panel)

const FEATURES: { name: string; status: 'full' | 'partial' | 'awaiting' | 'none'; note: string }[] = [
  { name: 'Nonlinear timeline (multi-track, move/trim/split/duplicate, snapping, pinch zoom)', status: 'full', note: 'Touch gestures, lock/hide/mute, frame-accurate snapping (grid = comp fps), drag ghost with timecode, keyframe drag commits, pointer-captured scrubbing' },
  { name: 'After Effects workspace (docks)', status: 'full', note: 'Desktop: resizable/collapsible left Project dock + right Effect Controls dock with tabs, persisted layout. Mobile: bottom-sheet panels. Playhead drag keeps capture outside the ruler' },
  { name: 'Real-time WebGL compositor preview', status: 'full', note: 'Layer transforms, blend modes, masks, adjustment layers, LUTs. FIXED: global orientation flip (everything imported looked upside-down/180°) — fixed at the FBO read level, rotation-safe' },
  { name: 'Editable numeric controls (AE-style)', status: 'full', note: 'Every parameter: drag-to-scrub chip + click-to-type exact value (Enter applies, Esc cancels, arrow keys nudge, Shift ×10) + numeric keyboard on mobile. Applies to transform, effects, camera, audio, text' },
  { name: 'Layer types (video/image/audio/text/solid/shape/null/camera/adjustment)', status: 'full', note: 'Solids & shapes are procedural GPU layers; nulls & cameras are real controller layers (never rendered); created from the timeline toolbar' },
  { name: 'Parenting (Parent & Link)', status: 'full', note: 'AE-style transform inheritance with per-parent keyframe timing, cycle-safe chains; parent dropdown in the Inspector with direction hints + link confirmation. NULLS ARE VISIBLE NOW: crosshair markers in the viewer (respect parenting), draggable to move them, and they list which layers they control. 2D verified numerically; 3D layers inherit a 2D parent transform applied after camera projection (approximation)' },
  { name: '3D layers + camera system', status: 'full', note: 'threeD layers projected through the active Camera as per-layer homographies (perspective-correct UVs); position/rotation/focal/zoom keyframable. DOF is an approximation (defocus by focal-plane distance) — not ray-traced bokeh' },
  { name: 'Track mattes (alpha / luma ± inverted)', status: 'full', note: 'Matte source rendered through the full pipeline and bound per-layer; alpha mattes work on shape/text/solid sources, luma mattes on anything. Pre-compositions (nested comps) not yet implemented' },
  { name: 'Keyframe system (transform + effect params)', status: 'full', note: 'Playhead keyframing; editing an ANIMATED property writes a keyframe at the playhead (AE behavior — before, writes were silently ignored); keyframe lane drag now actually commits' },
  { name: 'Graph editor with bezier handles', status: 'full', note: 'Value curves, editable easing handles, easing presets' },
  { name: 'Effects library (60+ across 10 categories)', status: 'full', note: 'Real GPU shaders incl. new: Sharpen, Cartoon/Cel Shade, Turbulent Displace, Posterize Time. Effect Controls stack: reorder, duplicate, reset, enable/disable; all params adjustable/keyframable' },
  { name: 'User presets (save/apply effect stacks)', status: 'full', note: 'Save the selected layer\u2019s effect stack with a name, reuse on any clip or project (localStorage)' },
  { name: 'Plugin system (AE-style packs)', status: 'full', note: 'JSON manifests with sandboxed GLSL compile into the compositor; hot install/uninstall; 4 sample packs included' },
  { name: 'Speed & velocity editing (time remap curves, presets)', status: 'full', note: 'Piecewise remap + Catmull-Rom smoothing' },
  { name: 'Smooth motion (frame interpolation)', status: 'partial', note: 'Renamed honestly: GPU pyramidal Horn–Schunck optical flow with occlusion-aware bidirectional warping, 3 quality tiers. It is motion interpolation — NOT neural Twixtor/RIFE grade. No cloud claims.' },
  { name: 'Detail Restore (image enhancement)', status: 'partial', note: 'Renamed honestly: progressive ≤2× bicubic chain with detail reinjection, bilateral denoise, deblock, edge-directed line-art reconstruction. It restores detail — it is NOT neural super-resolution.' },
  { name: 'Export — realtime MediaRecorder', status: 'full', note: 'MP4 (Safari) / WebM (Chrome) with the live audio mix; audioIncluded only claimed when a track really joined the stream' },
  { name: 'Export — frame-accurate WebCodecs + audio guarantee', status: 'full', note: 'VideoEncoder + AAC/Opus embedded when the browser supports it. If it does not, the full offline mix is delivered as a separate WAV file — audio ALWAYS comes out, never silently dropped' },
  { name: 'Audio engine (waveforms, fades, volume automation, effects)', status: 'full', note: 'WebAudio graph with per-clip chains' },
  { name: 'Text engine (fonts, styles, animators)', status: 'full', note: 'Device font catalog + INSTALL YOUR OWN fonts (.ttf/.otf/.woff, persisted in the browser). Weight, align, tracking, stroke, two-color gradient fill, full shadow (color/blur/offset). Animations: fadeIn, slideUp, slideLeft, pop, zoomIn, typewriter, shake, karaoke, bounce, wave, trackingIn, rotateIn, blurIn — with per-character stagger (range-selector style). Per-char 3D text and Source-Text expressions not yet' },
  { name: 'Vocal/instrumental separation (stems)', status: 'partial', note: 'Real Meta Demucs separation, modular: runs on a local Node server (npm run dev + pip install demucs). NOT available in the static PWA (no server) — the UI explains this and suggests importing pre-separated stems instead' },
  { name: 'Beat detection & BPM', status: 'full', note: 'Onset flux + adaptive threshold + autocorrelation BPM; beat markers on timeline' },
  { name: 'Motion tracking (point + corner pin)', status: 'partial', note: 'NCC pyramid tracker with sub-pixel fit + adaptive template; 4-point corner pin → similarity transforms; stabilization. No planar/rotoscope yet' },
  { name: 'Masking — rect / ellipse / pen (bezier)', status: 'full', note: 'Pen mask mapping fixed to match the new orientation convention (masks land where you draw them). Per-point editing, feather, invert, shape keyframes; max 24 flattened verts' },
  { name: 'Rotoscoping', status: 'awaiting', note: 'Requires per-frame matte ML model — no honest way to fake it in-browser today' },
  { name: 'Project management (save/open/duplicate/autosave/recovery)', status: 'full', note: 'Autosave in IndexedDB (7-point recovery ring) + SQLite server storage (server edition) + .aeproject save/open with automatic footage relinking on the same device' },
  { name: 'Project files (.aeproject save/open like AE)', status: 'full', note: 'Save/open the project from disk. Footage relinks automatically on the same device (media lives in IndexedDB); opening elsewhere lists the missing footage by name so you can re-import (AE missing-footage flow). Media is NOT embedded — videos are too large for a JSON project file' },
  { name: 'Autosave (IndexedDB) + recovery warnings', status: 'full', note: 'Autosave moved to IndexedDB with a history ring; storage failures show a clear warning (no more silent data loss); a newer autosave is recovered on boot if localStorage was cleared' },
  { name: 'Cloud processing (ffmpeg jobs: proxies, normalize, convert)', status: 'full', note: 'Real server jobs with status tracking — server edition only' },
  { name: 'Cloud GPU rendering / neural inference', status: 'awaiting', note: 'Job queue + API contract ready; needs GPU worker infrastructure' },
  { name: 'Keyboard shortcuts', status: 'full', note: 'Space play/pause · ←/→ frame step (Shift ×10) · Home/End · Delete removes layer · M marker · Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z redo' },
  { name: 'Speed-line / impact-frame / aura anime FX', status: 'full', note: 'Procedural GPU effects with animated parameters' },
  { name: 'Image assets as layers', status: 'full', note: 'Real image clips rendered by the GPU compositor: transform, opacity, blend modes, keyframes, masks and effects; thumbnail chip on the timeline; 5s default duration' },
  { name: 'Local in-browser proxies (no server)', status: 'full', note: '480p MediaRecorder proxy generated on-device (canvas + WebAudio capture), stored in IndexedDB, used for preview/scrubbing; export always reads the original' },
  { name: 'Mobile performance & memory guards', status: 'full', note: 'Preview quality tiers (Q 25% / H 50% / F full), GPU texture trimming away from the playhead (~2s cadence), heavy-FX badge, slow-preview warning, video element pool cap' },
  { name: 'AI editing assistant — browser-direct', status: 'full', note: 'YOUR own Gemini, Claude or Z.ai key, stored only in this browser (Settings panel); daily request cap enforced before sending; ops re-validated with zod; AI PREVIEW now renders the staged draft for real in the viewer (before it was claimed but not shown)' },
  { name: 'PWA (installable on iPhone)', status: 'full', note: 'Web manifest + service worker + icons; Safari → Add to Home Screen runs fullscreen. Static export works for free hosting (Netlify/Cloudflare Pages/GitHub Pages)' },
  { name: 'iOS native app (App Store / sideload)', status: 'awaiting', note: 'Capacitor config + GitHub Actions workflow for an UNSIGNED .ipa are ready in the repo. App Store requires the paid Apple Developer account; sideloading needs Sideloadly/AltStore on a PC with your Apple ID (7-day resign limit, 3 apps) — a Mac is not required, but a PC is' },
]

export function StatusPanel() {
  return (
    <div className="p-3 pb-10">
      <SectionTitle>Feature implementation status</SectionTitle>
      <p className="text-[10px] text-zinc-500 mb-2">Honest classification of every subsystem — nothing here is claimed to work unless it really does.</p>
      <div className="space-y-1.5">
        {FEATURES.map(f => (
          <div key={f.name} className="p-2.5 rounded-xl glass-soft">
            <div className="flex items-start justify-between gap-2">
              <span className="text-xs text-zinc-200 flex-1">{f.name}</span>
              <StatusChip status={f.status} />
            </div>
            <div className="text-[10px] text-zinc-500 mt-1">{f.note}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
