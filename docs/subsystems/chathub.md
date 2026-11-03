# ChatHub

English | [中文](chathub.zh.md)

ChatHub carries one conversation across browser-backed chat sites: a user signs into DeepSeek Chat, ChatGPT, Gemini, Doubao, Qianwen, or GLM once, and the harness drives the resulting pages instead of an API. Three packages split that work — [`chathub`](../../packages/experimental/chathub/README.md) owns provider-agnostic session state and the handoff a model switch needs, [`chathub-host`](../../packages/experimental/chathub-host/README.md) owns the Chromium pages, the sign-in state, and the per-page turn queue, and [`client-ui-chathub`](../../packages/experimental/client-ui-chathub/README.md) renders the panel. A fourth package, [`llm-chathub`](../../packages/experimental/llm-chathub/README.md), borrows the same transport to publish a site as an ordinary LLM route. Nothing here ships in a profile: the host layer is opt-in through its own `cordis.patch.yml`, and mounting it registers adapters without launching Chrome.

## Session state and the handoff

A ChatHub session is not a harness Session and never enters the harness session log. Its record holds the goal, plan, memory entries, semantic context, checkpoints, provider history, and a timeline; `ContextCompiler` derives the provider-independent context from that record and renders one of three prompt details per provider, and `CheckpointService` snapshots the same state before every switch. `SessionManager.switchProvider` writes the checkpoint first, compiles the incoming provider's context and prompt, then records the switch, so a target provider reads a handoff it never had to negotiate. The records persist in the `chathub` storage domain, which keeps them separate from the harness's own compaction and spill state.

## The browser transport

`WebChatTransportService` implements `WebChatTransport.open(providerId, sessionKey)` and returns `{ closed: true, reason: 'not-signed-in' }` when the site is signed out, which keeps the provider at `needs-auth` instead of recording a failure. A page key defaults to the provider id, so every conversation of one provider shares a page and its site-side history; the `llm-chathub` adapter passes its own key per attempt, which is what makes a retry a fresh site conversation. Turns on one key run in order behind `maxQueuedTurns`, sign-in always opens a visible window, and completion is the answer container reading the same value for `stablePolls` polls after the site's thinking placeholder is stripped. Answers are read as markup, so emphasis, lists, tables, code, and images survive to the panel. Transport failures surface as stable tokens rather than site text: `chathub-signed-out`, `chathub-driver-missing`, `chathub-ui-drift`, `chathub-turn-timeout`, `chathub-busy`, `chathub-network`, `chathub-profile-locked`, and `chathub-browser-unavailable`.

## The panel surface

The panel reaches the host through two Remote namespaces. `chatHub` exposes `state`, `resume`, `create`, `send`, `switch`, `read`, `history`, `timeline`, and `forget`, and every call returns a `RemoteResult` the panel unwraps before use; `webChat` exposes `providers`, `login`, and `reauthenticate`. The panel owns the draft and the selected provider, so a model switch is applied when the message is sent rather than when the selection changes, and the session records that switch as a timeline entry. Assistant bubbles render the answer markup itself and label it with the provider name and the time it arrived.

## Reusing the transport as an LLM route

`llm-chathub` depends on the same transport and adds no browser of its own. It renders each agent step into one self-contained prompt, opens a fresh page key per attempt, parses the reply into text plus at most one tool call, and lets the harness loop run the tools — so a site that cannot call functions still edits a repository in steps. The two chains stay separate: the adapter never goes through `ChatHubController`, `SessionManager`, or `ContextCompiler`, and the panel and the adapter share one Chrome profile and one turn queue, which makes them serial rather than concurrent.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
