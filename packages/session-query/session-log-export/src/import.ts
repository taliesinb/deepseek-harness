/**
 * Import one Session-log ZIP — the archive `session.export` produces (root log,
 * `subagents/<id>/session.jsonl` descendants, `media/` and `files/`
 * attachments) — as new stored Sessions of this Host under one Workspace.
 * This is the receiving half of a cross-host move.
 *
 * Attachments are content-addressed (`sha256:` ids), so saving the bytes here
 * reproduces the ids the logs reference; no event rewriting is needed for
 * them. Each log's header gets the destination cwd; an id that already exists
 * here is replaced by a fresh one (descendants are re-parented to match). The
 * root receives one `agent/inbox/spliced` notice for its next step naming the
 * origin, so the Agent knows earlier file references may not resolve.
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

/** Message source recorded on the import notice. */
export const SESSION_IMPORT_NOTICE_PLUGIN = 'session-import'

/** What the caller decides about the destination. */
export interface SessionImportTarget {
  readonly workspace: Workspace
  /** Where the bundle came from, for the Agent's notice (`alpha.tailnet/dsh`, a path…). */
  readonly origin: string
  /** Keep the exported ids when free here (default true); false always re-ids. */
  readonly keepIds?: boolean
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

/** Outcome of one import. */
export interface SessionImportResult {
  readonly sessionId: SessionId
  readonly imported: readonly ImportedSession[]
  readonly attachments: number
}

/** Root/subagent log entries, any format generation name (`session.jsonl`, `session.v3.jsonl`). */
const ROOT_LOG = /^session(?:\.v\d+)?\.jsonl$/u
const SUBAGENT_LOG = /^subagents\/([^/]+)\/session(?:\.v\d+)?\.jsonl$/u
const MEDIA_ENTRY = /^media\/([^/]+)\.(png|jpg|webp|gif)$/u
const FILE_ENTRY = /^files\/[0-9a-f]{2}\/([0-9a-f]{64})\/(.+)$/u
const MEDIA_TYPES: Record<string, ImageMediaType> = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
}

interface ParsedLog {
  header: SessionHeader
  events: SessionEvent[]
  inheritedEventCount: SessionLogOffset
}

/** Parse one exported JSONL text through the current format's strict restore. */
function parseLog(text: string, label: string): ParsedLog {
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

function noticeText(origin: string, workspace: Workspace, exportedId: SessionId, newId: SessionId): string {
  const renamed = exportedId === newId ? '' : ` Its id changed from \`${exportedId}\` to \`${newId}\`.`
  return `<system-reminder>NOTE: this session was imported from ${origin} into the workspace \`${workspace.title}\` (${workspace.path}) `
    + `on this host.${renamed} Files referenced earlier in the conversation lived on the original host and may not exist here; `
    + 're-read anything you need from the new workspace before relying on it.</system-reminder>'
}

/**
 * Import one export ZIP into a Workspace of this Host.
 * @param ctx - Host context carrying persistence and attachments.
 * @param zip - the complete archive bytes.
 * @param target - destination Workspace, origin label, id policy.
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
  const children: ParsedLog[] = []
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

  // Ids: keep when free here, else mint; children follow their parent's mapping.
  const idMap = new Map<SessionId, SessionId>()
  const assign = async (exported: SessionId): Promise<SessionId> => {
    const known = idMap.get(exported)
    if (known !== undefined) return known
    let chosen = exported
    if (target.keepIds === false || (await persistence.stat(exported)) !== undefined) {
      chosen = brandString<SessionId>(`session-${randomUUID()}`)
    }
    idMap.set(exported, chosen)
    return chosen
  }
  const rootId = await assign(root.header.id)
  for (const child of children) await assign(child.header.id)

  const store = async (log: ParsedLog, isRoot: boolean): Promise<ImportedSession> => {
    signal?.throwIfAborted()
    const sessionId = idMap.get(log.header.id) as SessionId
    const parent = log.header.parentSession === undefined ? undefined : idMap.get(log.header.parentSession) ?? log.header.parentSession
    const header: SessionHeader = {
      ...log.header,
      id: sessionId,
      cwd: target.workspace.path,
      ...(parent === undefined ? {} : { parentSession: parent }),
    }
    const events = [...log.events]
    if (isRoot && target.notify !== false) {
      const lastSeq = events.at(-1)?.seq ?? -1
      events.push({
        type: 'agent/inbox/spliced',
        seq: SessionSeq(lastSeq + 1),
        time: Date.now(),
        data: {
          target: 'next-step',
          start: 0,
          inserted: [createUserMessage({
            content: [{ type: 'text', text: noticeText(target.origin, target.workspace, log.header.id, sessionId) }],
            source: { kind: 'plugin', plugin: SESSION_IMPORT_NOTICE_PLUGIN },
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
    // imported log, so the row lists with its title rather than the directory
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
  imported.push(await store(root, true))
  for (const child of children) imported.push(await store(child, false))
  await target.workspace.attachSession(rootId)
  return { sessionId: rootId, imported, attachments: attachmentCount }
}
