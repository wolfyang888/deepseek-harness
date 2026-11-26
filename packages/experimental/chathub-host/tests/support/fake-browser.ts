/** In-memory browser doubles shared by the chathub-host unit suites. */

import { setTimeout as sleep } from 'node:timers/promises'
import type {
  BrowserContextLike,
  BrowserInputLike,
  BrowserPageLike,
  ChromiumLauncher,
  ConnectedBrowserLike,
  FileChooserLike,
  LaunchOptions,
} from '../../src/types.ts'

/** Page operations a test can make fail. */
type FakePageOperation =
  | 'goto'
  | 'close'
  | 'bringToFront'
  | 'count'
  | 'isVisible'
  | 'boundingBox'
  | 'innerHTML'
  | 'click'
  | 'type'
  | 'insertText'
  | 'press'
  | 'setInputFiles'

/** Locator double whose behavior follows its page's maps. */
class FakeLocator implements BrowserInputLike {
  /**
   * @param page - page owning the selector state.
   * @param selector - selector this locator targets.
   * @param index - element index this locator stands for.
   */
  constructor(
    private readonly page: FakePage,
    private readonly selector: string,
    private readonly index = 0,
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
   * @param index - element index ignored by the fake.
   * @returns A locator over the same selector.
   */
  nth(index: number): BrowserInputLike {
    return new FakeLocator(this.page, this.selector, index)
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
    // An indicator that clears on its own: visible for the first N checks.
    const seen = (this.page.visibilityChecks[this.selector] ?? 0) + 1
    this.page.visibilityChecks[this.selector] = seen
    const lingering = this.page.visibleFor[this.selector] ?? 0
    if (lingering > 0) {
      this.page.visibleFor[this.selector] = lingering - 1
      return true
    }
    this.page.visibilityChecks[this.selector] = seen
    // A menu painted a beat after its trigger is the normal case on the real
    // sites, so a selector can be configured to read hidden first.
    if (seen <= (this.page.hiddenChecks[this.selector] ?? 0)) return false
    return this.page.visible.has(this.selector)
  }

  /** @returns The configured element box or `null`. */
  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    this.page.raise('boundingBox')
    return this.page.boxes[this.selector] ?? null
  }

  /** @returns The configured markup; a restored draft until the host types. */
  async innerHTML(): Promise<string> {
    this.page.raise('innerHTML')
    // The composer renders nothing until the host inserts a prompt, so a test
    // that presets `texts` for it is describing the state *after* typing. A
    // draft the site restored from an earlier turn is `prefilled` instead.
    if (this.selector === this.page.composerSelector && this.page.typed.length === 0) {
      return this.page.prefilled[this.selector] ?? ''
    }
    return this.page.texts[this.selector] ?? ''
  }

  /** @returns Whether the selector reads disabled, honoring a countdown. */
  async isDisabled(): Promise<boolean> {
    const remaining = this.page.disabledChecks[this.selector] ?? 0
    if (remaining > 0) {
      this.page.disabledChecks[this.selector] = remaining - 1
      return true
    }
    return this.page.disabledButtons.has(this.selector)
  }

  /**
   * @param name - attribute name.
   * @returns The attribute the test configured for this element, then for the
   *   selector as a whole, or `null` when neither is set.
   */
  async getAttribute(name: string): Promise<string | null> {
    return this.page.attributes[`${this.selector}#${this.index}#${name}`]
      ?? this.page.attributes[`${this.selector}#${name}`]
      ?? null
  }

  /** Records one click on this selector. */
  async click(): Promise<void> {
    this.page.raise('click')
    this.page.locatorClicks.push(this.selector)
    if (this.page.clearAfterClicks > 0 && this.page.locatorClicks.length >= this.page.clearAfterClicks) this.page.texts = {}
  }

  /**
   * @param files - uploads the wrapper hands to this input.
   * @param _options - timeout the wrapper passes; the fake answers at once.
   * @returns Resolves after recording the pick, as a real input would.
   */
  async setInputFiles(
    files: readonly { name: string; mimeType: string; buffer: Uint8Array }[],
    _options?: { timeout?: number },
  ): Promise<void> {
    this.page.raise('setInputFiles')
    for (const file of files) {
      this.page.uploads.push({
        selector: this.selector,
        name: file.name,
        mimeType: file.mimeType,
        text: new TextDecoder().decode(file.buffer),
      })
    }
  }
}

/** File pick double: records the files the wrapper answers it with. */
export class FakeChooser implements FileChooserLike {
  /**
   * @param page - page this pick belongs to, which collects the uploads.
   */
  constructor(private readonly page: FakePage) {}

  /**
   * @param files - uploads the wrapper hands to the pick.
   * @param _options - timeout the wrapper passes; the fake answers at once.
   * @returns Resolves after recording the pick.
   */
  async setFiles(
    files: readonly { name: string; mimeType: string; buffer: Uint8Array }[],
    _options?: { timeout?: number },
  ): Promise<void> {
    for (const file of files) {
      this.page.uploads.push({
        selector: 'filechooser',
        name: file.name,
        mimeType: file.mimeType,
        text: new TextDecoder().decode(file.buffer),
      })
    }
  }
}

/** Page double recording every interaction the wrapper performs. */
export class FakePage implements BrowserPageLike {
  closed = false
  urlValue = 'https://fake.test/'
  /** Context this page reports; a context's `newPage` wires itself in. */
  contextValue: FakeContext | undefined
  counts: Record<string, number> = {}
  texts: Record<string, string> = {}
  /** Text the composer already holds before the host types: a restored draft. */
  prefilled: Record<string, string> = {}
  /** Selector whose text appears only after the host inserts a prompt. */
  composerSelector: string | undefined
  boxes: Record<string, { x: number; y: number; width: number; height: number } | null> = {}
  visible = new Set<string>()
  /** Attributes keyed by `selector#name`, so `accept` can differ per input. */
  attributes: Record<string, string | null> = {}
  /** Visibility checks each selector answers `false` first, keyed by selector. */
  hiddenChecks: Record<string, number> = {}
  /** Visibility checks performed per selector, so the above can count down. */
  visibilityChecks: Record<string, number> = {}
  /** Checks a selector answers visible before it clears itself, by selector. */
  visibleFor: Record<string, number> = {}
  /** File pick the page starts; unset when the site starts none. */
  chooser: FakeChooser | undefined
  /** Selectors the fake reports as disabled; empty means everything enabled. */
  disabledButtons = new Set<string>()
  /** Disabled answers a selector gives before it reads enabled, by selector. */
  disabledChecks: Record<string, number> = {}
  /** Selectors clicked through a locator (as opposed to raw mouse clicks). */
  locatorClicks: string[] = []
  /** Milliseconds each visibility check takes before answering. */
  isVisibleDelayMs = 0
  /** The URL of every navigation, in order. */
  visited: string[] = []
  /** The options of every navigation, paired with `visited` by index. */
  gotoOptions: Array<{ timeout?: number; waitUntil?: 'domcontentloaded' } | undefined> = []
  typed: string[] = []
  keys: string[] = []
  /** Files each locator input accepted, so an upload is observable. */
  uploads: { selector: string; name: string; mimeType: string; text: string }[] = []
  clicks: { x: number; y: number }[] = []
  /** Submit presses after which the composer empties, as a real site does; 0 keeps the text. */
  clearAfterPresses = 0
  /** Locator clicks after which the composer empties; 0 keeps the text. */
  clearAfterClicks = 0
  closeCount = 0
  /** Activation requests the runtime sent for this page's window. */
  bringToFrontCount = 0
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
      // Select-all + delete ends a restored draft, exactly as an editor does.
      if (key === 'Backspace') this.prefilled = {}
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

  /** @returns The context the page was opened in, or a fresh cookie-less one. */
  context(): BrowserContextLike {
    this.contextValue ??= new FakeContext()
    return this.contextValue
  }

  /**
   * @param selector - selector to resolve.
   * @returns A locator double for that selector.
   */
  locator(selector: string): BrowserInputLike {
    return new FakeLocator(this, selector)
  }

  /**
   * @param event - event name; only `filechooser` is used by the host.
   * @returns The pick the test armed, as a site starting one would report it.
   * @throws Error when the test armed no pick, standing in for a timed-out wait.
   */
  async waitForEvent(event: string): Promise<FileChooserLike> {
    if (event !== 'filechooser' || this.chooser === undefined) throw new Error('no file chooser was started')
    return this.chooser
  }

  /**
   * @param url - destination URL recorded as the current location.
   * @returns Resolves when the fake navigation finishes.
   */
  async goto(url: string, options?: { timeout?: number; waitUntil?: 'domcontentloaded' }): Promise<unknown> {
    this.raise('goto')
    this.visited.push(url)
    this.gotoOptions.push(options)
    this.urlValue = url
    return undefined
  }

  /** @returns Resolves after marking the page closed. */
  async close(): Promise<void> {
    this.raise('close')
    this.closeCount += 1
    this.closed = true
  }

  /** @returns Resolves after recording the activation request. */
  async bringToFront(): Promise<void> {
    this.raise('bringToFront')
    this.bringToFrontCount += 1
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
  /** Cookie names the fake context reports; tests flip this to simulate sign-in. */
  cookieNames: string[] = []
  /** Connection state the fake browser reports; tests flip this to simulate a closed window. */
  browserConnected = true

  /** @returns Pages opened through this context. */
  pages(): FakePage[] {
    return this.pagesList
  }

  /** @returns The owning browser's connection state. */
  browser(): { isConnected(): boolean } {
    return { isConnected: () => this.browserConnected }
  }

  /** @returns A new fake page wired to this context. */
  async newPage(): Promise<FakePage> {
    if (this.newPageError !== undefined) throw this.newPageError
    this.newPageCount += 1
    const page = this.pageFactory()
    page.contextValue = this
    this.pagesList.push(page)
    return page
  }

  /** @returns The cookie names the test configured. */
  async cookies(): Promise<readonly { name: string }[]> {
    return this.cookieNames.map(name => ({ name }))
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
