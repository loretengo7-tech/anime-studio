'use client'
/**
 * ANIME STUDIO — Account: sign in / sign up / reset password, plan + AI usage.
 * ProGate: wraps AI features (template / assistant) — sign-in and Pro checks.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useAccount, initAccount, signIn, signUp, signOut, resetPassword } from '@/lib/account/account'
import { useEditorStore } from '@/lib/store/editorStore'
import { useUIStore } from '@/lib/store/uiStore'
import { Loader2, LogOut, Crown, Mail, KeyRound, User, Sparkles } from 'lucide-react'

export function AccountPanel({ compact = false }: { compact?: boolean }) {
  useEffect(() => { initAccount() }, [])
  const { ready, session, plan, planError, refreshPlan } = useAccount()
  const toast = useEditorStore(s => s.toast)
  const [mode, setMode] = useState<'in' | 'up' | 'reset'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => { if (session) void refreshPlan() }, [session?.user.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    setBusy(true); setMsg(null)
    try {
      if (mode === 'in') { await signIn(email, password); toast({ kind: 'success', title: 'Signed in' }) }
      else if (mode === 'up') {
        if (password.length < 8) throw new Error('Use at least 8 characters for the password.')
        const r = await signUp(email, password, name)
        setMsg({ ok: true, text: r.needsConfirmation ? 'Account created. Open the e-mail we sent you to confirm it, then sign in here.' : 'Account created — you are signed in.' })
        if (r.needsConfirmation) setMode('in')
      } else { await resetPassword(email); setMsg({ ok: true, text: 'If that e-mail has an account, a reset link is on its way.' }) }
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }) }
    finally { setBusy(false) }
  }

  if (!ready) return <div className="p-3 text-zinc-500 text-[12px] flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> Loading account…</div>

  if (session) {
    const u = session.user
    const pct = (a: number, b: number) => `${Math.min(100, Math.round((a / Math.max(1, b)) * 100))}%`
    return (
      <div className={`${compact ? '' : 'p-3'} space-y-2.5 text-[12px]`}>
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-violet-500/30 flex items-center justify-center text-violet-200"><User size={15} /></div>
          <div className="min-w-0 flex-1">
            <div className="text-zinc-100 font-medium truncate">{(u.user_metadata?.display_name as string) || u.email}</div>
            <div className="text-[11px] text-zinc-500 truncate">{u.email}</div>
          </div>
          <button className="gbtn h-7 px-2 text-[11px] flex items-center gap-1" onClick={() => void signOut()}><LogOut size={12} /> Sign out</button>
        </div>
        {plan ? (
          <div className="rounded-lg border border-[#3a3a3a] p-2.5 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Crown size={13} className={plan.pro ? 'text-amber-400' : 'text-zinc-500'} />
              <span className="text-zinc-100 font-semibold">{plan.isAdmin ? 'Owner — unlimited AI' : plan.pro ? 'AnimeStudio Pro' : 'Free plan'}</span>
              {plan.pro && !plan.isAdmin && plan.periodEnd && <span className="ml-auto text-[10px] text-zinc-500">renews {new Date(plan.periodEnd).toLocaleDateString()}</span>}
            </div>
            {plan.limits && plan.pro && (
              <>
                <div className="text-[11px] text-zinc-400">AI templates this month: {plan.used.template}/{plan.limits.template}</div>
                <div className="h-1 bg-[#333]"><div className="h-full bg-violet-500" style={{ width: pct(plan.used.template, plan.limits.template) }} /></div>
                <div className="text-[11px] text-zinc-400">AI messages this month: {plan.used.chat}/{plan.limits.chat}</div>
                <div className="h-1 bg-[#333]"><div className="h-full bg-violet-500" style={{ width: pct(plan.used.chat, plan.limits.chat) }} /></div>
              </>
            )}
            {plan.isAdmin && <div className="text-[11px] text-zinc-500">Used this month: {plan.used.template} templates · {plan.used.chat} messages</div>}
            {!plan.pro && <ProPitch />}
          </div>
        ) : planError ? <div className="text-[11px] text-red-300">Could not load your plan: {planError} <button className="underline" onClick={() => void refreshPlan()}>retry</button></div>
          : <div className="text-zinc-500 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Loading plan…</div>}
      </div>
    )
  }

  return (
    <div className={`${compact ? '' : 'p-3'} space-y-2 text-[12px]`}>
      <div className="flex gap-1">
        {(['in', 'up'] as const).map(m => (
          <button key={m} className={`flex-1 h-7 rounded-[3px] border text-[12px] ${mode === m ? 'border-[#2d8ceb] bg-[#2d8ceb]/20 text-white' : 'border-[#3a3a3a] text-zinc-400'}`} onClick={() => { setMode(m); setMsg(null) }}>
            {m === 'in' ? 'Sign in' : 'Create account'}
          </button>
        ))}
      </div>
      {mode === 'up' && <input className="ginput w-full px-2 py-1.5 rounded text-[12px]" placeholder="Name (optional)" value={name} onChange={e => setName(e.target.value)} autoComplete="nickname" />}
      <div className="relative">
        <Mail size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input className="ginput w-full pl-7 pr-2 py-1.5 rounded text-[12px]" type="email" placeholder="E-mail" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
      </div>
      {mode !== 'reset' && (
        <div className="relative">
          <KeyRound size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input className="ginput w-full pl-7 pr-2 py-1.5 rounded text-[12px]" type="password" placeholder={mode === 'up' ? 'Password (8+ characters)' : 'Password'} value={password}
            onChange={e => setPassword(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void submit() }} autoComplete={mode === 'up' ? 'new-password' : 'current-password'} />
        </div>
      )}
      <button className="gbtn gbtn-accent w-full py-2 font-semibold flex items-center justify-center gap-1.5" disabled={busy || !email || (mode !== 'reset' && !password)} onClick={() => void submit()}>
        {busy && <Loader2 size={13} className="animate-spin" />}{mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create account' : 'Send reset link'}
      </button>
      {msg && <div className={`text-[11px] leading-4 p-2 rounded border ${msg.ok ? 'border-emerald-500/40 text-emerald-200 bg-emerald-500/10' : 'border-red-500/40 text-red-200 bg-red-500/10'}`}>{msg.text}</div>}
      <div className="flex justify-between text-[11px]">
        {mode !== 'reset' ? <button className="text-zinc-500 hover:text-zinc-300" onClick={() => { setMode('reset'); setMsg(null) }}>Forgot your password?</button>
          : <button className="text-zinc-500 hover:text-zinc-300" onClick={() => { setMode('in'); setMsg(null) }}>Back to sign in</button>}
      </div>
      <div className="text-[10px] text-zinc-600 leading-4">The editor is free. An account is needed for the AI features (AnimeStudio Pro).</div>
    </div>
  )
}

function ProPitch() {
  return (
    <div className="pt-1 space-y-1.5">
      <div className="text-[11px] text-zinc-300 leading-4">Pro unlocks the AI: templates from any edit and the editing assistant.</div>
      <button className="gbtn gbtn-violet w-full py-1.5 font-semibold flex items-center justify-center gap-1.5" disabled title="Payments are being set up"><Sparkles size={13} /> Get Pro — coming soon</button>
    </div>
  )
}

/** Wrap an AI feature: shows sign-in or Pro offers until the user can use it. */
export function ProGate({ children, feature }: { children: ReactNode; feature: string }) {
  useEffect(() => { initAccount() }, [])
  const { ready, session, plan } = useAccount()
  const setDialog = useUIStore(s => s.setDialog)
  if (!ready) return <div className="p-3 text-zinc-500 text-[12px] flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> Checking your account…</div>
  if (session && plan?.pro) return <>{children}</>
  return (
    <div className="p-3 space-y-3 text-[12px]">
      <div className="rounded-lg border border-violet-500/40 bg-violet-500/10 p-3 space-y-1.5">
        <div className="flex items-center gap-1.5 text-violet-100 font-semibold"><Crown size={14} className="text-amber-400" /> {feature} is part of AnimeStudio Pro</div>
        <div className="text-zinc-300 leading-5 text-[11px]">{session ? 'Your account is on the free plan.' : 'Sign in or create a free account to continue.'}</div>
      </div>
      {!session ? <AccountPanel compact /> : plan ? <ProPitch /> : <div className="text-zinc-500 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Loading plan…</div>}
      {session && <button className="text-[11px] text-zinc-500 underline" onClick={() => setDialog('settings')}>Account settings</button>}
    </div>
  )
}
