/**
 * Store Session logs that came from elsewhere as new stored Sessions of this
 * Host under one Workspace. Two entry points share the storing half:
 *
 * - `importSessionZip` — the receiving half of a cross-host move or copy: one
 *   Session-log ZIP as `session.export` produces it (root log,
 *   `subagents/<id>/session.jsonl` descendants, `media/` and `files/`
 *   attachments);
 * - `storeSessionLogs` — already-parsed logs, which a same-host copy reads
 *   straight from persistence.
 *
 * Attachments are content-addressed (`sha256:` ids), so saving the bytes here
 * reproduces the ids the logs reference; no event rewriting is needed for
 * them. Each log's header gets the destination cwd. In `move` mode an id that
 * already exists here is replaced by a fresh one (descendants are re-parented
 * to match) and the root receives one `agent/inbox/spliced` notice for its
 * next step naming the origin, so the Agent knows earlier file references may
 * not resolve. In `copy` mode every log gets a fresh id, a source mid-turn is
 * shaped by {@link shapeCopiedLog} (dropped whole or closed as interrupted),
 * descendants born in a dropped turn are left out, an optional title is
 * recorded, and the notice tells the Agent it is a copy.
 */
import { randomUUID } from 'node:crypto'
import { unzipSync } from 'fflate'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { shapeCopiedLog } from './shape.ts'

/** Message source recorded on the import notice. */
export const SESSION_IMPORT_NOTICE_PLUGIN = 'session-import'

/** Message source recorded on the copy notice. */
export const SESSION_COPY_NOTICE_PLUGIN = 'session-copy'

/** What the caller decides about the destination. */
export interface SessionImportTarget {
  readonly workspace: Workspace
  /** Where the logs came from, for the Agent's notice (`alpha.tailnet/dsh`, a workspace…). */
  readonly origin: string
  /**
   * `move` (default): the Sessions continue here — ids kept when free, the
   * notice says "imported". `copy`: the originals live on — fresh ids always,
   * mid-turn shaping, optional title, the notice says "copy".
   */
  readonly mode?: 'move' | 'copy'
  /** Keep the exported ids when free here (default true in `move` mode); `copy` mode always re-ids. */
  readonly keepIds?: boolean
  /** `copy` mode: drop a turn in progress instead of closing it as interrupted (default false). */
  readonly truncate?: boolean
  /** `copy` mode: title recorded on the copied root (a `session/title` event); omitted keeps the source's. */
  readonly title?: string
  /**
   * Whether the logs come from another host (default true): the notice then
   * warns that files referenced earlier may not exist here.
   */
  readonly crossHost?: boolean
  /** Append the notice to the root (default true). */
  readonly notify?: boolean
  readonly signal?: AbortSignal
}

/** One imported Session as stored here. */
export interface ImportedSession {
  readonly sessionId: SessionId
  readonly exportedId: SessionId
  readonly parentSessionId?: SessionId
}

/** Outcome of one import or copy. */
export interface SessionImportResult {
  readonly sessionId: SessionId
  readonly imported: readonly ImportedSession[]
  readonly attachments: number
  /** `copy` mode: whether the root's turn in progress was dropped. */
  readonly truncated: boolean
}

/** Root/subagent log entries, any format generation name (`session.jsonl`, `session.v3.jsonl`). */
const ROOT_LOG = /^session(?:\.v\d+)?\.jsonl$/u
const SUBAGENT_LOG = /^subagents\/([^/]+)\/session(?:\.v\d+)?\.jsonl$/u
const MEDIA_ENTRY = /^media\/([^/]+)\.(png|jpg|webp|gif)$/u
const FILE_ENTRY = /^files\/[0-9a-f]{2}\/([0-9a-f]{64})\/(.+)$/u
const MEDIA_TYPES: Record<string, ImageMediaType> = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
}

/** One Session log ready to be stored: header, events, and the fork-inherited cut. */
export interface ParsedSessionLog {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly inheritedEventCount: SessionLogOffset
}

/** Parse one exported JSONL text through the current format's strict restore. */
function parseLog(text: string, label: string): ParsedSessionLog {
  const lines = text.split('\n').filter(line => line !== '')
  if (lines.length === 0) throw new Error(`${label}: empty log`)
  let headerLine: unknown
  try {
    headerLine = JSON.parse(lines[0] as string)
  } catch {
    throw new Error(`${label}: header line is not JSON`)
  }
  if (typeof headerLine !== 'object' || headerLine === null || (headerLine as { type?: unknown }).type !== 'session') {
    throw new Error(`${label}: first line is not a session header`)
  }
  const restore = sessionFormatCatalog.createRestore(headerLine, { recovery: 'strict', validation: 'transformed' })
  for (const line of lines.slice(1)) {
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      throw new Error(`${label}: event line is not JSON`)
    }
    restore.decodeRow(row)
  }
  const artifact = restore.finish()
  const raw = headerLine as Record<string, unknown>
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: brandString<SessionId>(String(raw['id'])),
    createdAt: Number(raw['createdAt']),
    ...(typeof raw['cwd'] === 'string' ? { cwd: raw['cwd'] } : {}),
    ...(typeof raw['parentSession'] === 'string' ? { parentSession: brandString<SessionId>(raw['parentSession']) } : {}),
    isSeeded: raw['isSeeded'] === true,
    ...(raw['origin'] === 'subagent' ? { origin: 'subagent' as const } : {}),
    ...(typeof raw['delegationDepth'] === 'number' && raw['delegationDepth'] > 0 ? { delegationDepth: raw['delegationDepth'] } : {}),
    ...(typeof raw['agentPreset'] === 'string' ? { agentPreset: raw['agentPreset'] } : {}),
  }
  const events = artifact.events as SessionEvent[]
  // The exported header omits the inherited cut; for a seeded log it is the
  // position just after the last inherited `session/end-seed` marker.
  let inherited = 0
  if (header.isSeeded) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index] as { type: string; data?: { inherited?: boolean } }
      if (event.type === 'session/end-seed' && event.data?.inherited === true) {
        inherited = index + 1
        break
      }
    }
  }
  return { header, events, inheritedEventCount: SessionLogOffset(inherited) }
}

function importNoticeText(target: SessionImportTarget, exportedId: SessionId, newId: SessionId): string {
  const { workspace } = target
  const renamed = exportedId === newId ? '' : ` Its id changed from \`${exportedId}\` to \`${newId}\`.`
  return `<system-reminder>NOTE: this session was imported from ${target.origin} into the workspace \`${workspace.title}\` (${workspace.path}) `
    + `on this host.${renamed} Files referenced earlier in the conversation lived on the original host and may not exist here; `
    + 're-read anything you need from the new workspace before relying on it.</system-reminder>'
}

/**
 * The notice text an Agent reads on its next step after a copy.
 * @param target - destination and origin of the copy.
 * @param sourceId - the id of the original Session.
 * @param shape - what the copy did to a turn in progress.
 * @returns the complete reminder text.
 */
export function sessionCopyNoticeText(
  target: Pick<SessionImportTarget, 'workspace' | 'origin' | 'crossHost'>,
  sourceId: SessionId,
  shape: { readonly openTurn: boolean; readonly truncated: boolean },
): string {
  const { workspace } = target
  const where = target.crossHost === false ? '' : ' on this host'
  const files = target.crossHost === false
    ? ' Earlier file references may need to be re-read from the new location.'
    : ' Files referenced earlier in the conversation lived on the original host and may not exist here; re-read anything you need from the new workspace before relying on it.'
  const turn = !shape.openTurn
    ? ''
    : shape.truncated
      ? ' A turn was in progress when the copy was made; that turn, and the prompt that started it, are not part of this copy.'
      : ' A turn was in progress when the copy was made; it is recorded here as interrupted, and the outcome of any tool call it had pending is unknown.'
  return `<system-reminder>NOTE: this session is a copy of session \`${sourceId}\` from ${target.origin}, made on ${new Date().toISOString()} `
    + `into the workspace \`${workspace.title}\` (${workspace.path})${where}. The original continues separately; nothing done here affects it.`
    + `${turn}${files}</system-reminder>`
}

/**
 * Store parsed Session logs — one root and its subagent descendants — as new
 * Sessions of this Host under a Workspace. Attachments must already be here.
 * @param ctx - Host context carrying persistence and the projection cache.
 * @param logs - the root log and every descendant log (any order).
 * @param target - destination Workspace, origin label, mode and options.
 * @param attachmentCount - how many attachments the caller saved, echoed in the result.
 * @returns the new root id and every stored Session.
 */
export async function storeSessionLogs(
  ctx: Context,
  logs: { readonly root: ParsedSessionLog; readonly children: readonly ParsedSessionLog[] },
  target: SessionImportTarget,
  attachmentCount = 0,
): Promise<SessionImportResult> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('session import is unavailable: missing session-persistence service')
  const { signal } = target
  const copy = target.mode === 'copy'
  signal?.throwIfAborted()

  // Shape every log first: a copy of a mid-turn source drops or closes the
  // open turn, and descendants born inside a dropped turn are left out.
  const rootShape = copy ? shapeCopiedLog(logs.root.events, { truncate: target.truncate === true }) : undefined
  const children = logs.children.filter(child => rootShape?.cutTime === undefined || child.header.createdAt < rootShape.cutTime)

  // Ids: a copy always mints; an import keeps when free here, else mints.
  // Children follow their parent's mapping.
  const idMap = new Map<SessionId, SessionId>()
  const assign = async (exported: SessionId): Promise<SessionId> => {
    const known = idMap.get(exported)
    if (known !== undefined) return known
    let chosen = exported
    if (copy || target.keepIds === false || (await persistence.stat(exported)) !== undefined) {
      chosen = brandString<SessionId>(`session-${randomUUID()}`)
    }
    idMap.set(exported, chosen)
    return chosen
  }
  const rootId = await assign(logs.root.header.id)
  for (const child of children) await assign(child.header.id)

  const store = async (log: ParsedSessionLog, isRoot: boolean): Promise<ImportedSession> => {
    signal?.throwIfAborted()
    const sessionId = idMap.get(log.header.id) as SessionId
    const parent = log.header.parentSession === undefined ? undefined : idMap.get(log.header.parentSession) ?? log.header.parentSession
    const header: SessionHeader = {
      ...log.header,
      id: sessionId,
      cwd: target.workspace.path,
      ...(parent === undefined ? {} : { parentSession: parent }),
    }
    const shape = isRoot ? rootShape : copy ? shapeCopiedLog(log.events, { truncate: target.truncate === true }) : undefined
    const events = shape === undefined ? [...log.events] : shape.events
    const nextSeq = (): SessionSeq => SessionSeq((events.at(-1)?.seq ?? -1) + 1)
    if (isRoot && copy && target.title !== undefined && target.title.trim() !== '') {
      events.push({
        type: 'session/title',
        seq: nextSeq(),
        time: Date.now(),
        data: { title: target.title.trim(), messageSeqs: [], source: { kind: 'user' } },
      })
    }
    if (isRoot && target.notify !== false) {
      const text = copy
        ? sessionCopyNoticeText(target, log.header.id, shape ?? { openTurn: false, truncated: false })
        : importNoticeText(target, log.header.id, sessionId)
      events.push({
        type: 'agent/inbox/spliced',
        seq: nextSeq(),
        time: Date.now(),
        data: {
          target: 'next-step',
          start: 0,
          inserted: [createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: copy ? SESSION_COPY_NOTICE_PLUGIN : SESSION_IMPORT_NOTICE_PLUGIN },
          })],
        },
      })
    }
    const handle = await persistence.create(header, {
      ...(signal === undefined ? {} : { signal }),
      ...(header.isSeeded ? { inheritedEventCount: log.inheritedEventCount } : {}),
    })
    try {
      if (events.length > 0) await handle.append(events)
      await handle.flush()
    } finally {
      await handle.close()
    }
    // Seed this host's projection cache (title, stats, outline…) from the
    // stored log, so the row lists with its title rather than the directory
    // name until first open. Fail-soft: the cache is a convenience.
    try {
      ctx.get('sessionProjectionCache')?.coldSnapshot(header, header.isSeeded ? log.inheritedEventCount : SessionLogOffset(0), events)
    } catch (error) {
      ctx.logger.warn(`session import: projection cache seed for "${sessionId}" failed: ${String(error)}`)
    }
    ctx.emit('session-persistence/stored', header)
    return { sessionId, exportedId: log.header.id, ...(parent === undefined ? {} : { parentSessionId: parent }) }
  }

  const imported: ImportedSession[] = []
  imported.push(await store(logs.root, true))
  for (const child of children) imported.push(await store(child, false))
  await target.workspace.attachSession(rootId)
  return { sessionId: rootId, imported, attachments: attachmentCount, truncated: rootShape?.truncated === true }
}

/**
 * Import one export ZIP into a Workspace of this Host.
 * @param ctx - Host context carrying persistence and attachments.
 * @param zip - the complete archive bytes.
 * @param target - destination Workspace, origin label, mode and id policy.
 * @returns the new root id and every stored Session.
 */
export async function importSessionZip(
  ctx: Context,
  zip: Uint8Array,
  target: SessionImportTarget,
): Promise<SessionImportResult> {
  const persistence = ctx.get('sessionPersistence')
  const attachments = ctx.get('attachments')
  if (persistence === undefined || attachments === undefined) {
    throw new Error('session import is unavailable: missing session-persistence or attachments service')
  }
  const { signal } = target
  signal?.throwIfAborted()
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(zip)
  } catch (error) {
    throw new Error(`session import: not a readable ZIP archive: ${String(error instanceof Error ? error.message : error)}`)
  }
  const rootName = Object.keys(entries).find(path => ROOT_LOG.test(path))
  if (rootName === undefined) throw new Error('session import: archive has no root session log (session.jsonl)')
  const decoder = new TextDecoder()
  const root = parseLog(decoder.decode(entries[rootName]), rootName)
  const children: ParsedSessionLog[] = []
  for (const [path, data] of Object.entries(entries)) {
    if (SUBAGENT_LOG.test(path)) children.push(parseLog(decoder.decode(data), path))
  }
  signal?.throwIfAborted()

  // Attachments first: content-addressed, so ids in the logs stay valid.
  let attachmentCount = 0
  for (const [path, data] of Object.entries(entries)) {
    signal?.throwIfAborted()
    const media = MEDIA_ENTRY.exec(path)
    if (media !== null) {
      const mediaType = MEDIA_TYPES[media[2] as string]
      if (mediaType !== undefined) {
        await attachments.saveImages([{ data, mediaType }])
        attachmentCount += 1
      }
      continue
    }
    const file = FILE_ENTRY.exec(path)
    if (file !== null) {
      await attachments.saveFile({ data, ...(file[2] === undefined ? {} : { name: file[2] }) })
      attachmentCount += 1
    }
  }

  return storeSessionLogs(ctx, { root, children }, target, attachmentCount)
}
