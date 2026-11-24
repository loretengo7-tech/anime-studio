/**
 * ANIME STUDIO — AI settings (device-local)
 *
 * The API key lives ONLY in this browser's localStorage. It is never sent
 * anywhere except directly to the provider endpoint you choose (Gemini,
 * Anthropic, or Z.ai through the user's OWN Cloudflare Worker proxy — Z.ai's
 * API does not answer browser CORS preflight, so a direct call is impossible;
 * the worker just forwards the request and stores nothing). The user sets a
 * daily request cap so a runaway session can never burn the provider quota
 * silently.
 */
export type AIProvider = 'gemini' | 'claude' | 'zai'

export interface AISettings {
  provider: AIProvider
  apiKey: string
  model: string
  /** Z.ai only: URL of the user's own CORS proxy worker, e.g. https://my-zai-proxy.user.workers.dev */
  proxyUrl: string
  /** Max assistant requests per calendar day (spend guard). */
  dailyRequestCap: number
  usageDate: string // YYYY-MM-DD (local)
  usageCount: number
}

const LS_KEY = 'anime-studio:ai'

export const DEFAULT_MODELS: Record<AIProvider, string> = {
  gemini: 'gemini-2.0-flash',
  claude: 'claude-sonnet-4-5',
  zai: 'glm-4.6',
}

export function defaultAISettings(): AISettings {
  return {
    provider: 'gemini',
    apiKey: '',
    model: DEFAULT_MODELS.gemini,
    proxyUrl: '',
    dailyRequestCap: 25,
    usageDate: todayStr(),
    usageCount: 0,
  }
}

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function loadAISettings(): AISettings {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return defaultAISettings()
    const parsed = JSON.parse(raw) as Partial<AISettings>
    const s = { ...defaultAISettings(), ...parsed }
    // daily rollover
    if (s.usageDate !== todayStr()) {
      s.usageDate = todayStr()
      s.usageCount = 0
    }
    if (s.provider === 'claude' && (!parsed.model || parsed.model === DEFAULT_MODELS.gemini)) s.model = DEFAULT_MODELS.claude
    if (s.provider === 'gemini' && (!parsed.model || parsed.model === DEFAULT_MODELS.claude || parsed.model === DEFAULT_MODELS.zai)) s.model = DEFAULT_MODELS.gemini
    if (s.provider === 'zai' && (!parsed.model || parsed.model === DEFAULT_MODELS.gemini || parsed.model === DEFAULT_MODELS.claude)) s.model = DEFAULT_MODELS.zai
    return s
  } catch {
    return defaultAISettings()
  }
}

export function saveAISettings(s: AISettings) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s))
  } catch { /* storage full — settings not persisted */ }
}

export function remainingRequests(): number {
  const s = loadAISettings()
  return Math.max(0, s.dailyRequestCap - s.usageCount)
}

export function recordAIRequest() {
  const s = loadAISettings()
  s.usageDate = todayStr()
  s.usageCount += 1
  saveAISettings(s)
}

export function resetAIUsage() {
  const s = loadAISettings()
  s.usageDate = todayStr()
  s.usageCount = 0
  saveAISettings(s)
}
