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

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return json(503, { error: 'ai_not_configured', message: 'The AI is not configured on the server yet.' })
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 140_000 })

  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: Math.min(MAX_TOKENS[kind], Number(body.max_tokens) || MAX_TOKENS[kind]),
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: messages as Anthropic.Beta.BetaMessageParam[],
      output_config: { effort: EFFORT[kind] },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    })
    const msg = await stream.finalMessage()
    await admin.from('ai_usage').insert({ user_id: user.id, kind, model: msg.model, input_tokens: msg.usage.input_tokens ?? 0, output_tokens: msg.usage.output_tokens ?? 0 })
    if (msg.stop_reason === 'refusal') return json(422, { error: 'refused', message: 'Claude declined this request.' })
    const text = msg.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    return json(200, { text, stop_reason: msg.stop_reason, used: { ...acc.used, [kind]: acc.used[kind] + 1 }, limits: acc.limits })
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json(429, { error: 'busy', message: 'The AI is busy right now — try again in a minute.' })
    if (e instanceof Anthropic.AuthenticationError) return json(503, { error: 'ai_not_configured', message: 'The server AI key is invalid.' })
    if (e instanceof Anthropic.APIError) return json(502, { error: 'upstream', message: `AI error ${e.status ?? ''}` })
    return json(500, { error: 'internal', message: e instanceof Error ? e.message : String(e) })
  }
})
