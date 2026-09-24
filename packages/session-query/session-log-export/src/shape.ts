/**
 * Shaping a Session log for a copy. A copy never disturbs the original, so a
 * source mid-turn is copied from its durable log as it stands; the copy must
 * still be a self-consistent log an Agent can resume. Two shapes:
 *
 * - **truncated**: the turn in progress is dropped whole — the log is cut just
 *   before its `turn/start`, and the prompt(s) still queued for that turn are
 *   cancelled out of the inbox so the copy does not start running on open;
 * - **as-is**: everything recorded so far is kept and the open turn is closed
 *   with the crash-repair closers (`interruptedTurnClosers`: error results for
 *   pending tool calls, `step/end`, an interrupted `turn/end`).
 *
 * Only suffixes are cut and only events are appended, so seqs stay contiguous
 * and every `sourceEventSeqs` reference in the kept prefix stays valid.
 */
import { interruptedTurnClosers, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** How a copy shaped the source log. */
export interface CopiedLogShape {
  /** The events the copy stores (a prefix of the source, plus synthetic tail events). */
  readonly events: SessionEvent[]
  /** Whether a turn in progress was dropped. */
  readonly truncated: boolean
  /** Whether the source had a turn open (running, or crashed and not yet repaired). */
  readonly openTurn: boolean
  /** Time of the dropped turn's `turn/start`, when truncated (descendants created after it belong to that turn). */
  readonly cutTime?: number
}

/** Index of the `turn/start` whose turn never ended, or -1 for a balanced log. */
function openTurnIndex(events: readonly SessionEvent[]): number {
  let open = -1
  for (let index = 0; index < events.length; index += 1) {
    const type = events[index]?.type
    if (type === 'turn/start') open = index
    else if (type === 'turn/end') open = -1
  }
  return open
}

/** How many messages the `next-turn` inbox holds after folding every splice in `events`. */
function pendingNextTurnCount(events: readonly SessionEvent[]): number {
  let pending = 0
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const splice = event.data as { target: string; start: number; removedCount?: number; inserted: readonly unknown[] }
    if (splice.target !== 'next-turn') continue
    const start = Math.min(Math.max(0, splice.start), pending)
    const removed = Math.min(splice.removedCount ?? 0, pending - start)
    pending = pending - removed + splice.inserted.length
  }
  return pending
}

/**
 * Shape one source log for its copy.
 * @param events - the source's durable events in seq order.
 * @param options - `truncate`: drop the turn in progress (default: keep it and close it as interrupted).
 * @returns the events to store and what was done to them.
 */
export function shapeCopiedLog(events: readonly SessionEvent[], options: { readonly truncate?: boolean } = {}): CopiedLogShape {
  const open = openTurnIndex(events)
  if (open === -1) return { events: [...events], truncated: false, openTurn: false }
  if (options.truncate !== true) {
    return { events: [...events, ...interruptedTurnClosers(events)], truncated: false, openTurn: true }
  }
  const kept = events.slice(0, open)
  const turnStart = events[open] as SessionEvent
  const queued = pendingNextTurnCount(kept)
  if (queued > 0) {
    // The prompt that opened the dropped turn is still queued at the cut;
    // cancel it so the copy stays idle until the user says otherwise.
    const last = kept.at(-1)
    kept.push({
      type: 'agent/inbox/spliced',
      seq: SessionSeq(last === undefined ? 0 : last.seq + 1),
      time: last?.time ?? turnStart.time,
      data: { target: 'next-turn', start: 0, removedCount: queued, inserted: [], outcome: 'canceled' },
    })
  }
  return { events: kept, truncated: true, openTurn: true, cutTime: turnStart.time }
}
