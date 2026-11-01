/** The chatHub Remote controller: lifecycle, persistence, stable failure codes, and restart recovery. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import {
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

  constructor(options: {
    id: string
    name?: string
    answers?: readonly (string | Error)[]
    code?: ProviderErrorCode
    health?: ProviderStatus | Error
  }) {
    this.id = options.id
    this.name = options.name ?? options.id
    this.answers = [...(options.answers ?? [])]
    if (options.code !== undefined) {
      const code = options.code
      this.normalizeError = () => code
    }
    if (options.health !== undefined) {
      const health = options.health
      this.healthStatus = typeof health === 'string' ? (async () => health) : (async () => { throw health })
    }
  }

  async init(): Promise<void> {}
  async isReady(): Promise<boolean> { return true }
  async sendMessage(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request)
    const answer = this.answers.shift()
    if (answer instanceof Error) throw answer
    return { providerId: this.id, sessionId: request.sessionId, content: answer ?? `${this.id} answer` }
  }
  async *streamMessage(): AsyncIterable<ChatStreamChunk> {}
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
  const controller = new ChatHubController(ctx, { registry, now: () => AT })
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
        assistant: { role: 'assistant', content: 'deepseek-web answer', timestamp: AT },
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
