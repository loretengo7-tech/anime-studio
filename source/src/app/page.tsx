'use client'
/**
 * ANIME STUDIO — entry point. The editor is client-only (WebGL, WebAudio,
 * WebCodecs need the browser), so the workspace is dynamically imported.
 */
import dynamic from 'next/dynamic'

const Workspace = dynamic(
  () => import('@/components/editor/Workspace').then(m => m.Workspace),
  {
    ssr: false,
    loading: () => (
      <div className="fixed inset-0 bg-zinc-950 flex flex-col items-center justify-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold tracking-widest text-zinc-100">ANIME<span className="text-amber-400">STUDIO</span></span>
        </div>
        <div className="w-40 h-1 bg-zinc-800 rounded overflow-hidden">
          <div className="h-full w-1/3 bg-amber-400 animate-pulse" />
        </div>
        <p className="text-xs text-zinc-500">Booting render engine…</p>
      </div>
    ),
  }
)

export default function Page() {
  return <Workspace />
}
