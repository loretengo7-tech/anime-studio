/**
 * ANIME STUDIO — AI client
 *
 * The AI is part of AnimeStudio Pro: requests go to the AnimeStudio server (Supabase
 * Edge Function "ai") as the signed-in user. The server holds the Claude key, picks the
 * model, checks the plan and the monthly quota, and records usage — the app never sees
 * a key and cannot change any of that.
 */
import type Anthropic from '@anthropic-ai/sdk'
import { callAI } from '../account/account'
import { buildSystemPrompt, buildUserMessage, parseAIResponse } from './prompt'
import type { AIContext } from './prompt'
import type { AIOperation } from '../engine/types'

export interface AIResponse {
  reply: string
  operations: AIOperation[]
}

/** One Claude request through the AnimeStudio server. Returns the answer text. */
export async function askClaude(opts: {
  kind: 'template' | 'chat'
  system: string
  messages: Anthropic.MessageParam[]
  maxTokens?: number
  signal?: AbortSignal
}): Promise<string> {
  const run = callAI<{ text: string; stop_reason: string }>({ action: 'run', kind: opts.kind, system: opts.system, messages: opts.messages, max_tokens: opts.maxTokens })
  const r = opts.signal
    ? await Promise.race([run, new Promise<never>((_, rej) => opts.signal!.addEventListener('abort', () => rej(new Error('Cancelled')), { once: true }))])
    : await run
  if (!r.text?.trim()) throw new Error(r.stop_reason === 'max_tokens' ? 'The answer was cut off.' : 'The AI returned an empty answer.')
  return r.text
}

/** Run one editing request from the chat. Throws with honest, actionable messages. */
export async function runAIEdit(message: string, mode: 'auto' | 'preview', context: AIContext): Promise<AIResponse> {
  const history = (context.recentHistory ?? []).slice(-6).map(h => ({
    role: (h.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
    content: h.content,
  }))
  const raw = await askClaude({
    kind: 'chat',
    system: buildSystemPrompt(),
    messages: [...history, { role: 'user', content: buildUserMessage(mode, context, message) }],
  })
  const parsed = parseAIResponse(raw)
  return { reply: parsed.reply, operations: parsed.operations as AIOperation[] }
}
