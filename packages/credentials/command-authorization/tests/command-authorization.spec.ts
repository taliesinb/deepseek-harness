import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import CommandsService from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CredentialProvider, credentialKey } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { Config as PiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import { apply } from '../src/index.ts'

class MemoryCredentials extends CredentialProvider {
  private readonly records = new Map<CredentialKey, CredentialRecord>()
  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> { return Promise.resolve(undefined) }
  override describe(_ref: CredentialRef): Promise<CredentialInfo> { return Promise.resolve({ configured: false, writable: true }) }
  override set(_ref: CredentialRef, _value: string): Promise<void> { return Promise.resolve() }
  override unset(_ref: CredentialRef): Promise<void> { return Promise.resolve() }
  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> { return Promise.resolve(this.records.get(key)) }
  override describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.records.get(key)
    return Promise.resolve(record === undefined
      ? { configured: false, writable: true }
      : { configured: true, writable: true, kind: record.kind })
  }
  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([...this.records].map(([key, record]) => ({ key, kind: record.kind })))
  }
  override async modifyRecord(
    key: CredentialKey,
    updater: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await updater(this.records.get(key))
    if (next === undefined) return this.records.get(key)
    this.records.set(key, next)
    this.ctx.emit('credentials/record-updated', key)
    return next
  }
  override deleteRecord(key: CredentialKey): Promise<void> {
    if (this.records.delete(key)) this.ctx.emit('credentials/record-updated', key)
    return Promise.resolve()
  }
}

const KEY = credentialKey('llm-pi-ai', 'anthropic')
const OTHER_KEY = credentialKey('llm-pi-ai', 'github-copilot')

async function harness(initial: object = {}, stored?: object): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(CommandsService)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-command-authorization-'))

  if (stored !== undefined) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'settings.yaml'), JSON.stringify(stored), 'utf8')
  }
  await ctx.plugin(FileSettingsProvider, {
    path: join(dir, 'settings.yaml'),
    dshHome: dir,
    watch: false,
    debounceMs: 100,
  })
  let current: () => object = () => initial
  ctx.settings.installSection(ctx, 'llm-pi-ai', PiConfig, initial, {
    setSource: (source) => { current = source },
    onChange: () => { current() },
  })
  await ctx.plugin({
    name: 'command-authorization-test',
    inject: ['authorization', 'commands', 'credentials', 'settings'],
    apply,
  })
  return ctx
}

async function execute(ctx: Context, input: string) {
  const result = await ctx.commands.execute(
    { session: Session.create(SessionId(`authorize-${Math.random()}`)) } as Agent,
    `/oauth ${input}`,
    [],
    new AbortController().signal,
  )
  if (result === undefined) throw new Error('/oauth was not registered')
  return result
}

async function commit(ctx: Context, key: CredentialKey = KEY): Promise<void> {
  await ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: { type: 'oauth' } }))
}

function register(ctx: Context, key: CredentialKey, run: (session: AuthorizationSession) => Promise<void> = () => Promise.resolve()): void {
  ctx.authorization.registerFlow({ key, label: String(key), methods: [{ id: 'oauth', label: 'OAuth' }], run })
}

describe('/oauth', () => {
  it('lists and filters bare available flow names', async () => {
    const ctx = await harness()
    register(ctx, OTHER_KEY)
    register(ctx, KEY)

    expect((await execute(ctx, 'available')).result).toEqual({
      kind: 'success', text: 'anthropic\ngithub-copilot',
    })
    expect((await execute(ctx, 'available cop')).result).toEqual({ kind: 'success', text: 'github-copilot' })
  })

  it('lists active stored grants after a restart-independent credential read', async () => {
    const ctx = await harness()
    register(ctx, KEY)
    register(ctx, OTHER_KEY)
    await commit(ctx, KEY)

    expect((await execute(ctx, 'active')).result).toEqual({ kind: 'success', text: 'anthropic' })
  })

  it('adds the provider route before beginning authorization and returns its URL', async () => {
    const ctx = await harness()
    let routeWasPresent = false
    register(ctx, KEY, async (session) => {
      routeWasPresent = Object.hasOwn((ctx.settings.get('llm-pi-ai') as { providers: object }).providers, 'anthropic')
      session.notify({ message: 'Continue in the browser.', url: 'https://example.test/oauth' })
      await session.prompt({ kind: 'text', message: 'Paste redirect URL', signal: session.signal })
    })

    const result = await execute(ctx, 'activate anthropic')

    expect(result.result).toEqual({
      kind: 'success',
      text: [
        'Click to begin OAuth flow: [example.test/oauth](https://example.test/oauth)',
        'Provider will be added automatically.',
        'Use `/oauth cancel anthropic` to abort the flow now.',
        'Use `/oauth deactivate anthropic` to remove the authorization later.',
      ].join('\n'),
    })
    expect(routeWasPresent).toBe(true)
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(true)
    expect((await execute(ctx, 'pending')).result).toEqual({ kind: 'success', text: 'anthropic' })
    await execute(ctx, 'cancel')
  })

  it('refuses activation when the provider route already exists', async () => {
    const ctx = await harness({}, { 'llm-pi-ai': { providers: { anthropic: {} } } })
    register(ctx, KEY)

    expect((await execute(ctx, 'activate anthropic')).result).toEqual({
      kind: 'error',
      text: 'anthropic already exists in Settings > Models. Remove that provider there before activating it again.',
    })
  })

  it('cancels all pending flows', async () => {
    const ctx = await harness()
    for (const key of [KEY, OTHER_KEY]) register(ctx, key, async (session) => {
      session.notify({ message: 'Continue.', url: `https://example.test/${String(key)}` })
      await session.prompt({ kind: 'text', message: 'Paste redirect URL', signal: session.signal })
    })
    await execute(ctx, 'activate anthropic')
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', 'anthropic'] }])
    await execute(ctx, 'activate github-copilot')

    expect((await execute(ctx, 'cancel')).result).toEqual({
      kind: 'success',
      text: 'Canceled pending anthropic flow.\nCanceled pending github-copilot flow.',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect((await execute(ctx, 'pending')).result).toEqual({ kind: 'success', text: 'No authorization flows are pending.' })
  })


  it('reports an empty cancel and can cancel one named flow', async () => {
    const ctx = await harness()
    register(ctx, KEY, async (session) => {
      session.notify({ message: 'Continue.', url: 'https://example.test/anthropic' })
      await session.prompt({ kind: 'text', message: 'Paste redirect URL', signal: session.signal })
    })

    expect((await execute(ctx, 'cancel')).result).toEqual({
      kind: 'success', text: 'No pending authorization flows to cancel.',
    })
    await execute(ctx, 'activate anthropic')
    expect((await execute(ctx, 'cancel anthropic')).result).toEqual({
      kind: 'success', text: 'Canceled pending anthropic flow.',
    })
    expect((await execute(ctx, 'cancel anthropic')).result).toEqual({
      kind: 'success', text: 'No pending anthropic authorization flow to cancel.',
    })
  })

  it('deactivates a stored grant and lists active grants when no flow is provided', async () => {
    const ctx = await harness()
    register(ctx, KEY)
    await commit(ctx)

    expect((await execute(ctx, 'deactivate')).result).toEqual({ kind: 'success', text: 'anthropic' })
    expect((await execute(ctx, 'deactivate anthropic')).result).toEqual({
      kind: 'success', text: 'anthropic authorization removed.',
    })
    await expect(ctx.credentials.describeRecord(KEY)).resolves.toEqual({ configured: false, writable: true })
  })

  it('rejects the old flow-first grammar', async () => {
    const ctx = await harness()
    register(ctx, KEY)
    expect((await execute(ctx, 'anthropic oauth')).result).toEqual({
      kind: 'error',
      text: 'Usage: /oauth available [STRING] | active | pending | activate FLOW [METHOD] | cancel [FLOW] | deactivate [FLOW]',
    })
  })
})
