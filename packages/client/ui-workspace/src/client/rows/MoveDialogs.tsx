/**
 * Browser-owned dialogs behind the "Move to…" / "Copy to…" (session) and
 * "Rehome…" (workspace) row actions. All share one destination picker — the
 * same WorkspacePickFlow popover the sidebar's "Add workspace" uses, so an
 * existing Workspace or a freshly registered directory can be the target — and
 * hand the decision to the Host's `session.move` / `session.moveMany` /
 * `session.copy`.
 *
 * The session dialogs also list destinations contributed through
 * `ctx.uiWorkspace.contributeDestinations` (a remote host's Workspaces, for
 * instance) as further groups after this machine's, and hand a pick of one of
 * those to the contributor's `run` — which answers in the Host's own
 * RemoteResult vocabulary, so refusals read the same for every destination.
 *
 * A live Session refuses to move (`session/move-live`); the dialog answers by
 * revealing the stop-and-move option rather than failing, so the operator
 * chooses explicitly. A copy never disturbs the source, so a running one is
 * refused only until the operator decides what the copy does with the turn in
 * progress (`session/copy-live` → the truncate option). Rehome moves every
 * member of the source Workspace, reports skips, and can delete the emptied
 * source.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconChevronDownOutline14, IconFolderClose16, IconGlobeOutline14, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspacePickFlow, type PickFlowExternalGroup, type WorkspacePickFlowProps } from '../WorkspacePicker.tsx'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import type { DestinationContribution, DestinationGroup, DestinationRunRequest, DestinationRunResult } from '../navigation.ts'
import css from './WorkspaceBrowser.module.css'

/** The Host move surface as the browser consumes it (RemoteResult, not thrown). */
export interface MoveApi {
  moveSession: WorkspaceBrowserProps['moveSession']
  moveSessions: WorkspaceBrowserProps['moveSessions']
  copySession: WorkspaceBrowserProps['copySession']
  deleteWorkspace: WorkspaceBrowserProps['deleteWorkspace']
}

type Translate = WorkspaceBrowserProps['t']

/** Destination-picker props the dialogs forward to WorkspacePickFlow. */
export type DestinationFlowProps = Pick<WorkspacePickFlowProps, 'useWorkspaces' | 'createWorkspace' | 'useDirectoryFlow' | 'renderDirectoryFlow'>

/** One resolved destination shown in a session dialog: a local Workspace or a contributed one. */
export type DialogDestination =
  | { kind: 'local'; workspaceId: WorkspaceId; title: string; path: string }
  | { kind: 'external'; contributionId: string; groupId: string; groupLabel: string; key: string; title: string; path?: string | undefined }

/** One contributed group with the contribution it came from. */
export interface ContributedGroup {
  contributionId: string
  group: DestinationGroup
}

/**
 * The live groups of every destination contribution, flattened in contribution order.
 * @param contributions - the current contributions.
 * @returns groups with their contribution id (empty groups dropped).
 */
export function useContributedGroups(contributions: readonly DestinationContribution[]): readonly ContributedGroup[] {
  const read = useCallback((): readonly ContributedGroup[] => contributions.flatMap(contribution =>
    contribution.groups.getSnapshot()
      .filter(group => group.entries.length > 0)
      .map(group => ({ contributionId: contribution.id, group }))), [contributions])
  const [groups, setGroups] = useState<readonly ContributedGroup[]>(read)
  useEffect(() => {
    setGroups(read())
    const unsubscribes = contributions.map(contribution => contribution.groups.subscribe(() => { setGroups(read()) }))
    return () => { for (const unsubscribe of unsubscribes) unsubscribe() }
  }, [contributions, read])
  return groups
}

function localDestinationOf(workspaces: readonly WorkspaceView[], id: WorkspaceId | undefined): DialogDestination | undefined {
  const view = id === undefined ? undefined : workspaces.find(candidate => candidate.workspaceId === id)
  return view === undefined ? undefined : { kind: 'local', workspaceId: view.workspaceId, title: view.title, path: view.path }
}

function externalDestinationOf(groups: readonly ContributedGroup[], groupId: string, key: string): DialogDestination | undefined {
  const contributed = groups.find(candidate => candidate.group.id === groupId)
  const entry = contributed?.group.entries.find(candidate => candidate.key === key)
  if (contributed === undefined || entry === undefined) return undefined
  return {
    kind: 'external', contributionId: contributed.contributionId, groupId, groupLabel: contributed.group.label,
    key, title: entry.title, ...(entry.path === undefined ? {} : { path: entry.path }),
  }
}

/** The shared destination control: a button showing the choice, opening the pick flow. */
function DestinationPicker({ t, value, exclude, flow, groups, workspaces, onPick, disabled }: {
  t: Translate
  value: DialogDestination | undefined
  /** Workspace the item currently belongs to (shown checked, still pickable to surface the same-workspace message). */
  exclude: WorkspaceId | undefined
  flow: DestinationFlowProps
  /** Contributed groups listed after this machine's Workspaces (empty: the flat local list). */
  groups: readonly ContributedGroup[]
  workspaces: readonly WorkspaceView[]
  onPick: (destination: DialogDestination) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const externalGroups: PickFlowExternalGroup[] = groups.map(({ group }) => group)
  return (
    <div className={css.moveField}>
      <span className={css.moveLabel}>{t('move.destination')}</span>
      <button
        ref={anchor}
        type="button"
        className={css.moveDestination}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        {value?.kind === 'external' ? <IconGlobeOutline14 /> : <IconFolderClose16 />}
        <span className={css.moveDestinationText}>
          {value === undefined ? t('move.destination.pick') : value.kind === 'external' ? `${value.title} · ${value.groupLabel}` : value.title}
        </span>
        {value?.path !== undefined && <span className={css.moveDestinationPath} title={value.path}>{value.path}</span>}
        <IconChevronDownOutline14 />
      </button>
      <WorkspacePickFlow
        t={t}
        open={open}
        anchorRef={anchor}
        useWorkspaces={flow.useWorkspaces}
        createWorkspace={flow.createWorkspace}
        useDirectoryFlow={flow.useDirectoryFlow}
        renderDirectoryFlow={flow.renderDirectoryFlow}
        selectedId={value?.kind === 'local' ? value.workspaceId : value === undefined ? exclude : undefined}
        showPaths
        matchAnchorWidth
        side="bottom"
        externalGroups={externalGroups}
        localLabel={t('move.destination.local')}
        selectedExternal={value?.kind === 'external' ? { groupId: value.groupId, key: value.key } : undefined}
        onPick={(workspaceId) => {
          setOpen(false)
          const picked = localDestinationOf(workspaces, workspaceId)
          if (picked !== undefined) onPick(picked)
        }}
        onPickExternal={(pick) => {
          setOpen(false)
          const picked = externalDestinationOf(groups, pick.groupId, pick.key)
          if (picked !== undefined) onPick(picked)
        }}
        onClose={() => { setOpen(false) }}
      />
    </div>
  )
}

function Checkbox({ checked, onChange, disabled, label, description }: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: ReactNode
  description?: ReactNode
}) {
  return (
    <label className={css.moveOption}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => { onChange(event.currentTarget.checked) }} />
      <span>
        <span>{label}</span>
        {description !== undefined && <div className={css.moveOptionDesc}>{description}</div>}
      </span>
    </label>
  )
}

/** The Host's account of what a forced move would interrupt (`session/move-live` details). */
type MoveBlocker =
  | { kind: 'turn' }
  | { kind: 'jobs'; labels: readonly string[] }
  | { kind: 'subagents'; count: number; running: number }

function blockersOf(details: unknown): readonly MoveBlocker[] {
  const list = (details as { blockers?: unknown } | undefined)?.blockers
  return Array.isArray(list) ? list as MoveBlocker[] : [{ kind: 'turn' }]
}

function blockerLabel(blocker: MoveBlocker, t: Translate): string {
  switch (blocker.kind) {
    case 'turn': return t('move.blocker.turn')
    case 'jobs': return t('move.blocker.jobs', { n: String(blocker.labels.length), labels: blocker.labels.slice(0, 3).join(', ') + (blocker.labels.length > 3 ? ', …' : '') })
    case 'subagents': return blocker.running > 0
      ? t('move.blocker.subagentsRunning', { n: String(blocker.count), running: String(blocker.running) })
      : t('move.blocker.subagents', { n: String(blocker.count) })
  }
}

function failureMessage(result: RemoteResult<unknown>): string | null {
  return result.ok ? null : `${result.error.code}: ${result.error.message}`
}

/** One outcome shape for the Host's RemoteResult and a contributor's structural answer. */
type Outcome<V> =
  | { ok: true; value: V }
  | { ok: false; code: string; message: string; details: unknown }

function outcomeOf<V>(result: RemoteResult<V>): Outcome<V> {
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, code: result.error.code, message: result.error.message, details: result.error.details }
}

function contributedOutcome(result: DestinationRunResult): Outcome<{ summary?: string }> {
  return result.ok
    ? { ok: true, value: result.summary === undefined ? {} : { summary: result.summary } }
    : { ok: false, code: result.code, message: result.message, details: result.details }
}

/** Hand a contributed destination to its contributor. */
async function runContributed(
  contributions: readonly DestinationContribution[],
  destination: Extract<DialogDestination, { kind: 'external' }>,
  request: Omit<DestinationRunRequest, 'groupId' | 'destinationKey'>,
): Promise<Outcome<{ summary?: string }>> {
  const contribution = contributions.find(candidate => candidate.id === destination.contributionId)
  if (contribution === undefined) {
    return { ok: false, code: 'ui-workspace/destination-gone', message: 'that destination is no longer offered', details: undefined }
  }
  try {
    return contributedOutcome(await contribution.run({ ...request, groupId: destination.groupId, destinationKey: destination.key }))
  } catch (failure) {
    return { ok: false, code: 'ui-workspace/destination-failed', message: failure instanceof Error ? failure.message : String(failure), details: undefined }
  }
}

/** Source facts shared by the session dialogs. */
interface SessionDialogTarget {
  sessionId: SessionId
  title: string
  workspaceId: WorkspaceId | undefined
  /** Preselected local destination (a drop). */
  destinationId?: WorkspaceId | undefined
}

/** "Move to…" for one session. */
export function MoveSessionDialog({ target, workspaces, api, flow, contributions, t, onClose, onMoved }: {
  /** The session being moved; null closes the dialog. */
  target: SessionDialogTarget | null
  workspaces: readonly WorkspaceView[]
  api: MoveApi
  flow: DestinationFlowProps
  contributions: readonly DestinationContribution[]
  t: Translate
  onClose: () => void
  /** Moved: to a local Workspace (its id), or away through a contribution (undefined). */
  onMoved: (workspaceId: WorkspaceId | undefined) => void
}) {
  const groups = useContributedGroups(contributions)
  const [destination, setDestination] = useState<DialogDestination | undefined>(undefined)
  const [stopLive, setStopLive] = useState(false)
  const [blockers, setBlockers] = useState<readonly MoveBlocker[] | null>(null)
  const liveRefused = blockers !== null
  const [notify, setNotify] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  useEffect(() => {
    setDestination(localDestinationOf(workspaces, target?.destinationId))
    setStopLive(false)
    setBlockers(null)
    setNotify(true)
    setPending(false)
    setError(null)
    setSummary(null)
    // The list is read once per target: a preselected drop destination does not follow later list churn.
  }, [target])
  const sameWorkspace = target !== null && destination?.kind === 'local' && destination.workspaceId === target.workspaceId
  const blocked = pending || destination === undefined || sameWorkspace || summary !== null || (liveRefused && !stopLive)

  const confirm = useCallback(async () => {
    if (target === null || destination === undefined || blocked) return
    setPending(true)
    setError(null)
    const result: Outcome<{ summary?: string; moved?: readonly SessionId[] }> = destination.kind === 'local'
      ? outcomeOf(await api.moveSession({
        sessionId: target.sessionId, destination: { workspaceId: destination.workspaceId }, stopLive, notify,
      }))
      : await runContributed(contributions, destination, {
        action: 'move', sessionId: target.sessionId, sourceTitle: target.title, stopLive, notify,
        ...(target.workspaceId === undefined ? {} : { sourceWorkspaceId: target.workspaceId }),
      })
    setPending(false)
    if (result.ok) {
      const text = destination.kind === 'external' ? result.value.summary : undefined
      if (text !== undefined) {
        setSummary(text)
        return
      }
      onMoved(destination.kind === 'local' ? destination.workspaceId : undefined)
      return
    }
    if (result.code === 'session/move-live') {
      setBlockers(blockersOf(result.details))
      return
    }
    setError(`${result.code}: ${result.message}`)
  }, [api, blocked, contributions, destination, notify, onMoved, stopLive, target])

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      closeLabel={t('close')}
      title={t('move.session.title')}
      width={520}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={onClose}>{summary === null ? t('cancel') : t('close')}</Button>
          {summary === null && (
            <Button variant="primary" disabled={blocked} onClick={() => { void confirm() }}>{pending ? t('move.pending') : t('move.confirm')}</Button>
          )}
        </>
      )}
    >
      <div className={css.moveBody}>
        <div className={css.moveDesc}>{target?.title}</div>
        <DestinationPicker
          t={t} value={destination} exclude={target?.workspaceId} flow={flow} groups={groups} workspaces={workspaces}
          onPick={setDestination} disabled={pending || summary !== null}
        />
        {sameWorkspace && <div className={css.moveHint}>{t('move.destination.same')}</div>}
        {destination?.kind === 'external' && summary === null && <div className={css.moveHint}>{t('move.destination.external')}</div>}
        {liveRefused && (
          <>
            <div className={css.moveHint}>
              {t('move.live.blockers')}
              <ul className={css.moveBlockers}>
                {blockers.map((blocker, index) => <li key={index}>{blockerLabel(blocker, t)}</li>)}
              </ul>
            </div>
            <Checkbox checked={stopLive} onChange={setStopLive} disabled={pending} label={t('move.stopLive')} description={t('move.stopLive.desc')} />
          </>
        )}
        <Checkbox checked={notify} onChange={setNotify} disabled={pending || summary !== null} label={t('move.notify')} />
        {summary !== null && <div className={css.deleteStatus} role="status">{summary}</div>}
        {error !== null && <div className={css.renameError} role="alert">{error}</div>}
      </div>
    </Modal>
  )
}

/**
 * "Copy to…" for one session: a new session (fresh id) in the chosen
 * workspace — the source's own included — with an editable title defaulting to
 * “<title> (copy)”. A running source is refused once (`session/copy-live`);
 * the dialog then shows what is in flight and the truncate option, ticked by
 * default, and the operator confirms again.
 */
export function CopySessionDialog({ target, workspaces, api, flow, contributions, t, onClose, onCopied }: {
  /** The session being copied; null closes the dialog. */
  target: SessionDialogTarget | null
  workspaces: readonly WorkspaceView[]
  api: Pick<MoveApi, 'copySession'>
  flow: DestinationFlowProps
  contributions: readonly DestinationContribution[]
  t: Translate
  onClose: () => void
  /** Copied: into a local Workspace (ids known), or away through a contribution (both undefined). */
  onCopied: (result: { sessionId: SessionId | undefined; workspaceId: WorkspaceId | undefined }) => void
}) {
  const groups = useContributedGroups(contributions)
  const [destination, setDestination] = useState<DialogDestination | undefined>(undefined)
  const [title, setTitle] = useState('')
  const [truncate, setTruncate] = useState(true)
  const [blockers, setBlockers] = useState<readonly MoveBlocker[] | null>(null)
  const liveRefused = blockers !== null
  const [notify, setNotify] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  useEffect(() => {
    setDestination(localDestinationOf(workspaces, target?.destinationId ?? target?.workspaceId))
    setTitle(target === null ? '' : `${target.title}${t('copy.title.suffix')}`)
    setTruncate(true)
    setBlockers(null)
    setNotify(true)
    setPending(false)
    setError(null)
    setSummary(null)
  }, [t, target])
  const blocked = pending || destination === undefined || summary !== null

  const confirm = useCallback(async () => {
    if (target === null || destination === undefined || blocked) return
    setPending(true)
    setError(null)
    const trimmed = title.trim()
    const options = {
      // Undecided until the Host says a turn is running; then the checkbox decides.
      ...(liveRefused ? { truncate } : {}),
      ...(trimmed === '' || trimmed === target.title ? {} : { title: trimmed }),
      notify,
    }
    const result: Outcome<{ sessionId?: SessionId; workspaceId?: WorkspaceId; summary?: string }> = destination.kind === 'local'
      ? outcomeOf(await api.copySession({ sessionId: target.sessionId, destination: { workspaceId: destination.workspaceId }, ...options }))
      : await runContributed(contributions, destination, {
        action: 'copy', sessionId: target.sessionId, sourceTitle: target.title, ...options,
        ...(target.workspaceId === undefined ? {} : { sourceWorkspaceId: target.workspaceId }),
      })
    setPending(false)
    if (result.ok) {
      if (result.value.summary !== undefined) {
        setSummary(result.value.summary)
        return
      }
      onCopied({ sessionId: result.value.sessionId, workspaceId: result.value.workspaceId })
      return
    }
    if (result.code === 'session/copy-live') {
      setBlockers(blockersOf(result.details))
      return
    }
    setError(`${result.code}: ${result.message}`)
  }, [api, blocked, contributions, destination, liveRefused, notify, onCopied, target, title, truncate])

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      closeLabel={t('close')}
      title={t('copy.session.title')}
      width={520}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={onClose}>{summary === null ? t('cancel') : t('close')}</Button>
          {summary === null && (
            <Button variant="primary" disabled={blocked} onClick={() => { void confirm() }}>{pending ? t('copy.pending') : t('copy.confirm')}</Button>
          )}
        </>
      )}
    >
      <div className={css.moveBody}>
        {target !== null && <div className={css.moveDesc}>{t('copy.desc', { name: target.title })}</div>}
        <DestinationPicker
          t={t} value={destination} exclude={undefined} flow={flow} groups={groups} workspaces={workspaces}
          onPick={setDestination} disabled={pending || summary !== null}
        />
        <label className={css.moveField}>
          <span className={css.moveLabel}>{t('copy.title')}</span>
          <input
            className={css.renameInput}
            value={title}
            disabled={pending || summary !== null}
            onChange={(event) => { setTitle(event.currentTarget.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void confirm() } }}
          />
        </label>
        {destination?.kind === 'external' && summary === null && <div className={css.moveHint}>{t('copy.destination.external')}</div>}
        {liveRefused && (
          <>
            <div className={css.moveHint}>
              {t('copy.live.blockers')}
              <ul className={css.moveBlockers}>
                {blockers.map((blocker, index) => <li key={index}>{blockerLabel(blocker, t)}</li>)}
              </ul>
            </div>
            <Checkbox checked={truncate} onChange={setTruncate} disabled={pending} label={t('copy.truncate')} description={t('copy.truncate.desc')} />
          </>
        )}
        <Checkbox checked={notify} onChange={setNotify} disabled={pending || summary !== null} label={t('copy.notify')} />
        {summary !== null && <div className={css.deleteStatus} role="status">{summary}</div>}
        {error !== null && <div className={css.renameError} role="alert">{error}</div>}
      </div>
    </Modal>
  )
}

/** "Rehome…" for one workspace: move every member session elsewhere. */
export function RehomeWorkspaceDialog({ target, workspaces, api, flow, t, onClose, onDone }: {
  target: { workspaceId: WorkspaceId; title: string; sessionIds: readonly SessionId[] } | null
  workspaces: readonly WorkspaceView[]
  api: MoveApi
  flow: DestinationFlowProps
  t: Translate
  onClose: () => void
  onDone: (workspaceId: WorkspaceId) => void
}) {
  const [destination, setDestination] = useState<DialogDestination | undefined>(undefined)
  const [stopLive, setStopLive] = useState(false)
  const [deleteSource, setDeleteSource] = useState(false)
  const [notify, setNotify] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  useEffect(() => {
    setDestination(undefined)
    setStopLive(false)
    setDeleteSource(false)
    setNotify(true)
    setPending(false)
    setError(null)
    setSummary(null)
  }, [target])
  const local = destination?.kind === 'local' ? destination : undefined
  const sameWorkspace = target !== null && local?.workspaceId === target.workspaceId
  const blocked = pending || local === undefined || sameWorkspace || summary !== null

  const confirm = useCallback(async () => {
    if (target === null || local === undefined || blocked) return
    setPending(true)
    setError(null)
    const result = await api.moveSessions({
      sessionIds: target.sessionIds,
      destination: { workspaceId: local.workspaceId },
      stopLive,
      notify,
    })
    if (!result.ok) {
      setPending(false)
      setError(failureMessage(result))
      return
    }
    const { moved, skipped } = result.value
    let text = t('rehome.result', { moved: String(moved.length), skipped: String(skipped.length) })
    const live = skipped.filter(skip => skip.reason === 'live').length
    if (live > 0) text += ` (${String(live)} ${t('rehome.skipped.live')})`
    if (deleteSource && skipped.length === 0) {
      try {
        await api.deleteWorkspace(target.workspaceId)
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    }
    setPending(false)
    setSummary(text)
    onDone(result.value.workspaceId)
  }, [api, blocked, deleteSource, local, notify, onDone, stopLive, t, target])

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      closeLabel={t('close')}
      title={t('move.workspace.title')}
      width={520}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={onClose}>{summary === null ? t('cancel') : t('close')}</Button>
          {summary === null && (
            <Button variant="primary" disabled={blocked} onClick={() => { void confirm() }}>{pending ? t('rehome.pending') : t('rehome.confirm')}</Button>
          )}
        </>
      )}
    >
      <div className={css.moveBody}>
        {target !== null && (
          <div className={css.moveDesc}>{t('rehome.desc', { name: target.title, count: String(target.sessionIds.length) })}</div>
        )}
        <DestinationPicker
          t={t} value={destination} exclude={target?.workspaceId} flow={flow} groups={[]} workspaces={workspaces}
          onPick={setDestination} disabled={pending || summary !== null}
        />
        {sameWorkspace && <div className={css.moveHint}>{t('move.destination.same')}</div>}
        <Checkbox checked={stopLive} onChange={setStopLive} disabled={pending || summary !== null} label={t('rehome.stopLive')} />
        <Checkbox checked={deleteSource} onChange={setDeleteSource} disabled={pending || summary !== null} label={t('rehome.deleteSource')} />
        <Checkbox checked={notify} onChange={setNotify} disabled={pending || summary !== null} label={t('move.notify')} />
        {summary !== null && <div className={css.deleteStatus} role="status">{summary}</div>}
        {error !== null && <div className={css.renameError} role="alert">{error}</div>}
      </div>
    </Modal>
  )
}
