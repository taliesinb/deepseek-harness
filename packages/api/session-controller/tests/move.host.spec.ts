/**
 * SessionMoveController over a real JSONL backend: the relocation notice,
 * its replacement when several moves happen before the Agent runs again (the
 * origin carrying forward), registry re-accounting, live refusal and
 * stop-and-move, and the moveMany skip report.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { SESSION_MOVE_NOTICE_PLUGIN, SessionMoveController, sessionMoveNoticeText } from '../src/move.ts'

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
  const home = await mkdtemp(join(tmpdir(), 'dsh-move-'))
  dirs.push(home)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions'), compression: 'none' })
  const a = fakeWorkspace('ws-a', '/ws/a', 'Alpha')
  const b = fakeWorkspace('ws-b', '/ws/b', 'Beta')
  const c = fakeWorkspace('ws-c', '/ws/c', 'Gamma')
  const workspaces = [a, b, c]
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
  const live = new Map<string, unknown>()
  ctx.provide('agents', { get: (id: string) => live.get(id) } as never)
  ctx.provide('sessions', { get: (id: string) => live.get(id) } as never)
  const emitted: unknown[] = []
  const originalEmit = ctx.emit.bind(ctx)
  ctx.emit = ((...args: unknown[]) => { emitted.push(args); return (originalEmit as (...a: unknown[]) => unknown)(...args) }) as never
  const retire = vi.fn(async (id: string) => { live.delete(id); return true })
  const list = { summarizeCold: (header: SessionHeader) => ({ sessionId: header.id, cwd: header.cwd }) }
  const controller = new SessionMoveController(ctx, { retire } as never, list as never)
  return { ctx, a, b, c, live, retire, controller, emitted }
}

function header(id: string, cwd: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, isSeeded: false, cwd, ...extra }
}

async function store(ctx: Context, meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
  const handle = await ctx.sessionPersistence.create(meta)
  if (events.length > 0) await handle.append([...events])
  await handle.close()
}

async function pendingNextStep(ctx: Context, id: string): Promise<{ plugin?: string; text: string }[]> {
  const handle = await ctx.sessionPersistence.open(SessionId(id), 'read')
  try {
    const { events } = await handle.read()
    let pending: { source: { plugin?: string }; content: { text: string }[] }[] = []
    for (const event of events) {
      if (event.type !== 'agent/inbox/spliced') continue
      const splice = event.data as { target: string; start: number; removedCount?: number; inserted: typeof pending }
      if (splice.target !== 'next-step') continue
      pending = pending.toSpliced(splice.start, splice.removedCount ?? 0, ...splice.inserted)
    }
    return pending.map(message => ({ ...(message.source.plugin === undefined ? {} : { plugin: message.source.plugin }), text: message.content[0]?.text ?? '' }))
  } finally {
    await handle.close()
  }
}

const EVENTS: SessionEvent[] = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'sandbox/mode', seq: SessionSeq(1), time: 1, data: { mode: 'workspace-write' } } as SessionEvent,
  { type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]

describe('SessionMoveController', () => {
  it('moves a cold session, re-accounts it, notifies with the permission clause, and emits the refreshed summary', async () => {
    const { ctx, a, b, controller, emitted } = await harness()
    await store(ctx, header('s1', a.path), EVENTS)
    a.sessionIds.push('s1')
    const result = await controller.move({ sessionId: SessionId('s1'), destination: { workspaceId: b.id as never } })
    expect(result).toEqual({ sessionId: 's1', workspaceId: 'ws-b', moved: ['s1'] })
    expect(a.sessionIds).toEqual([])
    expect(b.sessionIds).toEqual(['s1'])
    expect((await ctx.sessionPersistence.stat(SessionId('s1')))?.header.cwd).toBe('/ws/b')
    const pending = await pendingNextStep(ctx, 's1')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.plugin).toBe(SESSION_MOVE_NOTICE_PLUGIN)
    expect(pending[0]!.text).toBe(sessionMoveNoticeText({ title: 'Alpha', path: '/ws/a' }, { title: 'Beta', path: '/ws/b' }, 'workspace-write'))
    expect(pending[0]!.text).toContain('`Workspace Write`')
    expect(emitted.some(args => Array.isArray(args) && args[0] === 'api-session/added')).toBe(true)
  })

  it('replaces the pending notice on a second move before the agent runs, keeping the original origin', async () => {
    const { ctx, a, b, c, controller } = await harness()
    await store(ctx, header('s2', a.path), EVENTS)
    a.sessionIds.push('s2')
    await controller.move({ sessionId: SessionId('s2'), destination: { workspaceId: b.id as never } })
    await controller.move({ sessionId: SessionId('s2'), destination: { workspaceId: c.id as never } })
    const pending = await pendingNextStep(ctx, 's2')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.text).toContain('from `Alpha` (/ws/a) to `Gamma` (/ws/c)')
    expect(c.sessionIds).toEqual(['s2'])
    expect(b.sessionIds).toEqual([])
  })

  it('refuses a live session, then stop-and-moves it; moveMany reports skips and moves children', async () => {
    const { ctx, a, b, live, retire, controller } = await harness()
    await store(ctx, header('live', a.path), EVENTS)
    await store(ctx, header('cold', a.path), EVENTS)
    await store(ctx, header('child', a.path, { origin: 'subagent', parentSession: SessionId('cold'), delegationDepth: 1 }), EVENTS)
    a.sessionIds.push('live', 'cold')
    live.set('live', { id: 'live' })
    await expect(controller.move({ sessionId: SessionId('live'), destination: { workspaceId: b.id as never } }))
      .rejects.toMatchObject({ code: 'session/move-live' })
    expect(retire).not.toHaveBeenCalled()

    const batch = await controller.moveMany({ sessionIds: [SessionId('live'), SessionId('cold')], destination: { workspaceId: b.id as never } })
    expect(batch.moved).toEqual(['child', 'cold'])
    expect(batch.skipped).toEqual([expect.objectContaining({ sessionId: 'live', reason: 'live' })])
    expect(b.sessionIds).toEqual(['cold'])
    expect((await ctx.sessionPersistence.stat(SessionId('child')))?.header.cwd).toBe('/ws/b')
    // The child has no registry account and gets no separate attach.
    expect(b.sessionIds).not.toContain('child')

    const moved = await controller.move({ sessionId: SessionId('live'), destination: { workspaceId: b.id as never }, stopLive: true })
    expect(retire).toHaveBeenCalledWith('live')
    expect(moved.moved).toEqual(['live'])
    expect(b.sessionIds).toEqual(['cold', 'live'])
  })

  it('registers a directory destination and reports same-workspace / missing', async () => {
    const { ctx, a, controller } = await harness()
    await store(ctx, header('s3', a.path), EVENTS)
    a.sessionIds.push('s3')
    const result = await controller.move({ sessionId: SessionId('s3'), destination: { path: '/ws/new', title: 'Fresh' } })
    expect(result.workspaceId).toBe('ws-3')
    expect((await ctx.sessionPersistence.stat(SessionId('s3')))?.header.cwd).toBe('/ws/new')
    await expect(controller.move({ sessionId: SessionId('s3'), destination: { workspaceId: result.workspaceId } }))
      .rejects.toMatchObject({ code: 'session/move-same-workspace' })
    await expect(controller.move({ sessionId: SessionId('nope'), destination: { workspaceId: a.id as never } }))
      .rejects.toBeInstanceOf(RemoteError)
  })
})
