/**
 * `importSessionZip`: the receiving half of a cross-host move. A ZIP shaped
 * like `session.export`'s (root log, `subagents/<id>/session.jsonl`, `media/`,
 * `files/`) becomes stored Sessions of the destination Workspace through a
 * real JSONL backend; attachments are saved through the store (content
 * addressing keeps the logs' references valid); ids are kept when free and
 * minted on collision, children following their parent; the root gets the
 * import notice.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { serializeSessionLog } from '../src/archive.ts'
import { importSessionZip, SESSION_IMPORT_NOTICE_PLUGIN } from '../src/import.ts'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function header(id: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1000, isSeeded: false, cwd: '/remote/proj', ...extra }
}
const turnStart: SessionEvent = { type: 'turn/start', seq: SessionSeq(0), time: 2000, data: { turn: 1 } }
const turnEnd: SessionEvent = { type: 'turn/end', seq: SessionSeq(1), time: 2001, data: { turn: 1, reason: { kind: 'completed' } } }

interface Harness {
  ctx: Context
  root: string
  saved: { images: number; files: string[] }
  workspace: Workspace & { attached: string[] }
}

async function mount(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-import-'))
  dirs.push(home)
  const root = join(home, 'sessions')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const saved = { images: 0, files: [] as string[] }
  ctx.provide('attachments', {
    saveImages: vi.fn(async (inputs: readonly { data: Uint8Array }[]) => { saved.images += inputs.length; return [] }),
    saveFile: vi.fn(async (input: { name?: string }) => { saved.files.push(input.name ?? '?'); return {} }),
  } as never)
  const attached: string[] = []
  const workspace = {
    id: 'ws-1', path: '/local/dest', title: 'dest', attached,
    attachSession: vi.fn(async (id: string) => { attached.push(id) }),
  } as unknown as Workspace & { attached: string[] }
  return { ctx, root, saved, workspace }
}

function bundle(entries: Record<string, string | Uint8Array>): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  for (const [path, value] of Object.entries(entries)) files[path] = typeof value === 'string' ? strToU8(value) : value
  return zipSync(files)
}

describe('importSessionZip', () => {
  it('stores root and subagent logs under the destination cwd, saves attachments, notifies, attaches the root', async () => {
    const { ctx, root, saved, workspace } = await mount()
    const rootId = SessionId('session-root')
    const childId = SessionId('session-child')
    const zip = bundle({
      'session.jsonl': serializeSessionLog(header('session-root'), [turnStart, turnEnd]),
      'subagents/session-child/session.jsonl': serializeSessionLog(
        header('session-child', { parentSession: rootId, origin: 'subagent', delegationDepth: 1 }),
        [turnStart],
      ),
      'media/sha256-abc.png': new Uint8Array([1, 2, 3, 4]),
      'files/ab/abababababababababababababababababababababababababababababababab/notes.txt': strToU8('hello'),
    })
    const result = await importSessionZip(ctx, zip, { workspace, origin: 'alpha/dsh' })
    expect(result.sessionId).toBe(rootId)
    expect(result.attachments).toBe(2)
    expect(saved).toEqual({ images: 1, files: ['notes.txt'] })
    expect(result.imported).toEqual([
      { sessionId: rootId, exportedId: rootId },
      { sessionId: childId, exportedId: childId, parentSessionId: rootId },
    ])
    expect(workspace.attached).toEqual([rootId])

    // A fresh backend over the same root sees both, at the destination cwd, root notice last.
    const fresh = new Context()
    contexts.push(fresh)
    await fresh.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const listed = (await fresh.sessionPersistence.list()).map(s => [s.header.id, s.header.cwd, s.header.parentSession]).sort()
    expect(listed).toEqual([[childId, '/local/dest', rootId], [rootId, '/local/dest', undefined]])
    const handle = await fresh.sessionPersistence.open(rootId, 'read')
    const { events } = await handle.read()
    await handle.close()
    expect(events.map(e => e.type)).toEqual(['turn/start', 'turn/end', 'agent/inbox/spliced'])
    const notice = events[2]!.data as { target: string; inserted: { source: { plugin?: string }; content: { text: string }[] }[] }
    expect(notice.target).toBe('next-step')
    expect(notice.inserted[0]!.source.plugin).toBe(SESSION_IMPORT_NOTICE_PLUGIN)
    expect(notice.inserted[0]!.content[0]!.text).toContain('imported from alpha/dsh')
    expect(notice.inserted[0]!.content[0]!.text).toContain('`dest` (/local/dest)')
  })

  it('mints new ids on collision and re-parents children; notify=false appends nothing', async () => {
    const { ctx, workspace } = await mount()
    // Occupy the exported root id locally first.
    const existing = await ctx.sessionPersistence.create(header('session-root', { cwd: '/elsewhere' }))
    await existing.append([turnStart])
    await existing.close()
    const zip = bundle({
      'session.jsonl': serializeSessionLog(header('session-root'), [turnStart]),
      'subagents/session-child/session.jsonl': serializeSessionLog(
        header('session-child', { parentSession: SessionId('session-root'), origin: 'subagent', delegationDepth: 1 }),
        [turnStart],
      ),
    })
    const result = await importSessionZip(ctx, zip, { workspace, origin: 'x', notify: false })
    expect(result.sessionId).not.toBe('session-root')
    expect(result.sessionId).toMatch(/^session-[0-9a-f-]{36}$/u)
    const child = result.imported[1]!
    expect(child.sessionId).toBe('session-child')
    expect(child.parentSessionId).toBe(result.sessionId)
    const stored = await ctx.sessionPersistence.stat(child.sessionId)
    expect(stored?.header.parentSession).toBe(result.sessionId)
    const handle = await ctx.sessionPersistence.open(result.sessionId, 'read')
    expect((await handle.read()).events.map(e => e.type)).toEqual(['turn/start'])
    await handle.close()
    // The pre-existing local session is untouched.
    expect((await ctx.sessionPersistence.stat(SessionId('session-root')))?.header.cwd).toBe('/elsewhere')
  })

  it('refuses archives without a root log or with a corrupt log', async () => {
    const { ctx, workspace } = await mount()
    await expect(importSessionZip(ctx, bundle({ 'other.txt': 'x' }), { workspace, origin: 'x' })).rejects.toThrow(/no root session log/u)
    await expect(importSessionZip(ctx, bundle({ 'session.jsonl': '{"type":"nope"}\n' }), { workspace, origin: 'x' })).rejects.toThrow(/not a session header/u)
    await expect(importSessionZip(ctx, new Uint8Array([1, 2, 3]), { workspace, origin: 'x' })).rejects.toThrow(/ZIP/u)
  })
})
