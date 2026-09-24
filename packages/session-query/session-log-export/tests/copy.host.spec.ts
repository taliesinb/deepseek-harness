/**
 * Copying Sessions: `shapeCopiedLog` (a turn in progress dropped whole with
 * its queued prompt cancelled, or kept and closed as interrupted),
 * `storeSessionLogs` in `copy` mode (fresh ids, title event, copy notice,
 * descendants born in a dropped turn left out) and `copyStoredSession`
 * reading a stored source and its lineage through a real JSONL backend.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { copyStoredSession } from '../src/copy.ts'
import { SESSION_COPY_NOTICE_PLUGIN, storeSessionLogs } from '../src/import.ts'
import { shapeCopiedLog } from '../src/shape.ts'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function header(id: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1000, isSeeded: false, cwd: '/ws/a', ...extra }
}

const prompt = (seq: number, time: number, text: string): SessionEvent => ({
  type: 'agent/inbox/spliced', seq: SessionSeq(seq), time,
  data: { target: 'next-turn', start: 0, inserted: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })] },
})
const claim = (seq: number, time: number): SessionEvent => ({
  type: 'agent/inbox/spliced', seq: SessionSeq(seq), time, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
})
const ev = (type: SessionEvent['type'], seq: number, time: number, data: unknown): SessionEvent => ({ type, seq: SessionSeq(seq), time, data } as SessionEvent)

/** One completed turn (seq 0–4) then a second turn in progress: prompt queued, claimed, one step open with a pending tool call. */
const MID_TURN: SessionEvent[] = [
  prompt(0, 10, 'first'),
  ev('turn/start', 1, 11, { turn: 1 }),
  claim(2, 12),
  ev('session/title', 3, 13, { title: 'Alpha work', messageSeqs: [], source: { kind: 'user' } }),
  ev('turn/end', 4, 14, { turn: 1, reason: { kind: 'completed' } }),
  prompt(5, 20, 'second'),
  ev('turn/start', 6, 21, { turn: 2 }),
  claim(7, 22),
  ev('step/start', 8, 23, { turn: 2, step: 1 }),
  {
    ...ev('assistant/message', 9, 24, {
      turn: 2, step: 1,
      message: { id: 'm1', role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'bash', input: {} }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }),
    surfaceOp: 'append',
  } as SessionEvent,
  ev('tool/call', 10, 25, { turn: 2, step: 1, callId: 'call-1', name: 'bash', input: {} }),
]

describe('shapeCopiedLog', () => {
  it('leaves a balanced log alone', () => {
    const balanced = MID_TURN.slice(0, 5)
    const shape = shapeCopiedLog(balanced, { truncate: true })
    expect(shape).toEqual({ events: balanced, truncated: false, openTurn: false })
  })

  it('truncate: cuts before the open turn and cancels the prompt still queued for it', () => {
    const shape = shapeCopiedLog(MID_TURN, { truncate: true })
    expect(shape.truncated).toBe(true)
    expect(shape.openTurn).toBe(true)
    expect(shape.cutTime).toBe(21)
    expect(shape.events.map(e => e.type)).toEqual([
      'agent/inbox/spliced', 'turn/start', 'agent/inbox/spliced', 'session/title', 'turn/end', 'agent/inbox/spliced', 'agent/inbox/spliced',
    ])
    const cancel = shape.events.at(-1) as { seq: number; time: number; data: unknown }
    expect(cancel.seq).toBe(6)
    expect(cancel.time).toBe(20)
    expect(cancel.data).toEqual({ target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
  })

  it('as-is: keeps everything and closes the open turn with interrupted closers', () => {
    const shape = shapeCopiedLog(MID_TURN)
    expect(shape.truncated).toBe(false)
    expect(shape.openTurn).toBe(true)
    expect(shape.events.slice(0, MID_TURN.length)).toEqual(MID_TURN)
    expect(shape.events.slice(MID_TURN.length).map(e => e.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
    const end = shape.events.at(-1) as { data: { reason: { kind: string } } }
    expect(end.data.reason.kind).toBe('interrupted')
  })

  it('truncate with nothing queued appends no cancellation', () => {
    const events = [...MID_TURN.slice(0, 5), ev('turn/start', 5, 20, { turn: 2 })]
    const shape = shapeCopiedLog(events, { truncate: true })
    expect(shape.events).toEqual(MID_TURN.slice(0, 5))
    expect(shape.truncated).toBe(true)
  })
})

interface Harness {
  ctx: Context
  workspace: Workspace & { attached: string[] }
}

async function mount(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-copy-'))
  dirs.push(home)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions'), compression: 'none' })
  const attached: string[] = []
  const workspace = {
    id: 'ws-b', path: '/ws/b', title: 'Beta', attached,
    attachSession: vi.fn(async (id: string) => { attached.push(id) }),
  } as unknown as Workspace & { attached: string[] }
  return { ctx, workspace }
}

async function readEvents(ctx: Context, id: string): Promise<SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(SessionId(id), 'read')
  try {
    return [...(await handle.read()).events]
  } finally {
    await handle.close()
  }
}

describe('storeSessionLogs in copy mode', () => {
  it('mints fresh ids even when free, drops descendants born in the dropped turn, records the title and the copy notice', async () => {
    const { ctx, workspace } = await mount()
    const root = { header: header('session-src'), events: MID_TURN, inheritedEventCount: SessionLogOffset(0) }
    const early = { header: header('session-early', { origin: 'subagent', parentSession: SessionId('session-src'), delegationDepth: 1, createdAt: 12 }), events: MID_TURN.slice(0, 5), inheritedEventCount: SessionLogOffset(0) }
    const late = { header: header('session-late', { origin: 'subagent', parentSession: SessionId('session-src'), delegationDepth: 1, createdAt: 23 }), events: MID_TURN.slice(0, 5), inheritedEventCount: SessionLogOffset(0) }
    const result = await storeSessionLogs(ctx, { root, children: [early, late] }, {
      workspace, origin: 'workspace `Alpha` (/ws/a)', mode: 'copy', truncate: true, title: 'Alpha work (copy)', crossHost: false,
    })
    expect(result.truncated).toBe(true)
    expect(result.sessionId).not.toBe('session-src')
    expect(result.sessionId).toMatch(/^session-[0-9a-f-]{36}$/u)
    expect(result.imported.map(entry => entry.exportedId)).toEqual(['session-src', 'session-early'])
    expect(result.imported[1]!.parentSessionId).toBe(result.sessionId)
    expect(workspace.attached).toEqual([result.sessionId])
    // The original is untouched (never stored here) and the copy sits under the destination cwd.
    expect(await ctx.sessionPersistence.stat(SessionId('session-src'))).toBeUndefined()
    expect((await ctx.sessionPersistence.stat(result.sessionId))?.header.cwd).toBe('/ws/b')
    const events = await readEvents(ctx, result.sessionId)
    expect(events.map(e => e.type)).toEqual([
      'agent/inbox/spliced', 'turn/start', 'agent/inbox/spliced', 'session/title', 'turn/end',
      'agent/inbox/spliced', 'agent/inbox/spliced', 'session/title', 'agent/inbox/spliced',
    ])
    expect((events[7] as { data: { title: string } }).data.title).toBe('Alpha work (copy)')
    const notice = events[8]!.data as { target: string; inserted: { source: { plugin?: string }; content: { text: string }[] }[] }
    expect(notice.target).toBe('next-step')
    expect(notice.inserted[0]!.source.plugin).toBe(SESSION_COPY_NOTICE_PLUGIN)
    const text = notice.inserted[0]!.content[0]!.text
    expect(text).toContain('copy of session `session-src` from workspace `Alpha` (/ws/a)')
    expect(text).toContain('`Beta` (/ws/b)')
    expect(text).toContain('not part of this copy')
    expect(text).not.toContain('original host')
  })

  it('as-is copy closes the open turn, keeps every descendant, and warns about the original host when cross-host', async () => {
    const { ctx, workspace } = await mount()
    const root = { header: header('session-src'), events: MID_TURN, inheritedEventCount: SessionLogOffset(0) }
    const late = { header: header('session-late', { origin: 'subagent', parentSession: SessionId('session-src'), delegationDepth: 1, createdAt: 23 }), events: [...MID_TURN.slice(0, 5), ev('turn/start', 5, 30, { turn: 2 })], inheritedEventCount: SessionLogOffset(0) }
    const result = await storeSessionLogs(ctx, { root, children: [late] }, { workspace, origin: 'alpha/dsh', mode: 'copy' })
    expect(result.truncated).toBe(false)
    expect(result.imported).toHaveLength(2)
    const events = await readEvents(ctx, result.sessionId)
    expect(events.slice(MID_TURN.length).map(e => e.type)).toEqual(['tool/result', 'step/end', 'turn/end', 'agent/inbox/spliced'])
    const text = (events.at(-1)!.data as { inserted: { content: { text: string }[] }[] }).inserted[0]!.content[0]!.text
    expect(text).toContain('recorded here as interrupted')
    expect(text).toContain('original host')
    // The child's own open turn is closed too.
    const child = await readEvents(ctx, result.imported[1]!.sessionId)
    expect(child.map(e => e.type).slice(-2)).toEqual(['turn/start', 'turn/end'])
  })
})

describe('copyStoredSession', () => {
  it('reads the stored source and its lineage, flushing live ones, and stores the copies', async () => {
    const { ctx, workspace } = await mount()
    const src = await ctx.sessionPersistence.create(header('session-src'))
    await src.append([...MID_TURN.slice(0, 5)])
    await src.close()
    const child = await ctx.sessionPersistence.create(header('session-child', { origin: 'subagent', parentSession: SessionId('session-src'), delegationDepth: 1 }))
    await child.append([...MID_TURN.slice(0, 5)])
    await child.close()
    const flush = vi.fn(async () => {})
    const sessions = { get: (id: string) => (id === 'session-src' ? { id } : undefined), flush } as never
    const sessionQuery = {
      traceSession: vi.fn(async () => ({
        ancestors: [],
        descendants: [{ session: { header: header('session-child') }, descendants: [] }],
      })),
    } as never
    const result = await copyStoredSession(ctx, { sessionQuery, sessionPersistence: ctx.sessionPersistence, sessions }, SessionId('session-src'), {
      workspace, origin: 'workspace `Alpha` (/ws/a)', title: 'Copy',
    })
    expect(result).toBeDefined()
    expect(flush).toHaveBeenCalledTimes(1)
    expect(result!.imported.map(entry => entry.exportedId)).toEqual(['session-src', 'session-child'])
    expect(result!.truncated).toBe(false)
    const events = await readEvents(ctx, result!.sessionId)
    expect(events.map(e => e.type).slice(-2)).toEqual(['session/title', 'agent/inbox/spliced'])
    // The source keeps its log.
    expect((await readEvents(ctx, 'session-src')).map(e => e.type)).toEqual(MID_TURN.slice(0, 5).map(e => e.type))
    expect(await copyStoredSession(ctx, { sessionQuery, sessionPersistence: ctx.sessionPersistence, sessions }, SessionId('nope'), { workspace, origin: 'x' })).toBeUndefined()
  })
})
