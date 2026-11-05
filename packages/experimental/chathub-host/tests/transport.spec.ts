/** Transport `open` semantics over the browser runtime. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolveSiteDrivers } from '../src/drivers.ts'
import { resolvePacing } from '../src/pacing.ts'
import { PlaywrightBrowserRuntime } from '../src/runtime.ts'
import { PlaywrightWebChatTransport } from '../src/transport.ts'
import type { Config, PacingPolicy, ResolvedConfig, TransportRuntime } from '../src/types.ts'
import { FakeContext, FakeLauncher, FakePage } from './support/fake-browser.ts'

const profiles: string[] = []

afterEach(async () => {
  await Promise.all(profiles.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function config(dir: string, pacing: PacingPolicy = resolvePacing({ profile: 'off' })): ResolvedConfig {
  const base: Config = {
    browser: { mode: 'managed', profileDir: dir, headless: true },
    loginTimeoutMs: 5,
    turnTimeoutMs: 500,
    actionTimeoutMs: 10,
    pollMs: 1,
    stablePolls: 2,
    maxQueuedTurns: 2,
    typeDelayMs: 1,
  }
  // Tests drive many turns back to back; pacing defaults to off unless a case opts in.
  return { ...base, drivers: {}, pacing }
}

async function fixture(visibleInput: boolean, pacing?: PacingPolicy): Promise<{
  transport: PlaywrightWebChatTransport
  runtime: TransportRuntime
  context: FakeContext
}> {
  const dir = await mkdtemp(join(tmpdir(), 'chathub-transport-'))
  profiles.push(dir)
  const launcher = new FakeLauncher()
  const context = new FakeContext()
  context.pageFactory = () => {
    const page = new FakePage()
    if (visibleInput) page.visible.add('textarea')
    return page
  }
  launcher.contextFactory = () => context
  const resolved = config(dir, pacing)
  const runtime = new PlaywrightBrowserRuntime(
    resolved.browser,
    { actionTimeoutMs: resolved.actionTimeoutMs, pollMs: resolved.pollMs },
    launcher,
  )
  return {
    transport: new PlaywrightWebChatTransport(runtime, resolved, resolveSiteDrivers({})),
    runtime,
    context,
  }
}

it('rejects a provider without a site driver', async () => {
  const { transport } = await fixture(true)
  await expect(transport.open('unknown-web'))
    .rejects.toMatchObject({ token: 'chathub-driver-missing' })
  await transport.dispose()
})

it('reports a signed-out site without throwing', async () => {
  const { transport, context } = await fixture(false)
  await expect(transport.open('deepseek-web')).resolves.toEqual({ closed: true, reason: 'not-signed-in' })
  expect(context.pagesList[0]?.closed).toBe(true)
  await transport.dispose()
})

it('holds a second turn until the site envelope allows it', async () => {
  const policy: PacingPolicy = { minTurnGapMs: 40, maxTurnsPerHour: 0, maxWaitMs: 1_000 }
  const { transport } = await fixture(true, policy)
  const started = Date.now()
  const first = await transport.open('deepseek-web')
  const second = await transport.open('deepseek-web')
  expect(Date.now() - started).toBeGreaterThanOrEqual(40)
  if (first !== undefined && 'send' in first) await first.close()
  if (second !== undefined && 'send' in second) await second.close()
  await transport.dispose()
})

it('opens a session on a signed-in page and reuses the page', async () => {
  const { transport, context } = await fixture(true)
  const session = await transport.open('deepseek-web')
  if (session === undefined || 'closed' in session) throw new Error('expected an open session')
  await expect(transport.open('deepseek-web')).resolves.toBeDefined()
  expect(context.newPageCount).toBe(1)
  await session.close()
  expect(context.pagesList[0]?.closed).toBe(true)
  await transport.dispose()
})

it('keeps one page per session key', async () => {
  const { transport, context } = await fixture(true)
  await transport.open('deepseek-web', 'first')
  await transport.open('deepseek-web', 'second')
  expect(context.newPageCount).toBe(2)
  await transport.dispose()
})

it('releases every resource through dispose', async () => {
  const { transport } = await fixture(true)
  await transport.open('deepseek-web')
  await expect(transport.dispose()).resolves.toBeUndefined()
})
