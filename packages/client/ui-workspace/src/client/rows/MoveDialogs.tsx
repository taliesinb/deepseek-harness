/**
 * Browser-owned dialogs behind the "Move to…" / "Copy to…" (session) and
 * "Rehome…" (workspace) row actions. All share one destination picker — the
 * same WorkspacePickFlow popover the sidebar's "Add workspace" uses, so an
 * existing Workspace or a freshly registered directory can be the target — and
 * hand the decision to the Host's `session.move` / `session.moveMany` /
 * `session.copy`.
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
import { Button, IconChevronDownOutline14, IconFolderClose16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspacePickFlow, type WorkspacePickFlowProps } from '../WorkspacePicker.tsx'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
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

/** One resolved destination shown in the dialog. */
interface Destination {
  workspaceId: WorkspaceId
  title: string
  path: string
}

function destinationOf(workspaces: readonly WorkspaceView[], id: WorkspaceId | undefined): Destination | undefined {
  const view = id === undefined ? undefined : workspaces.find(candidate => candidate.workspaceId === id)
  return view === undefined ? undefined : { workspaceId: view.workspaceId, title: view.title, path: view.path }
}

/** The shared destination control: a button showing the choice, opening the pick flow. */
function DestinationPicker({ t, value, exclude, flow, onPick, disabled }: {
  t: Translate
  value: Destination | undefined
  /** Workspace the item currently belongs to (shown checked, still pickable to surface the same-workspace message). */
  exclude: WorkspaceId | undefined
  flow: DestinationFlowProps
  onPick: (workspaceId: WorkspaceId) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
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
        <IconFolderClose16 />
        <span className={css.moveDestinationText}>{value?.title ?? t('move.destination.pick')}</span>
        {value !== undefined && <span className={css.moveDestinationPath} title={value.path}>{value.path}</span>}
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
        selectedId={value?.workspaceId ?? exclude}
        showPaths
        matchAnchorWidth
        side="bottom"
        onPick={(workspaceId) => { setOpen(false); onPick(workspaceId) }}
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

/** "Move to…" for one session. */
export function MoveSessionDialog({ target, workspaces, api, flow, t, onClose, onMoved }: {
  /** The session being moved; null closes the dialog. */
  target: { sessionId: SessionId; title: string; workspaceId: WorkspaceId | undefined; destinationId?: WorkspaceId | undefined } | null
  workspaces: readonly WorkspaceView[]
  api: MoveApi
  flow: DestinationFlowProps
  t: Translate
  onClose: () => void
  onMoved: (workspaceId: WorkspaceId) => void
}) {
  const [destinationId, setDestinationId] = useState<WorkspaceId | undefined>(undefined)
  const [stopLive, setStopLive] = useState(false)
  const [blockers, setBlockers] = useState<readonly MoveBlocker[] | null>(null)
  const liveRefused = blockers !== null
  const [notify, setNotify] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setDestinationId(target?.destinationId)
    setStopLive(false)
    setBlockers(null)
    setNotify(true)
    setPending(false)
    setError(null)
  }, [target])
  const destination = destinationOf(workspaces, destinationId)
  const sameWorkspace = target !== null && destinationId !== undefined && destinationId === target.workspaceId
  const blocked = pending || destination === undefined || sameWorkspace || (liveRefused && !stopLive)

  const confirm = useCallback(async () => {
    if (target === null || destination === undefined || blocked) return
    setPending(true)
    setError(null)
    const result = await api.moveSession({
      sessionId: target.sessionId,
      destination: { workspaceId: destination.workspaceId },
      stopLive,
      notify,
    })
    setPending(false)
    if (result.ok) {
      onMoved(result.value.workspaceId)
      return
    }
    if (result.error.code === 'session/move-live') {
      setBlockers(blockersOf(result.error.details))
      return
    }
    setError(failureMessage(result))
  }, [api, blocked, destination, notify, onMoved, stopLive, target])

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      closeLabel={t('close')}
      title={t('move.session.title')}
      width={520}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={blocked} onClick={() => { void confirm() }}>{pending ? t('move.pending') : t('move.confirm')}</Button>
        </>
      )}
    >
      <div className={css.moveBody}>
        <div className={css.moveDesc}>{target?.title}</div>
        <DestinationPicker
          t={t} value={destination} exclude={target?.workspaceId} flow={flow} onPick={setDestinationId} disabled={pending}
        />
        {sameWorkspace && <div className={css.moveHint}>{t('move.destination.same')}</div>}
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
        <Checkbox checked={notify} onChange={setNotify} disabled={pending} label={t('move.notify')} />
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
export function CopySessionDialog({ target, workspaces, api, flow, t, onClose, onCopied }: {
  /** The session being copied; null closes the dialog. */
  target: { sessionId: SessionId; title: string; workspaceId: WorkspaceId | undefined; destinationId?: WorkspaceId | undefined } | null
  workspaces: readonly WorkspaceView[]
  api: Pick<MoveApi, 'copySession'>
  flow: DestinationFlowProps
  t: Translate
  onClose: () => void
  onCopied: (result: { sessionId: SessionId; workspaceId: WorkspaceId }) => void
}) {
  const [destinationId, setDestinationId] = useState<WorkspaceId | undefined>(undefined)
  const [title, setTitle] = useState('')
  const [truncate, setTruncate] = useState(true)
  const [blockers, setBlockers] = useState<readonly MoveBlocker[] | null>(null)
  const liveRefused = blockers !== null
  const [notify, setNotify] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setDestinationId(target?.destinationId ?? target?.workspaceId)
    setTitle(target === null ? '' : `${target.title}${t('copy.title.suffix')}`)
    setTruncate(true)
    setBlockers(null)
    setNotify(true)
    setPending(false)
    setError(null)
  }, [t, target])
  const destination = destinationOf(workspaces, destinationId)
  const blocked = pending || destination === undefined

  const confirm = useCallback(async () => {
    if (target === null || destination === undefined || blocked) return
    setPending(true)
    setError(null)
    const trimmed = title.trim()
    const result = await api.copySession({
      sessionId: target.sessionId,
      destination: { workspaceId: destination.workspaceId },
      // Undecided until the Host says a turn is running; then the checkbox decides.
      ...(liveRefused ? { truncate } : {}),
      ...(trimmed === '' || trimmed === target.title ? {} : { title: trimmed }),
      notify,
    })
    setPending(false)
    if (result.ok) {
      onCopied({ sessionId: result.value.sessionId, workspaceId: result.value.workspaceId })
      return
    }
    if (result.error.code === 'session/copy-live') {
      setBlockers(blockersOf(result.error.details))
      return
    }
    setError(failureMessage(result))
  }, [api, blocked, destination, liveRefused, notify, onCopied, target, title, truncate])

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      closeLabel={t('close')}
      title={t('copy.session.title')}
      width={520}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={blocked} onClick={() => { void confirm() }}>{pending ? t('copy.pending') : t('copy.confirm')}</Button>
        </>
      )}
    >
      <div className={css.moveBody}>
        {target !== null && <div className={css.moveDesc}>{t('copy.desc', { name: target.title })}</div>}
        <DestinationPicker
          t={t} value={destination} exclude={undefined} flow={flow} onPick={setDestinationId} disabled={pending}
        />
        <label className={css.moveField}>
          <span className={css.moveLabel}>{t('copy.title')}</span>
          <input
            className={css.renameInput}
            value={title}
            disabled={pending}
            onChange={(event) => { setTitle(event.currentTarget.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void confirm() } }}
          />
        </label>
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
        <Checkbox checked={notify} onChange={setNotify} disabled={pending} label={t('copy.notify')} />
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
  const [destinationId, setDestinationId] = useState<WorkspaceId | undefined>(undefined)
  const [stopLive, setStopLive] = useState(false)
  const [deleteSource, setDeleteSource] = useState(false)
  const [notify, setNotify] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  useEffect(() => {
    setDestinationId(undefined)
    setStopLive(false)
    setDeleteSource(false)
    setNotify(true)
    setPending(false)
    setError(null)
    setSummary(null)
  }, [target])
  const destination = destinationOf(workspaces, destinationId)
  const sameWorkspace = target !== null && destinationId === target.workspaceId
  const blocked = pending || destination === undefined || sameWorkspace || summary !== null

  const confirm = useCallback(async () => {
    if (target === null || destination === undefined || blocked) return
    setPending(true)
    setError(null)
    const result = await api.moveSessions({
      sessionIds: target.sessionIds,
      destination: { workspaceId: destination.workspaceId },
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
  }, [api, blocked, deleteSource, destination, notify, onDone, stopLive, t, target])

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
          t={t} value={destination} exclude={target?.workspaceId} flow={flow} onPick={setDestinationId}
          disabled={pending || summary !== null}
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
