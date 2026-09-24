/** Workspace archive and directory UI capability. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { ClientRemote, DirectoryListing, RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ISessions,
  SessionReference,
  SessionTarget,
  SessionListState,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, embedPresentation } from '@deepseek-ai/dsh-client-store'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type {
  IWorkspaces, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

interface MainSelection {
  readonly sessionId?: SessionId
  readonly subagentAddress?: SubagentAddress
}

/** Workspace archive and directory operations consumed by Client UI domains. */
export interface UiWorkspace {
  /**
   * Select a Session and show its Conversation as one UI navigation action.
   * @param target - known Session identity or durable direct-parent subagent address to display.
   */
  openSession(target: SessionTarget): void
  /**
   * Connect a Workspace and open its Session unless a later navigation supersedes it.
   * @param workspaceId - target Workspace.
   * @param beforeOpen - optional synchronous preparation for the selected Session, skipped after supersession.
   * @returns completion; a superseded request may create a Session but does not open it.
   */
  openWorkspace(workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): Promise<void>
  /**
   * Fork a Session and open the child unless a later navigation supersedes it.
   * @param sessionId - source Session.
   * @returns completion; a superseded request leaves its child available without selecting it.
   */
  forkSession(sessionId: SessionId): Promise<void>
  /**
   * Resolve the reusable or newly created blank Session for a Workspace.
   * @param workspaceId - target Workspace.
   * @returns a Session already addressable through the Session Controller.
   */
  connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId>
  /**
   * Start a New Session flow and navigate to its Session.
   * @param workspaceId - explicit target; absent inherits the current or most recent Workspace.
   */
  startSession(workspaceId?: WorkspaceId): void
  /**
   * Archive a Session and clear it when it is the current selection.
   * @param sessionId - Session to archive.
   */
  archiveSession(sessionId: SessionId): Promise<void>
  /**
   * Unarchive a Session, restoring it to its recorded Workspace position.
   * @param sessionId - Session to unarchive.
   */
  unarchiveSession(sessionId: SessionId): Promise<void>
  /**
   * Open the Host-native directory picker.
   * @returns the selected directory, or null when cancelled.
   */
  pickDirectory(): Promise<string | null>
  /**
   * List one Host directory level.
   * @param path - directory path; absent selects the Host home.
   * @param signal - cancellation for a superseded scan.
   * @returns directory entries and breadcrumb ancestry.
   */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /**
   * Create a child directory.
   * @param path - existing parent directory.
   * @param name - child directory name.
   * @returns created absolute path.
   */
  createDirectory(path: string, name: string): Promise<string>
  /**
   * Contribute one row-menu item to every Session row of the sidebar tree.
   * Contributions are data: the row keeps owning its Menu and appends these
   * after the built-in items, in `order`. Other surfaces that show Session
   * rows (a plugin's remote groups) read the same registry.
   * @param entry - item identity, label, placement, predicate, and action.
   * @returns disposer withdrawing the item.
   */
  contributeSessionMenu(entry: SessionMenuContribution): () => void
  /**
   * Contribute one row-menu item to every Workspace row of the sidebar tree.
   * @param entry - item identity, label, placement, predicate, and action.
   * @returns disposer withdrawing the item.
   */
  contributeWorkspaceMenu(entry: WorkspaceMenuContribution): () => void
  /** Live registry of row-menu contributions (an observable for the browser's hook). */
  readonly menuContributions: HostObservable<MenuContributions>
  /**
   * Contribute destinations to the Move to… / Copy to… dialogs of local
   * Session rows: extra groups (a remote host each, say) listed after this
   * machine's Workspaces. Picking one hands the whole operation to the
   * contributor's `run`, which answers in the same RemoteResult vocabulary as
   * the Host (`session/move-live`, `session/copy-live` refusals included), so
   * the dialogs behave identically for every destination.
   * @param contribution - identity, live groups, and the executor.
   * @returns disposer withdrawing the contribution.
   */
  contributeDestinations(contribution: DestinationContribution): () => void
  /** Live registry of destination contributions (an observable for the browser's hook). */
  readonly destinationContributions: HostObservable<readonly DestinationContribution[]>
}

/** One destination a contributor offers (a Workspace on another host, for instance). */
export interface DestinationEntry {
  /** Stable key within its group. */
  readonly key: string
  readonly title: string
  /** Directory shown as the row's trailing detail. */
  readonly path?: string
}

/** One heading of contributed destinations (one remote host, say) with its entries. */
export interface DestinationGroup {
  readonly id: string
  readonly label: string
  readonly entries: readonly DestinationEntry[]
}

/** What a dialog asks a contributor to carry out once its destination is chosen. */
export interface DestinationRunRequest {
  readonly action: 'move' | 'copy'
  readonly sessionId: SessionId
  /** Owning Workspace of the source, absent for an ungrouped Session. */
  readonly sourceWorkspaceId?: WorkspaceId
  readonly sourceTitle: string
  readonly groupId: string
  readonly destinationKey: string
  /** Move: interrupt work in flight (after a `session/move-live` refusal). */
  readonly stopLive?: boolean
  /** Copy: drop the turn in progress (after a `session/copy-live` refusal). */
  readonly truncate?: boolean
  /** Copy: title recorded on the copy; omitted keeps the source's. */
  readonly title?: string
  /** Tell the Agent on its next step. */
  readonly notify: boolean
}

/**
 * A contributor's answer. Structural on purpose (no `RemoteError` instance),
 * so an out-of-tree plugin can build it from plain objects; the codes are the
 * Host's own (`session/move-live`, `session/copy-live`) so the dialogs react
 * to a contributor's refusal exactly as to the Host's.
 */
export type DestinationRunResult =
  | {
    readonly ok: true
    /** Shown in the dialog before it is closed; omitted closes the dialog at once. */
    readonly summary?: string
  }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly details?: unknown }

/** One contributor of dialog destinations. */
export interface DestinationContribution {
  /** Stable id, unique among contributions. */
  readonly id: string
  /** Sort key among contributions; this machine's own Workspaces always come first. */
  readonly order?: number
  /** Live groups; an empty list hides the contribution. */
  readonly groups: HostObservable<readonly DestinationGroup[]>
  /** Carry out the move or copy to one of this contribution's destinations. */
  readonly run: (request: DestinationRunRequest) => Promise<DestinationRunResult>
}

/** The Session row a contributed menu item acts on. */
export interface SessionMenuTarget {
  readonly sessionId: SessionId
  /** Owning Workspace, absent for an ungrouped Session. */
  readonly workspaceId?: WorkspaceId
  readonly title: string
}

/** The Workspace row a contributed menu item acts on. */
export interface WorkspaceMenuTarget {
  readonly workspaceId: WorkspaceId
  readonly path: string
  readonly title: string
}

/** One contributed row-menu item. */
export interface MenuContribution<T> {
  /** Stable id, unique among contributions of the same row kind. */
  readonly id: string
  /** Display label; a thunk follows the active locale. */
  readonly label: string | (() => string)
  /** Optional leading glyph (a 16px icon element). */
  readonly icon?: ReactNode
  /** Sort key among contributions; built-in items always come first. */
  readonly order?: number
  /** Destructive styling. */
  readonly danger?: boolean
  /** Offer the item only for matching rows. */
  readonly when?: (target: T) => boolean
  /** Run the action for the row. */
  readonly run: (target: T) => void
}

export type SessionMenuContribution = MenuContribution<SessionMenuTarget>
export type WorkspaceMenuContribution = MenuContribution<WorkspaceMenuTarget>

/** Current contributions, in order. */
export interface MenuContributions {
  readonly session: readonly SessionMenuContribution[]
  readonly workspace: readonly WorkspaceMenuContribution[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cross-Controller Workspace navigation and directory UI capability. */
    uiWorkspace: UiWorkspace
  }
}

/** Structured directory failure exposed to directory UI consumers. */
export class DirectoryBrowseError extends Error {
  override readonly name = 'DirectoryBrowseError'

  /** @param rpcError - Host directory business failure. */
  constructor(readonly rpcError: RemoteFailure) {
    super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Implements Workspace archive and directory UI operations. */
class UiWorkspaceService extends Service implements UiWorkspace {
  private readonly connecting = new Map<WorkspaceId, Promise<SessionId>>()
  private readonly lifetime = new AbortController()
  private readonly selection = createSnapshotStore<MainSelection>(
    {}, { persist: { name: 'dsh.sessions.current' } },
  )
  private mainReference: SessionReference | undefined
  /**
   * Embedded presentation pin (`?embed=<id>`): the one root Session this page
   * shows. While set, it is the initial selection and {@link replaceMain}
   * accepts only that Session and the subagent children reached from it, so
   * an embedded shell cannot wander to another root. (The persisted selection
   * cell is namespaced per embedded Session, so it starts empty.)
   */
  private readonly pinned = embedPresentation()?.sessionId as SessionId | undefined

  /**
   * @param ctx - Client root Context.
   * @param directoryPicker - the directory-picking Remote namespace.
   * @param workspaces - pure Workspace Controller.
   * @param sessions - pure Session Controller.
   */
  constructor(
    ctx: Context,
    private readonly directoryPicker: ClientRemote['directoryPicker'],
    private readonly workspaces: IWorkspaces,
    private readonly sessions: ISessions,
  ) {
    super(ctx, 'uiWorkspace')
    ctx.effect(() => {
      const stop = this.watchNavigation()
      return () => {
        stop()
        this.lifetime.abort()
        const reference = this.mainReference
        this.mainReference = undefined
        reference?.release()
      }
    }, 'ui-workspace: Workspace navigation policy')
  }

  async connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId> {
    const workspace = this.workspaces.list.getSnapshot().items
      .find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) {
      throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`)
    }
    const inflight = this.connecting.get(workspaceId)
    if (inflight !== undefined) return inflight

    const archived = this.workspaces.list.getSnapshot().archivedSessionIds
    const sessions = this.sessions.list.getSnapshot()
    for (const id of sessions.ids) {
      const summary = sessions.byId[id]
      if (summary !== undefined && summary.blank && summary.cwd === workspace.path
        && workspace.sessionIds.includes(summary.id)
        && !archived.includes(summary.id)) return summary.id
    }

    const attempt = this.sessions.create({ workspaceId })
      .finally(() => { this.connecting.delete(workspaceId) })
    this.connecting.set(workspaceId, attempt)
    return attempt
  }

  openSession(target: SessionTarget): void {
    this.replaceMain(target, this.lifetime.signal)
  }

  async openWorkspace(workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): Promise<void> {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    const sessionId = await this.connectWorkspace(workspaceId)
    if (navigation.aborted) return
    this.replaceMain(sessionId, navigation, beforeOpen)
  }

  async forkSession(sessionId: SessionId): Promise<void> {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    const childId = await this.sessions.fork({ sessionId, increaseTitle: true })
    if (!navigation.aborted) this.replaceMain(childId, navigation)
  }

  startSession(workspaceId?: WorkspaceId): void {
    const workspace = this.workspaces.list.getSnapshot()
    const sessions = this.sessions.list.getSnapshot()
    const current = this.mainReference?.sessionId
    const currentWorkspaceId = current === undefined
      ? undefined
      : workspace.items.find(item => item.sessionIds.includes(current))?.workspaceId
    const recent = workspace.phase === 'ready' && sessions.phase === 'ready'
      ? recentWorkspace(workspace.items, sessions.byId)
      : undefined
    const target = workspaceId ?? currentWorkspaceId ?? recent
    if (target === undefined) {
      this.clearMain()
      return
    }
    void this.openWorkspace(target).catch(
      (reason: unknown) => { console.warn('new session failed:', reason) },
    )
  }

  async archiveSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.archiveSession(sessionId)
    if (this.mainReference?.sessionId === sessionId) this.clearMain()
  }

  async unarchiveSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.unarchiveSession(sessionId)
  }

  async pickDirectory(): Promise<string | null> {
    const result = await this.directoryPicker.pick()
    if (!result.ok) throw new Error(`directory picker failed: ${result.error.message}`)
    return result.value
  }

  async listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const result = await this.directoryPicker.list(path, signal)
    if (!result.ok) throw new DirectoryBrowseError(result.error)
    return result.value
  }

  async createDirectory(path: string, name: string): Promise<string> {
    const result = await this.directoryPicker.createDirectory(path, name)
    if (!result.ok) throw new DirectoryBrowseError(result.error)
    return result.value
  }

  private contributions: MenuContributions = { session: [], workspace: [] }
  private readonly contributionListeners = new Set<() => void>()
  readonly menuContributions: HostObservable<MenuContributions> = {
    getSnapshot: () => this.contributions,
    subscribe: (listener) => {
      this.contributionListeners.add(listener)
      return () => { this.contributionListeners.delete(listener) }
    },
  }

  contributeSessionMenu(entry: SessionMenuContribution): () => void {
    return this.contribute('session', entry)
  }

  contributeWorkspaceMenu(entry: WorkspaceMenuContribution): () => void {
    return this.contribute('workspace', entry)
  }

  private destinations: readonly DestinationContribution[] = []
  private readonly destinationListeners = new Set<() => void>()
  readonly destinationContributions: HostObservable<readonly DestinationContribution[]> = {
    getSnapshot: () => this.destinations,
    subscribe: (listener) => {
      this.destinationListeners.add(listener)
      return () => { this.destinationListeners.delete(listener) }
    },
  }

  contributeDestinations(contribution: DestinationContribution): () => void {
    const publish = (next: readonly DestinationContribution[]): void => {
      this.destinations = [...next].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      for (const listener of this.destinationListeners) listener()
    }
    if (this.destinations.some(candidate => candidate.id === contribution.id)) {
      throw new Error(`uiWorkspace: duplicate destination contribution "${contribution.id}"`)
    }
    publish([...this.destinations, contribution])
    return () => { publish(this.destinations.filter(candidate => candidate.id !== contribution.id)) }
  }

  private contribute<K extends keyof MenuContributions>(kind: K, entry: MenuContributions[K][number]): () => void {
    const byOrder = (a: { order?: number }, b: { order?: number }): number => (a.order ?? 0) - (b.order ?? 0)
    const publish = (next: readonly MenuContributions[K][number][]): void => {
      this.contributions = { ...this.contributions, [kind]: [...next].sort(byOrder) }
      for (const listener of this.contributionListeners) listener()
    }
    const current = this.contributions[kind] as readonly MenuContributions[K][number][]
    if (current.some(candidate => candidate.id === entry.id)) {
      throw new Error(`uiWorkspace: duplicate ${kind} menu contribution "${entry.id}"`)
    }
    publish([...current, entry])
    return () => {
      publish((this.contributions[kind] as readonly MenuContributions[K][number][]).filter(candidate => candidate.id !== entry.id))
    }
  }

  private watchNavigation(): () => void {
    let initial: 'waiting' | 'connecting' | 'done' = 'waiting'
    const reconcile = (): void => {
      if (this.lifetime.signal.aborted) return
      if (this.clearArchivedCurrent()) return
      if (initial !== 'waiting') return
      const workspace = this.workspaces.list.getSnapshot()
      const sessions = this.sessions.list.getSnapshot()
      if (workspace.phase !== 'ready' || sessions.phase !== 'ready') return
      if (this.mainReference !== undefined) {
        initial = 'done'
        return
      }
      if (this.pinned !== undefined) {
        // An embedded page never falls back to the recent Workspace: it waits
        // for its pinned Session to be listed, like a persisted selection.
        if (sessions.byId[this.pinned] === undefined) return
        initial = 'connecting'
        try {
          this.openSession(this.pinned)
          initial = 'done'
        } catch (reason: unknown) {
          initial = 'waiting'
          console.warn('embedded Session selection failed:', reason)
        }
        return
      }
      const saved = this.selection.getSnapshot()
      const savedTarget = saved.subagentAddress
        ?? (saved.sessionId !== undefined && sessions.byId[saved.sessionId] !== undefined
          ? saved.sessionId
          : undefined)
      if (savedTarget !== undefined) {
        initial = 'connecting'
        try {
          if (saved.subagentAddress !== undefined) {
            void this.sessions.refreshSubagents(saved.subagentAddress.parentSessionId)
          }
          this.openSession(savedTarget)
          initial = 'done'
        } catch (reason: unknown) {
          initial = 'waiting'
          console.warn('initial Session restoration failed:', reason)
        }
        return
      }
      const target = recentWorkspace(workspace.items, sessions.byId)
      if (target === undefined) {
        initial = 'done'
        return
      }
      initial = 'connecting'
      void this.connectWorkspace(target).then(
        (sessionId) => {
          if (this.mainReference === undefined) this.openSession(sessionId)
        },
      ).then(
        () => { initial = 'done' },
        (reason: unknown) => {
          if (this.lifetime.signal.aborted) return
          initial = 'waiting'
          console.warn('initial workspace selection failed:', reason)
        },
      )
    }
    const disposeWorkspaces = this.workspaces.list.subscribe(reconcile)
    const disposeSessions = this.sessions.list.subscribe(reconcile)
    reconcile()
    return () => {
      this.lifetime.abort()
      disposeSessions()
      disposeWorkspaces()
    }
  }

  /** @returns true when an archived current selection was cleared. */
  private clearArchivedCurrent(): boolean {
    const current = this.mainReference?.sessionId
    if (current === undefined
      || !this.workspaces.list.getSnapshot().archivedSessionIds.includes(current)) return false
    this.clearMain()
    return true
  }

  private clearMain(): void {
    const previous = this.mainReference
    this.mainReference = undefined
    this.selection.set({})
    previous?.release()
    this.ctx.layout.selectPanel(null)
  }

  private replaceMain(
    target: SessionTarget,
    signal: AbortSignal,
    beforeOpen?: (sessionId: SessionId) => void,
  ): void {
    signal.throwIfAborted()
    if (this.pinned !== undefined && typeof target === 'string' && target !== this.pinned
      && this.sessions.subagentAddress(target) === undefined) {
      console.warn(`[uiWorkspace] embedded page is pinned to ${this.pinned}; ignoring openSession(${target})`)
      return
    }
    const reference = this.sessions.retain(target, { source: 'mainView' })
    try {
      signal.throwIfAborted()
      beforeOpen?.(reference.sessionId)
      if (signal.aborted) {
        reference.release()
        return
      }
      const subagentAddress = typeof target === 'string'
        ? this.sessions.subagentAddress(reference.sessionId)
        : target
      this.selection.set({
        sessionId: reference.sessionId,
        ...(subagentAddress === undefined ? {} : { subagentAddress }),
      })
    } catch (error: unknown) {
      reference.release()
      throw error
    }
    const previous = this.mainReference
    this.mainReference = reference
    previous?.release()
    void this.sessions.refreshSubagents(reference.sessionId)
    this.ctx.layout.selectPanel(null)
  }

}

/** Stable tie-breaking follows Host Workspace order. */
function recentWorkspace(
  workspaces: readonly WorkspaceView[],
  sessions: SessionListState['byId'],
): WorkspaceId | undefined {
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions[sessionId]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}

export { UiWorkspaceService }
