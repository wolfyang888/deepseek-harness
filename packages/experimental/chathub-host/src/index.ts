/**
 * Host-owned ChatHub browser transport: runtime, sessions, and the Remote service.
 *
 * The plugin class is declared in this entry module because the Loader and the
 * generated config catalog classify a package by its entry; every other module
 * is re-exported for library consumers and tests.
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  ProviderRegistry,
  webProviderAdapters,
  type ProviderHealth,
  type WebChatTransport,
} from '@deepseek-ai/dsh-experimental-chathub'
import { BrowserTransportError } from './errors.ts'
import { assertEveryAdapterHasDriver, resolveSiteDrivers } from './drivers.ts'
import { PlaywrightBrowserRuntime } from './runtime.ts'
import { PlaywrightWebChatTransport, WEB_TRANSPORT_FAILURE_RULES } from './transport.ts'
import { ChatHubController } from './controller.ts'
import type {
  BrowserContextLike,
  ChromiumLauncher,
  Config,
  ConnectedBrowserLike,
  ResolvedConfig,
  WebChatProviderView,
  WebChatTarget,
} from './types.ts'

export { BrowserTransportError, type BrowserTransportErrorCode } from './errors.ts'
export { DEFAULT_SITE_DRIVERS, assertEveryAdapterHasDriver, resolveSiteDrivers } from './drivers.ts'
export { PlaywrightPage } from './page.ts'
export { PlaywrightBrowserRuntime } from './runtime.ts'
export { PlaywrightChatSession, answerTextOf } from './session.ts'
export { PlaywrightWebChatTransport, WEB_TRANSPORT_FAILURE_RULES } from './transport.ts'
export { ChatHubController, type ChatHubControllerOptions } from './controller.ts'
export {
  chatHubDomainSpec,
  ChatHubRepository,
  chatHubStoredSession,
  chatHubStoredMessage,
  chatHubStoredTimelineEntry,
  chatHubStoredCheckpoint,
  chatHubProviderState,
} from './storage.ts'
export type {
  ChatHubSessionSnapshot,
  ChatHubStoredSession,
  ChatHubStoredMessage,
  ChatHubStoredTimelineEntry,
  ChatHubStoredCheckpoint,
  ChatHubProviderState,
} from './storage.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** ChatHub browser transport Remote controller. */
    webChatTransport: WebChatTransportService
    /** ChatHub session orchestration Remote controller. */
    chatHub: ChatHubController
  }
}

/** Shipped adapter ids; every one has a driver, checked at load. */
function providerIds(): (keyof typeof webProviderAdapters)[] {
  return Object.keys(webProviderAdapters) as (keyof typeof webProviderAdapters)[]
}

/**
 * Load `playwright-core` on first browser use.
 *
 * The package is an optional peer, so a profile that never opens a browser
 * must not require it to be installed.
 * @returns The Chromium launcher face backed by the lazily imported module.
 */
function lazyChromiumLauncher(): ChromiumLauncher {
  let engine: Promise<typeof import('playwright-core')> | undefined
  const chromium = async () => (await (engine ??= import('playwright-core'))).chromium
  return {
    async launchPersistentContext(
      profileDir: string,
      options: { headless: boolean; viewport: null; args: string[]; executablePath?: string },
    ): Promise<BrowserContextLike> {
      const context = await (await chromium()).launchPersistentContext(profileDir, options)
      return context
    },
    async connectOverCDP(endpoint: string): Promise<ConnectedBrowserLike> {
      return await (await chromium()).connectOverCDP(endpoint)
    },
  }
}

/**
 * Host-owned browser transport service.
 *
 * Providers stay registered but unstarted until a Remote call or login needs
 * them, so mounting this service never launches Chrome. Health probing stops
 * at `not-started` until the user signs in, making the browser opt-in per
 * provider.
 */
export class WebChatTransportService extends TypertRemoteService {
  static inject = ['typert', 'storageDomain']

  static Config: z<Config> = z.object({
    browser: z.union([
      z.object({
        mode: z.const('managed').required(),
        profileDir: z.string().min(1).required(),
        executablePath: z.string().min(1),
        headless: z.boolean().required(),
        proxy: z.string().min(1),
      }),
      z.object({
        mode: z.const('cdp').required(),
        profileDir: z.string().min(1).required(),
        cdpEndpoint: z.string().min(1).required(),
        headless: z.boolean().required(),
      }),
    ]).required(),
    loginTimeoutMs: z.natural().min(1).required(),
    turnTimeoutMs: z.natural().min(1).required(),
    actionTimeoutMs: z.natural().min(1).required(),
    pollMs: z.natural().min(1).required(),
    stablePolls: z.natural().min(1).required(),
    maxQueuedTurns: z.natural().min(1).required(),
    typeDelayMs: z.natural().required(),
    drivers: z.dict(z.object({
      url: z.string().min(1),
      input: z.string().min(1),
      answer: z.string().min(1),
      loginWall: z.string().min(1),
      signedOutPath: z.string().min(1),
      submitKey: z.string().min(1),
      stablePolls: z.natural().min(1),
      pollMs: z.natural().min(1),
    })).default({}),
  })

  /** Browser ownership and per-key serialization shared by every session. */
  private readonly runtime: PlaywrightBrowserRuntime
  /** Session opener handed to every adapter. */
  private readonly transport: PlaywrightWebChatTransport
  private readonly registry = new ProviderRegistry()
  private readonly targets = new Map<string, WebChatTarget>()
  private shutdownPromise: Promise<void> | undefined

  /**
   * @param ctx - Host context that owns the service lifetime.
   * @param config - Browser inputs, driver overrides, and timing policy.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'webChatTransport', { namespace: 'webChat' })
    const drivers = resolveSiteDrivers(config.drivers)
    assertEveryAdapterHasDriver(drivers)
    const resolved: ResolvedConfig = { ...config, drivers: config.drivers ?? {} }
    this.runtime = new PlaywrightBrowserRuntime(
      config.browser,
      { actionTimeoutMs: config.actionTimeoutMs, pollMs: config.pollMs },
      lazyChromiumLauncher(),
    )
    this.transport = new PlaywrightWebChatTransport(this.runtime, resolved, drivers)
    for (const providerId of providerIds()) {
      const provider = webProviderAdapters[providerId]({
        transport: this.transport,
        failureRules: WEB_TRANSPORT_FAILURE_RULES,
      })
      this.registry.register(provider)
      this.targets.set(providerId, { driver: drivers[providerId], provider })
    }
    // The controller registers itself on the context under its `chatHub` namespace.
    new ChatHubController(ctx, { registry: this.registry })
    ctx.effect(() => () => this.shutdown())
  }

  /**
   * Read every shipped provider's identity and current health.
   *
   * Health probing never opens a browser, so an unstarted provider reports
   * `not-started` and a signed-out one reports `needs-auth`.
   * @returns One view per shipped provider, in adapter order.
   */
  @Remote
  async providers(): Promise<WebChatProviderView[]> {
    const views: WebChatProviderView[] = []
    for (const [providerId, target] of this.targets) {
      const provider = target.provider
      views.push({
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        capabilities: provider.capabilities,
        health: await this.registry.health(providerId),
      })
    }
    return views
  }

  /**
   * Hand the shared transport to a model route that does not go through the
   * panel.
   *
   * The ChatHub LLM adapter drives the same sites from the agent loop, so it
   * must reuse this transport: a second one would mean a second browser
   * profile, a second login, and two queues competing for one Chrome.
   * @returns The session opener, exposing no page or runtime handle.
   */
  transportForAdapter(): WebChatTransport {
    return this.transport
  }

  /**
   * Open a headful page so the user can sign in, then reopen the provider.
   * @param providerId - provider whose site the user signs in on.
   * @param signal - Client cancellation; cancelling leaves the provider `needs-auth`.
   * @returns The provider's health after sign-in, or its current health when the
   *   user cancelled or the page closed before the chat input appeared.
   * @throws BrowserTransportError with `chathub-driver-missing` for an unregistered provider.
   */
  @Remote
  async login(providerId: string, signal: AbortSignal): Promise<ProviderHealth> {
    const target = this.requireTarget(providerId)
    let signedIn: boolean
    try {
      signedIn = await this.runtime.login(providerId, target.driver, this.config.loginTimeoutMs, signal)
    } catch (error) {
      if (error instanceof BrowserTransportError && error.token === 'chathub-signed-out') {
        return await this.registry.health(providerId)
      }
      throw error
    }
    if (!signedIn) return await this.registry.health(providerId)
    return await this.registry.reauthenticate(providerId)
  }

  /**
   * Close the provider's session and open it again under the current login state.
   * @param providerId - provider to reopen.
   * @returns The provider's health after the reopen attempt.
   * @throws BrowserTransportError with `chathub-driver-missing` for an unregistered provider.
   */
  @Remote
  async reauthenticate(providerId: string): Promise<ProviderHealth> {
    this.requireTarget(providerId)
    return await this.registry.reauthenticate(providerId)
  }

  /**
   * Close provider sessions, then release every browser resource.
   * @returns Resolves after the first shutdown attempt settles.
   */
  private shutdown(): Promise<void> {
    this.shutdownPromise ??= this.disposeResources()
    return this.shutdownPromise
  }

  /** @returns Resolves when providers and browser resources are released. */
  private async disposeResources(): Promise<void> {
    for (const target of this.targets.values()) await target.provider.close()
    await this.transport.dispose()
  }

  /**
   * @param providerId - provider id from a Remote call.
   * @returns Its resolved driver and adapter.
   * @throws BrowserTransportError with `chathub-driver-missing` when no adapter ships for it.
   */
  private requireTarget(providerId: string): WebChatTarget {
    const target = this.targets.get(providerId)
    if (target === undefined) {
      throw new BrowserTransportError('chathub-driver-missing', `no shipped provider "${providerId}"`)
    }
    return target
  }
}

export default WebChatTransportService
