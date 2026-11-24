// Serve a media file with HTTP Range support (mandatory for iOS Safari seeking)
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { createReadStream, existsSync, statSync } from 'fs'
import path from 'path'
import type { ReadableOptions } from 'stream'

const MEDIA_DIR = path.join(process.cwd(), 'db', 'media')

function nodeToWebStream(nodeStream: import('stream').Readable): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer | string) => {
        controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk))
      })
      nodeStream.on('end', () => controller.close())
      nodeStream.on('error', err => controller.error(err))
    },
    cancel() {
      nodeStream.destroy()
    },
  })
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const asset = await db.mediaAsset.findUnique({ where: { id } })
    if (!asset) return new Response('Not found', { status: 404 })

    const useProxy = req.nextUrl.searchParams.get('proxy') === '1' && asset.proxyPath
    const filePath = path.join(MEDIA_DIR, useProxy ? asset.proxyPath! : asset.storagePath)
    if (!existsSync(filePath)) return new Response('File missing on server', { status: 410 })

    const stat = statSync(filePath)
    const fileSize = stat.size
    const contentType = useProxy
      ? 'video/mp4'
      : (asset.mimeType || 'application/octet-stream')
    const range = req.headers.get('range')

    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/)
      if (match) {
        const start = parseInt(match[1], 10)
        const end = match[2] ? parseInt(match[2], 10) : Math.min(start + 4 * 1024 * 1024, fileSize - 1)
        if (start >= fileSize) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${fileSize}` } })
        }
        const opts: ReadableOptions & { start: number; end: number } = { start, end }
        const stream = createReadStream(filePath, opts)
        return new Response(nodeToWebStream(stream as unknown as import('stream').Readable), {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000',
          },
        })
      }
    }

    const stream = createReadStream(filePath)
    return new Response(nodeToWebStream(stream as unknown as import('stream').Readable), {
      status: 200,
      headers: {
        'Content-Length': String(fileSize),
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000',
      },
    })
  } catch (e) {
    return new Response(`Error: ${e instanceof Error ? e.message : String(e)}`, { status: 500 })
  }
}
