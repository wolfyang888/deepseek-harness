/** Session submission, completion polling, deltas, timeout, and page invalidation. */

import { expect, it } from 'vitest'
import { PlaywrightChatSession, answerMarkupText, answerMessageText, answerTextOf } from '../src/session.ts'
import type {
  FilePayloadLike,
  SiteDriverConfig,
  TransportConfig,
  TurnGate,
  TurnPage,
} from '../src/types.ts'
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

/** One attachment as the provider hands it over: base64 of multi-byte text. */
const ATTACHMENT = {
  name: '截图.png',
  mimeType: 'image/png',
  data: Buffer.from('图片字节').toString('base64'),
}

/** Turn page replaying a scripted answer sequence. */
class ScriptedPage implements TurnPage {
  closed = false
  urlValue = 'https://fake.test/chat'
  submitted: string[] = []
  /** Filenames each turn uploaded, so an attachment turn is observable. */
  readonly attached: string[] = []
  reads = 0
  /** Selectors each poll asked for, so a driver's body scope is observable. */
  readonly asked: { selector: string; body: string | undefined }[] = []
  submitError: unknown
  /** Whether submitting this turn closes the page, as a browser crash would. */
  closeOnSubmit = false
  /** Failure the page raises from `attach`, as a site with no upload input does. */
  attachError: unknown
  /** Turn steps in order, so the files can be proven to go up before the prompt. */
  readonly events: string[] = []
  /** Decoded bytes of each upload, so the base64 hop is observable. */
  readonly attachedBytes: string[] = []
  /** Answers returned by successive reads; the last answer repeats once exhausted. */
  answers: string[] = []
  /** Text the container already holds before the prompt is submitted. */
  before = ''

  /** Whether a reopened page reports a signed-in composer. */
  signedIn = true

  /**
   * @returns Whether the page reports a signed-in chat composer.
   */
  async waitForInput(): Promise<boolean> {
    return this.signedIn
  }

  /** @returns Resolves after marking the page closed. */
  async close(): Promise<void> {
    this.closed = true
  }

  /** @returns Resolves; the page double has no window to raise. */
  async bringToFront(): Promise<void> {}

  /** @returns Resolves after recording the destination as the current URL. */
  async goto(url: string): Promise<void> {
    this.urlValue = url
  }

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
    if (this.delayMs > 0) await new Promise<void>((resolve) => { setTimeout(resolve, this.delayMs) })
    this.asked.push({ selector, body })
    // Before submission the container is whatever the page already displayed.
    if (this.submitted.length === 0) return this.before
    const index = Math.min(this.reads, this.answers.length - 1)
    this.reads += 1
    return this.answers[index] ?? ''
  }

  /**
   * @returns The body markup the page reports; mirrors the last answer read,
   *   so a pending placeholder the answer selector keeps out is still visible.
   */
  async bodyMarkup(): Promise<string> {
    if (this.body.length > 0) return this.body
    if (this.submitted.length === 0) return this.before
    const index = Math.min(Math.max(this.reads - 1, 0), this.answers.length - 1)
    return this.answers[index] ?? ''
  }

  /** Whole-page markup to report; set to simulate a thinking card the answer selector excludes. */
  body = ''

  /** Artificial read latency for exercising the idle-deadline renewal. */
  delayMs = 0

  /** Visible reasoning text a scripted page reports after the reply settles. */
  reasoningValue = ''

  /** Expander selector the session handed to the page, when the driver declares one. */
  reasoningExpander: string | undefined

  /**
   * @param _selector - reasoning block selector.
   * @param expand - optional control the session asks the page to open first.
   * @returns The reasoning markup the site showed.
   */
  async reasoningHtml(_selector: string, expand?: string): Promise<string> {
    this.reasoningExpander = expand
    return this.reasoningValue
  }

  /**
   * @param _selector - signed-out wall selector.
   * @returns Always invisible; walls are exercised by the page-level specs.
   */
  async wallVisible(_selector: string): Promise<boolean> {
    return false
  }

  /**
   * @param _name - cookie name the driver declares.
   * @returns Whether the test marked the session cookie present.
   */
  async cookiePresent(_name: string): Promise<boolean> {
    return this.cookieNames.includes(_name)
  }

  /** Cookie names the scripted context reports; empty means signed out. */
  cookieNames: string[] = []

  /**
   * @param prompt - prompt the session submits.
   * @returns Resolves unless the test configured a failure.
   */
  async submit(prompt: string): Promise<void> {
    if (this.submitError !== undefined) throw this.submitError
    this.submitted.push(prompt)
    this.events.push('submit')
    if (this.closeOnSubmit) this.closed = true
  }

  /**
   * @param files - attachments this turn uploaded before its prompt.
   * @returns Resolves after recording their names.
   */
  async attach(files: readonly FilePayloadLike[]): Promise<void> {
    if (this.attachError !== undefined) throw this.attachError
    this.attached.push(...files.map(file => file.name))
    this.attachedBytes.push(...files.map(file => new TextDecoder().decode(file.buffer)))
    this.events.push(...files.map(file => `attach:${file.name}`))
  }
}

/** Gate double recording leases without serializing. */
class FakeGate implements TurnGate {
  acquireError: unknown
  acquired: { key: string; maxQueuedTurns: number }[] = []
  released: string[] = []
  leases = 0
  /** Page a reopened key receives; unset means the double has no page to offer. */
  reopenPage: ScriptedPage | undefined
  /** Keys whose page the session asked to reopen. */
  readonly reopened: string[] = []

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
   * @param key - page key whose page was closed by a context swap.
   * @returns The configured replacement page.
   */
  async acquire(key: string): Promise<ScriptedPage> {
    this.reopened.push(key)
    if (this.reopenPage === undefined) throw new Error(`no replacement page for ${key}`)
    return this.reopenPage
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

it('reopens the page a login context swap closed instead of failing the turn', async () => {
  const stale = new ScriptedPage()
  stale.closed = true
  const fresh = new ScriptedPage()
  fresh.answers = ['<p>ok</p>', '<p>ok</p>']
  const gate = new FakeGate()
  gate.reopenPage = fresh
  const chat = new PlaywrightChatSession('glm-web', stale, DRIVER, CONFIG, gate)
  const answer = await chat.send(payload())
  expect(answer).toEqual({ content: '<p>ok</p>', finishReason: 'stop' })
  expect(gate.reopened).toEqual(['glm-web'])
  expect(fresh.submitted).toEqual(['hello'])
})

it('reports a signed-out site when the reopened page has no session', async () => {
  const stale = new ScriptedPage()
  stale.closed = true
  const fresh = new ScriptedPage()
  fresh.signedIn = false
  const gate = new FakeGate()
  gate.reopenPage = fresh
  const chat = new PlaywrightChatSession('glm-web', stale, DRIVER, CONFIG, gate)
  await expect(chat.send(payload())).rejects.toMatchObject({ token: 'chathub-signed-out' })
})

it('collects the site thinking blocks without mixing them into the answer', async () => {
  const page = new ScriptedPage()
  page.reasoningValue = 'first thought.\n\nsecond thought.'
  page.answers = ['<p>reply</p>', '<p>reply</p>', '<p>reply</p>']
  const reasoningDriver: SiteDriverConfig = { ...DRIVER, reasoning: '.thinking', reasoningExpand: '.steps' }
  const { session: chat } = session(page, new FakeGate(), reasoningDriver)
  const answer = await chat.send(payload())
  expect(answer.content).toBe('<p>reply</p>')
  expect(chat.lastReasoning()).toBe('first thought.\n\nsecond thought.')
  expect(answer.metadata).toEqual({ reasoning: 'first thought.\n\nsecond thought.' })
  // The driver's expander travels with the read so collapsed work steps open.
  expect(page.reasoningExpander).toBe('.steps')
})

it('keeps a long streaming answer alive instead of cutting it off at the idle deadline', async () => {
  const page = new ScriptedPage()
  // 12 growing reads at 30 ms each outlast the 200 ms turn budget; every
  // changed poll renews it, so the site is allowed to finish writing.
  page.delayMs = 30
  page.answers = Array.from({ length: 12 }, (_unused, index) => `<p>${'x'.repeat(index + 1)}</p>`)
  const { session: chat } = session(page)
  const answer = await chat.send(payload())
  expect(answer.content).toBe('<p>xxxxxxxxxxxx</p>')
})

it('watches one prompt and yields the growing container as replacing snapshots', async () => {
  const { session: chat, page, gate } = session()
  page.answers = ['<p>a</p>', '<p>ab</p>', '<p>ab</p>', '<p>ab</p>']
  const snapshots: string[] = []
  for await (const snapshot of chat.watch(payload())) snapshots.push(snapshot)
  // The last snapshot is the stabilized answer send would have returned; the
  // unchanging polls after it yield nothing.
  expect(snapshots).toEqual(['<p>a</p>', '<p>ab</p>'])
  expect(page.submitted).toEqual(['hello'])
  expect(gate.acquired).toHaveLength(1)
})

it('yields the whole container again when a mid-answer rewrite shrinks it', async () => {
  const { session: chat, page } = session()
  page.answers = ['<p>long enough</p>', '<p>short</p>', '<p>short</p>', '<p>short</p>']
  const snapshots: string[] = []
  for await (const snapshot of chat.watch(payload())) snapshots.push(snapshot)
  // Snapshots replace, so a rewrite is the new container in full, never a
  // negative delta or a mix of old and new markup.
  expect(snapshots).toEqual(['<p>long enough</p>', '<p>short</p>'])
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

it('waits while the answer reads unchanged but the page shows pending', async () => {
  // GLM excludes its thinking card from the answer selector, so while it
  // thinks the last non-thinking answer reads unchanged (current === baseline)
  // though the page body still shows 思考中. The turn must outlast that wait
  // instead of timing out on the stale answer.
  const driver: SiteDriverConfig = { ...DRIVER, pending: '思考中' }
  const { session: chat, page } = session(new ScriptedPage(), new FakeGate(), driver)
  page.before = '<p>old answer</p>'
  page.body = '<div>思考中</div>'
  page.answers = [
    '<p>old answer</p>', '<p>old answer</p>', '<p>old answer</p>',
    '<p>real answer</p>', '<p>real answer</p>', '<p>real answer</p>',
  ]
  await expect(chat.send(payload())).resolves.toMatchObject({ content: '<p>real answer</p>' })
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
  page.closeOnSubmit = true
  // A closed page is a browser lifecycle failure, not a sign-out: the token
  // keeps the provider off `needs-auth` and lets the route fail over.
  await expect(chat.send(payload())).rejects.toMatchObject({ token: 'chathub-browser-unavailable' })
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

it('fails a cookie-gated site whose session cookie disappears mid-turn', async () => {
  // Doubao expires by dropping `sessionid` with no wall element to name.
  const gated: SiteDriverConfig = { ...DRIVER, loginCookie: 'sessionid' }
  const page = new ScriptedPage()
  page.cookieNames = ['sessionid']
  page.answers = ['answer']
  const chat = new PlaywrightChatSession('doubao-web', page, gated, CONFIG, new FakeGate())
  page.cookieNames = []
  await expect(chat.send(payload())).rejects.toMatchObject({ token: 'chathub-signed-out' })
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

it('restores the blocks a reply was written in', () => {
  // A real answer (doubao.com) arrived as one paragraph in the transcript:
  // the site had rendered the Markdown, and the protocol conversion collapsed
  // the blank lines that carry its headings, bullets, and code.
  const html = [
    '<h2>Main problems</h2>',
    '<p>Two dispatchers exist.</p>',
    '<ul><li>execute_hook cannot chain</li><li>load order is undefined</li></ul>',
    '<pre><code class="language-lua">local a = 1\n  local b = 2</code></pre>',
    '<p>Do you want me to refactor it?</p>',
  ].join('')
  expect(answerMessageText(html)).toBe([
    '## Main problems',
    '',
    'Two dispatchers exist.',
    '',
    '- execute_hook cannot chain',
    '- load order is undefined',
    '',
    '```lua',
    'local a = 1',
    '  local b = 2',
    '```',
    '',
    'Do you want me to refactor it?',
  ].join('\n'))
})

it('reads a call block out of the message text the site rendered', () => {
  // The message conversion feeds the protocol parser too, so its escaping has
  // to leave the delimiters and the JSON body untouched.
  expect(answerMessageText('<p>&lt;&lt;&lt;TOOL_CALL</p><p>{"name":"read","arguments":{"file_path":"a.ts"}}</p><p>TOOL_CALL&gt;&gt;&gt;</p>'))
    .toBe('<<<TOOL_CALL\n\n{"name":"read","arguments":{"file_path":"a.ts"}}\n\nTOOL_CALL>>>')
})

it('uploads the turn attachments before the prompt is submitted', async () => {
  const { session: chat, page } = session()
  page.answers = ['<p>ok</p>', '<p>ok</p>', '<p>ok</p>']
  await chat.send({ ...payload(), attachments: [ATTACHMENT] })
  expect(page.attached).toEqual(['截图.png'])
  // Order is the contract: a prompt typed first is a turn sent without files.
  expect(page.events).toEqual(['attach:截图.png', 'submit'])
  // The transport decodes the base64 once, so the site gets bytes, not text.
  expect(page.attachedBytes).toEqual(['图片字节'])
})

it('skips the upload for a turn that carries no attachments', async () => {
  const { session: chat, page } = session()
  page.answers = ['<p>ok</p>', '<p>ok</p>', '<p>ok</p>']
  await chat.send(payload())
  expect(page.events).toEqual(['submit'])
})

it('uploads the attachments of a watched turn too', async () => {
  // watch is a separate submission path; it must not skip the upload.
  const { session: chat, page } = session()
  page.answers = ['<p>a</p>', '<p>a</p>', '<p>a</p>']
  const seen: string[] = []
  for await (const snapshot of chat.watch({ ...payload(), attachments: [ATTACHMENT] })) seen.push(snapshot)
  expect(seen).toEqual(['<p>a</p>'])
  expect(page.attached).toEqual(['截图.png'])
})

it('fails the turn when the site refuses its attachments', async () => {
  const { session: chat, page } = session()
  page.attachError = Object.assign(new Error('no upload input'), { token: 'chathub-attachment-unsupported' })
  page.answers = ['<p>ok</p>']
  await expect(chat.send({ ...payload(), attachments: [ATTACHMENT] }))
    .rejects.toMatchObject({ token: 'chathub-attachment-unsupported' })
  // A refused attachment does not half-send: the prompt never leaves.
  expect(page.submitted).toEqual([])
})
