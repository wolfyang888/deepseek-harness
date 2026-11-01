/** One turn over a signed-in page: submission, completion polling, and deltas. */

import { setTimeout as sleep } from 'node:timers/promises'
import type { WebChatPayload, WebChatRawResponse, WebChatTransportSession } from '@deepseek-ai/dsh-experimental-chathub'
import { BrowserTransportError } from './errors.ts'
import type { SiteDriverConfig, TransportConfig, TurnGate, TurnPage } from './types.ts'

/** Final stable text carried out of a drained answer stream. */
interface TurnContent {
  content: string
}

/**
 * Consume an answer stream without exposing its deltas.
 * @param stream - deltas produced while an answer stabilizes.
 * @returns Resolves when the stream completes.
 */
async function drain(stream: AsyncIterable<string>): Promise<void> {
  for await (const delta of stream) void delta
}

/**
 * Browser session implementing the ChatHub transport session contract.
 *
 * Turns for one key are serialized through the runtime's gate; completion is
 * decided by the last answer container's text stabilizing over consecutive
 * polls, and streaming only emits text deltas read from that container.
 */
export class PlaywrightChatSession implements WebChatTransportSession {
  /**
   * @param key - provider or conversation key.
   * @param page - signed-in page bound to this key.
   * @param driver - site facts for input, answer, and submission.
   * @param config - turn, poll, and queue policy.
   * @param gate - per-key turn serialization and page release.
   */
  constructor(
    private readonly key: string,
    private readonly page: TurnPage,
    private readonly driver: SiteDriverConfig,
    private readonly config: TransportConfig,
    private readonly gate: TurnGate,
  ) {}

  /**
   * Send one prompt and wait for the site's complete answer.
   * @param payload - provider-normalized page payload.
   * @returns The raw answer before normalization.
   */
  async send(payload: WebChatPayload): Promise<WebChatRawResponse> {
    const release = await this.gate.acquireTurn(this.key, this.config.maxQueuedTurns)
    try {
      await this.page.submit(payload.prompt, this.driver, this.config.typeDelayMs)
      const collected: TurnContent = { content: '' }
      await drain(this.streamUntilComplete(payload.prompt, collected))
      return { content: collected.content, finishReason: 'stop' }
    } finally {
      release()
    }
  }

  /**
   * Send one prompt and yield text deltas as the answer container grows.
   * @param payload - provider-normalized page payload.
   * @returns Text deltas in page order.
   */
  async *stream(payload: WebChatPayload): AsyncIterable<string> {
    const release = await this.gate.acquireTurn(this.key, this.config.maxQueuedTurns)
    try {
      await this.page.submit(payload.prompt, this.driver, this.config.typeDelayMs)
      yield* this.streamUntilComplete(payload.prompt, { content: '' })
    } finally {
      release()
    }
  }

  /** @returns Resolves when the page is released. */
  async close(): Promise<void> {
    await this.gate.release(this.key)
  }

  /**
   * Poll the answer container until its text stabilizes, yielding deltas.
   * @param prompt - rendered prompt whose echo is not an answer.
   * @param collected - receives the final stable text when the turn completes.
   * @returns Text deltas as the answer grows.
   */
  private async *streamUntilComplete(prompt: string, collected: TurnContent): AsyncIterable<string> {
    const pollMs = this.driver.pollMs ?? this.config.pollMs
    const stablePolls = this.driver.stablePolls ?? this.config.stablePolls
    const deadline = Date.now() + this.config.turnTimeoutMs
    let lastText = ''
    let stable = 0
    let emitted = ''
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new BrowserTransportError(
          'chathub-turn-timeout',
          `${this.key}: answer did not stabilize within ${this.config.turnTimeoutMs}ms`,
        )
      }
      await sleep(Math.min(pollMs, remaining))
      this.assertNotSignedOut()
      const current = this.answerFrom(await this.page.answerText(this.driver.answer), prompt)
      if (current.length > 0 && current === lastText) stable += 1
      else stable = 0
      lastText = current
      if (stable >= stablePolls) {
        collected.content = lastText
        return
      }
      if (current.length === 0) continue
      if (current.startsWith(emitted) && current.length > emitted.length) {
        const delta = current.slice(emitted.length)
        emitted = current
        yield delta
      } else if (current !== emitted) {
        emitted = current
        yield current
      }
    }
  }

  /**
   * Reject a page that closed or navigated to a login path mid-turn.
   * @throws BrowserTransportError with `chathub-signed-out`.
   */
  private assertNotSignedOut(): void {
    if (this.page.isClosed()) {
      throw new BrowserTransportError('chathub-signed-out', `${this.key}: page closed during the turn`)
    }
    if (this.driver.signedOutPath === undefined) return
    let path = ''
    try {
      path = new URL(this.page.url()).pathname
    } catch {
      // An unparsable URL means the page left the site; report the same signed-out token.
      throw new BrowserTransportError('chathub-signed-out', `${this.key}: page navigated off-site`)
    }
    if (new RegExp(this.driver.signedOutPath, 'i').test(path)) {
      throw new BrowserTransportError('chathub-signed-out', `${this.key}: redirected to a login path`)
    }
  }

  /**
   * Treat the prompt echo or an empty container as "no answer yet".
   * @param text - text read from the answer container.
   * @param prompt - rendered prompt.
   * @returns The answer candidate, or an empty string.
   */
  private answerFrom(text: string, prompt: string): string {
    if (text.length === 0 || text === prompt) return ''
    return text
  }
}
