/**
 * ANIME STUDIO — Tracker bridge
 * Connects PreviewMonitor tap events to the TrackerPanel without prop drilling.
 */
export interface TrackerPickPayload {
  /** comp-space position (y-up), clamped to comp bounds */
  x: number
  y: number
  clipId: string
}

type PickHandler = (p: TrackerPickPayload) => void

const handlers = new Set<PickHandler>()

export function onTrackerPick(fn: PickHandler): () => void {
  handlers.add(fn)
  return () => handlers.delete(fn)
}

export function emitTrackerPick(p: TrackerPickPayload) {
  for (const fn of handlers) fn(p)
}
