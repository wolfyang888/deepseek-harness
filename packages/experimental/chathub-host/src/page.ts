/** Playwright page wrapper: visibility polls, prompt submission, and answer reads. */

import { setTimeout as sleep } from 'node:timers/promises'
import { BrowserTransportError, classifyPageError, isOperationTimeout } from './errors.ts'
import type { BrowserInputLike, BrowserPageLike, ChatPageHandle, SiteDriverConfig } from './types.ts'

/**
 * How long one submitted composer gets to clear before the send reads as dropped.
 *
 * A site clears its composer with an animation, and Doubao's editor keeps the
 * text for a beat after the message is already on its way; judging the send at
 * a single fixed moment read that ordinary latency as a dropped message.
 */
const SEND_SETTLE_MS = 3_000

/**
 * How many times one prompt is submitted before the send reads as dropped.
 *
 * A freshly opened site renders its composer before the framework's handlers
 * attach: the text lands in the DOM, the submit key reaches nobody, and the
 * editor keeps the prompt. One re-press was not enough on doubao.com, and
 * giving up costs the whole turn — a new page, the full prompt again, and the
 * tool results already gathered. Each round waits longer than the last, so a
 * slow hydration still lands inside the same page.
 */
const SUBMIT_ATTEMPTS = 3

/**
 * How long a rendered composer may still lack the session cookie before the
 * page is read as signed out.
 *
 * A site with a `loginCookie` renders its composer for a guest too, so the
 * input cannot prove sign-in; the cookie can. The opposite reading is what
 * matters here: once the composer has painted, a missing cookie means the
 * page is signed out, not slow. Without this the wait polls to the full login
 * deadline — 2026-11-13, gemini-web: every conversation turn took 305s and
 * answered `chathub_signed_out`, and each such turn held the browser session
 * (and the site's pacing budget) for the whole time. The window covers the
 * moment a cookie lands right after first paint; the login flow does not use
 * it, because there the cookie only arrives when the user finishes signing in.
 */
const SIGN_IN_SETTLE_MS = 2_000

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
      if (isOperationTimeout(error)) {
        // A slow portal page says nothing about the DOM we expect; blaming the
        // UI would mask a reachable-but-slow site as drift.
        throw new BrowserTransportError(
          'chathub-turn-timeout',
          `${this.key}: navigating to "${url}" did not settle within ${this.actionTimeoutMs}ms`,
          { cause: error },
        )
      }
      throw classifyPageError(error, `${this.key}: navigating to "${url}"`)
    }
  }

  /**
   * Wait for a signed-in composer, stopping early on a signed-out page or cancellation.
   *
   * A site whose driver declares a `loginCookie` renders its composer for a
   * guest too, so a visible input alone is a false sign-in; the wait reports
   * ready only once that cookie is also present, which is what makes the
   * login window's poll wait for the QR scan to actually land the session.
   *
   * The same fact reads the other way for an ordinary turn: a composer that
   * has painted and still carries no cookie after `SIGN_IN_SETTLE_MS` is a
   * signed-out page, and reporting it then is the whole point of the cookie
   * proof. Waiting out `timeoutMs` instead charges every unsigned-in turn the
   * full login deadline and keeps the browser session busy while it waits.
   * @param driver - site facts: input selector, wall selector, session cookie.
   * @param timeoutMs - longest wait for the signed-in composer.
   * @param pollMs - delay between visibility checks.
   * @param signal - cancels the wait.
   * @param options - `awaitingSignIn` marks the login window: its page is
   *   signed out by definition, so its wall is not a failure and its missing
   *   cookie is not a verdict — only the user finishing sign-in produces one.
   * @returns `true` when the composer is visible — and the session cookie is
   *   present when the site declares one — before the deadline.
   */
  async waitForInput(
    driver: SiteDriverConfig,
    timeoutMs: number,
    pollMs: number,
    signal?: AbortSignal,
    options: { readonly awaitingSignIn?: boolean } = {},
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    let composerSeenAt: number | undefined
    while (Date.now() < deadline) {
      if (signal?.aborted === true) return false
      if (await this.visible(driver.input)) {
        if (driver.loginCookie === undefined || await this.cookiePresent(driver.loginCookie)) return true
        if (!options.awaitingSignIn) {
          // A guest page paints the composer; the cookie is the proof. Give it
          // the settle window to land, then read the page as signed out.
          composerSeenAt ??= Date.now()
          if (Date.now() - composerSeenAt >= SIGN_IN_SETTLE_MS) return false
        }
      } else {
        // A composer that went away restarts the settle window: the page is
        // still loading, and its next paint deserves the full allowance.
        composerSeenAt = undefined
      }
      if (!options.awaitingSignIn && driver.loginWall !== undefined && await this.visible(driver.loginWall)) return false
      if (this.page.isClosed()) {
        throw new BrowserTransportError('chathub-browser-unavailable', `${this.key}: page closed while waiting for input`)
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
   * @param name - cookie name the driver declares as its session proof.
   * @returns Whether the page's context carries that cookie.
   */
  async cookiePresent(name: string): Promise<boolean> {
    try {
      const cookies = await this.page.context().cookies()
      return cookies.some(cookie => cookie.name === name)
    } catch {
      // A context that cannot be queried cannot prove a session either; the
      // wall checks own the failure if the page is really unusable.
      return false
    }
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
   * Read the whole page body's markup.
   *
   * The answer selector keeps a thinking card out of the answer read, so
   * while a site works its last non-thinking answer stays put and reads as
   * no change — indistinguishable from a site that went quiet. The page as
   * a whole still carries the site's "thinking" status text then, and
   * matching it tells a busy site from a stuck one.
   * @returns The body markup, or an empty string when unreadable.
   */
  async bodyMarkup(): Promise<string> {
    try {
      return (await this.page.locator('body').innerHTML({ timeout: this.actionTimeoutMs })).trim()
    } catch (error) {
      if (isOperationTimeout(error)) return ''
      throw classifyPageError(error, `${this.key}: reading page body`)
    }
  }

  /**
   * Read the site's visible chain of thought.
   *
   * Deep-thinking modes keep the reasoning in sibling blocks that the answer
   * selector deliberately excludes. Reading them once, after the reply has
   * stabilized, gives the caller a reasoning trace without polling the whole
   * page on every tick. `innerHTML` is used rather than a text-only helper so
   * this works with the same minimal locator face every other read uses.
   * @param selector - driver-declared reasoning block selector.
   * @returns Each matching block's markup joined by a blank-line separator.
   */
  async reasoningHtml(selector: string): Promise<string> {
    try {
      const locator = this.page.locator(selector)
      const count = await locator.count()
      const parts: string[] = []
      for (let index = 0; index < count; index += 1) {
        parts.push(await locator.nth(index).innerHTML({ timeout: this.actionTimeoutMs }))
      }
      return parts.join('\n\n')
    } catch (error) {
      if (isOperationTimeout(error)) return ''
      throw classifyPageError(error, `${this.key}: reading reasoning "${selector}"`)
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
   * not attached yet accepts the text and drops the key press. The second one
   * is only ever cured by time or by a refocus, so the press is retried with a
   * growing window instead of being given up on after one beat.
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
      const markers = composerMarkers(prompt)
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
        if (text.includes(markers.head) && text.includes(markers.tail)) {
          typed = text
          break
        }
      }
      if (readable && typed === undefined) {
        // A composer that took the opening text but not the closing line is a
        // silent length cap: sending would ask the model to answer half a task.
        throw new BrowserTransportError('chathub-ui-drift', `${this.key}: the composer truncated the prompt; it kept the opening but not the closing text`)
      }
      // What the conversation showed before this prompt: a site that keeps the
      // text in the composer while the answer already streams has advanced
      // here, and that advance is the send's real receipt.
      const before = await this.answerSignature(driver)
      // A page-operation cap smaller than the settle window is a harness in a
      // hurry (or a test); waiting longer than one operation budget there
      // would stall the suite without teaching it anything.
      const settleMs = Math.min(SEND_SETTLE_MS, this.actionTimeoutMs)
      for (let round = 0; round < SUBMIT_ATTEMPTS; round += 1) {
        // A retry has to refocus the composer: a toast, a banner, or a modal
        // that came and went moves the focus, and a key press lands wherever
        // the focus is — not in the editor that still shows the prompt.
        if (round > 0) await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await this.submitPrompt(driver)
        // An unreadable composer (a textarea keeps its text in `value`) offers
        // no receipt, so its behaviour stays as before: one press, no verdict.
        if (typed === undefined) return
        if (await this.composerCleared(composer, typed, settleMs * 2 ** round)) return
        if (await this.answerSignature(driver) !== before) return
      }
      // A send the site silently drops is most often its signed-out gate
      // (a login modal over the composer); report that cause when the site
      // declares one, so the turn asks for login instead of a vague drift.
      if (driver.loginCookie !== undefined && !(await this.cookiePresent(driver.loginCookie))) {
        throw new BrowserTransportError('chathub-signed-out', `${this.key}: the send was dropped and the session cookie is absent`)
      }
      if (driver.loginWall !== undefined && await this.visible(driver.loginWall)) {
        throw new BrowserTransportError('chathub-signed-out', `${this.key}: the send was blocked by the site's signed-out wall`)
      }
      throw new BrowserTransportError(
        'chathub-ui-drift',
        `${this.key}: the input kept the prompt after ${SUBMIT_ATTEMPTS} submits; the message was not sent`,
      )
    } catch (error) {
      throw classifyPageError(error, `${this.key}: submitting the prompt`)
    }
  }

  /**
   * Wait for a submitted composer to stop holding the prompt.
   *
   * Empty means the site took the text; any change means it reacted (a kept
   * draft with a newline, a rendered message). Only a composer that still
   * holds exactly what was typed through the whole window shows a dropped
   * send — checking once, moments after the key press, accused sites that
   * clear their editor with a transition.
   * @param composer - the input element the prompt was typed into.
   * @param typed - the composer text confirmed before submission.
   * @param waitMs - longest wait for the text to leave.
   * @returns `true` once the composer no longer holds the prompt.
   */
  private async composerCleared(composer: BrowserInputLike, typed: string, waitMs: number): Promise<boolean> {
    const deadline = Date.now() + waitMs
    for (;;) {
      const after = await this.readComposer(composer)
      if (after === undefined || after !== typed) return true
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      await sleep(Math.min(250, remaining))
    }
  }

  /**
   * Read the conversation's current answer container as a change marker.
   *
   * The container is not this turn's answer yet, only the text it held when
   * the prompt arrived: any later change proves the site accepted the send,
   * even when its composer keeps the text on screen.
   * @param driver - site facts carrying the answer selectors.
   * @returns The last answer container's markup, or an empty string.
   */
  private async answerSignature(driver: SiteDriverConfig): Promise<string> {
    try {
      return await this.answerHtml(driver.answer, driver.answerBody)
    } catch {
      // An unreadable container is no evidence either way; the send checks
      // below still guard the turn.
      return ''
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
 * Head and tail text of a prompt, used to recognise it inside a composer.
 *
 * The tail matters as much as the head: composers cap insertion length
 * silently — Qianwen's editor keeps the first 10 000 characters — and a
 * head-only check reads a truncated prompt as a delivered one.
 * @param prompt - rendered prompt.
 * @returns Its first and last characters with whitespace collapsed.
 */
function composerMarkers(prompt: string): { head: string; tail: string } {
  const flat = prompt.replace(/\s+/gu, ' ').trim()
  return { head: flat.slice(0, 24), tail: flat.slice(-24) }
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
