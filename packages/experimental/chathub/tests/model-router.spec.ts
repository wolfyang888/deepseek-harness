/** Task-aware routing and fallback execution. */

import { describe, expect, it } from 'vitest'
import { ChatHubError, ModelRouter, ProviderRegistry } from '@deepseek-ai/dsh-experimental-chathub'
import type {
  IProviderRegistry,
  ModelRouterOptions,
  RetryPolicy,
} from '@deepseek-ai/dsh-experimental-chathub'
import { FakeProvider, fakeProvider, semanticContext, sessionRecord, userMessage } from './fixtures.ts'

const TASK_CONTEXT = semanticContext({ objective: 'fix the build error', facts: ['uses pnpm'] })

function registryWithDeepSeekGeminiChatGpt(): ProviderRegistry {
  const registry = new ProviderRegistry()
  registry.register(fakeProvider({
    id: 'deepseek-web',
    capabilities: { reasoning: true, coding: true },
  }))
  registry.register(fakeProvider({ id: 'gemini-web', capabilities: { webAccess: true } }))
  registry.register(fakeProvider({ id: 'chatgpt-web' }))
  return registry
}

function router(options: Partial<ModelRouterOptions> = {}): ModelRouter {
  const { registry = registryWithDeepSeekGeminiChatGpt(), ...rest } = options
  return new ModelRouter({ registry, ...rest })
}

describe('ModelRouter.route', () => {
  it('routes coding to a coding-capable provider', async () => {
    const result = await router().route({ session: sessionRecord({ currentProvider: 'chatgpt-web' }), taskType: 'coding' })
    expect(result.provider.id).toBe('deepseek-web')
    expect(result.reason).toBe('capability.coding')
    expect(result.usedFallback).toBe(false)
  })

  it('routes research to a web-capable provider', async () => {
    const result = await router().route({ session: sessionRecord({ currentProvider: 'chatgpt-web' }), taskType: 'research' })
    expect(result.provider.id).toBe('gemini-web')
    expect(result.reason).toBe('capability.research')
  })

  it('keeps the current provider for quick answers', async () => {
    const result = await router().route({ session: sessionRecord({ currentProvider: 'chatgpt-web' }), taskType: 'quick-answer' })
    expect(result.provider.id).toBe('chatgpt-web')
    expect(result.reason).toBe('session.currentProvider')
  })

  it('honors configured routing and per-turn preferences before capabilities', async () => {
    const configured = await router({ routing: { coding: 'gemini-web' } })
      .route({ session: sessionRecord({ currentProvider: 'chatgpt-web' }), taskType: 'coding' })
    expect(configured.provider.id).toBe('gemini-web')
    expect(configured.reason).toBe('routing.coding')

    const preferred = await router().route({
      session: sessionRecord({ currentProvider: 'chatgpt-web' }),
      taskType: 'quick-answer',
      preferredProvider: 'gemini-web',
    })
    expect(preferred.provider.id).toBe('gemini-web')
    expect(preferred.reason).toBe('request.preferredProvider')
  })

  it('skips missing configured providers and unavailable candidates', async () => {
    const missing = await router({ routing: { coding: 'missing-provider' } })
      .route({ session: sessionRecord({ currentProvider: 'chatgpt-web' }), taskType: 'coding' })
    expect(missing.provider.id).toBe('deepseek-web')

    const registry = new ProviderRegistry()
    registry.register(fakeProvider({ id: 'deepseek-web', capabilities: { coding: true }, ready: new Error('offline') }))
    registry.register(fakeProvider({ id: 'doubao-web', capabilities: { coding: true } }))
    const result = await router({ registry }).route({
      session: sessionRecord({ currentProvider: 'deepseek-web' }),
      taskType: 'coding',
    })
    expect(result.provider.id).toBe('doubao-web')
  })

  it('marks a fallback provider when the current provider is unavailable', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({ id: 'chatgpt-web', ready: false }))
    registry.register(fakeProvider({ id: 'deepseek-web' }))
    const result = await router({ registry }).route({
      session: sessionRecord({ currentProvider: 'chatgpt-web' }),
      taskType: 'quick-answer',
    })
    expect(result.provider.id).toBe('deepseek-web')
    expect(result.reason).toBe('registry')
    expect(result.usedFallback).toBe(true)
  })

  it('reaches configured fallbacks in order', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({ id: 'chatgpt-web', ready: false }))
    registry.register(fakeProvider({ id: 'gemini-web', ready: false }))
    registry.register(fakeProvider({ id: 'deepseek-web' }))
    const result = await router({ registry, fallbackProviders: ['gemini-web', 'deepseek-web'] }).route({
      session: sessionRecord({ currentProvider: 'chatgpt-web' }),
      taskType: 'quick-answer',
    })
    expect(result.provider.id).toBe('deepseek-web')
    expect(result.reason).toBe('fallbackProviders')
  })

  it('fails loud when no provider is ready', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({ id: 'chatgpt-web', ready: false }))
    await expect(router({ registry }).route({
      session: sessionRecord({ currentProvider: 'chatgpt-web' }),
      taskType: 'quick-answer',
    })).rejects.toMatchObject({ code: 'no-ready-provider' })
  })

  it('ignores listed ids that resolve to no provider', async () => {
    const registry: IProviderRegistry = {
      register: () => {},
      get: () => undefined,
      list: () => ['ghost'],
      getByKind: () => [],
      health: async () => ({ providerId: 'ghost', ready: false, status: 'failed', lastCheckedAt: 0 }),
      reauthenticate: async () => ({ providerId: 'ghost', ready: false, status: 'failed', lastCheckedAt: 0 }),
    }
    await expect(router({ registry }).route({ session: sessionRecord(), taskType: 'coding' }))
      .rejects.toMatchObject({ code: 'no-ready-provider' })
  })
})

describe('ModelRouter.complete', () => {
  it('sends the turn with compiled context and optional prompt fields', async () => {
    const registry = registryWithDeepSeekGeminiChatGpt()
    const chatgpt = registry.get('chatgpt-web') as FakeProvider
    const result = await router({ registry }).complete({
      session: sessionRecord({ currentProvider: 'chatgpt-web' }),
      taskType: 'quick-answer',
      messages: [userMessage('fix the build')],
      taskContext: TASK_CONTEXT,
      systemPrompt: 'continue the task',
      metadata: { taskType: 'debug' },
    })

    expect(result.provider.id).toBe('chatgpt-web')
    expect(result.response.content).toBe('chatgpt-web answer')
    expect(result.usedFallback).toBe(false)
    expect(result.attempts).toEqual([])
    expect(chatgpt?.calls[0]).toEqual({
      sessionId: 'sess_20261031_001',
      providerId: 'chatgpt-web',
      messages: [userMessage('fix the build')],
      systemPrompt: 'continue the task',
      taskContext: TASK_CONTEXT,
      metadata: { taskType: 'debug' },
    })
  })

  it('omits absent optional request fields', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({ id: 'chatgpt-web' }))
    await router({ registry }).complete({
      session: sessionRecord({ currentProvider: 'chatgpt-web' }),
      taskType: 'quick-answer',
      messages: [userMessage('hello')],
      taskContext: semanticContext(),
    })

    const request = (registry.get('chatgpt-web') as FakeProvider).calls[0]
    expect(request).not.toHaveProperty('systemPrompt')
    expect(request).not.toHaveProperty('metadata')
  })

  it('skips a configured provider that is not registered', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({ id: 'deepseek-web' }))
    const result = await router({ registry, routing: { 'quick-answer': 'missing-provider' } }).complete({
      session: sessionRecord({ currentProvider: 'missing-provider' }),
      taskType: 'quick-answer',
      messages: [userMessage('continue')],
      taskContext: TASK_CONTEXT,
    })
    expect(result.provider.id).toBe('deepseek-web')
  })

  it('falls back to the next ready provider when a call fails', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({ id: 'chatgpt-web', response: new Error('session expired') }))
    registry.register(fakeProvider({ id: 'deepseek-web' }))
    const result = await router({ registry }).complete({
      session: sessionRecord({ currentProvider: 'chatgpt-web' }),
      taskType: 'quick-answer',
      messages: [userMessage('continue')],
      taskContext: TASK_CONTEXT,
    })

    expect(result.provider.id).toBe('deepseek-web')
    expect(result.usedFallback).toBe(true)
    expect(result.attempts).toEqual([{ providerId: 'chatgpt-web', attempt: 1, error: 'session expired' }])
  })

  it('reports every failed provider when all ready calls fail', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({ id: 'chatgpt-web', response: new Error('expired') }))
    registry.register(fakeProvider({ id: 'deepseek-web', response: new Error('offline') }))
    const complete = router({ registry }).complete({
      session: sessionRecord({ currentProvider: 'chatgpt-web' }),
      taskType: 'quick-answer',
      messages: [userMessage('continue')],
      taskContext: TASK_CONTEXT,
    })

    await expect(complete).rejects.toMatchObject({ code: 'provider-call-failed' })
    await expect(complete).rejects.toThrow(
      'Every ready provider failed: chatgpt-web: expired; deepseek-web: offline.',
    )
  })

  it('reports no ready provider before attempting a call', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({ id: 'chatgpt-web', ready: false }))
    await expect(router({ registry }).complete({
      session: sessionRecord({ currentProvider: 'chatgpt-web' }),
      taskType: 'quick-answer',
      messages: [userMessage('continue')],
      taskContext: TASK_CONTEXT,
    })).rejects.toMatchObject({ code: 'no-ready-provider' })
  })
})

describe('ModelRouter retry policy', () => {
  const NETWORK_RESET = (): ChatHubError => new ChatHubError('network-error', 'connection reset')

  function retryRouter(registry: ProviderRegistry, retry: RetryPolicy): ModelRouter {
    return router({ registry, retry })
  }

  it('retries a retryable failure on the same provider before returning', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({
      id: 'chatgpt-web',
      responses: [NETWORK_RESET(), NETWORK_RESET()],
      response: 'answered after retries',
    }))
    const result = await retryRouter(registry, {
      maxAttempts: 3,
      delayMs: 0,
      retryOn: ['network-error'],
    }).complete({
      session: sessionRecord({ currentProvider: 'chatgpt-web' }),
      taskType: 'quick-answer',
      messages: [userMessage('continue')],
      taskContext: TASK_CONTEXT,
    })

    expect(result.provider.id).toBe('chatgpt-web')
    expect(result.response.content).toBe('answered after retries')
    expect(result.usedFallback).toBe(false)
    expect(result.attempts).toEqual([
      { providerId: 'chatgpt-web', attempt: 1, error: 'connection reset' },
      { providerId: 'chatgpt-web', attempt: 2, error: 'connection reset' },
    ])
  })

  it('classifies a wrapped provider failure through the provider normalizer', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({
      id: 'chatgpt-web',
      responses: [
        new ChatHubError('provider-call-failed', 'site busy', { cause: new Error('server busy') }),
      ],
      response: 'answered after retry',
      normalizeError: 'provider-unavailable',
    }))
    const result = await retryRouter(registry, {
      maxAttempts: 2,
      delayMs: 0,
      retryOn: ['provider-unavailable'],
    }).complete({
      session: sessionRecord({ currentProvider: 'chatgpt-web' }),
      taskType: 'quick-answer',
      messages: [userMessage('continue')],
      taskContext: TASK_CONTEXT,
    })

    expect(result.provider.id).toBe('chatgpt-web')
    expect(result.response.content).toBe('answered after retry')
    expect(result.usedFallback).toBe(false)
    expect(result.attempts).toEqual([
      { providerId: 'chatgpt-web', attempt: 1, error: 'site busy' },
    ])
  })

  it('classifies a raw provider rejection through the provider normalizer', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({
      id: 'chatgpt-web',
      responses: [new Error('server busy')],
      response: 'answered after retry',
      normalizeError: 'provider-unavailable',
    }))
    const result = await retryRouter(registry, {
      maxAttempts: 2,
      delayMs: 0,
      retryOn: ['provider-unavailable'],
    }).complete({
      session: sessionRecord({ currentProvider: 'chatgpt-web' }),
      taskType: 'quick-answer',
      messages: [userMessage('continue')],
      taskContext: TASK_CONTEXT,
    })

    expect(result.provider.id).toBe('chatgpt-web')
    expect(result.response.content).toBe('answered after retry')
    expect(result.usedFallback).toBe(false)
  })

  it('falls back without retrying when the failure code is not retryable', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({
      id: 'chatgpt-web',
      responses: [new ChatHubError('provider-call-failed', 'site is down')],
      response: 'never used',
    }))
    registry.register(fakeProvider({ id: 'deepseek-web' }))
    const result = await retryRouter(registry, {
      maxAttempts: 2,
      delayMs: 0,
      retryOn: ['network-error'],
    }).complete({
      session: sessionRecord({ currentProvider: 'chatgpt-web' }),
      taskType: 'quick-answer',
      messages: [userMessage('continue')],
      taskContext: TASK_CONTEXT,
    })

    expect(result.provider.id).toBe('deepseek-web')
    expect(result.usedFallback).toBe(true)
    expect(result.attempts).toEqual([
      { providerId: 'chatgpt-web', attempt: 1, error: 'site is down' },
    ])
  })

  it('falls back after exhausting the retry budget', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({
      id: 'chatgpt-web',
      responses: [NETWORK_RESET(), NETWORK_RESET()],
    }))
    registry.register(fakeProvider({ id: 'deepseek-web' }))
    const result = await retryRouter(registry, {
      maxAttempts: 2,
      delayMs: 0,
      retryOn: ['network-error'],
    }).complete({
      session: sessionRecord({ currentProvider: 'chatgpt-web' }),
      taskType: 'quick-answer',
      messages: [userMessage('continue')],
      taskContext: TASK_CONTEXT,
    })

    expect(result.provider.id).toBe('deepseek-web')
    expect(result.attempts.map(attempt => attempt.attempt)).toEqual([1, 2])
  })

  it('rejects an invalid retry policy at construction', () => {
    const registry = new ProviderRegistry()
    expect(() => retryRouter(registry, { maxAttempts: 0, delayMs: 0, retryOn: [] }))
      .toThrow(expect.objectContaining({ code: 'invalid-retry-policy' }))
    expect(() => retryRouter(registry, { maxAttempts: 2, delayMs: -1, retryOn: [] }))
      .toThrow(expect.objectContaining({ code: 'invalid-retry-policy' }))
  })
})
