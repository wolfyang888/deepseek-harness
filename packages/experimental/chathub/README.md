---
description: "Provider-agnostic multi-model sessions that hand a task's objective, plan, facts, and history to the next provider on a model switch."
kind: "package-library"
---

# @deepseek-ai/dsh-experimental-chathub

English | [中文](README.zh.md)

## Summary

`dsh-experimental-chathub` keeps one task coherent while its user moves between models: it records what the task aims at, the plan, facts, open questions, and decisions, then renders that handoff for whichever provider takes the next turn. Registering providers behind one adapter lets the router pick a capable model per turn, fall back when a call fails, and write a checkpoint before every switch. This is a library — no profile mounts it and no `cordis.yml` row names it. It ships browser adapters for DeepSeek Chat, ChatGPT, Gemini, Doubao, Qianwen, and GLM; the host supplies the signed-in browser transport they drive.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to choose it

Choose this library when one conversation must continue across providers without losing the task, for example a coding turn on a reasoning model followed by a long-context review elsewhere. A host supplies browser automation and UI: the shipped adapters drive a `WebChatTransport` the host implements, and other providers arrive through the same `IModelProvider` seam. Reach for the `dsh-llm` seam instead when a single configured model per session is enough; this package adds cross-provider handoff, not provider transport.

### Entry point

```ts
import {
  CheckpointService,
  ChatHubError,
  ContextCompiler,
  DeepSeekWebProvider,
  ModelRouter,
  ProviderRegistry,
  SessionManager,
  SessionTimelineService,
} from '@deepseek-ai/dsh-experimental-chathub'
import type { WebChatTransport } from '@deepseek-ai/dsh-experimental-chathub'
```

A host implements the browser transport for its own sign-in and page isolation, then registers the shipped adapters:

```ts
import { DeepSeekWebProvider, ProviderRegistry } from '@deepseek-ai/dsh-experimental-chathub'
import type { WebChatTransport, WebChatTransportSession } from '@deepseek-ai/dsh-experimental-chathub'

declare function yourSignedInPage(providerId: string, sessionKey?: string): Promise<WebChatTransportSession | undefined>

const transport: WebChatTransport = {
  open: (providerId, sessionKey) => yourSignedInPage(providerId, sessionKey),
}
const provider = new DeepSeekWebProvider(transport)
const registry = new ProviderRegistry()
await provider.init()
registry.register(provider)
```

`init` reports readiness through the site login state: `open` returns `undefined` while the user still has to sign in. `webProviderAdapters` maps `deepseek-web`, `chatgpt-web`, `gemini-web`, and `doubao-web` to constructors for hosts that build providers from configuration. Every constructor also takes `WebProviderOverrides` — capability flags, prompt heading, and extra site failure rules — so a host applies the same configuration to any shipped adapter. When the user signs in again, `ProviderRegistry.reauthenticate(providerId)` reopens the provider and reports its new health; `ProviderRegistry.health(providerId)` returns one provider's health record for a status view. A failed probe reports a stable `ProviderErrorCode` in `failureReason`, never the site's raw message.

The common path registers providers, creates a session, and hands the next turn to a router:

```ts
import {
  CheckpointService,
  ContextCompiler,
  ProviderRegistry,
  SessionManager,
  SessionTimelineService,
} from '@deepseek-ai/dsh-experimental-chathub'
import type { ChatMessage, IModelProvider } from '@deepseek-ai/dsh-experimental-chathub'

declare const deepseekProvider: IModelProvider
declare const geminiProvider: IModelProvider
declare const userMessage: ChatMessage

const registry = new ProviderRegistry()
registry.register(deepseekProvider)
registry.register(geminiProvider)
const manager = new SessionManager({
  registry,
  compiler: new ContextCompiler(),
  checkpoints: new CheckpointService(),
  timeline: new SessionTimelineService(),
})
const session = manager.create({ title: 'Fix the build', goal: 'fix the build error', provider: 'deepseek-web' })
const request = manager.buildRequest(session, { messages: [userMessage] })
const outcome = await manager.switchProvider(session, 'gemini-web', 'need long-context review')
```

`switchProvider` writes a checkpoint for the outgoing provider, compiles the semantic context for the incoming one, records the switch, and returns the rendered prompt so the caller can send it. `ModelRouter.route` chooses a provider for `coding`, `research`, or `quick-answer` turns; `ModelRouter.complete` sends the turn, retries transient failures within one provider when a `RetryPolicy` is configured, then falls back down the candidate order. `SessionMemoryService` records facts, preferences, plans, decisions, and open questions on the session those services read, and `SessionMemoryService.compact` bounds a long session's memory by importance and recency. `SessionTimelineService` records session creation, provider switches, status changes, and memory writes as ordered entries on the session for a host view or replay.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The session record is the canonical state: goal, plan, memory entries, semantic context, checkpoints, provider history, and timeline. `ContextCompiler` derives the provider-independent context from it and renders one of three prompt details — `full`, `compact`, or `detailed` — selected per provider. `CheckpointService` snapshots the same state before a switch, so history never depends on a provider's own conversation memory. `ModelRouter` builds its candidate order from configured routing, the per-turn preference, capability flags, configured fallbacks, then the remaining registry entries, and skips candidates that fail readiness or an `undefined` lookup; a host-supplied `RetryPolicy` lists the failure codes that justify another attempt on the same provider before the router moves on. `WebModelProvider` is the browser adapter base: it folds system text, renders the provider-styled prompt, wraps transport failures as `provider-call-failed`, and streams deltas when the session offers them. Each shipped adapter supplies one `WebProviderConfig` — identity, capabilities, prompt heading, and site-specific failure rules — that the shared base class consumes, so adapters differ only in configuration and hosts override it uniformly.

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | Provider, request, context, checkpoint, memory, and runtime-state declarations |
| [`src/provider-registry.ts`](src/provider-registry.ts) | Provider registration, lookup, and readiness probing |
| [`src/session-memory.ts`](src/session-memory.ts) | Memory writes, plan updates, and the shared derived fact/highlight helpers |
| [`src/context-compiler.ts`](src/context-compiler.ts) | Provider-independent context derivation and the full, compact, and detailed prompt renderers |
| [`src/checkpoint.ts`](src/checkpoint.ts) | Pre-switch checkpoint snapshots |
| [`src/model-router.ts`](src/model-router.ts) | Task routing and fallback execution |
| [`src/providers/web-provider.ts`](src/providers/web-provider.ts) | Browser transport seam, request normalization, prompt rendering, and the adapter base class |
| [`src/providers/deepseek-web.ts`](src/providers/deepseek-web.ts) | DeepSeek Chat adapter |
| [`src/providers/chatgpt-web.ts`](src/providers/chatgpt-web.ts) | ChatGPT adapter |
| [`src/providers/gemini-web.ts`](src/providers/gemini-web.ts) | Gemini adapter |
| [`src/providers/doubao-web.ts`](src/providers/doubao-web.ts) | Doubao adapter |
| [`src/providers/qianwen-web.ts`](src/providers/qianwen-web.ts) | Qianwen adapter |
| [`src/providers/glm-web.ts`](src/providers/glm-web.ts) | GLM adapter |
| [`src/providers/adapters.ts`](src/providers/adapters.ts) | Provider-id keyed constructors for the shipped adapters |
| [`src/session-manager.ts`](src/session-manager.ts) | Session creation, request building, model switching, and runtime state |
| [`src/timeline.ts`](src/timeline.ts) | Ordered session timeline entries for host views and replay |
| [`src/ids.ts`](src/ids.ts) | Date-stamped session, checkpoint, memory, and timeline ids |
| [`src/errors.ts`](src/errors.ts) | Typed `ChatHubError` codes |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — experimental status and publication rules.
- [LLM adapters](../../llm/llm/README.md) — the in-process model transport this library deliberately does not replace.
- [Session format status](../../../docs/session-format-status.md) — durable-session compatibility policy a persistence layer for these records must follow.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the host-supplied browser transport that sends the rendered prompt.

#### KV Cache effect

The adapters add no content beyond the prompt they render; a consumer's cached request prefix changes whenever the compiled handoff differs between turns, such as an edited plan, a new fact, or an appended model switch.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Browser transports are not bundled: hosts implement `WebChatTransport` with their own automation and login handling, and cookies or tokens never enter provider code, session state, or logs.
- Web adapters carry text only: `tool` messages are rejected with `unsupported-request`, and declared capabilities describe the payload this adapter sends, not the site's full feature set.
- Sessions, memory, checkpoints, and timeline entries live in memory; nothing persists or reloads them across process restarts.
- Routing uses static capability flags per task type and does not learn from call outcomes.
- Retry attempts and compaction bounds come from the host; the library applies only the policy it is given and ships no default.
- No UI ships; a host consumer owns conversation display and provider selection, using `ProviderRegistry.health`, `ProviderRegistry.reauthenticate`, and the session timeline as its data sources.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
