/**
 * ANIME STUDIO — AI settings (device-local)
 *
 * Claude only. The API key lives ONLY on this device (localStorage) and is sent
 * only to the endpoint you configure: the Anthropic API by default, or any
 * Anthropic-compatible endpoint (Base URL) — e.g. a company gateway or a key
 * provider you trust. A daily request cap guards against runaway spending.
 */

export type AuthMode = 'x-api-key' | 'bearer'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AISettings {
  apiKey: string
  /** '' = official Anthropic API. Otherwise an Anthropic-compatible endpoint (https://…). */
  baseUrl: string
  /** How the key is sent: x-api-key (Anthropic) or Authorization: Bearer (most gateways). */
  authMode: AuthMode
  model: string
  /** Thinking depth (official API only; custom endpoints get a plain request). */
  effort: Effort
  /** Max assistant requests per calendar day (spend guard). */
  dailyRequestCap: number
  usageDate: string // YYYY-MM-DD (local)
  usageCount: number
}

const LS_KEY = 'anime-studio:ai'
export const DEFAULT_MODEL = 'claude-opus-5-5'

export function defaultAISettings(): AISettings {
  return { apiKey: '', baseUrl: '', authMode: 'x-api-key', model: DEFAULT_MODEL, effort: 'medium', dailyRequestCap: 40, usageDate: todayStr(), usageCount: 0 }
}

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** True when the requests go to Anthropic itself (not a third-party gateway). */
export function isOfficialEndpoint(s: Pick<AISettings, 'baseUrl'>): boolean {
  const b = s.baseUrl.trim()
  if (!b) return true
  try { return new URL(b).hostname === 'api.anthropic.com' } catch { return false }
}

export function loadAISettings(): AISettings {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return defaultAISettings()
    const parsed = JSON.parse(raw) as Partial<AISettings> & { provider?: string; proxyUrl?: string }
    const { provider, proxyUrl: _proxy, ...rest } = parsed
    const s: AISettings = { ...defaultAISettings(), ...rest }
    // migration from the multi-provider version: a Gemini / Z.ai key can't talk to Claude
    if (provider && provider !== 'claude') { s.apiKey = ''; s.model = DEFAULT_MODEL }
    if (!s.model || /^(gemini|glm)/i.test(s.model)) s.model = DEFAULT_MODEL
    if (s.authMode !== 'bearer' && s.authMode !== 'x-api-key') s.authMode = 'x-api-key'
    if (s.usageDate !== todayStr()) { s.usageDate = todayStr(); s.usageCount = 0 }
    return s
  } catch {
    return defaultAISettings()
  }
}

export function saveAISettings(s: AISettings) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)) } catch { /* storage full — settings not persisted */ }
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
