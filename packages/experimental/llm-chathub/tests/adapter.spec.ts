/** Adapter: one loop step per site turn, with the repair and failure policy. */

import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { ChatHubLlmAdapter } from '../src/adapter.ts'
import { TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from '../src/protocol.ts'
import type {
  ChatHubLlmConfig,
  ChatHubTransport,
  ChatHubTransportSession,
  ChatHubTransportSource,
  ChatHubTurnObservation,
} from '../src/types.ts'

/** One scripted page: records what it was asked and what it answered. */
class FakeSession implements ChatHubTransportSession {
  closed = false

  /**
   * @param source - transport that scripted this page.
   * @param key - page key the transport opened it under.
   */
  constructor(
    private readonly source: FakeSource,
    readonly key: string,
  ) {}

  /**
   * @param payload - the prompt the adapter rendered.
   * @returns The scripted answer.
   */
  async send(payload: { prompt: string }): Promise<{ content: string }> {
    this.source.prompts.push(payload.prompt)
    const failure = this.source.sendError
    if (failure !== undefined) throw failure
    this.source.onSend?.()
    // A site serializes its answer DOM: markup-carrying content escapes `<`,
    // `>`, and `&` into entities, which is the shape the transport really
    // delivers and the adapter's text conversion unescapes.
    const answer = (this.source.answers.shift() ?? '')
      .replace(/&/gu, '&amp;')
      .replace(/</gu, '&lt;')
      .replace(/>/gu, '&gt;')
    return { content: answer }
  }

  /** @returns Resolves once the page is released. */
  async close(): Promise<void> {
    this.closed = true
    this.source.released.push(this.key)
  }
}

/** Scripted transport: health row, answer queue, and open behaviour. */
class FakeSource implements ChatHubTransportSource {
  health = 'ready'
  answers: string[] = []
  openMode: 'session' | 'pending' | 'closed' = 'session'
  sendError: unknown
  onSend: (() => void) | undefined
  readonly prompts: string[] = []
  readonly keys: string[] = []
  readonly released: string[] = []
  readonly sites: string[] = []

  /** @returns One health row per health-known site. */
  providers(): Promise<readonly { id: string; health: { status: string } }[]> {
    return Promise.resolve([
      { id: 'deepseek-web', health: { status: this.health } },
      { id: 'qianwen-web', health: { status: this.health } },
    ])
  }

  /** @returns The transport the adapter drives. */
  transportForAdapter(): ChatHubTransport {
    return {
      open: async (providerId: string, key?: string) => {
        this.sites.push(providerId)
        this.keys.push(key ?? '')
        if (this.openMode === 'pending') return undefined
        if (this.openMode === 'closed') return { closed: true, reason: 'not-signed-in' } as const
        return new FakeSession(this, key ?? '')
      },
    }
  }
}

const BASE: ChatHubLlmConfig = {
  site: 'deepseek-web',
  sites: ['deepseek-web'],
  route: 'deepseek-web-chathub',
  routes: ['deepseek-web-chathub'],
  model: 'web-model',
  contextWindow: 32_000,
  maxPromptChars: 48_000,
  maxToolResultChars: 6_000,
  maxSystemChars: 4_000,
  historyTurns: 8,
  allowTools: ['read', 'edit'],
  denyPaths: ['.git'],
  verifyCommands: ['pnpm test'],
  workspaceRoot: '/work/repo',
  maxToolCallsPerTurn: 1,
  repairAttempts: 1,
}

/**
 * @param source - scripted transport.
 * @param overrides - configuration changes for one case.
 * @returns An adapter over the fake.
 */
function adapter(source: FakeSource, overrides: Partial<ChatHubLlmConfig> = {}): ChatHubLlmAdapter {
  return new ChatHubLlmAdapter(source, { ...BASE, ...overrides })
}

/**
 * @param content - the final user message.
 * @returns A minimal loop request.
 */
function request(content = 'fix the build'): GenerateOptions {
  return {
    provider: 'deepseek-web-chathub',
    model: 'web-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: content }] }],
  }
}

/**
 * @param stream - chunk stream from one call.
 * @returns Every chunk, in order.
 */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/**
 * @param body - block body.
 * @returns A reply carrying one call block.
 */
function call(body: string): string {
  return `let me look.\n${TOOL_CALL_OPEN}\n${body}\n${TOOL_CALL_CLOSE}`
}

describe('ChatHubLlmAdapter metadata', () => {
  it('names the route after the site and advertises one model', async () => {
    const source = new FakeSource()
    const subject = adapter(source)
    expect(subject.providerInfo('deepseek-web-chathub')).toEqual({ id: 'deepseek-web-chathub', name: 'ChatHub deepseek-web' })
    expect(await subject.listModels('deepseek-web-chathub')).toEqual([
      { provider: 'deepseek-web-chathub', id: 'web-model', name: 'web-model' },
    ])
    expect(await subject.resolveModel('deepseek-web-chathub', 'web-model')).toEqual({
      provider: 'deepseek-web-chathub',
      id: 'web-model',
      name: 'web-model',
      context: { contextWindow: 32_000 },
    })
  })

  it('names each mounted site behind its own route', () => {
    const subject = adapter(new FakeSource(), {
      sites: ['deepseek-web', 'qianwen-web'],
      routes: ['deepseek-web-chathub', 'qianwen-web-chathub'],
    })
    expect(subject.providerInfo('deepseek-web-chathub').name).toBe('ChatHub deepseek-web')
    expect(subject.providerInfo('qianwen-web-chathub').name).toBe('ChatHub qianwen-web')
  })

  it('refuses a route outside the configured sites', async () => {
    await expect(collect(adapter(new FakeSource()).stream({
      ...request(),
      provider: 'gemini-web-chathub',
    }))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('accepts a custom route id equal to a configured site', async () => {
    const source = new FakeSource()
    source.answers = ['nothing to change']
    const subject = adapter(source, { site: 'qianwen-web', sites: ['qianwen-web'], routes: ['qianwen-web'] })
    await collect(subject.stream({ ...request(), provider: 'qianwen-web' }))
    expect(source.sites).toEqual(['qianwen-web'])
    expect(source.released).toEqual(['qianwen-web:1'])
  })
})

describe('ChatHubLlmAdapter turns', () => {
  it('emits a text block and stops when the reply asks for nothing', async () => {
    const source = new FakeSource()
    source.answers = ['nothing to change']
    const chunks = await collect(adapter(source).stream(request()))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'nothing to change' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'nothing to change' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    // The adapter renders the whole conversation itself and says so.
    expect(source.prompts[0]).toContain('# NOW\nuser: fix the build')
    expect(source.sites).toEqual(['deepseek-web'])
    expect(source.released).toEqual(['deepseek-web:1'])
  })

  it('drives the site its route names, not the mount default', async () => {
    const source = new FakeSource()
    source.answers = ['nothing to change']
    const subject = adapter(source, {
      sites: ['deepseek-web', 'qianwen-web'],
      routes: ['deepseek-web-chathub', 'qianwen-web-chathub'],
    })
    await collect(subject.stream({ ...request(), provider: 'qianwen-web-chathub' }))
    expect(source.sites).toEqual(['qianwen-web'])
    expect(source.released).toEqual(['qianwen-web:1'])
  })

  it('emits one tool-call block and finishes with tool-calls', async () => {
    const source = new FakeSource()
    source.answers = [call('{"name":"read","arguments":{"file_path":"src/main.ts"}}')]
    const chunks = await collect(adapter(source).stream(request()))
    expect(chunks.slice(0, 3)).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'let me look.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'let me look.' } },
    ])
    expect(chunks[3]).toEqual({ type: 'block-start', index: 1, blockType: 'tool-call' })
    expect(chunks[4]).toMatchObject({
      type: 'tool-call-delta',
      index: 1,
      name: 'read',
      argumentsDelta: '{"file_path":"src/main.ts"}',
    })
    expect(chunks[5]).toMatchObject({
      type: 'block-end',
      index: 1,
      block: { type: 'tool-call', name: 'read', arguments: '{"file_path":"src/main.ts"}' },
    })
    expect(chunks[6]).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('emits an empty text block when the reply is only a call', async () => {
    const source = new FakeSource()
    source.answers = [`${TOOL_CALL_OPEN}\n{"name":"read","arguments":{"file_path":"a.ts"}}\n${TOOL_CALL_CLOSE}`]
    const chunks = await collect(adapter(source).stream(request()))
    expect(chunks[1]).toEqual({ type: 'block-end', index: 0, block: { type: 'text', text: '' } })
  })

  it('retries once in a fresh conversation when the first reply is illegal', async () => {
    const source = new FakeSource()
    source.answers = [call('{"name":"bash","arguments":{"command":"rm -rf /"}}'), 'all done']
    const records: ChatHubTurnObservation[] = []
    const chunks = await collect(adapter(source, { onTurn: record => records.push(record) }).stream(request()))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    // A retry is a new page key, so the site never sees the previous attempt.
    expect(source.keys).toEqual(['deepseek-web:1', 'deepseek-web:2'])
    expect(source.released).toEqual(['deepseek-web:1', 'deepseek-web:2'])
    // The correction travels inside the second prompt.
    expect(source.prompts[1]).toContain('# CORRECTION')
    expect(source.prompts[1]).toContain('not allowed')
    expect(records[0]?.attempt).toBe(2)
  })

  it('fails with MALFORMED_RESPONSE once the repair budget is spent', async () => {
    const source = new FakeSource()
    const records: ChatHubTurnObservation[] = []
    source.answers = [call('{"name":"bash","arguments":{"command":"ls"}}'), 'still illegal? no']
    await expect(collect(adapter(source, {
      repairAttempts: 0,
      onTurn: record => records.push(record),
    }).stream(request()))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect(source.keys).toEqual(['deepseek-web:1'])
    expect(records).toHaveLength(1)
  })

  it('reports one observation per turn without any text', async () => {
    const source = new FakeSource()
    const records: ChatHubTurnObservation[] = []
    source.answers = [call('{"name":"read","arguments":{"file_path":"a.ts"}}')]
    await collect(adapter(source, { onTurn: record => records.push(record) }).stream({
      ...request(),
      sessionId: 'sess-1' as never,
    }))
    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record?.sessionId).toBe('sess-1')
    expect(record?.pageKey).toBe('deepseek-web:1')
    expect(record?.attempt).toBe(1)
    expect(record?.toolName).toBe('read')
    expect(record?.promptChars).toBeGreaterThan(0)
    expect(record?.answerChars).toBeGreaterThan(0)
    expect(record?.droppedEntries).toBe(0)
    expect(record?.ms).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(record)).not.toContain('fix the build')
  })

  it('declares only whitelisted tools in the prompt', async () => {
    const source = new FakeSource()
    source.answers = ['ok']
    await collect(adapter(source).stream({
      ...request(),
      tools: [
        { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
        { name: 'bash', description: 'Run a command', parameters: { type: 'object' } },
      ],
    }))
    expect(source.prompts[0]).toContain('"name":"read"')
    expect(source.prompts[0]).not.toContain('"name":"bash"')
  })

  it('runs without a configured workspace root', async () => {
    const source = new FakeSource()
    source.answers = [call('{"name":"read","arguments":{"file_path":"/etc/passwd"}}')]
    const chunks = await collect(adapter(source, { workspaceRoot: undefined }).stream(request()))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(source.prompts[0]).toContain('root: (unknown; use relative paths)')
  })

  it('reports a legal turn without a rejection reason', async () => {
    const source = new FakeSource()
    const records: ChatHubTurnObservation[] = []
    source.answers = ['plain text, nothing to do']
    await collect(adapter(source, { onTurn: record => records.push(record) }).stream(request()))
    expect(records[0]?.invalid).toBeUndefined()
    expect(records[0]?.toolName).toBeUndefined()
  })
})

describe('ChatHubLlmAdapter refusals', () => {
  it('refuses a signed-out provider before opening a page', async () => {
    const source = new FakeSource()
    source.health = 'needs-auth'
    await expect(collect(adapter(source).stream(request()))).rejects.toMatchObject({ code: 'AUTH' })
    expect(source.keys).toEqual([])
  })

  it('refuses a failed provider before opening a page', async () => {
    const source = new FakeSource()
    source.health = 'failed'
    await expect(collect(adapter(source).stream(request()))).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('refuses a site that is not shipped by the host', async () => {
    const source = new FakeSource()
    await expect(collect(adapter(source, { site: 'ghost-web', sites: ['ghost-web'] }).stream({
      ...request(),
      provider: 'ghost-web',
    }))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('refuses while sign-in is still pending', async () => {
    const source = new FakeSource()
    source.openMode = 'pending'
    await expect(collect(adapter(source).stream(request()))).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('refuses a transport that reports a closed session', async () => {
    const source = new FakeSource()
    source.openMode = 'closed'
    const failure = await collect(adapter(source).stream(request())).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'AUTH' })
    expect((failure as Error).message).toContain('not-signed-in')
  })

  it('refuses a request that cannot fit the prompt budget', async () => {
    const source = new FakeSource()
    await expect(collect(adapter(source, { maxPromptChars: 100 }).stream(request())))
      .rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
  })

  it('stops before opening a page when the caller already cancelled', async () => {
    const source = new FakeSource()
    const controller = new AbortController()
    controller.abort()
    await expect(collect(adapter(source).stream({ ...request(), signal: controller.signal })))
      .rejects.toMatchObject({ code: 'ABORTED' })
    expect(source.keys).toEqual([])
  })

  it('stops after the answer when the caller cancelled mid-turn', async () => {
    const source = new FakeSource()
    const controller = new AbortController()
    source.onSend = () => { controller.abort() }
    source.answers = ['late answer']
    await expect(collect(adapter(source).stream({ ...request(), signal: controller.signal })))
      .rejects.toMatchObject({ code: 'ABORTED' })
    // The page is still released on the way out.
    expect(source.released).toEqual(['deepseek-web:1'])
  })
})

describe('ChatHubLlmAdapter transport failures', () => {
  const CASES: readonly [string, string, unknown][] = [
    ['a signed-out page', 'AUTH', Object.assign(new Error('page gone'), { token: 'chathub-signed-out' })],
    ['a busy queue', 'RATE_LIMIT', new Error('chathub-busy: queue full')],
    ['a stalled turn', 'TIMEOUT', new Error('chathub-turn-timeout: no answer')],
    ['a drifted UI', 'SERVER', new Error('chathub-ui-drift: no input')],
    ['a missing browser', 'SERVER', new Error('chathub-browser-unavailable: no chrome')],
    ['a locked profile', 'SERVER', new Error('chathub-profile-locked: pid 42')],
    ['a broken network', 'TRANSPORT', new Error('chathub-network: ECONNRESET')],
    ['an unknown token', 'TRANSPORT', Object.assign(new Error('odd'), { token: 'chathub-mystery' })],
    ['a plain failure', 'TRANSPORT', new Error('something odd')],
  ]

  for (const [label, code, failure] of CASES) {
    it(`maps ${label} to ${code}`, async () => {
      const source = new FakeSource()
      source.sendError = failure
      await expect(collect(adapter(source).stream(request()))).rejects.toMatchObject({ code })
      expect(source.released).toEqual(['deepseek-web:1'])
    })
  }

  it('keeps an LlmError the transport already raised', async () => {
    const source = new FakeSource()
    source.sendError = new LlmError('already mapped', 'CUSTOM')
    await expect(collect(adapter(source).stream(request()))).rejects.toMatchObject({ code: 'CUSTOM' })
  })

  it('rethrows a non-Error rejection untouched', async () => {
    const source = new FakeSource()
    source.sendError = 'boom'
    await expect(collect(adapter(source).stream(request()))).rejects.toBe('boom')
  })
})
