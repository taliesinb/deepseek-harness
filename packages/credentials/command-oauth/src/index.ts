/**
 * Human-facing `/oauth ACTION [FLOW]` command over provider-neutral flows.
 * Public flow names omit the credential scope and one trailing OAuth route suffix.
 * @module @deepseek-ai/dsh-command-oauth
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-questions'
import { AuthorizationDeclinedError, AuthorizationError } from '@deepseek-ai/dsh-authorization'
import type {
  AuthorizationEntry,
  AuthorizationNotice,
  AuthorizationPrompt,
  AuthorizationSettlement,
} from '@deepseek-ai/dsh-authorization'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'

export const name = 'command-oauth'
export const inject = ['authorization', 'commands', 'credentials', 'settings']

const FLOW_SCOPE = 'llm-pi-ai'
const SETTINGS_NS = 'llm-pi-ai'
const USAGE = 'Usage: /oauth available [STRING] | active | pending | activate FLOW [METHOD] | cancel [FLOW] | deactivate [FLOW]'
const URL_WAIT_MS = 30_000

interface Attempt {
  readonly key: CredentialKey
  readonly controller: AbortController
  readonly urlReady: PromiseWithResolvers<AuthorizationNotice>
  notice?: AuthorizationNotice
  settlement?: AuthorizationSettlement
  failure?: string
}

function providerRoute(key: CredentialKey): string | undefined {
  const prefix = `${FLOW_SCOPE}/`
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined
}

function flowName(key: CredentialKey): string | undefined {
  return providerRoute(key)?.replace(/-oauth$/u, '')
}

function keyFor(entries: readonly AuthorizationEntry[], value: string): CredentialKey | CommandResult {
  const match = entries.find(entry => flowName(entry.key) === value)
  return match?.key ?? { kind: 'error', text: `Unknown authorization flow ${JSON.stringify(value.replace(/-oauth$/u, ''))}. Run /oauth available.` }
}

function formatList(values: readonly string[], empty: string): CommandResult {
  return { kind: 'success', text: values.length === 0 ? empty : values.join('\n') }
}

function available(entries: readonly AuthorizationEntry[], filter: string | undefined): CommandResult {
  const needle = filter?.toLocaleLowerCase()
  const names = entries
    .map(entry => flowName(entry.key))
    .filter((value): value is string => value !== undefined && (needle === undefined || value.toLocaleLowerCase().includes(needle)))
    .sort()
  return formatList(names, filter === undefined ? 'No authorization flows are available.' : 'No authorization flows match that filter.')
}

async function active(ctx: Context, entries: readonly AuthorizationEntry[]): Promise<CommandResult> {
  const names = await Promise.all(entries.map(async entry => (
    (await ctx.credentials.describeRecord(entry.key)).configured ? flowName(entry.key) : undefined
  )))
  return formatList(names.filter((value): value is string => value !== undefined).sort(), 'No authorizations are active.')
}

function pending(entries: readonly AuthorizationEntry[]): CommandResult {
  const names = entries.filter(entry => entry.inFlight).map(entry => flowName(entry.key))
  return formatList(names.filter((value): value is string => value !== undefined).sort(), 'No authorization flows are pending.')
}

/** Keep a browser-callback fallback pending until its provider withdraws it. */
function waitForCallback(signal: AbortSignal): Promise<string> {
  return new Promise((_resolve, reject) => {
    const withdrawn = (): Error => new Error('authorization prompt withdrawn', { cause: signal.reason })
    if (signal.aborted) {
      reject(withdrawn())
      return
    }
    signal.addEventListener('abort', () => { reject(withdrawn()) }, { once: true })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate the answer returned by the UI before handing a value to the provider. */
function prerequisiteAnswer(value: unknown, options: readonly { label: string; value: string }[], text: boolean): string {
  const invalid = (): AuthorizationError => new AuthorizationError('Invalid OAuth prerequisite answer. Activate the flow again and choose one offered option or enter text when requested.', 'INVALID_ANSWER')
  if (!isRecord(value) || !Array.isArray(value.answers) || value.answers.length !== 1) throw invalid()
  const answer: unknown = value.answers[0]
  if (!isRecord(answer) || answer.id !== 'oauth-prerequisite' || !Array.isArray(answer.selected)) throw invalid()
  if (answer.selected.length === 0 && text && typeof answer.custom === 'string' && answer.custom.trim().length > 0) return answer.custom
  if (answer.selected.length !== 1 || (answer.custom !== undefined && answer.custom !== '')) throw invalid()
  const selected: unknown = answer.selected[0]
  const option = options.find(option => option.label === selected)
  if (option === undefined) throw invalid()
  return option.value
}

/** Collect only non-secret prerequisites from the exact initiating agent's human UI. */
async function askPrerequisite(ctx: Context, agent: Agent, prompt: AuthorizationPrompt, signal: AbortSignal): Promise<string> {
  if (prompt.kind === 'secret') {
    throw new AuthorizationError('Secret prompts are not supported by /oauth. Use a dedicated secure authorization surface.', 'SECRET_PROMPT')
  }
  if (prompt.signal !== undefined) return waitForCallback(prompt.signal)
  const questions = ctx.get('userQuestions')
  if (questions === undefined) {
    throw new AuthorizationError('This OAuth flow requires a human answer. Enable user questions in this session and activate the flow again.', 'INTERACTION_UNAVAILABLE')
  }
  const options = prompt.kind === 'select'
    ? prompt.options.map((option, index) => ({ label: `${String(index + 1)}. ${option.label}`, value: option.id }))
    : [{ label: 'Use default (empty)', value: '' }]
  let answer: unknown
  try {
    answer = await questions.ask({
      agent,
      signal,
      questions: [{
        id: 'oauth-prerequisite', question: prompt.message,
        options: options.map(option => ({ label: option.label })),
        multiSelect: false,
      }],
    })
  } catch (error) {
    throw new AuthorizationError('The OAuth prerequisite question could not be answered. Activate the flow from an interactive live session.', 'INTERACTION_FAILED', { cause: error })
  }
  return prerequisiteAnswer(answer, options, prompt.kind === 'text')
}

function startAttempt(ctx: Context, attempts: Map<CredentialKey, Attempt>, key: CredentialKey, agent: Agent): Attempt {
  const controller = new AbortController()
  const urlReady = Promise.withResolvers<AuthorizationNotice>()
  const attempt: Attempt = { key, controller, urlReady }
  attempts.set(key, attempt)
  let timer: ReturnType<typeof setTimeout> | undefined
  let remaining = URL_WAIT_MS
  let started = 0
  const pause = (): void => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
    remaining -= Date.now() - started
  }
  const resume = (): void => {
    if (controller.signal.aborted || attempt.notice?.url !== undefined || attempt.settlement !== undefined) return
    started = Date.now()
    timer = setTimeout(() => {
      urlReady.reject(new AuthorizationError(`authorization for "${flowName(key) ?? key}" did not provide a browser URL`, 'NO_URL'))
      controller.abort()
    }, Math.max(0, remaining))
  }
  controller.signal.addEventListener('abort', () => {
    pause()
    urlReady.reject(new AuthorizationDeclinedError(`Authorization for ${flowName(key) ?? key} was cancelled.`))
  }, { once: true })
  void urlReady.promise.then(pause, pause)
  resume()
  void ctx.authorization.begin({
    key,
    method: 'oauth',
    signal: controller.signal,
    interaction: {
      notify(notice) {
        if (notice.url !== undefined || attempt.notice === undefined) attempt.notice = notice
        if (notice.url !== undefined) urlReady.resolve(notice)
      },
      async prompt(prompt) {
        if (prompt.signal !== undefined || prompt.kind === 'secret') return askPrerequisite(ctx, agent, prompt, controller.signal)
        pause()
        try {
          return await askPrerequisite(ctx, agent, prompt, controller.signal)
        } finally {
          resume()
        }
      },
    },
  }).then((outcome) => {
    attempt.settlement = outcome.status
    pause()
    if (outcome.status === 'cancelled') urlReady.reject(new AuthorizationDeclinedError(`Authorization for ${flowName(key) ?? key} was cancelled.`))
    else if (attempt.notice?.url === undefined) urlReady.reject(new AuthorizationError('OAuth completed without providing a browser URL.', 'NO_URL'))
  }, (error: unknown) => {
    attempt.settlement = 'failed'
    attempt.failure = error instanceof Error ? error.message : String(error)
    pause()
    urlReady.reject(error)
  })
  return attempt
}

function oauthLink(url: string, flow: string, code?: string): string {
  try {
    const { hostname, pathname } = new URL(url)
    const label = `${hostname}${pathname}`.replace(/\/$/u, '')
    return [
      `Click to begin OAuth flow: [${label}](${url})`,
      ...code === undefined ? [] : [`Code: \`${code}\``],
      'Provider will be added automatically.',
      `Use \`/oauth cancel ${flow}\` to abort the flow now.`,
      `Use \`/oauth deactivate ${flow}\` to remove the authorization later.`,
    ].join('\n')
  } catch {
    return url
  }
}

function providerProfiles(ctx: Context): Readonly<Record<string, unknown>> {
  const value = ctx.settings.get(SETTINGS_NS) as { providers?: unknown } | undefined
  const providers = value?.providers
  return providers !== null && typeof providers === 'object' && !Array.isArray(providers)
    ? providers as Readonly<Record<string, unknown>>
    : {}
}

async function activate(
  ctx: Context,
  attempts: Map<CredentialKey, Attempt>,
  entries: readonly AuthorizationEntry[],
  flow: string,
  agent: Agent,
  method?: string,
): Promise<CommandResult> {
  const key = keyFor(entries, flow)
  if (typeof key === 'object' && 'kind' in key) return key
  if (method !== undefined && method !== 'oauth') {
    return { kind: 'error', text: `Authorization flow ${JSON.stringify(flow)} supports only the oauth method in /oauth. Configure API keys in Settings > Models.` }
  }
  const route = key.slice(FLOW_SCOPE.length + 1)
  const existing = attempts.get(key)
  if (existing !== undefined && existing.settlement === undefined) {
    if (existing.notice?.url !== undefined) return { kind: 'success', text: oauthLink(existing.notice.url, flow, existing.notice.code) }
    return { kind: 'success', text: `${flow} authorization is still starting.` }
  }
  // An existing OAuth route may be retried after a cancelled or failed login.
  // Never overwrite a configured route, even one with an empty profile.
  const ownsRoute = !Object.hasOwn(providerProfiles(ctx), route)
  if (ownsRoute) await ctx.settings.mutate(SETTINGS_NS, [{ op: 'set', path: ['providers', route], value: {} }])
  const activatedProfile = JSON.stringify(providerProfiles(ctx)[route])
  try {
    const notice = await startAttempt(ctx, attempts, key, agent).urlReady.promise
    return { kind: 'success', text: notice.url === undefined ? notice.message : oauthLink(notice.url, flow, notice.code) }
  } catch (error: unknown) {
    if (ownsRoute && JSON.stringify(providerProfiles(ctx)[route]) === activatedProfile) {
      await ctx.settings.mutate(SETTINGS_NS, [{ op: 'unset', path: ['providers', route] }])
    }
    if (error instanceof AuthorizationError) {
      return { kind: 'error', text: error.message.replaceAll(String(key), flow).replaceAll(route, flow) }
    }
    throw error
  }
}

async function deactivate(
  ctx: Context,
  attempts: Map<CredentialKey, Attempt>,
  entries: readonly AuthorizationEntry[],
  flow: string | undefined,
): Promise<CommandResult> {
  if (flow === undefined) return active(ctx, entries)
  const key = keyFor(entries, flow)
  if (typeof key === 'object' && 'kind' in key) return key
  const configured = (await ctx.credentials.describeRecord(key)).configured
  if (!configured) return { kind: 'error', text: `${flow} authorization is not active.` }
  attempts.get(key)?.controller.abort()
  ctx.authorization.cancel(key)
  await ctx.credentials.deleteRecord(key)
  attempts.delete(key)
  return { kind: 'success', text: `${flow} authorization removed.` }
}

async function oauth(ctx: Context, attempts: Map<CredentialKey, Attempt>, invocation: CommandInvocation): Promise<CommandResult> {
  const words = invocation.rawInput.trim().split(/\s+/u).filter(Boolean)
  const [action, argument, extra] = words
  const entries = ctx.authorization.list().filter(entry => (
    flowName(entry.key) !== undefined && entry.methods.some(method => method.id === 'oauth')
  ))
  if (action === undefined) return { kind: 'error', text: USAGE }
  if (action === 'available' && words.length <= 2) return available(entries, argument)
  if (action === 'active' && words.length === 1) return active(ctx, entries)
  if (action === 'pending' && words.length === 1) return pending(entries)
  if (action === 'cancel' && words.length <= 2) {
    const pendingEntries = entries.filter(entry => entry.inFlight)
    if (argument !== undefined) {
      const key = keyFor(entries, argument)
      if (typeof key === 'object' && 'kind' in key) return key
      const entry = pendingEntries.find(candidate => candidate.key === key)
      if (entry === undefined) return { kind: 'success', text: `No pending ${argument} authorization flow to cancel.` }
      attempts.get(key)?.controller.abort()
      ctx.authorization.cancel(key)
      return { kind: 'success', text: `Canceled pending ${argument} flow.` }
    }
    if (pendingEntries.length === 0) return { kind: 'success', text: 'No pending authorization flows to cancel.' }
    const cancelled: string[] = []
    for (const entry of pendingEntries) {
      attempts.get(entry.key)?.controller.abort()
      ctx.authorization.cancel(entry.key)
      const flow = flowName(entry.key)
      if (flow !== undefined) cancelled.push(`Canceled pending ${flow} flow.`)
    }
    return { kind: 'success', text: cancelled.join('\n') }
  }
  if (action === 'activate' && argument !== undefined && words.length <= 3) {
    return activate(ctx, attempts, entries, argument, invocation.agent, extra)
  }
  if (action === 'deactivate' && words.length <= 2) return deactivate(ctx, attempts, entries, argument)
  return { kind: 'error', text: USAGE }
}

/** Register the OAuth-only command over the generic authorization service. */
export function apply(ctx: Context): void {
  const attempts = new Map<CredentialKey, Attempt>()
  ctx.effect(() => () => {
    for (const attempt of attempts.values()) attempt.controller.abort()
  })
  ctx.commands.register({
    definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-command-oauth'),
    name: 'oauth',
    description: 'List, activate, cancel, or deactivate provider OAuth flows',
    input: { hint: 'available [STRING] | active | pending | activate FLOW [METHOD] | cancel [FLOW] | deactivate [FLOW]' },
    recordInput: true,
    handler: invocation => oauth(ctx, attempts, invocation),
  })
}
