/**
 * ANIME STUDIO — Local in-browser proxies (no server needed)
 *
 * Re-encodes a video asset to a lower resolution using MediaRecorder
 * (canvas.captureStream + WebAudio mix) entirely on the device. The proxy
 * is stored in IndexedDB and wired through mediaManager.setProxyUrl(), so
 * preview playback and scrubbing stay light on iPhone memory. The original
 * file is NEVER touched — export always reads the original source.
 *
 * Honest notes:
 *  - Generation runs at up to 2× realtime, so a 60s clip takes ~30-60s.
 *  - Uses the browser's recorder codec (Safari → MP4 H.264, Chrome → WebM).
 */
import type { AssetMeta } from '../engine/types'
import { mediaManager } from './mediaManager'

const DB_NAME = 'anime-studio-media'
const STORE = 'files'

function openDB(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
}

function proxyKey(assetId: string) {
  return `proxy_${assetId}`
}

/** Persist the proxy blob under a deterministic key. */
async function persistProxy(assetId: string, blob: Blob, mime: string): Promise<void> {
  const db = await openDB()
  if (!db) return
  await new Promise<void>(resolve => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({ id: proxyKey(assetId), blob, mime })
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
    tx.onabort = () => resolve()
  })
  db.close()
}

/** Restore persisted proxies for all assets (call on boot, after registerAsset). */
export async function restoreLocalProxies(assets: AssetMeta[]): Promise<void> {
  const db = await openDB()
  if (!db) return
  for (const a of assets) {
    if (a.kind !== 'video') continue
    const rec = await new Promise<{ id: string; blob: Blob; mime: string } | null>(resolve => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(proxyKey(a.id))
      req.onsuccess = () => resolve((req.result as { id: string; blob: Blob; mime: string }) ?? null)
      req.onerror = () => resolve(null)
    })
    if (rec?.blob) {
      mediaManager.setProxyUrl(a.id, URL.createObjectURL(rec.blob))
    }
  }
  db.close()
}

export interface ProxyProgress {
  progress: number
  message: string
}

function pickProxyMime(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ]
  for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c
  return ''
}

const PROXY_WIDTH = 480

/**
 * Generate a local proxy for a video asset. Progress is reported honestly.
 * Resolves with the proxy size; throws with a readable message on failure.
 */
export async function generateLocalProxy(
  asset: AssetMeta,
  onProgress: (p: ProxyProgress) => void
): Promise<{ sizeBytes: number; mimeType: string }> {
  if (asset.kind !== 'video') throw new Error('Proxies are only for video assets')
  const mime = pickProxyMime()
  if (!mime) throw new Error('MediaRecorder is not available in this browser')

  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ctx = new AC()
  try { await ctx.resume() } catch { /* locked context — proxy still generates silently */ }

  const el = document.createElement('video')
  el.src = asset.url
  el.muted = false
  el.playsInline = true
  el.preload = 'auto'
  el.crossOrigin = 'anonymous'
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('video load timeout')), 20000)
    el.onloadeddata = () => { clearTimeout(t); res() }
    el.onerror = () => { clearTimeout(t); rej(new Error('video decode error')) }
  })

  const scale = Math.min(1, PROXY_WIDTH / Math.max(1, el.videoWidth))
  const c = document.createElement('canvas')
  c.width = Math.max(2, Math.round(el.videoWidth * scale / 2) * 2)
  c.height = Math.max(2, Math.round(el.videoHeight * scale / 2) * 2)
  const g = c.getContext('2d')!

  const stream = c.captureStream(30)
  try {
    const source = ctx.createMediaElementSource(el)
    const dest = ctx.createMediaStreamDestination()
    source.connect(dest)
    if (ctx.state === 'running') source.connect(ctx.destination)
    for (const t of dest.stream.getAudioTracks()) stream.addTrack(t)
  } catch { /* audioless proxy is acceptable */ }

  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 1_200_000,
    audioBitsPerSecond: 96_000,
  })
  const chunks: BlobPart[] = []
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
  const done = new Promise<void>(res => { recorder.onstop = () => res() })

  // speed: 2× for anything longer than 8s (recorder realtime-bound, honest note in UI)
  const rate = asset.duration > 8 ? 2 : 1
  try { el.playbackRate = rate } catch { /* keep 1× */ }

  recorder.start(500)
  try { await el.play() } catch { throw new Error('Playback blocked — tap the button again') }

  await new Promise<void>(res => {
    const tick = () => {
      if (el.ended || el.currentTime >= Math.max(0.05, (el.duration || asset.duration) - 0.05)) { res(); return }
      g.drawImage(el, 0, 0, c.width, c.height)
      onProgress({
        progress: Math.min(0.99, el.currentTime / Math.max(0.1, el.duration || asset.duration)),
        message: `Proxy ${Math.round(el.currentTime)}s / ${Math.round(el.duration || asset.duration)}s (${rate}×)`,
      })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  await new Promise(r => setTimeout(r, 300))
  recorder.stop()
  await done
  el.pause()
  el.removeAttribute('src')
  el.load()
  void ctx.close()

  const blob = new Blob(chunks, { type: mime.split(';')[0] })
  if (blob.size < 1000) throw new Error('Proxy came out empty — try again')
  await persistProxy(asset.id, blob, mime)
  mediaManager.setProxyUrl(asset.id, URL.createObjectURL(blob))
  onProgress({ progress: 1, message: 'Proxy ready' })
  return { sizeBytes: blob.size, mimeType: mime.split(';')[0] }
}

export async function deleteLocalProxy(assetId: string): Promise<void> {
  const db = await openDB()
  if (!db) return
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).delete(proxyKey(assetId))
  db.close()
  mediaManager.setProxyUrl(assetId, null)
}
