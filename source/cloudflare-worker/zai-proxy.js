/**
 * ANIME STUDIO — Z.ai CORS proxy (Cloudflare Worker, free tier)
 *
 * WHY THIS EXISTS (verified 2026-11):
 *   Z.ai's API (api.z.ai) answers the actual POST with correct
 *   Access-Control-Allow-Origin headers, but its OPTIONS preflight response
 *   contains NO CORS headers — so Safari/Chrome always block the call before
 *   it is sent. This worker answers the preflight and forwards the POST.
 *
 * WHAT IT DOES (and does NOT do):
 *   - Forwards your request (with YOUR Authorization header) to api.z.ai.
 *   - Stores NOTHING: no key, no body, no logs of your content.
 *   - Anyone who finds this URL can only use it with their OWN key — it is a
 *     dumb pipe, not an open door to your account.
 *
 * DEPLOY (10 min, free): see LEEME-ZAI.md in this kit.
 */
const ZAI_ENDPOINT = 'https://api.z.ai/api/paas/v4/chat/completions'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Max-Age': '86400',
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }
    if (request.method !== 'POST') {
      return new Response('POST only — this worker forwards to Z.ai', { status: 405, headers: cors })
    }

    const auth = request.headers.get('authorization') ?? ''
    if (!auth) {
      return new Response(
        JSON.stringify({ error: { code: '401', message: 'Missing Authorization header — send your Z.ai API key as Bearer.' } }),
        { status: 401, headers: { ...cors, 'content-type': 'application/json' } },
      )
    }

    const body = await request.text()
    let upstream
    try {
      upstream = await fetch(ZAI_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': auth },
        body,
      })
    } catch {
      return new Response(
        JSON.stringify({ error: { message: 'Worker could not reach Z.ai — try again.' } }),
        { status: 502, headers: { ...cors, 'content-type': 'application/json' } },
      )
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    })
  },
}
