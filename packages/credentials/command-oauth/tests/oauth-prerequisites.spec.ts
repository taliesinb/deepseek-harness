import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import CommandsService from '@deepseek-ai/dsh-commands'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmService from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { oauthCatalogProvider } from '@deepseek-ai/dsh-llm-pi-ai/src/catalog.ts'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import UserQuestions, { type AskUserQuestionAnswer, type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import * as CommandOAuth from '../src/index.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

async function harness(answer?: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-oauth-prerequisites-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LocalCredentialProvider, { path: join(root, '.credentials.yaml'), watch: false })
  await ctx.plugin(FileSettingsProvider, { path: join(root, 'settings.yaml'), dshHome: root, watch: false, debounceMs: 100 })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(CommandsService)
  await ctx.plugin(LlmService)
  await ctx.plugin(PiAi, { providers: {} })
  await ctx.plugin(AgentRegistry)
  if (answer !== undefined) {
    await ctx.plugin(UserQuestions)
    ctx.on('user-questions/request', answer)
  }
  const command = ctx.plugin(CommandOAuth)
  await command
  const session = Session.create(SessionId('oauth-prerequisite-agent'))
  const agent = { id: session.id, session, ctx } as Agent
  await ctx.agents.register(agent)
  const execute = async (input: string) => {
    const execution = await ctx.commands.execute(agent, `/oauth ${input}`, [], new AbortController().signal)
    if (execution === undefined) throw new Error('/oauth is unavailable')
    return execution.result
  }
  return { ctx, agent, command, execute }
}

function nativeLogin(base = 'github-copilot') {
  const oauth = oauthCatalogProvider(`${base}-oauth`)?.auth.oauth
  if (oauth === undefined) throw new Error(`missing OAuth implementation for ${base}`)
  return vi.spyOn(oauth, 'login')
}

const grant = { type: 'oauth' as const, access: 'offline-access', refresh: 'offline-refresh', expires: 4_000_000_000_000 }
const domainPrompt = { type: 'text' as const, message: 'GitHub Enterprise URL/domain (blank for github.com)', placeholder: 'company.ghe.com' }
const defaultAnswer: AskUserQuestionAnswer = { answers: [{ id: 'oauth-prerequisite', selected: ['Use default (empty)'] }] }

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new Error('aborted'))
    else signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
  })
}

/** Keep the human UI pending, but honor the real question service's cancellation signal. */
function pendingUi() {
  const answer = Promise.withResolvers<AskUserQuestionAnswer>()
  const ui = vi.fn(async (request: AskUserQuestionRequest) => {
    request.signal?.addEventListener('abort', () => { answer.reject(new Error('UI cancelled')) }, { once: true })
    return answer.promise
  })
  return { answer, ui }
}

describe('OAuth prerequisites through the real user-question service', () => {
  it.each([
    { answer: defaultAnswer, expected: '' },
    { answer: { answers: [{ id: 'oauth-prerequisite', selected: [], custom: 'enterprise.example' }] }, expected: 'enterprise.example' },
  ])('passes an explicitly chosen domain value: $expected', async ({ answer, expected }) => {
    const ui = vi.fn(async (_request: AskUserQuestionRequest) => answer)
    const login = nativeLogin().mockImplementation(async (interaction) => {
      expect(await interaction.prompt(domainPrompt)).toBe(expected)
      interaction.notify({ type: 'device_code', verificationUri: 'https://example.test/device', userCode: 'ABCD-1234' })
      return grant
    })
    const { agent, execute } = await harness(ui)
    expect((await execute('activate github-copilot')).text).toContain('Code: `ABCD-1234`')
    expect(ui.mock.calls[0]?.[0].agent).toBe(agent)
    expect(ui.mock.calls[0]?.[0].questions).toMatchObject([{ id: 'oauth-prerequisite', question: domainPrompt.message }])
    expect(login).toHaveBeenCalledTimes(1)
  })

  it('maps numbered duplicate select labels back to the chosen native option id', async () => {
    const ui = vi.fn(async (request: AskUserQuestionRequest) => ({
      answers: [{ id: 'oauth-prerequisite', selected: [request.questions[0]!.options![1]!.label] }],
    }))
    nativeLogin('openai-codex').mockImplementation(async (interaction) => {
      expect(await interaction.prompt({ type: 'select', message: 'Select login:', options: [{ id: 'browser', label: 'Login' }, { id: 'device', label: 'Login' }] })).toBe('device')
      interaction.notify({ type: 'auth_url', url: 'https://example.test/oauth' })
      return grant
    })
    const { execute } = await harness(ui)
    expect((await execute('activate openai-codex')).kind).toBe('success')
    expect(ui.mock.calls[0]?.[0].questions[0]?.options).toEqual([{ label: '1. Login' }, { label: '2. Login' }])
  })

  it('suspends URL timeout while the human answers and does not duplicate questions on repeated activation', async () => {
    const { answer, ui } = pendingUi()
    const login = nativeLogin().mockImplementation(async (interaction) => {
      expect(await interaction.prompt(domainPrompt)).toBe('')
      interaction.notify({ type: 'auth_url', url: 'https://example.test/oauth' })
      return grant
    })
    const { execute } = await harness(ui)
    let settled = false
    const activation = execute('activate github-copilot').then((result) => { settled = true; return result })
    await vi.waitFor(() => { expect(ui).toHaveBeenCalledTimes(1) })
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(settled).toBe(false)
    expect((await execute('activate github-copilot')).text).toBe('github-copilot authorization is still starting.')
    expect(ui).toHaveBeenCalledTimes(1)
    answer.resolve(defaultAnswer)
    await vi.advanceTimersByTimeAsync(0)
    expect((await activation).kind).toBe('success')
    expect(login).toHaveBeenCalledTimes(1)
  })

  it('resumes the URL timeout after the prerequisite answer', async () => {
    const { answer, ui } = pendingUi()
    nativeLogin().mockImplementation(async (interaction) => {
      await interaction.prompt(domainPrompt)
      return waitForAbort(interaction.signal)
    })
    const { execute } = await harness(ui)
    const activation = execute('activate github-copilot')
    await vi.waitFor(() => { expect(ui).toHaveBeenCalledTimes(1) })
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(90_000)
    answer.resolve(defaultAnswer)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await activation).toEqual({ kind: 'error', text: 'authorization for "github-copilot" did not provide a browser URL' })
  })

  it.each(['cancel', 'dispose'] as const)('aborts the pending human question on %s', async (action) => {
    const { ui } = pendingUi()
    nativeLogin().mockImplementation(async (interaction) => { await interaction.prompt(domainPrompt); return grant })
    const { ctx, command, execute } = await harness(ui)
    const activation = execute('activate github-copilot')
    await vi.waitFor(() => { expect(ui).toHaveBeenCalledTimes(1) })
    if (action === 'cancel') await execute('cancel github-copilot')
    else await command.dispose()
    expect(ui.mock.calls[0]?.[0].signal?.aborted).toBe(true)
    expect((await activation).kind).toBe('error')
    await vi.waitFor(() => { expect(ctx.authorization.list().every(entry => !entry.inFlight)).toBe(true) })
  })

  it('fails actionably without the optional question service instead of choosing defaults', async () => {
    nativeLogin().mockImplementation(async (interaction) => { await interaction.prompt(domainPrompt); return grant })
    const { execute } = await harness()
    expect(await execute('activate github-copilot')).toEqual({
      kind: 'error', text: 'This OAuth flow requires a human answer. Enable user questions in this session and activate the flow again.',
    })
  })

  it('refuses secret prompts without forwarding or logging their message', async () => {
    const ui = vi.fn(async () => defaultAnswer)
    nativeLogin().mockImplementation(async (interaction) => {
      await interaction.prompt({ type: 'secret', message: 'sensitive-prompt-details' })
      return grant
    })
    const { execute, agent } = await harness(ui)
    const result = await execute('activate github-copilot')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('Secret prompts are not supported')
    expect(ui).not.toHaveBeenCalled()
    expect(JSON.stringify(agent.session.snapshotEvents())).not.toContain('sensitive-prompt-details')
  })

  it.each([
    { answers: [{ id: 'wrong-id', selected: ['Use default (empty)'] }] },
    { answers: [{ id: 'oauth-prerequisite', selected: ['unoffered'] }] },
    { answers: [{ id: 'oauth-prerequisite', selected: ['Use default (empty)', 'other'] }] },
    { answers: [{ id: 'oauth-prerequisite', selected: ['Use default (empty)'], custom: 'conflicting' }] },
    { answers: [{ id: 'oauth-prerequisite', selected: [], custom: '' }] },
  ])('rejects malformed UI answers: %j', async (answer) => {
    nativeLogin().mockImplementation(async (interaction) => { await interaction.prompt(domainPrompt); return grant })
    const { execute } = await harness(async () => answer)
    expect((await execute('activate github-copilot')).text).toContain('Invalid OAuth prerequisite answer')
  })
})
