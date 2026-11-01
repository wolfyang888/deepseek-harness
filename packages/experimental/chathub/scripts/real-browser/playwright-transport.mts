/**
 * Owner-local Playwright WebChatTransport for real-site validation.
 *
 * Drives the system Chrome through a persistent profile so a manual login in
 * `login` mode is reused by later validation runs. Not shipped with the
 * package and never wired into a profile; it exists to exercise the shipped
 * browser adapters against the real sites.
 */

import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
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
const baseChromium = (require('playwright') as typeof import('playwright')).chromium

/**
 * Resolve a chromium launcher, preferring playwright-extra + stealth when the
 * owner has installed it locally (CHATHUB_STEALTH=1 or the modules are present
 * under /tmp/node_modules). Falls back to vanilla Playwright otherwise.
 */
function resolveChromium(): typeof baseChromium {
  if (process.env.CHATHUB_STEALTH !== '1') return baseChromium
  try {
    const extraRequire = createRequire('/tmp/stealth-loader.js')
    const { chromium: extraChromium } = extraRequire('playwright-extra')
    const stealthModule = extraRequire('puppeteer-extra-plugin-stealth')
    const stealth = typeof stealthModule === 'function' ? stealthModule() : stealthModule.default()
    extraChromium.use(stealth)
    console.error('[transport] using playwright-extra with stealth plugin')
    return extraChromium as typeof baseChromium
  } catch (error) {
    console.error('[transport] stealth unavailable:', error instanceof Error ? error.message : String(error))
    return baseChromium
  }
}

const chromium = resolveChromium()

/** Anti-detection script injected into every page before navigation. */
function antiDetectionScript(): void {
  const define = (obj: object, prop: string, value: unknown) => {
    Object.defineProperty(obj, prop, { get: () => value, configurable: true })
  }
  define(navigator, 'webdriver', undefined)
  define(navigator, 'languages', ['zh-CN', 'zh', 'en-US', 'en'])
  define(navigator, 'hardwareConcurrency', 8)
  define(navigator, 'deviceMemory', 8)
  define(navigator, 'platform', 'Win32')
  const pluginArray = Object.getOwnPropertyNames(navigator.plugins).length > 0
    ? navigator.plugins
    : []
  define(navigator, 'plugins', pluginArray)
  const win = window as Window & { chrome?: Record<string, unknown> }
  if (win.chrome === undefined) {
    win.chrome = { runtime: {}, app: { isInstalled: false } }
  }
  const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions)
  window.navigator.permissions.query = parameters =>
    parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
      : originalQuery(parameters)
  const getParameter = WebGLRenderingContext.prototype.getParameter
  WebGLRenderingContext.prototype.getParameter = function (parameter: number) {
    if (parameter === 37445) return 'Intel Inc.'
    if (parameter === 37446) return 'Intel Iris OpenGL Engine'
    return getParameter.call(this, parameter)
  }
}

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
  private chromeProcess: ReturnType<typeof spawn> | undefined
  private readonly pages = new Map<string, import('playwright').Page>()

  constructor(private readonly options: PlaywrightTransportOptions) {}

  /**
   * Launch Chrome directly (not through Playwright) with a remote debugging
   * port, then attach via CDP. This avoids Playwright's launch-time flags
   * (e.g. --remote-debugging-pipe) that some anti-bot scripts detect.
   */
  private async launchChromeViaCdp(): Promise<import('playwright').BrowserContext> {
    const port = Number(process.env.CHATHUB_CDP_PORT ?? 9222)
    const executable = process.env.CHATHUB_CHROME_BIN ?? 'google-chrome'
    const args = [
      `--user-data-dir=${this.options.profileDir}`,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ]
    if (this.options.headless) args.push('--headless=new')
    this.chromeProcess = spawn(executable, args, { stdio: 'ignore' })
    console.error(`[transport] launched chrome pid=${this.chromeProcess.pid} on port ${port}`)
    // Wait for the debugging endpoint to respond.
    const deadline = Date.now() + 15_000
    let attempt = 0
    while (Date.now() < deadline) {
      attempt += 1
      try {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
        console.error('[transport] CDP connected')
        const contexts = browser.contexts()
        const ctx = contexts[0] ?? (await browser.newContext())
        if (this.options.storageState !== undefined) {
          // Storage state restore is not supported on connected contexts;
          // fall back to cookie injection done by caller if needed.
        }
        return ctx
      } catch {
        await sleep(200)
      }
    }
    throw new Error(`Chrome CDP endpoint on port ${port} did not respond`)
  }

  async open(providerId: string): Promise<WebChatTransportSession | WebChatTransportClosed | undefined> {
    const driver = SITE_DRIVERS[providerId]
    if (driver === undefined) throw new Error(`no site driver for ${providerId}`)
    const context = await this.browserContext()
    let page = this.pages.get(providerId)
    if (page === undefined || page.isClosed()) {
      // CDP-connected contexts: reuse the existing default tab. Creating a new
      // page via context.newPage() on a CDP-attached browser can leave the
      // page without working event subscriptions (waitForSelector hangs).
      const existing = context.pages().filter((p: import('playwright').Page) => !p.isClosed())
      page = existing[0] ?? (await context.newPage())
      this.pages.set(providerId, page)
    }
    await page.goto(driver.url, { waitUntil: 'domcontentloaded' })
    const deadline = Date.now() + (this.options.loginWaitMs ?? 20_000)
    // Manual polling via page.evaluate: CDP-connected pages can leave
    // waitForSelector/locator.waitFor hanging past their own timeout.
    const queryVisible = async (selector: string): Promise<boolean> => {
      try {
        return await page.evaluate((sel: string) => {
          const el = document.querySelector(sel)
          if (el === null) return false
          const style = window.getComputedStyle(el)
          return style.display !== 'none' && style.visibility !== 'hidden' && (el as HTMLElement).offsetParent !== null
        }, selector)
      } catch {
        return false
      }
    }
    let inputFound = false
    while (Date.now() < deadline) {
      if (await queryVisible(driver.input)) {
        inputFound = true
        break
      }
      await sleep(500)
    }
    if (!inputFound) {
      // Fallback: detect any editable element and log its shape.
      const fallbackSelector = 'textarea, [contenteditable="true"], [contenteditable="plaintext-only"]'
      while (Date.now() < deadline) {
        if (await queryVisible(fallbackSelector)) {
          const info = await page.evaluate((sel: string) => {
            const el = document.querySelector(sel) as HTMLElement | null
            return el === null ? null : { tag: el.tagName, id: el.id, cls: el.className, ph: el.getAttribute('placeholder') }
          }, fallbackSelector)
          console.error(`[transport] configured input "${driver.input}" not found; using fallback:`, info)
          inputFound = true
          break
        }
        await sleep(500)
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
    if (context !== undefined) {
      try {
        await context.close()
      } catch {
        // Connected CDP context may already be gone; kill the spawned Chrome.
      }
    }
    if (this.chromeProcess !== undefined) {
      this.chromeProcess.kill('SIGTERM')
      this.chromeProcess = undefined
    }
  }

  private async browserContext(): Promise<import('playwright').BrowserContext> {
    if (this.context === undefined) {
      if (process.env.CHATHUB_CDP === '1') {
        this.context = await this.launchChromeViaCdp()
      } else {
        this.context = await chromium.launchPersistentContext(this.options.profileDir, {
          channel: 'chrome',
          headless: this.options.headless ?? false,
          viewport: null,
          args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
          ],
          ...this.options.storageState === undefined ? {} : { storageState: this.options.storageState },
        })
      }
      if (process.env.CHATHUB_CDP !== '1') {
        console.error('[transport] applying anti-detection init script')
        await this.context.addInitScript(antiDetectionScript)
      }
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
    await this.submit(payload.prompt)
    await this.assertNotLoggedOut()
    const text = await this.waitForComplete(payload.prompt)
    return { content: text, finishReason: 'stop' }
  }

  async *stream(payload: WebChatPayload): AsyncIterable<string> {
    await this.submit(payload.prompt)
    await this.assertNotLoggedOut()
    yield* this.streamUntilComplete(payload.prompt)
  }

  async close(): Promise<void> {
    if (!this.page.isClosed()) await this.page.close()
  }

  /** Throw when the site redirects to a login or logout page after submit. */
  private async assertNotLoggedOut(): Promise<void> {
    if (this.page.isClosed()) throw new Error('session expired: page closed')
    let url = ''
    try {
      url = this.page.url()
    } catch {
      throw new Error('session expired: page navigated away')
    }
    console.error(`[transport] assertNotLoggedOut url=${url}`)
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
      if (/Execution context was destroyed/.test(message)) {
        throw new Error('session expired: page navigated away')
      }
      throw error
    }
  }

  private async answerCount(): Promise<number> {
    return this.runWithSessionGuard(() =>
      this.page.evaluate((sel: string) => {
        const direct = document.querySelectorAll(sel).length
        if (direct > 0) return direct
        // Fallback for sites without a stable answer class (e.g. Doubao):
        // count non-input blocks that carry substantial text.
        const all = document.querySelectorAll('div, p, article, section')
        let count = 0
        for (const el of all) {
          const ht = el as HTMLElement
          if (ht.closest('.ProseMirror, [contenteditable="true"]') !== null) continue
          const t = (ht.innerText ?? '').trim()
          if (t.length > 20 && t.length < 4000) count += 1
        }
        return count
      }, this.driver.answer),
    )
  }

  private async lastAnswerText(): Promise<string> {
    return this.runWithSessionGuard(async () => {
      const text = await this.page.evaluate((sel: string) => {
        // 1. Try the configured answer selector.
        const els = document.querySelectorAll(sel)
        if (els.length > 0) {
          const t = ((els[els.length - 1] as HTMLElement).innerText ?? '').trim()
          if (t.length > 0) return t
        }
        // 2. Doubao: look inside the chat list wrapper for the last message.
        const wrap = document.querySelector('[data-testid="chat_list_wrapper"]')
        if (wrap !== null) {
          const messages = wrap.querySelectorAll('[class*="message"], [class*="msg"], [class*="bubble"], [class*="answer"], [class*="response"]')
          if (messages.length > 0) {
            const t = ((messages[messages.length - 1] as HTMLElement).innerText ?? '').trim()
            if (t.length > 0) return t
          }
          // Fallback: last substantial text block inside the wrapper.
          const blocks = wrap.querySelectorAll('div, p')
          let best = ''
          for (const b of blocks) {
            const ht = b as HTMLElement
            if (ht.closest('.ProseMirror, [contenteditable="true"]') !== null) continue
            const t = (ht.innerText ?? '').trim()
            if (t.length > 10 && t.length < 4000) best = t
          }
          if (best.length > 0) return best
        }
        // 3. Global fallback: last substantial non-input text block.
        const all = document.querySelectorAll('div, p, article, section')
        let best = ''
        for (const el of all) {
          const ht = el as HTMLElement
          if (ht.closest('.ProseMirror, [contenteditable="true"]') !== null) continue
          const t = (ht.innerText ?? '').trim()
          if (t.length > 20 && t.length < 4000) best = t
        }
        return best
      }, this.driver.answer)
      return text.trim()
    })
  }

  private async submit(prompt: string): Promise<void> {
    await this.runWithSessionGuard(async () => {
      console.error('[transport] submit: focusing input')
      const box = await this.page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null
        if (el === null) return null
        el.focus()
        const r = el.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      }, this.driver.input)
      if (box === null) throw new Error('input element not found')
      // Real mouse click (not synthetic) to activate editors like ProseMirror.
      await this.page.mouse.click(box.x, box.y)
      console.error('[transport] submit: typing via keyboard')
      await this.page.keyboard.type(prompt, { delay: 30 })
      console.error('[transport] submit: pressing Enter')
      await this.page.keyboard.press('Enter')
    })
  }

  private async waitForComplete(prompt: string): Promise<string> {
    let last = ''
    for await (const text of this.streamUntilComplete(prompt)) last = text
    return last
  }

  private async *streamUntilComplete(prompt: string): AsyncIterable<string> {
    const deadline = Date.now() + TURN_TIMEOUT_MS
    let stable = 0
    let emitted = ''
    let current = ''
    while (Date.now() < deadline) {
      await sleep(POLL_MS)
      current = await this.lastAnswerText()
      if (current.length === 0 || current === prompt || current.includes(prompt)) {
        current = ''
      }
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
