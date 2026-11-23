/** The chatHub Remote controller: lifecycle, persistence, stable failure codes, and restart recovery. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import {
  COMPACTION_INSTRUCTION,
  ProviderRegistry,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamChunk,
  type IModelProvider,
  type IProviderRegistry,
  type ModelCapabilities,
  type ModelKind,
  type ProviderErrorCode,
  type ProviderHealth,
  type ProviderStatus,
} from '@deepseek-ai/dsh-experimental-chathub'
import { describe, expect, it } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { ChatHubController } from '../src/controller.ts'
import type { ChatHubCompareEvent } from '../src/types.ts'

const AT = Date.UTC(2026, 10, 1, 12)

const CAPABILITIES: ModelCapabilities = { reasoning: false, coding: false, vision: false, webAccess: true, streaming: true }

/** Provider double with canned answers, a stable failure code, and a programmable readiness probe. */
class TurnProvider implements IModelProvider {
  readonly id: string
  readonly kind: ModelKind = 'web'
  readonly name: string
  readonly capabilities = CAPABILITIES
  readonly requests: ChatRequest[] = []
  normalizeError?: (error: unknown) => ProviderErrorCode
  healthStatus?: () => Promise<ProviderStatus>
  private readonly answers: (string | Error)[]
  private readonly metadata: Record<string, unknown> | undefined
  private readonly chunks: readonly ChatStreamChunk[] | undefined
  private readonly hold: Promise<void> | undefined

  constructor(options: {
    id: string
    name?: string
    answers?: readonly (string | Error)[]
    code?: ProviderErrorCode
    health?: ProviderStatus | Error
    metadata?: Record<string, unknown>
    chunks?: readonly ChatStreamChunk[]
    hold?: Promise<void>
  }) {
    this.id = options.id
    this.name = options.name ?? options.id
    this.answers = [...(options.answers ?? [])]
    this.metadata = options.metadata
    this.chunks = options.chunks
    this.hold = options.hold
    if (options.code !== undefined) {
      const code = options.code
      this.normalizeError = () => code
    }
    if (options.health !== undefined) {
      const health = options.health
      this.healthStatus = typeof health === 'string' ? (async () => health) : (async () => { throw health })
    }
  }

  /** Whether the site is already open; a cold one makes the caller open it. */
  ready = true
  /** Times `init()` ran, so a cold-site open is observable. */
  initCount = 0
  async init(): Promise<void> { this.initCount += 1 }
  async isReady(): Promise<boolean> { return this.ready }
  async sendMessage(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request)
    const answer = this.answers.shift()
    if (answer instanceof Error) throw answer
    return {
      providerId: this.id,
      sessionId: request.sessionId,
      content: answer ?? `${this.id} answer`,
      ...this.metadata === undefined ? {} : { metadata: this.metadata },
    }
  }
  async *streamMessage(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    this.requests.push(request)
    // A held site has not written anything yet: the column must not block the rest.
    if (this.hold !== undefined) await this.hold
    if (this.chunks !== undefined) {
      for (const chunk of this.chunks) yield chunk
      return
    }
    const answer = this.answers.shift()
    if (answer instanceof Error) throw answer
    // A real site writes the answer in pieces; one delta plus the closing
    // chunk is enough to exercise the comparison's accumulation.
    yield { index: 0, delta: answer ?? `${this.id} answer` }
    yield { index: 0, finishReason: 'stop', ...this.metadata === undefined ? {} : { metadata: this.metadata } }
  }
  async close(): Promise<void> {}
}

/** Registry double: `list()` advertises one id it cannot resolve, and resolvable ids can be withdrawn. */
class GhostRegistry implements IProviderRegistry {
  private readonly inner = new ProviderRegistry()
  private readonly hidden = new Set<string>()

  constructor(providers: readonly IModelProvider[]) {
    for (const provider of providers) this.inner.register(provider)
  }

  /** Stop resolving one registered id, as if the registry entry went stale. */
  hide(providerId: string): void { this.hidden.add(providerId) }

  register(provider: IModelProvider): void { this.inner.register(provider) }
  get(providerId: string): IModelProvider | undefined {
    return this.hidden.has(providerId) ? undefined : this.inner.get(providerId)
  }
  list(): string[] { return [...this.inner.list(), 'ghost-web'] }
  getByKind(kind: ModelKind): IModelProvider[] { return this.inner.getByKind(kind) }
  async health(providerId: string): Promise<ProviderHealth> { return await this.inner.health(providerId) }
  async reauthenticate(providerId: string): Promise<ProviderHealth> { return await this.inner.reauthenticate(providerId) }
}

interface HarnessOptions {
  providers?: readonly TurnProvider[]
  registry?: IProviderRegistry
  pool?: MemoryMediaPool
  compaction?: { maxMessages?: number; minGap?: number }
}

/** Boot the controller over real memory storage with fake turn providers and a fixed clock. */
async function harness(options: HarnessOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const pool = options.pool ?? new MemoryMediaPool()
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  ctx.provide('typert', { lookups: { get: () => undefined } } as never)
  const providers = options.providers ?? [new TurnProvider({ id: 'deepseek-web' }), new TurnProvider({ id: 'gemini-web' })]
  const registry = options.registry ?? new ProviderRegistry()
  if (options.registry === undefined) {
    for (const provider of providers) registry.register(provider)
  }
  const controller = new ChatHubController(ctx, {
    registry,
    ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
    now: () => AT,
  })
  return { ctx, pool, facility, registry, controller, providers }
}

describe('ChatHubController state', () => {
  it('reports ready providers and the empty session list', async () => {
    const { ctx, controller } = await harness()
    try {
      const state = await controller.state()
      expect(state.providers).toEqual([
        { id: 'deepseek-web', name: 'deepseek-web', kind: 'web', capabilities: CAPABILITIES, status: 'ready' },
        { id: 'gemini-web', name: 'gemini-web', kind: 'web', capabilities: CAPABILITIES, status: 'ready' },
      ])
      expect(state.sessions).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('skips stale registry ids and maps expired probes onto needs-auth', async () => {
    const { ctx, controller } = await harness({
      registry: new GhostRegistry([new TurnProvider({ id: 'deepseek-web', health: 'expired' })]),
    })
    try {
      const state = await controller.state()
      expect(state.providers).toEqual([
        { id: 'deepseek-web', name: 'deepseek-web', kind: 'web', capabilities: CAPABILITIES, status: 'needs-auth' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('carries the stable failure code of a failed probe', async () => {
    const { ctx, controller } = await harness({
      providers: [new TurnProvider({ id: 'deepseek-web', health: new Error('probe down'), code: 'provider-unavailable' })],
    })
    try {
      const state = await controller.state()
      expect(state.providers).toEqual([
        {
          id: 'deepseek-web', name: 'deepseek-web', kind: 'web', capabilities: CAPABILITIES,
          status: 'failed', failureReason: 'provider-unavailable',
        },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lists every created session after more than one creation', async () => {
    const { ctx, controller } = await harness()
    try {
      await controller.create({ title: 'First', goal: 'One', provider: 'deepseek-web' })
      await controller.create({ title: 'Second', goal: 'Two', provider: 'deepseek-web' })
      const titles = (await controller.state()).sessions.map(session => session.title)
      expect(titles).toContain('First')
      expect(titles).toContain('Second')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('ChatHubController turns', () => {
  it('creates a session and runs one turn end to end', async () => {
    const { ctx, controller, providers, facility } = await harness()
    try {
      const deepseek = providers[0]!
      const view = await controller.create({ title: 'Draft review', goal: 'Review the draft', provider: 'deepseek-web' })
      expect(view.id).toBe('sess_20261101_001')
      expect(view).toMatchObject({
        title: 'Draft review', status: 'idle', currentProvider: 'deepseek-web', providerHistory: ['deepseek-web'],
      })
      const result = await controller.send(view.id, 'Start the review')
      expect(result).toEqual({
        sessionId: view.id,
        status: 'done',
        assistant: { role: 'assistant', content: 'deepseek-web answer', timestamp: AT, name: 'deepseek-web' },
      })
      expect(result.assistant?.content).toBe('deepseek-web answer')
      expect(deepseek.requests).toHaveLength(1)
      expect(deepseek.requests[0]?.sessionId).toBe(view.id)
      expect((await controller.history(view.id)).map(entry => entry.role)).toEqual(['user', 'assistant'])
      expect((await controller.timeline(view.id)).map(entry => entry.kind)).toEqual(['session-created', 'status', 'status'])
      const domain = facility.get('chathub')
      expect(await domain?.table('provider_state').get('deepseek-web')).toEqual({ lastUsedAt: AT })
      expect(await controller.state()).toMatchObject({
        sessions: [{ id: view.id, title: 'Draft review', status: 'done' }],
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the user message and a stable code when the turn fails', async () => {
    const { ctx, controller, facility } = await harness({
      providers: [new TurnProvider({ id: 'deepseek-web', answers: [new Error('site said no')], code: 'rate-limited' })],
    })
    try {
      const view = await controller.create({ title: 'T', goal: 'G', provider: 'deepseek-web' })
      const result = await controller.send(view.id, 'hello')
      expect(result).toEqual({ sessionId: view.id, status: 'failed', lastError: 'deepseek-web: rate-limited' })
      const history = await controller.history(view.id)
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({ role: 'user', content: 'hello' })
      expect(await controller.read(view.id)).toMatchObject({ status: 'failed', lastError: 'deepseek-web: rate-limited' })
      const domain = facility.get('chathub')
      expect(await domain?.table('provider_state').get('deepseek-web')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports unknown when the adapter has no error mapping', async () => {
    const { ctx, controller } = await harness({
      providers: [new TurnProvider({ id: 'deepseek-web', answers: [new Error('raw site text')] })],
    })
    try {
      const view = await controller.create({ title: 'T', goal: 'G', provider: 'deepseek-web' })
      const result = await controller.send(view.id, 'hello')
      expect(result).toEqual({ sessionId: view.id, status: 'failed', lastError: 'deepseek-web: unknown' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('compacts the transcript through the current model once it grows past the threshold', async () => {
    const checkpoint = [
      '## Primary Request and Intent',
      '- review the draft report',
      '',
      '## Key Facts and Conclusions',
      '- the draft misses a conclusion section',
      '',
      '## Errors and Fixes',
      '- (none)',
      '',
      '## Pending Jobs',
      '- write the conclusion',
      '',
      '## Current Work',
      '- second-pass review',
      '',
      '## Next Step',
      '- draft the conclusion',
      '',
      '## Critical Context',
      '- keep the tone formal',
    ].join('\n')
    const { ctx, controller, providers } = await harness({
      providers: [new TurnProvider({
        id: 'deepseek-web',
        answers: ['first answer', 'second answer', checkpoint, 'third answer'],
      })],
      compaction: { maxMessages: 4, minGap: 2 },
    })
    try {
      const view = await controller.create({ title: 'Review', goal: 'Review the draft', provider: 'deepseek-web' })
      await controller.send(view.id, 'first question')
      await controller.send(view.id, 'second question')
      const result = await controller.send(view.id, 'third question')

      expect(result.status).toBe('done')
      const deepseek = providers[0]!
      expect(deepseek.requests).toHaveLength(4)
      // Third provider call: the compaction turn carries the instruction alone,
      // without the compiled task context.
      const compaction = deepseek.requests[2]!
      expect(compaction.systemPrompt).toBeUndefined()
      expect(compaction.messages).toHaveLength(1)
      expect(compaction.messages[0]).toMatchObject({ role: 'user', content: COMPACTION_INSTRUCTION })
      // Fourth provider call: the real turn runs normally afterwards.
      expect(deepseek.requests[3]!.messages.at(-1)).toMatchObject({ role: 'user', content: 'third question' })
      // The compaction exchange stays out of the panel transcript.
      const history = await controller.history(view.id)
      expect(history).toHaveLength(6)
      expect(history.map(entry => entry.content)).not.toContain(COMPACTION_INSTRUCTION)
      expect((await controller.timeline(view.id)).map(entry => entry.detail)).toContain('compacted at 5 messages')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects turns and creations for untracked sessions and providers', async () => {
    const registry = new GhostRegistry([new TurnProvider({ id: 'deepseek-web' })])
    const { ctx, controller } = await harness({ registry })
    try {
      await expect(controller.send('sess_missing', 'hi')).rejects.toMatchObject({ code: 'session-not-tracked' })
      await expect(controller.create({ title: 'T', goal: 'G', provider: 'ghost-web' }))
        .rejects.toMatchObject({ code: 'provider-not-registered' })
      const view = await controller.create({ title: 'T', goal: 'G', provider: 'deepseek-web' })
      registry.hide(view.currentProvider)
      await expect(controller.send(view.id, 'hi')).rejects.toMatchObject({ code: 'provider-not-registered' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('ChatHubController switches', () => {
  it('switches providers through a checkpoint and leaves the session idle', async () => {
    const { ctx, controller, facility } = await harness()
    try {
      const view = await controller.create({ title: 'T', goal: 'G', provider: 'deepseek-web' })
      await controller.send(view.id, 'first message')
      const outcome = await controller.switch(view.id, 'gemini-web', 'need a second opinion')
      expect(outcome).toEqual({
        sessionId: view.id, from: 'deepseek-web', to: 'gemini-web', checkpointId: 'cp_20261101_001', status: 'idle',
      })
      expect(await controller.read(view.id)).toMatchObject({
        currentProvider: 'gemini-web', providerHistory: ['deepseek-web', 'gemini-web'], status: 'idle',
      })
      const domain = facility.get('chathub')
      expect(await domain?.table('checkpoints').get('cp_20261101_001')).toMatchObject({ sessionId: view.id })
      const switchEntry = (await controller.timeline(view.id)).find(entry => entry.kind === 'provider-switch')
      expect(switchEntry).toMatchObject({ checkpointId: 'cp_20261101_001' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects switches to the active provider and to providers that are not ready', async () => {
    const { ctx, controller } = await harness({
      providers: [
        new TurnProvider({ id: 'deepseek-web' }),
        new TurnProvider({ id: 'gemini-web', health: 'needs-auth' }),
      ],
    })
    try {
      const view = await controller.create({ title: 'T', goal: 'G', provider: 'deepseek-web' })
      await expect(controller.switch(view.id, 'deepseek-web', 'same'))
        .rejects.toMatchObject({ code: 'provider-already-active' })
      await expect(controller.switch(view.id, 'gemini-web', 'not signed in'))
        .rejects.toMatchObject({ code: 'provider-not-ready' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('ChatHubController deletion', () => {
  it('deletes a session with every projection and stops tracking it', async () => {
    const { ctx, controller, facility } = await harness()
    try {
      const view = await controller.create({ title: 'T', goal: 'G', provider: 'deepseek-web' })
      await controller.send(view.id, 'hello')
      await controller.delete(view.id)
      await expect(controller.read(view.id)).rejects.toMatchObject({ code: 'session-not-tracked' })
      await expect(controller.history(view.id)).rejects.toMatchObject({ code: 'session-not-tracked' })
      await expect(controller.timeline(view.id)).rejects.toMatchObject({ code: 'session-not-tracked' })
      expect((await controller.state()).sessions).toEqual([])
      const domain = facility.get('chathub')
      expect(await domain?.table('messages').get(`${view.id}/1`)).toBeUndefined()
      expect(await domain?.table('provider_state').get('deepseek-web')).toEqual({ lastUsedAt: AT })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('ChatHubController recovery', () => {
  it('restores sessions from storage and continues the conversation after a restart', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness({ pool })
    const view = await first.controller.create({ title: 'T', goal: 'G', provider: 'deepseek-web' })
    await first.controller.send(view.id, 'hello')
    await first.ctx.fiber.dispose()
    const second = await harness({ pool })
    try {
      expect(await second.controller.state()).toMatchObject({
        sessions: [{ id: view.id, title: 'T', status: 'done' }],
      })
      expect(await second.controller.history(view.id)).toHaveLength(2)
      const result = await second.controller.send(view.id, 'again')
      expect(result.status).toBe('done')
      expect(result.assistant?.content).toBe('deepseek-web answer')
      expect(await second.controller.history(view.id)).toHaveLength(4)
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('resumes failed sessions with their retained stable error', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness({
      pool,
      providers: [new TurnProvider({ id: 'deepseek-web', answers: [new Error('site said no')], code: 'rate-limited' })],
    })
    const view = await first.controller.create({ title: 'T', goal: 'G', provider: 'deepseek-web' })
    await first.controller.send(view.id, 'hello')
    await first.ctx.fiber.dispose()
    const second = await harness({ pool })
    try {
      const state = await second.controller.resume()
      expect(state.sessions).toEqual([{
        id: view.id, title: 'T', createdAt: AT, updatedAt: AT, currentProvider: 'deepseek-web',
        status: 'failed', lastError: 'deepseek-web: rate-limited',
      }])
      expect(await second.controller.read(view.id)).toMatchObject({ status: 'failed', lastError: 'deepseek-web: rate-limited' })
      await expect(second.controller.resume()).resolves.toEqual(state)
    } finally {
      await second.ctx.fiber.dispose()
    }
  })
})

describe('ChatHubController compare', () => {
  it('answers every requested model side by side', async () => {
    const { ctx, controller, providers } = await harness({
      providers: [
        new TurnProvider({ id: 'deepseek-web', answers: ['deep answer'] }),
        new TurnProvider({ id: 'gemini-web', answers: ['gemini answer'] }),
      ],
    })
    try {
      const result = await controller.compare({ content: 'compare this', providers: ['deepseek-web', 'gemini-web'] })
      expect(result.sides).toEqual([
        { provider: 'deepseek-web', providerName: 'deepseek-web', status: 'done', content: 'deep answer', elapsedMs: 0 },
        { provider: 'gemini-web', providerName: 'gemini-web', status: 'done', content: 'gemini answer', elapsedMs: 0 },
      ])
      // Both columns get the same words, and no system prompt or history.
      expect(providers.map(provider => provider.requests[0]?.messages)).toEqual([
        [{ role: 'user', content: 'compare this' }],
        [{ role: 'user', content: 'compare this' }],
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('carries the site reasoning trace into its own column', async () => {
    // A site that renders a search / thinking trace reports it through response
    // metadata; the compare view shows it next to the answer it explains.
    const { ctx, controller } = await harness({
      providers: [
        new TurnProvider({ id: 'doubao-web', answers: ['answer'], metadata: { reasoning: '搜索了 2 个关键词，参考 9 篇资料' } }),
        new TurnProvider({ id: 'qianwen-web', answers: ['plain answer'] }),
      ],
    })
    try {
      const result = await controller.compare({ content: 'x', providers: ['doubao-web', 'qianwen-web'] })
      expect(result.sides[0]?.reasoning).toBe('搜索了 2 个关键词，参考 9 篇资料')
      // A site without a trace keeps the column free of an empty expander.
      expect(result.sides[1]).not.toHaveProperty('reasoning')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('collapses a repeated model and stops at four columns', async () => {
    const providers = ['a-web', 'b-web', 'c-web', 'd-web', 'e-web'].map(id => new TurnProvider({ id }))
    const { ctx, controller } = await harness({ providers })
    try {
      const result = await controller.compare({ content: 'x', providers: ['a-web', 'a-web', 'b-web', 'c-web', 'd-web', 'e-web'] })
      expect(result.sides.map(side => side.provider)).toEqual(['a-web', 'b-web', 'c-web', 'd-web'])
      // The fifth site is never touched: the ceiling is a fan-out limit, not a queue.
      expect(providers[4]?.requests).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('returns no columns for an empty request', async () => {
    const { ctx, controller } = await harness()
    try {
      await expect(controller.compare({ content: 'x', providers: [] })).resolves.toEqual({ sides: [] })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports an unknown model in its own column and still answers the rest', async () => {
    const { ctx, controller } = await harness({ providers: [new TurnProvider({ id: 'deepseek-web' })] })
    try {
      const result = await controller.compare({ content: 'x', providers: ['deepseek-web', 'typo-web'] })
      expect(result.sides[0]).toMatchObject({ provider: 'deepseek-web', status: 'done' })
      // A typo costs its own column only; the good answer still comes back.
      expect(result.sides[1]).toEqual({
        provider: 'typo-web',
        providerName: 'typo-web',
        status: 'failed',
        lastError: 'chathub-driver-missing',
        elapsedMs: 0,
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('isolates a failing model from the answer that arrived', async () => {
    const failing = new TurnProvider({ id: 'gemini-web', answers: [new Error('site said no')], code: 'rate-limited' })
    const { ctx, controller } = await harness({
      providers: [new TurnProvider({ id: 'deepseek-web', answers: ['fine'] }), failing],
    })
    try {
      const result = await controller.compare({ content: 'x', providers: ['deepseek-web', 'gemini-web'] })
      expect(result.sides.map(side => side.status)).toEqual(['done', 'failed'])
      expect(result.sides[0]?.content).toBe('fine')
      // The column carries the adapter's stable code, not its message.
      expect(result.sides[1]?.lastError).toBe('rate-limited')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a code the adapter cannot normalize', async () => {
    const { ctx, controller } = await harness({
      providers: [new TurnProvider({ id: 'deepseek-web', answers: [new Error('boom')] })],
    })
    try {
      const result = await controller.compare({ content: 'x', providers: ['deepseek-web'] })
      expect(result.sides[0]).toMatchObject({ status: 'failed', lastError: 'unknown' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('opens a site that was never started before asking it', async () => {
    const cold = new TurnProvider({ id: 'deepseek-web', answers: ['warm answer'] })
    cold.ready = false
    const { ctx, controller } = await harness({ providers: [cold] })
    try {
      // A comparison often runs before any session opened the site.
      const result = await controller.compare({ content: 'x', providers: ['deepseek-web'] })
      expect(result.sides[0]?.content).toBe('warm answer')
      expect(cold.initCount).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves an already-open site alone', async () => {
    const { ctx, controller, providers } = await harness({ providers: [new TurnProvider({ id: 'deepseek-web' })] })
    try {
      await controller.compare({ content: 'x', providers: ['deepseek-web'] })
      expect(providers[0]?.initCount).toBe(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('forwards the shared attachments to every model', async () => {
    const files = [{ name: 'shot.png', mimeType: 'image/png', data: 'cG5n' }]
    const { ctx, controller, providers } = await harness()
    try {
      await controller.compare({ content: 'x', providers: ['deepseek-web', 'gemini-web'], attachments: files })
      // One pick, every column: each site uploads the same bytes itself.
      expect(providers.map(provider => provider.requests[0]?.attachments)).toEqual([files, files])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('persists nothing: a comparison is a scratch question', async () => {
    const { ctx, controller } = await harness()
    try {
      await controller.compare({ content: 'x', providers: ['deepseek-web', 'gemini-web'] })
      // No session, no checkpoint, no timeline entry: the panel's list stays empty.
      expect((await controller.state()).sessions).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('ChatHubController compareStream', () => {
  /** Collect every event of one stream, so assertions read in order. */
  async function drain(stream: AsyncIterable<ChatHubCompareEvent>): Promise<ChatHubCompareEvent[]> {
    const events: ChatHubCompareEvent[] = []
    for await (const event of stream) events.push(event)
    return events
  }

  it('emits the answer as the site grows it, then one settled column', async () => {
    const { ctx, controller } = await harness({
      providers: [new TurnProvider({
        id: 'deepseek-web',
        chunks: [
          { index: 0, delta: 'A gro' },
          // The same markup, longer: a growth suffix replaces the snapshot.
          { index: 0, delta: 'A growing' },
          // Unrelated text rebuilds the answer: it is appended.
          { index: 0, delta: 'B side' },
        ],
      })],
    })
    try {
      const events = await drain(controller.compareStream({ content: 'x', providers: ['deepseek-web'] }))
      expect(events).toEqual([
        { kind: 'progress', provider: 'deepseek-web', content: 'A gro' },
        { kind: 'progress', provider: 'deepseek-web', content: 'A growing' },
        { kind: 'progress', provider: 'deepseek-web', content: 'A growingB side' },
        {
          kind: 'settled',
          side: {
            provider: 'deepseek-web',
            providerName: 'deepseek-web',
            status: 'done',
            content: 'A growingB side',
            elapsedMs: 0,
          },
        },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('settles a finished column without waiting for a site that is still writing', async () => {
    let release: () => void = () => {}
    const hold = new Promise<void>((resolve) => { release = resolve })
    const { ctx, controller } = await harness({
      providers: [
        new TurnProvider({ id: 'deepseek-web', answers: ['fast answer'] }),
        new TurnProvider({ id: 'qwen-web', answers: ['slow answer'], hold }),
      ],
    })
    try {
      const events: ChatHubCompareEvent[] = []
      const consuming = (async (): Promise<void> => {
        for await (const event of controller.compareStream({ content: 'x', providers: ['deepseek-web', 'qwen-web'] })) {
          events.push(event)
        }
      })()
      // Let the fast site finish while the slow one is still silent.
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(events).toContainEqual({
        kind: 'settled',
        side: expect.objectContaining({ provider: 'deepseek-web', content: 'fast answer' }),
      })
      expect(events.some(event => event.kind === 'progress' && event.provider === 'qwen-web')).toBe(false)
      expect(events.some(event => event.kind === 'settled' && event.side.provider === 'qwen-web')).toBe(false)
      release()
      await consuming
      expect(events.at(-1)).toMatchObject({ kind: 'settled', side: { provider: 'qwen-web', content: 'slow answer' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('carries the closing chunk reasoning into the settled column', async () => {
    const { ctx, controller } = await harness({
      providers: [new TurnProvider({
        id: 'doubao-web',
        chunks: [
          { index: 0, delta: 'answer' },
          { index: 0, finishReason: 'stop', metadata: { reasoning: '找到 3 篇资料' } },
        ],
      })],
    })
    try {
      const events = await drain(controller.compareStream({ content: 'x', providers: ['doubao-web'] }))
      expect(events.at(-1)).toMatchObject({
        kind: 'settled',
        side: { provider: 'doubao-web', status: 'done', content: 'answer', reasoning: '找到 3 篇资料' },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('yields nothing for an already-cancelled comparison', async () => {
    const { ctx, controller, providers } = await harness({ providers: [new TurnProvider({ id: 'deepseek-web' })] })
    try {
      const cancellation = new AbortController()
      cancellation.abort()
      const events = await drain(controller.compareStream({ content: 'x', providers: ['deepseek-web'] }, cancellation.signal))
      expect(events).toEqual([])
      // No site turn started for a stream nobody is reading.
      expect(providers[0]?.requests).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
