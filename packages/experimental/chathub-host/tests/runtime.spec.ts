/** Browser runtime: profile locking, page reuse, turn order, login, and teardown. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PlaywrightBrowserRuntime, errorCode } from '../src/runtime.ts'
import { FakeBrowser, FakeContext, FakeLauncher, FakePage } from './support/fake-browser.ts'
import type { BrowserRuntimeConfig, SiteDriverConfig } from '../src/types.ts'

const TIMINGS = { actionTimeoutMs: 10, pollMs: 1 }
const DRIVER: SiteDriverConfig = { url: 'https://fake.test/chat', input: '#prompt', answer: '.answer', submitKey: 'Enter' }
const profiles: string[] = []

afterEach(async () => {
  await Promise.all(profiles.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function profileDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chathub-'))
  profiles.push(dir)
  return dir
}

function managed(dir: string, overrides: Partial<Extract<BrowserRuntimeConfig, { mode: 'managed' }>> = {}): BrowserRuntimeConfig {
  return { mode: 'managed', profileDir: dir, headless: true, ...overrides }
}

async function runtime(config: BrowserRuntimeConfig, launcher = new FakeLauncher()): Promise<{
  runtime: PlaywrightBrowserRuntime
  launcher: FakeLauncher
}> {
  return { runtime: new PlaywrightBrowserRuntime(config, TIMINGS, launcher), launcher }
}

/** Context whose pages report the chat input as visible. */
function signedInContext(launcher: FakeLauncher): void {
  launcher.contextFactory = () => {
    const context = new FakeContext()
    context.pageFactory = () => {
      const page = new FakePage()
      page.visible.add(DRIVER.input)
      return page
    }
    return context
  }
}

it('reads a filesystem error code only from a string field', () => {
  expect(errorCode({ code: 'EPERM' })).toBe('EPERM')
  expect(errorCode({ code: 1 })).toBe('')
  expect(errorCode({ message: 'denied' })).toBe('')
  expect(errorCode('denied')).toBe('')
  expect(errorCode(null)).toBe('')
})

it('launches a persistent context with the configured flags', async () => {
  const dir = await profileDir()
  const { runtime: browser, launcher } = await runtime(managed(dir, { executablePath: '/opt/chrome' }))
  await browser.acquire('deepseek-web', DRIVER)
  expect(launcher.launched).toHaveLength(1)
  expect(launcher.launched[0]?.profileDir).toBe(dir)
  expect(launcher.launched[0]?.options).toEqual({
    headless: true,
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled'],
    executablePath: '/opt/chrome',
  })
  expect((await readFile(join(dir, 'chathub.lock'), 'utf8')).trim()).toBe(String(process.pid))
  await browser.dispose()
})

it('omits executablePath when the host did not configure one', async () => {
  const dir = await profileDir()
  const { runtime: browser, launcher } = await runtime(managed(dir))
  await browser.acquire('deepseek-web', DRIVER)
  expect(launcher.launched[0]?.options).toEqual({
    headless: true,
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled'],
  })
  await browser.dispose()
})

it('passes a configured proxy to the launched Chrome', async () => {
  const dir = await profileDir()
  const { runtime: browser, launcher } = await runtime(managed(dir, { proxy: 'http://127.0.0.1:7890' }))
  await browser.acquire('deepseek-web', DRIVER)
  expect(launcher.launched[0]?.options).toEqual({
    headless: true,
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled', '--proxy-server=http://127.0.0.1:7890'],
  })
  await browser.dispose()
})

it('refuses a profile owned by a live process', async () => {
  const dir = await profileDir()
  await writeFile(join(dir, 'chathub.lock'), `${process.pid}\n`)
  const { runtime: browser } = await runtime(managed(dir))
  await expect(browser.acquire('deepseek-web', DRIVER))
    .rejects.toMatchObject({ token: 'chathub-profile-locked' })
})

it('takes over a lock whose process is gone or unreadable', async () => {
  const dir = await profileDir()
  await writeFile(join(dir, 'chathub.lock'), '999999\n')
  const { runtime: browser } = await runtime(managed(dir))
  await expect(browser.acquire('deepseek-web', DRIVER)).resolves.toBeDefined()
  await browser.dispose()

  const garbage = await profileDir()
  await writeFile(join(garbage, 'chathub.lock'), 'not-a-pid\n')
  const second = await runtime(managed(garbage))
  await expect(second.runtime.acquire('deepseek-web', DRIVER)).resolves.toBeDefined()
  await second.runtime.dispose()

  const zero = await profileDir()
  await writeFile(join(zero, 'chathub.lock'), '0\n')
  const third = await runtime(managed(zero))
  await expect(third.runtime.acquire('deepseek-web', DRIVER)).resolves.toBeDefined()
  await third.runtime.dispose()
})

it('treats an EPERM liveness check as a live owner', async () => {
  const dir = await profileDir()
  await writeFile(join(dir, 'chathub.lock'), '1\n')
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' })
  })
  try {
    const { runtime: browser } = await runtime(managed(dir))
    await expect(browser.acquire('deepseek-web', DRIVER))
      .rejects.toMatchObject({ token: 'chathub-profile-locked' })
  } finally {
    kill.mockRestore()
  }
})

it('reports a lock that cannot be written', async () => {
  const dir = await profileDir()
  await mkdir(join(dir, 'chathub.lock'))
  const { runtime: browser } = await runtime(managed(dir))
  await expect(browser.acquire('deepseek-web', DRIVER))
    .rejects.toMatchObject({ token: 'chathub-profile-locked' })
})

it('releases the lock when the launch fails', async () => {
  const dir = await profileDir()
  const launcher = new FakeLauncher()
  launcher.launchError = new Error('no chrome')
  const { runtime: browser } = await runtime(managed(dir), launcher)
  await expect(browser.acquire('deepseek-web', DRIVER))
    .rejects.toMatchObject({ token: 'chathub-browser-unavailable' })
  launcher.launchError = undefined
  await expect(browser.acquire('deepseek-web', DRIVER)).resolves.toBeDefined()
  await browser.dispose()
})

it('reports a page that cannot be created', async () => {
  const dir = await profileDir()
  const context = new FakeContext()
  context.newPageError = new Error('no tab')
  const launcher = new FakeLauncher()
  launcher.contextFactory = () => context
  const { runtime: browser } = await runtime(managed(dir), launcher)
  await expect(browser.acquire('deepseek-web', DRIVER))
    .rejects.toMatchObject({ token: 'chathub-browser-unavailable' })
  await browser.dispose()
})

it('closes the page when navigation fails', async () => {
  const dir = await profileDir()
  const launcher = new FakeLauncher()
  launcher.contextFactory = () => {
    const context = new FakeContext()
    context.pageFactory = () => {
      const page = new FakePage()
      page.errors.goto = new Error('net::ERR_INTERNET_DISCONNECTED')
      return page
    }
    return context
  }
  const { runtime: browser } = await runtime(managed(dir), launcher)
  await expect(browser.acquire('deepseek-web', DRIVER))
    .rejects.toMatchObject({ token: 'chathub-network' })
  await browser.dispose()
})

it('reuses a live page and replaces a closed one', async () => {
  const dir = await profileDir()
  const launcher = new FakeLauncher()
  const context = new FakeContext()
  launcher.contextFactory = () => context
  const { runtime: browser } = await runtime(managed(dir), launcher)
  const first = await browser.acquire('deepseek-web', DRIVER)
  expect(context.newPageCount).toBe(1)
  await expect(browser.acquire('deepseek-web', DRIVER)).resolves.toBe(first)
  first.isClosed = () => true
  const replacement = await browser.acquire('deepseek-web', DRIVER)
  expect(context.newPageCount).toBe(2)
  expect(replacement).not.toBe(first)
  await browser.release('deepseek-web')
  await browser.release('absent')
  await browser.dispose()
})

it('serializes turns per key and rejects a full queue', async () => {
  const { runtime: browser } = await runtime(managed(await profileDir()))
  const order: string[] = []
  const first = await browser.acquireTurn('deepseek-web', 1)
  order.push('first')
  const waiting = browser.acquireTurn('deepseek-web', 1).then((release) => {
    order.push('second')
    return release
  })
  await expect(browser.acquireTurn('deepseek-web', 0)).rejects.toMatchObject({ token: 'chathub-busy' })
  first()
  first()
  const second = await waiting
  order.push('released')
  second()
  expect(order).toEqual(['first', 'second', 'released'])
  const other = await browser.acquireTurn('chatgpt-web', 1)
  other()
  await browser.dispose()
})

it('waits for an in-flight turn before closing everything', async () => {
  const dir = await profileDir()
  const launcher = new FakeLauncher()
  const context = new FakeContext()
  const page = new FakePage()
  page.visible.add(DRIVER.input)
  context.pageFactory = () => page
  launcher.contextFactory = () => context
  const { runtime: browser } = await runtime(managed(dir), launcher)
  await browser.acquire('deepseek-web', DRIVER)
  const lease = await browser.acquireTurn('deepseek-web', 1)
  const disposed = browser.dispose()
  setTimeout(() => { lease() }, 5)
  await disposed
  expect(context.closeCount).toBe(1)
  expect(page.closeCount).toBe(1)
  await expect(readFile(join(dir, 'chathub.lock'), 'utf8')).rejects.toThrow()
  await expect(browser.acquire('deepseek-web', DRIVER))
    .rejects.toMatchObject({ token: 'chathub-browser-unavailable' })
  await expect(browser.acquireTurn('deepseek-web', 1))
    .rejects.toMatchObject({ token: 'chathub-browser-unavailable' })
  await expect(browser.dispose()).resolves.toBeUndefined()
})

it('opens a temporary headful window for login on a headless service', async () => {
  const dir = await profileDir()
  const launcher = new FakeLauncher()
  signedInContext(launcher)
  const { runtime: browser } = await runtime(managed(dir), launcher)
  await browser.acquire('deepseek-web', DRIVER)
  await expect(browser.login('deepseek-web', DRIVER, 20, new AbortController().signal)).resolves.toBe(true)
  expect(launcher.launched.map(entry => entry.options.headless)).toEqual([true, false])
  expect(launcher.launched[0]?.options.headless).toBe(true)
  expect(launcher.launched[1]?.options.headless).toBe(false)
  await expect(browser.acquire('deepseek-web', DRIVER)).resolves.toBeDefined()
  expect(launcher.launched[2]?.options.headless).toBe(true)
  await browser.dispose()
})

it('reports a successful login on a headful browser', async () => {
  const launcher = new FakeLauncher()
  signedInContext(launcher)
  const { runtime: browser } = await runtime(managed(await profileDir(), { headless: false }), launcher)
  await expect(browser.login('deepseek-web', DRIVER, 20, new AbortController().signal)).resolves.toBe(true)
  expect(launcher.launched.map(entry => entry.options.headless)).toEqual([false])
  await browser.dispose()
})

it('reports a failed login on a headful or attached browser', async () => {
  const launcher = new FakeLauncher()
  const { runtime: browser } = await runtime(managed(await profileDir(), { headless: false }), launcher)
  await expect(browser.login('deepseek-web', DRIVER, 5, new AbortController().signal)).resolves.toBe(false)

  const cdp = new FakeBrowser()
  cdp.contextFactory = () => {
    const context = new FakeContext()
    return context
  }
  const attached = new FakeLauncher()
  attached.browserFactory = () => cdp
  const { runtime: cdpRuntime } = await runtime({
    mode: 'cdp', profileDir: await profileDir(), cdpEndpoint: 'http://localhost:9222', headless: true,
  }, attached)
  await expect(cdpRuntime.login('deepseek-web', DRIVER, 5, new AbortController().signal)).resolves.toBe(false)
  await browser.dispose()
  await cdpRuntime.dispose()
})

it('reuses the user context of an attached browser without closing it', async () => {
  const cdp = new FakeBrowser()
  const userContext = new FakeContext()
  cdp.contextsList.push(userContext)
  const launcher = new FakeLauncher()
  launcher.browserFactory = () => cdp
  const context = await profileDir()
  const { runtime: browser } = await runtime({
    mode: 'cdp', profileDir: context, cdpEndpoint: 'http://localhost:9222', headless: false,
  }, launcher)
  await expect(browser.acquire('deepseek-web', DRIVER)).resolves.toBeDefined()
  expect(launcher.endpoints).toEqual(['http://localhost:9222'])
  expect(userContext.newPageCount).toBe(1)
  await browser.dispose()
  expect(userContext.closeCount).toBe(0)
  expect(cdp.closeCount).toBe(1)
})

it('creates and closes its own context on an attached browser', async () => {
  const cdp = new FakeBrowser()
  const created = new FakeContext()
  cdp.contextFactory = () => created
  const launcher = new FakeLauncher()
  launcher.browserFactory = () => cdp
  const { runtime: browser } = await runtime({
    mode: 'cdp', profileDir: await profileDir(), cdpEndpoint: 'http://localhost:9222', headless: true,
  }, launcher)
  await browser.acquire('deepseek-web', DRIVER)
  await browser.dispose()
  expect(created.closeCount).toBe(1)
  expect(cdp.closeCount).toBe(1)
})

it('reports attachment and context failures', async () => {
  const launcher = new FakeLauncher()
  launcher.cdpError = new Error('connection refused')
  const { runtime: browser } = await runtime({
    mode: 'cdp', profileDir: await profileDir(), cdpEndpoint: 'http://localhost:9222', headless: true,
  }, launcher)
  await expect(browser.acquire('deepseek-web', DRIVER))
    .rejects.toMatchObject({ token: 'chathub-browser-unavailable' })

  const cdp = new FakeBrowser()
  cdp.newContextError = new Error('context refused')
  const second = new FakeLauncher()
  second.browserFactory = () => cdp
  const { runtime: attached } = await runtime({
    mode: 'cdp', profileDir: await profileDir(), cdpEndpoint: 'http://localhost:9222', headless: true,
  }, second)
  await expect(attached.acquire('deepseek-web', DRIVER))
    .rejects.toMatchObject({ token: 'chathub-browser-unavailable' })
  expect(cdp.closeCount).toBe(1)
})

it('ignores teardown failures from an already gone browser', async () => {
  const cdp = new FakeBrowser()
  const created = new FakeContext()
  created.closeError = new Error('already closed')
  cdp.contextFactory = () => created
  cdp.closeError = new Error('already detached')
  const launcher = new FakeLauncher()
  launcher.browserFactory = () => cdp
  const { runtime: browser } = await runtime({
    mode: 'cdp', profileDir: await profileDir(), cdpEndpoint: 'http://localhost:9222', headless: true,
  }, launcher)
  await browser.acquire('deepseek-web', DRIVER)
  await expect(browser.dispose()).resolves.toBeUndefined()
})

it('rejects login after disposal', async () => {
  const { runtime: browser } = await runtime(managed(await profileDir()))
  await browser.dispose()
  await expect(browser.login('deepseek-web', DRIVER, 5, new AbortController().signal))
    .rejects.toMatchObject({ token: 'chathub-browser-unavailable' })
})
