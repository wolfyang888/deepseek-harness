/** Transport `open` semantics over the browser runtime. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolveSiteDrivers } from '../src/drivers.ts'
import { PlaywrightBrowserRuntime } from '../src/runtime.ts'
import { PlaywrightWebChatTransport } from '../src/transport.ts'
import type { Config, ResolvedConfig, TransportRuntime } from '../src/types.ts'
import { FakeContext, FakeLauncher, FakePage } from './support/fake-browser.ts'

const profiles: string[] = []

afterEach(async () => {
  await Promise.all(profiles.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function config(dir: string): ResolvedConfig {
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
  return { ...base, drivers: {} }
}

async function fixture(visibleInput: boolean): Promise<{
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
  const resolved = config(dir)
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
