# chatDeepDoc validation guide

English | [中文](README.zh.md)

This directory records the design and implementation documents for ChatHub's browser plan. This page gives the manual validation steps for the host-layer `WebChatTransport` implementation ([`packages/experimental/chathub-host`](../packages/experimental/chathub-host/README.md); design in [WebChat_design.md](WebChat_design.md)).

## Coverage

| Layer | Automatable | Means |
|---|---|---|
| Driver merging, `open` semantics, failure tokens, completion detection, profile lock, turn serialization | Yes | Unit tests (injected fake pages and launcher) |
| Cordis service, Remote registration, disposal, managed/cdp, login cancellation | Yes | Unit tests (`vi.mock('playwright-core')`) |
| Composition entry (bundle layer, config schema, plugin resolution) | Yes | `--dump-config` / `--dump-config-schema` and documentation gates |
| Real-site sign-in, real prompt, answer reading | No | Local Chrome plus the script below |

## 1. Automated checks (no browser)

```sh
pnpm exec vitest run packages/experimental/chathub-host/tests --coverage --coverage.include='packages/experimental/chathub-host/src/**'
pnpm exec tsx scripts/run-oxlint.ts packages/experimental/chathub-host
pnpm run build:artifacts
pnpm run build:check
pnpm run test:docs
pnpm run verify-cordis-config
```

Expected:

- All 7 test files and 86 cases pass, and every file under `src/` reports 100% line, branch, and function coverage;
- oxlint prints nothing for `packages/experimental/chathub-host` (zero errors);
- `test:docs` passes all 21 gates; `verify-cordis-config` reports every configuration file passing;
- Both the client and host aggregates of `build:check` pass.

The `lists every shipped provider as not-started without launching Chrome` case proves that mounting the service does not start a browser.

## 2. Composition entry check (no browser)

Confirm the Loader parses `cordis.patch.yml` and composes it:

```sh
pnpm dsh web --dump-config --patch packages/experimental/chathub-host/cordis.patch.yml | tail -20
```

Expect the tail to contain:

```yaml
- id: chathub-host
  name: '@deepseek-ai/dsh-experimental-chathub-host'
  config:
    browser: !!js ...
```

Confirm the configuration resolves through schemastery into a schema:

```sh
pnpm dsh web --dump-config-schema --patch packages/experimental/chathub-host/cordis.patch.yml 2>/dev/null | grep -A2 '"id": "chathub-host"'
```

Expect:

```json
"id": "chathub-host",
"name": "@deepseek-ai/dsh-experimental-chathub-host",
"status": "schema",
```

`status: schema` means that row's `Config` resolved into a schema; `unresolved` or a missing row means the bundle layer was not applied or the plugin name did not resolve.

## 3. Launch the web composition (optional)

```sh
DSH_CHATHUB_PROFILE_DIR=/tmp/chathub-web-profile \
  pnpm dsh web --patch packages/experimental/chathub-host/cordis.patch.yml
```

Expect the Web interface to open normally, and the startup log to have no `chathub-*` errors. `pgrep -af 'chrome.*chathub-web-profile'` should print nothing, because mounting only registers the four adapters and does not start a browser; the browser starts on the first provider call or sign-in. After exit, `/tmp/chathub-web-profile/chathub.lock` should be removed.

## 4. Real-browser check (the manual core)

No client model-switch UI exists in this phase, and the Remote is awkward to call directly, so drive the real site from a transport-layer script; it covers submission, sign-in waiting, and answer polling.

1. Create a temporary script `packages/experimental/chathub-host/manual-check.mts` in the repository (delete it after the check; do not commit it).
2. Paste the following content:

```ts
/* Owner-local manual check: real Chrome, real site. Run from the repo root:
   pnpm exec tsx packages/experimental/chathub-host/manual-check.mts [providerId]
   Delete this file and its profile directory when done. */
import { chromium } from 'playwright-core'
import type { WebChatPayload } from '@deepseek-ai/dsh-experimental-chathub'
import { PlaywrightBrowserRuntime } from './src/runtime.ts'
import { PlaywrightWebChatTransport } from './src/transport.ts'
import { resolveSiteDrivers } from './src/drivers.ts'
import type { Config } from './src/types.ts'

const providerId = process.argv[2] ?? 'deepseek-web'
const config: Config = {
  browser: {
    mode: 'managed',
    profileDir: process.env.DSH_CHATHUB_PROFILE_DIR ?? '/tmp/chathub-manual-profile',
    headless: false,
  },
  loginTimeoutMs: 300_000,
  turnTimeoutMs: 180_000,
  actionTimeoutMs: 15_000,
  pollMs: 500,
  stablePolls: 3,
  maxQueuedTurns: 2,
  typeDelayMs: 0,
}
const drivers = resolveSiteDrivers({})
const driver = drivers[providerId]
if (driver === undefined) throw new Error(`no shipped driver: ${providerId}`)
const runtime = new PlaywrightBrowserRuntime(
  config.browser,
  { actionTimeoutMs: config.actionTimeoutMs, pollMs: config.pollMs },
  chromium,
)
const transport = new PlaywrightWebChatTransport(runtime, { ...config, drivers: {} }, drivers)

const signedIn = await runtime.login(providerId, driver, config.loginTimeoutMs, new AbortController().signal)
console.log(`[${providerId}] signed in: ${signedIn}`)

const opened = await transport.open(providerId)
if (opened === undefined) throw new Error('transport.open returned undefined')
if ('closed' in opened) {
  console.log(`[${providerId}] no session: ${opened.reason}`)
} else {
  const payload: WebChatPayload = {
    providerId,
    system: '',
    messages: [],
    prompt: 'Reply with exactly: ok',
    meta: { origin: 'raw-messages' },
  }
  const answer = await opened.send(payload)
  console.log(`[${providerId}] answer: ${answer.content}`)
}

await transport.dispose()
```

3. Run it (pick any of the four ids: `deepseek-web`, `chatgpt-web`, `gemini-web`, `doubao-web`):

```sh
pnpm exec tsx packages/experimental/chathub-host/manual-check.mts deepseek-web
```

4. The first run opens Chrome on the site page and the script waits up to `loginTimeoutMs` (5 minutes by default). Finish signing in inside the window and the script continues on its own; no rerun is needed.
5. Expected output:

```
[deepseek-web] signed in: true
[deepseek-web] answer: ok
```

If the workstation has no default Chrome, name the binary explicitly (inside `browser`, beside `headless`):

```ts
executablePath: '/usr/bin/google-chrome',
```

## 5. Common failures and their meaning

Script errors start with a stable token; site text stays only in `cause`:

| token | meaning | handling |
|---|---|---|
| `chathub-signed-out` | The page closed or redirected to a sign-in or sign-out page | Run again and sign in inside the window |
| `chathub-turn-timeout` | One turn did not settle within `turnTimeoutMs` | Check whether the site is still generating, and raise the timeout if needed |
| `chathub-ui-drift` | The input or answer container selector stopped matching | The site changed; update the `drivers` override or `DEFAULT_SITE_DRIVERS` |
| `chathub-profile-locked` | Another Host process holds the same profile directory | Close the old process or point `DSH_CHATHUB_PROFILE_DIR` elsewhere |
| `chathub-browser-unavailable` | Chrome is missing, failed to launch, or the runtime was disposed | Install Chrome or set `executablePath` |
| `chathub-busy` | Queued turns for one key exceed `maxQueuedTurns` | Wait for the active turn or raise the queue bound |
| `chathub-network` | A page request failed on the network | Check the network or proxy |

## 6. Cleanup

```sh
rm packages/experimental/chathub-host/manual-check.mts
rm -rf /tmp/chathub-manual-profile
```

Sign-in state lives only in the profile directory's cookies and localStorage; it is never written to session state, logs, or events. Deleting the profile signs out completely.

## 7. Not covered in this phase

- Client model switching and `ChatHubController` (step 8 of section 17 in the design document; not implemented yet);
- The end-to-end path that calls `webChat.providers/login/reauthenticate` through the browser-side `/api` Remote channel, which needs a client UI or a direct call carrying a Peer identity;
- Automated regression for the four sites still runs manually through [`packages/experimental/chathub/scripts/real-browser/validate.mts`](../packages/experimental/chathub/scripts/real-browser/validate.mts) (site selectors and ChatHub normalization codes), a different layer from what this package's script checks.
