// Project CRUD — server persistence for ANIME STUDIO documents
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET() {
  try {
    const projects = await db.project.findMany({
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, name: true, createdAt: true, updatedAt: true,
        data: true,
      },
    })
    // Return summaries with duration + clip count parsed from data
    const summaries = projects.map(p => {
      let clipCount = 0, duration = 0
      try {
        const doc = JSON.parse(p.data)
        clipCount = doc.clips?.length ?? 0
        duration = doc.composition?.duration ?? 0
      } catch { }
      return { id: p.id, name: p.name, clipCount, duration, updatedAt: p.updatedAt, createdAt: p.createdAt }
    })
    return NextResponse.json(summaries)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.text()
    const doc = JSON.parse(body)
    const project = await db.project.create({
      data: {
        name: typeof doc.name === 'string' && doc.name ? doc.name.slice(0, 120) : 'Untitled Project',
        data: body,
      },
    })
    return NextResponse.json({ id: project.id })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
