---
description: "Own the Chromium pages behind ChatHub's shipped browser providers, with sign-in Remote calls and stable failure codes."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-chathub-host

English | [中文](README.zh.md)

## Summary

Run the browser that ChatHub's DeepSeek Chat, ChatGPT, Gemini, and Doubao adapters need, inside the Host. Mounting the service starts nothing: the first page request, sign-in, or health call opens one persistent profile and reuses one page per provider or conversation key. Turns on one key run in order, extra turns wait within a configured bound, and sign-in always opens a visible window. Site text never becomes a provider error; the transport reports stable tokens that ChatHub maps to its own codes. The package is experimental and opt-in, needs an installed Chrome, and treats `playwright-core` as an optional peer.

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

`WebChatTransportService` implements the `WebChatTransport` that ChatHub's browser adapters accept, registers all four shipped providers, and exposes `providers`, `login`, and `reauthenticate` through the `webChat` Remote namespace. The Host reaches the service as `ctx.webChatTransport`.

### When to choose it

Mount this service when a composition runs [`dsh-experimental-chathub`](../chathub/README.md) browser providers and needs the page ownership, persistent sign-in, and turn order those adapters leave to the host. Choose [`dsh-llm`](../../llm/llm/README.md) when one configured API model per Session is enough; this package drives sites a user signs into and does not add model routing. `managed` mode launches its own persistent profile, while `cdp` mode attaches to a Chrome the user already runs.

### Compose it into a profile

The package ships an opt-in bundle layer, [`cordis.patch.yml`](cordis.patch.yml), declared through its manifest's `dsh.bundle` block and excluded from shipped profiles. Apply it to a source checkout with:

```sh
pnpm dsh web --patch packages/experimental/chathub-host/cordis.patch.yml
```

The layer mounts one `chathub-host` row with environment-driven defaults: `DSH_CHATHUB_PROFILE_DIR` (default `$DSH_HOME/chathub-profile`), `DSH_CHATHUB_HEADLESS`, `DSH_CHATHUB_CDP_ENDPOINT`, `DSH_CHATHUB_EXECUTABLE_PATH`, and one `DSH_CHATHUB_*` variable per timing field. Mounting registers the four adapters without launching Chrome; the browser starts on the first provider call or login.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-chathub-host'
  config:
    browser:
      mode: managed
      profileDir: /path/to/chrome-profile
      headless: true
    loginTimeoutMs: 300000
    turnTimeoutMs: 180000
    actionTimeoutMs: 15000
    pollMs: 500
    stablePolls: 3
    maxQueuedTurns: 2
    typeDelayMs: 0
```

| Field | Default | Meaning |
|---|---|---|
| `browser.mode` | required | `managed` launches a persistent profile; `cdp` attaches to an existing Chrome |
| `browser.profileDir` | required | Directory holding the persistent profile and its `chathub.lock` |
| `browser.executablePath` | system Chrome | Chrome binary for `managed` launches |
| `browser.cdpEndpoint` | required with `cdp` | Remote debugging endpoint to attach to |
| `browser.headless` | required | Window mode for `managed` launches; `login` still opens a visible window |
| `loginTimeoutMs` | required | Longest wait for the chat input during sign-in and `open` |
| `turnTimeoutMs` | required | Deadline for one prompt to produce a stable answer |
| `actionTimeoutMs` | required | Default timeout for page operations |
| `pollMs` | required | Interval for input, login-wall, and answer polling |
| `stablePolls` | required | Consecutive unchanged reads that finish an answer |
| `maxQueuedTurns` | required | Turns allowed to wait behind the active turn of one key |
| `typeDelayMs` | required | Delay between typed characters |
| `drivers` | `{}` | Per-provider selector and polling overrides merged over the shipped drivers |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-chathub-host) is the exhaustive source for every accepted field. A `drivers` key must name a shipped provider, and an empty selector, a poll bound below one, or a `signedOutPath` that does not compile fails at load.

`login` opens a visible page even when `browser.headless` is true, waits up to `loginTimeoutMs` for the chat input, keeps the cookies in the profile, and reopens the provider. `reauthenticate` closes the provider session and opens it again under the current sign-in state. Both report `ProviderHealth`; a cancelled sign-in or a page that closes before the input appears leaves the provider `needs-auth`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`drivers.ts` merges host overrides over the shipped site facts for the four adapters and validates each merged driver before any browser work, so a bad selector fails at load rather than mid-turn. `runtime.ts` reserves `profileDir/chathub.lock` with the process id, treats an unreadable or dead owner as stale, and refuses a profile held by a live process; it opens one context — a managed persistent launch or a CDP attachment — records one page per key, and serializes turns per key through a promise chain with a bounded wait queue. Disposal waits for in-flight turns, closes pages and the context it owns, and removes the lock.

`page.ts` polls for element visibility and answer text instead of `waitForSelector`, because CDP attachments and contenteditable inputs are unreliable under Playwright's selector waits. It maps Playwright failures to stable tokens: a closed page or destroyed execution context reports `chathub-signed-out`, transport failures report `chathub-network`, and everything else reports `chathub-ui-drift`. `session.ts` clicks the input center, inserts the prompt as one text insertion, presses the submit key, and polls the last answer container until its text is unchanged for `stablePolls` reads; `stream` yields prefixes of a growing answer and the whole text when the site replaces it, and a whitespace-normalized prompt echo does not count as an answer.

`transport.ts` opens or reuses a page per provider or conversation key and returns `{ closed: true, reason: 'not-signed-in' }` when the site is signed out, which keeps ChatHub probing at `needs-auth` instead of recording a failure. It also exports the failure rules every adapter receives, so transport tokens become provider codes without site text:

| Transport token | Provider code | Meaning |
|---|---|---|
| `chathub-signed-out` | `auth-required` | Sign in again |
| `chathub-driver-missing` | `unsupported-capability` | No driver for this provider |
| `chathub-ui-drift` | `provider-unavailable` | The site changed or the container is missing |
| `chathub-turn-timeout` | `stream-interrupted` | The answer did not finish in time |
| `chathub-busy` | `rate-limited` | The turn queue for this key is full |
| `chathub-network` | `network-error` | The request or page load failed |
| `chathub-profile-locked` | `provider-unavailable` | Another process owns the profile |
| `chathub-browser-unavailable` | `provider-unavailable` | Chrome missing, a page failed to open, or the runtime is disposed |

`index.ts` builds the runtime and transport, registers the four adapters, and loads `playwright-core` on the first browser use, so a composition that never opens a browser does not need it installed.

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | Configuration, driver, browser, and transport-facing interfaces |
| [`src/drivers.ts`](src/drivers.ts) | Shipped site drivers, override merging, and load-time validation |
| [`src/errors.ts`](src/errors.ts) | `BrowserTransportError` and page-error classification |
| [`src/page.ts`](src/page.ts) | Element polling, answer reading, and page-level error mapping |
| [`src/session.ts`](src/session.ts) | One-turn submission, completion polling, and stream deltas |
| [`src/runtime.ts`](src/runtime.ts) | Profile lock, context ownership, page reuse, and turn serialization |
| [`src/transport.ts`](src/transport.ts) | `WebChatTransport.open` and adapter failure rules |
| [`src/index.ts`](src/index.ts) | `WebChatTransportService` Remote surface and teardown |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ChatHub library](../chathub/README.md) — provider runtime, checkpoints, and the transport contract this package implements.
- [Experimental packages](../README.md) — experimental status and opt-in composition.
- [Architecture](../../../docs/architecture.md) — plugin composition and service registration.
- [Defensive patterns](../../../docs/defensive-patterns/README.md) — lifecycle, concurrency, and teardown requirements this package follows.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the browser pages the shipped adapters drive.

#### KV Cache effect

The transport adds no prompt text of its own: it inserts the prompt that ChatHub's adapter rendered as one text insertion and polls the site's answer container, so each site's own caching follows its own rendering and this package recomputes no prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Chrome is not bundled; the package depends on an installed browser or `browser.executablePath`, and `playwright-core` is an optional peer.
- DOM polling yields paragraph-level deltas, not token-level streaming.
- `WebChatTransportSession` has no per-turn cancellation; closing the page is the only way to stop a turn.
- CDP mode cannot pass launch flags or set a viewport, and selector waits poll instead of using Playwright's selector wait.
- Site selectors are external facts that drift; update the shipped driver or override `drivers` for that provider.
- One Host process owns one profile directory; a live lock rejects the profile, and a stale lock is taken over on the next launch.
- Sign-in always needs a visible window, so a display-less Host must use a pre-signed profile or CDP mode.
- This package owns transport and sign-in only; session orchestration, model switching, and the provider UI belong to separate services.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
