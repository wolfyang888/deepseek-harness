/** Host transport configuration, page-driver facts, and browser automation faces. */

import type {
  IModelProvider,
  ModelCapabilities,
  ModelKind,
  ProviderHealth,
} from '@deepseek-ai/dsh-experimental-chathub'

/** One site's selectors, entry URL, and completion rules. */
export interface SiteDriverConfig {
  /** Chat entry URL. */
  url: string
  /** Chat input: a `textarea` or contenteditable element. */
  input: string
  /** Assistant answer containers; the last one is the current answer. */
  answer: string
  /** Element that only appears on a signed-out wall. */
  loginWall?: string
  /** Path pattern identifying a login or logout redirect; matched case-insensitively. */
  signedOutPath?: string
  /** Key that submits the rendered prompt. */
  submitKey: string
  /** Stable polls required before an answer counts as finished; defaults to the service value. */
  stablePolls?: number
  /** Milliseconds between answer polls; defaults to the service value. */
  pollMs?: number
}

/** Provider-id keyed site drivers. */
export type SiteDrivers = Record<string, SiteDriverConfig>

/** Browser ownership mode and launch inputs. */
export type BrowserRuntimeConfig =
  | {
    /** The Host launches and owns a persistent Chrome profile. */
    mode: 'managed'
    /** Persistent Chrome profile directory; required and never defaulted. */
    profileDir: string
    /** Chrome binary to launch; omitted uses Playwright's registry. */
    executablePath?: string
    /** Run without a visible window. */
    headless: boolean
  }
  | {
    /** The Host attaches to a Chrome the user already runs. */
    mode: 'cdp'
    /** Profile directory whose lock prevents a second Host from using it. */
    profileDir: string
    /** Remote debugging endpoint of the user's already running Chrome. */
    cdpEndpoint: string
    /** Report only; the connected browser keeps its own window mode. */
    headless: boolean
  }

/** Timing and queue policy shared by the transport, sessions, and pages. */
export interface TransportConfig {
  /** Milliseconds `open` waits for the chat input before reporting a signed-out site. */
  loginTimeoutMs: number
  /** Hard cap on one turn. */
  turnTimeoutMs: number
  /** Cap on one page operation. */
  actionTimeoutMs: number
  /** Milliseconds between answer polls. */
  pollMs: number
  /** Stable polls required before an answer counts as finished. */
  stablePolls: number
  /** Turns allowed to wait behind the active turn for one key. */
  maxQueuedTurns: number
  /** Milliseconds between keystrokes when typing a prompt. */
  typeDelayMs: number
}

/** Service configuration after schema defaults have been applied. */
export interface Config extends TransportConfig {
  /** Browser ownership mode and launch inputs. */
  browser: BrowserRuntimeConfig
  /** Provider-id keyed partial overrides of the shipped site drivers. */
  drivers?: Record<string, Partial<SiteDriverConfig>>
}

/** Service configuration with the driver-override map present. */
export interface ResolvedConfig extends Config {
  drivers: Record<string, Partial<SiteDriverConfig>>
}

/** One registered provider's identity and current health. */
export interface WebChatProviderView {
  id: string
  name: string
  kind: ModelKind
  capabilities: ModelCapabilities
  health: ProviderHealth
}

/** Provider identity with the driver and adapter the host built for it. */
export interface WebChatTarget {
  driver: SiteDriverConfig
  provider: IModelProvider
}

/** Answer container handle used by session polling. */
export interface BrowserLocatorLike {
  /**
   * @param options - optional operation timeout.
   * @returns Whether any element matching this locator is visible.
   */
  isVisible(options?: { timeout?: number }): Promise<boolean>
  /**
   * @param options - optional operation timeout.
   * @returns The element box, or `null` when no element matches.
   */
  boundingBox(options?: { timeout?: number }): Promise<{ x: number; y: number; width: number; height: number } | null>
  /**
   * @param options - optional operation timeout.
   * @returns The element's visible text.
   */
  innerText(options?: { timeout?: number }): Promise<string>
}

/** Locator face the page wrapper drives. */
export interface BrowserInputLike extends BrowserLocatorLike {
  /** @returns The first matching element locator. */
  first(): BrowserInputLike
  /** @returns The number of matching elements. */
  count(): Promise<number>
  /**
   * @param index - zero-based element index.
   * @returns The locator for that element.
   */
  nth(index: number): BrowserInputLike
}

/** One browser page or tab. */
export interface BrowserPageLike {
  /** @returns Whether the page has been closed. */
  isClosed(): boolean
  /** @returns The current absolute page URL. */
  url(): string
  /**
   * @param selector - CSS selector to resolve.
   * @returns A locator over matching elements.
   */
  locator(selector: string): BrowserInputLike
  /**
   * @param url - destination URL.
   * @param options - navigation timeout and readiness target.
   * @returns Resolves when the document is ready.
   */
  goto(url: string, options?: { timeout?: number; waitUntil?: 'domcontentloaded' }): Promise<unknown>
  /** @returns Resolves when the page is closed. */
  close(): Promise<void>
  /** Mouse operations on the page viewport. */
  mouse: {
    /**
     * @param x - viewport x coordinate.
     * @param y - viewport y coordinate.
     * @param options - click delay.
     * @returns Resolves when the click is delivered.
     */
    click(x: number, y: number, options?: { delay?: number }): Promise<void>
  }
  /** Keyboard operations on the focused element. */
  keyboard: {
    /**
     * @param text - text to type.
     * @param options - per-key delay.
     * @returns Resolves when typing finishes.
     */
    type(text: string, options?: { delay?: number }): Promise<void>
    /**
     * @param key - key name to press.
     * @returns Resolves when the key is delivered.
     */
    press(key: string): Promise<void>
  }
}

/** Browser context shared by every open page. */
export interface BrowserContextLike {
  /** @returns Pages currently open in this context. */
  pages(): BrowserPageLike[]
  /** @returns A newly opened page. */
  newPage(): Promise<BrowserPageLike>
  /** @returns Resolves when the context is closed. */
  close(): Promise<void>
  /**
   * @param timeout - default timeout for page operations.
   */
  setDefaultTimeout(timeout: number): void
}

/** Browser attached over CDP. */
export interface ConnectedBrowserLike {
  /** @returns Contexts the connected browser already owns. */
  contexts(): BrowserContextLike[]
  /** @returns A newly created context. */
  newContext(): Promise<BrowserContextLike>
  /** @returns Resolves when the connection is released. */
  close(): Promise<void>
}

/** Chromium launcher face the runtime consumes. */
export interface ChromiumLauncher {
  /**
   * @param profileDir - persistent profile directory.
   * @param options - launch flags.
   * @returns The launched persistent context.
   */
  launchPersistentContext(profileDir: string, options: LaunchOptions): Promise<BrowserContextLike>
  /**
   * @param endpoint - remote debugging endpoint.
   * @returns The attached browser.
   */
  connectOverCDP(endpoint: string): Promise<ConnectedBrowserLike>
}

/** Launch flags for a managed persistent context. */
export interface LaunchOptions {
  headless: boolean
  viewport: null
  args: string[]
  executablePath?: string
}

/** Page operations one turn needs. */
export interface TurnPage {
  /** @returns Whether the page has been closed. */
  isClosed(): boolean
  /** @returns The current absolute page URL. */
  url(): string
  /**
   * @param selector - answer container selector.
   * @returns The last answer's text, or an empty string when none exists.
   */
  answerText(selector: string): Promise<string>
  /**
   * @param prompt - rendered prompt to type.
   * @param driver - site facts for input and submission.
   * @param typeDelayMs - delay between keystrokes.
   * @returns Resolves when the prompt is submitted.
   */
  submit(prompt: string, driver: SiteDriverConfig, typeDelayMs: number): Promise<void>
}

/** Page handle the transport opens and releases. */
export interface ChatPageHandle extends TurnPage {
  /**
   * @param input - chat input selector.
   * @param loginWall - signed-out wall selector, when the site has one.
   * @param timeoutMs - longest wait for either element.
   * @param pollMs - delay between visibility checks.
   * @param signal - cancels the wait.
   * @returns `true` when the chat input is visible before the deadline.
   */
  waitForInput(
    input: string,
    loginWall: string | undefined,
    timeoutMs: number,
    pollMs: number,
    signal?: AbortSignal,
  ): Promise<boolean>
  /** @returns Resolves when the page is closed. */
  close(): Promise<void>
}

/** Per-key turn serialization the session uses. */
export interface TurnGate {
  /**
   * @param key - provider or conversation key.
   * @param maxQueuedTurns - turns allowed to wait behind the active turn.
   * @returns A lease that must be released when the turn settles.
   */
  acquireTurn(key: string, maxQueuedTurns: number): Promise<() => void>
  /**
   * @param key - page key to release.
   * @returns Resolves when the page is closed.
   */
  release(key: string): Promise<void>
}

/** Runtime face the transport drives. */
export interface TransportRuntime extends TurnGate {
  /**
   * @param key - provider or conversation key.
   * @param driver - site facts for navigation.
   * @returns The reusable signed-in page for that key.
   */
  acquire(key: string, driver: SiteDriverConfig): Promise<ChatPageHandle>
  /**
   * @param providerId - provider whose site page the user signs in on.
   * @param driver - site facts for navigation.
   * @param timeoutMs - longest wait for the chat input.
   * @param signal - cancels the wait.
   * @returns Whether the site reported a signed-in session.
   */
  login(providerId: string, driver: SiteDriverConfig, timeoutMs: number, signal: AbortSignal): Promise<boolean>
  /** @returns Resolves when every page and browser resource is released. */
  dispose(): Promise<void>
}
