/** Browser provider base class, shipped adapters, and their transport seam. */

import { describe, expect, it } from 'vitest'
import {
  ChatGptWebProvider,
  ChatHubError,
  DeepSeekWebProvider,
  DoubaoWebProvider,
  GeminiWebProvider,
  WebModelProvider,
  renderWebPrompt,
  splitRequestMessages,
  webProviderAdapters,
} from '@deepseek-ai/dsh-experimental-chathub'
import type {
  ChatRequest,
  ChatStreamChunk,
  WebChatPayload,
  WebChatRawResponse,
  WebChatTransport,
  WebChatTransportSession,
} from '@deepseek-ai/dsh-experimental-chathub'
import { semanticContext, userMessage } from './fixtures.ts'

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
      yield* deltas
    }
  }
  return session
}

/** Transport double that hands out queued sessions in order. */
class FakeTransport implements WebChatTransport {
  readonly opens: { providerId: string; sessionKey?: string }[] = []
  sessions: (WebChatTransportSession | undefined)[] = []

  async open(providerId: string, sessionKey?: string): Promise<WebChatTransportSession | undefined> {
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
  it('prefixes the provider heading when task context exists', () => {
    expect(renderWebPrompt('context', [userMessage('hello')], { heading: 'Task context' }))
      .toBe('Task context\ncontext\n\nConversation:\nuser: hello')
  })

  it('renders only the conversation when no context exists', () => {
    expect(renderWebPrompt('', [
      userMessage('hello'),
      { role: 'assistant', content: 'hi' },
    ], { heading: 'ignored' })).toBe('Conversation:\nuser: hello\nassistant: hi')
  })
})

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
    expect(payload.prompt).toBe('Task context\ntask context\n\nConversation:\nuser: fix the build error\nassistant: looking')
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
    expect(session.payloads[0]!.prompt).toBe('Conversation:\nuser: fix the build error')
  })

  it('wraps transport failures with the provider id', async () => {
    const transport = new FakeTransport()
    const session = fakeSession({ raw: new Error('tab closed') })
    transport.sessions.push(session)
    const provider = new DeepSeekWebProvider(transport)
    await provider.init()

    await expect(provider.sendMessage(chatRequest())).rejects.toMatchObject({
      code: 'provider-call-failed',
      message: 'deepseek-web: tab closed',
    })
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
    expect(session.payloads[0]!.prompt).toContain('user: fix the build error')
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
    }).rejects.toMatchObject({ code: 'provider-call-failed', message: 'deepseek-web: network reset' })
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
    }).rejects.toMatchObject({ code: 'provider-call-failed', message: 'chatgpt-web: prompt rejected' })
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
