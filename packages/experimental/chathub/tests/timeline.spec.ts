/** Ordered session event log and its memory integration. */

import { describe, expect, it } from 'vitest'
import { SessionMemoryService, SessionTimelineService } from '@deepseek-ai/dsh-experimental-chathub'
import { sessionRecord } from './fixtures.ts'

/** Fixed clock used by timeline specs. */
const AT = Date.UTC(2026, 9, 31, 9)

describe('SessionTimelineService', () => {
  it('appends date-stamped entries in order with optional checkpoint ids', () => {
    const timeline = new SessionTimelineService({ now: () => AT })
    const session = sessionRecord()

    const created = timeline.record(session, {
      kind: 'session-created',
      provider: 'deepseek-web',
      detail: 'created',
    })
    const switched = timeline.record(session, {
      kind: 'provider-switch',
      provider: 'gemini-web',
      detail: 'deepseek-web -> gemini-web: review',
      checkpointId: 'cp_20261031_001',
    })

    expect(created).toEqual({
      id: 'tl_20261031_001',
      kind: 'session-created',
      at: AT,
      provider: 'deepseek-web',
      detail: 'created',
    })
    expect(switched).toEqual({
      id: 'tl_20261031_002',
      kind: 'provider-switch',
      at: AT,
      provider: 'gemini-web',
      detail: 'deepseek-web -> gemini-web: review',
      checkpointId: 'cp_20261031_001',
    })
    expect(session.timeline).toEqual([created, switched])
  })

  it('lists copies and keeps the most recent entries', () => {
    const timeline = new SessionTimelineService({ now: () => AT })
    const session = sessionRecord()
    timeline.record(session, { kind: 'session-created', provider: 'deepseek-web', detail: 'created' })
    timeline.record(session, { kind: 'status', provider: 'deepseek-web', detail: 'thinking' })
    timeline.record(session, { kind: 'memory', provider: 'deepseek-web', detail: 'fact: uses pnpm' })

    const all = timeline.list(session)
    expect(all).toHaveLength(3)
    all[0]!.detail = 'mutated'
    expect(session.timeline[0]!.detail).toBe('created')
    expect(timeline.list(session, { limit: 2 }).map(entry => entry.detail)).toEqual([
      'thinking',
      'fact: uses pnpm',
    ])
  })

  it('records memory writes on the wired timeline', () => {
    const timeline = new SessionTimelineService({ now: () => AT })
    const memory = new SessionMemoryService({ now: () => AT, timeline })
    const session = sessionRecord()

    memory.record(session, { type: 'fact', content: 'project uses pnpm', source: 'tool' })

    expect(session.timeline).toEqual([
      expect.objectContaining({ kind: 'memory', provider: 'deepseek-web', detail: 'fact: project uses pnpm' }),
    ])
  })
})
