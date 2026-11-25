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
const { app, BrowserWindow, protocol, net, ipcMain, shell, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')

// ---------- performance switches ----------
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('force_high_performance_gpu')
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,CanvasOopRasterization,VaapiVideoDecoder')
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192')

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

ipcMain.handle('as:gpu', async () => JSON.stringify(await app.getGPUInfo('basic')))

function createWindow() {
  const win = new BrowserWindow({
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
  void win.loadURL('app://animestudio/index.html')
  win.maximize()
  // CI / support smoke test: AS_SMOKE=<png path> loads the app, checks the desktop bridge, saves a screenshot, quits
  if (process.env.AS_SMOKE) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const info = await win.webContents.executeJavaScript(`(async () => {
        const has = !!window.animeStudioDesktop
        let conv = 'skipped'
        if (has && ${JSON.stringify(process.env.AS_SMOKE_MEDIA || '')}) {
          const r = await fetch(${JSON.stringify(process.env.AS_SMOKE_MEDIA ? 'app://animestudio/__smoke_media' : '')})
          const out = await window.animeStudioDesktop.transcode('smoke.mkv', await r.arrayBuffer(), 'proxy')
          conv = out.name + ' ' + out.data.byteLength
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

app.whenReady().then(() => {
  protocol.handle('app', req => {
    const { pathname } = new URL(req.url)
    let rel = decodeURIComponent(pathname)
    if (rel === '/__smoke_media' && process.env.AS_SMOKE_MEDIA) return net.fetch(pathToFileURL(process.env.AS_SMOKE_MEDIA).toString())
    if (rel.endsWith('/')) rel += 'index.html'
    let file = path.normalize(path.join(APP_DIR, rel))
    if (!file.startsWith(APP_DIR)) return new Response('forbidden', { status: 403 })
    if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html'
    if (!fs.existsSync(file)) file = path.join(APP_DIR, 'index.html')
    return net.fetch(pathToFileURL(file).toString())
  })
  // allow microphone/camera prompts used by some panels
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true))
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
