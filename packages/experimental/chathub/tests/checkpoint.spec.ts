/** Checkpoint snapshots written before model switches. */

import { describe, expect, it } from 'vitest'
import { CheckpointService } from '@deepseek-ai/dsh-experimental-chathub'
import type { MemoryEntry } from '@deepseek-ai/dsh-experimental-chathub'
import { planStep, semanticContext, sessionRecord } from './fixtures.ts'

const AT = Date.UTC(2026, 9, 31, 9)

function memory(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'mem_1',
    type: 'fact',
    content: 'project uses pnpm',
    source: 'tool',
    importance: 5,
    createdAt: 1,
    ...overrides,
  }
}

function fixture() {
  return sessionRecord({
    goal: 'fix the build error',
    plan: [
      planStep({ id: 'p1', status: 'done', summary: 'root cause found', evidence: ['build.log'] }),
      planStep({ id: 'p2', status: 'running', summary: 'patching the path' }),
    ],
    memory: [
      memory({ id: 'm1', type: 'fact', content: 'project uses pnpm' }),
      memory({ id: 'm2', type: 'lesson', content: 'fixtures follow the platform', importance: 2, createdAt: 2 }),
    ],
    context: semanticContext({
      facts: ['build fails in stage 2'],
      openQuestions: ['is there a second failure?', 'does CI use the same script?'],
    }),
  })
}

describe('CheckpointService', () => {
  it('snapshots objective, plan, facts, questions, and memory highlights', () => {
    const service = new CheckpointService()
    const session = fixture()

    const checkpoint = service.generate(session, {
      provider: 'deepseek-web',
      reason: 'need stronger code analysis',
      now: AT,
    })

    expect(checkpoint).toEqual({
      id: 'cp_20261031_001',
      createdAt: AT,
      provider: 'deepseek-web',
      objective: 'fix the build error',
      summary: 'fix the build error (1/2 plan steps done, 2 facts, 2 open questions)',
      plan: session.plan,
      facts: ['project uses pnpm', 'build fails in stage 2'],
      openQuestions: ['is there a second failure?', 'does CI use the same script?'],
      memoryHighlights: ['project uses pnpm', 'fixtures follow the platform'],
      modelSwitchReason: 'need stronger code analysis',
    })
  })

  it('copies the plan so later session edits do not rewrite history', () => {
    const service = new CheckpointService()
    const session = fixture()
    const checkpoint = service.generate(session, { provider: 'deepseek-web', now: AT })

    checkpoint.plan[0]!.status = 'pending'
    checkpoint.plan[0]!.evidence.push('later')
    expect(session.plan[0]!.status).toBe('done')
    expect(session.plan[0]!.evidence).toEqual(['build.log'])
  })

  it('increments ids and omits the switch reason when none is given', () => {
    const service = new CheckpointService()
    const session = fixture()

    service.generate(session, { provider: 'deepseek-web', reason: 'first', now: AT })
    const second = service.generate(session, { provider: 'deepseek-web', now: AT })

    expect(second.id).toBe('cp_20261031_002')
    expect(second).not.toHaveProperty('modelSwitchReason')
  })
})
