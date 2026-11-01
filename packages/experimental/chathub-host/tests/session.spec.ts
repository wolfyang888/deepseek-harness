/** Session submission, completion polling, deltas, timeout, and page invalidation. */

import { expect, it } from 'vitest'
import { PlaywrightChatSession } from '../src/session.ts'
import type { SiteDriverConfig, TransportConfig, TurnGate, TurnPage } from '../src/types.ts'
import type { WebChatPayload } from '@deepseek-ai/dsh-experimental-chathub'

const DRIVER: SiteDriverConfig = {
  url: 'https://fake.test/chat',
  input: '#prompt',
  answer: '.answer',
  signedOutPath: 'login|logout',
  submitKey: 'Enter',
}

const CONFIG: TransportConfig = {
  loginTimeoutMs: 1,
  turnTimeoutMs: 200,
  actionTimeoutMs: 1,
  pollMs: 1,
  stablePolls: 2,
  maxQueuedTurns: 1,
  typeDelayMs: 5,
}

function payload(prompt = 'hello'): WebChatPayload {
  return { providerId: 'deepseek-web', system: '', messages: [], prompt, meta: { origin: 'raw-messages' } }
}

/** Turn page replaying a scripted answer sequence. */
class ScriptedPage implements TurnPage {
  closed = false
  urlValue = 'https://fake.test/chat'
  submitted: string[] = []
  reads = 0
  submitError: unknown
  /** Answers returned by successive reads; the last answer repeats once exhausted. */
  answers: string[] = []

  /** @returns Whether the page is closed. */
  isClosed(): boolean {
    return this.closed
  }

  /** @returns The current URL. */
  url(): string {
    return this.urlValue
  }

  /** @returns The next scripted answer. */
  async answerText(): Promise<string> {
    const index = Math.min(this.reads, this.answers.length - 1)
    this.reads += 1
    return this.answers[index] ?? ''
  }

  /**
   * @param prompt - prompt the session submits.
   * @returns Resolves unless the test configured a failure.
   */
  async submit(prompt: string): Promise<void> {
    if (this.submitError !== undefined) throw this.submitError
    this.submitted.push(prompt)
  }
}

/** Gate double recording leases without serializing. */
class FakeGate implements TurnGate {
  acquireError: unknown
  acquired: { key: string; maxQueuedTurns: number }[] = []
  released: string[] = []
  leases = 0

  /**
   * @param key - provider or conversation key.
   * @param maxQueuedTurns - queue bound.
   * @returns A release function.
   */
  async acquireTurn(key: string, maxQueuedTurns: number): Promise<() => void> {
    if (this.acquireError !== undefined) throw this.acquireError
    this.acquired.push({ key, maxQueuedTurns })
    return () => {
      this.leases += 1
    }
  }

  /**
   * @param key - page key to release.
   * @returns Resolves after recording the release.
   */
  async release(key: string): Promise<void> {
    this.released.push(key)
  }
}

function session(page = new ScriptedPage(), gate = new FakeGate(), driver = DRIVER) {
  return { session: new PlaywrightChatSession('deepseek-web', page, driver, CONFIG, gate), page, gate }
}

it('sends one prompt and returns the stabilized answer', async () => {
  const { session: chat, page } = session()
  page.answers = ['a', 'ab', 'ab', 'ab']
  const answer = await chat.send(payload())
  expect(answer).toEqual({ content: 'ab', finishReason: 'stop' })
  expect(page.submitted).toEqual(['hello'])
})

it('does not treat the prompt echo or an empty container as an answer', async () => {
  const { session: chat, page } = session()
  page.answers = ['', 'hello', 'hello answer', 'hello answer', 'hello answer']
  await expect(chat.send(payload())).resolves.toMatchObject({ content: 'hello answer' })
})

it('streams prefix deltas as the answer grows', async () => {
  const { session: chat, page } = session()
  page.answers = ['a', 'ab', 'abc', 'abc', 'abc']
  const deltas: string[] = []
  for await (const delta of chat.stream?.(payload()) ?? []) deltas.push(delta)
  expect(deltas).toEqual(['a', 'b', 'c'])
})

it('yields the full text when the site replaces the answer', async () => {
  const { session: chat, page } = session()
  page.answers = ['a', 'b', 'b', 'b']
  const deltas: string[] = []
  for await (const delta of chat.stream?.(payload()) ?? []) deltas.push(delta)
  expect(deltas).toEqual(['a', 'b'])
})

it('skips a replacement that matches what was already emitted', async () => {
  const { session: chat, page } = session()
  page.answers = ['a', 'a', 'a', 'a']
  const deltas: string[] = []
  for await (const delta of chat.stream?.(payload()) ?? []) deltas.push(delta)
  expect(deltas).toEqual(['a'])
})

it('fails a turn that never stabilizes', async () => {
  const page = new ScriptedPage()
  page.answers = ['']
  const slow: TransportConfig = { ...CONFIG, turnTimeoutMs: 20 }
  const timed = new PlaywrightChatSession('deepseek-web', page, DRIVER, slow, new FakeGate())
  await expect(timed.send(payload())).rejects.toMatchObject({ token: 'chathub-turn-timeout' })
})

it('fails when the page closes mid-turn', async () => {
  const { session: chat, page } = session()
  page.answers = ['answer']
  page.closed = true
  await expect(chat.send(payload())).rejects.toMatchObject({ token: 'chathub-signed-out' })
})

it('fails when the site redirects to a login path', async () => {
  const { session: chat, page } = session()
  page.answers = ['answer']
  page.urlValue = 'https://fake.test/login'
  await expect(chat.send(payload())).rejects.toMatchObject({ token: 'chathub-signed-out' })
})

it('fails when the site URL cannot be parsed', async () => {
  const { session: chat, page } = session()
  page.answers = ['answer']
  page.urlValue = '::'
  await expect(chat.send(payload())).rejects.toMatchObject({ token: 'chathub-signed-out' })
})

it('skips the path check when the driver has no signed-out pattern', async () => {
  const unsigned: SiteDriverConfig = { url: DRIVER.url, input: DRIVER.input, answer: DRIVER.answer, submitKey: DRIVER.submitKey }
  const { session: chat, page } = session(undefined, undefined, unsigned)
  page.answers = ['answer', 'answer', 'answer']
  page.urlValue = '::'
  await expect(chat.send(payload())).resolves.toMatchObject({ content: 'answer' })
})

it('releases the turn lease after success and failure', async () => {
  const success = session()
  success.page.answers = ['answer', 'answer', 'answer']
  await success.session.send(payload())
  expect(success.gate.leases).toBe(1)
  const failure = session()
  failure.page.submitError = new Error('submit failed')
  await expect(failure.session.send(payload())).rejects.toThrow('submit failed')
  expect(failure.gate.leases).toBe(1)
})

it('propagates a full turn queue', async () => {
  const gate = new FakeGate()
  gate.acquireError = new Error('queue full')
  const { session: chat } = session(new ScriptedPage(), gate)
  await expect(chat.send(payload())).rejects.toThrow('queue full')
})

it('uses driver poll and stability overrides', async () => {
  const { session: chat, page } = session(undefined, undefined, { ...DRIVER, stablePolls: 1, pollMs: 1 })
  page.answers = ['answer']
  await expect(chat.send(payload())).resolves.toMatchObject({ content: 'answer' })
})

it('releases the page when the session closes', async () => {
  const { session: chat, gate } = session()
  await chat.close()
  expect(gate.released).toEqual(['deepseek-web'])
})
