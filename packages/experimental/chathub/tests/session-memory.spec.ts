/** Session memory writes and shared derivations. */

import { describe, expect, it } from 'vitest'
import {
  SessionMemoryService,
  clonePlan,
  memoryHighlights,
  sessionFacts,
} from '@deepseek-ai/dsh-experimental-chathub'
import type { MemoryEntry } from '@deepseek-ai/dsh-experimental-chathub'
import { planStep, semanticContext, sessionRecord } from './fixtures.ts'

/** Fixed clock used by memory specs. */
const AT = Date.UTC(2026, 9, 31, 8)

describe('SessionMemoryService', () => {
  it('records entries with date-stamped ids, default importance, and update time', () => {
    const memory = new SessionMemoryService({ now: () => AT })
    const session = sessionRecord()

    const entry = memory.record(session, { type: 'fact', content: 'project uses pnpm', source: 'tool' })
    expect(entry).toEqual({
      id: 'mem_20261031_001',
      type: 'fact',
      content: 'project uses pnpm',
      source: 'tool',
      importance: 1,
      createdAt: AT,
    })
    expect(session.memory).toEqual([entry])
    expect(session.updatedAt).toBe(AT)

    const second = memory.record(session, {
      type: 'lesson',
      content: 'fix fixtures, not normalizers',
      source: 'agent',
      importance: 5,
    })
    expect(second.id).toBe('mem_20261031_002')
  })

  it('uses the wall clock when no override is supplied', () => {
    const session = sessionRecord()
    const entry = new SessionMemoryService().record(session, {
      type: 'preference',
      content: 'prefer pnpm',
      source: 'user',
    })
    expect(entry.id).toMatch(/^mem_\d{8}_\d{3}/)
    expect(entry.importance).toBe(1)
  })

  it('copies a plan before storing it', () => {
    const memory = new SessionMemoryService({ now: () => AT })
    const session = sessionRecord()
    const plan = [planStep({ evidence: ['build.log'] })]

    memory.setPlan(session, plan)
    plan[0]!.evidence.push('mutated')
    plan[0]!.status = 'done'

    expect(session.plan[0]!.evidence).toEqual(['build.log'])
    expect(session.plan[0]!.status).toBe('running')
    expect(session.updatedAt).toBe(AT)
  })

  it('updates only the supplied plan-step fields', () => {
    const memory = new SessionMemoryService({ now: () => AT })
    const session = sessionRecord({ plan: [planStep()] })

    const step = memory.updatePlanStep(session, 'p1', { status: 'done' })
    expect(step.status).toBe('done')
    expect(step.summary).toBe('scanning build output')
    expect(step.evidence).toEqual([])

    memory.updatePlanStep(session, 'p1', { summary: 'root cause found', evidence: ['build.log'] })
    expect(step.summary).toBe('root cause found')
    expect(step.evidence).toEqual(['build.log'])
    expect(session.updatedAt).toBe(AT)
  })

  it('rejects an unknown plan step', () => {
    const memory = new SessionMemoryService({ now: () => AT })
    const session = sessionRecord({ plan: [planStep()] })

    expect(() => memory.updatePlanStep(session, 'p9', { status: 'done' })).toThrow(
      expect.objectContaining({ code: 'plan-step-not-found' }),
    )
  })

  it('adds and resolves open questions without duplicates', () => {
    const memory = new SessionMemoryService({ now: () => AT })
    const session = sessionRecord({ context: semanticContext({ openQuestions: ['is the frontend at fault?'] }) })

    memory.addOpenQuestion(session, 'is the frontend at fault?')
    memory.addOpenQuestion(session, 'is there a second failure?')
    expect(session.context.openQuestions).toEqual([
      'is the frontend at fault?',
      'is there a second failure?',
    ])

    memory.resolveOpenQuestion(session, 'is the frontend at fault?')
    expect(session.context.openQuestions).toEqual(['is there a second failure?'])
    expect(session.updatedAt).toBe(AT)
  })

  it('records decisions without duplicates', () => {
    const memory = new SessionMemoryService({ now: () => AT })
    const session = sessionRecord()

    memory.addDecision(session, 'keep pnpm')
    memory.addDecision(session, 'keep pnpm')
    expect(session.context.decisions).toEqual(['keep pnpm'])
    expect(session.updatedAt).toBe(AT)
  })
})

describe('memory derivations', () => {
  function entry(overrides: Partial<MemoryEntry>): MemoryEntry {
    return {
      id: 'mem_1',
      type: 'fact',
      content: 'fact',
      source: 'agent',
      importance: 1,
      createdAt: 1,
      ...overrides,
    }
  }

  it('orders highlights by importance then recency and deduplicates content', () => {
    const session = sessionRecord({
      memory: [
        entry({ id: 'a', content: 'low', importance: 1, createdAt: 2 }),
        entry({ id: 'b', content: 'high', importance: 5, createdAt: 1 }),
        entry({ id: 'c', content: 'high', importance: 5, createdAt: 1 }),
        entry({ id: 'd', content: 'newer low', importance: 1, createdAt: 3 }),
      ],
    })

    expect(memoryHighlights(session)).toEqual(['high', 'newer low', 'low'])
  })

  it('unions typed facts with context facts and ignores other memory types', () => {
    const session = sessionRecord({
      memory: [
        entry({ id: 'a', type: 'fact', content: 'uses pnpm' }),
        entry({ id: 'b', type: 'preference', content: 'prefers short answers' }),
      ],
      context: semanticContext({ facts: ['build fails in stage 2', 'uses pnpm'] }),
    })

    expect(sessionFacts(session)).toEqual(['uses pnpm', 'build fails in stage 2'])
  })

  it('clones plans deeply enough for context isolation', () => {
    const plan = [planStep({ evidence: ['build.log'] })]
    const clone = clonePlan(plan)
    clone[0]!.status = 'done'
    clone[0]!.evidence.push('second')
    expect(plan[0]!.status).toBe('running')
    expect(plan[0]!.evidence).toEqual(['build.log'])
  })
})
