# ChatHub

[English](chathub.md) | 中文

ChatHub 把一段对话带过多个网页对话站点：用户只需登录一次 DeepSeek Chat、ChatGPT、Gemini、豆包、通义千问或 GLM，harness 就驱动由此得到的页面，而不是 API。三个包分担这件事——[`chathub`](../../packages/experimental/chathub/README.zh.md) 拥有与提供方无关的会话状态以及切换模型所需的交接，[`chathub-host`](../../packages/experimental/chathub-host/README.zh.md) 拥有 Chromium 页面、登录态与按页面的轮次队列，[`client-ui-chathub`](../../packages/experimental/client-ui-chathub/README.zh.md) 渲染面板。第四个包 [`llm-chathub`](../../packages/experimental/llm-chathub/README.zh.md) 借用同一个传输层，把站点发布成一条普通 LLM 路由。这里没有任何东西随 profile 发布：宿主层通过自己的 `cordis.patch.yml` 按需启用，挂载只注册适配器，不启动 Chrome。

## 会话状态与交接

ChatHub 会话不是 harness 会话，也从不进入 harness 会话日志。它的记录保存目标、计划、记忆条目、语义上下文、检查点、提供方历史与时间线；`ContextCompiler` 从该记录推导出与提供方无关的上下文，并按提供方渲染三种详细度的提示，`CheckpointService` 在每次切换前快照同一份状态。`SessionManager.switchProvider` 先写检查点，再编译目标提供方的上下文与提示，最后记录切换，因此目标提供方读到的是已经备好的交接，而无需自己协商。记录持久化在 `chathub` 存储域，与 harness 自己的压缩与溢写状态彼此隔离。

## 浏览器传输

`WebChatTransportService` 实现 `WebChatTransport.open(providerId, sessionKey)`，在站点未登录时返回 `{ closed: true, reason: 'not-signed-in' }`，让提供方停在 `needs-auth`，而不是记一次失败。页面键缺省等于提供方 id，因此同一提供方的所有对话共用一个页面及其站点侧历史；`llm-chathub` 适配器每次尝试自带键，这正是重试等于全新站点会话的原因。同一键上的轮次在 `maxQueuedTurns` 之后排队按序执行，登录始终打开可见窗口；完成判定是在剥离站点的思考占位后，回答容器连续 `stablePolls` 次读到同一内容。回答按 markup 读取，因此强调、列表、表格、代码与图片都能留到面板。传输失败以稳定 token 呈现而不是站点原文：`chathub-signed-out`、`chathub-driver-missing`、`chathub-ui-drift`、`chathub-turn-timeout`、`chathub-busy`、`chathub-network`、`chathub-profile-locked` 与 `chathub-browser-unavailable`。

## 面板表面

面板通过两个 Remote 命名空间访问宿主。`chatHub` 暴露 `state`、`resume`、`create`、`send`、`switch`、`read`、`history`、`timeline` 与 `forget`，每次调用都返回 `RemoteResult`，面板取值前统一解包；`webChat` 暴露 `providers`、`login` 与 `reauthenticate`。草稿与选中的提供方由面板拥有，因此模型切换在发送消息时生效，而不是在下拉框变化时生效，会话把这次切换记为一条时间线条目。助手气泡直接渲染回答 markup，并标注提供方名称与到达时间。

## 复用传输层作为 LLM 路由

`llm-chathub` 依赖同一个传输层，不自带浏览器。它把每个智能体步骤渲染成一段自包含提示，每次尝试打开新的页面键，把回答解析成文本加最多一个工具调用，并交给 harness 循环执行工具——于是不能 function calling 的站点也能分步修改代码仓库。两条链路彼此独立：适配器从不经过 `ChatHubController`、`SessionManager` 或 `ContextCompiler`；面板与适配器共用一个 Chrome profile 和一条轮次队列，因此它们是串行而非并发的。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxchathub--chathubcontroller"></a>

### `ctx.chatHub` — `ChatHubController`

The `chatHub` Remote service: session CRUD, one-turn sends, checkpointed model switches, and restart recovery over the `chathub` storage domain. ChatHub messages never enter Harness session logs; they live only here.

```ts cordis-catalog
/**
 * Read every provider's identity and panel-facing status plus the session list.
 * @returns The panel state; sessions are restored from storage on first read.
 */
@Remote async state(): Promise<ChatHubPanelState>

/**
 * Restore every persisted session from storage, then read the panel state.
 * Idempotent: adopting a stored session rewrites its runtime state.
 * @returns The restored panel state.
 */
@Remote async resume(): Promise<ChatHubPanelState>

/**
 * Create a session bound to a registered provider and persist it.
 * @param input - Title, goal, and starting provider.
 * @returns The new session's view.
 * @throws ChatHubError with `provider-not-registered` when the provider is unknown.
 */
@Remote async create(input: ChatHubCreateInput): Promise<ChatHubSessionView>

/**
 * Run one turn: persist the user message, ask the current provider, persist
 * the answer. A failed turn keeps the user message and a stable
 * `provider: code` error and writes no assistant message.
 * @param sessionId - Session the turn belongs to.
 * @param content - User message text.
 * @returns The turn outcome.
 * @throws ChatHubError when the session is unknown or its provider unregistered.
 */
@Remote async send(sessionId: string, content: string): Promise<ChatHubTurnResult>

/**
 * Switch the session's provider through the checkpointed handoff: the
 * checkpoint, canonical context, compiled prompt, provider update, and
 * timeline entry all happen inside the session manager before persistence.
 * The switch leaves the session idle, awaiting its next turn.
 * @param sessionId - Session to switch.
 * @param providerId - Target provider; must be registered and ready.
 * @param reason - User-visible reason recorded in history and the checkpoint.
 * @returns The switch outcome.
 * @throws ChatHubError when the session or provider is unknown, the provider
 *   is not ready, or it already owns the session.
 */
@Remote async switch(sessionId: string, providerId: string, reason: string): Promise<ChatHubSwitchResult>

/**
 * Read one session's stored messages for a panel that renders the transcript.
 * @param sessionId - Session whose messages to read.
 * @returns The session's messages in conversation order.
 * @throws ChatHubError with `session-not-tracked` when the session is unknown.
 */
@Remote async history(sessionId: string): Promise<ChatMessage[]>

/**
 * Read one session's recorded timeline for a panel that shows switches and status changes.
 * @param sessionId - Session whose timeline to read.
 * @returns The session's timeline entries in recording order.
 * @throws ChatHubError with `session-not-tracked` when the session is unknown.
 */
@Remote async timeline(sessionId: string): Promise<SessionTimelineEntry[]>

/**
 * Read one session's full panel view, including the goal and provider history
 * the switch handoff preserves.
 * @param sessionId - Session to read.
 * @returns The session's view.
 * @throws ChatHubError with `session-not-tracked` when the session is unknown.
 */
@Remote async read(sessionId: string): Promise<ChatHubSessionView>

/**
 * Delete a session and every projected message, timeline, and checkpoint row.
 * @param sessionId - Session to delete.
 * @throws ChatHubError with `session-not-tracked` when the session is unknown.
 */
@Remote async delete(sessionId: string): Promise<void>
```

Source: [`packages/experimental/chathub-host/src/controller.ts`](../../packages/experimental/chathub-host/src/controller.ts)

<a id="ctxwebchattransport--webchattransportservice"></a>

### `ctx.webChatTransport` — `WebChatTransportService`

Host-owned browser transport service.

Providers stay registered but unstarted until a Remote call or login needs them, so mounting this service never launches Chrome. Health probing stops at `not-started` until the user signs in, making the browser opt-in per provider.

```ts cordis-catalog
/**
 * Read every shipped provider's identity and current health.
 *
 * Health probing never opens a browser, so an unstarted provider reports
 * `not-started` and a signed-out one reports `needs-auth`.
 * @returns One view per shipped provider, in adapter order.
 */
@Remote async providers(): Promise<WebChatProviderView[]>

/**
 * Hand the shared transport to a model route that does not go through the
 * panel.
 *
 * The ChatHub LLM adapter drives the same sites from the agent loop, so it
 * must reuse this transport: a second one would mean a second browser
 * profile, a second login, and two queues competing for one Chrome.
 * @returns The session opener, exposing no page or runtime handle.
 */
transportForAdapter(): WebChatTransport

/**
 * Open a headful page so the user can sign in, then reopen the provider.
 * @param providerId - provider whose site the user signs in on.
 * @param signal - Client cancellation; cancelling leaves the provider `needs-auth`.
 * @returns The provider's health after sign-in, or its current health when the
 *   user cancelled or the page closed before the chat input appeared.
 * @throws BrowserTransportError with `chathub-driver-missing` for an unregistered provider.
 */
@Remote async login(providerId: string, signal: AbortSignal): Promise<ProviderHealth>

/**
 * Close the provider's session and open it again under the current login state.
 * @param providerId - provider to reopen.
 * @returns The provider's health after the reopen attempt.
 * @throws BrowserTransportError with `chathub-driver-missing` for an unregistered provider.
 */
@Remote async reauthenticate(providerId: string): Promise<ProviderHealth>
```

Source: [`packages/experimental/chathub-host/src/index.ts`](../../packages/experimental/chathub-host/src/index.ts)

<a id="chathub-llm-events"></a>

### `chathub-llm/*` events

<a id="chathub-llmturn--emit"></a>

#### `chathub-llm/turn` — emit

One completed ChatHub LLM turn, for budgeting and drift diagnosis.

```ts cordis-catalog
/**
 * One completed ChatHub LLM turn, for budgeting and drift diagnosis.
 * @mode emit
 * @param record - lengths, tool name, and outcome; never prompt or answer text.
 */
'chathub-llm/turn'(record: ChatHubTurnObservation): void
```

Source: [`packages/experimental/llm-chathub/src/index.ts`](../../packages/experimental/llm-chathub/src/index.ts)
<!-- END GENERATED cordis-surface -->
