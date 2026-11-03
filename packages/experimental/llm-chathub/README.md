---
description: "Run a signed-in web chat site as a text-only tool-calling model route, with one rendered prompt per step, at most one tool call per reply, and path-guarded arguments."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-llm-chathub

English | [中文](README.zh.md)

## Summary

Turn one signed-in web chat site into an LLM route the harness agent loop can drive. Each step renders one self-contained prompt, because the site rejects tool messages and keeps no usable history: role, system text, whitelisted tool schemas, recent turns, and the verification command. The reply is parsed into text plus at most one validated tool call. Tools, permissions, compaction, and retries stay in the harness, so a site without function calling still codes in steps. Mount it beside the ChatHub host layer, which owns the browser and sign-in. Shipped profiles omit it.

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

Mounting the plugin registers exactly one LLM provider route — `<site>-chathub` unless the row sets `route` — with the display name `ChatHub <site>` and one model id (`web-model` by default). The site picks its own underlying model, so the id is a routing label, not a capability claim: `token-meter` can only estimate usage because a web answer reports no counts.

### When to choose it

Choose this layer when a task must be carried by a site the user already pays for or signs into — DeepSeek Chat, ChatGPT, Gemini, Qianwen, or GLM — and that site refuses function calling. The adapter keeps the harness's own loop, so `read`, `grep`, `glob`, `edit`, `write`, approvals, compaction, and session logging behave exactly as they do with an API model. Choose [`dsh-llm`](../../llm/llm/README.md) with a configured API provider when you need streaming tokens, parallel tool calls, or image input. Do not choose it to run unattended CI: every step needs a signed-in browser.

### Compose it into a profile

The package ships an opt-in bundle layer, [`cordis.patch.yml`](cordis.patch.yml), declared through its manifest's `dsh.bundle` block and excluded from shipped profiles. It needs the ChatHub host layer, which owns the Chromium profile, the sign-in state, and the per-page turn queue, so apply both patches in one launch:

```sh
pnpm dsh web --patch packages/experimental/chathub-host/cordis.patch.yml --patch packages/experimental/llm-chathub/cordis.patch.yml
```

The layer mounts one `llm-chathub` row with environment-driven defaults: `DSH_CHATHUB_LLM_SITE` (default `deepseek-web`), `DSH_CHATHUB_LLM_MODEL`, `DSH_CHATHUB_LLM_ROOT` (default the host process's working directory), `DSH_CHATHUB_LLM_TOOLS` (default `read,grep,glob,edit,write`), and `DSH_CHATHUB_LLM_VERIFY` (default `pnpm run typecheck`). The first agent step opens a page; nothing starts a browser at mount time.

### Configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-llm-chathub'
  config:
    site: deepseek-web
    route: deepseek-web-chathub
    model: web-model
    contextWindow: 32000
    maxPromptChars: 48000
    maxToolResultChars: 6000
    maxSystemChars: 4000
    historyTurns: 8
    allowTools: [read, grep, glob, edit, write]
    denyPaths: ['.git', node_modules, '.env']
    verifyCommands: [pnpm run typecheck]
    workspaceRoot: /path/to/project
    maxToolCallsPerTurn: 1
    repairAttempts: 1
```

| Field | Default | Meaning |
|---|---|---|
| `site` | `deepseek-web` | Site provider id the ChatHub host layer ships |
| `route` | `<site>-chathub` | LLM provider route this row registers |
| `model` | `web-model` | Model id advertised on that route |
| `contextWindow` | `32000` | Declared capacity in tokens; harness compaction plans against it |
| `maxPromptChars` | `48000` | Hard ceiling of one rendered prompt |
| `maxToolResultChars` | `6000` | Ceiling of one tool result inside the prompt |
| `maxSystemChars` | `4000` | Ceiling of the harness system prompt carried into the prompt |
| `historyTurns` | `8` | Recent conversation entries kept verbatim; older ones collapse |
| `allowTools` | `read, grep, glob, edit, write` | Tool names the model may call; every other name is a rejected reply |
| `denyPaths` | `.git, node_modules, .env` | Path segments no argument may address |
| `verifyCommands` | `pnpm run typecheck` | Commands the prompt states as the completion check; the adapter never runs them |
| `workspaceRoot` | the host process's cwd | Absolute root every absolute path argument must stay under |
| `maxToolCallsPerTurn` | `1` | Accepted calls per reply; extra blocks are dropped with a warning |
| `repairAttempts` | `1` | Extra rounds granted to a rejected reply |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-llm-chathub) is the exhaustive source for every accepted field.

### One step through the adapter

| Step | What happens |
|---|---|
| 1 | The loop calls `stream(options)` with the system prompt, messages, and the tool schemas it may use |
| 2 | `renderRequest` folds them into one prompt; entries are dropped oldest-first until it fits `maxPromptChars` |
| 3 | The adapter reads provider health and refuses a signed-out site before a browser opens |
| 4 | `transport.open(site, <site>:<n>)` opens a fresh page, so a retry never appends to the previous attempt's conversation |
| 5 | The page inserts the prompt as one text insertion, submits, and polls until the answer stops changing |
| 6 | `parseAnswer` returns display text plus the single call it accepted, or the reason it rejected the reply |
| 7 | A rejected reply earns one `# CORRECTION` round inside a new page; a second rejection ends the step as a failure |
| 8 | The adapter yields a text block, then a tool-call block and `finish: tool-calls`, so the loop runs the tool itself |

### Failure codes

| Site token | Harness code | Loop reaction |
|---|---|---|
| `chathub-signed-out` | `AUTH` | Stop and ask the user to sign in; never retried |
| `chathub-turn-timeout` | `TIMEOUT` | Retried once on a fresh page |
| `chathub-busy` | `RATE_LIMIT` | Back off, then retry |
| `chathub-ui-drift` | `SERVER` | Stop and report that the site driver needs an update |
| `chathub-browser-unavailable`, `chathub-profile-locked` | `SERVER` | Stop |
| `chathub-network` | `TRANSPORT` | Retried |
| illegal reply after the repair budget | `MALFORMED_RESPONSE` | Stop; the reason names the offending block |
| prompt over budget with no history left | `CONTEXT_WINDOW_EXCEEDED` | Compact instead of retrying |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`render.ts` is the whole context contract: `# ROLE`, an optional `# SYSTEM`, `# TOOLS` with one compact JSON object per whitelisted schema, `# PROTOCOL`, `# PROJECT` (root and verification commands), `# CONVERSATION`, and `# NOW`. Rendering is pure, so a snapshot pins the shape. History is dropped oldest-first and collapses to `[earlier: N entries omitted]`; when even a history-free prompt exceeds `maxPromptChars`, `ChatHubPromptOverflowError` carries `CONTEXT_WINDOW_EXCEEDED` so the loop compacts instead of retrying the same text. Image and file blocks become a one-line placeholder rather than being sent.

`protocol.ts` reads one reply: it finds the `<<<TOOL_CALL` … `TOOL_CALL>>>` delimiters, cuts the first balanced JSON object out of the body while tolerating surrounding prose, and validates the result against the mount's policy. A name outside `allowTools`, arguments that are not an object, an unterminated block, unparseable JSON, or a path argument carrying `..`, a NUL byte, a denied segment, or an absolute location outside `workspaceRoot` are all rejections — returned as a reason, never thrown. A Markdown fence would be the obvious carrier and is deliberately not used: sites re-render fences, add copy buttons, and sometimes keep line numbers, while an unknown token survives as plain text.

`budget.ts` clamps one text by keeping its head and tail and stating the omitted count, because a file's header names it and its tail usually holds the change under review; a budget too small for head, marker, and tail degrades to a plain cut.

`adapter.ts` owns the step: it declares one provider and one model, renders, asks until the reply is legal or `repairAttempts` runs out, reports one observation per step, and emits `block-start`, `text-delta`, `block-end`, then either `finish: stop` or the tool-call block with `finish: tool-calls`. Each attempt allocates a new page key, closes the page in a `finally`, and aborts through the caller's `AbortSignal`. `index.ts` resolves the row into configuration, registers the route through `ctx.llm.registerAdapter`, and emits `chathub-llm/turn` per step — lengths, tool name, rejection reason, duration, dropped entries — never prompt or answer text.

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | Configuration, transport contract, parse and render policy, failure codes |
| [`src/render.ts`](src/render.ts) | `GenerateOptions` into one self-contained prompt |
| [`src/protocol.ts`](src/protocol.ts) | Call-block delimiters, JSON extraction, whitelist and path validation |
| [`src/budget.ts`](src/budget.ts) | Head-and-tail text clamping that states the omitted count |
| [`src/adapter.ts`](src/adapter.ts) | `LlmAdapter` implementation, transport turn, chunk sequence, failure mapping |
| [`src/index.ts`](src/index.ts) | Cordis plugin, configuration schema, route registration, turn event |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ChatHub browser transport](../chathub-host/README.md) — the page ownership, sign-in, and turn queue this adapter borrows.
- [ChatHub library](../chathub/README.md) — the provider runtime and transport contract the host implements.
- [LLM adapters](../../llm/llm/README.md) — the adapter seam and chunk contract this package implements.
- [Experimental packages](../README.md) — experimental status and opt-in composition.

-----

<a id="model-experience"></a>
## Model Experience

### Rendered step prompt

#### What the model sees

Every request is one prompt the adapter composes: fixed `# ROLE` text, the harness system prompt clamped to `maxSystemChars`, the whitelisted tool schemas as one JSON object per line with descriptions clamped to 240 characters, the fixed `# PROTOCOL` text below, `# PROJECT` with the workspace root and the configured verification commands, the recent conversation entries with tool results clamped to `maxToolResultChars`, and `# NOW` carrying the latest user or tool message. Tool calls the loop made earlier appear as `[asked for <tool> <arguments>]` and their results as `tool(<tool>) -> <result>`, so the model reads an ordinary transcript rather than a provider-shaped message list.

##### Protocol block the reply must use

```markdown
To act, reply with exactly one block and nothing else inside it:
<<<TOOL_CALL
{"name":"<tool>","arguments":{...}}
TOOL_CALL>>>
Put any explanation outside the block. Never invent tool output: you only see what the tools returned.
When the task is complete, or when you need the user to decide, reply without a block.
```

#### Token effect

Conditional and capped. The role, protocol, and project text are fixed per mount; tool schemas add one line per whitelisted tool; conversation entries add at most `historyTurns` verbatim lines, because every earlier entry collapses into a single omission line. Each tool result is clamped to `maxToolResultChars` with the omitted count stated, and display text is clamped to 2000 characters per reply. The whole prompt must fit `maxPromptChars` or the request is refused with `CONTEXT_WINDOW_EXCEEDED` instead of being silently truncated.

#### KV Cache effect

Independent per step. Each attempt opens a new site conversation and sends a complete prompt, so no prefix is reused across steps and this package never depends on site-side caching. Within one step the prompt is rendered once; a repair round renders the same prompt again with `# CORRECTION` appended, which is a separate site request rather than an extension of the previous one.

### Correction round

#### What the model sees

Only after a rejection with `repairAttempts` remaining: the same rendered prompt plus a `# CORRECTION` section naming the rejection reason, such as an unclosed block, an unknown tool name, or a path the policy forbids, and asking for a reply in the documented format.

#### Token effect

It doubles the prompt for that step. The budget is unchanged, so a prompt already near `maxPromptChars` still fits, and the round costs one extra site turn.

#### KV Cache effect

Independent: the correction is a new site conversation, so nothing from the rejected attempt is reused.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Text only** — image and file content blocks are replaced with a one-line placeholder; the adapter never sends them, because a web composer has no attachment path this package controls.
- **One call per reply** — the protocol allows a single call block, and extra blocks are dropped with a warning, so a step cannot parallelize independent reads.
- **No usage accounting** — a web answer reports no token counts, so `token-meter` can only estimate and `contextWindow` is a declared value the caller must keep conservative.
- **No cancellation inside a turn** — the transport has no per-turn cancel; the adapter checks `AbortSignal` between prompts and closes the page in a finally block, so an in-flight site turn runs to its own timeout.
- **One browser profile** — agent steps and panel turns share the host profile and queue, so a busy panel delays coding; parallel work needs a second profile directory.
- **Lexical path guard** — `..`, denied segments, NUL bytes, and absolute paths outside `workspaceRoot` are rejected before the call runs, but the guard does not resolve symlinks, and relative paths are judged by the tool that executes them.
- **Whitelist must match shipped tools** — a name in `allowTools` that no mounted tool provides makes those calls fail in the executor, and a tool the loop ships but the whitelist omits is invisible to the model.
- **Site drift breaks the chain** — a selector or layout change surfaces as `SERVER` or `TRANSPORT`, and recovery means updating the ChatHub host driver.
- **No completion verdict** — a reply without a block ends the step as `stop`; whether the task is actually done is judged by the loop and the user, not by this adapter.
- **`verifyCommands` is prompt text** — the adapter never runs it; the loop runs only what the session's approvals allow.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
