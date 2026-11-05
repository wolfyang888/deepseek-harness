/** Browser ownership: one Chrome profile, per-key pages, and per-key turn serialization. */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserTransportError } from './errors.ts'
import { PlaywrightPage } from './page.ts'
import type {
  BrowserContextLike,
  BrowserPageLike,
  BrowserRuntimeConfig,
  ChatPageHandle,
  ChromiumLauncher,
  ConnectedBrowserLike,
  SiteDriverConfig,
  TransportConfig,
  TransportRuntime,
} from './types.ts'

/** Lock file that reserves one profile directory for one Host process. */
const LOCK_FILE = 'chathub.lock'

/** Launch flag that reduces the most common automation fingerprint. */
const LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled']

/** Per-key serialization state; `active` covers the running turn, `waiting` the queue. */
interface TurnChain {
  tail: Promise<void>
  active: boolean
  waiting: number
}

/** Timing values the runtime needs from the service configuration. */
type RuntimeTimings = Pick<TransportConfig, 'actionTimeoutMs' | 'pollMs'>

/**
 * Read the stable `code` a filesystem rejection carries, so a lock held by a
 * live process is told apart from an unreadable one.
 * @param error - rejected value.
 * @returns The code string, or an empty string for non-filesystem rejections.
 */
export function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : ''
  }
  return ''
}

/**
 * @param pid - process id read from a lock file.
 * @returns Whether that process still exists.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // `EPERM` means the process exists under another user; only `ESRCH` proves it is gone.
    return errorCode(error) !== 'ESRCH'
  }
}

/**
 * Reserve a profile directory for this process, taking over a stale lock.
 * @param profileDir - persistent Chrome profile directory.
 * @returns The lock file path that must be removed on teardown.
 * @throws BrowserTransportError with `chathub-profile-locked` when another live process owns it.
 */
async function acquireProfileLock(profileDir: string): Promise<string> {
  await mkdir(profileDir, { recursive: true, mode: 0o700 })
  const lockPath = join(profileDir, LOCK_FILE)
  try {
    await writeFile(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
    return lockPath
  } catch {
    // An existing lock, or an unusable path, is settled by the takeover write below.
  }
  const owner = await readLockedPid(lockPath)
  if (owner !== undefined && isProcessAlive(owner)) {
    throw new BrowserTransportError('chathub-profile-locked', `${profileDir}: owned by live pid ${owner}`)
  }
  try {
    await writeFile(lockPath, `${process.pid}\n`, { flag: 'w', mode: 0o600 })
  } catch (error) {
    throw new BrowserTransportError('chathub-profile-locked', `${profileDir}: replacing the stale lock failed`, { cause: error })
  }
  return lockPath
}

/**
 * @param lockPath - lock file written by a previous Host.
 * @returns The recorded pid, or `undefined` when the file is gone or unreadable.
 */
async function readLockedPid(lockPath: string): Promise<number | undefined> {
  try {
    const pid = Number.parseInt((await readFile(lockPath, 'utf8')).trim(), 10)
    return Number.isNaN(pid) ? undefined : pid
  } catch {
    // An unreadable or vanished lock carries no owner; the caller takes it over.
    return undefined
  }
}

/**
 * Owns the Chrome process, its pages, and per-key turn order for the transport.
 *
 * Every page is recorded by key so teardown closes exactly what the runtime
 * created. `managed` mode holds a profile lock for its lifetime; `cdp` mode
 * only owns contexts it created on the attached browser.
 */
export class PlaywrightBrowserRuntime implements TransportRuntime {
  private context: BrowserContextLike | undefined
  private browser: ConnectedBrowserLike | undefined
  private ownsContext = false
  private lockPath: string | undefined
  private disposed = false
  private readonly pages = new Map<string, ChatPageHandle>()
  private readonly chains = new Map<string, TurnChain>()

  /**
   * @param config - browser ownership mode and launch inputs.
   * @param timings - page-operation and login-poll timeouts.
   * @param launcher - Chromium API face; callers pass `playwright-core`'s `chromium`.
   */
  constructor(
    private readonly config: BrowserRuntimeConfig,
    private readonly timings: RuntimeTimings,
    private readonly launcher: ChromiumLauncher,
  ) {}

  /**
   * Return the reusable page for one key, navigating a new page to the site.
   * @param key - provider or conversation key.
   * @param driver - site facts for the entry URL.
   * @returns The page bound to this key.
   * @throws BrowserTransportError when the runtime is disposed or the page cannot open.
   */
  async acquire(key: string, driver: SiteDriverConfig): Promise<ChatPageHandle> {
    this.assertUsable()
    const existing = this.pages.get(key)
    if (existing !== undefined) {
      if (!existing.isClosed()) return existing
      this.pages.delete(key)
    }
    const page = await this.createPage(key, driver)
    this.pages.set(key, page)
    return page
  }

  /**
   * Open a headful page for manual sign-in and close it afterwards.
   *
   * A `managed` headless service cannot show a login window, so this call
   * replaces the context with a temporary headful one and restores a closed
   * state afterwards; the profile keeps the cookies the user established.
   * @param providerId - provider whose site page the user signs in on.
   * @param driver - site facts for the entry URL and login wall.
   * @param timeoutMs - longest wait for the chat input.
   * @param signal - cancels the wait.
   * @returns Whether the site reported a signed-in session.
   * @throws BrowserTransportError when the runtime is disposed or the page closes.
   */
  async login(
    providerId: string,
    driver: SiteDriverConfig,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    this.assertUsable()
    if (this.config.mode !== 'managed' || !this.config.headless) {
      const page = await this.acquire(providerId, driver)
      const signedIn = await page.waitForInput(
        driver.input,
        driver.loginWall,
        timeoutMs,
        this.timings.pollMs,
        signal,
      )
      if (!signedIn) await this.release(providerId)
      return signedIn
    }
    await this.dropContext()
    try {
      const context = await this.openContext(false)
      this.context = context
      const page = await this.createPage(providerId, driver)
      this.pages.set(providerId, page)
      return await page.waitForInput(
        driver.input,
        driver.loginWall,
        timeoutMs,
        this.timings.pollMs,
        signal,
      )
    } finally {
      await this.dropContext()
    }
  }

  /**
   * Close the page bound to one key.
   * @param key - provider or conversation key.
   * @returns Resolves when the page is closed.
   */
  async release(key: string): Promise<void> {
    const page = this.pages.get(key)
    if (page === undefined) return
    this.pages.delete(key)
    await page.close()
  }

  /**
   * Take the next turn slot for one key.
   * @param key - provider or conversation key.
   * @param maxQueuedTurns - turns allowed to wait behind the active turn.
   * @returns A lease that must be released when the turn settles.
   * @throws BrowserTransportError with `chathub-busy` when the queue is full, or
   * `chathub-browser-unavailable` after disposal.
   */
  async acquireTurn(key: string, maxQueuedTurns: number): Promise<() => void> {
    this.assertUsable()
    const chain = this.chainFor(key)
    if (chain.active) {
      if (chain.waiting >= maxQueuedTurns) {
        throw new BrowserTransportError('chathub-busy', `${key}: ${maxQueuedTurns} turns already queued`)
      }
      chain.waiting += 1
    }
    chain.active = true
    const previous = chain.tail
    let releaseTurn!: () => void
    const current = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    chain.tail = previous.then(() => current)
    await previous
    if (chain.waiting > 0) chain.waiting -= 1
    let released = false
    return () => {
      if (released) return
      released = true
      chain.active = false
      releaseTurn()
    }
  }

  /**
   * Release every page, context, browser, and profile lock.
   * @returns Resolves when no browser resource remains.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await Promise.all([...this.chains.values()].map(chain => chain.tail))
    await this.dropContext()
    if (this.lockPath !== undefined) {
      const lockPath = this.lockPath
      this.lockPath = undefined
      await rm(lockPath, { force: true })
    }
  }

  /**
   * @param key - provider or conversation key.
   * @returns The serialization state for that key, created on first use.
   */
  private chainFor(key: string): TurnChain {
    const existing = this.chains.get(key)
    if (existing !== undefined) return existing
    const chain: TurnChain = { tail: Promise.resolve(), active: false, waiting: 0 }
    this.chains.set(key, chain)
    return chain
  }

  /**
   * @param key - provider or conversation key.
   * @param driver - site facts for the entry URL.
   * @returns A page navigated to the provider's chat entry.
   */
  private async createPage(key: string, driver: SiteDriverConfig): Promise<ChatPageHandle> {
    const context = await this.ensureContext()
    let raw: BrowserPageLike
    try {
      raw = await context.newPage()
    } catch (error) {
      throw new BrowserTransportError('chathub-browser-unavailable', `${key}: opening a page failed`, { cause: error })
    }
    const page = new PlaywrightPage(raw, key, this.timings.actionTimeoutMs)
    try {
      await page.goto(driver.url)
    } catch (error) {
      await page.close()
      throw error
    }
    return page
  }

  /** @returns The shared context, opening one when the runtime has none. */
  private async ensureContext(): Promise<BrowserContextLike> {
    if (this.context !== undefined) return this.context
    this.context = await this.openContext(this.config.mode === 'managed' && this.config.headless)
    return this.context
  }

  /**
   * Open a context for the configured mode.
   * @param headless - window mode for a managed launch; `cdp` ignores it.
   * @returns The opened context with the runtime's default operation timeout.
   */
  private async openContext(headless: boolean): Promise<BrowserContextLike> {
    if (this.config.mode === 'cdp') return this.openCdpContext(this.config.cdpEndpoint)
    const lockPath = this.lockPath ?? await acquireProfileLock(this.config.profileDir)
    this.lockPath = undefined
    try {
      const options = {
        headless,
        viewport: null,
        args: [...LAUNCH_ARGS, ...(this.config.proxy === undefined ? [] : [`--proxy-server=${this.config.proxy}`])],
        ...(this.config.executablePath === undefined ? {} : { executablePath: this.config.executablePath }),
      }
      const context = await this.launcher.launchPersistentContext(this.config.profileDir, options)
      this.lockPath = lockPath
      this.ownsContext = true
      context.setDefaultTimeout(this.timings.actionTimeoutMs)
      return context
    } catch (error) {
      await rm(lockPath, { force: true })
      const reason = error instanceof Error ? error.message : String(error)
      throw new BrowserTransportError(
        'chathub-browser-unavailable',
        `launching Chrome failed: ${reason}`
          + ' — install the Playwright browser (`pnpm exec playwright install chromium`)'
          + ' or point DSH_CHATHUB_EXECUTABLE_PATH at an existing chrome.exe',
        { cause: error },
      )
    }
  }

  /**
   * @param endpoint - remote debugging endpoint of the user's Chrome.
   * @returns The attached browser's first context or a context created on it.
   */
  private async openCdpContext(endpoint: string): Promise<BrowserContextLike> {
    let browser: ConnectedBrowserLike
    try {
      browser = await this.launcher.connectOverCDP(endpoint)
    } catch (error) {
      throw new BrowserTransportError('chathub-browser-unavailable', 'attaching over CDP failed', { cause: error })
    }
    this.browser = browser
    try {
      const existing = browser.contexts()[0]
      const context = existing ?? await browser.newContext()
      this.ownsContext = existing === undefined
      context.setDefaultTimeout(this.timings.actionTimeoutMs)
      return context
    } catch (error) {
      this.browser = undefined
      try {
        await browser.close()
      } catch {
        // The attachment is already unusable; the selection failure is the reported cause.
      }
      throw new BrowserTransportError('chathub-browser-unavailable', 'selecting a CDP context failed', { cause: error })
    }
  }

  /** Close every recorded page, then the context and attached browser. */
  private async dropContext(): Promise<void> {
    const pages = [...this.pages.values()]
    this.pages.clear()
    for (const page of pages) await page.close()
    const context = this.context
    const ownsContext = this.ownsContext
    const browser = this.browser
    this.context = undefined
    this.ownsContext = false
    this.browser = undefined
    if (context !== undefined && ownsContext) {
      try {
        await context.close()
      } catch {
        // The browser may already be gone; there is no further resource to release.
      }
    }
    if (browser !== undefined) {
      try {
        await browser.close()
      } catch {
        // The attached browser may already be gone; disconnecting has no other effect.
      }
    }
  }

  /** @throws BrowserTransportError with `chathub-browser-unavailable` after disposal. */
  private assertUsable(): void {
    if (this.disposed) {
      throw new BrowserTransportError('chathub-browser-unavailable', 'the browser runtime has been disposed')
    }
  }
}
