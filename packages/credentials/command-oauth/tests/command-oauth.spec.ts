import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService, { AuthorizationError } from '@deepseek-ai/dsh-authorization'
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

const KEY = credentialKey('llm-pi-ai', 'anthropic-oauth')
const OTHER_KEY = credentialKey('llm-pi-ai', 'github-copilot-oauth')
const OAUTH_NAMES = ['anthropic', 'github-copilot', 'kimi-coding', 'meta', 'openai-codex', 'openrouter', 'radius', 'xai']
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function harness(initial: object = {}, stored?: object): Promise<Context> {
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(CommandsService)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-command-oauth-'))
  cleanups.unshift(() => rm(dir, { recursive: true, force: true }))

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
    name: 'command-oauth-test',
    inject: ['authorization', 'commands', 'credentials', 'settings'],
    apply,
  })
  return ctx
}

async function execute(ctx: Context, input: string) {
  const result = await ctx.commands.execute(
    { session: Session.create(SessionId(`oauth-${Math.random()}`)) } as Agent,
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

function browserFlow(session: AuthorizationSession): Promise<string> {
  session.notify({ message: 'Continue in the browser.', url: 'https://example.test/oauth' })
  return session.prompt({ kind: 'text', message: 'Paste redirect URL', signal: session.signal })
}

describe('/oauth', () => {
  it('lists persisted grants without an in-process authorization attempt', async () => {
    const ctx = await harness()
    register(ctx, KEY)
    await commit(ctx)
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
    expect((await execute(ctx, 'active')).result).toEqual({ kind: 'success', text: 'anthropic' })
  })
  it('lists and filters only OAuth flows with unsuffixed names', async () => {
    const ctx = await harness()
    for (const base of OAUTH_NAMES) register(ctx, credentialKey('llm-pi-ai', `${base}-oauth`))
    ctx.authorization.registerFlow({
      key: credentialKey('llm-pi-ai', 'api-only'), label: 'API only',
      methods: [{ id: 'api-key', label: 'API key' }], run: async () => {},
    })
    register(ctx, credentialKey('other-scope', 'hidden-oauth'))
    expect((await execute(ctx, 'available')).result).toEqual({ kind: 'success', text: [...OAUTH_NAMES].sort().join('\n') })
    expect((await execute(ctx, 'available COP')).result).toEqual({ kind: 'success', text: 'github-copilot' })
    expect((await execute(ctx, 'activate api-only')).result.kind).toBe('error')
  })

  it.each(OAUTH_NAMES)('keeps %s API keys and settings independent throughout OAuth activation and deactivation', async (base) => {
    const route = `${base}-oauth`
    const key = credentialKey('llm-pi-ai', route)
    const apiKey = credentialKey('llm-pi-ai', base)
    const profile = { apiKeyEnv: 'EXISTING_API_KEY' }
    const record: CredentialRecord = { kind: 'api-key', key: 'existing-secret' }
    const ctx = await harness({}, { 'llm-pi-ai': { providers: { [base]: profile } } })
    await ctx.credentials.modifyRecord(apiKey, () => Promise.resolve(record))
    ctx.authorization.registerFlow({
      key: apiKey, label: base, methods: [{ id: 'api-key', label: 'API key' }], run: async () => {},
    })
    let routeWasPresent = false
    register(ctx, key, async (session) => {
      expect(session.method).toBe('oauth')
      routeWasPresent = Object.hasOwn((ctx.settings.get('llm-pi-ai') as { providers: object }).providers, route)
      await browserFlow(session)
    })
    expect((await execute(ctx, 'active')).result.text).toBe('No authorizations are active.')
    expect((await execute(ctx, `activate ${base}`)).result).toEqual({
      kind: 'success',
      text: [
        'Click to begin OAuth flow: [example.test/oauth](https://example.test/oauth)',
        'Provider will be added automatically.',
        `Use \`/oauth cancel ${base}\` to abort the flow now.`,
        `Use \`/oauth deactivate ${base}\` to remove the authorization later.`,
      ].join('\n'),
    })
    expect(routeWasPresent).toBe(true)
    expect((await execute(ctx, 'pending')).result).toEqual({ kind: 'success', text: base })
    await commit(ctx, key)
    expect((await execute(ctx, 'active')).result).toEqual({ kind: 'success', text: base })
    expect((await execute(ctx, 'deactivate')).result).toEqual({ kind: 'success', text: base })
    expect((await execute(ctx, `deactivate ${base}`)).result).toEqual({ kind: 'success', text: `${base} authorization removed.` })
    await expect(ctx.credentials.describeRecord(key)).resolves.toEqual({ configured: false, writable: true })
    await expect(ctx.credentials.readRecord(apiKey)).resolves.toEqual(record)
    expect((ctx.settings.get('llm-pi-ai') as { providers: Record<string, object> }).providers)
      .toMatchObject({ [base]: profile, [route]: {} })
  })

  it.each(OAUTH_NAMES)('reuses the configured %s OAuth route without changing either route', async (base) => {
    const route = `${base}-oauth`
    const profile = { modelOverrides: { 'custom-model': { maxTokens: 32000 } } }
    const apiProfile = { apiKeyEnv: 'EXISTING_API_KEY' }
    const ctx = await harness({}, { 'llm-pi-ai': { providers: { [route]: profile, [base]: apiProfile } } })
    register(ctx, credentialKey('llm-pi-ai', route), async (session) => { await browserFlow(session) })
    expect((await execute(ctx, `activate ${base}`)).result.kind).toBe('success')
    expect((ctx.settings.get('llm-pi-ai') as { providers: Record<string, object> }).providers)
      .toMatchObject({ [route]: profile, [base]: apiProfile })
    expect((await execute(ctx, `cancel ${base}`)).result).toEqual({ kind: 'success', text: `Canceled pending ${base} flow.` })
  })

  it.each(OAUTH_NAMES)('rejects API-key and invalid methods for %s without starting or mutating a route', async (base) => {
    const ctx = await harness()
    const run = vi.fn(async () => {})
    ctx.authorization.registerFlow({
      key: credentialKey('llm-pi-ai', `${base}-oauth`), label: base,
      methods: [{ id: 'api-key', label: 'API key' }, { id: 'oauth', label: 'OAuth' }], run,
    })
    for (const method of ['api-key', 'invalid-oauth']) {
      const { result } = await execute(ctx, `activate ${base} ${method}`)
      expect(result.kind).toBe('error')
      expect(result.text).toContain(`Authorization flow "${base}" supports only the oauth method`)
      expect(result.text).not.toContain('-oauth')
    }
    expect(run).not.toHaveBeenCalled()
    expect((ctx.settings.get('llm-pi-ai') as { providers: object }).providers).toEqual({})
  })

  it('selects OAuth explicitly even if another method is listed first', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow({
      key: KEY, label: 'Anthropic',
      methods: [{ id: 'api-key', label: 'API key' }, { id: 'oauth', label: 'OAuth' }],
      run: async (session) => { expect(session.method).toBe('oauth'); await browserFlow(session) },
    })
    expect((await execute(ctx, 'activate anthropic oauth')).result.kind).toBe('success')
    await execute(ctx, 'cancel')
  })

  it('retains the device code and URL across progress notices and repeated activation', async () => {
    const ctx = await harness()
    const run = vi.fn(async (session: AuthorizationSession) => {
      session.notify({ message: 'Enter this code.', url: 'https://example.test/device', code: 'ABCD-1234' })
      session.notify({ message: 'Waiting for browser approval.' })
      await session.prompt({ kind: 'text', message: 'Paste redirect URL', signal: session.signal })
    })
    register(ctx, OTHER_KEY, run)
    const first = (await execute(ctx, 'activate github-copilot')).result
    expect(first).toEqual({
      kind: 'success',
      text: [
        'Click to begin OAuth flow: [example.test/device](https://example.test/device)',
        'Code: `ABCD-1234`',
        'Provider will be added automatically.',
        'Use `/oauth cancel github-copilot` to abort the flow now.',
        'Use `/oauth deactivate github-copilot` to remove the authorization later.',
      ].join('\n'),
    })
    expect((await execute(ctx, 'activate github-copilot')).result).toEqual(first)
    expect(run).toHaveBeenCalledTimes(1)
    await execute(ctx, 'cancel github-copilot')
  })
  it('strips exactly one suffix and derives the provider route from the resolved key', async () => {
    const ctx = await harness()
    const key = credentialKey('llm-pi-ai', 'custom-oauth-oauth')
    register(ctx, key, async (session) => { await browserFlow(session) })
    expect((await execute(ctx, 'available')).result).toEqual({ kind: 'success', text: 'custom-oauth' })
    expect((await execute(ctx, 'activate custom-oauth')).result.kind).toBe('success')
    expect((ctx.settings.get('llm-pi-ai') as { providers: object }).providers).toHaveProperty('custom-oauth-oauth')
    await execute(ctx, 'cancel custom-oauth')
  })

  it.each(['NO_FLOW', 'UNKNOWN_METHOD', 'ALREADY_IN_FLIGHT'])('presents %s service failures without internal credential names', async (code) => {
    const ctx = await harness()
    register(ctx, KEY)
    vi.spyOn(ctx.authorization, 'begin').mockRejectedValue(new AuthorizationError(`authorization flow for "${KEY}" failed`, code))
    expect((await execute(ctx, 'activate anthropic')).result).toEqual({ kind: 'error', text: 'authorization flow for "anthropic" failed' })
    expect((ctx.settings.get('llm-pi-ai') as { providers: object }).providers).not.toHaveProperty('anthropic-oauth')
  })

  it('does not roll back a configured route when authorization fails', async () => {
    const profile = { modelOverrides: { 'custom-model': { maxTokens: 32000 } } }
    const ctx = await harness({}, { 'llm-pi-ai': { providers: { 'anthropic-oauth': profile } } })
    register(ctx, KEY)
    vi.spyOn(ctx.authorization, 'begin').mockRejectedValue(new AuthorizationError(`no flow for ${KEY}`, 'NO_FLOW'))
    expect((await execute(ctx, 'activate anthropic')).result.kind).toBe('error')
    expect((ctx.settings.get('llm-pi-ai') as { providers: Record<string, object> }).providers['anthropic-oauth']).toMatchObject(profile)
  })

  it('cancels all pending flows with unsuffixed names', async () => {
    const ctx = await harness()
    for (const key of [KEY, OTHER_KEY]) register(ctx, key, async (session) => { await browserFlow(session) })
    await execute(ctx, 'activate anthropic')
    await execute(ctx, 'activate github-copilot')
    expect((await execute(ctx, 'cancel')).result).toEqual({
      kind: 'success', text: 'Canceled pending anthropic flow.\nCanceled pending github-copilot flow.',
    })
    await vi.waitFor(async () => {
      expect((await execute(ctx, 'pending')).result).toEqual({ kind: 'success', text: 'No authorization flows are pending.' })
    })
  })

  it('reports empty and named cancellation', async () => {
    const ctx = await harness()
    register(ctx, KEY, async (session) => { await browserFlow(session) })
    expect((await execute(ctx, 'cancel')).result).toEqual({ kind: 'success', text: 'No pending authorization flows to cancel.' })
    await execute(ctx, 'activate anthropic')
    expect((await execute(ctx, 'cancel anthropic')).result).toEqual({ kind: 'success', text: 'Canceled pending anthropic flow.' })
    expect((await execute(ctx, 'cancel anthropic')).result).toEqual({ kind: 'success', text: 'No pending anthropic authorization flow to cancel.' })
  })

  it('reports unknown names without the internal suffix', async () => {
    const ctx = await harness()
    for (const action of ['activate', 'cancel', 'deactivate']) {
      expect((await execute(ctx, `${action} unknown-oauth`)).result).toEqual({
        kind: 'error', text: 'Unknown authorization flow "unknown". Run /oauth available.',
      })
    }
  })

  it.each(['anthropic oauth', 'activate'])('shows usage for %s', async (input) => {
    const ctx = await harness()
    expect((await execute(ctx, input)).result).toEqual({
      kind: 'error', text: 'Usage: /oauth available [STRING] | active | pending | activate FLOW [METHOD] | cancel [FLOW] | deactivate [FLOW]',
    })
  })
})
