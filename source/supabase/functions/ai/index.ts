// AnimeStudio — AI gateway (Supabase Edge Function "ai")
//
// The Claude API key lives ONLY here, as the secret ANTHROPIC_API_KEY. The app never sees it.
// Every request: verify the signed-in user → admin or active Pro subscription → monthly
// quota → call Claude (model chosen here, not by the client) → record token usage.
//
// POST body:
//   { "action": "status" }                                  → plan, usage, limits
//   { "action": "run", "kind": "template" | "chat", "system": string, "messages": [...], "max_tokens"?: number }
import Anthropic from 'npm:@anthropic-ai/sdk@1.14.0'
import { createClient } from 'jsr:@supabase/supabase-js@2'

const MODEL = Deno.env.get('AI_MODEL') ?? 'claude-opus-5-5'
const LIMITS = {
  template: Number(Deno.env.get('PRO_TEMPLATES_PER_MONTH') ?? 60),
  chat: Number(Deno.env.get('PRO_CHATS_PER_MONTH') ?? 600),
}
const EFFORT = { template: 'medium', chat: 'low' } as const
const MAX_TOKENS = { template: 32000, chat: 16000 }

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })

function monthStart() { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString() }

async function account(userId: string) {
  const [{ data: profile }, { data: sub }, { data: usage }] = await Promise.all([
    admin.from('profiles').select('is_admin, email').eq('id', userId).maybeSingle(),
    admin.from('subscriptions').select('status, plan, current_period_end').eq('user_id', userId).maybeSingle(),
    admin.from('ai_usage').select('kind').eq('user_id', userId).gte('created_at', monthStart()),
  ])
  const used = { template: 0, chat: 0 }
  for (const u of usage ?? []) used[u.kind as 'template' | 'chat']++
  const isAdmin = !!profile?.is_admin
  const active = !!sub && (sub.status === 'active' || sub.status === 'trialing' || (sub.status === 'canceled' && !!sub.current_period_end && new Date(sub.current_period_end) > new Date()))
  return { isAdmin, pro: isAdmin || active, status: sub?.status ?? 'none', periodEnd: sub?.current_period_end ?? null, used, limits: isAdmin ? null : LIMITS }
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' })

  // who is calling (verify_jwt already checked the token's signature at the platform level)
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: userData, error: userErr } = await admin.auth.getUser(token)
  const user = userData?.user
  if (userErr || !user) return json(401, { error: 'not_signed_in', message: 'Sign in to use the AI.' })

  let body: { action?: string; kind?: 'template' | 'chat'; system?: string; messages?: unknown[]; max_tokens?: number }
  try { body = await req.json() } catch { return json(400, { error: 'bad_json' }) }

  const acc = await account(user.id)
  if (body.action === 'status') return json(200, acc)
  if (body.action !== 'run') return json(400, { error: 'unknown_action' })

  const kind = body.kind === 'template' ? 'template' : 'chat'
  if (!acc.pro) return json(402, { error: 'subscription_required', message: 'AI is part of AnimeStudio Pro.' })
  if (acc.limits && acc.used[kind] >= acc.limits[kind]) {
    return json(429, { error: 'quota_reached', message: `You used your ${acc.limits[kind]} ${kind === 'template' ? 'templates' : 'AI messages'} for this month.` })
  }

  // keep requests bounded (the model and limits are decided here, never by the client)
  const system = String(body.system ?? '').slice(0, 80000)
  const messages = Array.isArray(body.messages) ? body.messages : []
  const raw = JSON.stringify(messages)
  if (!messages.length || raw.length > 8_000_000) return json(413, { error: 'request_too_large' })
  const images = (raw.match(/"type":"image"/g) ?? []).length
  if (images > 48) return json(413, { error: 'too_many_images' })

  // ---- providers: ANTHROPIC_API_KEY, then backups ANTHROPIC_API_KEY_2.._5. A backup may point to
  // another Anthropic-compatible server with ANTHROPIC_BASE_URL_N (+ optional ANTHROPIC_MODEL_N,
  // ANTHROPIC_AUTH_N = "bearer" | "x-api-key"); GEMINI_API_KEY adds Google Gemini. Each one is tried
  // in order until one answers.
  const providers = keyChain()
  if (!providers.length) return json(503, { error: 'ai_not_configured', message: 'The AI is not configured on the server yet.' })

  const maxTokens = Math.min(MAX_TOKENS[kind], Number(body.max_tokens) || MAX_TOKENS[kind])
  const failures: string[] = []
  for (const p of providers) {
    try {
      let msg: { model: string; stop_reason: string | null; usage: { input_tokens?: number | null; output_tokens?: number | null }; content: { type: string; text?: string }[] }
      if (p.type === 'gemini') msg = await callGemini(p, system, messages, maxTokens)
      else {
      const client = new Anthropic({
        ...(p.auth === 'bearer' ? { apiKey: null, authToken: p.key } : { apiKey: p.key }),
        ...(p.baseURL ? { baseURL: p.baseURL } : {}),
        maxRetries: 1, timeout: 140_000,
      })
      if (!p.baseURL) {
        // official API: effort + server-side refusal fallback
        msg = await client.beta.messages.stream({
          model: p.model, max_tokens: maxTokens,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages: messages as Anthropic.Beta.BetaMessageParam[],
          output_config: { effort: EFFORT[kind] },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        }).finalMessage()
      } else {
        // compatible gateway: plain request (gateways often reject the newest parameters)
        msg = await client.messages.stream({
          model: p.model, max_tokens: maxTokens,
          system,
          messages: messages as Anthropic.MessageParam[],
        }).finalMessage()
      }
      }
      await admin.from('ai_usage').insert({ user_id: user.id, kind, model: `${msg.model}${p.baseURL || p.type === 'gemini' ? ' @' + p.name : ''}`, input_tokens: msg.usage.input_tokens ?? 0, output_tokens: msg.usage.output_tokens ?? 0 })
      if (msg.stop_reason === 'refusal') return json(422, { error: 'refused', message: 'Claude declined this request.' })
      const text = msg.content.map(b => (b.type === 'text' ? b.text ?? '' : '')).join('')
      if (failures.length) console.warn('ai served by backup', p.name, 'after', failures.join(' | '))
      return json(200, { text, stop_reason: msg.stop_reason, used: { ...acc.used, [kind]: acc.used[kind] + 1 }, limits: acc.limits, ...(acc.isAdmin ? { servedBy: p.name } : {}) })
    } catch (e) {
      const why = e instanceof Anthropic.APIError ? `${p.name}: ${e.name} ${e.status ?? ''} ${e.message.slice(0, 200)}` : `${p.name}: ${e instanceof Error ? e.name + ' ' + e.message : String(e)}`
      console.error('ai provider failed', why)
      failures.push(why)
      // a bad request caused by the user's content would fail everywhere — stop early
      if (e instanceof Anthropic.BadRequestError && !p.baseURL && /too long|image|content/i.test(e.message)) break
    }
  }
  return json(502, { error: 'upstream', message: 'The AI service is not answering right now — try again in a minute.', ...(acc.isAdmin ? { detail: [...keyChainProblems, ...failures] } : {}) })
})

function clean(v: string | undefined) {
  // values pasted into the dashboard often carry spaces, line breaks, quotes or invisible characters
  // …and sometimes the whole line "NAME=value" (or "export NAME=value") instead of just the value
  return (v ?? '').replace(/[\s\u200B-\u200D\u2060\uFEFF"'\u201C\u201D\u2018\u2019]/g, '').replace(/^(export)?[A-Za-z_][A-Za-z0-9_]*=/, '')
}
// A secret may hold several pasted lines ("ANTHROPIC_BASE_URL=…\nANTHROPIC_MODEL=…"): read them as
// settings for that same provider number.
function envBlob(raw: string | undefined) {
  const out: Record<string, string> = {}
  for (const line of (raw ?? '').split(/[\r\n]+/)) {
    const m = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (m) out[m[1].toUpperCase().replace(/_[2-5]$/, '')] = clean(m[2])
  }
  return out
}
function providerEnv(n: string) {
  const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_AUTH']
  const blob: Record<string, string> = {}
  const own: Record<string, string> = {}
  for (const k of names) {
    const raw = Deno.env.get(`${k}${n}`)
    const b = envBlob(raw)
    if (Object.keys(b).length > 1) { Object.assign(blob, b); own[k] = b[k] ?? '' } else own[k] = clean(raw)
  }
  const get = (k: string) => own[k] || blob[k] || ''
  return { key: get('ANTHROPIC_API_KEY'), base: get('ANTHROPIC_BASE_URL'), model: get('ANTHROPIC_MODEL'), auth: get('ANTHROPIC_AUTH') }
}
const keyChainProblems: string[] = []
function keyChain() {
  keyChainProblems.length = 0
  const out: Provider[] = []
  for (const n of ['', '_2', '_3', '_4', '_5']) {
    const env = providerEnv(n)
    const key = env.key
    if (!key) continue
    if (!/^[\x21-\x7E]+$/.test(key)) { keyChainProblems.push(`ANTHROPIC_API_KEY${n}: invalid characters`); console.error(`ANTHROPIC_API_KEY${n} has invalid characters — skipped`); continue }
    let base = env.base.replace(/\/+$/, '').replace(/\/v1(\/messages)?$/, '')
    if (base && !/^https?:\/\//i.test(base)) base = `https://${base}` // "api.example.com" → https://api.example.com
    let host = ''
    try { if (base) host = new URL(base).hostname } catch { keyChainProblems.push(`ANTHROPIC_BASE_URL${n}: not a valid URL (length ${base.length}, has dot: ${base.includes('.')}, starts: ${base.slice(0, 12)})`); console.error(`ANTHROPIC_BASE_URL${n} is not a valid URL — skipped`); continue }
    const official = !base || host === 'api.anthropic.com'
    const auth = (env.auth || (official ? 'x-api-key' : 'bearer')) === 'x-api-key' ? 'x-api-key' : 'bearer'
    out.push({ type: 'anthropic', name: `key${n || '_1'}${official ? '' : ' (' + host + ')'}`, key, baseURL: official ? undefined : base, model: env.model || MODEL, auth })
  }
  // Google Gemini (free tier at aistudio.google.com): GEMINI_API_KEY (+ optional GEMINI_MODEL).
  // Tried after the Claude keys, or first with AI_PRIMARY=gemini.
  const g = providerGemini()
  if (g) { if (clean(Deno.env.get('AI_PRIMARY')).toLowerCase() === 'gemini') out.unshift(g); else out.push(g) }
  return out
}
type Provider = { type: 'anthropic' | 'gemini'; name: string; key: string; baseURL?: string; model: string; auth: 'bearer' | 'x-api-key' }
function providerGemini(): Provider | null {
  const raw = Deno.env.get('GEMINI_API_KEY')
  const b = envBlob(raw)
  const key = b.GEMINI_API_KEY || clean(raw)
  if (!key) return null
  return { type: 'gemini', name: 'gemini', key, model: clean(Deno.env.get('GEMINI_MODEL')) || b.GEMINI_MODEL || 'gemini-2.5-flash', auth: 'x-api-key' }
}

// ---- Gemini: translate the Claude-style request (text + base64 image blocks) to generateContent
type Block = { type: string; text?: string; source?: { type?: string; media_type?: string; data?: string } }
async function callGemini(p: Provider, system: string, messages: unknown[], maxTokens: number) {
  const contents = (messages as { role: string; content: string | Block[] }[]).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: (typeof m.content === 'string' ? [{ type: 'text', text: m.content } as Block] : m.content).flatMap((b: Block): ({ text: string } | { inline_data: { mime_type: string; data: string } })[] =>
      b.type === 'text' ? [{ text: b.text ?? '' }]
        : b.type === 'image' && b.source?.data ? [{ inline_data: { mime_type: b.source.media_type ?? 'image/jpeg', data: b.source.data } }]
        : []),
  })).filter(c => c.parts.length)
  // busy (503/429) or slow models are common on the free tier: try a few, within one time budget
  // (the platform kills the function at ~150 s, which the app sees as "Failed to send a request")
  const models = [...new Set([p.model, 'gemini-flash-latest', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest'])]
  const deadline = Date.now() + 120_000
  let last = ''
  for (const model of models) {
    const left = deadline - Date.now()
    if (left < 8000) break
    let r: Response
    try { r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.key },
      body: JSON.stringify({ ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents, generationConfig: { maxOutputTokens: Math.max(maxTokens, 8192) } }),
      signal: AbortSignal.timeout(Math.min(75_000, left)),
    }) } catch (e) { last = `${model}: ${e instanceof Error ? e.name : 'error'} (too slow)`; continue }
    const j = await r.json().catch(() => ({})) as { error?: { message?: string }; candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }; modelVersion?: string }
    if (!r.ok) { last = `${model}: ${r.status} ${(j.error?.message ?? '').slice(0, 200)}`; if ([404, 429, 500, 503, 504].includes(r.status)) continue; throw new Error(`Gemini ${last}`) }
    const c = j.candidates?.[0]
    const text = (c?.content?.parts ?? []).filter(x => !x.thought).map(x => x.text ?? '').join('')
    const fr = c?.finishReason ?? ''
    return {
      model: j.modelVersion ?? model,
      stop_reason: fr === 'MAX_TOKENS' ? 'max_tokens' : fr === 'SAFETY' || fr === 'PROHIBITED_CONTENT' ? 'refusal' : 'end_turn',
      usage: { input_tokens: j.usageMetadata?.promptTokenCount ?? 0, output_tokens: j.usageMetadata?.candidatesTokenCount ?? 0 },
      content: [{ type: 'text', text }],
    }
  }
  throw new Error(`Gemini ${last}`)
}
