/**
 * Copying Sessions between Workspaces of this Host. Unlike a move, a copy
 * never touches the source: its durable log (flushed first when live) and
 * those of its subagent descendants are read and stored again under the
 * destination cwd as new Sessions with fresh ids — the storing half is the
 * same code that receives a cross-host import. The only decision a live source
 * forces is what to do with a turn in progress: drop it whole (`truncate`) or
 * keep what was recorded and close it as interrupted. Without that decision a
 * running source is refused (`session/copy-live`) so the operator chooses.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-query'
import { copyStoredSession } from '@deepseek-ai/dsh-session-log-export'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { basename } from 'node:path'
import { describeBlockers, sessionMoveBlockers, resolveMoveDestination } from './move.ts'
import type { SessionCopyRequest, SessionCopyValue } from './types.ts'

/** Host-side copy orchestration behind `session.copy`. */
export class SessionCopyController {
  /**
   * @param ctx - Host context carrying persistence, session query, the Workspace registry and Agents.
   */
  constructor(private readonly ctx: Context) {}

  /**
   * Copy one Session (and its subagent descendants) into a Workspace.
   * @param request - source, destination, and mid-turn policy.
   * @returns the new root id, every stored id, and whether a turn was dropped.
   */
  async copy(request: SessionCopyRequest): Promise<SessionCopyValue> {
    const destination = await resolveMoveDestination(this.ctx, request.destination)
    const { sessionId } = request
    const persistence = this.ctx.sessionPersistence
    const snapshot = await persistence.stat(sessionId)
    const header = snapshot?.header ?? this.ctx.sessions.get(sessionId)?.header
    if (header === undefined) {
      throw new RemoteError('session/copy-missing', `session "${sessionId}" not found`, { sessionId })
    }
    // A turn in progress is the one thing the caller must decide about; an
    // idle or absent Agent needs no question (the log is the whole truth).
    const resident = this.ctx.agents.get(sessionId)
    if (resident !== undefined && request.truncate === undefined) {
      const blockers = sessionMoveBlockers(this.ctx, resident)
      if (blockers.some(blocker => blocker.kind === 'turn')) {
        throw new RemoteError(
          'session/copy-live',
          `session "${sessionId}": ${describeBlockers(blockers)}; choose whether to drop the turn in progress (truncate)`,
          { sessionId, blockers },
        )
      }
    }
    const fromPath = header.cwd
    const from = fromPath === undefined ? undefined : await this.ctx.workspaceRegistry.resolveByPath(fromPath).catch(() => undefined)
    const origin = `workspace \`${from?.title ?? (fromPath === undefined ? '(no workspace)' : basename(fromPath))}\` (${fromPath ?? '(none)'})`
    let result
    try {
      result = await copyStoredSession(
        this.ctx,
        { sessionQuery: this.ctx.sessionQuery, sessionPersistence: persistence, sessions: this.ctx.sessions },
        sessionId,
        {
          workspace: destination,
          origin,
          ...(request.truncate === undefined ? {} : { truncate: request.truncate }),
          ...(request.title === undefined ? {} : { title: request.title }),
          ...(request.notify === undefined ? {} : { notify: request.notify }),
        },
      )
    } catch (error) {
      throw new RemoteError('session/copy-error', `failed to copy session "${sessionId}": ${String(error instanceof Error ? error.message : error)}`, { sessionId })
    }
    if (result === undefined) {
      throw new RemoteError('session/copy-missing', `session "${sessionId}" has no stored log`, { sessionId })
    }
    return {
      sessionId: result.sessionId,
      sourceSessionId: sessionId,
      workspaceId: destination.id,
      copied: result.imported.map(entry => entry.sessionId),
      truncated: result.truncated,
    }
  }
}
