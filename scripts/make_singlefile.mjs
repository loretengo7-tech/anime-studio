#!/usr/bin/env node
/**
 * ANIME STUDIO — single-file inliner v2 (Turbopack-aware)
 *
 * Turbopack chunks self-register via:
 *   (globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push([
 *     "object"==typeof document?document.currentScript:void 0, <moduleId>, ...factories])
 *
 * document.currentScript is NULL for inline <script> (per spec), so when
 * inlining we patch that first argument to the chunk's original URL string —
 * the registration handler accepts strings verbatim. The runtime's own
 * base-path derivation (also currentScript-based) is patched the same way.
 * Lazy chunks are appended as self-registering inline modules; because their
 * registration URL string matches the URL the loader asks for, the loader
 * finds them already loaded and never hits the network.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'fs'
import { join, relative } from 'path'
import vm from 'vm'

const ROOT = '/home/z/my-project'
const DIST = join(ROOT, 'dist-static')
const OUTDIR = join(ROOT, 'download', 'anime-studio')
const OUT = join(OUTDIR, 'index.html')

const collect = (dir, ext, acc = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) collect(p, ext, acc)
    else if (name.endsWith(ext)) acc.push(p)
  }
  return acc
}

const safeJs = js =>
  js.replace(/<\/script>/gi, '<\\/script>').replace(/<!--/g, '<\\!--')

/** Patch a chunk so it self-registers with its URL string instead of currentScript. */
const patchChunk = (js, url) => {
  let out = js.replace(
    '"object"==typeof document?document.currentScript:void 0',
    JSON.stringify(url),
  )
  if (url.includes('/turbopack-')) {
    // runtime base-path derivation: currentScript → own URL (query → "" suffix, same as original)
    out = out.replace(
      'document?.currentScript?.getAttribute?.("src")',
      JSON.stringify(url),
    )
    // diagnostics: log every registerChunk/loadChunkCached call + settlement
    out = out.replace(
      ';let F=globalThis.TURBOPACK;',
      `;["registerChunk","loadChunkCached"].forEach(k=>{const o=e[k];e[k]=function(...a){const key=String(a[1]!==undefined?a[1]:a[0]).slice(0,70);console.log('[TP] call',k,key);const p=o.apply(this,a);if(p&&p.then)p.then(()=>console.log('[TP-OK]',k,key),er=>console.log('[TP-FAIL]',k,er&&er.message));return p}});let F=globalThis.TURBOPACK;`,
    )
    // diagnostics: trace S/E chunk-dependency resolution
    out = out.replace(
      'function S(e,t,r){',
      'function S(e,t,r){console.log("[TP-S]",e,t,typeof r);',
    )
    out = out.replace(
      'function E(t,r,n){',
      'function E(t,r,n){console.log("[TP-E]",t,n);',
    )
  }
  return out
}

const fontMime = u =>
  u.endsWith('.woff2') ? 'font/woff2' : u.endsWith('.woff') ? 'font/woff' : 'application/octet-stream'

const readAsset = href => {
  const p = join(DIST, href.replace(/^\//, '').split('?')[0])
  return readFileSync(p, 'utf8')
}

let html = readFileSync(join(DIST, 'index.html'), 'utf8')

// ---- 1) stylesheets → <style>, fonts as data URLs
const emittedCss = new Set()
html = html.replace(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*\/?>/g, (m, href) => {
  emittedCss.add(href.replace(/^\//, '').split('?')[0])
  const css = readAsset(href)
  const inlined = css.replace(/url\((['"]?)\/(.*?)\1\)/g, (mm, q, path) => {
    const p = join(DIST, path.split('?')[0])
    return `url(${q}data:${fontMime(path)};base64,${readFileSync(p).toString('base64')}${q})`
  })
  return `<style>${inlined}</style>`
})

// lazy CSS chunks referenced by flight data (React injects <link> at hydration)
// → emit them as extra <style> blocks so nothing 404s later
const extraCss = collect(join(DIST, '_next', 'static', 'css'), '.css')
  .map(p => relative(join(DIST, '_next', 'static', 'css'), p).split('\\').join('/'))
  .filter(rel => !emittedCss.has('_next/static/css/' + rel))
const extraCssTags = extraCss.map(rel => {
  const p = join(DIST, '_next', 'static', 'css', rel)
  const css = readFileSync(p, 'utf8').replace(/url\((['"]?)\/?(?!data:)(.*?)\1\)/g, (mm, q, path) => {
    const abs = path.startsWith('_next/') ? path : '_next/static/css/' + path
    const fp = join(DIST, abs.split('?')[0])
    let data
    try { data = readFileSync(fp).toString('base64') } catch { return mm }
    return `url(${q}data:${fontMime(path)};base64,${data}${q})`
  })
  return `<style>${css}</style>`
})
html = html.replace('</head>', `${extraCssTags.join('\n')}\n</head>`)

// ---- 1b) neutralize flight-data CSS URLs: React renders <link href=...css>
// from the RSC payload at hydration; since all CSS is already inlined as
// <style>, swap those URLs for an empty data: URL — no fetch, no 404/reject.
html = html.replace(
  /\/_next\/static\/css\/[A-Za-z0-9._-]+\.css(\?[^"'\\\s]*)?/g,
  'data:text/css;charset=utf-8,%2F*%20bundled%20above%20*%2F',
)

// ---- 2) chunk universe + registration patching
const allChunks = collect(join(DIST, '_next', 'static', 'chunks'), '.js')
  .filter(p => !p.endsWith('.map'))
const patchErrors = []

const patchedContent = new Map()
for (const p of allChunks) {
  const rel = '/' + relative(DIST, p).split('\\').join('/')
  let js = readFileSync(p, 'utf8')
  js = patchChunk(js, rel)
  if (rel.includes('/turbopack-')) {
    // runtime base-path derivation: currentScript → own URL (query → "" suffix, same as original)
    js = js.replace(
      'document?.currentScript?.getAttribute?.("src")',
      JSON.stringify(rel),
    )
  }
  // parse check (module) — catches broken inline output before the browser does
  try {
    new vm.SourceTextModule(js, { identifier: rel })
  } catch (err) {
    patchErrors.push(`${rel}: ${err.message}`)
  }
  patchedContent.set(rel, js)
}
if (patchErrors.length) {
  console.error('PARSE ERRORS:\n' + patchErrors.join('\n'))
  process.exit(1)
}

// ---- 3) inline document scripts in order
const consumed = new Set()
html = html.replace(/<script([^>]*?)\ssrc="([^"]+)"([^>]*)>\s*<\/script>/g, (m, pre, src, post) => {
  const rel = src.replace(/^\//, '').split('?')[0]
  // safeJs is REQUIRED at emit time: the HTML parser closes inline <script>
  // at the first literal </script> inside JS strings
  const js = safeJs(patchedContent.get('/' + rel) ?? readAsset(src))
  consumed.add(rel)
  const attrs = pre + post
  const idM = attrs.match(/id="([^"]+)"/)
  const idAttr = idM ? ` id="${idM[1]}"` : ''
  if (/nomodule/i.test(attrs)) {
    // legacy polyfill chunk — modern browsers never execute it; drop entirely
    return ''
  }
  // CLASSIC script (not module): webpack entry chunks end with `_N_E = e.O()`
  // which relies on implicit-global assignment — illegal in strict modules.
  // The original served these as classic <script src> too.
  return `<script${idAttr} data-src="${rel}">${js}</script>`
})

// ---- 4) append lazy chunks as self-registering inline modules
// NOTE: splice before the LAST </body> — String.replace('</body>') would hit
// the first literal '</body>' inside inlined JS strings (React DOM code).
const lazy = allChunks
  .map(p => '/' + relative(DIST, p).split('\\').join('/'))
  .filter(rel => !consumed.has(rel.slice(1)))
const lazyTags = lazy
  .map(rel => `<script data-src="${rel}">${safeJs(patchedContent.get(rel))}</script>`)
  .join('\n')
const bodyClose = html.lastIndexOf('</body>')
if (bodyClose === -1) throw new Error('no </body> found')
html = html.slice(0, bodyClose) + lazyTags + html.slice(bodyClose)

// ---- 5) drop preload/prefetch noise
html = html.replace(/<link[^>]*rel="(preload|prefetch|preconnect|dns-prefetch|modulepreload)"[^>]*\/?>/g, '')

// ---- 6) error trap + currentScript shim (top of head)
// Next.js getAssetPrefix() asserts document.currentScript — null for inline
// <script> (spec). Shim returns a synthetic <script> whose src sits at the
// site root, so the derived asset prefix is "" (correct for one-file deploys).
const trap = `<script>
window.__errs=[];window.__tp=[];
window.addEventListener('error',function(e){window.__errs.push('ERR ' + ((e.error && (e.error.stack || e.error.message)) || e.message) + ' @' + e.lineno + ':' + e.colno)});
window.addEventListener('unhandledrejection',function(e){window.__errs.push('REJ ' + ((e.reason && (e.reason.stack || e.reason.message)) || String(e.reason)))});
document.addEventListener('error',function(e){var t=e.target;if(t&&t.tagName==='SCRIPT'){window.__errs.push('SCRIPT-ELEMENT-PARSE-ERROR: '+(t.getAttribute('data-src')||'?'))}},true);
try{var __fake=document.createElement('script');__fake.src='/_next/static/chunks/webpack.js';Object.defineProperty(document,'currentScript',{configurable:true,get:function(){return __fake}})}catch(e){window.__errs.push('SHIM-ERR '+e.message)}
Object.defineProperty(globalThis,'TURBOPACK',{configurable:true,get:function(){return window.__TPV},set:function(v){window.__TPV=v;var isArr=Array.isArray(v);var orig=isArr?v.push.bind(v):v.push;v.push=function(a){var first=typeof a==='string'?a:(a&&a.getAttribute?a.getAttribute('src'):(a&&a[0]!==undefined?String(typeof a[0]==='object'&&a[0]!==null?Object.keys(a[0]).join('|'):a[0]):String(a[0]))).slice(0,100);window.__tp.push((isArr?'ARR ':'OBJ ')+a.length+' first='+first);var r=orig.call(this,a);if(r&&typeof r.catch==='function'){r.catch(function(e){window.__errs.push('REG-REJECT: '+(e&&e.message||e))})}return r}}});
</script>`
html = html.replace('<head>', '<head>' + trap)

mkdirSync(OUTDIR, { recursive: true })
writeFileSync(OUT, html)
console.log(`document chunks: ${consumed.size} · lazy appended: ${lazy.length} · total files: ${allChunks.length}`)
console.log(`output: ${OUT} (${(statSync(OUT).size / 1024 / 1024).toFixed(1)} MB)`)
