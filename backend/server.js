#!/usr/bin/env node
/**
 * ANIME STUDIO — Backend de herramientas (Etapa 2 del plan de integración)
 *
 * Servidor Node SIN dependencias externas (solo módulos nativos) para que se
 * pueda desplegar gratis en Render / Railway / Fly.io / una PC, con o sin Docker.
 *
 * Qué hace de verdad:
 *   - API con token opcional (BACKEND_TOKEN), CORS configurable y límites de tamaño.
 *   - Cola de trabajos (job queue) con concurrencia, progreso real y resultados en disco.
 *   - Herramientas por binario del servidor, con DETECCIÓN DE CAPACIDADES honesta:
 *       ffmpeg/ffprobe  → convertir, comprimir, extraer audio, loudness (Audio Lab), probe
 *       yt-dlp          → importar referencias desde URLs permitidas (opcional)
 *       faster-whisper  → transcripción y subtítulos SRT/VTT (opcional, Python)
 *       earshot (VAD)   → segmentos de voz (opcional, Python)
 *       blender         → reservado para la Etapa 6 (solo se reporta si existe)
 *   Si un binario no está instalado, el trabajo falla con un mensaje claro —
 *   nunca se simula un resultado.
 *
 * Endpoints:
 *   GET  /api/health                → { ok: true, uptime }
 *   GET  /api/capabilities          → qué herramientas hay realmente instaladas
 *   POST /api/jobs                  → crear trabajo (JSON con input base64 o URL)
 *   GET  /api/jobs                  → lista breve de trabajos
 *   GET  /api/jobs/:id              → estado + progreso + archivos resultantes
 *   GET  /api/jobs/:id/files/:i     → descargar el archivo resultante i
 *   DELETE /api/jobs/:id            → cancelar / limpiar
 *
 * Variables de entorno:
 *   PORT (default 8787)        BACKEND_TOKEN (si se define, exige Authorization: Bearer)
 *   ALLOWED_ORIGIN (default *) MAX_UPLOAD_MB (default 200)
 *   CONCURRENCY (default 2)    JOB_TTL_MIN (default 120)
 *   OUTPUT_DIR (default: tempdir/anime-studio-jobs)
 */

'use strict'

const http = require('node:http')
const os = require('node:os')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 8787)
const TOKEN = process.env.BACKEND_TOKEN || ''
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 200)
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 2))
const JOB_TTL_MIN = Number(process.env.JOB_TTL_MIN || 120)
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(os.tmpdir(), 'anime-studio-jobs')

const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024

// ---------------------------------------------------------------------------
// Estado: cola de trabajos
// ---------------------------------------------------------------------------

/** @type {Map<string, any>} */
const jobs = new Map()
const queue = []
let running = 0

function newJob(type, label) {
  const id = crypto.randomBytes(10).toString('hex')
  const job = {
    id,
    type,
    label: label || type,
    state: 'queued', // queued | running | done | error | cancelled
    progress: 0,
    message: 'En cola',
    createdAt: Date.now(),
    files: [], // { name, path, mime, size }
    result: null, // JSON opcional (ej. segmentos de subtítulos)
    error: null,
    cancelRequested: false,
    /** @type {(() => void) | null} */
    onCancel: null,
    payload: null,
    _inputs: [],
  }
  jobs.set(id, job)
  return job
}

function enqueue(job) {
  queue.push(job)
  drain()
}

function drain() {
  while (running < CONCURRENCY && queue.length > 0) {
    const job = queue.shift()
    if (!job || job.state === 'cancelled') continue
    running++
    setJobState(job, 'running', 'Procesando…')
    runJob(job)
      .then(() => {
        if (job.state !== 'cancelled') {
          job.progress = 1
          setJobState(job, 'done', 'Listo')
        }
      })
      .catch(err => {
        if (job.state !== 'cancelled') {
          job.error = String(err && err.message ? err.message : err)
          setJobState(job, 'error', job.error)
        }
      })
      .finally(() => {
        running--
        drain()
      })
  }
}

function setJobState(job, state, message) {
  job.state = state
  if (message != null) job.message = message
}

function setProgress(job, p, message) {
  job.progress = Math.max(0, Math.min(1, p))
  if (message) job.message = message
}

function checkCancelled(job) {
  if (job.cancelRequested) {
    throw Object.assign(new Error('Cancelado por el usuario'), { cancelled: true })
  }
}

// Limpieza periódica: borra trabajos viejos y sus archivos
setInterval(() => {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MIN * 60 * 1000) {
      for (const f of job.files) void fsp.rm(f.path, { force: true }).catch(() => {})
      for (const p of job._inputs) void fsp.rm(p, { force: true }).catch(() => {})
      jobs.delete(id)
    }
  }
}, 10 * 60 * 1000).unref()

// ---------------------------------------------------------------------------
// Capacidades reales del servidor (nada inventado: se ejecuta el binario)
// ---------------------------------------------------------------------------

async function binVersion(bin, args = ['-version']) {
  return new Promise(resolve => {
    let done = false
    const finish = v => { if (!done) { done = true; resolve(v) } }
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    p.stdout.on('data', d => { out += d })
    p.on('error', () => finish(null))
    p.on('close', code => finish(code === 0 ? out.split('\n')[0].trim() : null))
    setTimeout(() => { try { p.kill('SIGKILL') } catch { } finish(null) }, 8000).unref()
  })
}

async function pyHasModule(mod) {
  return new Promise(resolve => {
    let done = false
    const finish = v => { if (!done) { done = true; resolve(v) } }
    const p = spawn('python3', ['-c', `import ${mod}`], { stdio: 'ignore' })
    p.on('error', () => finish(false))
    p.on('close', code => finish(code === 0))
    setTimeout(() => { try { p.kill('SIGKILL') } catch { } finish(false) }, 15000).unref()
  })
}

let capsCache = null
async function capabilities() {
  if (capsCache && Date.now() - capsCache.at < 60_000) return capsCache.v
  const [ffmpeg, ffprobe, ytdlp, blender] = await Promise.all([
    binVersion('ffmpeg'), binVersion('ffprobe'), binVersion('yt-dlp', ['--version']), binVersion('blender', ['--version']),
  ])
  const [pyWhisper, pyEarshot] = await Promise.all([pyHasModule('faster_whisper'), pyHasModule('earshot')])
  const v = {
    name: 'anime-studio-backend',
    maxUploadMB: MAX_UPLOAD_MB,
    authRequired: !!TOKEN,
    ffmpeg: ffmpeg ? { ok: true, version: ffmpeg } : { ok: false },
    ffprobe: ffprobe ? { ok: true } : { ok: false },
    ytdlp: ytdlp ? { ok: true, version: ytdlp } : { ok: false, hint: 'pip install yt-dlp' },
    whisper: pyWhisper ? { ok: true, engine: 'faster-whisper' } : { ok: false, hint: 'pip install faster-whisper' },
    earshot: pyEarshot ? { ok: true, engine: 'earshot VAD (pykeio)' } : { ok: false, hint: 'pip install earshot' },
    blender: blender ? { ok: true } : { ok: false, note: 'Etapa 6 — render 3D' },
  }
  capsCache = { at: Date.now(), v }
  return v
}

// ---------------------------------------------------------------------------
// Utilidades de procesos
// ---------------------------------------------------------------------------

function run(bin, args, { onLine, onProgress, job, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let rejected = false

    if (job) {
      job.onCancel = () => {
        rejected = true
        try { child.kill('SIGKILL') } catch { }
        job.onCancel = null
        reject(Object.assign(new Error('Cancelado por el usuario'), { cancelled: true }))
      }
    }

    const timer = setTimeout(() => {
      if (!rejected) {
        rejected = true
        try { child.kill('SIGKILL') } catch { }
        reject(new Error(`${bin} excedió el tiempo límite`))
      }
    }, timeoutMs)
    timer.unref?.()

    child.stdout.on('data', d => {
      const s = d.toString()
      stdout += s
      if (onProgress) onProgress(s)
    })
    child.stderr.on('data', d => {
      const s = d.toString()
      stderr += s
      if (onLine) for (const line of s.split('\n')) { if (line) onLine(line) }
    })
    child.on('error', err => {
      if (!rejected) { rejected = true; clearTimeout(timer); reject(err) }
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (job) job.onCancel = null
      if (rejected) return
      if (code === 0) resolve({ stdout, stderr })
      else {
        const tail = stderr.split('\n').filter(Boolean).slice(-4).join(' | ')
        reject(new Error(`${bin} salió con código ${code}: ${tail || 'sin detalle'}`))
      }
    })
  })
}

async function probeDuration(file) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', file])
    const j = JSON.parse(stdout)
    return Number(j.format && j.format.duration) || 0
  } catch { return 0 }
}

async function addResult(job, filePath, mime, name) {
  const st = await fsp.stat(filePath)
  job.files.push({ name: name || path.basename(filePath), path: filePath, mime, size: st.size })
}

/** Nombre de archivo seguro (sin traversal ni caracteres raros) */
function safeName(name) {
  const base = path.basename(String(name || 'media')).replace(/[^\w.\- ]+/g, '_').slice(0, 120)
  return base || 'media'
}

async function writeInput(job, input) {
  if (!input || typeof input.dataB64 !== 'string' || input.dataB64.length === 0) {
    throw new Error('Falta el archivo de entrada (input.dataB64)')
  }
  const buf = Buffer.from(input.dataB64, 'base64')
  if (buf.length === 0) throw new Error('Archivo de entrada vacío')
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new Error(`El archivo supera el límite de ${MAX_UPLOAD_MB} MB de este servidor`)
  }
  const inPath = path.join(OUTPUT_DIR, `${job.id}-in-${safeName(input.name || 'input.bin')}`)
  await fsp.writeFile(inPath, buf)
  job._inputs.push(inPath)
  return inPath
}

// ---------------------------------------------------------------------------
// Herramientas FFmpeg (con progreso real por -progress pipe:1)
// ---------------------------------------------------------------------------

function ffmpegProgressParser(job, totalDur) {
  let lastEmit = 0
  return chunk => {
    if (!totalDur || totalDur <= 0) return
    for (const line of chunk.split('\n')) {
      const m = line.match(/out_time_us=(\d+)/) || line.match(/out_time_ms=(\d+)/)
      if (m) {
        const p = Number(m[1]) / 1e6 / totalDur
        const now = Date.now()
        if (now - lastEmit > 300 || p >= 1) {
          lastEmit = now
          setProgress(job, Math.min(0.99, p), `Procesando ${(p * 100).toFixed(0)}%`)
        }
      }
    }
  }
}

function crfFromQuality(q) {
  // calidad: high = mejor imagen, low = archivo más chico
  return q === 'high' ? '18' : q === 'low' ? '28' : '23'
}

function outSpec(kind, p) {
  if (kind === 'extractAudio') {
    return p.audioFormat === 'mp3'
      ? { ext: 'mp3', mime: 'audio/mpeg', audioArgs: ['-vn', '-c:a', 'libmp3lame', '-b:a', String(p.audioBitrate || '192k')] }
      : { ext: 'wav', mime: 'audio/wav', audioArgs: ['-vn', '-c:a', 'pcm_s16le'] }
  }
  if (p.format === 'webm') {
    return { ext: 'webm', mime: 'video/webm', audioArgs: ['-c:v', 'libvpx-vp9', '-crf', crfFromQuality(p.quality), '-b:v', '0', '-c:a', 'libopus', '-b:a', '128k'] }
  }
  const ext = p.format === 'mov' ? 'mov' : 'mp4'
  return { ext, mime: 'video/mp4', audioArgs: ['-c:v', 'libx264', '-preset', p.quality === 'fast' ? 'veryfast' : 'medium', '-crf', crfFromQuality(p.quality), '-c:a', 'aac', '-b:a', '192k', '-pix_fmt', 'yuv420p'] }
}

async function jobFfmpeg(job, p) {
  checkCancelled(job)
  const input = await writeInput(job, p.input)
  const kind = p.ffmpegKind

  if (kind === 'probe') {
    const { stdout } = await run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', input])
    job.result = JSON.parse(stdout)
    setProgress(job, 1, 'Analizado')
    return
  }

  if (kind === 'loudness') {
    // Audio Lab: loudness real (EBU R128) con loudnorm print_format=json
    setProgress(job, 0.1, 'Midiendo loudness (EBU R128)…')
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', input, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { job })
    const m = stderr.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('ffmpeg no devolvió el reporte de loudnorm')
    const r = JSON.parse(m[0])
    job.result = {
      inputI: r.input_i, inputTp: r.input_tp, inputLra: r.input_lra, inputTh: r.input_th,
      targetI: r.target_i, targetTp: r.target_tp,
      reading: `Loudness integrado: ${r.input_i} LUFS · pico real: ${r.input_tp} dBTP · rango: ${r.input_lra} LU`,
      clippingHint: Number(r.input_tp) > -1.0 ? 'El pico supera -1 dBTP: probablemente hay clipping.' : 'Pico dentro de rango seguro (-1 dBTP).',
    }
    setProgress(job, 1, 'Medición lista')
    return
  }

  const dur = await probeDuration(input)
  const spec = outSpec(kind, p)
  const out = path.join(OUTPUT_DIR, `${job.id}-out.${spec.ext}`)
  const args = ['-hide_banner', '-y', '-i', input, ...spec.audioArgs, '-progress', 'pipe:1', '-nostats']
  const scale = Number(p.scale || 0)
  const fps = Number(p.fps || 0)
  if (kind !== 'extractAudio') {
    if (scale > 0) args.push('-vf', `scale='min(${scale},iw)':-2`)
    if (fps > 0) args.push('-r', String(fps))
  }
  args.push(out)

  await run('ffmpeg', args, { job, onProgress: ffmpegProgressParser(job, dur) })
  checkCancelled(job)
  await addResult(job, out, spec.mime, `resultado.${spec.ext}`)
  setProgress(job, 0.99, 'Cerrando archivo…')
}

// ---------------------------------------------------------------------------
// Whisper (faster-whisper) — transcripción real a SRT/VTT + segmentos
// ---------------------------------------------------------------------------

function fmtTs(sec, sep = ',') {
  const ms = Math.floor((sec % 1) * 1000)
  const s = Math.floor(sec) % 60
  const m = Math.floor(sec / 60) % 60
  const h = Math.floor(sec / 3600)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`
}

function toSrt(segments) {
  return segments.map((sg, i) => `${i + 1}\n${fmtTs(sg.start)} --> ${fmtTs(sg.end)}\n${(sg.text || '').trim()}\n`).join('\n')
}
function toVtt(segments) {
  return `WEBVTT\n\n${segments.map(sg => `${fmtTs(sg.start, '.')} --> ${fmtTs(sg.end, '.')}\n${(sg.text || '').trim()}\n`).join('\n')}`
}

async function jobWhisper(job, p) {
  checkCancelled(job)
  const model = ['tiny', 'base', 'small', 'medium', 'large-v3'].includes(p.model) ? p.model : 'base'
  const input = await writeInput(job, p.input)
  const scriptPath = path.join(OUTPUT_DIR, `${job.id}-whisper.py`)
  await fsp.writeFile(scriptPath, `
import json, sys
from faster_whisper import WhisperModel
path, model_name = sys.argv[1], sys.argv[2]
m = WhisperModel(model_name, device="cpu", compute_type="int8")
segments, info = m.transcribe(path, vad_filter=True)
out = []
for sg in segments:
    out.append({"start": round(sg.start, 3), "end": round(sg.end, 3), "text": sg.text})
print(json.dumps({"language": info.language, "duration": info.duration, "segments": out}, ensure_ascii=False))
`)
  job._inputs.push(scriptPath)
  setProgress(job, 0.15, `Transcribiendo con faster-whisper (${model})… puede tardar`)
  let stdout
  try {
    const r = await run('python3', [scriptPath, input, model], {
      job,
      onLine: line => { if (line) setProgress(job, job.progress, `Whisper: ${line.slice(0, 70)}`) },
      timeoutMs: 60 * 60 * 1000,
    })
    stdout = r.stdout
  } catch (err) {
    const blob = `${err.message || ''} ${err.stderr || ''}`
    if (blob.includes('No module named')) {
      throw new Error('El servidor no tiene faster-whisper instalado (pip install faster-whisper). Nada se simuló.')
    }
    throw err
  }
  const parsed = JSON.parse(stdout)
  job.result = parsed
  if (!parsed.segments || parsed.segments.length === 0) {
    setProgress(job, 1, 'Sin segmentos de voz detectados')
    return
  }
  const srtPath = path.join(OUTPUT_DIR, `${job.id}-subs.srt`)
  const vttPath = path.join(OUTPUT_DIR, `${job.id}-subs.vtt`)
  await fsp.writeFile(srtPath, toSrt(parsed.segments), 'utf8')
  await fsp.writeFile(vttPath, toVtt(parsed.segments), 'utf8')
  await addResult(job, srtPath, 'application/x-subrip', 'subtitulos.srt')
  await addResult(job, vttPath, 'text/vtt', 'subtitulos.vtt')
}

// ---------------------------------------------------------------------------
// Earshot (VAD pykeio) — segmentos de voz reales
// ---------------------------------------------------------------------------

async function jobEarshot(job, p) {
  checkCancelled(job)
  const input = await writeInput(job, p.input)
  setProgress(job, 0.1, 'Normalizando audio a PCM 16 kHz…')
  const wavPath = path.join(OUTPUT_DIR, `${job.id}-in16k.wav`)
  await run('ffmpeg', ['-hide_banner', '-y', '-i', input, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath], { job })
  const scriptPath = path.join(OUTPUT_DIR, `${job.id}-vad.py`)
  await fsp.writeFile(scriptPath, `
import json, sys, wave, math
import numpy as np
import earshot
w = wave.open(sys.argv[1], 'rb')
sr, ch = w.getframerate(), w.getnchannels()
data = w.readframes(w.getnframes())
w.close()
if ch == 2:
    data = data[1::2]  # canal izquierdo del intercalado int16
audio = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
hop = 16000
if sr != hop:
    idx = np.linspace(0, len(audio) - 1, math.ceil(len(audio) * hop / sr)).astype(np.int64)
    audio = audio[idx]
det = earshot.Detector()
frame = 256  # 16 ms @ 16 kHz
segs = []
in_voice = False
start = 0.0
for i in range(0, len(audio) - frame, frame):
    isv = det.predict(audio[i:i + frame]).is_voice()
    t = i / hop
    if isv and not in_voice:
        in_voice, start = True, t
    elif not isv and in_voice:
        in_voice = False
        if t - start > 0.3:
            segs.append({"start": round(start, 2), "end": round(t, 2)})
if in_voice:
    segs.append({"start": round(start, 2), "end": round(len(audio) / hop, 2)})
print(json.dumps({"segments": segs, "sampleRate": hop}, ensure_ascii=False))
`)
  job._inputs.push(scriptPath)
  setProgress(job, 0.3, 'Detectando voz con Earshot…')
  try {
    const { stdout } = await run('python3', [scriptPath, wavPath], { job, timeoutMs: 20 * 60 * 1000 })
    job.result = JSON.parse(stdout)
    setProgress(job, 1, 'Segmentos de voz listos')
  } catch (err) {
    if (`${err.message || ''}${err.stderr || ''}`.includes('No module named')) {
      throw new Error('El servidor no tiene earshot instalado (pip install earshot). Nada se simuló.')
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// yt-dlp — SOLO contenido para el que el usuario tiene autorización
// ---------------------------------------------------------------------------

async function jobYtdlp(job, p) {
  checkCancelled(job)
  const url = String(p.url || '')
  if (!/^https?:\/\//i.test(url)) throw new Error('URL inválida')
  const mode = p.mode === 'info' ? 'info' : 'download'

  if (mode === 'info') {
    setProgress(job, 0.2, 'Consultando información…')
    try {
      const { stdout } = await run('yt-dlp', ['--no-warnings', '--dump-json', '--no-playlist', url], { job, timeoutMs: 120_000 })
      const info = JSON.parse(stdout)
      job.result = {
        title: info.title, duration: info.duration, uploader: info.uploader,
        webpage_url: info.webpage_url, isLive: !!info.is_live,
        notice: 'Importá solo contenido propio o autorizado. Si la plataforma no permite descarga, el intento falla de forma explícita.',
      }
      setProgress(job, 1, 'Info lista')
      return
    } catch (err) {
      throw new Error(`yt-dlp no pudo leer la URL: ${String(err.message).slice(0, 200)}`)
    }
  }

  const h = [240, 360, 480, 720, 1080].includes(Number(p.maxHeight)) ? Number(p.maxHeight) : 720
  setProgress(job, 0.1, `Descargando (≤${h}p)…`)
  const out = path.join(OUTPUT_DIR, `${job.id}-dl.%(ext)s`)
  await run('yt-dlp', [
    '--no-warnings', '--no-playlist', '-f', `bv*[height<=${h}][ext=mp4]+ba/b[height<=${h}]`,
    '--merge-output-format', 'mp4', '--newline', '-o', out, url,
  ], {
    job,
    onLine: line => {
      const m = line.match(/(\d{1,3})\.(\d)%/)
      if (m) setProgress(job, Number(m[1]) / 100 + Number(m[2]) / 1000, `Descargando ${m[1]}.${m[2]}%`)
    },
    timeoutMs: 45 * 60 * 1000,
  })
  const base = `${job.id}-dl`
  const files = await fsp.readdir(OUTPUT_DIR)
  const produced = files.filter(f => f.startsWith(base) && !f.endsWith('.part'))
  if (produced.length === 0) throw new Error('La descarga no produjo archivos (la plataforma puede no permitir descargas).')
  for (const f of produced) {
    await addResult(job, path.join(OUTPUT_DIR, f), f.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4', f.slice(base.length + 1))
  }
}

// ---------------------------------------------------------------------------
// Dispatcher de trabajos
// ---------------------------------------------------------------------------

async function runJob(job) {
  const p = job.payload || {}
  switch (job.type) {
    case 'media.convert':
      return jobFfmpeg(job, { ...p, ffmpegKind: 'convert' })
    case 'media.compress':
      return jobFfmpeg(job, { ...p, ffmpegKind: 'compress' })
    case 'media.extractAudio':
      return jobFfmpeg(job, { ...p, ffmpegKind: 'extractAudio' })
    case 'media.probe':
      return jobFfmpeg(job, { ...p, ffmpegKind: 'probe' })
    case 'media.loudness':
      return jobFfmpeg(job, { ...p, ffmpegKind: 'loudness' })
    case 'media.transcribe':
      return jobWhisper(job, p)
    case 'media.vad':
      return jobEarshot(job, p)
    case 'media.importUrl':
      return jobYtdlp(job, p)
    default:
      throw new Error(`Tipo de trabajo desconocido: ${job.type}`)
  }
}

// ---------------------------------------------------------------------------
// HTTP (sin dependencias)
// ---------------------------------------------------------------------------

function setCORS(req, res) {
  const origin = req.headers.origin || ''
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN === '*' ? '*' : (origin && ALLOWED_ORIGIN.split(',').includes(origin) ? origin : ''))
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')
}

function authorized(req) {
  if (!TOKEN) return true
  const h = req.headers.authorization || ''
  return h === `Bearer ${TOKEN}`
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readBody(req, capBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > capBytes) {
        reject(new Error(`Cuerpo demasiado grande (límite ~${Math.round(capBytes / 1024 / 1024)} MB)`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function publicJob(job) {
  return {
    id: job.id, type: job.type, label: job.label, state: job.state,
    progress: job.progress, message: job.message, createdAt: job.createdAt,
    files: job.files.map(f => ({ name: f.name, mime: f.mime, size: f.size })),
    result: job.result, error: job.error,
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  setCORS(req, res)
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  try {
    // health — sin auth (para probar que el servidor responde)
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return sendJSON(res, 200, { ok: true, name: 'anime-studio-backend', uptime: Math.round(process.uptime()) })
    }

    if (url.pathname === '/api/capabilities' && req.method === 'GET') {
      const caps = await capabilities()
      return sendJSON(res, 200, caps)
    }

    // todo lo demás exige token si está configurado
    if (!authorized(req)) {
      return sendJSON(res, 401, { error: 'Token incorrecto o ausente (Authorization: Bearer <BACKEND_TOKEN>)' })
    }

    await fsp.mkdir(OUTPUT_DIR, { recursive: true })

    if (url.pathname === '/api/jobs' && req.method === 'POST') {
      const raw = await readBody(req, MAX_UPLOAD_BYTES * 1.4) // base64 infla ~33%
      let body
      try { body = JSON.parse(raw.toString('utf8') || '{}') } catch { throw new Error('JSON inválido') }
      if (!body.type) throw new Error('Falta "type"')
      const job = newJob(body.type, body.label || body.type)
      job.payload = body
      enqueue(job)
      return sendJSON(res, 200, { id: job.id, state: job.state })
    }

    if (url.pathname === '/api/jobs' && req.method === 'GET') {
      return sendJSON(res, 200, { jobs: [...jobs.values()].slice(-50).map(publicJob) })
    }

    const mJob = url.pathname.match(/^\/api\/jobs\/([a-f0-9]+)$/)
    if (mJob && req.method === 'GET') {
      const job = jobs.get(mJob[1])
      if (!job) return sendJSON(res, 404, { error: 'Trabajo no encontrado (o venció su TTL)' })
      return sendJSON(res, 200, publicJob(job))
    }

    const mFile = url.pathname.match(/^\/api\/jobs\/([a-f0-9]+)\/files\/(\d+)$/)
    if (mFile && req.method === 'GET') {
      const job = jobs.get(mFile[1])
      const f = job && job.files[Number(mFile[2])]
      if (!f) return sendJSON(res, 404, { error: 'Archivo no encontrado' })
      res.writeHead(200, {
        'Content-Type': f.mime || 'application/octet-stream',
        'Content-Length': f.size,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(f.name)}"`,
      })
      fs.createReadStream(f.path).pipe(res)
      return
    }

    if (mJob && req.method === 'DELETE') {
      const job = jobs.get(mJob[1])
      if (!job) return sendJSON(res, 404, { error: 'Trabajo no encontrado' })
      if (job.state === 'queued') {
        const i = queue.indexOf(job)
        if (i >= 0) queue.splice(i, 1)
        setJobState(job, 'cancelled', 'Cancelado')
      } else if (job.state === 'running' && job.onCancel) {
        job.cancelRequested = true
        job.onCancel()
        setJobState(job, 'cancelled', 'Cancelado')
      } else {
        for (const file of job.files) await fsp.rm(file.path, { force: true }).catch(() => {})
      }
      return sendJSON(res, 200, { ok: true, state: job.state })
    }

    return sendJSON(res, 404, { error: 'Ruta desconocida' })
  } catch (err) {
    const msg = String(err && err.message ? err.message : err)
    return sendJSON(res, /demasiado grande/i.test(msg) ? 413 : 400, { error: msg })
  }
})

server.listen(PORT, () => {
  console.log(`ANIME STUDIO backend en http://0.0.0.0:${PORT}`)
  console.log(`  auth: ${TOKEN ? 'Bearer token activado' : 'SIN token (definí BACKEND_TOKEN en producción)'}`)
  console.log(`  límite de subida: ${MAX_UPLOAD_MB} MB · concurrencia: ${CONCURRENCY} · TTL: ${JOB_TTL_MIN} min`)
})
