---
description: "通过操作优先的 `/oauth` 执行提供商授权，支持持久状态列表、设置路由激活和可点击的 OAuth 卡片。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-oauth

[English](README.md) | 中文

## 概述

`dsh-command-oauth` 提供操作优先的命令语法和始终可见的 Web 命令卡片：

```text
/oauth available [STRING]
/oauth active
/oauth pending
/oauth activate FLOW [METHOD]
/oauth cancel [FLOW]
/oauth deactivate [FLOW]
```

流程名称省略内部 `llm-pi-ai/` 凭据作用域，以及恰好一个尾部 `-oauth` 路由后缀。命令只列出和调用提供 `oauth` 方法的流程；API 密钥仍在 **Settings > Models** 中配置。显式方法必须为 `oauth`。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
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

对于目录中每个支持 OAuth 的提供商，OAuth 路由 `<base>-oauth` 及其授权与 `<base>` 及其 API 密钥相互独立。命令使用基础名称，例如 `anthropic`、`github-copilot` 或 `openai-codex`。两种路由可以共存，并在模型选择器中独立显示。激活会保留已有的 OAuth 路由以便重试；如果不存在，Anthropic 示例会把 `llm-pi-ai.providers.anthropic-oauth: {}` 写入 `settings.yaml`，启动流程，并在始终可见且可点击的卡片中返回浏览器 URL。浏览器回调会自动完成 OAuth；不需要 `finish` 操作。不要删除 API 密钥提供商。

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

停用会删除存储的授权，但会有意保留 Settings 中的提供商路由。请在 **Settings > Models** 中删除或自定义该路由。仅在 Settings 中删除路由不会删除存储的授权；使用 `/oauth deactivate anthropic` 清除订阅授权。

<a id="understand-the-implementation"></a>
## 理解实现

命令把协议工作委托给 `ctx.authorization`，把授权存储委托给 `ctx.credentials`，并通过 `ctx.settings` 创建提供商路由。非秘密的前置文本和选择提示使用可选的 `ctx.userQuestions` 服务，严格面向发起命令的活动会话。用户自行选择账户、域名或登录方法；命令不会自动选择选项。文本提示提供显式的 **Use default (empty)** 选项。等待用户回答期间，30 秒浏览器 URL 超时会暂停，回答后继续计时。重复激活会复用待完成的尝试；取消或卸载插件会中止其问题。没有交互式问题服务时，前置提示会返回可操作的错误。支持回调的流程可能让文本提示与浏览器回调竞速；命令会保持带 signal 的提示等待，直到流程撤回它。秘密提示会被拒绝，且不会显示或记录其消息。

Client 部分占用 `oauth` 命令卡片槽位。摘要只显示提供的参数（`oauth · activate · anthropic`），完整结果无需展开即可显示在下方。HTTP(S) 结果以 Markdown 链接呈现，因此可直接点击。设备流程代码与 URL 一同显示，即使收到进度通知后再次激活也会保留。

<a id="further-exploration"></a>
## 延伸阅读

- [Authorization](../authorization/README.zh.md) — 提供商无关的授权流程生命周期。
- [Pi AI 适配器](../../llm/llm-pi-ai/README.zh.md) — 提供商发现、凭据和请求分派。
- [Commands](../../interaction/commands/README.zh.md) — 斜杠命令注册和 Session 记录。

<a id="model-experience"></a>
## 模型体验

### 用户 OAuth 控制

#### 模型看到的内容

`/oauth` 输入、前置问题和直接 OAuth 通知不会进入模型请求。授权改变后续请求可用的凭据。

#### Token 影响

命令及其直接输出不会增加模型 token。

#### KV Cache 影响

命令不会编辑对话历史或已形成的请求。后续请求遵循所选提供商路由的常规传输和缓存行为。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 命令结果会把授权 URL 及其短期 OAuth state 持久化到 Session 日志；请将其视为敏感信息。
- Web 页面和回调浏览器必须能够访问同一 Host 的回调端口。
- 手动粘贴回调代码和秘密提示需要专用的安全授权界面；基于回调的流程会等待浏览器。
- 前置问题需要可选的用户问题服务，以及面向发起命令的活动会话提供回答的人机界面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文。用于手动粘贴回调代码和秘密提示的专用安全界面仍属延后工作；请将其与前置问题分开处理。

</details>
