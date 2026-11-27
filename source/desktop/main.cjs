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
ipcMain.handle('as:videolab', async (e, { name, data, opts }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animestudio-lab-'))
  const safe = String(name || 'media').replace(/[^\w.-]+/g, '_')
  const input = path.join(dir, safe)
  const out = path.join(dir, 'lab-out.mp4')
  fs.writeFileSync(input, Buffer.from(data))
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  const start = Math.max(0, num(opts.start, 0))
  const dur = Math.max(0.05, num(opts.end, start + 1) - start)
  const srcFps = Math.max(1, num(opts.srcFps, 30))
  const target = opts.targetFps ? Math.min(480, Math.max(1, num(opts.targetFps, srcFps))) : null
  const factor = target ? target / srcFps : 1
  const w = Math.max(16, Math.round(num(opts.width, 1920) / 2) * 2), h = Math.max(16, Math.round(num(opts.height, 1080) / 2) * 2)
  const en = opts.enhance || null
  const vf = []
  if (en) {
    const d = num(en.denoise, 0), db = num(en.deblock, 0)
    if (d + db > 0.02) vf.push(`hqdn3d=${(1 + 6 * d + 3 * db).toFixed(2)}:${(1 + 4 * d).toFixed(2)}:${(2 + 6 * d).toFixed(2)}:${(2 + 4 * d).toFixed(2)}`)
  }
  if (target) {
    if (opts.method === 'dup') vf.push(`fps=${target}`)
    else if (opts.method === 'blend') vf.push(`minterpolate=fps=${target}:mi_mode=blend`)
    else vf.push(`minterpolate=fps=${target}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:${opts.sceneDetect === false ? 'scd=none' : 'scd=fdiff:scd_threshold=10'}`)
  }
  vf.push(`scale=${w}:${h}:flags=lanczos`)
  if (en) {
    const sh = Math.min(2, num(en.sharpen, 0) * 1.4 + num(en.detail, 0) * 0.6)
    if (sh > 0.02) vf.push(`unsharp=5:5:${sh.toFixed(2)}:5:5:0`)
  }
  const slow = !!(opts.slowmo && target)
  if (slow) vf.push(`setpts=${factor.toFixed(6)}*PTS`)
  const outDur = dur * (slow ? factor : 1)
  const crf = String(Math.min(30, Math.max(10, Math.round(num(opts.crf, 16)))))
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    '-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', input,
    '-map', '0:v:0', ...(slow ? ['-an'] : ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k']),
    '-vf', vf.join(','), ...(slow ? ['-r', String(srcFps)] : []),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', crf, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]
  log('videolab', JSON.stringify(args.slice(4)))
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath(), args, { windowsHide: true })
      let err = '', buf = '', last = {}
      p.stdout.on('data', d => {
        buf += d.toString()
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
          const [k, v] = line.split('=')
          if (k === 'out_time_us' || k === 'out_time_ms') last.t = Number(v) / 1e6
          else if (k === 'fps') last.fps = Number(v)
          else if (k === 'speed') last.speed = v
          else if (k === 'progress') {
            try { e.sender.send('as:videolab-progress', { progress: Math.min(1, (last.t || 0) / outDur), fps: last.fps, speed: last.speed }) } catch { }
          }
        }
      })
      p.stderr.on('data', d => { err = (err + d.toString()).slice(-4000) })
      p.on('error', reject)
      p.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err.split('\n').slice(-4).join(' ')}`))))
    })
    const buf = fs.readFileSync(out)
    const base = safe.replace(/\.[^.]+$/, '')
    const tag = [en ? `${h}p` : '', target ? (slow ? `${Math.round(factor)}x-slowmo` : `${target}fps`) : ''].filter(Boolean).join('-') || 'lab'
    return { name: `${base} [${tag}].mp4`, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
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
        return JSON.stringify({ has, conv, title: document.title, gl: !!document.createElement('canvas').getContext('webgl2') })
      })()`)
      console.log('[smoke]', info)
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
