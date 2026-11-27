/**
 * CEP host (After Effects HTML extension panels, .zxp) for AnimeStudio.
 *
 * A panel's HTML runs in an iframe with an `__adobe_cep__` / `window.cep`
 * implementation, so the extension's own CSInterface.js works unchanged.
 * `evalScript()` runs in the extension's ExtendScript engine (aeDom.ts),
 * which loads the bundle's host .jsx once and keeps its functions alive.
 */
import { createEngine, runWithDialogs, type ScriptEngine } from './aeDom'
import type { InstalledExt, ExtPanel } from './store'
import { useExtStore } from './store'
import { useEditorStore } from '@/lib/store/editorStore'

const engines = new Map<string, ScriptEngine>()
export const extLogs = new Map<string, string[]>()
function pushLog(id: string, m: string) {
  const a = extLogs.get(id) ?? []
  a.push(m); if (a.length > 300) a.shift()
  extLogs.set(id, a)
}

function decode(u8: Uint8Array) { return new TextDecoder().decode(u8) }

export function engineFor(ext: InstalledExt): ScriptEngine {
  let e = engines.get(ext.id)
  if (e) return e
  e = createEngine({
    log: m => pushLog(ext.id, m),
    alert: (m, t) => useEditorStore.getState().toast({ kind: 'info', title: t || ext.name, detail: m }),
  })
  engines.set(ext.id, e)
  if (ext.kind === 'cep' && ext.scriptPath && ext.files[ext.scriptPath]) {
    try { e.exec(decode(ext.files[ext.scriptPath])) } catch (err) { pushLog(ext.id, `Host script error: ${err instanceof Error ? err.message : String(err)}`) }
  }
  return e
}
export function resetEngine(id: string) { engines.delete(id) }

// ------------------------------------------------------------------ bridge the panels call (same origin)

type Listener = { type: string; fn: (e: unknown) => void; win: Window }
const evListeners: Listener[] = []
let busy = false
const queue: (() => Promise<void>)[] = []

function cepResult(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  if (typeof v === 'object' && typeof (v as { toString?: unknown }).toString === 'function') return String(v)
  return String(v)
}

const bridge = {
  evalScript(extId: string, script: string, cb?: (r: string) => void) {
    const run = async () => {
      const ext = useExtStore.getState().list.find(e => e.id === extId)
      let out = 'EvalScript error.'
      if (ext) {
        busy = true
        try { out = cepResult(await runWithDialogs(() => engineFor(ext).exec(String(script)))) } catch (err) {
          pushLog(extId, `evalScript error: ${err instanceof Error ? err.message : String(err)} ← ${String(script).slice(0, 120)}`)
          out = 'EvalScript error.'
        } finally { busy = false }
      }
      setTimeout(() => { try { cb?.(out) } catch { } ; if (queue.length) void queue.shift()!() }, 0)
    }
    if (busy) queue.push(run); else void run()
  },
  listPanels(extId: string) {
    const ext = useExtStore.getState().list.find(e => e.id === extId)
    return (ext?.panels ?? []).map(p => ({ id: p.id, name: p.name, mainPath: p.main, basePath: '', windowType: p.type, width: p.width, height: p.height, minWidth: 0, minHeight: 0, maxWidth: 0, maxHeight: 0, defaultExtensionDataXml: '', specialExtensionDataXml: '', requiredRuntimeList: [], isAutoVisible: true, isPluginExtension: false }))
  },
  openExtension(extId: string, panelId: string) {
    const ext = useExtStore.getState().list.find(e => e.id === extId)
    const p = ext?.panels.find(x => x.id === panelId)
    if (!p) return
    if (useExtStore.getState().docked.includes(`${extId}|${panelId}`)) return
    useExtStore.getState().openFloating(extId, panelId)
  },
  closeExtension(extId: string, panelId: string) { useExtStore.getState().closeFloating(`${extId}|${panelId}`) },
  on(type: string, fn: (e: unknown) => void, win: Window) { evListeners.push({ type, fn, win }) },
  off(type: string, fn: (e: unknown) => void) { const i = evListeners.findIndex(l => l.type === type && l.fn === fn); if (i >= 0) evListeners.splice(i, 1) },
  dispatch(ev: { type?: string }) {
    for (const l of [...evListeners]) {
      if (l.win.closed) { evListeners.splice(evListeners.indexOf(l), 1); continue }
      if (l.type === ev?.type) setTimeout(() => { try { l.fn(ev) } catch { } }, 0)
    }
  },
  openURL(u: string) { window.open(u, '_blank', 'noopener') },
  log(extId: string, m: string) { pushLog(extId, m) },
}
if (typeof window !== 'undefined') (window as unknown as { __AS_CEP__: typeof bridge }).__AS_CEP__ = bridge

// ------------------------------------------------------------------ building the panel document

const blobUrls = new Map<string, string>()
function mime(path: string) {
  const e = path.split('.').pop()?.toLowerCase()
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', json: 'application/json', css: 'text/css', js: 'text/javascript', mp4: 'video/mp4', wav: 'audio/wav', mp3: 'audio/mpeg' } as Record<string, string>)[e ?? ''] ?? 'application/octet-stream'
}
function fileUrl(ext: InstalledExt, path: string): string | null {
  const data = ext.files[path]
  if (!data) return null
  const key = `${ext.id}|${path}`
  let u = blobUrls.get(key)
  if (!u) { u = URL.createObjectURL(new Blob([data as BlobPart], { type: mime(path) })); blobUrls.set(key, u) }
  return u
}
function resolve(base: string, rel: string): string {
  if (/^(https?:|data:|blob:|\/\/)/i.test(rel)) return rel
  const parts = (base ? base.split('/') : []).concat(rel.split('?')[0].split('#')[0].split('/'))
  const out: string[] = []
  for (const p of parts) { if (!p || p === '.') continue; if (p === '..') out.pop(); else out.push(p) }
  return out.join('/')
}
const safeScript = (js: string) => js.replace(/<\/script/gi, '<\\/script')
function patchJs(js: string) {
  return js.replace(/\bwindow\.location\.search\b/g, '(window.__CEP_SEARCH__)').replace(/\bdocument\.location\.search\b/g, '(window.__CEP_SEARCH__)')
}

function shim(ext: InstalledExt, panel: ExtPanel): string {
  const env = {
    appName: 'AEFT', appVersion: '24.0.0', appLocale: 'en_US', appUILocale: 'en_US', appId: 'AEFT', isAppOnline: true,
    appSkinInfo: {
      baseFontFamily: 'Inter', baseFontSize: 10,
      appBarBackgroundColor: { antialiasLevel: 0, type: 1, color: { red: 38, green: 38, blue: 38, alpha: 255 } },
      panelBackgroundColor: { antialiasLevel: 0, type: 1, color: { red: 35, green: 35, blue: 35, alpha: 255 } },
      appBarBackgroundColorSRGB: { antialiasLevel: 0, type: 1, color: { red: 38, green: 38, blue: 38, alpha: 255 } },
      panelBackgroundColorSRGB: { antialiasLevel: 0, type: 1, color: { red: 35, green: 35, blue: 35, alpha: 255 } },
      systemHighlightColor: { red: 45, green: 140, blue: 235, alpha: 255 },
    },
  }
  return `(function(){
  var B = window.parent.__AS_CEP__; var EXT = ${JSON.stringify(ext.id)}, PANEL = ${JSON.stringify(panel.id)};
  window.__CEP_SEARCH__ = ${JSON.stringify(panel.query)};
  var ENV = ${JSON.stringify(JSON.stringify(env))};
  window.__adobe_cep__ = {
    evalScript: function(s, cb) { B.evalScript(EXT, s, cb); },
    getHostEnvironment: function() { return ENV; },
    getHostCapabilities: function() { return JSON.stringify({ EXTENDED_PANEL_MENU: true, EXTENDED_PANEL_ICONS: true, DELEGATE_APE_ENGINE: false, SUPPORT_HTML_EXTENSIONS: true, DISABLE_FLASH_EXTENSIONS: true }); },
    getCurrentApiVersion: function() { return JSON.stringify({ major: 11, minor: 0, micro: 0 }); },
    getSystemPath: function(t) { return '/AnimeStudio/extensions/' + EXT; },
    getExtensionId: function() { return PANEL; },
    getExtensions: function() { return JSON.stringify(B.listPanels(EXT)); },
    requestOpenExtension: function(id) { B.openExtension(EXT, id); },
    closeExtension: function() { B.closeExtension(EXT, PANEL); },
    addEventListener: function(type, fn) { B.on(type, fn, window); },
    removeEventListener: function(type, fn) { B.off(type, fn); },
    dispatchEvent: function(ev) { B.dispatch(typeof ev === 'string' ? JSON.parse(ev) : ev); },
    resizeContent: function() {}, getScaleFactor: function() { return window.devicePixelRatio || 1; }, getMonitorScaleFactor: function() { return window.devicePixelRatio || 1; },
    setScaleFactorChangedHandler: function() {}, getNetworkPreferences: function() { return '{}'; }, initResourceBundle: function() { return '{}'; },
    dumpInstallationInfo: function() { return ''; }, invokeSync: function() { return ''; }, invokeAsync: function(n, a, cb) { cb && cb(''); },
    registerKeyEventsInterest: function() {}, registerInvalidCertificateCallback: function() {}, loadSnapshot: function() {},
    setPanelFlyoutMenu: function() {}, updatePanelMenuItem: function() { return true; }, setContextMenu: function() {}, setContextMenuByJSON: function() {}, updateContextMenuItem: function() {},
    isWindowVisible: function() { return true; }, getWindowTitle: function() { return ${JSON.stringify(panel.name)}; }, setWindowTitle: function() {}
  };
  var VFS = 'cepfs:' + EXT + ':';
  function vget(p) { try { return localStorage.getItem(VFS + p); } catch (e) { return null; } }
  function vset(p, d) { try { localStorage.setItem(VFS + p, d); return true; } catch (e) { return false; } }
  window.cep = {
    fs: {
      NO_ERROR: 0, ERR_UNKNOWN: 1, ERR_INVALID_PARAMS: 2, ERR_NOT_FOUND: 3, ERR_CANT_READ: 4, ERR_UNSUPPORTED_ENCODING: 5, ERR_CANT_WRITE: 6, ERR_OUT_OF_SPACE: 7, ERR_NOT_FILE: 8, ERR_NOT_DIRECTORY: 9, ERR_FILE_EXISTS: 10,
      readFile: function(p) { var d = vget(p); return d === null ? { err: 3, data: '' } : { err: 0, data: d }; },
      writeFile: function(p, d) { return { err: vset(p, String(d)) ? 0 : 6 }; },
      makedir: function() { return { err: 0 }; }, rename: function() { return { err: 0 }; }, deleteFile: function(p) { try { localStorage.removeItem(VFS + p); } catch (e) {} return { err: 0 }; },
      readdir: function() { return { err: 0, data: [] }; }, stat: function(p) { return vget(p) === null ? { err: 3 } : { err: 0, data: { isFile: function() { return true; }, isDirectory: function() { return false; } } }; },
      chmod: function() { return { err: 0 }; },
      showOpenDialog: function() { return { err: 0, data: [] }; }, showOpenDialogEx: function() { return { err: 0, data: [] }; },
      showSaveDialogEx: function() { return { err: 0, data: '' }; }
    },
    util: { openURLInDefaultBrowser: function(u) { B.openURL(u); return { err: 0 }; }, registerExtensionUnloadCallback: function() {}, storeProxyCredentials: function() {}, DEPRECATED_API: 100, ERR_INVALID_URL: 201 },
    process: { createProcess: function() { return { err: 1 }; }, isRunning: function() { return { err: 0, data: false }; } },
    encoding: { UTF8: 'UTF-8', Base64: 'Base64' }
  };
  var _log = console.log, _err = console.error;
  console.error = function() { try { B.log(EXT, 'console.error: ' + Array.prototype.join.call(arguments, ' ')); } catch (e) {} return _err.apply(console, arguments); };
})();`
}

/** Self-contained HTML for one panel: scripts/styles inlined, assets as blob URLs. */
export function buildPanelDoc(ext: InstalledExt, panel: ExtPanel): string {
  const html = decode(ext.files[panel.main] ?? new TextEncoder().encode('<p>Missing panel file</p>'))
  const base = panel.main.includes('/') ? panel.main.slice(0, panel.main.lastIndexOf('/')) : ''
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const deferred: string[] = []
  for (const s of [...doc.querySelectorAll('script')]) {
    const src = s.getAttribute('src')
    if (src && !/^(https?:)?\/\//i.test(src)) {
      const path = resolve(base, src)
      const data = ext.files[path]
      const js = data ? patchJs(decode(data)) : `console.warn('missing ${path}')`
      const isModule = s.getAttribute('type') === 'module'
      if (s.hasAttribute('defer') || isModule) {
        deferred.push(`<script${isModule ? ' type="module"' : ''}>${safeScript(js)}</script>`)
        s.remove()
      } else {
        const n = doc.createElement('script')
        n.textContent = safeScript(js)
        s.replaceWith(n)
      }
    } else if (!src && s.textContent) {
      s.textContent = safeScript(patchJs(s.textContent))
    }
  }
  for (const l of [...doc.querySelectorAll('link[rel="stylesheet"]')]) {
    const href = l.getAttribute('href')
    if (!href || /^(https?:)?\/\//i.test(href)) continue
    const path = resolve(base, href)
    const data = ext.files[path]
    if (!data) continue
    const css = decode(data).replace(/url\((['"]?)([^'")]+)\1\)/g, (m, q, u) => {
      const p = resolve(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', u)
      const b = fileUrl(ext, p)
      return b ? `url(${q}${b}${q})` : m
    })
    const st = doc.createElement('style')
    st.textContent = css
    l.replaceWith(st)
  }
  for (const el of [...doc.querySelectorAll('[src]')]) {
    if (el.tagName === 'SCRIPT') continue
    const v = el.getAttribute('src')!
    const b = /^(https?:|data:|blob:|\/\/)/i.test(v) ? null : fileUrl(ext, resolve(base, v))
    if (b) el.setAttribute('src', b)
  }
  const head = doc.head
  const sh = doc.createElement('script')
  sh.textContent = safeScript(shim(ext, panel))
  head.insertBefore(sh, head.firstChild)
  const style = doc.createElement('style')
  style.textContent = 'html,body{background:#232323;color:#ddd;margin:0}'
  head.insertBefore(style, sh.nextSibling)
  const tail = deferred.join('\n') + '</body>'
  return '<!DOCTYPE html>' + doc.documentElement.outerHTML.replace('</body>', () => tail)
}
