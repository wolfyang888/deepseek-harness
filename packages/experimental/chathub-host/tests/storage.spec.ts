/** The ChatHub repository projects orchestration records onto five domain tables and reassembles them. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type {
  ChatMessage,
  ChatSessionRecord,
  MemoryEntry,
  PlanStep,
  SessionCheckpoint,
  SessionTimelineEntry,
} from '@deepseek-ai/dsh-experimental-chathub'
import { describe, expect, it } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { chatHubDomainSpec, ChatHubRepository } from '../src/storage.ts'

const AT = Date.UTC(2026, 10, 1, 12)
const PLAN: PlanStep[] = [{ id: 'step_1', title: 'Draft', status: 'running', summary: 'Drafting', evidence: ['fact-a'] }]
const MEMORY: MemoryEntry[] = [{ id: 'mem_1', type: 'fact', content: 'Layout decided', source: 'turn', importance: 1, createdAt: AT }]

function message(content: string, role: ChatMessage['role'] = 'user', timestamp = AT): ChatMessage {
  return { role, content, timestamp }
}

function timelineEntry(id: string, at = AT): SessionTimelineEntry {
  return { id, kind: 'status', at, provider: 'deepseek-web', detail: 'thinking' }
}

function checkpoint(id: string, sessionId = 'sess_20261101_001', createdAt = AT): SessionCheckpoint {
  return {
    schemaVersion: 1,
    id,
    sessionId,
    createdAt,
    provider: 'deepseek-web',
    objective: 'Finish the draft',
    summary: 'before switch',
    plan: [],
    facts: ['fact-a'],
    openQuestions: [],
    decisions: [],
    memoryHighlights: [],
    modelSwitchHistory: [],
  }
}

function record(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
  return {
    id: 'sess_20261101_001',
    title: 'Cross-provider task',
    createdAt: AT,
    updatedAt: AT,
    currentProvider: 'deepseek-web',
    providerHistory: ['deepseek-web'],
    goal: 'Finish the draft',
    plan: PLAN,
    memory: MEMORY,
    context: {
      objective: 'Finish the draft',
      plan: PLAN,
      facts: ['fact-a'],
      openQuestions: ['which provider next?'],
      decisions: ['checkpoint before switching'],
      workingMemory: ['draft half done'],
      modelSwitchHistory: [{ from: 'deepseek-web', to: 'gemini-web', timestamp: AT, checkpointId: 'cp_1', reason: 'manual' }],
      lastToolResults: [{ toolCallId: 'call_1', name: 'read', summary: 'file', createdAt: AT }],
    },
    checkpoints: [],
    timeline: [],
    ...overrides,
  }
}

/** Open one repository over an isolated in-memory domain. */
async function openRepository(pool = new MemoryMediaPool()) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory' })
  const domain = await facility.open(chatHubDomainSpec)
  return { ctx, pool, facility, repository: ChatHubRepository.from(domain) }
}

describe('ChatHubRepository', () => {
  it('persists a session row with its projections and reads it back', async () => {
    const { ctx, repository } = await openRepository()
    try {
      await repository.putSession(record({
        updatedAt: AT + 1,
        timeline: [timelineEntry('tl_1'), timelineEntry('tl_2', AT + 1)],
        checkpoints: [checkpoint('cp_2', 'sess_20261101_001', AT + 1), checkpoint('cp_1')],
      }), 'done', 'deepseek-web: rate-limited')
      const [snapshot] = await repository.listSessions()
      expect(snapshot?.record.id).toBe('sess_20261101_001')
      expect(snapshot?.status).toBe('done')
      expect(snapshot?.lastError).toBe('deepseek-web: rate-limited')
      expect(snapshot?.record.timeline.map(entry => entry.id)).toEqual(['tl_1', 'tl_2'])
      expect(snapshot?.record.checkpoints.map(entry => entry.id)).toEqual(['cp_1', 'cp_2'])
      expect(snapshot?.record.context.modelSwitchHistory).toHaveLength(1)
      expect(snapshot?.record.memory).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the optional keys a stored row may carry', async () => {
    const { ctx, repository } = await openRepository()
    try {
      await repository.putSession(record({
        plan: [{ ...PLAN[0] as PlanStep, parentId: 'step_0' }],
        checkpoints: [{ ...checkpoint('cp_1'), modelSwitchReason: 'manual' }],
        timeline: [{ ...timelineEntry('tl_1'), kind: 'provider-switch', checkpointId: 'cp_1' }],
      }), 'idle')
      await repository.appendMessage('sess_20261101_001', {
        role: 'assistant',
        content: 'running',
        timestamp: AT,
        name: 'deepseek-web',
        toolCallId: 'call_1',
      })
      const snapshot = await repository.getSession('sess_20261101_001')
      expect(snapshot?.record.plan[0]?.parentId).toBe('step_0')
      expect(snapshot?.record.checkpoints[0]?.modelSwitchReason).toBe('manual')
      expect(snapshot?.record.timeline[0]?.checkpointId).toBe('cp_1')
      const [answer] = await repository.listMessages('sess_20261101_001')
      expect(answer?.name).toBe('deepseek-web')
      expect(answer?.toolCallId).toBe('call_1')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('omits lastError and reports unknown ids', async () => {
    const { ctx, repository } = await openRepository()
    try {
      await repository.putSession(record(), 'idle')
      const snapshot = await repository.getSession('sess_20261101_001')
      expect(snapshot?.status).toBe('idle')
      expect(snapshot?.lastError).toBeUndefined()
      expect(await repository.getSession('sess_missing')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lists sessions most recently updated first', async () => {
    const { ctx, repository } = await openRepository()
    try {
      await repository.putSession(record({ id: 'sess_a' }), 'idle')
      await repository.putSession(record({ id: 'sess_b', updatedAt: AT + 5 }), 'idle')
      expect((await repository.listSessions()).map(snapshot => snapshot.record.id)).toEqual(['sess_b', 'sess_a'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('appends messages per session and backfills sequences after reopen', async () => {
    const pool = new MemoryMediaPool()
    const first = await openRepository(pool)
    await first.repository.appendMessage('sess_1', message('first'))
    await first.repository.appendMessage('sess_1', message('second', 'assistant', AT + 1))
    await first.repository.appendMessage('sess_2', message('other session'))
    expect((await first.repository.listMessages('sess_1')).map(entry => entry.content)).toEqual(['first', 'second'])
    await first.facility.closeAll()
    await first.ctx.fiber.dispose()
    const second = await openRepository(pool)
    try {
      expect(await second.repository.appendMessage('sess_1', message('third', 'assistant', AT + 2))).toBe('sess_1/3')
      expect((await second.repository.listMessages('sess_1')).map(entry => entry.content))
        .toEqual(['first', 'second', 'third'])
      expect((await second.repository.listMessages('sess_2')).map(entry => entry.content)).toEqual(['other session'])
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('scopes timeline and checkpoint reads to their session', async () => {
    const { ctx, repository } = await openRepository()
    try {
      await repository.putSession(
        record({ id: 'sess_a', timeline: [timelineEntry('tl_a')], checkpoints: [checkpoint('cp_a', 'sess_a')] }), 'idle')
      await repository.putSession(
        record({ id: 'sess_b', timeline: [timelineEntry('tl_b', AT + 1)], checkpoints: [checkpoint('cp_b', 'sess_b')] }), 'idle')
      expect((await repository.listTimeline('sess_a')).map(entry => entry.id)).toEqual(['tl_a'])
      expect((await repository.listCheckpoints('sess_a')).map(entry => entry.id)).toEqual(['cp_a'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('deletes a session with its projections and keeps other sessions', async () => {
    const { ctx, repository } = await openRepository()
    try {
      await repository.putSession(
        record({ id: 'sess_a', timeline: [timelineEntry('tl_a')], checkpoints: [checkpoint('cp_a', 'sess_a')] }), 'idle')
      await repository.putSession(
        record({ id: 'sess_b', timeline: [timelineEntry('tl_b', AT + 1)], checkpoints: [checkpoint('cp_b', 'sess_b')] }), 'idle')
      await repository.appendMessage('sess_a', message('a only'))
      await repository.appendMessage('sess_b', message('b only'))
      await repository.deleteSession('sess_a')
      expect(await repository.getSession('sess_a')).toBeUndefined()
      expect(await repository.listMessages('sess_a')).toEqual([])
      expect(await repository.listTimeline('sess_a')).toEqual([])
      expect(await repository.listCheckpoints('sess_a')).toEqual([])
      expect((await repository.getSession('sess_b'))?.record.id).toBe('sess_b')
      expect((await repository.listMessages('sess_b')).map(entry => entry.content)).toEqual(['b only'])
      await expect(repository.deleteSession('sess_missing')).resolves.toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records per-provider usage for selector ordering', async () => {
    const { ctx, repository } = await openRepository()
    try {
      await repository.markProviderUsed('deepseek-web', AT)
      await repository.markProviderUsed('gemini-web', AT + 5)
      expect(repository.providerLastUsed()).toEqual({ 'deepseek-web': AT, 'gemini-web': AT + 5 })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
