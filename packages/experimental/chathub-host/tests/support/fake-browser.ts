/** In-memory browser doubles shared by the chathub-host unit suites. */

import { setTimeout as sleep } from 'node:timers/promises'
import type {
  BrowserContextLike,
  BrowserInputLike,
  BrowserPageLike,
  ChromiumLauncher,
  ConnectedBrowserLike,
  LaunchOptions,
} from '../../src/types.ts'

/** Page operations a test can make fail. */
type FakePageOperation =
  | 'goto'
  | 'close'
  | 'count'
  | 'isVisible'
  | 'boundingBox'
  | 'innerHTML'
  | 'click'
  | 'type'
  | 'insertText'
  | 'press'

/** Locator double whose behavior follows its page's maps. */
class FakeLocator implements BrowserInputLike {
  /**
   * @param page - page owning the selector state.
   * @param selector - selector this locator targets.
   */
  constructor(
    private readonly page: FakePage,
    private readonly selector: string,
  ) {}

  /** @returns The same locator; fakes have no distinct first element. */
  first(): BrowserInputLike {
    return this
  }

  /** @returns The configured match count; a visible selector has one match. */
  async count(): Promise<number> {
    this.page.raise('count')
    return Math.max(this.page.counts[this.selector] ?? 0, this.page.visible.has(this.selector) ? 1 : 0)
  }

  /**
   * @param _index - element index ignored by the fake.
   * @returns A locator over the same selector.
   */
  nth(_index: number): BrowserInputLike {
    return this
  }

  /**
   * @param selector - selector resolved inside this element.
   * @returns A locator keyed by the `parent >> child` pair the fake maps use.
   */
  locator(selector: string): BrowserInputLike {
    return new FakeLocator(this.page, `${this.selector} >> ${selector}`)
  }

  /** @returns Whether the selector is in the visible set. */
  async isVisible(): Promise<boolean> {
    this.page.raise('isVisible')
    if (this.page.isVisibleDelayMs > 0) await sleep(this.page.isVisibleDelayMs)
    return this.page.visible.has(this.selector)
  }

  /** @returns The configured element box or `null`. */
  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    this.page.raise('boundingBox')
    return this.page.boxes[this.selector] ?? null
  }

  /** @returns The configured markup. */
  async innerHTML(): Promise<string> {
    this.page.raise('innerHTML')
    return this.page.texts[this.selector] ?? ''
  }

  /** @returns Whether the selector is in the disabled set. */
  async isDisabled(): Promise<boolean> {
    return this.page.disabledButtons.has(this.selector)
  }

  /** Records one click on this selector. */
  async click(): Promise<void> {
    this.page.raise('click')
    this.page.locatorClicks.push(this.selector)
    if (this.page.clearAfterClicks > 0 && this.page.locatorClicks.length >= this.page.clearAfterClicks) this.page.texts = {}
  }
}

/** Page double recording every interaction the wrapper performs. */
export class FakePage implements BrowserPageLike {
  closed = false
  urlValue = 'https://fake.test/'
  counts: Record<string, number> = {}
  texts: Record<string, string> = {}
  boxes: Record<string, { x: number; y: number; width: number; height: number } | null> = {}
  visible = new Set<string>()
  /** Selectors the fake reports as disabled; empty means everything enabled. */
  disabledButtons = new Set<string>()
  /** Selectors clicked through a locator (as opposed to raw mouse clicks). */
  locatorClicks: string[] = []
  /** Milliseconds each visibility check takes before answering. */
  isVisibleDelayMs = 0
  visited: string[] = []
  typed: string[] = []
  keys: string[] = []
  clicks: { x: number; y: number }[] = []
  /** Submit presses after which the composer empties, as a real site does; 0 keeps the text. */
  clearAfterPresses = 0
  /** Locator clicks after which the composer empties; 0 keeps the text. */
  clearAfterClicks = 0
  closeCount = 0
  errors: Partial<Record<FakePageOperation, unknown>> = {}
  mouse = {
    click: async (x: number, y: number): Promise<void> => {
      this.raise('click')
      this.clicks.push({ x, y })
    },
  }
  keyboard = {
    type: async (text: string): Promise<void> => {
      this.raise('type')
      this.typed.push(text)
    },
    insertText: async (text: string): Promise<void> => {
      this.raise('insertText')
      this.typed.push(text)
    },
    press: async (key: string): Promise<void> => {
      this.raise('press')
      this.keys.push(key)
      if (this.clearAfterPresses > 0 && this.keys.length >= this.clearAfterPresses) this.texts = {}
    },
  }

  /** @returns Whether the page is marked closed. */
  isClosed(): boolean {
    return this.closed
  }

  /** @returns The current page URL. */
  url(): string {
    return this.urlValue
  }

  /**
   * @param selector - selector to resolve.
   * @returns A locator double for that selector.
   */
  locator(selector: string): BrowserInputLike {
    return new FakeLocator(this, selector)
  }

  /**
   * @param url - destination URL recorded as the current location.
   * @returns Resolves when the fake navigation finishes.
   */
  async goto(url: string): Promise<unknown> {
    this.raise('goto')
    this.visited.push(url)
    this.urlValue = url
    return undefined
  }

  /** @returns Resolves after marking the page closed. */
  async close(): Promise<void> {
    this.raise('close')
    this.closeCount += 1
    this.closed = true
  }

  /**
   * @param operation - operation the test configured to fail.
   * @throws The configured rejection for that operation.
   */
  raise(operation: FakePageOperation): void {
    const error = this.errors[operation]
    if (error !== undefined) throw error
  }
}

/** Context double collecting the pages created through it. */
export class FakeContext implements BrowserContextLike {
  pagesList: FakePage[] = []
  newPageError: unknown
  closeError: unknown
  newPageCount = 0
  closeCount = 0
  defaultTimeout: number | undefined
  pageFactory: () => FakePage = () => new FakePage()

  /** @returns Pages opened through this context. */
  pages(): FakePage[] {
    return this.pagesList
  }

  /** @returns A new fake page. */
  async newPage(): Promise<FakePage> {
    if (this.newPageError !== undefined) throw this.newPageError
    this.newPageCount += 1
    const page = this.pageFactory()
    this.pagesList.push(page)
    return page
  }

  /** @returns Resolves after recording the close. */
  async close(): Promise<void> {
    if (this.closeError !== undefined) throw this.closeError
    this.closeCount += 1
  }

  /**
   * @param timeout - default operation timeout the runtime sets.
   */
  setDefaultTimeout(timeout: number): void {
    this.defaultTimeout = timeout
  }
}

/** Attached-browser double for CDP mode. */
export class FakeBrowser implements ConnectedBrowserLike {
  contextsList: FakeContext[] = []
  newContextError: unknown
  closeError: unknown
  closeCount = 0
  contextFactory: () => FakeContext = () => new FakeContext()

  /** @returns Contexts the attached browser reports. */
  contexts(): FakeContext[] {
    return this.contextsList
  }

  /** @returns A newly created fake context. */
  async newContext(): Promise<FakeContext> {
    if (this.newContextError !== undefined) throw this.newContextError
    const context = this.contextFactory()
    this.contextsList.push(context)
    return context
  }

  /** @returns Resolves after recording the close. */
  async close(): Promise<void> {
    if (this.closeError !== undefined) throw this.closeError
    this.closeCount += 1
  }
}

/** Chromium launcher double recording launch inputs. */
export class FakeLauncher implements ChromiumLauncher {
  launched: { profileDir: string; options: LaunchOptions }[] = []
  endpoints: string[] = []
  launchError: unknown
  cdpError: unknown
  contextFactory: () => FakeContext = () => new FakeContext()
  browserFactory: () => FakeBrowser = () => new FakeBrowser()

  /**
   * @param profileDir - profile directory passed by the runtime.
   * @param options - launch flags passed by the runtime.
   * @returns A new fake persistent context.
   */
  async launchPersistentContext(profileDir: string, options: LaunchOptions): Promise<FakeContext> {
    if (this.launchError !== undefined) throw this.launchError
    this.launched.push({ profileDir, options })
    return this.contextFactory()
  }

  /**
   * @param endpoint - remote debugging endpoint.
   * @returns A new fake attached browser.
   */
  async connectOverCDP(endpoint: string): Promise<FakeBrowser> {
    if (this.cdpError !== undefined) throw this.cdpError
    this.endpoints.push(endpoint)
    return this.browserFactory()
  }
}

/** Launcher the service suite's `playwright-core` mock delegates to. */
export const sharedLauncher = new FakeLauncher()
