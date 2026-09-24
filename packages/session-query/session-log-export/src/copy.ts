/**
 * Same-host Session copy: read the source's durable log (flushed first when it
 * is live) and every subagent descendant's, then store them as new Sessions
 * of a Workspace through {@link storeSessionLogs} in `copy` mode. The source is
 * only ever read — a running Agent keeps running — and attachments need no
 * work because the copy shares this Host's content-addressed store.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionLineageNode } from '@deepseek-ai/dsh-session-query'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { flushLiveSessionLog, type SessionLogExportReady } from './archive.ts'
import { storeSessionLogs, type ParsedSessionLog, type SessionImportResult, type SessionImportTarget } from './import.ts'

/** Read one stored log (after flushing it when live) as a storable parsed log. */
async function readStoredLog(
  deps: Pick<SessionLogExportReady, 'sessionPersistence' | 'sessions'>,
  id: SessionId,
  signal: AbortSignal | undefined,
): Promise<ParsedSessionLog | undefined> {
  await flushLiveSessionLog(deps, id, signal)
  const options = signal === undefined ? {} : { signal }
  let handle
  try {
    handle = await deps.sessionPersistence.open(id, 'read', options)
  } catch (error) {
    if (error instanceof SessionPersistenceNotFoundError) return undefined
    throw error
  }
  try {
    const { events } = await handle.read(0, undefined, options)
    return { header: handle.header, events, inheritedEventCount: handle.inheritedEventCount }
  } finally {
    await handle.close()
  }
}

/**
 * Copy one stored Session (and its subagent descendants) into a Workspace of
 * this Host.
 * @param ctx - Host context carrying persistence and the projection cache.
 * @param deps - the mounted export services (lineage, persistence, live store).
 * @param sessionId - the source Session.
 * @param target - destination, origin label and copy options (`mode` is forced to `copy`, `crossHost` to false).
 * @returns the new root id and every stored Session, or `undefined` when the source has no stored log.
 */
export async function copyStoredSession(
  ctx: Context,
  deps: Pick<SessionLogExportReady, 'sessionQuery' | 'sessionPersistence' | 'sessions'>,
  sessionId: SessionId,
  target: Omit<SessionImportTarget, 'mode' | 'crossHost' | 'keepIds'>,
): Promise<SessionImportResult | undefined> {
  const { signal } = target
  const root = await readStoredLog(deps, sessionId, signal)
  if (root === undefined) return undefined
  const children: ParsedSessionLog[] = []
  const seen = new Set<SessionId>([sessionId])
  const collect = async (nodes: readonly SessionLineageNode[]): Promise<void> => {
    for (const node of nodes) {
      signal?.throwIfAborted()
      const id = node.session.header.id
      if (seen.has(id)) continue
      seen.add(id)
      const log = await readStoredLog(deps, id, signal)
      if (log !== undefined) children.push(log)
      await collect(node.descendants)
    }
  }
  const lineage = await deps.sessionQuery.traceSession(sessionId, signal)
  signal?.throwIfAborted()
  await collect(lineage.descendants)
  return storeSessionLogs(ctx, { root, children }, { ...target, mode: 'copy', crossHost: false })
}
