/**
 * ANIME STUDIO — OpenFX plug-in manager (desktop main process).
 *
 * Runs the ofxhost process (a crashing plug-in only kills that process: it is restarted and
 * the plug-in flagged), finds *.ofx.bundle folders in the standard OFX locations plus folders
 * the user added, caches plug-in descriptions, and renders frames through it.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

function createOfx({ hostPath, configPath, userPluginDir, extraDirs = [], log = () => { } }) {
  let proc = null, buf = '', queue = [], busy = null
  const crashed = new Set()

  function start() {
    if (!fs.existsSync(hostPath)) throw new Error('The OpenFX host is not included in this build')
    proc = spawn(hostPath, [], { cwd: path.dirname(hostPath), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    buf = ''
    proc.stdout.on('data', d => { buf += d.toString('utf8'); pump() })
    proc.stderr.on('data', d => log('ofx', d.toString('utf8').trim().slice(0, 400)))
    proc.stdin.on('error', () => { })
    proc.on('exit', (code, signal) => {
      log('ofx exit', code, signal)
      const cur = busy
      proc = null; busy = null
      if (cur) {
        clearTimeout(cur.timer)
        if (cur.bundle) crashed.add(cur.bundle)
        cur.reject(new Error(cur.timedOut ? 'The plug-in did not answer in time and was stopped.' : `The plug-in crashed (${signal || 'exit ' + code}). It is disabled until AnimeStudio restarts.`))
      }
      next()
    })
  }
  // every request ends with a terminator line: END / OK… / ERR… / PONG (READY = boot banner)
  function pump() {
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const raw of lines) {
      const l = raw.replace(/\r$/, '')
      if (!busy || l.startsWith('READY')) continue
      busy.lines.push(l)
      if (l === 'END' || l === 'PONG' || l.startsWith('OK') || l.startsWith('ERR')) {
        const job = busy; busy = null
        clearTimeout(job.timer)
        job.resolve(job.lines)
        next()
      }
    }
  }
  function next() {
    if (busy || !queue.length) return
    const job = queue.shift()
    try { if (!proc) start() } catch (e) { job.reject(e); next(); return }
    busy = job
    job.timer = setTimeout(() => { job.timedOut = true; try { proc && proc.kill() } catch { } }, job.timeoutMs || 60000)
    proc.stdin.write(job.cmd + '\n')
  }
  function call(cmd, bundle, timeoutMs) {
    return new Promise((resolve, reject) => { queue.push({ cmd, bundle, timeoutMs, resolve, reject, lines: [] }); next() })
  }

  function config() { try { return JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { return { dirs: [], cache: {} } } }
  function saveConfig(c) { try { fs.mkdirSync(path.dirname(configPath), { recursive: true }); fs.writeFileSync(configPath, JSON.stringify(c)) } catch (e) { log('ofx cfg', e) } }
  function defaultDirs() {
    const d = [...extraDirs]
    if (process.env.OFX_PLUGIN_PATH) d.push(...process.env.OFX_PLUGIN_PATH.split(path.delimiter))
    if (process.platform === 'win32') {
      d.push(path.join(process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files', 'OFX', 'Plugins'))
      if (process.env['CommonProgramFiles(x86)']) d.push(path.join(process.env['CommonProgramFiles(x86)'], 'OFX', 'Plugins'))
    } else if (process.platform === 'darwin') d.push('/Library/OFX/Plugins')
    else d.push('/usr/OFX/Plugins')
    d.push(userPluginDir)
    return d
  }
  function findBundles(dir, depth = 0, out = []) {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
    for (const e of ents) {
      if (!e.isDirectory()) continue
      const p = path.join(dir, e.name)
      if (/\.ofx\.bundle$/i.test(e.name)) out.push(p)
      else if (depth < 3) findBundles(p, depth + 1, out)
    }
    return out
  }
  function parseDescribe(bundle, lines) {
    const plugins = [], skipped = []
    let err = null
    for (const l of lines) {
      const a = l.split('\t')
      if (a[0] === 'PLUGIN') plugins.push({ bundle, index: +a[1], id: a[2], label: a[3], group: a[4], context: a[5], temporal: a[6] === '1', depth: +a[7], params: [] })
      else if (a[0] === 'PARAM') {
        const pl = plugins.find(p => p.index === +a[1])
        if (pl) pl.params.push({ name: a[2], type: a[3], label: a[4], dims: +a[5], min: +a[6], max: +a[7], def: (a[8] || '').split(',').map(Number), choices: a[9] ? a[9].split('|') : [], hint: a[10] || '' })
      } else if (a[0] === 'SKIP') skipped.push({ index: +a[1], id: a[2], reason: a[3] })
      else if (a[0] === 'ERR') err = a.slice(1).join(' ')
    }
    return { bundle, plugins, skipped, err }
  }

  async function scan(force) {
    const cfg = config()
    cfg.cache = cfg.cache || {}
    const dirs = [...new Set([...defaultDirs(), ...(cfg.dirs || [])])]
    const bundles = [...new Set(dirs.flatMap(d => findBundles(d)))]
    const results = []
    for (const b of bundles) {
      let mtime = 0
      try { mtime = fs.statSync(b).mtimeMs } catch { }
      const hit = cfg.cache[b]
      if (!force && hit && hit.mtime === mtime) { results.push(hit.result); continue }
      if (crashed.has(b)) { results.push({ bundle: b, plugins: [], skipped: [], err: 'crashed while loading' }); continue }
      try {
        const r = parseDescribe(b, await call('DESCRIBE\t' + b, b, 30000))
        cfg.cache[b] = { mtime, result: r }
        results.push(r)
      } catch (e) { results.push({ bundle: b, plugins: [], skipped: [], err: String((e && e.message) || e) }) }
    }
    saveConfig(cfg)
    return { dirs, hostOk: fs.existsSync(hostPath), results }
  }
  async function addDir(dir) {
    const cfg = config()
    cfg.dirs = [...new Set([...(cfg.dirs || []), dir])]
    saveConfig(cfg)
    return scan(false)
  }
  let tmp = null
  async function render({ bundle, index, w, h, time, params, data }) {
    if (crashed.has(bundle)) throw new Error('This plug-in crashed earlier — restart AnimeStudio to try it again')
    tmp = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'as-ofx-'))
    const id = Math.random().toString(36).slice(2)
    const inP = path.join(tmp, id + '.in'), outP = path.join(tmp, id + '.out')
    fs.writeFileSync(inP, Buffer.from(data))
    const enc = Object.entries(params || {}).filter(([k]) => /^[\w.\-]+$/.test(k))
      .map(([k, v]) => `${k}=${(Array.isArray(v) ? v : [v]).map(x => (Number.isFinite(+x) ? +x : 0)).join(',')}`).join(';')
    try {
      const lines = await call(['RENDER', bundle, index | 0, w | 0, h | 0, +time || 0, inP, outP, enc].join('\t'), bundle, 120000)
      const last = lines[lines.length - 1] || ''
      if (!last.startsWith('OK')) throw new Error(last.replace(/^ERR\t?/, '') || 'render failed')
      const out = fs.readFileSync(outP)
      return { data: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength), ms: +(last.split('\t')[1] || 0) }
    } finally {
      fs.rmSync(inP, { force: true }); fs.rmSync(outP, { force: true })
    }
  }
  function quit() { try { proc && proc.stdin.write('QUIT\n') } catch { } }
  return { scan, addDir, render, quit, userPluginDir, crashed }
}

module.exports = { createOfx }
