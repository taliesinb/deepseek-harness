/**
 * `relocate()`: moving a cold stored session to another working directory —
 * the storage half of "move session to workspace". The header's cwd decides
 * the project directory, so the artifact is republished under the new one and
 * the old directory leaves the root (into a sibling backup directory), with
 * the requested events appended after the stored tail. Live sessions (an open
 * write handle in this process, or a lock held by another instance) refuse.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistence, SessionRelocateAppend } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '../src/index.ts'
import { sessionDir } from '../src/format.ts'

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function meta(id: string, cwd = '/work/old'): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1_000, cwd, isSeeded: false }
}

async function freshHome(): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-jsonl-relocate-'))
  dirs.push(home)
  return { home, root: join(home, 'sessions') }
}

async function mount(root: string, compression: 'none' | 'zstd' = 'none'): Promise<SessionPersistence> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  return ctx.sessionPersistence
}

const EVENTS = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
] as const

const NOTICE = {
  type: 'agent/inbox/spliced',
  data: {
    target: 'next-step',
    start: 0,
    inserted: [{
      id: 'msg-notice', role: 'user',
      content: [{ type: 'text', text: '<system-reminder>moved</system-reminder>' }],
      source: { kind: 'plugin', plugin: 'session-move' },
    }],
  },
} as unknown as SessionRelocateAppend

describe('relocate', () => {
  it.each(['none', 'zstd'] as const)('republishes under the new cwd, appends events, and backs up the old directory (%s)', async (compression) => {
    const { home, root } = await freshHome()
    const backend = await mount(root, compression)
    const handle = await backend.create(meta('moved'))
    await handle.append([...EVENTS])
    await handle.close()

    const before = await backend.stat(SessionId('moved'))
    expect(before?.header.cwd).toBe('/work/old')

    const result = await backend.relocate!({ id: SessionId('moved'), cwd: '/work/new', append: [NOTICE] })
    expect(result.moved).toBe(true)
    expect(result.header).toMatchObject({ id: 'moved', cwd: '/work/new', createdAt: 1_000 })
    expect(result.backupPath).toBeDefined()
    expect(result.backupPath!.startsWith(join(home, 'session-move-backups'))).toBe(true)

    // Old location gone from the root; the backup retains the artifact.
    expect(existsSync(sessionDir(root, '/work/old', SessionId('moved')))).toBe(false)
    expect((await readdir(result.backupPath!)).length).toBeGreaterThan(0)

    // The new artifact is the whole log plus the notice, re-read cold with the new header.
    const reopened = await backend.open(SessionId('moved'), 'read')
    expect(reopened.header.cwd).toBe('/work/new')
    const read = await reopened.read()
    expect(read.events.map(event => [event.type, event.seq])).toEqual([
      ['turn/start', 0], ['turn/end', 1], ['agent/inbox/spliced', 2],
    ])
    expect(read.events[2]!.data).toMatchObject({ target: 'next-step', inserted: [{ id: 'msg-notice' }] })
    await reopened.close()

    // The list sees exactly one session, at the new cwd; a fresh instance agrees.
    const listed = await backend.list()
    expect(listed.map(snapshot => [snapshot.header.id, snapshot.header.cwd])).toEqual([['moved', '/work/new']])
    const fresh = await mount(root, compression)
    expect((await fresh.stat(SessionId('moved')))?.header.cwd).toBe('/work/new')

    // A write open afterwards works at the new location (no stale lock, no duplicate id).
    const writer = await fresh.open(SessionId('moved'), 'write')
    await writer.append([{ type: 'turn/start', seq: SessionSeq(3), time: 4, data: { turn: 2 } }])
    await writer.close()
  })

  it('is a no-op for the same cwd and refuses unknown ids', async () => {
    const { root } = await freshHome()
    const backend = await mount(root)
    const handle = await backend.create(meta('same'))
    await handle.append([...EVENTS])
    await handle.close()
    const result = await backend.relocate!({ id: SessionId('same'), cwd: '/work/old/' })
    expect(result.moved).toBe(false)
    expect(existsSync(sessionDir(root, '/work/old', SessionId('same')))).toBe(true)
    await expect(backend.relocate!({ id: SessionId('missing'), cwd: '/x' })).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
  })

  it('refuses a session that is open for writing, here or in another instance', async () => {
    const { root } = await freshHome()
    const backend = await mount(root)
    const holder = await backend.create(meta('live'))
    await holder.append([...EVENTS])
    // In-process owner.
    await expect(backend.relocate!({ id: SessionId('live'), cwd: '/work/new' })).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    // Another instance (kernel lock).
    const other = await mount(root)
    await expect(other.relocate!({ id: SessionId('live'), cwd: '/work/new' })).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await holder.close()
    // Cold now: both succeed in turn (second is a no-op).
    expect((await other.relocate!({ id: SessionId('live'), cwd: '/work/new' })).moved).toBe(true)
    expect((await backend.relocate!({ id: SessionId('live'), cwd: '/work/new' })).moved).toBe(false)
    expect(existsSync(sessionDir(root, '/work/old', SessionId('live')))).toBe(false)
  })
})
