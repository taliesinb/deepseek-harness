---
description: "Action-first provider authorization through `/oauth`, with persisted-state listings, settings route activation, and clickable OAuth cards."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-oauth

English | [中文](README.zh.md)

## Summary

`dsh-command-oauth` provides an action-first command grammar and an always-visible Web command card:

```text
/oauth available [STRING]
/oauth active
/oauth pending
/oauth activate FLOW [METHOD]
/oauth cancel [FLOW]
/oauth deactivate [FLOW]
```

Flow names omit the internal `llm-pi-ai/` credential scope and exactly one trailing `-oauth` route suffix. Only flows offering the `oauth` method are listed or invoked; API keys remain in **Settings > Models**. An explicit method must be `oauth`.

## Use this package

List all registered flows, optionally filtered by a case-insensitive substring:

```text
/oauth available
/oauth available anth
```

Start Anthropic subscription OAuth:

```text
/oauth activate anthropic
```

For every OAuth-capable catalog provider, the OAuth route `<base>-oauth` and its grant are separate from `<base>` and its API key. Commands use the base name, such as `anthropic`, `github-copilot`, or `openai-codex`. The two can coexist and appear independently in the model picker. Activation preserves an existing OAuth route for retry; if none exists, the Anthropic example writes `llm-pi-ai.providers.anthropic-oauth: {}` to `settings.yaml`, starts the flow, and returns its browser URL in an always-visible clickable card. The browser callback completes OAuth automatically; there is no `finish` action. Do not remove the API-key provider.

Inspect persisted grants and in-flight flows:

```text
/oauth active
/oauth pending
```

`active` reads the credential provider, so completed grants remain visible after restart. Cancel every pending flow, or one named flow, with:

```text
/oauth cancel
/oauth cancel anthropic
```

An empty cancel reports that there is nothing to cancel. A multi-flow cancellation reports one line per cancelled flow.

List removable grants or delete one:

```text
/oauth deactivate
/oauth deactivate anthropic
```

Deactivation deletes the stored grant but intentionally leaves the provider route in Settings. Remove or customize that route under **Settings > Models**. Removing the route in Settings alone does not delete its stored grant; use `/oauth deactivate anthropic` to forget the subscription authorization.

## Understand the implementation

The command delegates protocol work to `ctx.authorization`, grant storage to `ctx.credentials`, and provider-route creation to `ctx.settings`. Non-secret prerequisite text and selection prompts use the optional `ctx.userQuestions` service in the exact initiating live session. The human chooses the account, domain, or login method; no option is selected automatically. Text prompts offer an explicit **Use default (empty)** option. The 30-second browser-URL timeout pauses while a question is pending and resumes after the answer. Repeating activation reuses the pending attempt; cancellation or plugin unload aborts its question. Without an interactive question service, prerequisite prompts fail with an actionable error. Callback-capable flows may race a typed prompt against their browser callback; the command leaves a signal-bearing prompt pending until the flow withdraws it. Secret prompts are refused without displaying or logging their message.

The Client half occupies the `oauth` command-card slot. It renders only the supplied arguments in the summary (`oauth · activate · anthropic`) and renders the full result below without a disclosure step. HTTP(S) results are Markdown links and therefore directly clickable. Device-flow codes remain visible with the URL, including when activation is repeated after progress notices.

## Further Exploration

- [Authorization](../authorization/README.md) — provider-neutral authorization flow lifecycle.
- [Pi AI adapter](../../llm/llm-pi-ai/README.md) — provider discovery, credentials, and request dispatch.
- [Commands](../../interaction/commands/README.md) — slash-command registration and Session bookkeeping.

## Model Experience

The model sees neither the `/oauth` input nor OAuth notices. Authorization changes only credentials available to later requests, adds no request tokens, and does not alter an already-formed KV-cache prefix.

## Known Limitations and Deferred Work

- The command result persists the authorization URL and its short-lived OAuth state in the Session log; treat it as sensitive.
- The Web page and callback browser must reach the same host's callback port.
- Manually pasted callback codes and secret prompts require a dedicated secure authorization surface; callback-based flows wait for the browser instead.
- Prerequisite questions require the optional user-question service and a human UI answering for the initiating live session.
