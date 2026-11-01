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
    executablePath: process.env.DSH_CHATHUB_EXECUTABLE_PATH ?? '/usr/bin/google-chrome',
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