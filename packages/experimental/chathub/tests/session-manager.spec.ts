/** Session creation, model switching, request preparation, and runtime state. */

import { describe, expect, it } from 'vitest'
import {
  CheckpointService,
  ContextCompiler,
  ProviderRegistry,
  SessionManager,
  SessionTimelineService,
} from '@deepseek-ai/dsh-experimental-chathub'
import type { SessionManagerOptions } from '@deepseek-ai/dsh-experimental-chathub'
import { FakeProvider, fakeProvider, planStep, userMessage } from './fixtures.ts'

const AT = Date.UTC(2026, 9, 31, 10)

function setup(options: Partial<SessionManagerOptions> = {}) {
  const registry = new ProviderRegistry()
  if (options.registry === undefined) {
    registry.register(fakeProvider({ id: 'deepseek-web', capabilities: { reasoning: true, coding: true } }))
    registry.register(fakeProvider({ id: 'gemini-web', capabilities: { webAccess: true } }))
  }
  const { registry: injected, ...rest } = options
  const manager = new SessionManager({
    registry: injected ?? registry,
    compiler: new ContextCompiler({ details: { 'gemini-web': 'compact' } }),
    checkpoints: new CheckpointService(),
    timeline: new SessionTimelineService({ now: () => AT }),
    now: () => AT,
    ...rest,
  })
  return { manager, registry: injected ?? registry }
}

describe('SessionManager.create', () => {
  it('builds an idle session with a copied plan', () => {
    const { manager } = setup()
    const plan = [planStep({ evidence: ['build.log'] })]
    const session = manager.create({
      id: 'sess_20261031_001',
      title: 'Fix the build',
      goal: 'fix the build error',
      provider: 'deepseek-web',
      plan,
    })

    plan[0]!.evidence.push('mutated')
    expect(session.id).toBe('sess_20261031_001')
    expect(session.createdAt).toBe(AT)
    expect(session.updatedAt).toBe(AT)
    expect(session.providerHistory).toEqual(['deepseek-web'])
    expect(session.plan[0]!.evidence).toEqual(['build.log'])
    expect(session.context).toMatchObject({
      objective: 'fix the build error',
      plan: [planStep({ evidence: ['build.log'] })],
      facts: [],
      openQuestions: [],
    })
    expect(manager.getState(session.id)).toEqual({
      sessionId: 'sess_20261031_001',
      currentProvider: 'deepseek-web',
      activeGoal: 'fix the build error',
      status: 'idle',
    })
  })

  it('generates date-stamped ids and creates a session without a plan', () => {
    const { manager } = setup()
    const first = manager.create({ title: 'First', goal: 'goal one', provider: 'deepseek-web' })
    const second = manager.create({ title: 'Second', goal: 'goal two', provider: 'gemini-web' })

    expect(first.id).toBe('sess_20261031_001')
    expect(second.id).toBe('sess_20261031_002')
    expect(first.plan).toEqual([])
  })

  it('defaults createdAt to the wall clock', () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({ id: 'deepseek-web' }))
    const manager = new SessionManager({
      registry,
      compiler: new ContextCompiler(),
      checkpoints: new CheckpointService(),
      timeline: new SessionTimelineService(),
    })
    const before = Date.now()
    const session = manager.create({ title: 'Fix', goal: 'goal', provider: 'deepseek-web' })
    expect(session.createdAt).toBeGreaterThanOrEqual(before)
  })

  it('rejects an unregistered provider', () => {
    const { manager } = setup()
    expect(() => manager.create({
      title: 'Broken',
      goal: 'goal',
      provider: 'missing-provider',
    })).toThrow(expect.objectContaining({ code: 'provider-not-registered' }))
  })
})

describe('SessionManager.buildRequest', () => {
  it('carries the compiled context and its rendered prompt', () => {
    const { manager } = setup()
    const session = manager.create({
      title: 'Fix the build',
      goal: 'fix the build error',
      provider: 'deepseek-web',
      plan: [planStep()],
    })

    const request = manager.buildRequest(session, {
      messages: [userMessage('continue')],
      metadata: { taskType: 'debug' },
    })

    expect(request.sessionId).toBe(session.id)
    expect(request.providerId).toBe('deepseek-web')
    expect(request.messages).toEqual([userMessage('continue')])
    expect(request.metadata).toEqual({ taskType: 'debug' })
    expect(request.taskContext?.objective).toBe('fix the build error')
    expect(request.systemPrompt?.startsWith('# Task context for deepseek-web')).toBe(true)
  })

  it('omits absent metadata', () => {
    const { manager } = setup()
    const session = manager.create({ title: 'Fix', goal: 'goal', provider: 'deepseek-web' })
    const request = manager.buildRequest(session, { messages: [userMessage('continue')] })
    expect(request).not.toHaveProperty('metadata')
  })

  it('rejects a session whose provider was removed', () => {
    const registry = new ProviderRegistry()
    const dispose = registry.register(fakeProvider({ id: 'deepseek-web' }))
    const { manager } = setup({ registry })
    const session = manager.create({ title: 'Fix', goal: 'goal', provider: 'deepseek-web' })
    dispose()

    expect(() => manager.buildRequest(session, { messages: [userMessage('continue')] }))
      .toThrow(expect.objectContaining({ code: 'provider-not-registered' }))
  })
})

describe('SessionManager.switchProvider', () => {
  it('writes a checkpoint before handing the task to the target provider', async () => {
    const { manager, registry } = setup()
    const session = manager.create({
      title: 'Fix the build',
      goal: 'fix the build error',
      provider: 'deepseek-web',
      plan: [
        planStep({ id: 'p1', status: 'done', summary: 'root cause found', evidence: ['build.log'] }),
        planStep({ id: 'p2', status: 'running', summary: 'patching' }),
      ],
    })
    session.memory.push({
      id: 'mem_1',
      type: 'fact',
      content: 'project uses pnpm',
      source: 'tool',
      importance: 5,
      createdAt: 1,
    })
    session.context.modelSwitchHistory.push({
      from: 'chatgpt-web',
      to: 'deepseek-web',
      timestamp: 1,
      checkpointId: 'cp_1',
      reason: 'coding',
    })

    const outcome = await manager.switchProvider(session, 'gemini-web', 'need long-context review')

    expect(outcome.checkpoint).toMatchObject({
      provider: 'deepseek-web',
      objective: 'fix the build error',
      facts: ['project uses pnpm'],
      openQuestions: [],
      modelSwitchReason: 'need long-context review',
    })
    expect(outcome.record).toMatchObject({
      from: 'deepseek-web',
      to: 'gemini-web',
      checkpointId: outcome.checkpoint.id,
      reason: 'need long-context review',
    })
    expect(outcome.context.modelSwitchHistory).toHaveLength(2)
    expect(outcome.prompt.startsWith('# Task context for gemini-web')).toBe(true)
    expect(outcome.prompt).toContain('## Latest Facts')
    expect(session.currentProvider).toBe('gemini-web')
    expect(session.providerHistory).toEqual(['deepseek-web', 'gemini-web'])
    expect(session.checkpoints).toEqual([outcome.checkpoint])
    expect(session.updatedAt).toBe(AT)
    expect((registry.get('gemini-web') as FakeProvider).calls).toEqual([])
    expect(manager.getState(session.id)).toEqual({
      sessionId: session.id,
      currentProvider: 'gemini-web',
      activeGoal: 'fix the build error',
      status: 'thinking',
      latestCheckpointId: outcome.checkpoint.id,
    })
  })

  it('rejects switching to the active provider', async () => {
    const { manager } = setup()
    const session = manager.create({ title: 'Fix', goal: 'goal', provider: 'deepseek-web' })
    await expect(manager.switchProvider(session, 'deepseek-web', 'same model'))
      .rejects.toMatchObject({ code: 'provider-already-active' })
  })

  it('rejects an unregistered target provider', async () => {
    const { manager } = setup()
    const session = manager.create({ title: 'Fix', goal: 'goal', provider: 'deepseek-web' })
    await expect(manager.switchProvider(session, 'missing-provider', 'switch'))
      .rejects.toMatchObject({ code: 'provider-not-registered' })
  })

  it('rejects an unready target provider', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({ id: 'deepseek-web' }))
    registry.register(fakeProvider({ id: 'gemini-web', ready: false }))
    const { manager } = setup({ registry })
    const session = manager.create({ title: 'Fix', goal: 'goal', provider: 'deepseek-web' })

    await expect(manager.switchProvider(session, 'gemini-web', 'switch'))
      .rejects.toMatchObject({ code: 'provider-not-ready' })
  })

  it('reports a failed readiness probe in the refusal', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({ id: 'deepseek-web' }))
    registry.register(fakeProvider({ id: 'gemini-web', ready: new Error('session expired') }))
    const { manager } = setup({ registry })
    const session = manager.create({ title: 'Fix', goal: 'goal', provider: 'deepseek-web' })

    await expect(manager.switchProvider(session, 'gemini-web', 'switch'))
      .rejects.toThrow('ChatHub provider "gemini-web" is not ready: session expired.')
  })
})

describe('SessionManager runtime state', () => {
  it('updates tracked sessions and retains the last error', () => {
    const { manager } = setup()
    const session = manager.create({ title: 'Fix', goal: 'goal', provider: 'deepseek-web' })

    const running = manager.setStatus(session.id, 'tool-running')
    expect(running.status).toBe('tool-running')

    const failed = manager.setStatus(session.id, 'waiting', 'provider failed')
    expect(failed.lastError).toBe('provider failed')
    expect(manager.getState(session.id)).toEqual(failed)
    expect(manager.getState('sess_unknown')).toBeUndefined()
  })

  it('rejects status updates for untracked sessions', () => {
    const { manager } = setup()
    expect(() => manager.setStatus('sess_unknown', 'done'))
      .toThrow(expect.objectContaining({ code: 'session-not-tracked' }))
  })
})

describe('SessionManager timeline', () => {
  it('records creation, status changes, and checkpoint-backed switches in order', async () => {
    const { manager } = setup()
    const session = manager.create({ title: 'Fix', goal: 'goal', provider: 'deepseek-web' })
    manager.setStatus(session.id, 'tool-running')
    const outcome = await manager.switchProvider(session, 'gemini-web', 'tool stalled')

    expect(session.timeline.map(entry => entry.kind)).toEqual([
      'session-created',
      'status',
      'provider-switch',
    ])
    expect(session.timeline.map(entry => entry.id)).toEqual([
      'tl_20261031_001',
      'tl_20261031_002',
      'tl_20261031_003',
    ])
    expect(session.timeline[1]).toMatchObject({ provider: 'deepseek-web', detail: 'tool-running', at: AT })
    expect(session.timeline[2]).toMatchObject({
      provider: 'gemini-web',
      detail: 'deepseek-web -> gemini-web: tool stalled',
      checkpointId: outcome.checkpoint.id,
      at: AT,
    })
  })
})

describe('Model switch integration', () => {
  it('preserves the objective, plan, and facts across DeepSeek to Gemini (IT-01)', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({ id: 'deepseek-web', capabilities: { coding: true } }))
    registry.register(fakeProvider({ id: 'gemini-web', capabilities: { webAccess: true } }))
    const compiler = new ContextCompiler({ details: { 'gemini-web': 'compact' } })
    const manager = new SessionManager({
      registry,
      compiler,
      checkpoints: new CheckpointService(),
      timeline: new SessionTimelineService({ now: () => AT }),
      now: () => AT,
    })

    const session = manager.create({
      title: 'Fix repository build',
      goal: 'fix the repository build',
      provider: 'deepseek-web',
      plan: [
        planStep({ id: 'p1', title: 'locate error', status: 'done', summary: 'config path bug', evidence: ['build.log'] }),
        planStep({ id: 'p2', title: 'patch config', status: 'running', summary: 'editing tsconfig' }),
      ],
    })
    session.memory.push({
      id: 'mem_1',
      type: 'fact',
      content: 'the project uses pnpm',
      source: 'tool',
      importance: 5,
      createdAt: 1,
    })
    session.context.facts.push('the failure is in the build stage')
    session.context.openQuestions.push('is there a second failure point?')

    const outcome = await manager.switchProvider(session, 'gemini-web', 'need long-context review')

    expect(session.title).toBe('Fix repository build')
    expect(session.goal).toBe('fix the repository build')
    expect(outcome.checkpoint.objective).toBe('fix the repository build')
    expect(outcome.checkpoint.plan.map(step => step.id)).toEqual(['p1', 'p2'])
    expect(outcome.checkpoint.facts).toEqual(['the project uses pnpm', 'the failure is in the build stage'])
    expect(outcome.context.objective).toBe('fix the repository build')
    expect(outcome.context.plan.map(step => step.status)).toEqual(['done', 'running'])
    expect(outcome.context.facts).toEqual(['the project uses pnpm', 'the failure is in the build stage'])
    expect(outcome.context.openQuestions).toEqual(['is there a second failure point?'])
    expect(outcome.prompt).toContain('## Objective\nfix the repository build')
    expect(outcome.prompt).toContain('## Plan')
    expect(outcome.prompt).toContain(
      '## Latest Facts\n- the project uses pnpm\n- the failure is in the build stage',
    )
    expect(manager.buildRequest(session, { messages: [userMessage('continue')] }).taskContext?.facts)
      .toEqual(['the project uses pnpm', 'the failure is in the build stage'])
  })

  it('keeps full provider history and distinct prompts across DeepSeek, Doubao, and ChatGPT (IT-02)', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({ id: 'deepseek-web', capabilities: { coding: true } }))
    registry.register(fakeProvider({ id: 'doubao-web', capabilities: { webAccess: true } }))
    registry.register(fakeProvider({ id: 'chatgpt-web' }))
    const compiler = new ContextCompiler({ details: { 'doubao-web': 'detailed', 'chatgpt-web': 'compact' } })
    const manager = new SessionManager({
      registry,
      compiler,
      checkpoints: new CheckpointService(),
      timeline: new SessionTimelineService({ now: () => AT }),
      now: () => AT,
    })

    const session = manager.create({
      title: 'Investigate the build',
      goal: 'investigate the failing build',
      provider: 'deepseek-web',
      plan: [planStep({ id: 'p1', status: 'done', summary: 'found the failing stage', evidence: ['build.log'] })],
    })
    session.memory.push({
      id: 'mem_1',
      type: 'fact',
      content: 'the build fails during asset bundling',
      source: 'tool',
      importance: 5,
      createdAt: 1,
    })

    const doubao = await manager.switchProvider(session, 'doubao-web', 'need current web results')
    const chatgpt = await manager.switchProvider(session, 'chatgpt-web', 'need a second explanation')

    expect(session.goal).toBe('investigate the failing build')
    expect(session.providerHistory).toEqual(['deepseek-web', 'doubao-web', 'chatgpt-web'])
    expect(session.context.modelSwitchHistory.map(record => record.to)).toEqual(['doubao-web', 'chatgpt-web'])
    expect(session.checkpoints.map(checkpoint => checkpoint.id)).toEqual(['cp_20261031_001', 'cp_20261031_002'])
    expect(session.checkpoints[1]!.provider).toBe('doubao-web')
    expect(doubao.prompt).toContain('## Attempted and Blocked Steps')
    expect(chatgpt.prompt).toContain('## Latest Facts')
    expect(doubao.prompt).not.toBe(chatgpt.prompt)
    expect(manager.getState(session.id)?.currentProvider).toBe('chatgpt-web')
  })

  it('switches while the task is still running and keeps the working context', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({ id: 'deepseek-web', capabilities: { coding: true } }))
    registry.register(fakeProvider({ id: 'gemini-web', capabilities: { webAccess: true } }))
    const manager = new SessionManager({
      registry,
      compiler: new ContextCompiler(),
      checkpoints: new CheckpointService(),
      timeline: new SessionTimelineService({ now: () => AT }),
      now: () => AT,
    })

    const session = manager.create({
      title: 'Patch the build',
      goal: 'patch the failing build',
      provider: 'deepseek-web',
      plan: [
        planStep({ id: 'p1', title: 'locate error', status: 'done', summary: 'config path bug' }),
        planStep({ id: 'p2', title: 'patch config', status: 'running', summary: 'editing tsconfig' }),
      ],
    })
    session.context.workingMemory.push('next: rerun the bundler')
    session.context.openQuestions.push('does the patch cover both entrypoints?')
    manager.setStatus(session.id, 'tool-running')

    const outcome = await manager.switchProvider(session, 'gemini-web', 'tool run stalled')

    expect(outcome.checkpoint.summary).toContain('1/2 plan steps done')
    expect(outcome.context.plan.map(step => step.status)).toEqual(['done', 'running'])
    expect(outcome.context.openQuestions).toEqual(['does the patch cover both entrypoints?'])
    expect(outcome.context.workingMemory).toEqual(['next: rerun the bundler'])
    expect(outcome.context.modelSwitchHistory[0]).toMatchObject({ from: 'deepseek-web', to: 'gemini-web' })
    expect(outcome.prompt).toContain('- deepseek-web -> gemini-web: tool run stalled')
    expect(manager.getState(session.id)).toMatchObject({ currentProvider: 'gemini-web', status: 'thinking' })
    expect(session.goal).toBe('patch the failing build')
  })
})
