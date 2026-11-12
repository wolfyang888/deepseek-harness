---
description: "Local OpenAI-wire HTTP gateway that exposes mounted ChatHub site routes to external coding agents, with per-site admission and stable failure codes."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-chathub-gateway

English | [中文](README.zh.md)

## Summary

Serve the mounted ChatHub site routes (`glm-web`, `doubao-web`, `gemini-web`, `chatgpt-web`, `qianwen-web`, …) as OpenAI-wire models on a local HTTP port, so external coding agents — Codex, Trae, WorkBuddy, or anything that speaks OpenAI-compatible chat completions — can list and use them through their own model selectors. The gateway owns no browser state and stores nothing: it translates one request into one `ctx.llm` turn on the route the llm-chathub layer already registered, and maps failures into the OpenAI wire with the next action named. Shipped profiles omit it.

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

Mount the gateway after the ChatHub host layer and the llm-chathub adapter; mount order matters because the roster reads the transport health those layers provide:

```sh
pnpm dsh web --patch packages/experimental/chathub-host/cordis.patch.yml \
              --patch packages/experimental/llm-chathub/cordis.patch.yml \
              --patch packages/experimental/chathub-gateway/cordis.patch.yml
```

The row defaults to `127.0.0.1:8787`, exposes every mounted site, and checks no key. Point an OpenAI-compatible agent at it:

```sh
# Codex (~/.codex/config.toml)
model = "glm-web"
model_provider = "chathub"
[model_providers.chathub]
name = "ChatHub"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "chat"
```

Trae and WorkBuddy take the same base URL as a custom OpenAI-compatible provider; `GET /v1/models` lists the site models with their sign-in state. Claude Code needs the Anthropic wire, which is deferred work (see below).

### Configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-chathub-gateway'
  config:
    host: 127.0.0.1
    port: 8787
    apiKey: ''
    sites: []
    maxQueuePerSite: 8
    keepaliveMs: 15000
```

| Field | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | Bind address; loopback keeps the gateway machine-local |
| `port` | `8787` | Bind port |
| `apiKey` | `''` | Bearer key every request must present; empty checks nothing, safe only on a loopback bind |
| `sites` | every health-known site | Mounted site ids to expose; a configured site the transport does not know is dropped from the roster, not listed as needs-auth |
| `maxQueuePerSite` | `8` | Pending requests one site accepts before answering 429 |
| `keepaliveMs` | `15000` | Interval between SSE keepalive writes while a site turn runs |

The bundle layer maps `DSH_CHATHUB_GATEWAY_HOST`, `DSH_CHATHUB_GATEWAY_PORT`, `DSH_CHATHUB_GATEWAY_KEY`, `DSH_CHATHUB_GATEWAY_SITES`, `DSH_CHATHUB_GATEWAY_QUEUE`, and `DSH_CHATHUB_GATEWAY_KEEPALIVE_MS` onto the same fields, defaulting the roster from `DSH_CHATHUB_LLM_SITES` / `DSH_CHATHUB_LLM_SITE`.

### Failure codes

| Site condition | HTTP | Wire `error.code` |
|---|---|---|
| site signed out | 401 | `chathub_signed_out`, message points at the ChatHub panel |
| site throttling | 429 | `rate_limit_exceeded`, with `Retry-After` |
| browser unavailable or driver drifted | 503 | `server_error` |
| site unreachable | 502 | `server_error` |
| reply outside the call protocol after repair | 502 | `server_error` |
| turn timeout | 504 | `timeout` |
| rendered prompt over budget | 400 | `context_length_exceeded` |
| queue for the site full | 429 | `rate_limit_exceeded`, with `Retry-After` |
| model not exposed | 404 | `model_not_found` |

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`openai-wire.ts` is the one translation seam: `toGenerateOptions` folds wire messages (system, user, assistant text and `tool_calls`, tool results) into `GenerateOptions` with adapter-issued call ids preserved, and `toCompletionResponse` / `toSseFrames` unfold the turn's chunks into the completion object or the SSE frame sequence. The first text and the first tool-call block win; the adapter never emits more.

`server.ts` owns the HTTP surface: request routing, bearer checking, the body size cap (32 MiB), and the SSE lifecycle — headers and one keepalive comment open the stream, `keepaliveMs` keeps it alive while the site turn runs, and a failed turn surfaces as a wire error event instead of a lost stream. Model resolution goes through the transport health: a `ready` site answers, a `needs-auth` site answers 401 with the panel hint, and an unlisted model answers 404 with a listing hint.

`queue.ts` counts pending requests per site and answers 429 over `maxQueuePerSite`; sites count independently. `errors.ts` maps the llm runtime's stable failure codes onto HTTP statuses and user-facing messages that name the next action, never raw site prose. `index.ts` resolves the row into configuration and registers the listener with the context effect, so the port closes with the plugin.

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | Configuration, model roster rows, and failure facts |
| [`src/openai-wire.ts`](src/openai-wire.ts) | Wire request folding and response/SSE unfolding |
| [`src/server.ts`](src/server.ts) | HTTP routing, auth, SSE lifecycle, model resolution |
| [`src/queue.ts`](src/queue.ts) | Per-site pending counters with the 429 limit |
| [`src/errors.ts`](src/errors.ts) | Llm failure codes into HTTP and wire errors |
| [`src/index.ts`](src/index.ts) | Cordis plugin, configuration schema, listener lifecycle |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [LLM chathub adapter](../llm-chathub/README.md) — the routes this gateway forwards to, and the call protocol that shapes what comes back.
- [ChatHub browser transport](../chathub-host/README.md) — the browser runtime, sign-in state, and health rows the roster reads.
- [ChatHub design](../../../chatDeepDoc/model.md) — the gateway design document covering all four target agents.

-----

<a id="model-experience"></a>
## Model Experience

None, as the gateway changes representation, not content: the external agent's system prompt, messages, and tool schemas pass through the wire folding unchanged into the llm-chathub adapter, which renders the site prompt exactly as it does for a harness session step.

#### KV Cache effect

No direct effect; each gateway request becomes one adapter turn that opens its own site conversation, exactly as a harness session step does.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Anthropic wire deferred** — Claude Code needs `/v1/messages` with its own SSE event vocabulary; the OpenAI wire covers Codex, Trae, and WorkBuddy first.
- **Pseudo-streaming** — the site transport polls until the answer stabilizes, so a streamed response delivers the whole text at once after the site turn; only the keepalive comments run during the wait.
- **No true usage accounting** — a web answer reports no token counts, so `usage` mirrors whatever the adapter estimated.
- **Queue, not fairness** — per-site admission bounds pending requests but does not reorder them; the host transport still serializes turns on the site page.
- **No request identity across turns** — the gateway stores nothing between calls; the external agent's own history is the conversation.
- **Bearer key is the only auth** — no TLS, no per-client keys; the loopback bind is the boundary. Binding a non-loopback host without a key is a misconfiguration this package does not prevent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The gateway is the fifth ChatHub plugin: it composes the four existing layers without changing them, per the browser-model local-edit track rules. Real-browser verification follows the track's manual-check pattern — a project-sized prompt, two turns of one topic, a legal tool call — through an external agent pointed at the port.

</details>
