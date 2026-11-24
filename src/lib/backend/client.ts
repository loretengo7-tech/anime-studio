/**
 * Cliente del backend de herramientas (Etapa 2).
 *
 * - La URL del servidor y el token se guardan SOLO en este dispositivo
 *   (localStorage). El token nunca va dentro del bundle ni del repo.
 * - detectCapabilities() reporta la verdad del servidor: si una herramienta
 *   no está instalada ahí, la UI lo muestra — nada se simula.
 * - submitJob + waitForJob: cola con progreso real del backend
 *   (ffmpeg -progress, yt-dlp --newline, etc.).
 */

export interface BackendSettings {
  url: string
  token: string
}

const LS_KEY = 'anime-studio-backend'

export function loadBackendSettings(): BackendSettings {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const v = JSON.parse(raw) as BackendSettings
      return { url: (v.url || '').replace(/\/+$/, ''), token: v.token || '' }
    }
  } catch { /* private mode */ }
  return { url: '', token: '' }
}

export function saveBackendSettings(s: BackendSettings) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ url: s.url.replace(/\/+$/, ''), token: s.token }))
  } catch { /* private mode */ }
}

function headers(token: string, json = true): HeadersInit {
  const h: Record<string, string> = {}
  if (json) h['Content-Type'] = 'application/json'
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

export interface Capabilities {
  name?: string
  maxUploadMB?: number
  authRequired?: boolean
  ffmpeg?: { ok: boolean; version?: string }
  ffprobe?: { ok: boolean }
  ytdlp?: { ok: boolean; hint?: string }
  whisper?: { ok: boolean; engine?: string; hint?: string }
  earshot?: { ok: boolean; engine?: string; hint?: string }
  blender?: { ok: boolean; note?: string }
}

/** Prueba la conexión y devuelve las capacidades REALES del servidor. */
export async function detectCapabilities(s: BackendSettings): Promise<Capabilities> {
  if (!s.url) throw new Error('Configurá primero la URL del servidor')
  const res = await fetch(`${s.url}/api/capabilities`, { headers: headers(s.token, false) })
  if (!res.ok) {
    if (res.status === 401) throw new Error('Token incorrecto — revisalo en los ajustes del servidor')
    throw new Error(`El servidor respondió ${res.status}`)
  }
  return await res.json() as Capabilities
}

export interface JobState {
  id: string
  type: string
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  progress: number
  message: string
  files: { name: string; mime: string; size: number }[]
  result: unknown | null
  error: string | null
}

export async function submitJob(s: BackendSettings, body: Record<string, unknown>): Promise<string> {
  if (!s.url) throw new Error('Configurá primero la URL del servidor')
  const res = await fetch(`${s.url}/api/jobs`, {
    method: 'POST',
    headers: headers(s.token),
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  if (!res.ok) throw new Error(String(json.error || `El servidor rechazó el trabajo (${res.status})`))
  return String(json.id)
}

export async function getJob(s: BackendSettings, id: string): Promise<JobState> {
  const res = await fetch(`${s.url}/api/jobs/${encodeURIComponent(id)}`, { headers: headers(s.token, false) })
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  if (!res.ok) throw new Error(String(json.error || `HTTP ${res.status}`))
  return json as JobState
}

/**
 * Encuesta el trabajo hasta terminar. onProgress recibe (0..1, mensaje).
 * Un error de red puntual reintenta (el trabajo sigue vivo en el servidor).
 */
export async function waitForJob(
  s: BackendSettings,
  id: string,
  onProgress: (p: number, msg: string) => void,
  isCancelled?: () => boolean,
  pollMs = 1200
): Promise<JobState> {
  for (;;) {
    if (isCancelled?.()) {
      void cancelJob(s, id).catch(() => { /* el servidor expira solo */ })
      throw new Error('Cancelado por el usuario')
    }
    let st: JobState
    try {
      st = await getJob(s, id)
    } catch {
      await new Promise(r => setTimeout(r, pollMs))
      continue
    }
    onProgress(st.progress, st.message)
    if (st.state === 'done') return st
    if (st.state === 'error') throw new Error(st.error || 'El trabajo falló en el servidor')
    if (st.state === 'cancelled') throw new Error('El trabajo fue cancelado en el servidor')
    await new Promise(r => setTimeout(r, pollMs))
  }
}

export async function cancelJob(s: BackendSettings, id: string): Promise<void> {
  await fetch(`${s.url}/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers(s.token, false) }).catch(() => { })
}

/** Descarga un archivo resultante como File listo para importar al proyecto. */
export async function fetchResultFile(s: BackendSettings, id: string, index: number, fallbackName: string): Promise<File> {
  const res = await fetch(`${s.url}/api/jobs/${encodeURIComponent(id)}/files/${index}`, { headers: headers(s.token, false) })
  if (!res.ok) throw new Error(`No se pudo descargar el resultado (${res.status})`)
  const blob = await res.blob()
  const cd = res.headers.get('Content-Disposition') || ''
  const m = cd.match(/filename="([^"]+)"/)
  const name = m ? decodeURIComponent(m[1]) : fallbackName
  return new File([blob], name, { type: blob.type || 'application/octet-stream' })
}

/** Helper: arma el cuerpo de un trabajo con un archivo local en base64. */
export function jobWithFile(type: string, payload: Record<string, unknown>, file: File): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(new Error('No se pudo leer el archivo'))
    r.onload = () => {
      const dataB64 = String(r.result).split(',')[1] || ''
      resolve({
        type,
        label: file.name,
        ...payload,
        input: { name: file.name, mime: file.type || 'application/octet-stream', dataB64 },
      })
    }
    r.readAsDataURL(file)
  })
}
