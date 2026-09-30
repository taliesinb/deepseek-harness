import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import CommandsService from '@deepseek-ai/dsh-commands'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import LlmService from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { oauthCatalogProvider, oauthProviderIds } from '@deepseek-ai/dsh-llm-pi-ai/src/catalog.ts'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as CommandOAuth from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.restoreAllMocks()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('/oauth real Loader composition', () => {
  it('boots catalog flows from cordis.yml, stores isolated grants, and withdraws registrations on unmount', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-command-oauth-loader-'))
    const routes = oauthProviderIds()
    expect(routes.length).toBeGreaterThan(0)
    const bases = routes.map(route => route.replace(/-oauth$/u, '')).sort()
    const loginCalls: string[] = []
    for (const route of routes) {
      const oauth = oauthCatalogProvider(route)?.auth.oauth
      if (oauth === undefined) throw new Error(`missing catalog OAuth method for ${route}`)
      // Only the remote browser exchange is replaced. Models.login, the
      // credential store, flow registration, and settings writes remain real.
      vi.spyOn(oauth, 'login').mockImplementation(async (interaction) => {
        loginCalls.push(route)
        if (route === 'github-copilot-oauth') {
          expect(await interaction.prompt({ type: 'text', message: 'GitHub Enterprise URL/domain (blank for github.com)', placeholder: 'company.ghe.com' })).toBe('')
        }
        if (route === 'openai-codex-oauth') {
          expect(await interaction.prompt({
            type: 'select', message: 'Select OpenAI Codex login method:',
            options: [{ id: 'browser', label: 'Browser login (default)' }, { id: 'device', label: 'Device code login (headless)' }],
          })).toBe('device')
        }
        interaction.notify({ type: 'auth_url', url: 'https://example.test/oauth' })
        return { type: 'oauth', access: `offline-${route}`, refresh: 'offline-refresh', expires: 4_000_000_000_000 }
      })
    }

    const settingsPath = join(root, 'settings.yaml')
    const apiProfile = { apiKeyEnv: 'EXISTING_API_KEY' }
    await writeFile(settingsPath, JSON.stringify({ 'llm-pi-ai': { providers: { anthropic: apiProfile } } }))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, JSON.stringify([
      { id: 'credentials', name: '@deepseek-ai/dsh-credentials-local', config: { path: join(root, '.credentials.yaml'), watch: false } },
      { id: 'settings', name: '@deepseek-ai/dsh-settings-file', config: { path: settingsPath, dshHome: root, watch: false, debounceMs: 100 } },
      { id: 'agents', name: '@deepseek-ai/dsh-agent' },
      { id: 'user-questions', name: '@deepseek-ai/dsh-user-questions' },
      { id: 'authorization', name: '@deepseek-ai/dsh-authorization' },
      { id: 'commands', name: '@deepseek-ai/dsh-commands' },
      { id: 'llm', name: '@deepseek-ai/dsh-llm' },
      { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {} } },
      { id: 'command-oauth', name: '@deepseek-ai/dsh-command-oauth' },
    ]))
    const ctx = context = new Context()
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
      ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-user-questions', UserQuestions],
      ['@deepseek-ai/dsh-authorization', AuthorizationService],
      ['@deepseek-ai/dsh-commands', CommandsService],
      ['@deepseek-ai/dsh-llm', LlmService],
      ['@deepseek-ai/dsh-llm-pi-ai', PiAi],
      ['@deepseek-ai/dsh-command-oauth', CommandOAuth],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()

    const session = Session.create(SessionId('oauth-loader'))
    const agent = { id: session.id, session, ctx } as Agent
    await ctx.agents.register(agent)
    ctx.on('user-questions/request', async request => ({
      answers: request.questions.map(question => ({
        id: question.id,
        selected: [question.options?.[question.question.startsWith('Select') ? 1 : 0]?.label ?? ''],
      })),
    }))
    const signal = new AbortController().signal
    const execute = async (input: string) => {
      const executed = await ctx.commands.execute(agent, `/oauth ${input}`, [], signal)
      if (executed === undefined) throw new Error('/oauth was not loaded')
      return executed.result
    }
    const apiKey = credentialKey('llm-pi-ai', 'anthropic')
    await ctx.credentials.modifyRecord(apiKey, async () => ({ kind: 'api-key', key: 'offline-api-key' }))
    expect(ctx.commands.list(agent).map(command => command.name)).toContain('oauth')
    expect((await execute('available')).text).toBe(bases.join('\n'))
    expect((await execute('available')).text).toMatchInlineSnapshot(`
      "anthropic
      github-copilot
      kimi-coding
      meta
      openai-codex
      openrouter
      radius
      xai"
    `)
    expect(ctx.authorization.list().every(entry => entry.methods.length === 1 && entry.methods[0]?.id === 'oauth')).toBe(true)

    for (const base of bases) {
      const activated = await execute(`activate ${base}`)
      expect(activated.kind).toBe('success')
      expect(activated.text).not.toContain(`${base}-oauth`)
      if (base === 'anthropic') expect(activated).toMatchInlineSnapshot(`
        {
          "kind": "success",
          "text": "Click to begin OAuth flow: [example.test/oauth](https://example.test/oauth)
        Provider will be added automatically.
        Use \`/oauth cancel anthropic\` to abort the flow now.
        Use \`/oauth deactivate anthropic\` to remove the authorization later.",
        }
      `)
      const route = `${base}-oauth`
      const key = credentialKey('llm-pi-ai', route)
      await vi.waitFor(async () => {
        expect(ctx.authorization.describe(key)?.inFlight).toBe(false)
        expect(await ctx.credentials.readRecord(key)).toMatchObject({ kind: 'grant', payload: { type: 'oauth', access: `offline-${route}` } })
      })
      expect((await execute('active')).text).toBe(base)
      expect((ctx.settings.get('llm-pi-ai') as PiAi.Config).providers).toHaveProperty(route)
      expect(await readFile(settingsPath, 'utf8')).toContain(`${route}:`)
      const deactivated = await execute(`deactivate ${base}`)
      expect(deactivated).toEqual({ kind: 'success', text: `${base} authorization removed.` })
      if (base === 'anthropic') expect(deactivated).toMatchInlineSnapshot(`
        {
          "kind": "success",
          "text": "anthropic authorization removed.",
        }
      `)
      expect(await ctx.credentials.readRecord(key)).toBeUndefined()
      expect(await ctx.credentials.readRecord(apiKey)).toEqual({ kind: 'api-key', key: 'offline-api-key' })
      expect((ctx.settings.get('llm-pi-ai') as PiAi.Config).providers?.anthropic).toMatchObject(apiProfile)
    }
    expect(loginCalls.sort()).toEqual([...routes].sort())
    expect((await execute('active')).text).toBe('No authorizations are active.')
    expect(session.snapshotEvents().filter(event => event.type === 'command/done').length).toBeGreaterThan(0)
    expect(session.deriveMessages()).toEqual([])

    const commandFiber = [...ctx.registry.get(CommandOAuth)!.fibers][0]!
    await commandFiber.dispose()
    expect(ctx.commands.list(agent).map(command => command.name)).not.toContain('oauth')
    expect(await ctx.commands.execute(agent, '/oauth available', [], signal)).toBeUndefined()
    const providerFiber = [...ctx.registry.get(PiAi)!.fibers][0]!
    await providerFiber.dispose()
    expect(ctx.authorization.list()).toEqual([])
  })
})
