/** Browser provider base class, shipped adapters, and their transport seam. */

import { describe, expect, it } from 'vitest'
import {
  ChatGptWebProvider,
  ChatHubError,
  DeepSeekWebProvider,
  DoubaoWebProvider,
  GeminiWebProvider,
  ModelRouter,
  ProviderRegistry,
  WebModelProvider,
  renderWebPrompt,
  splitRequestMessages,
  webProviderAdapters,
} from '@deepseek-ai/dsh-experimental-chathub'
import type {
  ChatRequest,
  ChatStreamChunk,
  ProviderErrorCode,
  WebChatPayload,
  WebChatRawResponse,
  WebChatTransport,
  WebChatTransportClosed,
  WebChatTransportSession,
} from '@deepseek-ai/dsh-experimental-chathub'
import { semanticContext, sessionRecord, userMessage } from './fixtures.ts'

/** Recorded browser session state used by the fakes. */
interface FakeSession extends WebChatTransportSession {
  readonly payloads: WebChatPayload[]
  closes: number
}

/** Behavior one fake browser session applies to its calls. */
interface SessionBehavior {
  /** Raw answer from `send`, or an error it rejects with. */
  raw?: WebChatRawResponse | Error
  /** Deltas from `stream`; absent means the session offers no streaming. */
  deltas?: string[] | Error
  /** Deltas yielded before the stream rejects, when the site drops mid-answer. */
  interruptAfter?: number
}

/**
 * Build one fake browser session.
 * @param behavior - Answer and streaming behavior.
 * @returns The session plus its recorded payloads and close count.
 */
function fakeSession(behavior: SessionBehavior = {}): FakeSession {
  const raw = behavior.raw ?? { content: 'site answer' }
  const session: FakeSession = {
    payloads: [],
    closes: 0,
    async send(payload: WebChatPayload): Promise<WebChatRawResponse> {
      session.payloads.push(payload)
      if (raw instanceof Error) throw raw
      return raw
    },
    async close(): Promise<void> {
      session.closes += 1
    },
  }
  if (behavior.deltas !== undefined) {
    const deltas = behavior.deltas
    session.stream = async function* streamDeltas(payload: WebChatPayload): AsyncIterable<string> {
      session.payloads.push(payload)
      if (deltas instanceof Error) throw deltas
      for (const [index, delta] of deltas.entries()) {
        if (behavior.interruptAfter !== undefined && index >= behavior.interruptAfter) {
          throw new Error('stream interrupted')
        }
        yield delta
      }
    }
  }
  return session
}

/** Transport double that hands out queued sessions in order. */
class FakeTransport implements WebChatTransport {
  readonly opens: { providerId: string; sessionKey?: string }[] = []
  sessions: (WebChatTransportSession | WebChatTransportClosed | undefined)[] = []

  async open(providerId: string, sessionKey?: string): Promise<WebChatTransportSession | WebChatTransportClosed | undefined> {
    this.opens.push(sessionKey === undefined ? { providerId } : { providerId, sessionKey })
    return this.sessions.shift()
  }
}

/**
 * Build one provider turn.
 * @param overrides - Fields to override.
 * @returns A chat request.
 */
function chatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    sessionId: 'sess_20261031_001',
    providerId: 'deepseek-web',
    messages: [userMessage('fix the build error')],
    taskContext: semanticContext({ objective: 'fix the build error' }),
    ...overrides,
  }
}

describe('splitRequestMessages', () => {
  it('folds the system prompt and system messages into one text block', () => {
    const request = chatRequest({
      systemPrompt: '  you are an agent  ',
      messages: [
        { role: 'system', content: 'keep answers short' },
        { role: 'system', content: '   ' },
        userMessage('hello'),
      ],
    })

    const split = splitRequestMessages(request)
    expect(split.system).toBe('you are an agent\n\nkeep answers short')
    expect(split.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(split.messages).not.toBe(request.messages[2])
  })

  it('rejects tool messages', () => {
    const request = chatRequest({ messages: [{ role: 'tool', content: 'build.log', toolCallId: 'call_1' }] })
    expect(() => splitRequestMessages(request)).toThrow(
      expect.objectContaining({ code: 'unsupported-request' }),
    )
  })

  it('rejects a conversation with no user or assistant message', () => {
    const request = chatRequest({ messages: [{ role: 'system', content: 'only context' }] })
    expect(() => splitRequestMessages(request)).toThrow(
      expect.objectContaining({ code: 'unsupported-request' }),
    )
  })

  it('returns an empty system text when no system content arrives', () => {
    expect(splitRequestMessages(chatRequest()).system).toBe('')
  })
})

describe('renderWebPrompt', () => {
  it('sends the context heading and only the latest user message when task context exists', () => {
    expect(renderWebPrompt('context', [
      userMessage('earlier question'),
      { role: 'assistant', content: 'earlier answer' },
      userMessage('hello'),
    ], { heading: 'Task context' }))
      .toBe('Task context\ncontext\n\nAnswer the message below; treat the task context above as background, not as the question.\n\nhello')
  })

  it('renders only the latest user message when no context exists', () => {
    expect(renderWebPrompt('', [
      userMessage('hello'),
      { role: 'assistant', content: 'hi' },
      userMessage('next question'),
    ], { heading: 'ignored' })).toBe('next question')
  })

  it('falls back to the last message when no user message exists', () => {
    expect(renderWebPrompt('', [{ role: 'assistant', content: 'only reply' }], { heading: 'ignored' }))
      .toBe('only reply')
  })

  it('rejects an empty message list', () => {
    expect(() => renderWebPrompt('', [], { heading: 'ignored' })).toThrow(
      expect.objectContaining({ code: 'unsupported-request' }),
    )
  })
})

/** Every provider id with a shipped browser adapter. */
const SHIPPED_PROVIDER_IDS = ['deepseek-web', 'chatgpt-web', 'gemini-web', 'doubao-web'] as const

describe('shipped adapters', () => {
  it('declare their identity, capabilities, and site names', () => {
    const transport = new FakeTransport()
    const deepseek = new DeepSeekWebProvider(transport)
    const chatgpt = new ChatGptWebProvider(transport)
    const gemini = new GeminiWebProvider(transport)
    const doubao = new DoubaoWebProvider(transport)

    expect(deepseek.id).toBe('deepseek-web')
    expect(deepseek.name).toBe('DeepSeek Chat')
    expect(deepseek.kind).toBe('web')
    expect(deepseek.capabilities).toEqual({
      reasoning: true,
      coding: true,
      vision: false,
      webAccess: true,
      streaming: true,
    })
    expect(chatgpt.id).toBe('chatgpt-web')
    expect(chatgpt.name).toBe('ChatGPT')
    expect(chatgpt.kind).toBe('web')
    expect(chatgpt.capabilities).toEqual(deepseek.capabilities)
    expect(gemini.id).toBe('gemini-web')
    expect(gemini.name).toBe('Gemini')
    expect(gemini.kind).toBe('web')
    expect(gemini.capabilities).toEqual(deepseek.capabilities)
    expect(doubao.id).toBe('doubao-web')
    expect(doubao.name).toBe('Doubao')
    expect(doubao.kind).toBe('web')
    expect(doubao.capabilities).toEqual(deepseek.capabilities)
  })

  it('builds every shipped adapter from its provider id', () => {
    const transport = new FakeTransport()
    expect(webProviderAdapters['deepseek-web']({ transport }).id).toBe('deepseek-web')
    expect(webProviderAdapters['chatgpt-web']({ transport }).id).toBe('chatgpt-web')
    expect(webProviderAdapters['gemini-web']({ transport }).id).toBe('gemini-web')
    expect(webProviderAdapters['doubao-web']({ transport }).id).toBe('doubao-web')
  })

  it('honors one minimal contract across every shipped adapter', async () => {
    for (const providerId of SHIPPED_PROVIDER_IDS) {
      const transport = new FakeTransport()
      const session = fakeSession({ raw: { content: 'answered' }, deltas: ['part ', 'two'] })
      transport.sessions.push(session)
      const provider = webProviderAdapters[providerId]({ transport })

      await provider.init()
      expect(transport.opens).toEqual([{ providerId }])
      expect(await provider.isReady()).toBe(true)

      const response = await provider.sendMessage(chatRequest({ providerId }))
      expect(response).toMatchObject({ providerId, sessionId: 'sess_20261031_001', content: 'answered' })

      const chunks: ChatStreamChunk[] = []
      for await (const chunk of provider.streamMessage(chatRequest({ providerId }))) chunks.push(chunk)
      expect(chunks).toEqual([
        { index: 0, delta: 'part ' },
        { index: 0, delta: 'two' },
        { index: 0, finishReason: 'stop' },
      ])

      await provider.close()
      expect(session.closes).toBe(1)
      expect(await provider.isReady()).toBe(false)
      await expect(provider.sendMessage(chatRequest({ providerId }))).rejects.toMatchObject({
        code: 'provider-not-ready',
      })
    }
  })

  it('applies the same host overrides to every shipped adapter', async () => {
    for (const providerId of SHIPPED_PROVIDER_IDS) {
      const transport = new FakeTransport()
      const session = fakeSession()
      transport.sessions.push(session)
      const provider = webProviderAdapters[providerId]({
        transport,
        capabilities: { vision: true, webAccess: false },
        promptStyle: { heading: 'Shared context' },
        failureRules: [{ code: 'rate-limited', pattern: /custom throttle/ }],
      })

      expect(provider.capabilities).toEqual({
        reasoning: true,
        coding: true,
        vision: true,
        webAccess: false,
        streaming: true,
      })
      expect(provider.normalizeError?.(new Error('custom throttle'))).toBe('rate-limited')

      await provider.init()
      await provider.sendMessage(chatRequest({ providerId, systemPrompt: 'task state' }))
      expect(session.payloads[0]!.prompt).toBe('Shared context\ntask state\n\nAnswer the message below; treat the task context above as background, not as the question.\n\nfix the build error')
    }
  })

  it('maps site-specific failure messages to stable codes', () => {
    const transport = new FakeTransport()
    const cases: { provider: WebModelProvider; message: string; code: ProviderErrorCode }[] = [
      { provider: new DeepSeekWebProvider(transport), message: '服务器繁忙', code: 'provider-unavailable' },
      { provider: new ChatGptWebProvider(transport), message: 'verify you are human', code: 'auth-required' },
      { provider: new GeminiWebProvider(transport), message: 'resource exhausted', code: 'rate-limited' },
      { provider: new DoubaoWebProvider(transport), message: '账号异常', code: 'auth-required' },
    ]
    for (const item of cases) {
      expect(item.provider.normalizeError(new Error(item.message))).toBe(item.code)
    }
  })

  it('reports a signed-out site as not ready on every adapter', async () => {
    for (const providerId of SHIPPED_PROVIDER_IDS) {
      const transport = new FakeTransport()
      const provider = webProviderAdapters[providerId]({ transport })

      await provider.init()
      expect(await provider.isReady()).toBe(false)
      await expect(provider.sendMessage(chatRequest({ providerId }))).rejects.toMatchObject({
        code: 'provider-not-ready',
      })
      await provider.close()
    }
  })
})

describe('WebModelProvider lifecycle', () => {
  it('opens a session on init and closes it once', async () => {
    const transport = new FakeTransport()
    const session = fakeSession()
    transport.sessions.push(session)
    const provider: WebModelProvider = new DeepSeekWebProvider(transport)

    expect(await provider.isReady()).toBe(false)
    await provider.init()
    expect(transport.opens).toEqual([{ providerId: 'deepseek-web' }])
    expect(await provider.isReady()).toBe(true)

    await provider.close()
    expect(session.closes).toBe(1)
    expect(await provider.isReady()).toBe(false)
    await provider.close()
    expect(session.closes).toBe(1)
  })

  it('stays unready when the user has not signed in', async () => {
    const transport = new FakeTransport()
    const provider = new DeepSeekWebProvider(transport)

    await provider.init()
    expect(await provider.isReady()).toBe(false)
    await expect(provider.sendMessage(chatRequest())).rejects.toMatchObject({ code: 'provider-not-ready' })
    await provider.close()
  })

  it('reports not-started before init and ready after a signed-in open', async () => {
    const transport = new FakeTransport()
    transport.sessions.push(fakeSession())
    const provider = new DeepSeekWebProvider(transport)

    expect(await provider.healthStatus()).toBe('not-started')
    await provider.init()
    expect(await provider.healthStatus()).toBe('ready')
  })

  it('reports needs-auth when the transport returns no session', async () => {
    const transport = new FakeTransport()
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()
    expect(await provider.healthStatus()).toBe('needs-auth')
  })

  it('reports expired when the transport reports an expired session', async () => {
    const transport = new FakeTransport()
    transport.sessions.push({ closed: true, reason: 'expired' })
    const provider = new DeepSeekWebProvider(transport)

    await provider.init()
    expect(await provider.isReady()).toBe(false)
    expect(await provider.healthStatus()).toBe('expired')
    await expect(provider.sendMessage(chatRequest())).rejects.toMatchObject({ code: 'provider-not-ready' })
  })

  it('returns to not-started after close', async () => {
    const transport = new FakeTransport()
    transport.sessions.push(fakeSession())
    const provider = new DeepSeekWebProvider(transport)

    await provider.init()
    await provider.close()
    expect(await provider.healthStatus()).toBe('not-started')
  })

  it('reopens the site session after the user signs in again', async () => {
    const transport = new FakeTransport()
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()
    expect(await provider.healthStatus()).toBe('needs-auth')

    transport.sessions.push(fakeSession())
    await provider.reauthenticate()

    expect(transport.opens).toEqual([{ providerId: 'deepseek-web' }, { providerId: 'deepseek-web' }])
    expect(await provider.healthStatus()).toBe('ready')
    await provider.close()
  })

  it('reopens the site conversation on switchSession', async () => {
    const transport = new FakeTransport()
    const first = fakeSession()
    transport.sessions.push(first)
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()

    await provider.switchSession('conv_2')
    expect(transport.opens).toEqual([{ providerId: 'deepseek-web' }, { providerId: 'deepseek-web', sessionKey: 'conv_2' }])
    expect(first.closes).toBe(1)
    expect(await provider.isReady()).toBe(false)
    await provider.close()
  })
})

describe('WebModelProvider sendMessage', () => {
  it('normalizes the payload and the answered response', async () => {
    const transport = new FakeTransport()
    const session = fakeSession({ raw: { content: 'root cause found', usage: { totalTokens: 12 }, finishReason: 'length', metadata: { tab: 3 } } })
    transport.sessions.push(session)
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()

    const response = await provider.sendMessage(chatRequest({
      systemPrompt: 'task context',
      messages: [userMessage('fix the build error'), { role: 'assistant', content: 'looking' }],
    }))

    expect(response).toEqual({
      providerId: 'deepseek-web',
      sessionId: 'sess_20261031_001',
      content: 'root cause found',
      usage: { totalTokens: 12 },
      finishReason: 'length',
      metadata: { tab: 3 },
    })
    const payload = session.payloads[0]!
    expect(payload.providerId).toBe('deepseek-web')
    expect(payload.system).toBe('task context')
    expect(payload.meta).toEqual({ origin: 'semantic-context' })
    expect(payload.prompt).toBe('Task context\ntask context\n\nAnswer the message below; treat the task context above as background, not as the question.\n\nfix the build error')
  })

  it('defaults the finish reason and omits absent usage and metadata', async () => {
    const transport = new FakeTransport()
    const session = fakeSession()
    transport.sessions.push(session)
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()

    const response = await provider.sendMessage(chatRequest())
    expect(response.finishReason).toBe('stop')
    expect(response.usage).toBeUndefined()
    expect(response.metadata).toBeUndefined()
    expect(session.payloads[0]!.meta).toEqual({ origin: 'raw-messages' })
    expect(session.payloads[0]!.prompt).toBe('fix the build error')
  })

  it('sends the task context only on the first turn of a site conversation', async () => {
    const transport = new FakeTransport()
    const session = fakeSession()
    transport.sessions.push(session)
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()

    await provider.sendMessage(chatRequest({
      systemPrompt: 'task state',
      messages: [userMessage('first question')],
    }))
    await provider.sendMessage(chatRequest({
      systemPrompt: 'task state',
      messages: [userMessage('second question')],
    }))

    expect(session.payloads[0]!.prompt).toBe(
      'Task context\ntask state\n\nAnswer the message below; treat the task context above as background, not as the question.\n\nfirst question',
    )
    expect(session.payloads[1]!.prompt).toBe('second question')
    expect(session.payloads[1]!.meta).toEqual({ origin: 'raw-messages' })
  })

  it('re-sends the task context after the site conversation reopens', async () => {
    const transport = new FakeTransport()
    const session = fakeSession()
    transport.sessions.push(session, session)
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()
    await provider.sendMessage(chatRequest({ systemPrompt: 'task state' }))

    await provider.close()
    await provider.init()
    await provider.sendMessage(chatRequest({ systemPrompt: 'task state' }))

    expect(session.payloads[1]!.prompt).toBe(
      'Task context\ntask state\n\nAnswer the message below; treat the task context above as background, not as the question.\n\nfix the build error',
    )
  })

  it('keeps the task context pending when a turn fails', async () => {
    const transport = new FakeTransport()
    const failing = fakeSession({ raw: new Error('tab closed') })
    const working = fakeSession()
    transport.sessions.push(failing, working)
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()

    await expect(provider.sendMessage(chatRequest({ systemPrompt: 'task state' })))
      .rejects.toMatchObject({ code: 'provider-call-failed' })
    await provider.init()
    await provider.sendMessage(chatRequest({ systemPrompt: 'task state' }))

    expect(working.payloads[0]!.prompt).toBe(
      'Task context\ntask state\n\nAnswer the message below; treat the task context above as background, not as the question.\n\nfix the build error',
    )
  })

  it('wraps transport failures with the provider id', async () => {
    const transport = new FakeTransport()
    const session = fakeSession({ raw: new Error('tab closed') })
    transport.sessions.push(session)
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()

    const failure = await provider.sendMessage(chatRequest()).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: 'provider-call-failed',
      message: 'deepseek-web: unknown',
    })
    expect((failure as ChatHubError).cause).toEqual(new Error('tab closed'))
  })

  it('rethrows an already typed provider failure unchanged', async () => {
    const transport = new FakeTransport()
    const failure = new ChatHubError('unsupported-request', 'site rejected the prompt')
    const session = fakeSession({ raw: failure })
    transport.sessions.push(session)
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()

    await expect(provider.sendMessage(chatRequest())).rejects.toBe(failure)
  })
})

describe('WebModelProvider streamMessage', () => {
  it('streams session deltas and ends with the finish reason', async () => {
    const transport = new FakeTransport()
    const session = fakeSession({ deltas: ['root ', 'cause'] })
    transport.sessions.push(session)
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()

    const chunks: ChatStreamChunk[] = []
    for await (const chunk of provider.streamMessage(chatRequest())) chunks.push(chunk)
    expect(chunks).toEqual([
      { index: 0, delta: 'root ' },
      { index: 0, delta: 'cause' },
      { index: 0, finishReason: 'stop' },
    ])
    expect(session.payloads[0]!.prompt).toContain('fix the build error')
  })

  it('invokes session.stream with its receiver bound so methods that use this work', async () => {
    const transport = new FakeTransport()
    const deltas = ['alpha', 'beta']
    const session = {
      seen: [] as string[],
      async send(): Promise<WebChatRawResponse> {
        return { content: '' }
      },
      async close(): Promise<void> {},
    }
    Object.defineProperty(session, 'stream', {
      value: async function* streamWithThis(this: typeof session, payload: WebChatPayload): AsyncIterable<string> {
        this.seen.push(payload.prompt)
        for (const delta of deltas) yield delta
      },
    })
    transport.sessions.push(session)
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()

    const chunks: ChatStreamChunk[] = []
    for await (const chunk of provider.streamMessage(chatRequest())) chunks.push(chunk)
    expect(chunks).toEqual([
      { index: 0, delta: 'alpha' },
      { index: 0, delta: 'beta' },
      { index: 0, finishReason: 'stop' },
    ])
    expect(session.seen).toHaveLength(1)
  })

  it('wraps streaming failures', async () => {
    const transport = new FakeTransport()
    const session = fakeSession({ deltas: new Error('network reset') })
    transport.sessions.push(session)
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()

    await expect(async () => {
      for await (const _chunk of provider.streamMessage(chatRequest())) {
        throw new Error('no chunk expected')
      }
    }).rejects.toMatchObject({ code: 'network-error', message: 'deepseek-web: network-error' })
  })

  it('keeps the deltas already shown when the site interrupts the stream', async () => {
    const transport = new FakeTransport()
    const session = fakeSession({ deltas: ['root ', 'cause'], interruptAfter: 1 })
    transport.sessions.push(session)
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()

    const chunks: ChatStreamChunk[] = []
    await expect(async () => {
      for await (const chunk of provider.streamMessage(chatRequest())) chunks.push(chunk)
    }).rejects.toMatchObject({ code: 'stream-interrupted', message: 'deepseek-web: stream-interrupted' })
    expect(chunks).toEqual([{ index: 0, delta: 'root ' }])
  })

  it('falls back to one content chunk without a delta stream', async () => {
    const transport = new FakeTransport()
    const session = fakeSession({ raw: { content: 'whole answer', usage: { totalTokens: 4 }, finishReason: 'length' } })
    transport.sessions.push(session)
    const provider = new ChatGptWebProvider(transport)
    await provider.init()

    const chunks: ChatStreamChunk[] = []
    for await (const chunk of provider.streamMessage(chatRequest())) chunks.push(chunk)
    expect(chunks).toEqual([
      { index: 0, content: 'whole answer', finishReason: 'length', metadata: { usage: { totalTokens: 4 } } },
    ])
  })

  it('omits usage metadata when the site reports none', async () => {
    const transport = new FakeTransport()
    const session = fakeSession()
    transport.sessions.push(session)
    const provider = new ChatGptWebProvider(transport)
    await provider.init()

    const chunks: ChatStreamChunk[] = []
    for await (const chunk of provider.streamMessage(chatRequest())) chunks.push(chunk)
    expect(chunks).toEqual([{ index: 0, content: 'site answer', finishReason: 'stop', metadata: {} }])
  })

  it('wraps a non-streaming send failure', async () => {
    const transport = new FakeTransport()
    const session = fakeSession({ raw: new Error('prompt rejected') })
    transport.sessions.push(session)
    const provider = new ChatGptWebProvider(transport)
    await provider.init()

    await expect(async () => {
      for await (const _chunk of provider.streamMessage(chatRequest())) {
        throw new Error('no chunk expected')
      }
    }).rejects.toMatchObject({ code: 'provider-call-failed', message: 'chatgpt-web: unknown' })
  })

  it('requires an open session before streaming', async () => {
    const transport = new FakeTransport()
    const provider = new ChatGptWebProvider(transport)

    await expect(async () => {
      for await (const _chunk of provider.streamMessage(chatRequest())) {
        throw new Error('no chunk expected')
      }
    }).rejects.toMatchObject({ code: 'provider-not-ready' })
  })
})

describe('WebModelProvider.normalizeError', () => {
  const provider = new DeepSeekWebProvider(new FakeTransport())

  it('classifies auth and login failures', () => {
    expect(provider.normalizeError(new Error('session expired'))).toBe('auth-required')
    expect(provider.normalizeError(new Error('user signed out'))).toBe('auth-required')
    expect(provider.normalizeError(new Error('unauthorized'))).toBe('auth-required')
  })

  it('classifies rate-limiting failures', () => {
    expect(provider.normalizeError(new Error('rate limit exceeded'))).toBe('rate-limited')
    expect(provider.normalizeError(new Error('too many requests 429'))).toBe('rate-limited')
  })

  it('classifies network failures', () => {
    expect(provider.normalizeError(new Error('network timeout'))).toBe('network-error')
    expect(provider.normalizeError(new Error('fetch failed'))).toBe('network-error')
  })

  it('classifies stream interruptions', () => {
    expect(provider.normalizeError(new Error('stream interrupted'))).toBe('stream-interrupted')
    expect(provider.normalizeError(new Error('connection reset by peer'))).toBe('stream-interrupted')
  })

  it('classifies unsupported capability failures', () => {
    expect(provider.normalizeError(new Error('vision not supported'))).toBe('unsupported-capability')
  })

  it('classifies provider availability failures', () => {
    expect(provider.normalizeError(new Error('service unavailable 503'))).toBe('provider-unavailable')
    expect(provider.normalizeError(new Error('overloaded'))).toBe('provider-unavailable')
  })

  it('falls back to unknown for unrecognized errors', () => {
    expect(provider.normalizeError(new Error('something broke'))).toBe('unknown')
  })

  it('maps normalized codes to runtime error codes on send', async () => {
    const transport = new FakeTransport()
    transport.sessions.push(fakeSession({ raw: new Error('rate limited') }))
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()

    await expect(provider.sendMessage(chatRequest())).rejects.toMatchObject({ code: 'rate-limited' })
  })

  it('maps auth failures to provider-not-ready on send', async () => {
    const transport = new FakeTransport()
    transport.sessions.push(fakeSession({ raw: new Error('session expired') }))
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()

    await expect(provider.sendMessage(chatRequest())).rejects.toMatchObject({ code: 'provider-not-ready' })
  })

  it('maps unsupported capability failures to unsupported-request on send', async () => {
    const transport = new FakeTransport()
    transport.sessions.push(fakeSession({ raw: new Error('vision not supported') }))
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()

    await expect(provider.sendMessage(chatRequest())).rejects.toMatchObject({ code: 'unsupported-request' })
  })

  it('maps site availability failures to provider-call-failed on send', async () => {
    const transport = new FakeTransport()
    transport.sessions.push(fakeSession({ raw: new Error('服务器繁忙') }))
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()

    await expect(provider.sendMessage(chatRequest())).rejects.toMatchObject({
      code: 'provider-call-failed',
      message: 'deepseek-web: provider-unavailable',
    })
  })

  it('maps network failures to network-error on send', async () => {
    const transport = new FakeTransport()
    transport.sessions.push(fakeSession({ raw: new Error('network timeout') }))
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()

    await expect(provider.sendMessage(chatRequest())).rejects.toMatchObject({
      code: 'network-error',
      message: 'deepseek-web: network-error',
    })
  })

  it('maps stream interruptions to stream-interrupted on send', async () => {
    const transport = new FakeTransport()
    transport.sessions.push(fakeSession({ raw: new Error('stream interrupted') }))
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()

    await expect(provider.sendMessage(chatRequest())).rejects.toMatchObject({
      code: 'stream-interrupted',
      message: 'deepseek-web: stream-interrupted',
    })
  })

  it('lets a subclass override normalizeError for site-specific patterns', async () => {
    const transport = new FakeTransport()
    transport.sessions.push(fakeSession({ raw: new Error('deepseek site is down') }))
    class CustomProvider extends DeepSeekWebProvider {
      override normalizeError(error: unknown): ProviderErrorCode {
        return /deepseek/.test(String(error)) ? 'provider-unavailable' : super.normalizeError(error)
      }
    }
    const provider = new CustomProvider(transport)
    await provider.init()

    await expect(provider.sendMessage(chatRequest())).rejects.toMatchObject({ code: 'provider-call-failed' })
  })
})

describe('registry auth flows with a shipped adapter', () => {
  it('renews an expired site session through re-login', async () => {
    const transport = new FakeTransport()
    transport.sessions.push({ closed: true, reason: 'expired' })
    const registry = new ProviderRegistry()
    const provider = new DeepSeekWebProvider(transport)
    registry.register(provider)
    await provider.init()

    expect(await registry.health('deepseek-web')).toEqual(expect.objectContaining({
      ready: false,
      status: 'expired',
    }))

    transport.sessions.push(fakeSession())
    expect(await registry.reauthenticate('deepseek-web')).toEqual(expect.objectContaining({
      providerId: 'deepseek-web',
      ready: true,
      status: 'ready',
    }))
    expect(transport.opens).toEqual([{ providerId: 'deepseek-web' }, { providerId: 'deepseek-web' }])
  })

  it('opens a session when a signed-out user logs in', async () => {
    const transport = new FakeTransport()
    const registry = new ProviderRegistry()
    const provider = new DeepSeekWebProvider(transport)
    registry.register(provider)
    await provider.init()

    expect(await registry.health('deepseek-web')).toEqual(expect.objectContaining({
      ready: false,
      status: 'needs-auth',
    }))

    transport.sessions.push(fakeSession())
    expect(await registry.reauthenticate('deepseek-web')).toEqual(expect.objectContaining({
      providerId: 'deepseek-web',
      ready: true,
      status: 'ready',
    }))
  })
})

describe('shipped multi-model routing', () => {
  it('routes every task type to a configured browser adapter', async () => {
    const transport: WebChatTransport = {
      async open(providerId: string): Promise<WebChatTransportSession> {
        return fakeSession({ raw: { content: `${providerId} answer` } })
      },
    }
    const registry = new ProviderRegistry()
    for (const create of Object.values(webProviderAdapters)) {
      const provider = create({ transport })
      await provider.init()
      registry.register(provider)
    }
    const router = new ModelRouter({
      registry,
      routing: {
        coding: 'deepseek-web',
        research: 'gemini-web',
      },
    })
    const session = sessionRecord({ currentProvider: 'doubao-web' })

    const coding = await router.route({ session, taskType: 'coding' })
    expect(coding.provider.id).toBe('deepseek-web')

    const research = await router.route({ session, taskType: 'research' })
    expect(research.provider.id).toBe('gemini-web')

    const current = await router.route({ session, taskType: 'quick-answer' })
    expect(current.provider.id).toBe('doubao-web')

    const completion = await router.complete({
      session,
      taskType: 'quick-answer',
      preferredProvider: 'chatgpt-web',
      messages: [userMessage('quick check')],
      taskContext: semanticContext(),
    })
    expect(completion.provider.id).toBe('chatgpt-web')
    expect(completion.response.content).toBe('chatgpt-web answer')
  })
})
