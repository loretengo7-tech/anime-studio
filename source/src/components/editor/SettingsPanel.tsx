'use client'
/**
 * ANIME STUDIO — Settings panel
 *  - Account (sign in / plan / AI usage) — the AI runs on AnimeStudio's server, no keys here
 *  - Storage & PWA install info
 */
import { AccountPanel } from './AccountPanel'
import { STATIC_MODE } from '@/lib/media/staticMode'
import { SectionTitle } from './ui-bits'
import { User } from 'lucide-react'

export function SettingsPanel() {
  return (
    <div className="p-3 pb-10">
      {/* ---------------- Account ---------------- */}
      <SectionTitle><User size={11} className="inline mr-1 text-violet-400" /> Account</SectionTitle>
      <div className="-mx-3 mb-3"><AccountPanel /></div>

      {/* ---------------- Storage ---------------- */}
      <SectionTitle>Storage & projects</SectionTitle>
      <div className="text-[10px] text-zinc-500 leading-relaxed mb-2">
        {STATIC_MODE
          ? 'Offline edition: projects autosave in this browser (localStorage) and media lives in IndexedDB on this device. Use Projects → Export .json as backup. Nothing leaves your device except AI requests (Pro), which go to the AnimeStudio server.'
          : 'Server edition: projects also sync to the server SQLite database (Projects panel). Media uploads to the server in this mode.'}
      </div>

      {/* ---------------- iPhone install ---------------- */}
      <SectionTitle>Install on iPhone (PWA)</SectionTitle>
      <div className="text-[10px] text-zinc-500 leading-relaxed">
        Open this app in <b>Safari</b> → Share button → <b>Add to Home Screen</b>. It launches fullscreen (standalone) like an app and keeps your data. On iOS the browser engine is always WebKit — App Store distribution needs a paid Apple Developer account (see the project guide for the Capacitor route).
      </div>

    </div>
  )
}
