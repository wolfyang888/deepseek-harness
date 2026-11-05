/** Playwright page wrapper: visibility polls, prompt submission, and answer reads. */

import { setTimeout as sleep } from 'node:timers/promises'
import { BrowserTransportError, classifyPageError, isOperationTimeout } from './errors.ts'
import type { BrowserInputLike, BrowserPageLike, ChatPageHandle, SiteDriverConfig } from './types.ts'

/**
 * One browser page bound to a key and its operation timeout.
 *
 * Visibility and completion use explicit polling rather than Playwright's
 * waiting helpers, because pages attached over CDP can leave those waits
 * hanging past their own timeout.
 */
export class PlaywrightPage implements ChatPageHandle {
  /**
   * @param page - underlying browser page.
   * @param key - provider or conversation key used in diagnostics.
   * @param actionTimeoutMs - cap on one page operation.
   */
  constructor(
    private readonly page: BrowserPageLike,
    private readonly key: string,
    private readonly actionTimeoutMs: number,
  ) {}

  /** @returns Whether the page has been closed. */
  isClosed(): boolean {
    return this.page.isClosed()
  }

  /** @returns The current absolute page URL. */
  url(): string {
    return this.page.url()
  }

  /**
   * Navigate to a site's chat entry.
   * @param url - destination URL.
   * @returns Resolves when the document is ready.
   */
  async goto(url: string): Promise<void> {
    try {
      await this.page.goto(url, { timeout: this.actionTimeoutMs, waitUntil: 'domcontentloaded' })
    } catch (error) {
      throw classifyPageError(error, `${this.key}: navigating to "${url}"`)
    }
  }

  /**
   * Wait for the chat input, stopping early on a signed-out wall or cancellation.
   * @param input - chat input selector.
   * @param loginWall - signed-out wall selector, when the site has one.
   * @param timeoutMs - longest wait for either element.
   * @param pollMs - delay between visibility checks.
   * @param signal - cancels the wait.
   * @returns `true` when the chat input is visible before the deadline.
   */
  async waitForInput(
    input: string,
    loginWall: string | undefined,
    timeoutMs: number,
    pollMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (signal?.aborted === true) return false
      if (await this.visible(input)) return true
      if (loginWall !== undefined && await this.visible(loginWall)) return false
      if (this.page.isClosed()) {
        throw new BrowserTransportError('chathub-signed-out', `${this.key}: page closed while waiting for input`)
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      try {
        await sleep(Math.min(pollMs, remaining), undefined, { signal })
      } catch {
        // A timer guarded by the caller's signal rejects only for that cancellation.
        return false
      }
    }
    return false
  }

  /**
   * Read the last answer container's markup.
   *
   * The container is read as markup rather than text: an answer's emphasis,
   * lists, tables, code, and images exist only in the site's DOM, and its
   * `innerText` flattens all of them into plain lines. The panel sanitizes and
   * lays the markup out itself.
   * @param selector - answer container selector.
   * @param body - optional reply-body selector; when it matches inside the last
   *   container, its last match is read instead of the container, which keeps
   *   the site's thinking and tool cards out of the answer.
   * @returns Trimmed answer markup, or an empty string when the container does not exist yet.
   */
  async answerHtml(selector: string, body?: string): Promise<string> {
    try {
      const locator = this.page.locator(selector)
      const count = await locator.count()
      if (count === 0) return ''
      const container = locator.nth(count - 1)
      const target = body === undefined ? container : await this.bodyOf(container, body)
      return (await target.innerHTML({ timeout: this.actionTimeoutMs })).trim()
    } catch (error) {
      if (isOperationTimeout(error)) return ''
      throw classifyPageError(error, `${this.key}: reading answer "${selector}"`)
    }
  }

  /**
   * Resolve the reply body inside one answer container.
   * @param container - the newest answer container.
   * @param body - reply-body selector.
   * @returns The last matching descendant, or the container when none matches.
   */
  private async bodyOf(container: BrowserInputLike, body: string): Promise<BrowserInputLike> {
    const inner = container.locator(body)
    const count = await inner.count()
    return count === 0 ? container : inner.nth(count - 1)
  }

  /**
   * Focus the chat input, insert the prompt, and submit it.
   *
   * The prompt is inserted in one text insertion rather than typed keystroke
   * by keystroke: typing presses Enter for every newline, and sites that
   * submit on Enter would send each prompt line as its own message.
   *
   * Two failures are silent without the checks below, and both end the turn
   * as an empty answer long after the fact: a selector whose first match is a
   * hidden composer takes the text nowhere, and a composer whose handlers are
   * not attached yet accepts the text and drops the key press.
   * @param prompt - rendered prompt.
   * @param driver - site facts for input and submission.
   * @param typeDelayMs - settle delay between insertion and the submit key.
   * @returns Resolves when the prompt is submitted.
   */
  async submit(prompt: string, driver: SiteDriverConfig, typeDelayMs: number): Promise<void> {
    try {
      const composer = await this.visibleInput(driver.input)
      const box = await composer.boundingBox({ timeout: this.actionTimeoutMs })
      if (box === null) {
        throw new BrowserTransportError('chathub-ui-drift', `${this.key}: input "${driver.input}" has no layout box`)
      }
      const marker = composerMarker(prompt)
      let typed: string | undefined
      let readable = false
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await this.page.keyboard.insertText(prompt)
        await sleep(Math.max(typeDelayMs, 120))
        const text = await this.readComposer(composer)
        // `undefined` means the composer is unreadable (a textarea keeps its
        // text in `value`, not markup); its behaviour stays as before.
        if (text === undefined) break
        readable = true
        if (text.includes(marker)) {
          typed = text
          break
        }
      }
      if (readable && typed === undefined) {
        throw new BrowserTransportError('chathub-ui-drift', `${this.key}: the input never took the prompt`)
      }
      await this.submitPrompt(driver)
      await sleep(Math.max(typeDelayMs, 600))
      if (typed === undefined) return
      const after = await this.readComposer(composer)
      // Empty means the site took it; any change means the site reacted (a
      // kept draft with a newline, a rendered message). Only a composer that
      // is identical to what was typed shows the submit was dropped.
      if (after === undefined || after !== typed) return
      await this.submitPrompt(driver)
      await sleep(Math.max(typeDelayMs, 600))
      if (await this.readComposer(composer) === typed) {
        // A send the site silently drops is most often its signed-out gate
        // (a login modal over the composer); report that cause when the site
        // declares one, so the turn asks for login instead of a vague drift.
        if (driver.loginWall !== undefined && await this.visible(driver.loginWall)) {
          throw new BrowserTransportError('chathub-signed-out', `${this.key}: the send was blocked by the site's signed-out wall`)
        }
        throw new BrowserTransportError('chathub-ui-drift', `${this.key}: the input kept the prompt; the message was not sent`)
      }
    } catch (error) {
      throw classifyPageError(error, `${this.key}: submitting the prompt`)
    }
  }

  /**
   * Fire one submit attempt: the driver's send button when it declares one
   * and the page still shows it enabled, otherwise its submit key.
   *
   * Qianwen's composer accepts inserted text but ignores a synthetic Enter —
   * the only working path is its `发送消息` button — while DeepSeek submits on
   * the key. The read-back confirmation in {@linkcode submit} judges whichever
   * path ran, so a button click that the site ignores still ends as drift.
   * @param driver - site facts carrying the button selector and submit key.
   */
  private async submitPrompt(driver: SiteDriverConfig): Promise<void> {
    if (driver.submitButton !== undefined) {
      const button = this.page.locator(driver.submitButton).first()
      if (await button.isVisible().catch(() => false)
        && !(await button.isDisabled().catch(() => true))) {
        await button.click()
        return
      }
    }
    await this.page.keyboard.press(driver.submitKey)
  }

  /**
   * Resolve the chat input the user would type into.
   *
   * A site can ship several matching nodes (a hidden legacy textarea, an
   * off-screen editor) and only one of them is the composer.
   * @param selector - chat input selector.
   * @returns The first visible match, or the first match when none reports as visible.
   */
  private async visibleInput(selector: string): Promise<BrowserInputLike> {
    const locator = this.page.locator(selector)
    const count = await locator.count()
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index)
      if (await candidate.isVisible()) return candidate
    }
    // Nothing reported as visible: the caller's bounding-box check owns the
    // failure, which keeps the diagnosis in one place.
    return locator.first()
  }

  /**
   * Read one composer's text back.
   * @param composer - the input element the prompt was typed into.
   * @returns Its visible text, or `undefined` when it cannot be read.
   */
  private async readComposer(composer: BrowserInputLike): Promise<string | undefined> {
    const html = await composer.innerHTML({ timeout: this.actionTimeoutMs })
    // A textarea renders no children, so an empty read says nothing about it.
    if (html.trim().length === 0) return undefined
    return plainText(html)
  }

  /** @returns Resolves when the page is closed. */
  async close(): Promise<void> {
    if (this.page.isClosed()) return
    try {
      await this.page.close()
    } catch {
      // A tab the user already closed reports itself as gone; nothing remains to release.
    }
  }

  /**
   * @param selector - signed-out wall selector.
   * @returns Whether the wall is currently visible.
   */
  async wallVisible(selector: string): Promise<boolean> {
    return this.visible(selector)
  }

  /**
   * @param selector - element selector.
   * @returns Whether any element matching the selector is visible.
   *
   * Sites ship several matches for one composer selector — a hidden legacy
   * textarea ahead of the live editor — so the check scans every match
   * instead of trusting the first.
   */
  private async visible(selector: string): Promise<boolean> {
    try {
      const locator = this.page.locator(selector)
      const count = await locator.count()
      for (let index = 0; index < count; index += 1) {
        if (await locator.nth(index).isVisible()) return true
      }
      return false
    } catch (error) {
      throw classifyPageError(error, `${this.key}: inspecting "${selector}"`)
    }
  }
}

/**
 * Opening text of a prompt, used to recognise it inside a composer.
 * @param prompt - rendered prompt.
 * @returns Its first characters with whitespace collapsed.
 */
function composerMarker(prompt: string): string {
  return prompt.replace(/\s+/gu, ' ').trim().slice(0, 24)
}

/**
 * Visible text of a composer's markup.
 * @param html - composer `innerHTML`.
 * @returns Text with entities decoded and whitespace collapsed.
 */
function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#(?:39|x27);/gu, "'")
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ')
    .trim()
}
