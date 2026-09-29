---
description: "Action-first provider authorization through `/oauth`, with persisted-state listings, settings route activation, and clickable OAuth cards."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-authorization

English | [中文](README.zh.md)

## Summary

`dsh-command-authorization` provides an action-first command grammar and an always-visible Web command card:

```text
/oauth available [STRING]
/oauth active
/oauth pending
/oauth activate FLOW [METHOD]
/oauth cancel [FLOW]
/oauth deactivate [FLOW]
```

Flow names omit the internal `llm-pi-ai/` credential scope.

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

Activation refuses a provider already present in **Settings > Models**. Otherwise it writes `llm-pi-ai.providers.anthropic: {}` to `settings.yaml`, starts the flow, and returns its browser URL in an always-visible clickable card. The browser callback completes OAuth automatically; there is no `finish` action.

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

Deactivation deletes the stored grant but intentionally leaves the provider route in Settings. Remove or customize that route under **Settings > Models**.

## Understand the implementation

The command delegates protocol work to `ctx.authorization`, grant storage to `ctx.credentials`, and provider-route creation to `ctx.settings`. Callback-capable flows may race a typed prompt against their browser callback; the command leaves a signal-bearing prompt pending until the flow withdraws it. Other typed prompts are declined because one command has one request and one result.

The Client half occupies the `oauth` command-card slot. It renders only the supplied arguments in the summary (`oauth · activate · anthropic`) and renders the full result below without a disclosure step. HTTP(S) results are Markdown links and therefore directly clickable.

## Further Exploration

- [Authorization](../authorization/README.md) — provider-neutral authorization flow lifecycle.
- [Pi AI adapter](../../llm/llm-pi-ai/README.md) — provider discovery, credentials, and request dispatch.
- [Commands](../../interaction/commands/README.md) — slash-command registration and Session bookkeeping.

## Model Experience

The model sees neither the `/oauth` input nor OAuth notices. Authorization changes only credentials available to later requests, adds no request tokens, and does not alter an already-formed KV-cache prefix.

## Known Limitations and Deferred Work

- The command result persists the authorization URL and its short-lived OAuth state in the Session log; treat it as sensitive.
- The Web page and callback browser must reach the same host's callback port.
- Typed codes, secrets, and selections require a future interactive authorization surface.
