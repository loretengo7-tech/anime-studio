/**
 * ANIME STUDIO — Claude client (official @anthropic-ai/sdk)
 *
 * Runs on the user's device with the user's own key (see settings.ts):
 *  - Official Anthropic API: browser access is allowed by Anthropic for user-owned
 *    keys (`dangerouslyAllowBrowser`). Adaptive thinking + effort + server-side
 *    refusal fallback are enabled.
 *  - Custom Anthropic-compatible endpoint (Base URL): a plain Messages request
 *    (gateways often don't support the newest parameters). In the desktop app the
 *    request goes through the main process, so endpoints without CORS work too.
 *
 * Every request is counted against the daily cap BEFORE it is sent.
 */
import Anthropic from '@anthropic-ai/sdk'
import { loadAISettings, recordAIRequest, isOfficialEndpoint, type AISettings } from './settings'
import { buildSystemPrompt, buildUserMessage, parseAIResponse } from './prompt'
import type { AIContext } from './prompt'
import type { AIOperation } from '../engine/types'

export interface AIResponse {
  reply: string
  operations: AIOperation[]
}

// ---------------------------------------------------------------- transport

interface DesktopHttp { httpFetch: (req: { url: string; method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; headers: Record<string, string>; body: string }> }
function desktopHttp(): DesktopHttp | null {
  const d = typeof window !== 'undefined' ? (window as unknown as { animeStudioDesktop?: Partial<DesktopHttp> }).animeStudioDesktop : undefined
  return d && typeof d.httpFetch === 'function' ? d as DesktopHttp : null
}
/** fetch() through the desktop main process (no CORS); the SSE body is delivered whole. */
function bridgedFetch(desk: DesktopHttp): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null
    const url = req ? req.url : String(input)
    const headers: Record<string, string> = {}
    new Headers(init?.headers ?? req?.headers).forEach((v, k) => { headers[k] = v })
    const body = typeof init?.body === 'string' ? init.body : init?.body ? await new Response(init.body).text() : undefined
    const r = await desk.httpFetch({ url, method: init?.method ?? req?.method ?? 'GET', headers, body })
    return new Response(r.body, { status: r.status, headers: r.headers })
  }) as typeof fetch
}

export function makeClient(s: AISettings = loadAISettings()): Anthropic {
  const official = isOfficialEndpoint(s)
  const baseURL = official ? undefined : s.baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
  const desk = !official ? desktopHttp() : null
  return new Anthropic({
    ...(s.authMode === 'bearer' ? { apiKey: null, authToken: s.apiKey } : { apiKey: s.apiKey }),
    baseURL,
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
    timeout: 10 * 60 * 1000,
    ...(desk ? { fetch: bridgedFetch(desk) } : {}),
  })
}

/** Readable error text (typed SDK errors, most specific first). */
export function friendlyError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'The endpoint rejected the API key (401). Check the key and the "Send key as" setting.'
  if (e instanceof Anthropic.PermissionDeniedError) return 'This key has no permission for that model or endpoint (403).'
  if (e instanceof Anthropic.NotFoundError) return 'Model or endpoint not found (404). Check the model name and the Base URL.'
  if (e instanceof Anthropic.RateLimitError) return 'Rate limit / quota reached on the provider (429). Wait a bit or check your plan.'
  if (e instanceof Anthropic.BadRequestError) return `The request was rejected (400): ${e.message}`
  if (e instanceof Anthropic.InternalServerError) return `The provider had an error (${e.status}). Try again in a moment.`
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'The request timed out — the endpoint did not answer.'
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach the endpoint (network / CORS). In the web version a custom Base URL must allow browser requests — the desktop app does not have this limit.'
  if (e instanceof Anthropic.APIError) return `API error ${e.status ?? ''}: ${e.message}`
  return e instanceof Error ? e.message : String(e)
}

/**
 * One Claude request. `content` may include images (base64 JPEG) for vision.
 * Streams under the hood (long outputs never hit HTTP timeouts) and returns the text.
 */
export async function askClaude(opts: {
  system: string
  messages: Anthropic.MessageParam[]
  maxTokens?: number
  signal?: AbortSignal
}): Promise<string> {
  const s = loadAISettings()
  if (!s.apiKey) throw new Error('No API key yet — open Settings → AI and paste your key.')
  if (s.usageCount >= s.dailyRequestCap) throw new Error(`Daily cap reached (${s.dailyRequestCap} requests). Raise it in Settings or wait until tomorrow.`)
  recordAIRequest() // counted before sending: retries can never exceed the cap
  const client = makeClient(s)
  const official = isOfficialEndpoint(s)
  const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }]
  try {
    let msg: Anthropic.Message | Anthropic.Beta.BetaMessage
    if (official) {
      // official API: adaptive thinking (always on for current Opus) with an explicit effort,
      // plus server-side fallback if a safety classifier declines the request
      const stream = client.beta.messages.stream({
        model: s.model,
        max_tokens: opts.maxTokens ?? 32000,
        system,
        messages: opts.messages as Anthropic.Beta.BetaMessageParam[],
        output_config: { effort: s.effort },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      }, { signal: opts.signal })
      msg = await stream.finalMessage()
    } else {
      const stream = client.messages.stream({
        model: s.model,
        max_tokens: opts.maxTokens ?? 32000,
        system,
        messages: opts.messages,
      }, { signal: opts.signal })
      msg = await stream.finalMessage()
    }
    if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request.')
    const text = msg.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    if (!text.trim()) throw new Error(msg.stop_reason === 'max_tokens' ? 'The answer was cut off (max tokens).' : 'Claude returned an empty answer.')
    return text
  } catch (e) {
    if (e instanceof Error && /declined|empty answer|cut off/.test(e.message)) throw e
    throw new Error(friendlyError(e))
  }
}

/** Run one editing request from the chat. Throws with honest, actionable messages. */
export async function runAIEdit(message: string, mode: 'auto' | 'preview', context: AIContext): Promise<AIResponse> {
  const history = (context.recentHistory ?? []).slice(-6).map(h => ({
    role: (h.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
    content: h.content,
  }))
  const raw = await askClaude({
    system: buildSystemPrompt(),
    messages: [...history, { role: 'user', content: buildUserMessage(mode, context, message) }],
  })
  const parsed = parseAIResponse(raw)
  return { reply: parsed.reply, operations: parsed.operations as AIOperation[] }
}

/** Tiny connectivity test used by the Settings screen. Counts against the cap. */
export async function testAIConnection(): Promise<{ ok: boolean; message: string }> {
  const s = loadAISettings()
  if (!s.apiKey) return { ok: false, message: 'No key saved yet.' }
  try {
    const raw = await askClaude({
      system: 'You are a connectivity probe. Answer ONLY with the JSON {"reply":"ok","operations":[]}.',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 2000,
    })
    parseAIResponse(raw)
    return { ok: true, message: `Connected to ${isOfficialEndpoint(s) ? 'Anthropic' : s.baseUrl} · ${s.model}. Used today: ${loadAISettings().usageCount}/${s.dailyRequestCap}.` }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
