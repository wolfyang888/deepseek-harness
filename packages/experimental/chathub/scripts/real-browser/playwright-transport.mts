/**
 * Owner-local Playwright WebChatTransport for real-site validation.
 *
 * Drives the system Chrome through a persistent profile so a manual login in
 * `login` mode is reused by later validation runs. Not shipped with the
 * package and never wired into a profile; it exists to exercise the shipped
 * browser adapters against the real sites.
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  WebChatPayload,
  WebChatRawResponse,
  WebChatTransport,
  WebChatTransportClosed,
  WebChatTransportSession,
} from '../../src/providers/web-provider.ts'

const require = createRequire(
  path.resolve(fileURLToPath(import.meta.url), '../../../../inspector/package.json'),
)
const { chromium } = require('playwright') as typeof import('playwright')

/** Per-site page drivers the generic engine parametrizes over. */
interface SiteDriver {
  /** Chat entry URL. */
  url: string
  /** Chat input: a textarea or contenteditable element. */
  input: string
  /** Assistant answer containers; the last one is the current answer. */
  answer: string
  /** Elements that only appear on a signed-out wall. */
  loginWall?: string
}

const SITE_DRIVERS: Record<string, SiteDriver> = {
  'deepseek-web': {
    url: 'https://chat.deepseek.com/',
    input: 'textarea',
    answer: '.ds-markdown',
  },
  // Secondary alias for the same site; used by the switch-self drill to
  // exercise the cross-provider path without a second signed-in site.
  'deepseek-web-2': {
    url: 'https://chat.deepseek.com/',
    input: 'textarea',
    answer: '.ds-markdown',
  },
  'chatgpt-web': {
    url: 'https://chatgpt.com/',
    input: '#prompt-textarea',
    answer: '[data-message-author-role="assistant"] .markdown',
    loginWall: '[data-testid="login-button"]',
  },
  'gemini-web': {
    url: 'https://gemini.google.com/app',
    input: '.ql-editor',
    answer: 'model-response .markdown',
  },
  'doubao-web': {
    url: 'https://www.doubao.com/chat',
    input: '.ProseMirror[contenteditable="true"]',
    answer: '[class*="markdown"]',
  },
}

/** Milliseconds between answer-text polls while waiting for completion. */
const POLL_MS = 600
/** Stable polls required before an answer counts as finished. */
const STABLE_POLLS = 4
/** Hard cap on one turn. */
const TURN_TIMEOUT_MS = 180_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Open options for the Playwright transport. */
export interface PlaywrightTransportOptions {
  /** Persistent Chrome profile directory. */
  profileDir: string
  /** Run headless; default false so the user can watch and intervene. */
  headless?: boolean
  /** Milliseconds `open` waits for the chat input before declaring signed-out. */
  loginWaitMs?: number
  /** Path to a saved storage state (cookies + localStorage) to restore on launch. */
  storageState?: string
}

/**
 * WebChatTransport backed by one persistent Chrome context.
 *
 * Pages are reused per provider; cookies live only in the profile directory,
 * never in provider code or logs.
 */
export class PlaywrightWebChatTransport implements WebChatTransport {
  private context: import('playwright').BrowserContext | undefined
  private readonly pages = new Map<string, import('playwright').Page>()

  constructor(private readonly options: PlaywrightTransportOptions) {}

  async open(providerId: string): Promise<WebChatTransportSession | WebChatTransportClosed | undefined> {
    const driver = SITE_DRIVERS[providerId]
    if (driver === undefined) throw new Error(`no site driver for ${providerId}`)
    const context = await this.browserContext()
    let page = this.pages.get(providerId)
    if (page === undefined || page.isClosed()) {
      page = await context.newPage()
      this.pages.set(providerId, page)
    }
    await page.goto(driver.url, { waitUntil: 'domcontentloaded' })
    const deadline = Date.now() + (this.options.loginWaitMs ?? 20_000)
    let inputFound = false
    try {
      await page.waitForSelector(driver.input, { state: 'visible', timeout: Math.min(5000, deadline - Date.now()) })
      inputFound = true
    } catch {
      // Configured selector unknown on the live page; wait for any editable element.
      const fallback = page.locator('textarea, [contenteditable="true"], [contenteditable="plaintext-only"]').first()
      try {
        await fallback.waitFor({ state: 'visible', timeout: Math.max(0, deadline - Date.now()) })
        const info = await fallback.evaluate((el: Element) => ({ tag: el.tagName, id: (el as HTMLElement).id, cls: (el as HTMLElement).className, ph: el.getAttribute('placeholder') }))
        console.error(`[transport] configured input "${driver.input}" not found; using fallback:`, info)
        inputFound = true
      } catch {
        return { closed: true, reason: 'not-signed-in' }
      }
    }
    if (!inputFound) return { closed: true, reason: 'not-signed-in' }
    return new PlaywrightTransportSession(page, driver)
  }

  /** Persist cookies and localStorage so session cookies survive context close. */
  async saveStorageState(path: string): Promise<void> {
    const context = await this.browserContext()
    await context.storageState({ path })
  }

  /** Release every page and the shared browser context. */
  async dispose(): Promise<void> {
    const context = this.context
    this.context = undefined
    this.pages.clear()
    if (context !== undefined) await context.close()
  }

  private async browserContext(): Promise<import('playwright').BrowserContext> {
    if (this.context === undefined) {
      this.context = await chromium.launchPersistentContext(this.options.profileDir, {
        channel: 'chrome',
        headless: this.options.headless ?? false,
        viewport: null,
        args: ['--disable-blink-features=AutomationControlled'],
        ...this.options.storageState === undefined ? {} : { storageState: this.options.storageState },
      })
      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] })
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
      })
    }
    return this.context
  }
}

/** One open chat page bound to a site driver. */
class PlaywrightTransportSession implements WebChatTransportSession {
  constructor(
    private readonly page: import('playwright').Page,
    private readonly driver: SiteDriver,
  ) {}

  async send(payload: WebChatPayload): Promise<WebChatRawResponse> {
    const before = await this.answerCount()
    await this.submit(payload.prompt)
    await this.assertNotLoggedOut()
    const text = await this.waitForComplete(before)
    return { content: text, finishReason: 'stop' }
  }

  async *stream(payload: WebChatPayload): AsyncIterable<string> {
    const before = await this.answerCount()
    await this.submit(payload.prompt)
    await this.assertNotLoggedOut()
    yield* this.streamUntilComplete(before)
  }

  async close(): Promise<void> {
    if (!this.page.isClosed()) await this.page.close()
  }

  /** Throw when the site redirects to a login or logout page after submit. */
  private async assertNotLoggedOut(): Promise<void> {
    if (this.page.isClosed()) throw new Error('session expired: page closed')
    const url = this.page.url()
    if (/from_logout|sign_in|login|expired/.test(url)) {
      throw new Error(`session expired: redirected to ${url}`)
    }
  }

  /** Run a page action, rethrowing closed-target errors as session-expired. */
  private async runWithSessionGuard<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/Target page, context or browser has been closed/.test(message)) {
        throw new Error('session expired: page closed')
      }
      throw error
    }
  }

  private async answerCount(): Promise<number> {
    return this.runWithSessionGuard(() => this.page.locator(this.driver.answer).count())
  }

  private async lastAnswerText(): Promise<string> {
    const text = await this.runWithSessionGuard(async () => {
      const answers = this.page.locator(this.driver.answer)
      const count = await answers.count()
      if (count === 0) return ''
      return (await answers.nth(count - 1).innerText()).trim()
    })
    return text
  }

  private async submit(prompt: string): Promise<void> {
    await this.runWithSessionGuard(async () => {
      const input = this.page.locator(this.driver.input).first()
      await input.click()
      const tag = await input.evaluate((el: Element) => ({
        name: el.tagName.toLowerCase(),
        editable: (el as HTMLElement).isContentEditable,
      }))
      if (tag.name === 'textarea' || tag.name === 'input') {
        await input.fill(prompt)
      } else {
        await this.page.keyboard.insertText(prompt)
      }
      await this.page.keyboard.press('Enter')
    })
  }

  private async waitForComplete(before: number): Promise<string> {
    let last = ''
    for await (const text of this.streamUntilComplete(before)) last = text
    return last
  }

  private async *streamUntilComplete(before: number): AsyncIterable<string> {
    const deadline = Date.now() + TURN_TIMEOUT_MS
    let stable = 0
    let emitted = ''
    let current = ''
    while (Date.now() < deadline) {
      await sleep(POLL_MS)
      const count = await this.answerCount()
      current = count > before ? await this.lastAnswerText() : ''
      if (current.length > 0 && current === emitted) {
        stable += 1
        if (stable >= STABLE_POLLS) return
      } else {
        stable = 0
      }
      if (current.startsWith(emitted) && current.length > emitted.length) {
        yield current.slice(emitted.length)
        emitted = current
      } else if (current !== emitted && current.length > 0) {
        yield current
        emitted = current
      }
    }
    throw new Error(`turn timeout: answer did not stabilize within ${TURN_TIMEOUT_MS}ms`)
  }
}

export { SITE_DRIVERS }
