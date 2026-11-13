/** Adapter: one loop step per site turn, with the repair and failure policy. */

import {
  createAssistantMessage,
  LlmError,
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChatHubLlmAdapter } from '../src/adapter.ts'
import { END_MARKER, TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from '../src/protocol.ts'
import type {
  ChatHubLlmConfig,
  ChatHubTransport,
  ChatHubTransportSession,
  ChatHubTransportSource,
  ChatHubTurnObservation,
} from '../src/types.ts'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'session-title': true
    'compaction': true
  }
}

/** One scripted page: records what it was asked and what it answered. */
class FakeSession implements ChatHubTransportSession {
  closed = false

  /**
   * Snapshots of the growing answer, present only when the transport reports
   * them; the streaming caller consumes these instead of `send`.
   */
  watch?: (payload: { prompt: string }) => AsyncIterable<string>

  /**
   * @param source - transport that scripted this page.
   * @param key - page key the transport opened it under.
   * @param site - site provider the page belongs to.
   */
  constructor(
    private readonly source: FakeSource,
    readonly key: string,
    private readonly site: string,
  ) {
    if (source.snapshots) this.watch = payload => this.watchTurn(payload)
  }

  /**
   * @param payload - the prompt the adapter rendered.
   * @returns The scripted answer.
   */
  async send(payload: { prompt: string }): Promise<{ content: string }> {
    this.source.prompts.push(payload.prompt)
    const answer = await this.answerOf()
    // A site serializes its answer DOM: markup-carrying content escapes `<`,
    // `>`, and `&` into entities, which is the shape the transport really
    // delivers and the adapter's text conversion unescapes.
    return {
      content: answer
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;'),
    }
  }

  /**
   * @param payload - the prompt the adapter rendered.
   * @returns The scripted answer's snapshots, entity-escaped like `send`
   *   content, ending with the full answer.
   */
  private async *watchTurn(payload: { prompt: string }): AsyncIterable<string> {
    this.source.prompts.push(payload.prompt)
    const answer = await this.answerOf()
    const escape = (text: string): string => text
      .replace(/&/gu, '&amp;')
      .replace(/</gu, '&lt;')
      .replace(/>/gu, '&gt;')
    const plan = this.source.watchPlans.shift() ?? [answer]
    for (const snapshot of plan) yield escape(snapshot)
  }

  /**
   * Consume one scripted answer, sharing the failure checks of both paths.
   * @returns The raw answer text.
   */
  private async answerOf(): Promise<string> {
    if (this.source.failSites.has(this.site)) {
      throw new LlmError(`chathub-llm: ${this.site} is needs-auth; sign in first`, 'AUTH')
    }
    const failure = this.source.sendError
    if (failure !== undefined) throw failure
    this.source.onSend?.()
    return this.source.answers.shift() ?? ''
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
  /** Per-site health that overrides {@link health} for a listed site. */
  healthBySite: Record<string, string> = {}
  answers: string[] = []
  /** Whether scripted pages report answer snapshots for the streaming path. */
  snapshots = false
  /** Snapshot sequence per streamed turn, entity-escaped like `send` content. */
  watchPlans: string[][] = []
  openMode: 'session' | 'pending' | 'closed' = 'session'
  sendError: unknown
  openError: unknown
  onSend: (() => void) | undefined
  /** Sites whose page refuses the turn as signed out. */
  readonly failSites = new Set<string>()
  readonly prompts: string[] = []
  readonly keys: string[] = []
  readonly released: string[] = []
  readonly sites: string[] = []

  /** @returns One health row per health-known site. */
  providers(): Promise<readonly { id: string; health: { status: string } }[]> {
    return Promise.resolve([
      { id: 'deepseek-web', health: { status: this.healthBySite['deepseek-web'] ?? this.health } },
      { id: 'qianwen-web', health: { status: this.healthBySite['qianwen-web'] ?? this.health } },
    ])
  }

  /** @returns The transport the adapter drives. */
  transportForAdapter(): ChatHubTransport {
    return {
      open: async (providerId: string, key?: string) => {
        this.sites.push(providerId)
        this.keys.push(key ?? '')
        if (this.openError !== undefined) throw this.openError
        if (this.openMode === 'pending') return undefined
        if (this.openMode === 'closed') return { closed: true, reason: 'not-signed-in' } as const
        return new FakeSession(this, key ?? '', providerId)
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
  auxiliary: 'refuse',
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
      { provider: 'deepseek-web-chathub', id: 'web-model', name: 'deepseek-web' },
    ])
    expect(await subject.resolveModel('deepseek-web-chathub', 'web-model')).toEqual({
      provider: 'deepseek-web-chathub',
      id: 'web-model',
      name: 'deepseek-web',
      context: { contextWindow: 32_000 },
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Max' },
        ],
      },
    })
  })

  it('declares the standard reasoning efforts so a leaked default effort resolves', async () => {
    // A session-level default model carries its effort into requests routed to
    // a site model; without declared efforts the turn fails before the
    // browser opens with UNSUPPORTED_REASONING_EFFORT. The value is accepted
    // and ignored, and no default effort is materialized for callers that
    // send none.
    const info = await adapter(new FakeSource()).resolveModel('deepseek-web-chathub', 'web-model')
    expect(info.reasoning?.efforts.map(effort => effort.id)).toContain('high')
    expect(info.reasoning?.defaultEffort).toBeUndefined()
  })

  it('names each mounted site behind its own route', () => {
    const subject = adapter(new FakeSource(), {
      sites: ['deepseek-web', 'qianwen-web'],
      routes: ['deepseek-web-chathub', 'qianwen-web-chathub'],
    })
    expect(subject.providerInfo('deepseek-web-chathub').name).toBe('ChatHub deepseek-web')
    expect(subject.providerInfo('qianwen-web-chathub').name).toBe('ChatHub qianwen-web')
  })

  it('names the aggregate route after every site it spans', () => {
    const subject = adapter(new FakeSource(), {
      sites: ['deepseek-web', 'qianwen-web'],
      routes: ['deepseek-web-chathub', 'qianwen-web-chathub', 'web-auto-chathub'],
      autoRoute: 'web-auto-chathub',
    })
    expect(subject.providerInfo('web-auto-chathub'))
      .toEqual({ id: 'web-auto-chathub', name: 'ChatHub auto (deepseek-web, qianwen-web)' })
  })

  it('lists the site, not one shared model name, under each route', async () => {
    const subject = adapter(new FakeSource(), {
      sites: ['deepseek-web', 'qianwen-web'],
      routes: ['deepseek-web-chathub', 'qianwen-web-chathub', 'web-auto-chathub'],
      autoRoute: 'web-auto-chathub',
    })
    expect((await subject.listModels('deepseek-web-chathub'))[0]?.name).toBe('deepseek-web')
    expect((await subject.listModels('qianwen-web-chathub'))[0]?.name).toBe('qianwen-web')
    expect((await subject.listModels('web-auto-chathub'))[0]?.name).toBe('auto')
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

  it('teaches the missing-arguments defect by name in the correction', async () => {
    const source = new FakeSource()
    source.answers = [call('{"name":"read"}'), call('{"name":"read","arguments":{"file_path":"a.ts"}}')]
    await collect(adapter(source).stream(request()))
    // The correction says where the arguments belong, not only "use the block".
    expect(source.prompts[1]).toContain('carries no arguments object')
    expect(source.prompts[1]).toContain('nest the arguments under "arguments"')
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

  it('tapes the exact prompt the site read when the log is enabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chathub-tape-'))
    const tape = join(dir, 'prompts.jsonl')
    process.env.DSH_CHATHUB_LLM_PROMPT_LOG = tape
    try {
      const source = new FakeSource()
      source.answers = ['ok']
      await collect(adapter(source).stream(request()))
      const entry = JSON.parse(await readFile(tape, 'utf8')) as { site: string; chars: number; prompt: string }
      expect(entry.site).toBe('deepseek-web')
      expect(entry.chars).toBe(entry.prompt.length)
      expect(entry.prompt).toContain('# NOW')
    } finally {
      delete process.env.DSH_CHATHUB_LLM_PROMPT_LOG
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('tapes the raw answer with its rejection when the answer log is enabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chathub-tape-'))
    const tape = join(dir, 'answers.jsonl')
    process.env.DSH_CHATHUB_LLM_ANSWER_LOG = tape
    try {
      const source = new FakeSource()
      source.answers = [call('{"name":"read"}'), call('{"name":"read","arguments":{"file_path":"a.ts"}}')]
      await collect(adapter(source).stream(request()))
      const lines = (await readFile(tape, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {
        site: string
        attempt: number
        chars: number
        invalid?: string
        answer: string
      })
      expect(lines).toHaveLength(2)
      expect(lines[0]?.site).toBe('deepseek-web')
      expect(lines[0]?.attempt).toBe(1)
      expect(lines[0]?.chars).toBe(lines[0]?.answer.length)
      expect(lines[0]?.invalid).toBe('tool "read" carries no arguments object')
      expect(lines[0]?.answer).toContain(TOOL_CALL_OPEN)
      // The accepted retry is taped too, without a rejection field.
      expect(lines[1]?.invalid).toBeUndefined()
      expect(lines[1]?.answer).toContain('"file_path":"a.ts"')
    } finally {
      delete process.env.DSH_CHATHUB_LLM_ANSWER_LOG
      await rm(dir, { recursive: true, force: true })
    }
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

describe('ChatHubLlmAdapter live streaming', () => {
  it('streams a pinned route answer as growing text deltas', async () => {
    const source = new FakeSource()
    source.snapshots = true
    source.answers = ['the build is green now']
    // One snapshot per poll: the answer grows mid-turn, so the deltas the
    // caller sees while the turn runs are separate chunks, not one lump.
    source.watchPlans = [['the build is', 'the build is green', 'the build is green now']]
    const chunks = await collect(adapter(source).stream(request()))
    const deltas = chunks.flatMap(chunk => chunk.type === 'text-delta' ? [chunk.text] : [])
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.join('')).toBe('the build is green now')
    const blockEnd = chunks.find(chunk => chunk.type === 'block-end')
    expect(blockEnd).toMatchObject({ block: { type: 'text', text: 'the build is green now' } })
    expect(source.prompts).toHaveLength(1)
    expect(source.released).toEqual(['deepseek-web:1'])
  })

  it('holds the tool-call marker back while streaming and emits the call after', async () => {
    const source = new FakeSource()
    source.snapshots = true
    const body = '{"name":"read","arguments":{"file_path":"src/a.ts"}}'
    const full = call(body)
    source.answers = [full]
    source.watchPlans = [[`let me look.\n${TOOL_CALL_OPEN}`, full]]
    const chunks = await collect(adapter(source).stream(request()))
    const deltas = chunks.flatMap(chunk => chunk.type === 'text-delta' ? [chunk.text] : [])
    // No delta carries any part of the marker, however the DOM split it.
    for (const delta of deltas) expect(delta).not.toContain('<')
    expect(deltas.join('')).toBe('let me look.\n')
    const callEnd = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(callEnd).toMatchObject({
      index: 1,
      block: { type: 'tool-call', id: expect.any(String), name: 'read', arguments: '{"file_path":"src/a.ts"}' },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('does not stream a half-written END marker when the holdback is released', async () => {
    const source = new FakeSource()
    source.snapshots = true
    // Regression for 2026-11-13: gemini-web's answer container stabilized on
    // the first two characters of <<<END. parseAnswer already accepts that as a
    // damaged marker, but finalSuffix used to flush "\n<<" into the SSE deltas,
    // so the client saw text the final block-end did not contain.
    const answer = 'HTTP 200 means OK\n<<'
    source.answers = [answer]
    source.watchPlans = [['HTTP 200 means', answer]]
    const chunks = await collect(adapter(source).stream(request()))
    const deltas = chunks.flatMap(chunk => chunk.type === 'text-delta' ? [chunk.text] : [])
    expect(deltas.join('')).toBe('HTTP 200 means OK')
    const blockEnd = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'text')
    expect(blockEnd).toMatchObject({ block: { type: 'text', text: 'HTTP 200 means OK' } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('keeps a site-mangled END tail out of streamed text too', async () => {
    const source = new FakeSource()
    source.snapshots = true
    const answer = 'all done\n<<END'
    source.answers = [answer]
    source.watchPlans = [['all', answer]]
    const chunks = await collect(adapter(source).stream(request()))
    const deltas = chunks.flatMap(chunk => chunk.type === 'text-delta' ? [chunk.text] : [])
    expect(deltas.join('')).toBe('all done')
  })

  it('still hides the exact END marker from streamed text', async () => {
    const source = new FakeSource()
    source.snapshots = true
    const answer = `done\n${END_MARKER}`
    source.answers = [answer]
    source.watchPlans = [['done', answer]]
    const chunks = await collect(adapter(source).stream(request()))
    const deltas = chunks.flatMap(chunk => chunk.type === 'text-delta' ? [chunk.text] : [])
    expect(deltas.join('')).toBe('done')
  })

  it('still streams a single trailing bracket that is not a marker tail', async () => {
    const source = new FakeSource()
    source.snapshots = true
    const answer = 'x <'
    source.answers = [answer]
    source.watchPlans = [['x', answer]]
    const chunks = await collect(adapter(source).stream(request()))
    const deltas = chunks.flatMap(chunk => chunk.type === 'text-delta' ? [chunk.text] : [])
    expect(deltas.join('')).toBe('x <')
  })

  it('surfaces an illegal answer instead of repairing once a delta has been emitted', async () => {
    const source = new FakeSource()
    source.snapshots = true
    const unclosed = `looking\n${TOOL_CALL_OPEN}\n{"name":"read"`
    const body = '{"name":"read","arguments":{"file_path":"src/a.ts"}}'
    source.answers = [unclosed, call(body)]
    source.watchPlans = [[unclosed]]
    await expect(collect(adapter(source).stream(request()))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    // The visible text committed the attempt, so no repair round re-asks.
    expect(source.prompts).toHaveLength(1)
  })

  it('repairs the same illegal answer when nothing was streamed yet', async () => {
    const source = new FakeSource()
    const unclosed = `looking\n${TOOL_CALL_OPEN}\n{"name":"read"`
    const body = '{"name":"read","arguments":{"file_path":"src/a.ts"}}'
    source.answers = [unclosed, call(body)]
    const chunks = await collect(adapter(source).stream(request()))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(source.prompts).toHaveLength(2)
  })

  it('keeps the aggregate route on the lump path even when snapshots exist', async () => {
    const source = new FakeSource()
    source.snapshots = true
    // Two answers: the aggregate route replays prose across sites, and both
    // replays and lumps stay on the full-answer pipeline.
    source.answers = ['one answer', 'one answer']
    source.watchPlans = [['one', 'one answer'], ['one', 'one answer']]
    const chunks = await collect(adapter(source, {
      sites: ['deepseek-web', 'qianwen-web'],
      routes: ['deepseek-web-chathub', 'qianwen-web-chathub', 'web-auto-chathub'],
      autoRoute: 'web-auto-chathub',
    }).stream({ ...request(), provider: 'web-auto-chathub' }))
    const deltas = chunks.flatMap(chunk => chunk.type === 'text-delta' ? [chunk.text] : [])
    expect(deltas).toEqual(['one answer'])
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

describe('ChatHubLlmAdapter auxiliary requests', () => {
  it('refuses a session title before a page is opened', async () => {
    const source = new FakeSource()
    await expect(collect(adapter(source).stream({ ...request(), purpose: 'session-title' })))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    // No page, no prompt: the refusal costs nothing on the user's account.
    expect(source.keys).toEqual([])
    expect(source.prompts).toEqual([])
  })

  it('serves a compaction summary: its output is the caller\'s result', async () => {
    const source = new FakeSource()
    const checkpoint = '## Primary Request and Intent\n- fix the build'.repeat(150)
    source.answers = [checkpoint]
    const chunks = await collect(adapter(source).stream({ ...request(), purpose: 'compaction' }))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(source.keys).toEqual(['deepseek-web:1'])
    // A checkpoint outgrows the conversational text budget, so the compaction
    // turn reads its answer under the raised bound instead of truncating it.
    const text = chunks
      .filter((chunk): chunk is Extract<typeof chunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
    expect(text).toHaveLength(checkpoint.trim().length)
    expect(text.length).toBeGreaterThan(2_000)
  })

  it('serves an auxiliary request when the mount allows it', async () => {
    const source = new FakeSource()
    source.answers = ['Fix the build']
    const chunks = await collect(adapter(source, { auxiliary: 'allow' })
      .stream({ ...request(), purpose: 'session-title' }))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(source.keys).toEqual(['deepseek-web:1'])
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

  it('classifies a transport failure that escapes open', async () => {
    // A page that closes while open waits reports the browser token; without
    // the mapping the raw BrowserTransportError bypasses the site-failure
    // codes and the loop cannot fail over.
    const source = new FakeSource()
    const err = new Error('glm-web:9: page closed while waiting for input')
    Object.assign(err, { token: 'chathub-browser-unavailable' })
    source.openError = err
    await expect(collect(adapter(source).stream(request()))).rejects.toMatchObject({ code: 'SERVER' })
  })
})

describe('ChatHubLlmAdapter answer text', () => {
  it('keeps the indentation a call argument carries', async () => {
    const source = new FakeSource()
    const body = JSON.stringify({
      name: 'edit',
      arguments: { file_path: 'a.lua', old_string: '    x = 1,   -- 慢', new_string: '    x = 2,   -- 慢' },
    })
    // A site renders the block inside markup and escapes the delimiters.
    source.answers = [`<pre><code>${TOOL_CALL_OPEN}\n${body}\n${TOOL_CALL_CLOSE}</code></pre>`]
    const chunks = await collect(adapter(source, { allowTools: ['edit'] }).stream(request()))
    const delta = chunks.find(chunk => chunk.type === 'tool-call-delta')
    expect(delta?.type).toBe('tool-call-delta')
    if (delta?.type !== 'tool-call-delta') return
    const args = JSON.parse(delta.argumentsDelta) as { old_string: string }
    // The site's markup is stripped; the argument's own whitespace is not.
    expect(args.old_string).toBe('    x = 1,   -- 慢')
  })
})

/**
 * @param text - the task text of the request.
 * @returns A request whose conversation already carries one executed tool call,
 *   so a blockless reply is a final answer the END-marker rule governs.
 */
function requestAfterTools(text: string): GenerateOptions {
  return {
    ...request(text),
    messages: [...request(text).messages, createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 'read', arguments: '{}' }],
      source: { provider: 'deepseek-web-chathub', model: 'web-model' },
    })],
  }
}

describe('ChatHubLlmAdapter reply-shape repairs', () => {
  // Regression for 2026-11-13: a long GLM turn with tool history answered in
  // full but was discarded as MALFORMED_RESPONSE because the reply lacked the
  // trailing <<<END. The marker is a warning now; reintroducing a repair or a
  // rejection for it must break this test.
  it('delivers a completed final answer without END instead of re-asking or rejecting it', async () => {
    const source = new FakeSource()
    const answer = `the build is fixed\n\n${'more detail '.repeat(60)}`
    source.answers = [answer]
    const chunks = await collect(adapter(source).stream(requestAfterTools('summarize the fix')))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    // The whole answer reaches the caller, not just a prefix, on one site turn.
    expect(chunks.flatMap(chunk => chunk.type === 'text-delta' ? [chunk.text] : []).join(''))
      .toContain('the build is fixed')
    expect(source.keys).toEqual(['deepseek-web:1'])
    expect(source.prompts).toHaveLength(1)
    expect(source.prompts[0]).not.toContain('# CORRECTION')
  })

  it('does not fail a final answer that never ends with the marker, even with a zero repair budget', async () => {
    const source = new FakeSource()
    source.answers = ['the build is fixed']
    const chunks = await collect(adapter(source, { repairAttempts: 0 }).stream(requestAfterTools('summarize the fix')))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(source.keys).toEqual(['deepseek-web:1'])
    expect(source.prompts[0]).not.toContain('# CORRECTION')
  })

  it('does not require the marker before any tool has run', async () => {
    const source = new FakeSource()
    source.answers = ['nothing to change']
    await collect(adapter(source).stream(request()))
    // A fresh topic may answer in prose; the marker rule starts with the first
    // executed tool call.
    expect(source.keys).toEqual(['deepseek-web:1'])
  })

  it('repairs a narrated tool call into a real block', async () => {
    const source = new FakeSource()
    // A real subject answered exactly this shape: the read it never ran was
    // narrated as the prompt's history echoes, and the reply was cut off.
    source.answers = [
      '已读：service/condition_evaluator.lua（全文）\n[asked for read {"file_path":"service/rule_engine_service.lua"}]\n先把剩余部分读完：',
      call('{"name":"read","arguments":{"file_path":"service/rule_engine_service.lua"}}'),
    ]
    const chunks = await collect(adapter(source).stream(request('读完 rule_engine 目录')))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(source.keys).toEqual(['deepseek-web:1', 'deepseek-web:2'])
    expect(source.prompts[1]).toContain('# CORRECTION')
    expect(source.prompts[1]).toContain('TOOL_CALL>>>')
  })

  it('fails a reply that keeps narrating after the repair budget', async () => {
    const source = new FakeSource()
    source.answers = ['[asked for read {"file_path":"a.ts"}] 已读完']
    await expect(collect(adapter(source, { repairAttempts: 0 }).stream(request('读完'))))
      .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('exempts a compaction summary from the marker and narrative rules', async () => {
    const source = new FakeSource()
    // A checkpoint is machine-consumed on a web-only mount with no fallback
    // route, and it legitimately recounts the conversation's tool events.
    const checkpoint = '## Primary Request and Intent\n- fix the build\n- ran tool(read) -> src/main.ts'.repeat(20)
    source.answers = [checkpoint]
    const chunks = await collect(adapter(source).stream({ ...request(), purpose: 'compaction' }))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(source.keys).toEqual(['deepseek-web:1'])
  })
})

/** Mount with the aggregate route on: both sites, plus auto selection. */
const AUTO: Partial<ChatHubLlmConfig> = {
  sites: ['deepseek-web', 'qianwen-web'],
  routes: ['deepseek-web-chathub', 'qianwen-web-chathub', 'web-auto-chathub'],
  autoRoute: 'web-auto-chathub',
}

/**
 * @param session - harness session, the key a topic is tracked under.
 * @returns A request on the aggregate route.
 */
function autoRequest(session: string): GenerateOptions {
  return {
    ...request(),
    provider: 'web-auto-chathub',
    sessionId: session as NonNullable<GenerateOptions['sessionId']>,
  }
}

describe('ChatHubLlmAdapter site selection', () => {
  it('keeps one topic on one site and starts a new topic on the other', async () => {
    const source = new FakeSource()
    // Legal call blocks, so the prose-replay rule stays out of the way: this
    // test is about placement, not about protocol compliance.
    source.answers = [
      call('{"name":"read","arguments":{"file_path":"a.ts"}}'),
      call('{"name":"read","arguments":{"file_path":"b.ts"}}'),
      call('{"name":"read","arguments":{"file_path":"c.ts"}}'),
    ]
    const subject = adapter(source, AUTO)
    await collect(subject.stream(autoRequest('session-a')))
    await collect(subject.stream(autoRequest('session-a')))
    await collect(subject.stream(autoRequest('session-b')))
    // Two turns of one conversation read as one voice; a new conversation
    // spreads to the account that has been idle.
    expect(source.sites).toEqual(['deepseek-web', 'deepseek-web', 'qianwen-web'])
  })

  it('does not spend a turn on a site that needs sign-in', async () => {
    const source = new FakeSource()
    source.healthBySite = { 'deepseek-web': 'needs-auth' }
    source.answers = ['ok']
    await collect(adapter(source, AUTO).stream(autoRequest('session-a')))
    expect(source.sites).toEqual(['qianwen-web'])
  })

  it('replaces a site that fails the turn instead of failing the step', async () => {
    const source = new FakeSource()
    source.failSites.add('deepseek-web')
    source.answers = ['ok']
    const chunks = await collect(adapter(source, AUTO).stream(autoRequest('session-a')))
    expect(source.sites).toEqual(['deepseek-web', 'qianwen-web'])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('reports the site that served an auto turn', async () => {
    const source = new FakeSource()
    source.answers = [call('{"name":"read","arguments":{"file_path":"a.ts"}}')]
    const records: ChatHubTurnObservation[] = []
    await collect(adapter(source, { ...AUTO, onTurn: record => records.push(record) })
      .stream(autoRequest('session-a')))
    expect(records[0]?.site).toBe('deepseek-web')
  })

  it('replays a protocol-breaking answer on another site', async () => {
    const source = new FakeSource()
    const records: ChatHubTurnObservation[] = []
    // The prompt is fixed and self-contained, so a model that cannot produce a
    // legal call block is the part that varies: another site deserves the turn.
    source.answers = [call('{"name":"bash","arguments":{"command":"ls"}}'), 'ok']
    const chunks = await collect(adapter(source, {
      ...AUTO,
      repairAttempts: 0,
      onTurn: record => records.push(record),
    }).stream(autoRequest('session-a')))
    expect(source.sites).toEqual(['deepseek-web', 'qianwen-web'])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    // The failed attempt stays on the tape, so a turn that moved is visible
    // site by site instead of only as its final answer.
    expect(records.map(record => record.failure ?? null)).toEqual(['MALFORMED_RESPONSE', null])
    expect(records.map(record => record.site)).toEqual(['deepseek-web', 'qianwen-web'])
  })

  it('replays a prose answer that dodges the tool protocol', async () => {
    const source = new FakeSource()
    const records: ChatHubTurnObservation[] = []
    // A fresh topic answered with a refusal question instead of a call block
    // is a protocol miss, not a finished task: another site deserves the turn.
    source.answers = [
      '目前我这边无法访问本地文件系统，请补充仓库路径与改进方向',
      call('{"name":"read","arguments":{"file_path":"src/main.ts"}}'),
    ]
    const chunks = await collect(adapter(source, { ...AUTO, onTurn: record => records.push(record) })
      .stream(autoRequest('session-a')))
    expect(source.sites).toEqual(['deepseek-web', 'qianwen-web'])
    expect(records.map(record => record.failure ?? null)).toEqual(['PROSE_ANSWER', null])
    expect(chunks.some(chunk => chunk.type === 'tool-call-delta')).toBe(true)
  })

  it('delivers the last prose answer when every site declines', async () => {
    const source = new FakeSource()
    source.answers = ['我无法访问文件', '请直接贴出关键文件']
    const chunks = await collect(adapter(source, AUTO).stream(autoRequest('session-a')))
    expect(source.sites).toEqual(['deepseek-web', 'qianwen-web'])
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
  })

  it('keeps a prose answer that follows executed tool calls', async () => {
    const source = new FakeSource()
    // A final summary ends with the completion marker; the marker itself never
    // reaches the caller's text.
    source.answers = ['the build is fixed\n<<<END']
    const history = request('summarize the fix')
    const done: GenerateOptions = {
      ...history,
      // A final summary only happens after tools have run; prose here is the
      // caller's answer, never a replay trigger.
      messages: [...history.messages, createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 'read', arguments: '{}' }],
        source: { provider: 'deepseek-web-chathub', model: 'web-model' },
      })],
    }
    const chunks = await collect(adapter(source, AUTO).stream(done))
    expect(source.sites).toEqual(['deepseek-web'])
    expect(chunks.flatMap(chunk => (chunk.type === 'text-delta' ? [chunk.text] : [])).join('')).toBe('the build is fixed')
  })

  it('answers a pinned route with the prose it got', async () => {
    const source = new FakeSource()
    source.answers = ['我无法访问文件']
    const chunks = await collect(adapter(source).stream(request()))
    // The user picked this model; replaying its words elsewhere is a silent
    // substitute, so a pinned prose answer is delivered as-is.
    expect(source.sites).toEqual(['deepseek-web'])
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
  })

  it('names the transport code when the page throws no structured failure', async () => {
    const source = new FakeSource()
    const records: ChatHubTurnObservation[] = []
    source.sendError = 'page exploded'
    await expect(collect(adapter(source, { ...AUTO, onTurn: record => records.push(record) })
      .stream(autoRequest('session-a')))).rejects.toBe('page exploded')
    expect(records[0]?.failure).toBe('TRANSPORT')
    // Nothing about a page that threw an opaque value says another site would
    // answer differently, so the turn stops here.
    expect(source.sites).toEqual(['deepseek-web'])
  })

  it('names the transport code when opening the page throws a bare error', async () => {
    const source = new FakeSource()
    const records: ChatHubTurnObservation[] = []
    source.openError = new Error('browser unavailable')
    await expect(collect(adapter(source, { onTurn: record => records.push(record) }).stream(request())))
      .rejects.toThrow(/browser unavailable/u)
    expect(records[0]?.failure).toBe('TRANSPORT')
  })

  it('carries repaired-argument warnings into the turn record', async () => {
    const source = new FakeSource()
    const records: ChatHubTurnObservation[] = []
    source.answers = [call('{"name":"edit","arguments":{"file_path":"a.lua","old_string":"x – y","new_string":"z"}}')]
    await collect(adapter(source, { onTurn: record => records.push(record) }).stream(request()))
    expect(records[0]?.warnings?.[0]).toMatch(/folded 1 typographic/u)
  })

  it('does not replay a cancelled turn on another site', async () => {
    const source = new FakeSource()
    const controller = new AbortController()
    controller.abort()
    await expect(collect(adapter(source, AUTO).stream({
      ...autoRequest('session-a'),
      signal: controller.signal,
    }))).rejects.toMatchObject({ code: 'ABORTED' })
    expect(source.sites).toEqual([])
  })

  it('never answers a pinned route from another site', async () => {
    const source = new FakeSource()
    source.failSites.add('deepseek-web')
    source.answers = ['ok']
    await expect(collect(adapter(source, AUTO).stream(request()))).rejects.toMatchObject({ code: 'AUTH' })
    // The user picked this model; a silent substitute is worse than a failure.
    expect(source.sites).toEqual(['deepseek-web'])
  })

  it('still names sign-in when every site needs it', async () => {
    const source = new FakeSource()
    source.health = 'needs-auth'
    source.answers = ['ok']
    await expect(collect(adapter(source, AUTO).stream(autoRequest('session-a'))))
      .rejects.toMatchObject({ code: 'AUTH' })
    expect(source.sites).toEqual([])
  })
})
