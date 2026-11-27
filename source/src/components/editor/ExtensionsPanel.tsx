'use client'
/**
 * ANIME STUDIO — Extensions (After Effects scripts & CEP panels)
 *  - Install .zxp / .zip (CEP HTML panels) and .jsx (ExtendScript / ScriptUI)
 *  - Panels dock as tabs (like AE's Window > Extensions) or float
 *  - Run any .jsx once from File > Scripts > Run Script File…
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { useEditorStore } from '@/lib/store/editorStore'
import { useExtStore, type InstalledExt, type ExtPanel } from '@/lib/extensions/store'
import { buildPanelDoc, engineFor, extLogs, resetEngine } from '@/lib/extensions/cep'
import { createEngine, runWithDialogs } from '@/lib/extensions/aeDom'
import { SUIControl, ScriptUIWindow, callHandler, subscribeSUI, suiVersion } from '@/lib/extensions/scriptui'
import { Puzzle, Upload, Trash2, PanelRight, ExternalLink, FileCode2, X, Play } from 'lucide-react'

export function useExtensionsLoaded() {
  const load = useExtStore(s => s.load)
  useEffect(() => { void load() }, [load])
}

// ------------------------------------------------------------------ manager

export function ExtensionsPanel() {
  useExtensionsLoaded()
  const list = useExtStore(s => s.list)
  const docked = useExtStore(s => s.docked)
  const install = useExtStore(s => s.install)
  const remove = useExtStore(s => s.remove)
  const dock = useExtStore(s => s.dock)
  const undock = useExtStore(s => s.undock)
  const openFloating = useExtStore(s => s.openFloating)
  const toast = useEditorStore(s => s.toast)
  const [busy, setBusy] = useState(false)
  const [logFor, setLogFor] = useState<string | null>(null)

  const pick = (accept: string, then: (f: File) => void) => {
    const i = document.createElement('input')
    i.type = 'file'; i.accept = accept
    i.onchange = () => { const f = i.files?.[0]; if (f) then(f) }
    i.click()
  }
  const doInstall = (f: File) => {
    if (!window.confirm(`Install "${f.name}"?\n\nExtensions and scripts run with full access to your project — only install ones you trust.`)) return
    setBusy(true)
    install(f).then(e => {
      resetEngine(e.id)
      toast({ kind: 'success', title: `Installed ${e.name}`, detail: `${e.kind === 'cep' ? 'Panel' : 'Script'} — docked in the right panel group (Window > Extensions)` })
    }).catch(err => toast({ kind: 'error', title: 'Install failed', detail: err instanceof Error ? err.message : String(err) }))
      .finally(() => setBusy(false))
  }

  return (
    <div className="p-3 text-[12px] space-y-3">
      <div className="flex items-center gap-2 text-zinc-200 font-semibold"><Puzzle size={14} className="text-amber-400" /> Extensions &amp; Scripts</div>
      <p className="text-zinc-500 text-[11px] leading-4">
        Install After Effects panels (<b>.zxp</b>, <b>.zip</b>) and scripts (<b>.jsx</b>, <b>.js</b>, <b>.jsxinc</b>, zips of scripts with <code>#include</code>). Animation presets (<b>.ffx</b>) apply to the selected layer. They run on AnimeStudio&apos;s After Effects scripting layer: layers, transform keyframes, easing (KeyframeEase), expressions, effects and ScriptUI panels.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <button className="gbtn gbtn-accent h-8 flex items-center justify-center gap-1.5" disabled={busy} onClick={() => pick('.zxp,.zip,.jsx,.js,.jsxinc,.jsxbin', doInstall)}><Upload size={13} /> Install…</button>
        <button className="gbtn h-8 flex items-center justify-center gap-1.5" onClick={() => pick('.jsx,.js,.jsxinc,.jsxbin,.ffx,.zip,.zxp', f => void runScriptFile(f))}><Play size={13} /> Run script once…</button>
      </div>
      {list.length === 0 && <div className="text-zinc-600 text-[11px] py-4 text-center">No extensions installed yet.</div>}
      {list.map(e => (
        <div key={e.id} className="vl-card">
          <div className="flex items-center gap-2">
            {e.kind === 'cep' ? <Puzzle size={14} className="text-sky-400 shrink-0" /> : <FileCode2 size={14} className="text-emerald-400 shrink-0" />}
            <div className="flex-1 min-w-0">
              <div className="text-zinc-100 truncate">{e.name} <span className="text-zinc-500 text-[10.5px]">{e.version}</span></div>
              <div className="text-zinc-500 text-[10.5px] truncate">{e.kind === 'cep' ? 'CEP panel' : 'ExtendScript'} · {e.id}</div>
            </div>
            <button className="tb-btn !w-7 !h-7" title="Log" onClick={() => setLogFor(logFor === e.id ? null : e.id)}>≡</button>
            <button className="tb-btn !w-7 !h-7" title="Uninstall" onClick={() => { if (window.confirm(`Uninstall ${e.name}?`)) void remove(e.id) }}><Trash2 size={13} /></button>
          </div>
          <div className="mt-2 space-y-1">
            {e.panels.map(p => {
              const key = `${e.id}|${p.id}`
              const isDocked = docked.includes(key)
              return (
                <div key={p.id} className="flex items-center gap-1.5">
                  <span className="flex-1 truncate text-zinc-300">{p.name}<span className="text-zinc-600"> · {p.type}</span></span>
                  <button className="vl-chip" data-on={isDocked ? '1' : '0'} onClick={() => isDocked ? undock(key) : dock(e.id, p.id)} title="Dock in the right panel group"><PanelRight size={11} /> {isDocked ? 'Docked' : 'Dock'}</button>
                  <button className="vl-chip" onClick={() => openFloating(e.id, p.id)} title="Open as floating window"><ExternalLink size={11} /> Float</button>
                </div>
              )
            })}
          </div>
          {logFor === e.id && <pre className="mt-2 max-h-40 overflow-auto as-scroll text-[10px] text-zinc-400 bg-black/40 p-2 whitespace-pre-wrap">{(extLogs.get(e.id) ?? ['(empty)']).join('\n')}</pre>}
        </div>
      ))}
    </div>
  )
}

/** File > Scripts > Run Script File… (AE): run a .jsx once; ScriptUI windows float. */
export async function runScriptFile(file: File) {
  const toast = useEditorStore.getState().toast
  if (/\.(ffx|aspreset)$/i.test(file.name)) {
    try {
      const { installPresetFiles, applyPreset } = await import('@/lib/extensions/ffx')
      const [e] = await installPresetFiles([file])
      const st = useEditorStore.getState()
      const hasSel = st.selectedClipIds.length > 0 || !!st.selectedClipId
      if (hasSel && (e.effects.length || e.payload)) applyPreset(e)
      const fxNames = e.effects.map(t => t.replace(/_/g, ' ')).join(', ')
      toast({
        kind: e.effects.length || e.payload ? 'success' : 'error',
        title: hasSel ? `Applied preset ${e.name}` : `Installed preset ${e.name}`,
        detail: [hasSel ? '' : 'Find it in Effects & Presets › Animation Presets (double-click to apply)', fxNames ? `Effects: ${fxNames}` : '', e.unsupported.length ? `Not available here: ${e.unsupported.slice(0, 6).join(', ')}` : ''].filter(Boolean).join(' · '),
      })
    } catch (err) { toast({ kind: 'error', title: `Preset error — ${file.name}`, detail: err instanceof Error ? err.message : String(err) }) }
    return
  }
  if (/\.(zip|zxp)$/i.test(file.name)) {
    try { const ext = await useExtStore.getState().install(file); toast({ kind: 'success', title: `Installed ${ext.name}`, detail: 'Find it in Window › Extensions' }) }
    catch (err) { toast({ kind: 'error', title: `Install failed — ${file.name}`, detail: err instanceof Error ? err.message : String(err) }) }
    return
  }
  const code = await file.text()
  if (/@JSXBIN@ES@/.test(code.slice(0, 4096))) {
    toast({ kind: 'error', title: `${file.name} is compiled ExtendScript (.jsxbin)`, detail: 'It is encrypted bytecode only Adobe\'s engine can run — use the .jsx version or the .zxp panel.' })
    return
  }
  const fake: InstalledExt = { id: `run.${file.name}`, kind: 'script', name: file.name, version: '', panels: [], scriptPath: null, files: {}, installedAt: 0 }
  const eng = createEngine({
    log: m => console.info(`[${file.name}]`, m),
    alert: (m, t) => toast({ kind: 'info', title: t || file.name, detail: m }),
    openWindow: w => openScriptWindow(fake, w),
  })
  try {
    await runWithDialogs(() => eng.exec(code))
    toast({ kind: 'success', title: `Ran ${file.name}` })
  } catch (err) {
    toast({ kind: 'error', title: `Script error — ${file.name}`, detail: err instanceof Error ? err.message : String(err) })
  }
}

// floating ScriptUI windows (palettes/dialogs a script shows)
const scriptWindows = new Set<{ key: string; title: string; win: SUIControl }>()
const swSubs = new Set<() => void>()
let swVer = 0
function openScriptWindow(ext: InstalledExt, w: SUIControl) {
  for (const x of scriptWindows) if (x.win === w) return
  scriptWindows.add({ key: `${ext.id}:${Math.random().toString(36).slice(2)}`, title: w.text || ext.name, win: w })
  swVer++; swSubs.forEach(f => f())
}
function closeScriptWindow(w: SUIControl) {
  for (const x of scriptWindows) if (x.win === w) scriptWindows.delete(x)
  swVer++; swSubs.forEach(f => f())
}
const useScriptWindows = () => { useSyncExternalStore(cb => { swSubs.add(cb); return () => swSubs.delete(cb) }, () => swVer, () => swVer); return [...scriptWindows] }

// ------------------------------------------------------------------ a panel (dock tab / floating content)

export function ExtensionView({ extId, panelId }: { extId: string; panelId: string }) {
  useExtensionsLoaded()
  const ext = useExtStore(s => s.list.find(e => e.id === extId))
  const panel = ext?.panels.find(p => p.id === panelId)
  if (!ext || !panel) return <div className="p-4 text-[12px] text-zinc-500">Extension not installed.</div>
  return ext.kind === 'cep' ? <CepFrame ext={ext} panel={panel} /> : <ScriptPanelHost ext={ext} panel={panel} />
}

function CepFrame({ ext, panel }: { ext: InstalledExt; panel: ExtPanel }) {
  const html = useMemo(() => buildPanelDoc(ext, panel), [ext, panel])
  useEffect(() => { engineFor(ext) }, [ext])
  return <iframe title={panel.name} srcDoc={html} className="w-full h-full min-h-[360px] flex-1 border-0 bg-[#232323]" allow="clipboard-read; clipboard-write" />
}

function ScriptPanelHost({ ext, panel }: { ext: InstalledExt; panel: ExtPanel }) {
  const [root, setRoot] = useState<SUIControl | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [runN, setRunN] = useState(0)
  useEffect(() => {
    const code = new TextDecoder().decode(ext.files[ext.scriptPath ?? ''] ?? new Uint8Array())
    const cb = {
      log: (m: string) => console.info(`[${ext.name}]`, m),
      alert: (m: string, t?: string) => useEditorStore.getState().toast({ kind: 'info', title: t || ext.name, detail: m }),
      openWindow: (w: SUIControl) => openScriptWindow(ext, w),
      panel: null as ScriptUIWindow | null,
    }
    const eng = createEngine(cb)
    const PanelCls = eng.scope.Panel as new (t: string, p: null, text: string) => ScriptUIWindow
    const p = new PanelCls('panel', null, panel.name)
    p.orientation = 'column'
    cb.panel = p
    eng.scope.__thisPanel = p
    let alive = true
    runWithDialogs(() => { p.children = []; return eng.exec(`(function(){\n${code}\n}).call(__thisPanel)`) })
      .then(() => { if (alive) setRoot(p) })
      .catch(e => { if (alive) { setErr(e instanceof Error ? e.message : String(e)); setRoot(p) } })
    return () => { alive = false }
  }, [ext, panel, runN])
  return (
    <div className="p-2 text-[12px] h-full overflow-auto as-scroll">
      {err && <div className="text-red-400 text-[11px] mb-2">Script error: {err}</div>}
      {root && (root.children.length ? <ScriptUIView node={root} /> : (
        <div className="text-zinc-400 text-[11.5px] space-y-2">
          <div>{err ? '' : 'This script has no panel of its own: it runs an action (and may open its own windows).'}</div>
          <button className="gbtn gbtn-accent h-8 px-4 flex items-center gap-1.5" onClick={() => { setErr(null); setRunN(n => n + 1) }}><Play size={13} /> Run {panel.name}</button>
        </div>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ ScriptUI renderer

function useSUI() { useSyncExternalStore(subscribeSUI, suiVersion, suiVersion) }

function flexFor(node: SUIControl): CSSProperties {
  const t = node.type
  const orient = String(node.orientation || (t === 'group' ? 'row' : 'column'))
  const ac = node.alignChildren
  const acv = Array.isArray(ac) ? ac[orient === 'row' ? 1 : 0] : ac
  const map: Record<string, string> = { left: 'flex-start', top: 'flex-start', right: 'flex-end', bottom: 'flex-end', center: 'center', fill: 'stretch' }
  const m = node.margins
  const pad = typeof m === 'number' ? m : Array.isArray(m) ? `${m[1]}px ${m[2]}px ${m[3]}px ${m[0]}px` : t === 'panel' ? 10 : t === 'group' ? 0 : 6
  return {
    display: 'flex', flexDirection: orient === 'row' ? 'row' : 'column',
    alignItems: (acv && map[String(acv)]) || (orient === 'row' ? 'center' : t === 'panel' || t === 'palette' || t === 'dialog' || t === 'window' ? 'stretch' : 'flex-start'),
    gap: node.spacing ?? (t === 'group' ? 6 : 8), padding: pad, flexWrap: orient === 'stack' ? undefined : 'nowrap',
  }
}
function selfStyle(node: SUIControl): CSSProperties {
  const al = node.alignment
  const a = Array.isArray(al) ? al[0] : al
  const map: Record<string, string> = { left: 'flex-start', top: 'flex-start', right: 'flex-end', bottom: 'flex-end', center: 'center', fill: 'stretch' }
  const ps = node.preferredSize
  const st: CSSProperties = {}
  if (a && map[String(a)]) { st.alignSelf = map[String(a)]; if (a === 'fill') st.flex = '1 1 auto' }
  if (ps && ps[0] > 0) st.width = ps[0]
  if (ps && ps[1] > 0) st.minHeight = ps[1]
  if (!node.visible) st.display = 'none'
  return st
}

export function ScriptUIView({ node }: { node: SUIControl }) {
  useSUI()
  return <div className="sui" style={flexFor(node)}>{node.children.map((c, i) => <SUIItem key={i} node={c} />)}</div>
}

function fire(node: SUIControl, h: 'onClick' | 'onChange' | 'onChanging' | 'onDoubleClick') {
  const fn = node[h] as ((this: SUIControl) => unknown) | null
  if (fn) callHandler(node, fn).catch(e => useEditorStore.getState().toast({ kind: 'error', title: 'Script error', detail: e instanceof Error ? e.message : String(e) }))
}

function SUIItem({ node }: { node: SUIControl }): ReactNode {
  const t = node.type
  const st = selfStyle(node)
  const dis = !node.enabled
  switch (t) {
    case 'group': case 'panel': case 'tab':
      return (
        <div className={t === 'panel' ? 'sui-panel' : ''} style={{ ...flexFor(node), ...st }} title={node.helpTip}>
          {t === 'panel' && node.text && <span className="sui-panel-t">{node.text}</span>}
          {node.children.map((c, i) => <SUIItem key={i} node={c} />)}
        </div>
      )
    case 'tabbedpanel': {
      const sel = node.selection as SUIControl | null
      return (
        <div className="sui-panel" style={{ ...st, display: node.visible ? 'flex' : 'none', flexDirection: 'column' }}>
          <div className="flex gap-0.5 mb-1">{node.children.map((c, i) => <button key={i} className="vl-chip" data-on={c === sel ? '1' : '0'} onClick={() => { node.selection = c; fire(node, 'onChange') }}>{c.text}</button>)}</div>
          {sel && <SUIItem node={sel} />}
        </div>
      )
    }
    case 'button': case 'iconbutton':
      return <button className="sui-btn" style={st} disabled={dis} title={node.helpTip} onClick={() => fire(node, 'onClick')}>{node.text || (t === 'iconbutton' ? '◆' : 'Button')}</button>
    case 'statictext':
      return <span className="sui-text" style={{ ...st, whiteSpace: (node.properties as { multiline?: boolean })?.multiline ? 'pre-wrap' : 'nowrap' }} title={node.helpTip}>{node.text}</span>
    case 'edittext': {
      const multi = !!(node.properties as { multiline?: boolean })?.multiline
      const common = {
        className: 'ginput sui-input', style: { ...st, minWidth: st.width ?? 60 }, disabled: dis, title: node.helpTip, value: node.text,
        onChange: (e: { target: { value: string } }) => { node.text = e.target.value; fire(node, 'onChanging') },
        onBlur: () => fire(node, 'onChange'),
        onKeyDown: (e: { key: string }) => { if (e.key === 'Enter' && !multi) fire(node, 'onChange') },
      }
      return multi ? <textarea rows={4} {...common} /> : <input {...common} />
    }
    case 'checkbox': case 'radiobutton':
      return (
        <label className="flex items-center gap-1.5 text-zinc-300" style={st} title={node.helpTip}>
          <input type={t === 'checkbox' ? 'checkbox' : 'radio'} checked={!!node.value} disabled={dis} onChange={e => { node.value = t === 'radiobutton' ? true : e.target.checked; fire(node, 'onClick'); fire(node, 'onChange') }} />
          {node.text}
        </label>
      )
    case 'slider': case 'scrollbar':
      return <input type="range" style={{ ...st, minWidth: st.width ?? 100 }} disabled={dis} min={node.minvalue} max={node.maxvalue} step="any" value={Number(node.value) || 0}
        onChange={e => { node.value = Number(e.target.value); fire(node, 'onChanging') }} onPointerUp={() => fire(node, 'onChange')} onKeyUp={() => fire(node, 'onChange')} />
    case 'progressbar':
      return <progress style={{ ...st, minWidth: st.width ?? 100 }} max={node.maxvalue} value={Number(node.value) || 0} />
    case 'dropdownlist': {
      const sel = node.selection as SUIControl | null
      return (
        <select className="ginput" style={st} disabled={dis} title={node.helpTip} value={sel ? String(sel.index) : ''} onChange={e => { node.selection = Number(e.target.value); fire(node, 'onChange') }}>
          {!sel && <option value="">—</option>}
          {node.items.map((it, i) => <option key={i} value={i} disabled={it.type === 'separator'}>{it.text}</option>)}
        </select>
      )
    }
    case 'listbox': {
      const sel = node.selection as SUIControl | null
      return (
        <div className="sui-list" style={{ ...st, minHeight: st.minHeight ?? 80 }}>
          {node.items.map((it, i) => (
            <div key={i} className="sui-li" data-on={it === sel ? '1' : '0'} onClick={() => { node.selection = i; fire(node, 'onChange') }} onDoubleClick={() => fire(node, 'onDoubleClick')}>{it.text}</div>
          ))}
        </div>
      )
    }
    case 'image':
      return <span style={st} />
    default:
      return node.children.length ? <div style={{ ...flexFor(node), ...st }}>{node.children.map((c, i) => <SUIItem key={i} node={c} />)}</div> : null
  }
}

// ------------------------------------------------------------------ floating windows (CEP modeless + ScriptUI palettes)

export function ExtensionFloatingWindows() {
  useExtensionsLoaded()
  const floating = useExtStore(s => s.floating)
  const close = useExtStore(s => s.closeFloating)
  const dock = useExtStore(s => s.dock)
  const sw = useScriptWindows()
  return (
    <>
      {floating.map((f, i) => (
        <FloatPane key={f.key} title={f.title} w={Math.min(f.width, 1200)} h={Math.min(f.height, 820)} offset={i}
          onClose={() => close(f.key)} onDock={() => dock(f.extId, f.panelId)}>
          <ExtensionView extId={f.extId} panelId={f.panelId} />
        </FloatPane>
      ))}
      {sw.map((x, i) => (
        <FloatPane key={x.key} title={x.title} w={360} h={0} offset={floating.length + i} onClose={() => { x.win.close(); closeScriptWindow(x.win) }}>
          <div className="p-2 text-[12px]"><ScriptUIView node={x.win} /></div>
        </FloatPane>
      ))}
    </>
  )
}

function FloatPane({ title, w, h, offset, onClose, onDock, children }: { title: string; w: number; h: number; offset: number; onClose: () => void; onDock?: () => void; children: ReactNode }) {
  const [pos, setPos] = useState({ x: 120 + offset * 28, y: 90 + offset * 28 })
  const [size, setSize] = useState({ w, h })
  const drag = useRef<{ x: number; y: number; px: number; py: number; mode: 'move' | 'size' } | null>(null)
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (d.mode === 'move') setPos({ x: d.px + e.clientX - d.x, y: Math.max(0, d.py + e.clientY - d.y) })
    else setSize({ w: Math.max(240, d.px + e.clientX - d.x), h: Math.max(160, d.py + e.clientY - d.y) })
  }
  return (
    <div className="fixed z-[240] bg-[#262626] border border-black shadow-[0_18px_60px_rgba(0,0,0,0.7)] rounded-[4px] flex flex-col"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h || undefined, maxHeight: '88vh', maxWidth: '96vw' }}
      onPointerMove={move} onPointerUp={() => { drag.current = null }}>
      <div className="h-7 shrink-0 flex items-center px-2 gap-1 bg-[#1f1f1f] border-b border-black text-[12px] text-zinc-200 cursor-move select-none rounded-t-[4px]"
        onPointerDown={e => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y, mode: 'move' } }}>
        <Puzzle size={12} className="text-sky-400" />
        <span className="flex-1 truncate">{title}</span>
        {onDock && <button className="tb-btn !w-6 !h-6" title="Dock in the right panel group" onPointerDown={e => e.stopPropagation()} onClick={onDock}><PanelRight size={12} /></button>}
        <button className="tb-btn !w-6 !h-6" onPointerDown={e => e.stopPropagation()} onClick={onClose} aria-label="Close"><X size={13} /></button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col overflow-auto as-scroll">{children}</div>
      <div className="absolute right-0 bottom-0 w-3 h-3 cursor-se-resize" onPointerDown={e => { e.stopPropagation(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, px: size.w, py: size.h || 400, mode: 'size' } }} />
    </div>
  )
}
