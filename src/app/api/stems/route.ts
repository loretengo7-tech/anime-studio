/**
 * ANIME STUDIO — Stems separation API (vocal / instrumental)
 *
 * Modular, honest integration: the actual separation runs Demucs (Meta's
 * open source-separation model) via scripts/separate-vocals.py. This only
 * works when the Node server runs locally (npm run dev / next start) with
 * Python + demucs installed:
 *    pip install demucs
 *
 * The static export (GitHub Pages / PWA on the phone) has no server: the UI
 * must call this route anyway and surface the honest error returned here.
 */
import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import path from 'path'
import { db } from '@/lib/db'

const STEM_ROOT = path.join(process.cwd(), 'db', 'stems')
const SCRIPT = path.join(process.cwd(), 'scripts', 'separate-vocals.py')

export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  try {
    const { assetId } = await req.json()
    if (!assetId) return NextResponse.json({ error: 'assetId required' }, { status: 400 })

    const asset = await db.mediaAsset.findUnique({ where: { id: assetId } })
    if (!asset) return NextResponse.json({ error: 'Asset not found (server mode required)' }, { status: 404 })

    const srcPath = path.join(process.cwd(), 'db', 'media', asset.filename)
    if (!existsSync(srcPath)) {
      return NextResponse.json({ error: 'Media file not on server disk — static deployments cannot separate stems locally.' }, { status: 400 })
    }

    // python availability probe (honest failure)
    const probe = spawn('python3', ['-c', 'import demucs'])
    const probeCode = await new Promise<number>(resolve => probe.on('close', resolve)).catch(() => 1)
    if (probeCode !== 0) {
      return NextResponse.json({
        error: 'Demucs not installed on this machine. Run: pip install demucs  (then retry). Static builds (GitHub Pages) cannot run Python.',
      }, { status: 501 })
    }

    const outDir = path.join(STEM_ROOT, `${asset.id}_${Date.now()}`)
    mkdirSync(outDir, { recursive: true })

    const proc = spawn('python3', [SCRIPT, srcPath, outDir])
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => { stdout += d })
    proc.stderr.on('data', d => { stderr += d })
    const code = await new Promise<number>(resolve => proc.on('close', resolve))
    if (code !== 0) {
      return NextResponse.json({ error: 'Separation failed', detail: stderr.slice(-800) }, { status: 500 })
    }

    const [vocalsRel, instRel] = stdout.trim().split('\n').slice(-2)
    if (!vocalsRel || !instRel) return NextResponse.json({ error: 'Separation produced no stems' }, { status: 500 })

    // register both stems as regular media assets so they appear in the Project panel
    const mediaDir = path.join(process.cwd(), 'db', 'media')
    if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true })
    const stemId = (p: string) => `st_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const base = path.basename(asset.filename).replace(/\.[^.]+$/, '')

    const register = async (stemPath: string, suffix: string) => {
      const id = stemId(stemPath)
      const dest = path.join(mediaDir, `${id}.mp3`)
      const { copyFileSync } = await import('fs')
      copyFileSync(stemPath, dest)
      return db.mediaAsset.create({
        data: {
          id,
          filename: `${base} — ${suffix}.mp3`,
          storagePath: `${id}.mp3`,
          mimeType: 'audio/mpeg',
          size: 0,
          kind: 'audio',
          duration: asset.duration ?? null,
        },
      })
    }

    const vocals = await register(vocalsRel, 'vocals')
    const inst = await register(instRel, 'instrumental')

    return NextResponse.json({
      vocalsId: vocals.id,
      instrumentalId: inst.id,
      vocalsUrl: `/api/media/${vocals.id}/file`,
      instrumentalUrl: `/api/media/${inst.id}/file`,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
