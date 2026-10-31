---
description: "Provider-agnostic multi-model sessions that hand a task's objective, plan, facts, and history to the next provider on a model switch."
kind: "package-library"
---

# @deepseek-ai/dsh-experimental-chathub

English | [中文](README.zh.md)

## Summary

`dsh-experimental-chathub` keeps one task coherent while its user moves between models: it records what the task aims at, the plan, facts, open questions, and decisions, then renders that handoff for whichever provider takes the next turn. Registering providers behind one adapter lets the router pick a capable model per turn, fall back when a call fails, and write a checkpoint before every switch. This is a library — no profile mounts it, no `cordis.yml` row names it, and it ships no browser or API providers.

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

Choose this library when one conversation must continue across providers without losing the task, for example a coding turn on a reasoning model followed by a long-context review elsewhere. A host that already owns its providers, browser automation, and UI supplies `IModelProvider` adapters and drives the exported services. Reach for the `dsh-llm` seam instead when a single configured model per session is enough; this package adds cross-provider handoff, not provider transport.

### Entry point

```ts
import {
  CheckpointService,
  ChatHubError,
  ContextCompiler,
  ModelRouter,
  ProviderRegistry,
  SessionManager,
} from '@deepseek-ai/dsh-experimental-chathub'
```

The common path registers providers, creates a session, and hands the next turn to a router:

```ts
const registry = new ProviderRegistry()
registry.register(deepseekProvider)
registry.register(geminiProvider)
const manager = new SessionManager({
  registry,
  compiler: new ContextCompiler(),
  checkpoints: new CheckpointService(),
})
const session = manager.create({ title: 'Fix the build', goal: 'fix the build error', provider: 'deepseek-web' })
const request = manager.buildRequest(session, { messages: [userMessage] })
const outcome = await manager.switchProvider(session, 'gemini-web', 'need long-context review')
```

`switchProvider` writes a checkpoint for the outgoing provider, compiles the semantic context for the incoming one, records the switch, and returns the rendered prompt so the caller can send it. `ModelRouter.route` chooses a provider for `coding`, `research`, or `quick-answer` turns; `ModelRouter.complete` sends the turn and falls back down the candidate order when a provider call fails. `SessionMemoryService` records facts, preferences, plans, decisions, and open questions on the session those services read.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The session record is the canonical state: goal, plan, memory entries, semantic context, checkpoints, and provider history. `ContextCompiler` derives the provider-independent context from it and renders one of three prompt details — `full`, `compact`, or `detailed` — selected per provider. `CheckpointService` snapshots the same state before a switch, so history never depends on a provider's own conversation memory. `ModelRouter` builds its candidate order from configured routing, the per-turn preference, capability flags, configured fallbacks, then the remaining registry entries, and skips candidates that fail readiness or an `undefined` lookup.

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | Provider, request, context, checkpoint, memory, and runtime-state declarations |
| [`src/provider-registry.ts`](src/provider-registry.ts) | Provider registration, lookup, and readiness probing |
| [`src/session-memory.ts`](src/session-memory.ts) | Memory writes, plan updates, and the shared derived fact/highlight helpers |
| [`src/context-compiler.ts`](src/context-compiler.ts) | Provider-independent context derivation and the full, compact, and detailed prompt renderers |
| [`src/checkpoint.ts`](src/checkpoint.ts) | Pre-switch checkpoint snapshots |
| [`src/model-router.ts`](src/model-router.ts) | Task routing and fallback execution |
| [`src/session-manager.ts`](src/session-manager.ts) | Session creation, request building, model switching, and runtime state |
| [`src/ids.ts`](src/ids.ts) | Date-stamped session, checkpoint, and memory ids |
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

Indirectly, through the consumer that sends the rendered handoff prompt.

#### KV Cache effect

The library adds no request content by itself; a consumer's cached request prefix changes whenever the compiled handoff differs between turns, such as an edited plan, a new fact, or an appended model switch.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- No provider adapters ship: every `IModelProvider` is supplied by a host consumer, and browser-session providers remain deferred.
- Sessions, memory, and checkpoints live in memory; nothing persists or reloads them across process restarts.
- Routing uses static capability flags per task type and does not learn from call outcomes.
- No UI ships; a host consumer owns conversation display and provider selection.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
