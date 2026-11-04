/** One turn over a signed-in page: submission, completion polling, and deltas. */

import { setTimeout as sleep } from 'node:timers/promises'
import type { WebChatPayload, WebChatRawResponse, WebChatTransportSession } from '@deepseek-ai/dsh-experimental-chathub'
import { BrowserTransportError } from './errors.ts'
import type { SiteDriverConfig, TransportConfig, TurnGate, TurnPage } from './types.ts'

/** Final stable text carried out of a drained answer stream. */
interface TurnContent {
  content: string
}

/** Entities that carry visible text in provider markup, keyed by lower-cased name. */
const ANSWER_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
}

/**
 * Visible text of one answer markup.
 *
 * Answers are carried as markup so the panel can render their emphasis, lists,
 * tables, code, and images; the turn itself still needs the plain text to tell a
 * prompt echo or a site status line from a real answer. Text-only consumers of
 * a raw response — the LLM adapter route — need the same conversion, so this is
 * exported.
 * @param html - answer container markup.
 * @returns Whitespace-collapsed text without tags.
 */
export function answerTextOf(html: string): string {
  return html
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/giu, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&([#0-9a-z]+);/giu, (_match: string, name: string) => ANSWER_ENTITIES[name.toLowerCase()] ?? ' ')
    .replace(/\s+/gu, ' ')
    .trim()
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
      const current = this.answerFrom(
        await this.page.answerHtml(this.driver.answer, this.driver.answerBody),
        prompt,
      )
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
   * Treat the prompt echo, a thinking placeholder, or an empty container as
   * "no answer yet".
   * @param html - markup read from the answer container.
   * @param prompt - rendered prompt.
   * @returns The answer markup, or an empty string.
   */
  private answerFrom(html: string, prompt: string): string {
    if (html.length === 0) return ''
    const normalized = answerTextOf(html)
    const promptNormalized = prompt.replace(/\s+/g, ' ').trim()
    if (normalized === promptNormalized) return ''
    // A site's "thinking" placeholder sits in the same container and can stay
    // unchanged for several polls; counting it as an answer ends the turn with
    // the placeholder instead of the reply that follows it.
    if (this.driver.pending !== undefined && this.isPending(normalized, this.driver.pending)) return ''
    return html
  }

  /**
   * Whether the answer slot holds nothing but the site's working status.
   * @param normalized - whitespace-normalized answer text.
   * @param pattern - the driver's status-phrase pattern.
   * @returns true when removing the status phrases leaves only punctuation.
   */
  private isPending(normalized: string, pattern: string): boolean {
    const remainder = normalized
      .replace(new RegExp(pattern, 'gi'), '')
      .replace(/[\s·•,，.。:：;；!！?？~～|/\\\-—_]+/g, '')
    return remainder.length === 0
  }
}
