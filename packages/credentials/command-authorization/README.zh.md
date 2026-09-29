---
description: "通过操作优先的 `/oauth` 执行提供商授权，支持持久状态列表、设置路由激活和可点击的 OAuth 卡片。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-authorization

[English](README.md) | 中文

## 摘要

`dsh-command-authorization` 提供操作优先的命令语法和始终可见的 Web 命令卡片：

```text
/oauth available [STRING]
/oauth active
/oauth pending
/oauth activate FLOW [METHOD]
/oauth cancel [FLOW]
/oauth deactivate [FLOW]
```

流程名称省略内部 `llm-pi-ai/` 凭据作用域。

## 使用此包

列出所有已注册流程，并可使用不区分大小写的子字符串过滤：

```text
/oauth available
/oauth available anth
```

启动 Anthropic 订阅 OAuth：

```text
/oauth activate anthropic
```

如果提供商已存在于 **Settings > Models**，激活会被拒绝。否则命令把 `llm-pi-ai.providers.anthropic: {}` 写入 `settings.yaml`，启动流程，并在始终可见且可点击的卡片中返回浏览器 URL。浏览器回调会自动完成 OAuth；不需要 `finish` 操作。

检查持久授权和进行中的流程：

```text
/oauth active
/oauth pending
```

`active` 读取凭据提供者，因此重启后仍能看到已完成授权。取消所有待处理流程，或取消一个指定流程：

```text
/oauth cancel
/oauth cancel anthropic
```

没有待处理流程时，命令会明确说明无可取消内容。取消多个流程时，每个被取消流程占一行。

列出可删除授权或删除一个授权：

```text
/oauth deactivate
/oauth deactivate anthropic
```

停用会删除存储的授权，但会有意保留 Settings 中的提供商路由。请在 **Settings > Models** 中删除或自定义该路由。

## 理解实现

命令把协议工作委托给 `ctx.authorization`，把授权存储委托给 `ctx.credentials`，并通过 `ctx.settings` 创建提供商路由。支持回调的流程可能让文本提示与浏览器回调竞速；命令会保持带 signal 的提示等待，直到流程撤回它。其他文本提示会被拒绝，因为一次命令只有一次请求和一次结果。

Client 部分占用 `oauth` 命令卡片槽位。摘要只显示提供的参数（`oauth · activate · anthropic`），完整结果无需展开即可显示在下方。HTTP(S) 结果以 Markdown 链接呈现，因此可直接点击。

## 延伸阅读

- [Authorization](../authorization/README.zh.md) — 提供商无关的授权流程生命周期。
- [Pi AI 适配器](../../llm/llm-pi-ai/README.zh.md) — 提供商发现、凭据和请求分派。
- [Commands](../../interaction/commands/README.zh.md) — 斜杠命令注册和 Session 记录。

## 模型体验

模型看不到 `/oauth` 输入或 OAuth 通知。授权只改变后续请求可用的凭据，不添加请求 token，也不会改变已形成的 KV cache 前缀。

## 已知限制与延后工作

- 命令结果会把授权 URL 及其短期 OAuth state 持久化到 Session 日志；请将其视为敏感信息。
- Web 页面和回调浏览器必须能够访问同一 Host 的回调端口。
- 文本代码、秘密和选择项需要未来的交互式授权界面。
