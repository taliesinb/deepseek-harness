/**
 * Human-facing `/oauth ACTION [FLOW]` command over provider-neutral flows.
 * The public flow name omits this package family's internal credential scope.
 * @module @deepseek-ai/dsh-command-authorization
 */

import type { Context } from '@deepseek-ai/cordis'
import { AuthorizationDeclinedError, AuthorizationError } from '@deepseek-ai/dsh-authorization'
import type {
  AuthorizationEntry,
  AuthorizationNotice,
  AuthorizationPrompt,
  AuthorizationSettlement,
} from '@deepseek-ai/dsh-authorization'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'

export const name = 'command-authorization'
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

function flowName(key: CredentialKey): string | undefined {
  const prefix = `${FLOW_SCOPE}/`
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined
}

function keyFor(entries: readonly AuthorizationEntry[], value: string): CredentialKey | CommandResult {
  const match = entries.find(entry => flowName(entry.key) === value)
  return match?.key ?? { kind: 'error', text: `Unknown authorization flow ${JSON.stringify(value)}. Run /oauth available.` }
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

/** Keep a callback-raced prompt open; decline prompts that this command cannot answer. */
function waitForCallback(prompt: AuthorizationPrompt): Promise<string> {
  if (prompt.signal === undefined) {
    return Promise.reject(new AuthorizationDeclinedError(
      `${prompt.message} This command cannot collect a typed response; use a dedicated interactive authorization surface.`,
    ))
  }
  const { signal } = prompt
  return new Promise((_resolve, reject) => {
    const withdrawn = (): Error => new Error('authorization prompt withdrawn', { cause: signal.reason })
    if (signal.aborted) {
      reject(withdrawn())
      return
    }
    signal.addEventListener('abort', () => { reject(withdrawn()) }, { once: true })
  })
}

function startAttempt(ctx: Context, attempts: Map<CredentialKey, Attempt>, key: CredentialKey, method?: string): Attempt {
  const controller = new AbortController()
  const urlReady = Promise.withResolvers<AuthorizationNotice>()
  const attempt: Attempt = { key, controller, urlReady }
  attempts.set(key, attempt)
  void ctx.authorization.begin({
    key,
    ...method === undefined ? {} : { method },
    signal: controller.signal,
    interaction: {
      notify(notice) {
        attempt.notice = notice
        if (notice.url !== undefined) urlReady.resolve(notice)
      },
      prompt: waitForCallback,
    },
  }).then((outcome) => {
    attempt.settlement = outcome.status
    if (outcome.status === 'cancelled') urlReady.reject(new AuthorizationDeclinedError(`Authorization for ${flowName(key) ?? key} was cancelled.`))
  }, (error: unknown) => {
    attempt.settlement = 'failed'
    attempt.failure = error instanceof Error ? error.message : String(error)
    urlReady.reject(error)
  })
  return attempt
}

async function awaitUrl(attempt: Attempt): Promise<AuthorizationNotice> {
  const timeout = Promise.withResolvers<AuthorizationNotice>()
  const timer = setTimeout(() => {
    timeout.reject(new AuthorizationError(`authorization for "${flowName(attempt.key) ?? attempt.key}" did not provide a browser URL`, 'NO_URL'))
  }, URL_WAIT_MS)
  try {
    return await Promise.race([attempt.urlReady.promise, timeout.promise])
  } catch (error) {
    attempt.controller.abort()
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function oauthLink(url: string, flow: string): string {
  try {
    const { hostname, pathname } = new URL(url)
    const label = `${hostname}${pathname}`.replace(/\/$/u, '')
    return [
      `Click to begin OAuth flow: [${label}](${url})`,
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
  method?: string,
): Promise<CommandResult> {
  const key = keyFor(entries, flow)
  if (typeof key === 'object' && 'kind' in key) return key
  if (Object.hasOwn(providerProfiles(ctx), flow)) {
    return {
      kind: 'error',
      text: `${flow} already exists in Settings > Models. Remove that provider there before activating it again.`,
    }
  }
  const existing = attempts.get(key)
  if (existing !== undefined && existing.settlement === undefined) {
    if (existing.notice?.url !== undefined) return { kind: 'success', text: oauthLink(existing.notice.url, flow) }
    return { kind: 'success', text: `${flow} authorization is still starting.` }
  }
  await ctx.settings.mutate(SETTINGS_NS, [{ op: 'set', path: ['providers', flow], value: {} }])
  try {
    const notice = await awaitUrl(startAttempt(ctx, attempts, key, method))
    return { kind: 'success', text: notice.url === undefined ? notice.message : oauthLink(notice.url, flow) }
  } catch (error: unknown) {
    await ctx.settings.mutate(SETTINGS_NS, [{ op: 'unset', path: ['providers', flow] }])
    if (error instanceof AuthorizationError) return { kind: 'error', text: error.message }
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

async function authorize(ctx: Context, attempts: Map<CredentialKey, Attempt>, invocation: CommandInvocation): Promise<CommandResult> {
  const words = invocation.rawInput.trim().split(/\s+/u).filter(Boolean)
  const [action, argument, extra] = words
  const entries = ctx.authorization.list().filter(entry => flowName(entry.key) !== undefined)
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
    return activate(ctx, attempts, entries, argument, extra)
  }
  if (action === 'deactivate' && words.length <= 2) return deactivate(ctx, attempts, entries, argument)
  return { kind: 'error', text: USAGE }
}

/** Register the provider-neutral authorization command. */
export function apply(ctx: Context): void {
  const attempts = new Map<CredentialKey, Attempt>()
  ctx.effect(() => () => {
    for (const attempt of attempts.values()) attempt.controller.abort()
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-authorization'),
    name: 'oauth',
    description: 'List, activate, cancel, or deactivate provider authorization flows',
    input: { hint: 'available [STRING] | active | pending | activate FLOW [METHOD] | cancel [FLOW] | deactivate [FLOW]' },
    recordInput: true,
    handler: invocation => authorize(ctx, attempts, invocation),
  })
}
