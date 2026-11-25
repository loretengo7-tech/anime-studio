// Media upload — stores files on server disk, registers in DB.
// Range-capable serving happens via /api/media/[id]/file (required for iOS Safari seeking).
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { uid } from '@/lib/engine/types'

export const maxDuration = 300

const MEDIA_DIR = path.join(process.cwd(), 'db', 'media')

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('file') as File | null
    const kind = (form.get('kind') as string) || 'video'
    const duration = parseFloat((form.get('duration') as string) || '0')
    const width = parseInt((form.get('width') as string) || '0', 10)
    const height = parseInt((form.get('height') as string) || '0', 10)
    const fps = parseFloat((form.get('fps') as string) || '0')

    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    if (file.size > 500 * 1024 * 1024) {
      return NextResponse.json({ error: 'File exceeds 500MB limit' }, { status: 413 })
    }

    await mkdir(MEDIA_DIR, { recursive: true })
    const id = uid('m')
    const ext = path.extname(file.name).slice(0, 12) || (file.type.startsWith('audio') ? '.mp3' : file.type.startsWith('image') ? '.png' : '.mp4')
    const storagePath = path.join(MEDIA_DIR, `${id}${ext}`)
    const bytes = Buffer.from(await file.arrayBuffer())
    await writeFile(storagePath, bytes)

    const asset = await db.mediaAsset.create({
      data: {
        id,
        filename: file.name.slice(0, 200),
        storagePath: `${id}${ext}`,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        kind,
        duration: isFinite(duration) ? duration : null,
        width: isFinite(width) ? width : null,
        height: isFinite(height) ? height : null,
        fps: isFinite(fps) ? fps : null,
      },
    })

    return NextResponse.json({
      id: asset.id,
      url: `/api/media/${asset.id}/file`,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

export async function GET() {
  try {
    const assets = await db.mediaAsset.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, filename: true, kind: true, size: true,
        duration: true, width: true, height: true, fps: true,
        proxyPath: true, createdAt: true,
      },
    })
    return NextResponse.json(assets.map(a => ({
      ...a,
      url: `/api/media/${a.id}/file`,
      proxyUrl: a.proxyPath ? `/api/media/${a.id}/file?proxy=1` : undefined,
    })))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
