/** The `WebChatTransport` implementation over a host-owned browser runtime. */

import { PlaywrightChatSession } from './session.ts'
import { BrowserTransportError } from './errors.ts'
import type {
  ProviderFailureRule,
  WebChatTransport,
  WebChatTransportClosed,
  WebChatTransportSession,
} from '@deepseek-ai/dsh-experimental-chathub'
import type { ResolvedConfig, SiteDrivers, TransportRuntime } from './types.ts'

/** Stable transport tokens mapped to ChatHub provider failure codes for every adapter. */
export const WEB_TRANSPORT_FAILURE_RULES: readonly ProviderFailureRule[] = [
  { pattern: /chathub-signed-out/, code: 'auth-required' },
  { pattern: /chathub-driver-missing/, code: 'unsupported-capability' },
  { pattern: /chathub-ui-drift/, code: 'provider-unavailable' },
  { pattern: /chathub-turn-timeout/, code: 'stream-interrupted' },
  { pattern: /chathub-busy/, code: 'rate-limited' },
  { pattern: /chathub-network/, code: 'network-error' },
  { pattern: /chathub-profile-locked/, code: 'provider-unavailable' },
  { pattern: /chathub-browser-unavailable/, code: 'provider-unavailable' },
]

/**
 * Opens ChatHub sessions on pages the host owns.
 *
 * A page is reused per key; a site that is not signed in yields the closed
 * result the library expects rather than an error, so provider probing records
 * `needs-auth` instead of a failure.
 */
export class PlaywrightWebChatTransport implements WebChatTransport {
  /**
   * @param runtime - browser ownership and per-key turn serialization.
   * @param config - resolved timing, queue, and driver-override configuration.
   * @param drivers - validated site drivers for every shipped provider.
   */
  constructor(
    private readonly runtime: TransportRuntime,
    private readonly config: ResolvedConfig,
    private readonly drivers: SiteDrivers,
  ) {}

  /**
   * Open or reuse a signed-in session for one provider.
   * @param providerId - provider whose site the session belongs to.
   * @param sessionKey - optional site-side conversation to resume.
   * @returns The session, or the closed result when the site is not signed in.
   * @throws BrowserTransportError with `chathub-driver-missing` for an unregistered provider.
   */
  async open(
    providerId: string,
    sessionKey?: string,
  ): Promise<WebChatTransportSession | WebChatTransportClosed | undefined> {
    const driver = this.drivers[providerId]
    if (driver === undefined) {
      throw new BrowserTransportError('chathub-driver-missing', `no site driver for "${providerId}"`)
    }
    const key = sessionKey ?? providerId
    const page = await this.runtime.acquire(key, driver)
    const signedIn = await page.waitForInput(
      driver.input,
      driver.loginWall,
      this.config.loginTimeoutMs,
      this.config.pollMs,
    )
    if (!signedIn) {
      await this.runtime.release(key)
      return { closed: true, reason: 'not-signed-in' }
    }
    return new PlaywrightChatSession(key, page, driver, this.config, this.runtime)
  }

  /**
   * Characters one insertion may put into the site's composer.
   * @param providerId - provider whose site composer is queried.
   * @returns The driver's ceiling, or `undefined` when the site declares none.
   */
  maxPromptChars(providerId: string): number | undefined {
    return this.drivers[providerId]?.maxPromptChars
  }

  /**
   * Release every page and browser resource this transport opened.
   * @returns Resolves when every page and browser resource is released.
   */
  async dispose(): Promise<void> {
    await this.runtime.dispose()
  }
}
