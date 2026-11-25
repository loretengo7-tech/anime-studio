'use client'
/**
 * ANIME STUDIO — Settings panel
 *  - AI provider + API key (device-local only) + daily spend cap + test
 *  - Honest guide: how to get a key, how to limit spending, client-storage risks
 *  - Storage & PWA install info
 */
import { useEffect, useState } from 'react'
import {
  loadAISettings, saveAISettings, resetAIUsage, DEFAULT_MODELS,
} from '@/lib/ai/settings'
import type { AISettings, AIProvider } from '@/lib/ai/settings'
import { testAIConnection } from '@/lib/ai/aiClient'
import { STATIC_MODE } from '@/lib/media/staticMode'
import { useEditorStore } from '@/lib/store/editorStore'
import { SectionTitle, Row } from './ui-bits'
import { Loader2, Eye, EyeOff, KeyRound, ShieldAlert, Trash2 } from 'lucide-react'

export function SettingsPanel() {
  const toast = useEditorStore(s => s.toast)
  const [s, setS] = useState<AISettings>(() => loadAISettings())
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // re-load when the panel opens (key may exist from a previous session)
  useEffect(() => { setS(loadAISettings()) }, [])

  const update = (patch: Partial<AISettings>) => {
    setS(prev => {
      const next = { ...prev, ...patch }
      saveAISettings(next)
      setSavedAt(Date.now())
      return next
    })
  }

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await testAIConnection()
      setTestResult(`${r.ok ? 'OK — ' : 'FAILED — '}${r.message}`)
      toast({ kind: r.ok ? 'success' : 'error', title: r.ok ? 'AI connection works' : 'AI test failed', detail: r.message })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="p-3 pb-10">
      {/* ---------------- AI ---------------- */}
      <SectionTitle right={<span className="text-[10px] text-zinc-500">stored on this device only</span>}>
        <KeyRound size={11} className="inline mr-1 text-violet-400" /> AI editing assistant
      </SectionTitle>

      <Row label="Provider">
        <select
          className="flex-1 text-xs ginput rounded px-2 py-1.5"
          value={s.provider}
          onChange={e => {
            const p = e.target.value as AIProvider
            update({ provider: p, model: DEFAULT_MODELS[p] })
            setTestResult(null)
          }}
        >
          <option value="gemini">Google Gemini (free tier available)</option>
          <option value="claude">Anthropic Claude (prepaid credits)</option>
          <option value="zai">Z.ai GLM (via your own free proxy)</option>
        </select>
      </Row>

      <Row label="Model">
        <input
          className="flex-1 text-xs ginput rounded px-2 py-1.5 as-mono"
          value={s.model}
          onChange={e => update({ model: e.target.value.trim() })}
          placeholder={DEFAULT_MODELS[s.provider]}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </Row>

      <div className="mb-2">
        <div className="flex items-center gap-1.5">
          <input
            className="flex-1 text-xs ginput rounded px-2 py-2 as-mono"
            type={showKey ? 'text' : 'password'}
            value={s.apiKey}
            onChange={e => update({ apiKey: e.target.value.trim() })}
            placeholder={s.provider === 'gemini' ? 'AIza… (Gemini API key)' : s.provider === 'claude' ? 'sk-ant-… (Claude API key)' : 'your Z.ai API key'}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button className="tb-btn" onClick={() => setShowKey(v => !v)} aria-label="Show/hide key">
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <div className="text-[10px] text-zinc-500 mt-1 leading-relaxed">
          {s.provider === 'gemini' ? (
            <>Get it free: open <span className="text-sky-400">aistudio.google.com/apikey</span> in Safari → sign in → <b>Create API key</b>. Paste it here (never in the chat).</>
          ) : s.provider === 'claude' ? (
            <>Get it: <span className="text-sky-400">console.anthropic.com</span> → API Keys → Create key (needs prepaid credits).</>
          ) : (
            <>Get it: <span className="text-sky-400">z.ai open platform → API Keys</span>. Their API blocks direct browser calls, so ALSO deploy the free proxy worker (kit file <b>LEEME-ZAI.md</b>) and paste its URL below.</>
          )}
        </div>
      </div>

      {s.provider === 'zai' && (
        <div className="mb-2">
          <Row label="Proxy URL">
            <input
              className="flex-1 text-xs ginput rounded px-2 py-1.5 as-mono"
              value={s.proxyUrl}
              onChange={e => update({ proxyUrl: e.target.value.trim() })}
              placeholder="https://my-zai-proxy.your-user.workers.dev"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </Row>
          <div className="text-[10px] text-zinc-600 leading-relaxed">
            The worker only forwards your request to Z.ai — it stores nothing and never sees your key (it stays on this device and travels only inside the encrypted request). Setup: 10 minutes, free, kit file <b>LEEME-ZAI.md</b>.
          </div>
        </div>
      )}

      <Row label={`Daily cap · ${s.usageCount}/${s.dailyRequestCap} used`}>
        <input
          className="as-range flex-1"
          type="range"
          min={5}
          max={200}
          step={5}
          value={s.dailyRequestCap}
          onChange={e => update({ dailyRequestCap: parseInt(e.target.value) })}
        />
        <button className="p-1.5 text-zinc-500 hover:text-red-400" aria-label="Reset usage today" onClick={() => { resetAIUsage(); setS(loadAISettings()) }}>
          <Trash2 size={13} />
        </button>
      </Row>
      <div className="text-[10px] text-zinc-600 mb-2 leading-relaxed">
        The cap counts every assistant request made from this app per day and is enforced before sending — retries included. Also set a hard limit on the provider side: Google AI Studio → API keys (free tier quota), Anthropic Console → Limits → Monthly budget.
      </div>

      <button
        className="w-full py-2.5 rounded-xl gbtn gbtn-violet text-sm font-semibold flex items-center justify-center gap-1.5"
        onClick={() => void runTest()}
        disabled={testing || !s.apiKey}
      >
        {testing ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
        Test connection
      </button>
      {testResult && (
        <div className={`mt-2 p-2.5 rounded-lg text-[11px] border ${testResult.startsWith('OK') ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200' : 'border-red-500/50 bg-red-500/10 text-red-200'}`}>
          {testResult}
        </div>
      )}

      <div className="mt-3 p-2.5 rounded-xl border border-amber-500/40 bg-amber-500/5 text-[10px] text-amber-200/90 leading-relaxed flex items-start gap-2">
        <ShieldAlert size={14} className="mt-0.5 shrink-0" />
        <div>
          <b>Risks of a client-stored key (honest):</b> the key lives in this browser&apos;s localStorage. Any code running on this page can read it, and anyone with your unlocked phone can extract it. It is never sent to my servers (there are none), but a leaked key can spend your provider quota.
          Mitigate: use a key dedicated to this app, keep the daily cap low, restrict the Google key to the Generative Language API / a website referrer if you host it on your own domain, and rotate it if in doubt. Never paste the key into a chat.
        </div>
      </div>

      {/* ---------------- Storage ---------------- */}
      <SectionTitle>Storage & projects</SectionTitle>
      <div className="text-[10px] text-zinc-500 leading-relaxed mb-2">
        {STATIC_MODE
          ? 'Offline edition: projects autosave in this browser (localStorage) and media lives in IndexedDB on this device. Use Projects → Export .json as backup. Nothing leaves your device except your own AI requests.'
          : 'Server edition: projects also sync to the server SQLite database (Projects panel). Media uploads to the server in this mode.'}
      </div>

      {/* ---------------- iPhone install ---------------- */}
      <SectionTitle>Install on iPhone (PWA)</SectionTitle>
      <div className="text-[10px] text-zinc-500 leading-relaxed">
        Open this app in <b>Safari</b> → Share button → <b>Add to Home Screen</b>. It launches fullscreen (standalone) like an app and keeps your data. On iOS the browser engine is always WebKit — App Store distribution needs a paid Apple Developer account (see the project guide for the Capacitor route).
      </div>

      <p className="text-[9px] text-zinc-600 mt-3 as-mono">
        {savedAt ? `Saved to localStorage ${new Date(savedAt).toLocaleTimeString()}` : 'Changes save automatically to localStorage.'}
      </p>
    </div>
  )
}
