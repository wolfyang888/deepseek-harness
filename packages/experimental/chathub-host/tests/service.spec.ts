/** Remote service behavior over the lazily imported browser launcher. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebChatTransportService from '../src/index.ts'
import type { Config, SiteDriverConfig } from '../src/types.ts'
import { FakeBrowser, FakeContext, FakePage, sharedLauncher } from './support/fake-browser.ts'

vi.mock('playwright-core', async () => {
  const { sharedLauncher: launcher } = await import('./support/fake-browser.ts')
  return {
    chromium: {
      launchPersistentContext: launcher.launchPersistentContext.bind(launcher),
      connectOverCDP: launcher.connectOverCDP.bind(launcher),
    },
  }
})

const profiles: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(profiles.splice(0).map(path => rm(path, { recursive: true, force: true })))
  sharedLauncher.launched.length = 0
  sharedLauncher.endpoints.length = 0
  sharedLauncher.launchError = undefined
  sharedLauncher.cdpError = undefined
})

function config(dir: string, drivers?: Record<string, Partial<SiteDriverConfig>>): Config {
  const base: Config = {
    browser: { mode: 'managed', profileDir: dir, headless: true },
    loginTimeoutMs: 10,
    turnTimeoutMs: 500,
    actionTimeoutMs: 10,
    pollMs: 1,
    stablePolls: 2,
    maxQueuedTurns: 2,
    typeDelayMs: 1,
  }
  return drivers === undefined ? base : { ...base, drivers }
}

function cdpConfig(dir: string): Config {
  return {
    ...config(dir),
    browser: { mode: 'cdp', profileDir: dir, cdpEndpoint: 'http://localhost:9222', headless: true },
  }
}

/**
 * Build the service over the shared launcher mock.
 * @param options - Visible selectors, per-page setup, and browser attachment mode.
 * @returns The service, its host context, and every context the launcher opened.
 */
async function harness(options: {
  visible?: string[]
  drivers?: Record<string, Partial<SiteDriverConfig>>
  page?: (page: FakePage) => void
  cdp?: boolean
} = {}): Promise<{
  ctx: Context
  service: WebChatTransportService
  opened: FakeContext[]
}> {
  const dir = await mkdtemp(join(tmpdir(), 'chathub-service-'))
  profiles.push(dir)
  const opened: FakeContext[] = []
  const makeContext = (): FakeContext => {
    const context = new FakeContext()
    context.pageFactory = () => {
      const page = new FakePage()
      for (const selector of options.visible ?? ['textarea']) page.visible.add(selector)
      options.page?.(page)
      return page
    }
    opened.push(context)
    return context
  }
  sharedLauncher.contextFactory = makeContext
  sharedLauncher.browserFactory = () => {
    const browser = new FakeBrowser()
    browser.contextFactory = makeContext
    return browser
  }
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('typert', { lookups: { get: () => undefined } } as never)
  // The service declares storageDomain for the ChatHub controller; these specs
  // never touch session persistence, so a loud fake is enough.
  ctx.provide('storageDomain', {
    open: () => Promise.reject(new Error('service.spec never opens the chathub domain')),
  } as never)
  await ctx.plugin(WebChatTransportService, options.cdp === true ? cdpConfig(dir) : config(dir, options.drivers))
  return { ctx, service: ctx.webChatTransport, opened }
}

describe('WebChatTransportService', () => {
  it('lists every shipped provider as not-started without launching Chrome', async () => {
    const { service } = await harness()
    const views = await service.providers()
    expect(views.map(view => view.id)).toEqual(['deepseek-web', 'chatgpt-web', 'gemini-web', 'doubao-web', 'qianwen-web', 'glm-web'])
    expect(views.every(view => view.health.status === 'not-started' && !view.health.ready)).toBe(true)
    expect(sharedLauncher.launched).toHaveLength(0)
  })

  it('rejects login and reauthentication for an unregistered provider', async () => {
    const { service } = await harness()
    await expect(service.login('unknown-web', new AbortController().signal))
      .rejects.toMatchObject({ token: 'chathub-driver-missing' })
    await expect(service.reauthenticate('unknown-web'))
      .rejects.toMatchObject({ token: 'chathub-driver-missing' })
  })

  it('opens a temporary headful page and reports the unchanged health when the user cancels', async () => {
    const { service, opened } = await harness()
    const controller = new AbortController()
    controller.abort()
    const health = await service.login('deepseek-web', controller.signal)
    expect(health).toMatchObject({ providerId: 'deepseek-web', ready: false, status: 'not-started' })
    expect(sharedLauncher.launched.map(launch => launch.options.headless)).toEqual([false])
    expect(opened[0]?.pagesList[0]?.closed).toBe(true)
    expect(opened[0]?.closeCount).toBe(1)
  })

  it('reports the unchanged health when the page closes during sign-in', async () => {
    const { service } = await harness({ visible: [], page: (page) => { page.closed = true } })
    const health = await service.login('deepseek-web', new AbortController().signal)
    expect(health).toMatchObject({ providerId: 'deepseek-web', ready: false, status: 'not-started' })
  })

  it('reports the unchanged health when a login wall stays visible', async () => {
    const { service, opened } = await harness({
      visible: ['#wall'],
      drivers: { 'deepseek-web': { loginWall: '#wall' } },
    })
    const health = await service.login('deepseek-web', new AbortController().signal)
    expect(health).toMatchObject({ providerId: 'deepseek-web', ready: false, status: 'not-started' })
    expect(opened[0]?.pagesList[0]?.closed).toBe(true)
  })

  it('opens the provider after sign-in and probes it as ready', async () => {
    const { service } = await harness()
    const health = await service.login('deepseek-web', new AbortController().signal)
    expect(health).toMatchObject({ providerId: 'deepseek-web', ready: true, status: 'ready' })
    expect(sharedLauncher.launched.map(launch => launch.options.headless)).toEqual([false, true])
    const views = await service.providers()
    expect(views.find(view => view.id === 'deepseek-web')?.health.status).toBe('ready')
  })

  it('rethrows a login failure that is not a signed-out page', async () => {
    const { service } = await harness()
    sharedLauncher.launchError = new Error('launch failed')
    await expect(service.login('deepseek-web', new AbortController().signal))
      .rejects.toMatchObject({ token: 'chathub-browser-unavailable' })
  })

  it('reauthenticates a signed-out provider as needs-auth', async () => {
    const { service } = await harness({ visible: [] })
    const health = await service.reauthenticate('deepseek-web')
    expect(health).toMatchObject({ providerId: 'deepseek-web', ready: false, status: 'needs-auth' })
    expect(sharedLauncher.launched.map(launch => launch.options.headless)).toEqual([true])
  })

  it('treats an omitted driver map as no overrides', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chathub-service-'))
    profiles.push(dir)
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('typert', { lookups: { get: () => undefined } } as never)
    ctx.provide('storageDomain', {
      open: () => Promise.reject(new Error('service.spec never opens the chathub domain')),
    } as never)
    const service = new WebChatTransportService(ctx, config(dir))
    const views = await service.providers()
    expect(views).toHaveLength(6)
  })

  it('opens providers on a browser attached over CDP', async () => {
    const { service, opened } = await harness({ cdp: true })
    const health = await service.reauthenticate('deepseek-web')
    expect(health).toMatchObject({ providerId: 'deepseek-web', ready: true, status: 'ready' })
    expect(sharedLauncher.endpoints).toEqual(['http://localhost:9222'])
    expect(sharedLauncher.launched).toHaveLength(0)
    expect(opened[0]?.pagesList[0]?.closed).toBe(false)
  })

  it('hands the shared transport to a model route without opening a second browser', async () => {
    const { service, opened } = await harness()
    const transport = service.transportForAdapter()
    expect(transport).toBe(service.transportForAdapter())
    expect(sharedLauncher.launched).toHaveLength(0)
    const session = await transport.open('deepseek-web', 'adapter:1')
    expect(session).toBeDefined()
    expect(opened[0]?.pagesList).toHaveLength(1)
  })

  it('releases provider sessions and browser resources on context disposal', async () => {
    const { ctx, service, opened } = await harness()
    await service.reauthenticate('deepseek-web')
    expect(opened[0]?.pagesList[0]?.closed).toBe(false)
    await ctx.fiber.dispose()
    expect(opened[0]?.pagesList[0]?.closed).toBe(true)
    expect(opened[0]?.closeCount).toBe(1)
    expect(sharedLauncher.launched).toHaveLength(1)
  })
})
