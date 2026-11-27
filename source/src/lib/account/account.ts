/**
 * ANIME STUDIO — accounts (Supabase Auth) + the AI gateway.
 *
 * The AI is a Pro feature: the app never holds a Claude key. Requests go to the
 * Supabase Edge Function "ai", which checks the signed-in user's plan and monthly
 * quota and calls Claude with the server-side key. The URL and publishable key below
 * are public by design (row-level security protects the data).
 */
import { createClient, type Session, FunctionsHttpError } from '@supabase/supabase-js'
import { create } from 'zustand'

const SUPABASE_URL = 'https://wiowdniuhuilukmflvhp.supabase.co'
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_toiSHL6KD3IL0qqkS-mKFA_FoFvFu6m'
/** Where e-mail confirmation / password-reset links land (must be in Auth → URL Configuration). */
export const SITE_URL = 'https://animestudio.online'

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'anime-studio:auth' },
})

export interface PlanStatus {
  isAdmin: boolean
  pro: boolean
  status: string
  periodEnd: string | null
  used: { template: number; chat: number }
  limits: { template: number; chat: number } | null
}

interface AccountState {
  ready: boolean
  session: Session | null
  plan: PlanStatus | null
  planError: string | null
  refreshPlan: () => Promise<void>
}

export const useAccount = create<AccountState>((set, get) => ({
  ready: false,
  session: null,
  plan: null,
  planError: null,
  refreshPlan: async () => {
    if (!get().session) { set({ plan: null }); return }
    try {
      const plan = await callAI<PlanStatus>({ action: 'status' })
      set({ plan, planError: null })
    } catch (e) { set({ planError: e instanceof Error ? e.message : String(e) }) }
  },
}))

let started = false
/** Load the saved session and follow sign-in / sign-out. Safe to call many times. */
export function initAccount() {
  if (started || typeof window === 'undefined') return
  started = true
  void supabase.auth.getSession().then(({ data }) => {
    useAccount.setState({ session: data.session, ready: true })
    if (data.session) void useAccount.getState().refreshPlan()
  })
  supabase.auth.onAuthStateChange((_evt, session) => {
    const prev = useAccount.getState().session?.user.id
    useAccount.setState({ session, ready: true })
    if (session && session.user.id !== prev) void useAccount.getState().refreshPlan()
    if (!session) useAccount.setState({ plan: null })
  })
}

// ------------------------------------------------------------------ auth actions

const authMsg = (m: string) =>
  /invalid login credentials/i.test(m) ? 'Wrong e-mail or password.'
    : /email not confirmed/i.test(m) ? 'Confirm your e-mail first (check your inbox and spam).'
      : /already registered|already exists/i.test(m) ? 'There is already an account with that e-mail — sign in instead.'
        : /rate limit/i.test(m) ? 'Too many attempts — wait a few minutes.'
          : /password/i.test(m) && /6|characters|weak/i.test(m) ? 'Use a stronger password (at least 8 characters).'
            : m

export async function signIn(email: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
  if (error) throw new Error(authMsg(error.message))
}
export async function signUp(email: string, password: string, displayName: string) {
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(), password,
    options: { data: { display_name: displayName.trim() || undefined }, emailRedirectTo: SITE_URL },
  })
  if (error) throw new Error(authMsg(error.message))
  return { needsConfirmation: !data.session }
}
export async function signOut() { await supabase.auth.signOut() }
export async function resetPassword(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: SITE_URL })
  if (error) throw new Error(authMsg(error.message))
}

// ------------------------------------------------------------------ AI gateway

export class AIAccessError extends Error {
  constructor(public code: 'not_signed_in' | 'subscription_required' | 'quota_reached' | 'other', message: string) { super(message) }
}

/** POST to the "ai" edge function as the signed-in user. */
export async function callAI<T = { text: string; stop_reason: string }>(body: Record<string, unknown>): Promise<T> {
  const { data: s } = await supabase.auth.getSession()
  if (!s.session) throw new AIAccessError('not_signed_in', 'Sign in to use the AI (Account in Settings).')
  const { data, error } = await supabase.functions.invoke('ai', { body })
  if (error) {
    let payload: { error?: string; message?: string } = {}
    if (error instanceof FunctionsHttpError) { try { payload = await error.context.json() } catch { /* not json */ } }
    const code = payload.error === 'subscription_required' || payload.error === 'quota_reached' || payload.error === 'not_signed_in' ? payload.error : 'other'
    if (code !== 'other') window.dispatchEvent(new CustomEvent('as-ai-paywall', { detail: code }))
    throw new AIAccessError(code, payload.message || error.message || 'The AI request failed.')
  }
  if (body.action === 'run') void useAccount.getState().refreshPlan()
  return data as T
}
