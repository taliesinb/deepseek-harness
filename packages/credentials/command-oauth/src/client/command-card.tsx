/** Compact always-visible command card for `/oauth`. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { CommandRowProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { IconApiOutline14, MarkdownText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// @ts-expect-error CSS is bundled by the Client build face.
import './style.css'

export const inject = ['slots']

const labels = {
  code: { copyLabel: 'Copy', copiedLabel: 'Copied' },
  footnotes: 'Footnotes',
}

function tokens(raw: string | null): string[] {
  return raw?.trim().split(/\s+/u).filter(Boolean) ?? []
}

function isMarkdownLink(value: string): boolean {
  return /\[[^\]]+\]\(https?:\/\/[^)]+\)/u.test(value)
}

/** Match ordinary command-row chrome while keeping the result body permanently visible. */
function OAuthCommandCard({ node }: CommandRowProps) {
  const state = node.outcome === null ? 'running' : node.outcome.kind === 'error' ? 'error' : 'ok'
  const result = node.outcome?.text
  return <div className="dsh-oauth-card" data-state={state}>
    <div className="dsh-oauth-card__row">
      <span className="dsh-oauth-card__icon">
        {state === 'error' ? <StateDot state="error" /> : <IconApiOutline14 size={14} />}
      </span>
      <span className="dsh-oauth-card__title">oauth</span>
      {tokens(node.args).map((token, index) => <span className="dsh-oauth-card__segment" key={`${String(index)}:${token}`}>
        <span className="dsh-oauth-card__separator" aria-hidden />
        <span>{token}</span>
      </span>)}
    </div>
    {result === undefined
      ? <pre className="dsh-oauth-card__body">Working…</pre>
      : isMarkdownLink(result)
        ? <div className="dsh-oauth-card__body dsh-oauth-card__body--link">
          <MarkdownText text={result} labels={labels} variant="compact" />
        </div>
        : <pre className="dsh-oauth-card__body">{result}</pre>}
  </div>
}

/** Register the keyed `/oauth` command renderer. */
export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview',
    key: 'oauth',
  }, OAuthCommandCard))
}
