/**
 * ANIME STUDIO — Browser-direct AI client
 *
 * Talks straight from the browser to the provider API using the user's own
 * key (stored device-local, see settings.ts). No intermediate server, no
 * server-stored keys, works offline-build (static hosting) too.
 *
 * Providers:
 *  - Gemini: generativelanguage.googleapis.com (CORS enabled)
 *  - Claude: api.anthropic.com with the anthropic-dangerous-direct-browser-access
 *    header (officially supported browser access)
 *
 * Every request is counted against the daily cap BEFORE it is sent, so even
 * repeated manual retries cannot exceed the user's spend guard.
 */
import { loadAISettings, recordAIRequest } from './settings'
import { buildSystemPrompt, buildUserMessage, parseAIResponse } from './prompt'
import type { AIContext } from './prompt'
import type { AIOperation } from '../engine/types'

export interface AIResponse {
  reply: string
  operations: AIOperation[]
}

function friendlyHttpError(status: number, provider: string, body: string): string {
  const snippet = body.slice(0, 220)
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(body)) return 'Invalid API key — check it in Settings (Google said: API key not valid).'
  if (status === 401 || status === 403) return `${provider} rejected the key (HTTP ${status}). Check the key, its restrictions and billing. ${snippet}`
  if (status === 404) return `Model not found for this key (HTTP 404). Check the model name in Settings. ${snippet}`
  if (status === 429) return 'Quota/rate limit reached on the provider. Wait, or raise the limit in the provider console. Daily app cap unchanged.'
  if (status === 402) return `${provider} says insufficient credits (HTTP 402). Add credit/billing to the account.`
  return `${provider} HTTP ${status}: ${snippet}`
}

async function callGemini(system: string, history: { role: 'user' | 'assistant'; content: string }[], user: string, signal?: AbortSignal): Promise<string> {
  const s = loadAISettings()
  const contents = [
    ...history.map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] })),
    { role: 'user', parts: [{ text: user }] },
  ]
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.model)}:generateContent`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': s.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
    }),
  })
  if (!res.ok) throw new Error(friendlyHttpError(res.status, 'Gemini', await res.text().catch(() => '')))
  const json = await res.json()
  const cand = json?.candidates?.[0]
  const text: string = (cand?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('')
  if (!text.trim()) {
    const reason = cand?.finishReason ?? json?.promptFeedback?.blockReason ?? 'empty response'
    throw new Error(`Gemini returned an empty response (${reason}).`)
  }
  return text
}

async function callClaude(system: string, history: { role: 'user' | 'assistant'; content: string }[], user: string, signal?: AbortSignal): Promise<string> {
  const s = loadAISettings()
  const messages = [
    ...history.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
    { role: 'user', content: user },
  ]
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': s.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: s.model,
      max_tokens: 4096,
      system,
      messages,
    }),
  })
  if (!res.ok) throw new Error(friendlyHttpError(res.status, 'Claude', await res.text().catch(() => '')))
  const json = await res.json()
  const text: string = (json?.content ?? []).map((b: { text?: string }) => b.text ?? '').join('')
  if (!text.trim()) throw new Error('Claude returned an empty response.')
  return text
}

async function callZai(system: string, history: { role: 'user' | 'assistant'; content: string }[], user: string, signal?: AbortSignal): Promise<string> {
  const s = loadAISettings()
  const proxy = s.proxyUrl.trim().replace(/\/+$/, '')
  if (!proxy) {
    throw new Error('Z.ai blocks direct browser calls (their API does not answer the CORS preflight — verified). Deploy the free Cloudflare Worker from the kit (LEEME-ZAI.md) and paste its URL in Settings → Proxy URL.')
  }
  if (!/^https:\/\//.test(proxy)) throw new Error('The proxy URL must start with https://')
  const messages = [
    { role: 'system', content: system },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: user },
  ]
  let res: Response
  try {
    res = await fetch(`${proxy}/v1/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${s.apiKey}`,
      },
      body: JSON.stringify({
        model: s.model,
        messages,
        temperature: 0.4,
        max_tokens: 4096,
      }),
    })
  } catch (e) {
    if (e instanceof TypeError) throw new Error('Network error reaching your proxy worker — check the URL and that the worker is deployed.')
    throw e
  }
  if (!res.ok) throw new Error(friendlyHttpError(res.status, 'Z.ai', await res.text().catch(() => '')))
  let json: { choices?: { message?: { content?: string } }[] }
  try {
    json = await res.json()
  } catch {
    throw new Error('The proxy returned a non-JSON response — check the worker code matches zai-proxy.js from the kit.')
  }
  const text = json?.choices?.[0]?.message?.content ?? ''
  if (!text.trim()) throw new Error('Z.ai returned an empty response.')
  return text
}

/** Run one editing request. Throws with honest, actionable messages. */
export async function runAIEdit(message: string, mode: 'auto' | 'preview', context: AIContext): Promise<AIResponse> {
  const s = loadAISettings()
  if (!s.apiKey) throw new Error('No API key configured — open Settings → AI and paste your key.')
  if (s.usageCount >= s.dailyRequestCap) {
    throw new Error(`Daily cap reached (${s.dailyRequestCap} requests). Raise it in Settings or wait for tomorrow.`)
  }

  const system = buildSystemPrompt()
  const user = buildUserMessage(mode, context, message)
  const history = (context.recentHistory ?? []).slice(-6).map(h => ({
    role: (h.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
    content: h.content,
  }))

  let raw: string
  try {
    raw = s.provider === 'gemini'
      ? await callGemini(system, history, user)
      : s.provider === 'claude'
        ? await callClaude(system, history, user)
        : await callZai(system, history, user)
  } catch (e) {
    if (e instanceof TypeError) {
      throw new Error('Network/CORS error reaching the provider — check the connection or the key restrictions.')
    }
    throw e
  }
  recordAIRequest()
  const parsed = parseAIResponse(raw)
  return {
    reply: parsed.reply,
    operations: parsed.operations as AIOperation[],
  }
}

/** Tiny connectivity test used by the Settings screen. Counts against the cap. */
export async function testAIConnection(): Promise<{ ok: boolean; message: string }> {
  const s = loadAISettings()
  if (!s.apiKey) return { ok: false, message: 'No key saved yet.' }
  try {
    const ctx: AIContext = {
      projectName: 'test', composition: { width: 16, height: 9, fps: 30, duration: 1 },
      tracks: [], clips: [], assets: [], selectedClipId: null, playhead: 0, beats: 0, bpm: 0,
      recentHistory: [],
    }
    const user = `MODE: AUTO\nPROJECT CONTEXT:\n{"test":true}\n\nUSER REQUEST: reply with {"reply":"ok","operations":[]}`
    const system = 'You are a connectivity probe. Answer ONLY strict JSON {"reply":"ok","operations":[]}.'
    const raw = s.provider === 'gemini'
      ? await callGemini(system, [], user)
      : s.provider === 'claude'
        ? await callClaude(system, [], user)
        : await callZai(system, [], user)
    recordAIRequest()
    parseAIResponse(raw)
    return { ok: true, message: `Connected to ${s.provider} (${s.model}). Usage counted: ${s.usageCount + 1}/${s.dailyRequestCap} today.` }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
