/**
 * Moving Sessions between Workspaces. A Session's Workspace membership is its
 * header `cwd` (on-disk project directory, sandbox root, shell cwd, prompt
 * line, registry attach validation all read it), so a move is a storage
 * relocation (`sessionPersistence.relocate`) followed by registry detach/attach
 * and a list refresh. A resident Agent owns the write handle and blocks the
 * relocation; the caller may ask for it to be retired first, in which case it
 * resumes cold in the new Workspace the next time the Session is opened.
 *
 * Every moved Session receives one `agent/inbox/spliced` notice for the next
 * step so the Agent learns where it now lives and what its permissions cover.
 * Same-cwd subagent children of a moved Session move with it.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import { SessionAlreadyOwnedError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { basename } from 'node:path'
import type { ApiSessionAgentController } from './agent.ts'
import type { ApiSessionList } from './list.ts'
import type {
  SessionMoveDestination, SessionMoveManyRequest, SessionMoveManyValue, SessionMoveRequest, SessionMoveValue,
  SessionMoveSkip,
} from './types.ts'

/** Message source recorded on the relocation notice. */
export const SESSION_MOVE_NOTICE_PLUGIN = 'session-move'

const PERMISSION_LABELS: Record<string, string> = {
  'workspace-write': 'Workspace Write',
  'read-only': 'Read Only',
}

/**
 * The notice text an Agent reads on its next step after a move.
 * @param from - previous Workspace (title + path).
 * @param to - new Workspace (title + path).
 * @param sandboxMode - the Session's last recorded sandbox mode, when known.
 * @returns the complete reminder text.
 */
export function sessionMoveNoticeText(
  from: { title: string; path: string },
  to: { title: string; path: string },
  sandboxMode: string | undefined,
): string {
  const permission = sandboxMode === undefined ? undefined : PERMISSION_LABELS[sandboxMode]
  const clause = permission === undefined
    ? ''
    : ` Your current permissions of \`${permission}\` now grant access to this new directory instead of the old one.`
  return `<system-reminder>NOTE: this session's workspace was changed from \`${from.title}\` (${from.path}) to `
    + `\`${to.title}\` (${to.path}).${clause} Earlier file references may need to be re-read from the new location.</system-reminder>`
}

/** Recovers the origin a pending move notice named (see {@link sessionMoveNoticeText}). */
const MOVE_NOTICE_FROM = /workspace was changed from `([^`]*)` \(([^)]*)\) to `/u

/** Host-side move orchestration behind `session.move` / `session.moveMany`. */
export class SessionMoveController {
  /**
   * @param ctx - Host context carrying persistence, Workspace registry, Agents, and Sessions.
   * @param agents - Agent controller, for retiring a resident Agent before a move.
   * @param list - list state, for the refreshed summary broadcast after a move.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agents: ApiSessionAgentController,
    private readonly list: ApiSessionList,
  ) {}

  /**
   * Move one Session (and its same-cwd subagent children) to a Workspace.
   * @param request - Session, destination, and live-Session policy.
   * @returns the moved ids and the destination Workspace.
   */
  async move(request: SessionMoveRequest): Promise<SessionMoveValue> {
    const destination = await this.resolveDestination(request.destination)
    const outcome = await this.moveOne(request.sessionId, destination, request)
    if (outcome.skipped !== undefined) {
      throw new RemoteError(`session/move-${outcome.skipped.reason}`, outcome.skipped.message, {
        sessionId: request.sessionId,
      })
    }
    return { sessionId: request.sessionId, workspaceId: destination.id, moved: outcome.moved }
  }

  /**
   * Move several Sessions to one Workspace, reporting per-Session skips
   * instead of failing the batch.
   * @param request - Sessions, destination, and live-Session policy.
   * @returns moved ids and skipped Sessions with reasons.
   */
  async moveMany(request: SessionMoveManyRequest): Promise<SessionMoveManyValue> {
    const destination = await this.resolveDestination(request.destination)
    const moved: SessionId[] = []
    const skipped: SessionMoveSkip[] = []
    const done = new Set<SessionId>()
    for (const sessionId of request.sessionIds) {
      if (done.has(sessionId)) continue
      const outcome = await this.moveOne(sessionId, destination, request)
      for (const id of outcome.moved) done.add(id)
      moved.push(...outcome.moved)
      if (outcome.skipped !== undefined) skipped.push(outcome.skipped)
    }
    return { workspaceId: destination.id, moved, skipped }
  }

  private async resolveDestination(destination: SessionMoveDestination): Promise<Workspace> {
    if ('workspaceId' in destination) {
      const workspace = this.ctx.workspaceRegistry.get(destination.workspaceId)
      if (workspace === undefined) {
        throw new RemoteError('workspace/not-found', `workspace "${destination.workspaceId}" not found`, {
          workspaceId: destination.workspaceId,
        })
      }
      return workspace
    }
    try {
      return await this.ctx.workspaceRegistry.create(destination.path, destination.title)
    } catch (error) {
      throw new RemoteError('workspace/create-failed', `cannot use "${destination.path}" as a workspace: ${String(error)}`, {
        path: destination.path,
      })
    }
  }

  private async moveOne(
    sessionId: SessionId,
    destination: Workspace,
    policy: { stopLive?: boolean; notify?: boolean },
  ): Promise<{ moved: SessionId[]; skipped?: SessionMoveSkip }> {
    const persistence = this.ctx.sessionPersistence
    if (persistence.relocate === undefined) {
      throw new RemoteError('session/move-unsupported', 'this deployment\'s session storage cannot relocate sessions', {})
    }
    const snapshot = await persistence.stat(sessionId)
    const header = snapshot?.header ?? this.ctx.sessions.get(sessionId)?.header
    if (header === undefined) {
      return { moved: [], skipped: { sessionId, reason: 'missing', message: `session "${sessionId}" not found` } }
    }
    const fromPath = header.cwd
    const from = fromPath === undefined ? undefined : await this.ctx.workspaceRegistry.resolveByPath(fromPath).catch(() => undefined)
    if (from?.id === destination.id) {
      if (destination.sessionIds.includes(sessionId) || header.origin === 'subagent') {
        return { moved: [], skipped: { sessionId, reason: 'same-workspace', message: `session "${sessionId}" is already in that workspace` } }
      }
      // Stored under the destination's directory but not on its account (an
      // interrupted earlier move, or a session created outside the registry): just attach.
      this.ctx.workspaceRegistry.forgetSessionHeader(sessionId)
      await destination.attachSession(sessionId)
      return { moved: [sessionId] }
    }
    const fromLabel = {
      title: from?.title ?? (fromPath === undefined ? '(no workspace)' : basename(fromPath)),
      path: fromPath ?? '(none)',
    }
    const toLabel = { title: destination.title, path: destination.path }

    // Children first: they share the parent's cwd and are not in any registry account.
    const children = await this.childrenOf(sessionId, fromPath)
    const moved: SessionId[] = []
    for (const child of children) {
      const outcome = await this.relocateOne(child, destination, fromLabel, toLabel, policy)
      if (outcome.skipped === undefined) moved.push(child.id)
      // A live child is left behind (reported through the parent's skip below only if the parent also fails).
    }
    const outcome = await this.relocateOne(header, destination, fromLabel, toLabel, policy)
    if (outcome.skipped !== undefined) return { moved, skipped: outcome.skipped }
    moved.push(sessionId)
    return { moved }
  }

  private async relocateOne(
    header: SessionHeader,
    destination: Workspace,
    fromLabel: { title: string; path: string },
    toLabel: { title: string; path: string },
    policy: { stopLive?: boolean; notify?: boolean },
  ): Promise<{ skipped?: SessionMoveSkip }> {
    const sessionId = header.id
    const persistence = this.ctx.sessionPersistence
    const relocate = persistence.relocate?.bind(persistence)
    if (relocate === undefined) {
      throw new RemoteError('session/move-unsupported', 'this deployment\'s session storage cannot relocate sessions', {})
    }
    // A resident Agent owns the write handle: retire it first when allowed.
    if (this.ctx.agents.get(sessionId) !== undefined || this.ctx.sessions.get(sessionId) !== undefined) {
      if (policy.stopLive !== true) {
        return { skipped: { sessionId, reason: 'live', message: `session "${sessionId}" is open; stop it first or move with stopLive` } }
      }
      const retired = await this.agents.retire(sessionId)
      if (!retired) {
        return { skipped: { sessionId, reason: 'live', message: `session "${sessionId}" is owned by another component and cannot be stopped here` } }
      }
    }
    const cold = await this.readCold(sessionId)
    // Successive moves before the Agent runs again replace the pending notice
    // rather than stacking one per hop: the Agent needs "from where it last
    // ran, to where it is now", not the itinerary — so the replaced notice's
    // origin carries forward as the `from`.
    const pendingIndex = cold.pendingMoveNoticeIndex
    const noticeFrom = cold.pendingMoveFrom ?? fromLabel
    const notice = policy.notify === false
      ? []
      : [{
        type: 'agent/inbox/spliced' as const,
        data: {
          target: 'next-step' as const,
          start: pendingIndex ?? 0,
          ...(pendingIndex === undefined ? {} : { removedCount: cold.pendingMoveNoticeRun }),
          inserted: [createUserMessage({
            content: [{ type: 'text' as const, text: sessionMoveNoticeText(noticeFrom, toLabel, cold.sandboxMode) }],
            source: { kind: 'plugin' as const, plugin: SESSION_MOVE_NOTICE_PLUGIN },
          })],
        },
      }]
    try {
      await relocate({ id: sessionId, cwd: destination.path, append: notice })
    } catch (error) {
      if (error instanceof SessionAlreadyOwnedError) {
        return { skipped: { sessionId, reason: 'live', message: `session "${sessionId}" is open in another process` } }
      }
      if (error instanceof SessionPersistenceNotFoundError) {
        return { skipped: { sessionId, reason: 'missing', message: `session "${sessionId}" has no stored log` } }
      }
      return { skipped: { sessionId, reason: 'error', message: String(error instanceof Error ? error.message : error) } }
    }
    // Registry accounts: the cached header is stale now; leave the old
    // Workspace, join the new one (children have no account).
    this.ctx.workspaceRegistry.forgetSessionHeader(sessionId)
    const from = header.cwd === undefined ? undefined : await this.ctx.workspaceRegistry.resolveByPath(header.cwd).catch(() => undefined)
    if (from !== undefined && from.id !== destination.id) await from.detachSession(sessionId)
    if (header.origin !== 'subagent') {
      try {
        await destination.attachSession(sessionId)
      } catch (error) {
        return { skipped: { sessionId, reason: 'error', message: `moved on disk but could not attach to "${destination.title}": ${String(error)}` } }
      }
    }
    // Cached projections (title, stats) are cwd-independent: re-bind the
    // cache record so the moved Session lists with its title straight away.
    const stored = await persistence.stat(sessionId)
    if (stored !== undefined) {
      try {
        await this.ctx.get('sessionProjectionCache')?.rebind(header, stored.header, SessionLogOffset(0))
      } catch (error) {
        this.ctx.logger.warn(`session move: projection cache rebind for "${sessionId}" failed: ${String(error)}`)
      }
      // Clients merge summaries by id: the new cwd lands as an upsert.
      this.ctx.emit('api-session/added', this.list.summarizeCold(stored.header))
    }
    return {}
  }

  /** Same-cwd subagent children of a Session, from stored headers. */
  private async childrenOf(parent: SessionId, cwd: string | undefined): Promise<SessionHeader[]> {
    if (cwd === undefined) return []
    const snapshots = await this.ctx.sessionPersistence.list()
    return snapshots
      .map(snapshot => snapshot.header)
      .filter(header => header.origin === 'subagent' && header.parentSession === parent && header.cwd === cwd)
  }

  /**
   * Cold facts a move needs from the log: the last recorded `sandbox/mode`
   * and, in the pending next-step inbox, the index of an earlier move notice.
   */
  private async readCold(sessionId: SessionId): Promise<{
    sandboxMode: string | undefined
    pendingMoveNoticeIndex: number | undefined
    /** How many consecutive move notices sit at that index (all replaced together). */
    pendingMoveNoticeRun: number
    /** Origin named by the pending move notice, when one exists. */
    pendingMoveFrom: { title: string; path: string } | undefined
  }> {
    try {
      const handle = await this.ctx.sessionPersistence.open(sessionId, 'read')
      try {
        const { events } = await handle.read()
        let sandboxMode: string | undefined
        let pending: { source?: { kind?: string; plugin?: string }; content?: { type: string; text?: string }[] }[] = []
        for (const event of events as readonly { type: string; data: unknown }[]) {
          if (event.type === 'sandbox/mode') sandboxMode = (event.data as { mode?: string }).mode
          if (event.type !== 'agent/inbox/spliced') continue
          const splice = event.data as { target: string; start: number; removedCount?: number; inserted: typeof pending }
          if (splice.target !== 'next-step') continue
          pending = pending.toSpliced(splice.start, splice.removedCount ?? 0, ...splice.inserted)
        }
        const isMoveNotice = (message: (typeof pending)[number]): boolean =>
          message.source?.kind === 'plugin' && message.source.plugin === SESSION_MOVE_NOTICE_PLUGIN
        const index = pending.findIndex(isMoveNotice)
        let run = 0
        while (index !== -1 && index + run < pending.length && isMoveNotice(pending[index + run] as (typeof pending)[number])) run += 1
        // The earliest pending notice names where the Agent actually last ran.
        const text = index === -1 ? undefined : pending[index]?.content?.find(block => block.type === 'text')?.text
        const origin = text === undefined ? undefined : MOVE_NOTICE_FROM.exec(text)
        return {
          sandboxMode,
          pendingMoveNoticeIndex: index === -1 ? undefined : index,
          pendingMoveNoticeRun: run,
          pendingMoveFrom: origin?.[1] === undefined || origin[2] === undefined ? undefined : { title: origin[1], path: origin[2] },
        }
      } finally {
        await handle.close()
      }
    } catch {
      return { sandboxMode: undefined, pendingMoveNoticeIndex: undefined, pendingMoveNoticeRun: 0, pendingMoveFrom: undefined }
    }
  }
}
