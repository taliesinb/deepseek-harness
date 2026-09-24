/**
 * SessionCopyController over a real JSONL backend: a cold copy into another
 * (or the same) Workspace with a fresh id, title and copy notice, the source
 * untouched; descendants copied along; a running source refused until the
 * caller decides `truncate`, then dropped whole or closed as interrupted; an
 * idle resident Agent asks nothing.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SESSION_COPY_NOTICE_PLUGIN } from '@deepseek-ai/dsh-session-log-export'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionCopyController } from '../src/copy.ts'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface FakeWorkspace {
  id: string
  path: string
  title: string
  sessionIds: string[]
  attachSession: (id: string) => Promise<void>
  detachSession: (id: string) => Promise<void>
}

function fakeWorkspace(id: string, path: string, title: string): FakeWorkspace {
  const workspace: FakeWorkspace = {
    id, path, title, sessionIds: [],
    attachSession: async (sessionId) => { if (!workspace.sessionIds.includes(sessionId)) workspace.sessionIds.push(sessionId) },
    detachSession: async (sessionId) => { workspace.sessionIds = workspace.sessionIds.filter(candidate => candidate !== sessionId) },
  }
  return workspace
}

async function harness() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-copy-'))
  dirs.push(home)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions'), compression: 'none' })
  const a = fakeWorkspace('ws-a', '/ws/a', 'Alpha')
  const b = fakeWorkspace('ws-b', '/ws/b', 'Beta')
  const workspaces = [a, b]
  ctx.provide('workspaceRegistry', {
    get: (id: string) => workspaces.find(w => w.id === id),
    resolveByPath: async (path: string) => workspaces.find(w => w.path === path),
    create: async (path: string, title?: string) => {
      const created = fakeWorkspace(`ws-${workspaces.length}`, path, title ?? path)
      workspaces.push(created)
      return created
    },
    forgetSessionHeader: vi.fn(),
  } as never)
  const live = new Map<string, { id: string; status: string; owner?: string }>()
  ctx.provide('agents', {
    get: (id: string) => live.get(id),
    list: () => [...live.values()],
    isOwnedBy: (id: string, owner: { id: string }) => live.get(id)?.owner === owner.id,
  } as never)
  const flush = vi.fn(async () => {})
  ctx.provide('sessions', { get: (id: string) => live.get(id), flush } as never)
  // Lineage: every stored subagent header naming the parent is a direct descendant.
  ctx.provide('sessionQuery', {
    traceSession: async (id: string) => {
      const snapshots = await ctx.sessionPersistence.list()
      const descendants = snapshots
        .filter(snapshot => snapshot.header.parentSession === id && snapshot.header.origin === 'subagent')
        .map(snapshot => ({ session: { header: snapshot.header }, descendants: [] }))
      return { ancestors: [], descendants }
    },
  } as never)
  const controller = new SessionCopyController(ctx)
  return { ctx, a, b, live, flush, controller }
}

function header(id: string, cwd: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, isSeeded: false, cwd, ...extra }
}

async function store(ctx: Context, meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
  const handle = await ctx.sessionPersistence.create(meta)
  if (events.length > 0) await handle.append([...events])
  await handle.close()
}

async function readEvents(ctx: Context, id: string): Promise<SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(SessionId(id), 'read')
  try {
    return [...(await handle.read()).events]
  } finally {
    await handle.close()
  }
}

const DONE: SessionEvent[] = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'session/title', seq: SessionSeq(1), time: 1, data: { title: 'Work', messageSeqs: [], source: { kind: 'user' } } },
  { type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]
const RUNNING: SessionEvent[] = [
  ...DONE,
  {
    type: 'agent/inbox/spliced', seq: SessionSeq(3), time: 3,
    data: { target: 'next-turn', start: 0, inserted: [createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })] },
  },
  { type: 'turn/start', seq: SessionSeq(4), time: 4, data: { turn: 2 } },
  { type: 'agent/inbox/spliced', seq: SessionSeq(5), time: 5, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
  { type: 'step/start', seq: SessionSeq(6), time: 6, data: { turn: 2, step: 1 } },
]

describe('SessionCopyController', () => {
  it('copies a cold session with a fresh id, title and notice; the source is untouched; the same workspace is allowed', async () => {
    const { ctx, a, b, controller } = await harness()
    await store(ctx, header('s1', a.path), DONE)
    a.sessionIds.push('s1')
    const result = await controller.copy({ sessionId: SessionId('s1'), destination: { workspaceId: b.id as never }, title: 'Work (copy)' })
    expect(result.sourceSessionId).toBe('s1')
    expect(result.workspaceId).toBe('ws-b')
    expect(result.truncated).toBe(false)
    expect(result.sessionId).toMatch(/^session-[0-9a-f-]{36}$/u)
    expect(result.copied).toEqual([result.sessionId])
    expect(a.sessionIds).toEqual(['s1'])
    expect(b.sessionIds).toEqual([result.sessionId])
    expect((await ctx.sessionPersistence.stat(SessionId('s1')))?.header.cwd).toBe('/ws/a')
    expect((await ctx.sessionPersistence.stat(result.sessionId))?.header.cwd).toBe('/ws/b')
    expect(await readEvents(ctx, 's1')).toHaveLength(DONE.length)
    const events = await readEvents(ctx, result.sessionId)
    expect(events.map(e => e.type)).toEqual(['turn/start', 'session/title', 'turn/end', 'session/title', 'agent/inbox/spliced'])
    expect((events[3] as { data: { title: string } }).data.title).toBe('Work (copy)')
    const notice = events[4]!.data as { inserted: { source: { plugin?: string }; content: { text: string }[] }[] }
    expect(notice.inserted[0]!.source.plugin).toBe(SESSION_COPY_NOTICE_PLUGIN)
    expect(notice.inserted[0]!.content[0]!.text).toContain('copy of session `s1` from workspace `Alpha` (/ws/a)')
    // Duplicate into the source's own workspace.
    const again = await controller.copy({ sessionId: SessionId('s1'), destination: { workspaceId: a.id as never }, notify: false })
    expect(a.sessionIds).toEqual(['s1', again.sessionId])
    expect((await readEvents(ctx, again.sessionId)).map(e => e.type)).toEqual(DONE.map(e => e.type))
  })

  it('copies subagent descendants along, re-parented to the new root; an idle resident agent asks nothing and is flushed', async () => {
    const { ctx, a, b, live, flush, controller } = await harness()
    await store(ctx, header('p', a.path), DONE)
    await store(ctx, header('c', a.path, { origin: 'subagent', parentSession: SessionId('p'), delegationDepth: 1 }), DONE)
    live.set('p', { id: 'p', status: 'idle' })
    const result = await controller.copy({ sessionId: SessionId('p'), destination: { workspaceId: b.id as never } })
    expect(result.copied).toHaveLength(2)
    expect(flush).toHaveBeenCalledTimes(1)
    const child = await ctx.sessionPersistence.stat(result.copied[1]!)
    expect(child?.header.parentSession).toBe(result.sessionId)
    expect(child?.header.cwd).toBe('/ws/b')
    expect(b.sessionIds).toEqual([result.sessionId])
  })

  it('refuses a running source until truncate is decided, then drops the turn or closes it as interrupted', async () => {
    const { ctx, a, b, live, controller } = await harness()
    await store(ctx, header('r', a.path), RUNNING)
    live.set('r', { id: 'r', status: 'running' })
    await expect(controller.copy({ sessionId: SessionId('r'), destination: { workspaceId: b.id as never } }))
      .rejects.toMatchObject({ code: 'session/copy-live', details: { sessionId: 'r', blockers: [{ kind: 'turn' }] } })
    expect(b.sessionIds).toEqual([])

    const dropped = await controller.copy({ sessionId: SessionId('r'), destination: { workspaceId: b.id as never }, truncate: true })
    expect(dropped.truncated).toBe(true)
    const droppedEvents = await readEvents(ctx, dropped.sessionId)
    expect(droppedEvents.map(e => e.type)).toEqual([
      'turn/start', 'session/title', 'turn/end', 'agent/inbox/spliced', 'agent/inbox/spliced', 'agent/inbox/spliced',
    ])
    expect((droppedEvents[4] as { data: { outcome?: string; removedCount?: number } }).data).toMatchObject({ outcome: 'canceled', removedCount: 1 })
    expect((droppedEvents[5]!.data as { inserted: { content: { text: string }[] }[] }).inserted[0]!.content[0]!.text).toContain('not part of this copy')

    const kept = await controller.copy({ sessionId: SessionId('r'), destination: { workspaceId: b.id as never }, truncate: false })
    expect(kept.truncated).toBe(false)
    const keptEvents = await readEvents(ctx, kept.sessionId)
    expect(keptEvents.map(e => e.type).slice(RUNNING.length)).toEqual(['step/end', 'turn/end', 'agent/inbox/spliced'])
    expect((keptEvents[RUNNING.length + 1] as { data: { reason: { kind: string } } }).data.reason.kind).toBe('interrupted')
    // The running source's log is exactly what it was.
    expect((await readEvents(ctx, 'r')).map(e => e.type)).toEqual(RUNNING.map(e => e.type))
  })

  it('registers a directory destination and reports a missing source', async () => {
    const { ctx, a, controller } = await harness()
    await store(ctx, header('s3', a.path), DONE)
    const result = await controller.copy({ sessionId: SessionId('s3'), destination: { path: '/ws/new', title: 'Fresh' } })
    expect(result.workspaceId).toBe('ws-2')
    expect((await ctx.sessionPersistence.stat(result.sessionId))?.header.cwd).toBe('/ws/new')
    await expect(controller.copy({ sessionId: SessionId('nope'), destination: { workspaceId: a.id as never } }))
      .rejects.toMatchObject({ code: 'session/copy-missing' })
  })
})
