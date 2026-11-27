/**
 * AnimeStudio Desktop — Electron shell for the AnimeStudio web editor.
 *
 * Why a desktop build: same editor, but
 *  - GPU acceleration is forced on (no blocklist), zero-copy video upload,
 *    no tab background throttling → steadier preview and RAM previews
 *  - bundled ffmpeg converts formats browsers can't decode (MKV/HEVC/AC3,
 *    AVI, ProRes…) and builds lightweight preview proxies fast
 *  - more memory for the RAM preview cache
 */
const { app, BrowserWindow, protocol, net, ipcMain, shell, session, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')

// ---------- crash log (so a window that "doesn't open" leaves a reason) ----------
let logFile = null
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(x => (x && x.stack) || String(x)).join(' ')}\n`
  try { process.stdout.write(line) } catch { }
  try {
    if (!logFile) {
      const dir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(dir, { recursive: true })
      logFile = path.join(dir, 'main.log')
      try { if (fs.statSync(logFile).size > 2e6) fs.rmSync(logFile) } catch { }
    }
    fs.appendFileSync(logFile, line)
  } catch { }
}
process.on('uncaughtException', e => {
  log('uncaughtException', e)
  try { dialog.showErrorBox('AnimeStudio', `Error al iniciar:\n${e && e.message}\n\nLog: ${logFile || ''}`) } catch { }
})
process.on('unhandledRejection', e => log('unhandledRejection', e))

// ---------- GPU mode ----------
// Safe mode = no forced GPU flags. It is used automatically when the GPU
// process crashes at startup (some drivers die with zero-copy / ignored
// blocklist), or with --safe-gpu.
const SAFE_FLAG = path.join(app.getPath('userData'), 'safe-gpu')
const safeGpu = process.argv.includes('--safe-gpu') || fs.existsSync(SAFE_FLAG)
if (!safeGpu) {
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-gpu-rasterization')
  app.commandLine.appendSwitch('enable-zero-copy')
  app.commandLine.appendSwitch('force_high_performance_gpu')
  app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,CanvasOopRasterization')
}
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192')

// one window only: a 2nd launch (double click on the shortcut) focuses it
// instead of starting a second copy fighting over the same profile / GPU cache
if (!process.env.AS_SMOKE && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0]
    if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus() }
  })
}

let gpuCrashes = 0
app.on('child-process-gone', (_e, d) => {
  log('child-process-gone', JSON.stringify(d))
  if (d.type === 'GPU' && !safeGpu && ++gpuCrashes >= 2) {
    try { fs.writeFileSync(SAFE_FLAG, '1') } catch { }
    log('GPU crashed twice — relaunching in safe GPU mode')
    app.relaunch({ args: [...process.argv.slice(1), '--safe-gpu'] })
    app.exit(0)
  }
})

const APP_DIR = path.join(__dirname, 'app')

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

function ffmpegPath() {
  try {
    const p = require('ffmpeg-static')
    return p ? p.replace('app.asar', 'app.asar.unpacked') : 'ffmpeg'
  } catch { return 'ffmpeg' }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true })
    let err = ''
    p.stderr.on('data', d => { err = (err + d.toString()).slice(-4000) })
    p.on('error', reject)
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err.split('\n').slice(-4).join(' ')}`))))
  })
}

ipcMain.handle('as:transcode', async (_e, { name, data, preset }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animestudio-'))
  const safe = String(name || 'media').replace(/[^\w.-]+/g, '_')
  const input = path.join(dir, safe)
  const out = path.join(dir, safe.replace(/\.[^.]+$/, '') + (preset === 'proxy' ? '.proxy.mp4' : '.mp4'))
  fs.writeFileSync(input, Buffer.from(data))
  const common = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-map', '0:v:0?', '-map', '0:a:0?', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']
  // Influx-style universal import: any format ffmpeg reads; keeps transparency
  // (ProRes 4444, QT Animation/PNG, VP9/VP8 alpha, GIF/APNG) by going to
  // VP9-with-alpha WebM (Chromium decodes the alpha), everything else → H.264.
  if (preset === 'influx') {
    const probeErr = await new Promise(res => {
      const p = spawn(ffmpegPath(), ['-hide_banner', '-i', input], { windowsHide: true })
      let err = ''
      p.stderr.on('data', d => { err += d.toString() })
      p.on('close', () => res(err)); p.on('error', () => res(err))
    })
    const info = String(probeErr || '')
    const vline = (info.match(/Stream #\S+.*Video: .*/) || [''])[0]
    const alpha = /yuva|rgba|argb|bgra|abgr|gbrap|ya8|ya16|pal8|qtrle|png|prores_?4444|ap4h|ap4x/i.test(vline) || /alpha_mode\s*:\s*1/i.test(info)
    const isGif = /\.(gif|apng)$/i.test(safe) || /Video: (gif|apng)/i.test(vline)
    const outA = path.join(dir, safe.replace(/\.[^.]+$/, '') + (alpha ? '.webm' : '.mp4'))
    const argsA = alpha
      ? ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '18', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-c:a', 'libopus', '-b:a', '160k', outA]
      : ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-map', '0:v:0?', '-map', '0:a:0?', ...(isGif ? ['-vf', "scale='trunc(iw/2)*2':'trunc(ih/2)*2'"] : []), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outA]
    try {
      await runFfmpeg(argsA)
      const buf = fs.readFileSync(outA)
      log('influx', safe, alpha ? 'alpha→webm' : '→mp4', vline.slice(0, 160))
      return { name: path.basename(outA), alpha, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  const args = preset === 'proxy'
    // proxy: ≤960 px, short GOP + fastdecode → instant scrubbing; frame rate preserved (up to 240)
    ? [...common, '-vf', "scale='min(960,iw)':-2", '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'fastdecode', '-g', '12', '-crf', '23', out]
    // compat: visually lossless H.264 the editor can decode
    : [...common, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', out]
  try {
    await runFfmpeg(args)
    const buf = fs.readFileSync(out)
    return { name: path.basename(out), data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- Video Lab (Topaz-style enhance + Flowframes-style interpolation) ----------
// ---------- neural tools (bundled by CI): Real-ESRGAN + RIFE, ncnn-vulkan builds ----------
function aiDir() { return app.isPackaged ? path.join(process.resourcesPath, 'ai') : path.join(__dirname, 'ai') }
function aiTools() {
  const d = aiDir(), ext = process.platform === 'win32' ? '.exe' : ''
  const esrgan = path.join(d, 'realesrgan', 'realesrgan-ncnn-vulkan' + ext)
  const rife = path.join(d, 'rife', 'rife-ncnn-vulkan' + ext)
  return {
    esrgan: fs.existsSync(esrgan) ? esrgan : null,
    esrganModels: path.join(d, 'realesrgan', 'models'),
    rife: fs.existsSync(rife) ? rife : null,
    rifeModel: path.join(d, 'rife', 'rife-v4.6'),
  }
}
ipcMain.handle('as:ai-tools', async () => { const t = aiTools(); return { esrgan: !!t.esrgan, rife: !!t.rife } })

const labProcs = new Set()
let labCancelled = false
ipcMain.handle('as:videolab-cancel', async () => { labCancelled = true; for (const p of labProcs) { try { p.kill() } catch { } } return true })

/** Run a tool; resolves on exit 0. onLine gets stdout lines (ffmpeg -progress). */
function runTool(exe, args, opts = {}) {
  return new Promise((resolve, reject) => {
    if (labCancelled) return reject(new Error('Cancelled'))
    const p = spawn(exe, args, { windowsHide: true, cwd: opts.cwd })
    labProcs.add(p)
    let err = '', buf = ''
    p.stdout.on('data', d => {
      if (!opts.onLine) return
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) { opts.onLine(buf.slice(0, i).trim()); buf = buf.slice(i + 1) }
    })
    p.stderr.on('data', d => { err = (err + d.toString()).slice(-4000) })
    p.on('error', e => { labProcs.delete(p); reject(e) })
    p.on('close', code => {
      labProcs.delete(p)
      if (labCancelled) return reject(new Error('Cancelled'))
      code === 0 ? resolve() : reject(new Error(`${path.basename(exe)} failed (${code}): ${err.split('\n').filter(Boolean).slice(-3).join(' ')}`))
    })
  })
}
const countFiles = d => { try { return fs.readdirSync(d).length } catch { return 0 } }

ipcMain.handle('as:videolab-preview', async (_e, { name, data, time, model, scale }) => {
  const t = aiTools()
  if (!t.esrgan) throw new Error('Real-ESRGAN is not bundled in this build')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animestudio-pv-'))
  try {
    const input = path.join(dir, String(name || 'media').replace(/[^\w.-]+/g, '_'))
    fs.writeFileSync(input, Buffer.from(data))
    const f = path.join(dir, 'f'), u = path.join(dir, 'u')
    fs.mkdirSync(f); fs.mkdirSync(u)
    labCancelled = false
    await runTool(ffmpegPath(), ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, Number(time) || 0)), '-i', input, '-frames:v', '1', path.join(f, '00000001.png')])
    const m = /x4plus/.test(model) ? 'realesrgan-x4plus-anime' : 'realesr-animevideov3'
    const sc = m === 'realesrgan-x4plus-anime' ? 4 : Math.max(2, Math.min(4, Math.round(Number(scale) || 2)))
    try {
      await runTool(t.esrgan, ['-i', f, '-o', u, '-n', m, '-s', String(sc), '-m', t.esrganModels, '-f', 'png'], { cwd: path.dirname(t.esrgan) })
    } catch (err) { throw new Error(`${err.message} — Real-ESRGAN needs a GPU with Vulkan (update your graphics driver).`) }
    const read = p => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
    return { before: read(path.join(f, '00000001.png')), after: read(path.join(u, '00000001.png')) }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

ipcMain.handle('as:videolab', async (e, { name, data, opts }) => {
  labCancelled = false
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animestudio-lab-'))
  const safe = String(name || 'media').replace(/[^\w.-]+/g, '_')
  const input = path.join(dir, safe)
  const out = path.join(dir, 'lab-out.mp4')
  fs.writeFileSync(input, Buffer.from(data))
  const send = (progress, speed, fps) => { try { e.sender.send('as:videolab-progress', { progress: Math.max(0, Math.min(1, progress)), speed, fps }) } catch { } }
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  const start = Math.max(0, num(opts.start, 0))
  const dur = Math.max(0.05, num(opts.end, start + 1) - start)
  const srcFps = Math.max(1, num(opts.srcFps, 30))
  const target = opts.targetFps ? Math.min(480, Math.max(1, num(opts.targetFps, srcFps))) : null
  const factor = target ? target / srcFps : 1
  const w = Math.max(16, Math.round(num(opts.width, 1920) / 2) * 2), h = Math.max(16, Math.round(num(opts.height, 1080) / 2) * 2)
  const en = opts.enhance || null
  const slow = !!(opts.slowmo && target)
  const crf = String(Math.min(30, Math.max(10, Math.round(num(opts.crf, 16)))))
  const neuralUp = opts.neuralUpscale || null // { model, scale }
  const useRife = opts.method === 'rife' && !!target
  const pre = [], post = []
  if (en) {
    const d = num(en.denoise, 0), db = num(en.deblock, 0)
    if (d + db > 0.02) pre.push(`hqdn3d=${(1 + 6 * d + 3 * db).toFixed(2)}:${(1 + 4 * d).toFixed(2)}:${(2 + 6 * d).toFixed(2)}:${(2 + 4 * d).toFixed(2)}`)
    const sh = Math.min(2, num(en.sharpen, 0) * 1.4 + num(en.detail, 0) * 0.6)
    if (sh > 0.02) post.push(`unsharp=5:5:${sh.toFixed(2)}:5:5:0`)
  }
  const tag = [en || neuralUp ? `${h}p` : '', target ? (slow ? `${Math.round(factor)}x-slowmo` : `${target}fps`) : '', useRife ? 'RIFE' : '', neuralUp ? 'ESRGAN' : ''].filter(Boolean).join('-') || 'lab'
  const base = safe.replace(/\.[^.]+$/, '')
  const finish = () => { const buf = fs.readFileSync(out); return { name: `${base} [${tag}].mp4`, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } }
  const ffProgress = (outDur, from, span, label) => {
    const last = {}
    return line => {
      const [k, v] = line.split('=')
      if (k === 'out_time_us' || k === 'out_time_ms') last.t = Number(v) / 1e6
      else if (k === 'fps') last.fps = Number(v)
      else if (k === 'speed') last.speed = v
      else if (k === 'progress') send(from + span * Math.min(1, (last.t || 0) / outDur), `${label} ${last.speed || ''}`, last.fps)
    }
  }
  try {
    // ---------------- neural path (Real-ESRGAN and/or RIFE on extracted frames) ----------------
    if (neuralUp || useRife) {
      const t = aiTools()
      if (neuralUp && !t.esrgan) throw new Error('Real-ESRGAN is not bundled in this build')
      if (useRife && !t.rife) throw new Error('RIFE is not bundled in this build')
      const fDir = path.join(dir, 'f'), uDir = path.join(dir, 'u'), rDir = path.join(dir, 'r')
      for (const d of [fDir, uDir, rDir]) fs.mkdirSync(d)
      const nEst = Math.max(1, Math.round(dur * srcFps))
      const W = { ex: 0.08, up: neuralUp ? 0.5 : 0, ri: useRife ? 0.3 : 0, enc: 0.12 }
      const tot = W.ex + W.up + W.ri + W.enc
      let at = 0
      // 1) extract source frames (with the pre-clean filters)
      await runTool(ffmpegPath(), ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', input,
        '-map', '0:v:0', '-fps_mode', 'passthrough', ...(pre.length ? ['-vf', pre.join(',')] : []), path.join(fDir, '%08d.png')],
        { onLine: ffProgress(dur, 0, W.ex / tot, 'extracting frames') })
      at += W.ex / tot
      const n = countFiles(fDir)
      if (!n) throw new Error('No frames could be extracted from this clip')
      let cur = fDir
      const watch = (d, expect, from, span, label) => setInterval(() => send(from + span * Math.min(1, countFiles(d) / expect), label), 700)
      // 2) Real-ESRGAN upscale
      if (neuralUp) {
        const model = /x4plus/.test(neuralUp.model) ? 'realesrgan-x4plus-anime' : 'realesr-animevideov3'
        const sc = model === 'realesrgan-x4plus-anime' ? 4 : Math.max(2, Math.min(4, Math.round(num(neuralUp.scale, 2))))
        const iv = watch(uDir, n, at, W.up / tot, `Real-ESRGAN ${model} ${sc}×`)
        try {
          await runTool(t.esrgan, ['-i', fDir, '-o', uDir, '-n', model, '-s', String(sc), '-m', t.esrganModels, '-f', 'png'], { cwd: path.dirname(t.esrgan) })
        } catch (err) { throw new Error(`${err.message} — Real-ESRGAN needs a GPU with Vulkan (update your graphics driver), or use the classic GPU enhance.`) }
        finally { clearInterval(iv) }
        at += W.up / tot
        cur = uDir
      }
      // 3) RIFE interpolation to the exact target frame count
      let outFrames = n
      if (useRife) {
        outFrames = Math.max(n, Math.round(n * factor))
        const iv = watch(rDir, outFrames, at, W.ri / tot, `RIFE 4.6 → ${outFrames} frames`)
        try {
          const uhd = Math.max(w, h) > 2600 ? ['-u'] : []
          await runTool(t.rife, ['-i', cur, '-o', rDir, '-m', t.rifeModel, '-n', String(outFrames), '-f', '%08d.png', ...uhd], { cwd: path.dirname(t.rife) })
        } catch (err) { throw new Error(`${err.message} — RIFE needs a GPU with Vulkan (update your graphics driver), or use Flow / MCI.`) }
        finally { clearInterval(iv) }
        at += W.ri / tot
        cur = rDir
      }
      // 4) encode (other interpolation methods + final scale/sharpen happen here)
      const outFps = useRife ? (slow ? srcFps : srcFps * (countFiles(rDir) / n)) : srcFps
      const vf = []
      if (target && !useRife) {
        if (opts.method === 'dup') vf.push(`fps=${target}`)
        else if (opts.method === 'blend') vf.push(`minterpolate=fps=${target}:mi_mode=blend`)
        else vf.push(`minterpolate=fps=${target}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:${opts.sceneDetect === false ? 'scd=none' : 'scd=fdiff:scd_threshold=10'}`)
        if (slow) vf.push(`setpts=${factor.toFixed(6)}*PTS`)
      }
      vf.push(`scale=${w}:${h}:flags=lanczos`, ...post)
      const outDur = outFrames / outFps * (slow && !useRife ? factor : 1)
      await runTool(ffmpegPath(), ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
        '-framerate', outFps.toFixed(6), '-i', path.join(cur, '%08d.png'),
        ...(slow ? [] : ['-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', input]),
        '-map', '0:v:0', ...(slow ? ['-an'] : ['-map', '1:a:0?', '-c:a', 'aac', '-b:a', '192k', '-shortest']),
        '-vf', vf.join(','), ...(slow ? ['-r', String(srcFps)] : []),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', crf, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
        { onLine: ffProgress(outDur, at, W.enc / tot, 'encoding') })
      send(1, 'done')
      return finish()
    }
    // ---------------- ffmpeg-only path (MCI / blend / dup + classic filters) ----------------
    const vf = [...pre]
    if (target) {
      if (opts.method === 'dup') vf.push(`fps=${target}`)
      else if (opts.method === 'blend') vf.push(`minterpolate=fps=${target}:mi_mode=blend`)
      else vf.push(`minterpolate=fps=${target}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:${opts.sceneDetect === false ? 'scd=none' : 'scd=fdiff:scd_threshold=10'}`)
    }
    vf.push(`scale=${w}:${h}:flags=lanczos`, ...post)
    if (slow) vf.push(`setpts=${factor.toFixed(6)}*PTS`)
    const outDur = dur * (slow ? factor : 1)
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
      '-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', input,
      '-map', '0:v:0', ...(slow ? ['-an'] : ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k']),
      '-vf', vf.join(','), ...(slow ? ['-r', String(srcFps)] : []),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', crf, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]
    log('videolab', JSON.stringify(args.slice(4)))
    await runTool(ffmpegPath(), args, { onLine: ffProgress(outDur, 0, 1, opts.method === 'mci' ? 'motion-compensated' : 'ffmpeg') })
    return finish()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})


// ------------------------------------------------------------------ OpenFX plug-ins (see ofx.cjs)
const { createOfx } = require('./ofx.cjs')
function ofxDir() { return app.isPackaged ? path.join(process.resourcesPath, 'ofx') : path.join(__dirname, 'ofxhost', 'build') }
let ofxMgr = null
function ofx() {
  if (!ofxMgr) ofxMgr = createOfx({
    hostPath: path.join(ofxDir(), process.platform === 'win32' ? 'ofxhost.exe' : 'ofxhost'),
    configPath: path.join(app.getPath('userData'), 'ofx.json'),
    userPluginDir: path.join(app.getPath('userData'), 'OFX', 'Plugins'),
    extraDirs: process.env.AS_OFX_DIR ? [process.env.AS_OFX_DIR] : [],
    log,
  })
  return ofxMgr
}
ipcMain.handle('as:ofx-scan', async (_e, { force } = {}) => ofx().scan(!!force))
ipcMain.handle('as:ofx-add-dir', async () => {
  const r = await dialog.showOpenDialog({ title: 'Choose a folder with OpenFX plug-ins (.ofx.bundle)', properties: ['openDirectory'] })
  if (r.canceled || !r.filePaths[0]) return null
  return ofx().addDir(r.filePaths[0])
})
ipcMain.handle('as:ofx-open-dir', async () => {
  const d = ofx().userPluginDir
  fs.mkdirSync(d, { recursive: true })
  await shell.openPath(d)
  return d
})
ipcMain.handle('as:ofx-render', async (_e, req) => ofx().render(req))
app.on('will-quit', () => { if (ofxMgr) ofxMgr.quit() })

// AI requests to a custom Anthropic-compatible endpoint: done here (Chromium network stack,
// no CORS) because many gateways don't answer browser preflights. HTTPS only.
ipcMain.handle('as:http', async (_e, { url, method, headers, body }) => {
  const u = new URL(url)
  if (u.protocol !== 'https:') throw new Error('Only https:// endpoints are allowed')
  const res = await net.fetch(url, { method: method || 'GET', headers: headers || {}, body: body ?? undefined })
  const h = {}
  res.headers.forEach((v, k) => { h[k] = v })
  return { status: res.status, headers: h, body: await res.text() }
})
ipcMain.handle('as:gpu', async () => JSON.stringify(await app.getGPUInfo('basic')))

function createWindow() {
  log('start', app.getVersion(), process.execPath, 'appDir=' + APP_DIR, 'exists=' + fs.existsSync(path.join(APP_DIR, 'index.html')), safeGpu ? 'safe-gpu' : 'gpu')
  const win = new BrowserWindow({
    show: false,
    width: 1600, height: 960, minWidth: 1100, minHeight: 700,
    backgroundColor: '#1b1b1b',
    title: 'AnimeStudio',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })
  win.removeMenu() // free Ctrl+N / Ctrl+T / Ctrl+R… for the After Effects keymap
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' } })
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools()
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen())
  })
  let shown = false
  const reveal = () => { if (shown || win.isDestroyed()) return; shown = true; win.maximize(); win.show() }
  win.once('ready-to-show', reveal)
  setTimeout(reveal, 6000) // never leave an invisible window behind
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('did-fail-load', code, desc, url)
    if (code === -3) return // aborted (navigation replaced) — harmless
    reveal()
    dialog.showErrorBox('AnimeStudio', `No se pudo cargar el editor (${code} ${desc}).\n${url}\n\nLog: ${logFile || ''}`)
  })
  let renderCrashes = 0
  win.webContents.on('render-process-gone', (_e, d) => {
    log('render-process-gone', JSON.stringify(d))
    if (d.reason === 'clean-exit') return
    if (++renderCrashes <= 2) win.webContents.reload()
    else dialog.showErrorBox('AnimeStudio', `El editor se cerró (${d.reason}). Log: ${logFile || ''}`)
  })
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) log('renderer', message) })
  win.loadURL('app://animestudio/index.html').catch(e => log('loadURL', e))
  // CI / support smoke test: AS_SMOKE=<png path> loads the app, checks the desktop bridge, saves a screenshot, quits
  if (process.env.AS_SMOKE) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const info = await win.webContents.executeJavaScript(`(async () => {
        const has = !!window.animeStudioDesktop
        let conv = 'skipped'
        if (has && ${JSON.stringify(process.env.AS_SMOKE_MEDIA || '')}) {
          const r = await fetch(${JSON.stringify(process.env.AS_SMOKE_MEDIA ? 'app://animestudio/__smoke_media' : '')})
          const buf = await r.arrayBuffer()
          const out = await window.animeStudioDesktop.transcode('smoke.mkv', buf, 'proxy')
          conv = out.name + ' ' + out.data.byteLength
          const inf = await window.animeStudioDesktop.transcode('smoke.mkv', buf, 'influx')
          conv += ' | influx ' + inf.name + ' ' + inf.data.byteLength
          const lab = await window.animeStudioDesktop.videolab('smoke.mkv', buf, { start: 0, end: 0.5, srcFps: 30, targetFps: 60, method: 'mci', sceneDetect: true, width: 640, height: 360, enhance: { denoise: 0.3, deblock: 0.2, sharpen: 0.4, detail: 0.2 }, crf: 22 })
          conv += ' | videolab ' + lab.name + ' ' + lab.data.byteLength
        }
        const ai = has && window.animeStudioDesktop.aiTools ? await window.animeStudioDesktop.aiTools() : null
        let ofx = null
        if (has && window.animeStudioDesktop.ofxScan) {
          const sc = await window.animeStudioDesktop.ofxScan(true)
          const pl = sc.results.flatMap(r => r.plugins)
          ofx = { hostOk: sc.hostOk, plugins: pl.map(p => p.label), errors: sc.results.filter(r => r.err).map(r => r.err) }
          if (pl[0]) {
            const w = 32, hh = 16, px = new Uint8Array(w * hh * 4)
            for (let i = 0; i < px.length; i += 4) { px[i] = 200; px[i + 1] = 100; px[i + 2] = 50; px[i + 3] = 255 }
            try {
              const r = await window.animeStudioDesktop.ofxRender({ bundle: pl[0].bundle, index: pl[0].index, w, h: hh, time: 0, params: { invert: 1 }, data: px.buffer })
              const o = new Uint8Array(r.data)
              ofx.render = [o[0], o[1], o[2], o[3]].join(',')
            } catch (e) { ofx.render = 'ERR ' + e.message }
          }
        }
        return JSON.stringify({ has, conv, ai, ofx, title: document.title, gl: !!document.createElement('canvas').getContext('webgl2') })
      })()`)
      console.log('[smoke]', info)
      try { fs.writeFileSync(process.env.AS_SMOKE + '.json', info) } catch { }
      const img = await win.webContents.capturePage()
      fs.writeFileSync(process.env.AS_SMOKE, img.toPNG())
      app.quit()
    }, 6000))
  }
}

app.whenReady().then(async () => {
  protocol.handle('app', req => {
    try { return serveApp(req) } catch (e) { log('protocol', req.url, e); return new Response(String(e), { status: 500 }) }
  })
  // allow microphone/camera prompts used by some panels
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true))
  // the web build's offline service worker must never run in the desktop app:
  // after an update it served the OLD cached index/chunks → blank window.
  try { await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }) } catch (e) { log('clearStorage', e) }
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch(e => { log('whenReady', e); dialog.showErrorBox('AnimeStudio', String(e && e.stack || e)) })

function serveApp(req) {
  {
    const { pathname } = new URL(req.url)
    let rel = decodeURIComponent(pathname)
    if (rel === '/__smoke_media' && process.env.AS_SMOKE_MEDIA) return net.fetch(pathToFileURL(process.env.AS_SMOKE_MEDIA).toString())
    if (rel.endsWith('/')) rel += 'index.html'
    let file = path.normalize(path.join(APP_DIR, rel))
    const rootN = path.resolve(APP_DIR), fileN = path.resolve(file)
    const inside = process.platform === 'win32' ? fileN.toLowerCase().startsWith(rootN.toLowerCase()) : fileN.startsWith(rootN)
    if (!inside) return new Response('forbidden', { status: 403 })
    if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html'
    if (!fs.existsSync(file)) file = path.join(APP_DIR, 'index.html')
    return net.fetch(pathToFileURL(file).toString())
  }
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
