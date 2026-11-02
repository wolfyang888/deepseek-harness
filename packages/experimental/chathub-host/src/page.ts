/** Playwright page wrapper: visibility polls, prompt submission, and answer reads. */

import { setTimeout as sleep } from 'node:timers/promises'
import { BrowserTransportError, classifyPageError, isOperationTimeout } from './errors.ts'
import type { BrowserPageLike, ChatPageHandle, SiteDriverConfig } from './types.ts'

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
   * Read the last answer container's text.
   * @param selector - answer container selector.
   * @returns Trimmed answer text, or an empty string when the container does not exist yet.
   */
  async answerText(selector: string): Promise<string> {
    try {
      const locator = this.page.locator(selector)
      const count = await locator.count()
      if (count === 0) return ''
      return (await locator.nth(count - 1).innerText({ timeout: this.actionTimeoutMs })).trim()
    } catch (error) {
      if (isOperationTimeout(error)) return ''
      throw classifyPageError(error, `${this.key}: reading answer "${selector}"`)
    }
  }

  /**
   * Focus the chat input, insert the prompt, and submit it.
   *
   * The prompt is inserted in one text insertion rather than typed keystroke
   * by keystroke: typing presses Enter for every newline, and sites that
   * submit on Enter would send each prompt line as its own message.
   * @param prompt - rendered prompt.
   * @param driver - site facts for input and submission.
   * @param typeDelayMs - settle delay between insertion and the submit key.
   * @returns Resolves when the prompt is submitted.
   */
  async submit(prompt: string, driver: SiteDriverConfig, typeDelayMs: number): Promise<void> {
    try {
      const box = await this.page.locator(driver.input).first().boundingBox({ timeout: this.actionTimeoutMs })
      if (box === null) {
        throw new BrowserTransportError('chathub-ui-drift', `${this.key}: input "${driver.input}" has no layout box`)
      }
      await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await this.page.keyboard.insertText(prompt)
      await sleep(typeDelayMs)
      await this.page.keyboard.press(driver.submitKey)
    } catch (error) {
      throw classifyPageError(error, `${this.key}: submitting the prompt`)
    }
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
   * @param selector - element selector.
   * @returns Whether an element matching the selector is visible.
   */
  private async visible(selector: string): Promise<boolean> {
    try {
      return await this.page.locator(selector).first().isVisible()
    } catch (error) {
      throw classifyPageError(error, `${this.key}: inspecting "${selector}"`)
    }
  }
}
