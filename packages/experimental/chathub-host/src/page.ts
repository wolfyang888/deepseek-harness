/** Playwright page wrapper: visibility polls, prompt submission, and answer reads. */

import { setTimeout as sleep } from 'node:timers/promises'
import { BrowserTransportError, classifyPageError, isOperationTimeout } from './errors.ts'
import { answerTextOf } from './session.ts'
import type {
  BrowserInputLike,
  BrowserPageLike,
  ChatPageHandle,
  FileChooserLike,
  FilePayloadLike,
  SiteDriverConfig,
} from './types.ts'

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
 * slow hydration still lands inside the same page. The count covers the other
 * slow path too: a site that is still ingesting an attachment ignores the send
 * until it is done, and gemini took anywhere from 6s to 25s to get there
 * (2026-11-26).
 */
const SUBMIT_ATTEMPTS = 5

/**
 * Cap on one round's wait for the composer to clear.
 *
 * The growing window is there to outlast hydration, not to double without
 * bound: five rounds at 3s, 6s, 12s, 24s and 48s would hold a broken turn for
 * a minute and a half before reporting it.
 */
const SEND_WINDOW_MAX_MS = 10_000

/**
 * How long a site gets to register uploaded files when its driver names no
 * window of its own.
 *
 * A site shows the filename in the composer as soon as the upload begins, so
 * this is not a wait for the file to be readable: it is the moment the site
 * binds the file to the next message rather than the one after it.
 */
const DEFAULT_UPLOAD_SETTLE_MS = 2_500

/**
 * How many page-operation budgets a site may spend finishing its upload before
 * the send control has to work.
 *
 * A site shows the attachment chip the instant the pick is answered, but
 * chatgpt keeps its send button disabled until the file reaches its storage
 * host and is processed: on this machine the PUT to
 * `sdmntpritalynorth.oaiusercontent.com` alone took 17s for a 112KB .docx, and
 * the chip read "正在上传文件" the whole time (2026-11-26). The host typed the
 * prompt into a control that would not send, a synthetic Enter does nothing in
 * that editor, and three submit rounds later the turn failed as
 * provider-unavailable while the site was healthy — the question was simply
 * never sent. Four default action caps is a minute: long enough for a slow
 * link, short enough that a stalled upload still ends the turn inside the
 * conversation's own budget.
 */
const SEND_READY_FACTOR = 4

/**
 * How long an attachment menu gets to paint its entries.
 *
 * The menu is rendered after the trigger's own handler runs, so it is a beat
 * behind the click: doubao's "上传文件或图片" entry was still absent when the
 * host clicked it straight away, and the click then waited out the whole
 * operation budget on a node that did not exist yet (2026-11-24). Polling
 * covers the paint without turning a missing entry into a long stall.
 */
const MENU_REVEAL_MS = 5_000

/**
 * A file input seen through the locator face.
 *
 * Playwright's own `setInputFiles` also accepts path strings and single
 * payloads, which this host never passes: attachments arrive as decoded bytes.
 * Widening `BrowserInputLike` to that union would make every real Playwright
 * page stop matching the interface it is declared against, so the upload
 * signature stays local to the one call site that uses it. The method is
 * optional because a page supplied by a driver test may expose no upload input
 * at all, and `attach` reports that case as unsupported.
 */
interface UploadInputLike {
  /** @returns How many nodes match this locator. */
  count(): Promise<number>
  /**
   * @param files - decoded uploads in pick order.
   * @param options - optional operation timeout.
   * @returns Resolves when the input knows the files.
   */
  setInputFiles?(files: readonly FilePayloadLike[], options?: { timeout?: number }): Promise<void>
  /**
   * @param name - attribute name.
   * @param options - optional operation timeout.
   * @returns The attribute value, or `null`.
   */
  getAttribute?(name: string, options?: { timeout?: number }): Promise<string | null>
}

/**
 * Narrow a page event result to a file pick.
 * @param value - whatever `waitForEvent('filechooser')` reported.
 * @returns The pick, or `undefined` when the value carries no `setFiles`.
 */
function asFileChooser(value: unknown): FileChooserLike | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<FileChooserLike>
  return typeof candidate.setFiles === 'function' ? candidate as FileChooserLike : undefined
}

/**
 * Whether one input's `accept` admits every file the turn carries.
 *
 * The attribute is a comma-separated list of extensions (`.docx`), media types
 * (`application/pdf`), or families (`image/*`); its absence means the input
 * takes anything. A browser does not enforce the list when files are set
 * programmatically, so the site's own handler is what drops a mismatch — and
 * it drops it silently.
 * @param accept - the input's `accept` attribute, or `null` when it has none.
 * @param files - files the turn carries.
 * @returns Whether every file is covered by at least one entry.
 */
function acceptsFiles(accept: string | null, files: readonly FilePayloadLike[]): boolean {
  if (accept === null || accept.trim().length === 0) return true
  const entries = accept.split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry.length > 0)
  return files.every((file) => {
    const name = file.name.toLowerCase()
    const type = file.mimeType.toLowerCase()
    return entries.some((entry) => {
      if (entry.startsWith('.')) return name.endsWith(entry)
      if (entry.endsWith('/*')) return type.startsWith(entry.slice(0, entry.length - 1))
      return entry === type
    })
  })
}

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
   * Raise the page's window and focus it.
   * @returns Resolves when the activation request is delivered.
   */
  async bringToFront(): Promise<void> {
    await this.page.bringToFront()
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
   * @param expand - optional control opened before the blocks are read.
   * @returns Each matching block's markup joined by a blank-line separator.
   */
  async reasoningHtml(selector: string, expand?: string): Promise<string> {
    try {
      // The expander is a toggle: a site that opens its steps by default (or
      // one already opened by an earlier read) must not be clicked shut, which
      // would leave the trace emptier than before.
      if (expand !== undefined && await this.newestReasoningEmpty(selector)) await this.revealReasoning(expand)
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
   * Whether the newest reasoning block renders no visible text.
   *
   * A collapsed work-step section keeps its elements and shows only a divider,
   * so the markup is non-empty while the text is not. No block at all counts as
   * empty: such a site renders the steps only once they are opened.
   * @param selector - driver-declared reasoning block selector.
   * @returns true when there is no text to read yet.
   */
  private async newestReasoningEmpty(selector: string): Promise<boolean> {
    const locator = this.page.locator(selector)
    const count = await locator.count()
    if (count === 0) return true
    const html = await locator.nth(count - 1).innerHTML({ timeout: this.actionTimeoutMs })
    return answerTextOf(html).length === 0
  }

  /**
   * Open the newest work-step control, if the site renders one.
   *
   * The newest control is the turn that just finished; earlier cards stay as
   * they are, so a second turn never collapses the reply read before it. The
   * caller only reaches here while the newest steps hold no text, so this is
   * the opening click of a toggle, not a blind click.
   * @param selector - driver-declared control that reveals the work steps.
   */
  private async revealReasoning(selector: string): Promise<void> {
    const controls = this.page.locator(selector)
    const count = await controls.count()
    if (count === 0) return
    await controls.nth(count - 1).click({ timeout: this.actionTimeoutMs })
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
        // A turn that failed after typing leaves its prompt in the composer:
        // the site restores that draft, so the insertion lands at the caret
        // inside the old text and the site sends one mangled message made of
        // both (2026-11-26, after the chatgpt upload stall below).
        if (attempt === 0) await this.clearDraft(composer)
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
      // Shared by every round: the site is given one budget to finish whatever
      // holds its send control back (an attachment upload), not one per round.
      const readyBy = Date.now() + this.actionTimeoutMs * SEND_READY_FACTOR
      for (let round = 0; round < SUBMIT_ATTEMPTS; round += 1) {
        // A retry has to refocus the composer: a toast, a banner, or a modal
        // that came and went moves the focus, and a key press lands wherever
        // the focus is — not in the editor that still shows the prompt.
        if (round > 0) await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await this.submitPrompt(driver, readyBy)
        // An unreadable composer (a textarea keeps its text in `value`) offers
        // no receipt, so its behaviour stays as before: one press, no verdict.
        if (typed === undefined) return
        if (await this.composerCleared(composer, typed, Math.min(settleMs * 2 ** round, SEND_WINDOW_MAX_MS))) return
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
      // The control that never enabled is a different failure from a click the
      // site ignored: the message was never submitted, so nothing was sent.
      if (driver.submitButton !== undefined) {
        const button = this.page.locator(driver.submitButton).first()
        const stuck = await button.isVisible().catch(() => false)
          && await button.isDisabled().catch(() => false)
        if (stuck) {
          throw new BrowserTransportError(
            'chathub-ui-drift',
            `${this.key}: the site kept its send control disabled, so the message was never submitted (an attachment may still be uploading)`,
          )
        }
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
   * Upload files to the site before the prompt is typed.
   *
   * A site's paper-clip button only opens the operating system's file picker,
   * and no automation can answer that dialog; both routes below reach the same
   * end state a real pick does, through the site's own handlers. A driver that
   * names an {@linkcode SiteDriverConfig.uploadTrigger} is driven the way a
   * user drives it — open the menu, choose the entry, answer the pick it
   * starts — while a driver that only names a file input has the files set on
   * that input directly.
   *
   * Which input is set matters as much as how: chatgpt mounts four
   * `input[type=file]` nodes with the image-only ones first, and a document
   * written to one of those is dropped by the site without an error, so the
   * turn then asks its question about a file that was never uploaded
   * (2026-11-24). Selection therefore reads `accept` and skips an input that
   * does not admit every file.
   * @param files - decoded attachments in pick order.
   * @param driver - site facts: the upload trigger, menu entry, and input.
   * @throws BrowserTransportError with `chathub-attachment-unsupported` when
   *   the driver names no upload path, or the page offers none of it.
   */
  async attach(files: readonly FilePayloadLike[], driver: SiteDriverConfig): Promise<void> {
    if (files.length === 0) return
    const trigger = driver.uploadTrigger
    const input = driver.fileInput
    if (trigger === undefined && input === undefined) {
      throw new BrowserTransportError(
        'chathub-attachment-unsupported',
        `${this.key}: this site declares no attachment input`,
      )
    }
    if (trigger !== undefined) await this.pickThroughMenu(files, driver, trigger)
    else if (input !== undefined) await this.setMountedFiles(files, input)
    // The composer accepts the prompt the moment the files are picked, while
    // the upload is still running: the site then sends the message without
    // them. Give the site its window before the text is typed.
    const settleMs = driver.uploadSettleMs ?? DEFAULT_UPLOAD_SETTLE_MS
    if (settleMs > 0) await sleep(Math.min(settleMs, this.actionTimeoutMs))
    // The settle window is a floor, not a verdict: a site that says it is still
    // ingesting the file keeps the turn waiting until it stops.
    if (driver.uploadBusy !== undefined) await this.awaitIngest(driver.uploadBusy)
  }

  /**
   * Wait out the indicator a site shows while it is still ingesting a file.
   *
   * Gemini is the case that forced this: its chip carries a spinner until the
   * bytes are stored, and until then the composer takes the prompt, keeps the
   * send control looking enabled, and drops both the click and the Enter — so
   * every retry round burned without a single send attempt reaching the site.
   * The wait is bounded by the same budget a slow upload gets on the send side;
   * an indicator that never clears leaves the turn to report the send that
   * never went.
   * @param selector - the driver's ingest indicator.
   */
  private async awaitIngest(selector: string): Promise<void> {
    const indicator = this.page.locator(selector).first()
    const deadline = Date.now() + this.actionTimeoutMs * SEND_READY_FACTOR
    for (;;) {
      if (!(await indicator.isVisible().catch(() => false))) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      await sleep(Math.min(250, remaining))
    }
  }

  /**
   * Open the driver's attachment menu and answer the pick it starts.
   *
   * Two shapes exist. A menu entry that starts a native pick (chatgpt, doubao,
   * qianwen) is answered through the chooser it opens; a menu that merely
   * mounts the file inputs (gemini) is answered by writing the files into one
   * of them. The driver separates them: a declared entry means the pick comes
   * from clicking it, and no entry means the inputs are the answer.
   * @param files - decoded attachments in pick order.
   * @param driver - site facts carrying the trigger, entry, and input.
   * @param trigger - the attachment control the caller resolved from the driver.
   * @throws BrowserTransportError when neither a pick nor a usable input appears.
   */
  private async pickThroughMenu(
    files: readonly FilePayloadLike[],
    driver: SiteDriverConfig,
    trigger: string,
  ): Promise<void> {
    // Armed before the click: the pick the site starts is a one-shot event, and
    // a listener attached afterwards would miss it on a fast site. A site that
    // never starts one resolves to `undefined`, so a menu that only mounts
    // inputs leaves no rejection behind.
    const pending = this.waitForPick()
    await this.clickLocator(trigger, `${this.key}: opening the site's attachment menu`)
    if (driver.uploadMenuItem === undefined) {
      // No entry to click: the menu mounts the inputs itself, so poll for one
      // instead of waiting out a pick that this site never starts. Reading the
      // pick first cost gemini a full operation budget on a chooser that never
      // came (2026-11-24).
      if (driver.fileInput !== undefined && await this.setMountedWhenReady(files, driver.fileInput)) return
      const chooser = await pending
      if (chooser !== undefined) {
        await this.answerChooser(chooser, files)
        return
      }
      throw new BrowserTransportError(
        'chathub-attachment-unsupported',
        `${this.key}: the attachment menu started no file pick and mounted no input admitting ${this.namesOf(files)}`,
      )
    }
    await this.clickWhenVisible(driver.uploadMenuItem, `${this.key}: choosing the site's attachment entry`)
    const chooser = await pending
    if (chooser !== undefined) {
      await this.answerChooser(chooser, files)
      return
    }
    // A site can also answer the entry by mounting inputs instead of picking.
    if (driver.fileInput !== undefined && await this.trySetMountedFiles(files, driver.fileInput)) return
    throw new BrowserTransportError(
      'chathub-attachment-unsupported',
      `${this.key}: the attachment menu started no file pick and mounted no input admitting ${this.namesOf(files)}`,
    )
  }

  /**
   * Arm a wait for the pick a site is about to start.
   *
   * The listener is registered before the caller's click — a pick is a
   * one-shot event, and a listener attached afterwards would miss it — and a
   * site that never starts one resolves to `undefined` instead of rejecting.
   * A page face with no event source (a driver test double) has nothing to
   * arm, which is also `undefined`.
   * @returns The pending pick, or `undefined` when this page reports none.
   */
  private waitForPick(): Promise<FileChooserLike | undefined> | undefined {
    if (this.page.waitForEvent === undefined) return undefined
    return this.page.waitForEvent('filechooser', { timeout: this.actionTimeoutMs })
      .then(value => asFileChooser(value), () => undefined)
  }

  /**
   * Answer the pick the site started.
   * @param chooser - the pick.
   * @param files - decoded attachments in pick order.
   * @throws BrowserTransportError classified from the rejected write.
   */
  private async answerChooser(chooser: FileChooserLike, files: readonly FilePayloadLike[]): Promise<void> {
    try {
      await chooser.setFiles(files, { timeout: this.actionTimeoutMs })
    } catch (error) {
      throw classifyPageError(error, `${this.key}: uploading attachments`)
    }
  }

  /**
   * Click one element the driver names, reporting a failure against it.
   * @param selector - selector to click.
   * @param detail - structural context for the failure message.
   * @returns Resolves when the click is delivered.
   */
  private async clickLocator(selector: string, detail: string): Promise<void> {
    try {
      await this.page.locator(selector).first().click({ timeout: this.actionTimeoutMs })
    } catch (error) {
      throw classifyPageError(error, detail)
    }
  }

  /**
   * Click an element a just-opened menu paints, polling instead of waiting on
   * the click's own timeout.
   * @param selector - selector to click.
   * @param detail - structural context for the failure message.
   * @returns Resolves when the click is delivered.
   * @throws BrowserTransportError with `chathub-ui-drift` when the menu never
   *   paints an element matching the selector.
   */
  private async clickWhenVisible(selector: string, detail: string): Promise<void> {
    const locator = this.page.locator(selector).first()
    const deadline = Date.now() + Math.min(MENU_REVEAL_MS, this.actionTimeoutMs)
    for (;;) {
      if (await locator.isVisible().catch(() => false)) break
      if (Date.now() >= deadline) {
        throw new BrowserTransportError('chathub-ui-drift', `${detail}: nothing matching "${selector}" appeared`)
      }
      await sleep(100)
    }
    await this.clickLocator(selector, detail)
  }

  /**
   * Write the files into the first mounted input that admits all of them.
   * @param files - decoded attachments in pick order.
   * @param selector - the driver's file-input selector.
   * @returns Whether an input took the files.
   * @throws BrowserTransportError when the input exists but rejected the write.
   */
  private async trySetMountedFiles(files: readonly FilePayloadLike[], selector: string): Promise<boolean> {
    const input = await this.acceptingInput(files, selector)
    if (input === undefined) return false
    const write = input.setInputFiles?.bind(input)
    if (write === undefined) return false
    try {
      await write(files, { timeout: this.actionTimeoutMs })
    } catch (error) {
      throw classifyPageError(error, `${this.key}: uploading attachments`)
    }
    return true
  }

  /**
   * Write the files into a mounted input, polling while the menu mounts it.
   *
   * The inputs of a menu that reveals them (gemini) appear a beat after the
   * trigger is clicked, so a single probe reads the page before they exist.
   * @param files - decoded attachments in pick order.
   * @param selector - the driver's file-input selector.
   * @returns Whether an input took the files.
   * @throws BrowserTransportError when an input exists but rejected the write.
   */
  private async setMountedWhenReady(files: readonly FilePayloadLike[], selector: string): Promise<boolean> {
    const deadline = Date.now() + Math.min(MENU_REVEAL_MS, this.actionTimeoutMs)
    for (;;) {
      if (await this.trySetMountedFiles(files, selector)) return true
      if (Date.now() >= deadline) return false
      await sleep(100)
    }
  }

  /**
   * Write the files into a mounted input, failing when the page offers none.
   * @param files - decoded attachments in pick order.
   * @param selector - the driver's file-input selector.
   * @returns Resolves when the input took the files.
   * @throws BrowserTransportError with `chathub-attachment-unsupported` when no
   *   matching input exists or every one of them declines the files.
   */
  private async setMountedFiles(files: readonly FilePayloadLike[], selector: string): Promise<void> {
    if (await this.trySetMountedFiles(files, selector)) return
    throw new BrowserTransportError(
      'chathub-attachment-unsupported',
      `${this.key}: no file input matches "${selector}" and accepts ${this.namesOf(files)}`,
    )
  }

  /**
   * Resolve the first matching input whose `accept` admits every file.
   *
   * An input without an `accept` attribute takes anything, and one that
   * declares types is only written when each file's extension or MIME type is
   * among them: a site ignores a file its own input never accepted, and the
   * turn would then ask about an attachment the model cannot see.
   * @param files - decoded attachments in pick order.
   * @param selector - the driver's file-input selector.
   * @returns The input to write, or `undefined` when none matches.
   */
  private async acceptingInput(
    files: readonly FilePayloadLike[],
    selector: string,
  ): Promise<UploadInputLike | undefined> {
    const locator = this.page.locator(selector)
    // A page face that cannot even report a match count (a driver test double)
    // offers nothing to write to; the caller reports that as unsupported
    // instead of sending the prompt without its files.
    let count = 0
    try {
      const probed = await locator.count()
      count = typeof probed === 'number' ? probed : 0
    } catch {
      count = 0
    }
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index) as unknown as UploadInputLike
      if (candidate.setInputFiles === undefined) continue
      const accept = await candidate.getAttribute?.('accept', { timeout: this.actionTimeoutMs })
        .catch(() => null) ?? null
      if (acceptsFiles(accept, files)) return candidate
    }
    return undefined
  }

  /**
   * @param files - files the turn carries.
   * @returns Their names, for a failure message the panel can show.
   */
  private namesOf(files: readonly FilePayloadLike[]): string {
    return files.map(file => file.name).join(', ')
  }

  /**
   * Fire one submit attempt: the driver's send button when it declares one and
   * the page shows it, otherwise its submit key.
   *
   * A control the site has disabled is not a control the site will act on:
   * clicking it waits for it to enable and then times out, and the key path is
   * ignored by editors that only listen for a real click (chatgpt's
   * ProseMirror drops a synthetic Enter). So a disabled control means "the site
   * is not ready", not "use the other path" — the round waits for the site to
   * finish, then clicks. Only a control that never enables inside the budget
   * falls back to the key, and the read-back in {@linkcode submit} judges it.
   * @param driver - site facts carrying the button selector and submit key.
   * @param readyBy - epoch millisecond deadline for the control to enable.
   */
  private async submitPrompt(driver: SiteDriverConfig, readyBy: number): Promise<void> {
    if (driver.submitButton !== undefined) {
      const button = this.page.locator(driver.submitButton).first()
      if (await button.isVisible().catch(() => false) && await this.awaitEnabled(button, readyBy)) {
        await button.click()
        return
      }
    }
    await this.page.keyboard.press(driver.submitKey)
  }

  /**
   * Poll a send control until the site enables it.
   * @param button - the send control.
   * @param readyBy - epoch millisecond deadline shared by every attempt.
   * @returns Whether the control is enabled; `false` once the deadline passes.
   */
  private async awaitEnabled(button: BrowserInputLike, readyBy: number): Promise<boolean> {
    for (;;) {
      // A page that cannot answer reads as "not ready": the caller then keeps
      // the key path, which is what a page without a live control needs.
      if (!(await button.isDisabled().catch(() => true))) return true
      const remaining = readyBy - Date.now()
      if (remaining <= 0) return false
      await sleep(Math.min(250, remaining))
    }
  }

  /**
   * Wipe a draft the site restored from an earlier, failed turn.
   *
   * Chatgpt keeps the composer's text with the conversation, so a turn that
   * died after typing — an upload that never enabled the send — is still there
   * on the next attempt. Inserting then lands at the caret in the middle of
   * that text and the site sends one message made of both (2026-11-26:
   * `…生成AI_1.请只回复两个字：收到docx 供给下载`). The caller has just focused
   * the composer, so select-all stays inside the editor.
   * @param composer - the focused chat input.
   */
  private async clearDraft(composer: BrowserInputLike): Promise<void> {
    const draft = await this.readComposer(composer)
    if (draft === undefined || draft.trim().length === 0) return
    await this.page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await this.page.keyboard.press('Backspace')
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
