/**
 * ANIME STUDIO — pre-comp helpers shared by playback, audio and export.
 *
 * The compositor renders nested comps itself; media elements (video decode,
 * audio) are driven from a FLATTENED view where every clip inside a pre-comp
 * appears as a top-level clip at its absolute time. Flattened inner clips are
 * marked hidden so they are never drawn twice if this view reaches a renderer.
 */
import type { Clip, ProjectDoc, Track, PrecompClip } from './types'

const cache = new WeakMap<ProjectDoc, ProjectDoc>()

export function hasPrecompLayers(doc: ProjectDoc): boolean {
  return !!doc.precomps?.length && doc.clips.some(c => c.kind === 'precomp')
}

export function flattenForMedia(doc: ProjectDoc): ProjectDoc {
  if (!hasPrecompLayers(doc)) return doc
  const hit = cache.get(doc)
  if (hit) return hit
  const tracks: Track[] = [...doc.tracks]
  const clips: Clip[] = [...doc.clips]
  const walk = (layer: PrecompClip, offset: number, winStart: number, winEnd: number, muted: boolean, depth: number) => {
    if (depth > 4) return
    const pc = doc.precomps!.find(p => p.id === layer.precompId)
    if (!pc) return
    const trackMap = new Map<string, Track>()
    for (const t of pc.tracks) {
      const nt: Track = { ...t, id: `flat_${layer.id}_${t.id}`, muted: t.muted || muted }
      trackMap.set(t.id, nt)
      tracks.push(nt)
    }
    for (const c of pc.clips) {
      const absStart = offset + c.start
      const s = Math.max(absStart, winStart)
      const e = Math.min(absStart + c.duration, winEnd)
      if (c.kind === 'precomp') {
        walk(c as PrecompClip, absStart, s, e, muted || !!c.muted, depth + 1)
        continue
      }
      if (c.kind !== 'video' && c.kind !== 'audio') continue
      if (e <= s) continue
      const tr = trackMap.get(c.trackId)
      if (!tr) continue
      // keep the SAME clip id → the same media element the nested render samples
      const cut = s - absStart
      const nc = { ...c, trackId: tr.id, start: s, duration: e - s, hidden: true, muted: c.muted || muted } as Clip
      if ((nc.kind === 'video' || nc.kind === 'audio') && cut > 0) {
        nc.inPoint = nc.inPoint + cut * (c.speed || 1)
        nc.keyframes = nc.keyframes.map(k => ({ ...k, keyframes: k.keyframes.map(kf => ({ ...kf, time: kf.time - cut })) }))
      }
      clips.push(nc)
    }
  }
  for (const c of doc.clips) {
    if (c.kind !== 'precomp') continue
    const tr = doc.tracks.find(t => t.id === c.trackId)
    walk(c as PrecompClip, c.start, c.start, c.start + c.duration, !!c.muted || !!tr?.muted, 0)
  }
  const flat = { ...doc, tracks, clips }
  cache.set(doc, flat)
  return flat
}

import type { Precomp } from './types'

/** Pure: return `doc` with comp `targetId` open (the current comp is stored back into precomps). */
export function openCompIn(doc: ProjectDoc, targetId: string): ProjectDoc {
  const curId = doc.compId ?? 'main'
  if (targetId === curId) return doc
  const pcs = doc.precomps ?? []
  const target = pcs.find(p => p.id === targetId)
  if (!target) return doc
  const cur: Precomp = {
    id: curId, name: curId === 'main' ? (doc.compName ?? doc.name) : (doc.compName ?? 'Comp'),
    composition: doc.composition, tracks: doc.tracks, clips: doc.clips,
  }
  return {
    ...doc,
    precomps: [...pcs.filter(p => p.id !== targetId), cur],
    composition: target.composition, tracks: target.tracks, clips: target.clips,
    compId: target.id, compName: target.name,
  }
}

/** The project as seen from the root comp (export always renders the main comp). */
export function rootView(doc: ProjectDoc): ProjectDoc {
  if (!doc.compId || doc.compId === 'main') return doc
  return { ...openCompIn(doc, 'main'), compStack: [] }
}
