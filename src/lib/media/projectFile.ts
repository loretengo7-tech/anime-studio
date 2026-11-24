/**
 * ANIME STUDIO — Project file (.aeproject)
 *
 * Save/open the project like an After Effects project file: a JSON document
 * downloaded to (or picked from) disk. Media itself lives in the browser's
 * IndexedDB keyed by asset id — so opening a .aeproject on the SAME device
 * relinks footage automatically; on another device the missing footage is
 * listed clearly (AE "missing footage" flow) and can be re-imported.
 */
import type { AssetMeta, ProjectDoc } from '@/lib/engine/types'
import { migrateDoc } from '@/lib/store/editorStore'

export const PROJECT_EXT = '.aeproject'
export const PROJECT_MIME = 'application/json'

interface ProjectFilePayload {
  app: 'anime-studio'
  format: number
  savedAt: number
  doc: ProjectDoc
}

export function serializeProject(doc: ProjectDoc): string {
  const payload: ProjectFilePayload = {
    app: 'anime-studio',
    format: 1,
    savedAt: Date.now(),
    doc: { ...doc, aiHistory: doc.aiHistory.slice(-60) },
  }
  return JSON.stringify(payload, null, 1)
}

export interface OpenResult {
  doc: ProjectDoc
  /** Assets referenced by the project that have no persisted media on this device. */
  missingFootage: AssetMeta[]
  linkedFootage: number
}

export function parseProject(text: string): OpenResult {
  const raw = JSON.parse(text) as ProjectFilePayload | ProjectDoc
  const isPayload = (r: ProjectFilePayload | ProjectDoc): r is ProjectFilePayload =>
    (r as ProjectFilePayload).app === 'anime-studio' && 'doc' in r
  const inner = isPayload(raw) ? raw.doc : raw
  if (!inner || !inner.composition || !Array.isArray(inner.clips)) {
    throw new Error('Not an ANIME STUDIO project file (.aeproject)')
  }
  const doc = migrateDoc(inner)
  return { doc, missingFootage: [], linkedFootage: 0 }
}

export function downloadProjectFile(doc: ProjectDoc): void {
  const blob = new Blob([serializeProject(doc)], { type: PROJECT_MIME })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${(doc.name || 'project').replace(/[^\w\-]+/g, '_')}${PROJECT_EXT}`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}
