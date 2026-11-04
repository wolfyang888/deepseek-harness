/** Session submission, completion polling, deltas, timeout, and page invalidation. */

import { expect, it } from 'vitest'
import { PlaywrightChatSession, answerMarkupText, answerTextOf } from '../src/session.ts'
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
  /** Selectors each poll asked for, so a driver's body scope is observable. */
  readonly asked: { selector: string; body: string | undefined }[] = []
  submitError: unknown
  /** Answers returned by successive reads; the last answer repeats once exhausted. */
  answers: string[] = []
  /** Text the container already holds before the prompt is submitted. */
  before = ''

  /** @returns Whether the page is closed. */
  isClosed(): boolean {
    return this.closed
  }

  /** @returns The current URL. */
  url(): string {
    return this.urlValue
  }

  /**
   * @param selector - answer container selector.
   * @param body - reply-body selector the driver declared.
   * @returns The next scripted answer markup.
   */
  async answerHtml(selector: string, body?: string): Promise<string> {
    this.asked.push({ selector, body })
    // Before submission the container is whatever the page already displayed.
    if (this.submitted.length === 0) return this.before
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

it('sends one prompt and returns the stabilized answer markup', async () => {
  const { session: chat, page } = session()
  page.answers = ['<p>a</p>', '<p>ab</p>', '<p>ab</p>', '<p>ab</p>']
  const answer = await chat.send(payload())
  // The markup, not its text: emphasis, tables, and images survive the read.
  expect(answer).toEqual({ content: '<p>ab</p>', finishReason: 'stop' })
  expect(page.submitted).toEqual(['hello'])
})

it('does not treat the prompt echo or an empty container as an answer', async () => {
  const { session: chat, page } = session()
  page.answers = ['', '<p>hello</p>', '<p>hello answer</p>', '<p>hello answer</p>', '<p>hello answer</p>']
  await expect(chat.send(payload())).resolves.toMatchObject({ content: '<p>hello answer</p>' })
})

it('never reads text the page already showed as the answer', async () => {
  const { page } = session()
  // A landing page's recommendation card sits in the same node the driver
  // calls an answer; reading it would end the turn on words nobody asked for.
  page.before = '<p>ChatGLM voice</p>'
  page.answers = ['<p>ChatGLM voice</p>']
  const slow: TransportConfig = { ...CONFIG, turnTimeoutMs: 30 }
  const timed = new PlaywrightChatSession('deepseek-web', page, DRIVER, slow, new FakeGate())
  await expect(timed.send(payload())).rejects.toMatchObject({ token: 'chathub-turn-timeout' })
})

it('accepts the answer that replaces a leftover block', async () => {
  const { session: chat, page } = session()
  page.before = '<p>leftover</p>'
  page.answers = ['<p>leftover</p>', '<p>real</p>', '<p>real</p>', '<p>real</p>']
  await expect(chat.send(payload())).resolves.toMatchObject({ content: '<p>real</p>' })
})

it('reads the answer through the driver body scope', async () => {
  const driver: SiteDriverConfig = { ...DRIVER, answerBody: '.qk-markdown' }
  const { session: chat, page } = session(new ScriptedPage(), new FakeGate(), driver)
  page.answers = ['<p>答案</p>', '<p>答案</p>']
  await chat.send(payload())
  expect(page.asked[0]).toEqual({ selector: '.answer', body: '.qk-markdown' })
})

it('filters an echo whose whitespace the site rendered differently', async () => {
  const { session: chat, page } = session()
  page.answers = ['  <p>hello\n</p>', '<p>real   answer</p>', '<p>real   answer</p>', '<p>real   answer</p>']
  await expect(chat.send(payload())).resolves.toMatchObject({ content: '<p>real   answer</p>' })
})

it('does not treat a stable thinking placeholder as the answer', async () => {
  // The placeholder outlives stablePolls before the reply replaces it.
  const driver: SiteDriverConfig = { ...DRIVER, pending: '问题分析中|思考中' }
  const { session: chat, page } = session(new ScriptedPage(), new FakeGate(), driver)
  page.answers = ['<div>问题分析中</div>', '<div>问题分析中</div>', '<div>问题分析中</div>', '<div>问题分析中</div>', '<p>答案正文</p>', '<p>答案正文</p>', '<p>答案正文</p>']
  await expect(chat.send(payload())).resolves.toMatchObject({ content: '<p>答案正文</p>' })
})

it('accepts an answer that only mentions the placeholder phrase', async () => {
  const driver: SiteDriverConfig = { ...DRIVER, pending: '思考中' }
  const { session: chat, page } = session(new ScriptedPage(), new FakeGate(), driver)
  page.answers = ['<p>为什么界面一直显示思考中？</p>', '<p>为什么界面一直显示思考中？</p>', '<p>为什么界面一直显示思考中？</p>']
  await expect(chat.send(payload())).resolves.toMatchObject({ content: '<p>为什么界面一直显示思考中？</p>' })
})

it('streams markup prefix deltas as the answer grows', async () => {
  const { session: chat, page } = session()
  // Each poll appends one block, so every read extends the last as a prefix.
  page.answers = [
    '<p>a</p>',
    '<p>a</p><p>b</p>',
    '<p>a</p><p>b</p><p>c</p>',
    '<p>a</p><p>b</p><p>c</p>',
    '<p>a</p><p>b</p><p>c</p>',
  ]
  const deltas: string[] = []
  for await (const delta of chat.stream?.(payload()) ?? []) deltas.push(delta)
  // Deltas carry markup so emphasis and blocks survive the stream too.
  expect(deltas).toEqual(['<p>a</p>', '<p>b</p>', '<p>c</p>'])
})

it('yields the full markup when the site replaces the answer', async () => {
  const { session: chat, page } = session()
  page.answers = ['<p>a</p>', '<p>b</p>', '<p>b</p>', '<p>b</p>']
  const deltas: string[] = []
  for await (const delta of chat.stream?.(payload()) ?? []) deltas.push(delta)
  expect(deltas).toEqual(['<p>a</p>', '<p>b</p>'])
})

it('skips a replacement that matches what was already emitted', async () => {
  const { session: chat, page } = session()
  page.answers = ['<p>a</p>', '<p>a</p>', '<p>a</p>', '<p>a</p>']
  const deltas: string[] = []
  for await (const delta of chat.stream?.(payload()) ?? []) deltas.push(delta)
  expect(deltas).toEqual(['<p>a</p>'])
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
  page.answers = ['<p>answer</p>', '<p>answer</p>', '<p>answer</p>']
  page.urlValue = '::'
  await expect(chat.send(payload())).resolves.toMatchObject({ content: '<p>answer</p>' })
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
  page.answers = ['<p>answer</p>']
  await expect(chat.send(payload())).resolves.toMatchObject({ content: '<p>answer</p>' })
})

it('releases the page when the session closes', async () => {
  const { session: chat, gate } = session()
  await chat.close()
  expect(gate.released).toEqual(['deepseek-web'])
})

it('reads entities, scripts, and styling out of the answer text', async () => {
  const driver: SiteDriverConfig = { ...DRIVER, pending: '思考中' }
  const { session: chat, page } = session(new ScriptedPage(), new FakeGate(), driver)
  // A styled wrapper, an entity-bearing body, and a script the page injected.
  const answer = '<div class="md"><p>结论&nbsp;如下&hellip;</p><script>track()</script><style>p{color:red}</style></div>'
  page.answers = [answer, answer, answer]
  // The markup comes back whole; the status check saw "结论 如下 …" and let it pass.
  await expect(chat.send(payload())).resolves.toMatchObject({ content: answer })
})

it('collapses an answer to one line for the completeness check', () => {
  expect(answerTextOf('<p>a   b</p><p>c</p>')).toBe('a b c')
})

it('keeps line structure and inner spacing for the protocol text', () => {
  // JSON carries meaning in its whitespace: an edit's old_string is copied whole.
  expect(answerMarkupText('<pre><code>    slow_ms = 200,       -- 慢<br>next</code></pre>'))
    .toBe('    slow_ms = 200,       -- 慢\nnext')
})

it('unescapes the tool-call delimiters a DOM serializes', () => {
  expect(answerMarkupText('<p>&lt;&lt;&lt;TOOL_CALL</p><p>{"a":1}</p><p>TOOL_CALL&gt;&gt;&gt;</p>'))
    .toBe('<<<TOOL_CALL\n{"a":1}\nTOOL_CALL>>>')
})
