/** LLM-driven session compaction: trigger, checkpoint parsing, and merge. */

import { describe, expect, it } from 'vitest'
import {
  COMPACTION_INSTRUCTION,
  SessionCompactionService,
  SessionTimelineService,
  mergeCheckpoint,
  parseCheckpoint,
} from '@deepseek-ai/dsh-experimental-chathub'
import type { ChatSessionRecord } from '@deepseek-ai/dsh-experimental-chathub'
import { fakeProvider, sessionRecord } from './fixtures.ts'

const AT = Date.UTC(2026, 10, 5, 9)
const BOUNDS = { maxEntries: 10, maxWorkingMemory: 4, maxToolResults: 4, maxModelSwitches: 4 }

const CHECKPOINT = [
  '## Primary Request and Intent',
  '- fix the failing build in the lua_device repo',
  '',
  '## Key Facts and Conclusions',
  '- the failure is in stage 2 of the build',
  '- the project uses pnpm',
  '',
  '## Errors and Fixes',
  '- rate limit hit: retried after the cooldown',
  '',
  '## Pending Jobs',
  '- rerun the full test suite',
  '',
  '## Current Work',
  '- patching tsconfig paths',
  '',
  '## Next Step',
  '- rerun the bundler',
  '',
  '## Critical Context',
  '- keep diffs minimal',
].join('\n')

describe('SessionCompactionService.shouldRun', () => {
  function service(): SessionCompactionService {
    return new SessionCompactionService({
      timeline: new SessionTimelineService({ now: () => AT }),
      now: () => AT,
      maxMessages: 10,
      minGap: 4,
    })
  }

  it('stays below the message threshold', () => {
    const record = sessionRecord()
    expect(service().shouldRun(record, 9)).toBe(false)
  })

  it('runs at the threshold before the first compaction', () => {
    const record = sessionRecord()
    expect(service().shouldRun(record, 10)).toBe(true)
  })

  it('respects the cooldown after a compaction', () => {
    const record = sessionRecord()
    record.lastAutoCompaction = { at: AT, messageCount: 10 }
    expect(service().shouldRun(record, 13)).toBe(false)
    expect(service().shouldRun(record, 14)).toBe(true)
  })
})

describe('parseCheckpoint', () => {
  it('routes sections onto facts, decisions, and working memory', () => {
    const checkpoint = parseCheckpoint(CHECKPOINT)
    expect(checkpoint.facts).toEqual([
      'fix the failing build in the lua_device repo',
      'the failure is in stage 2 of the build',
      'the project uses pnpm',
      'rate limit hit: retried after the cooldown',
    ])
    expect(checkpoint.decisions).toEqual(['keep diffs minimal'])
    expect(checkpoint.workingMemory).toEqual([
      'rerun the full test suite',
      'patching tsconfig paths',
      'rerun the bundler',
    ])
  })

  it('skips "(none)" placeholders and unknown sections', () => {
    const checkpoint = parseCheckpoint([
      '## Key Facts and Conclusions',
      '- a fact',
      '',
      '## Files and Code',
      '- should be ignored',
      '',
      '## Current Work',
      '- (none)',
    ].join('\n'))
    expect(checkpoint.facts).toEqual(['a fact'])
    expect(checkpoint.workingMemory).toEqual([])
    expect(checkpoint.decisions).toEqual([])
  })

  it('treats the fillers a model writes for an empty section as empty', () => {
    const checkpoint = parseCheckpoint([
      'Errors and Fixes',
      'None reported.',
      'Pending Jobs',
      '(none)',
      'n/a',
    ].join('\n'))
    expect(checkpoint.facts).toEqual([])
    expect(checkpoint.workingMemory).toEqual([])
  })

  it('routes an answer whose markers the site stripped', () => {
    const checkpoint = parseCheckpoint([
      'Primary Request and Intent',
      'change slow_ms default from 200 to 150',
      'Key Facts and Conclusions',
      'line 45 holds the config default',
      'Pending Jobs',
      'add slow_ratio to the report stats',
    ].join('\n'))
    expect(checkpoint.facts).toEqual(['change slow_ms default from 200 to 150', 'line 45 holds the config default'])
    expect(checkpoint.workingMemory).toEqual(['add slow_ratio to the report stats'])
  })

  it('reads bold and colon-decorated titles as headings', () => {
    const checkpoint = parseCheckpoint([
      '**Next Step**:',
      'rerun the bundler',
    ].join('\n'))
    expect(checkpoint.workingMemory).toEqual(['rerun the bundler'])
  })

  it('keeps a sentence that resembles a title as content', () => {
    const checkpoint = parseCheckpoint([
      'Next Step',
      'rerun the bundler',
      'the failure is in stage 2 of the build',
    ].join('\n'))
    expect(checkpoint.workingMemory).toEqual(['rerun the bundler', 'the failure is in stage 2 of the build'])
  })
})

describe('mergeCheckpoint', () => {
  it('merges without duplicates, prunes memory, and stamps the position', () => {
    const record = sessionRecord()
    record.context.facts = ['the project uses pnpm']
    record.memory = Array.from({ length: 15 }, (_, index) => ({
      id: `mem_${index}`,
      type: 'fact' as const,
      content: `old fact ${index}`,
      source: 'tool',
      importance: 1,
      createdAt: index,
    }))
    mergeCheckpoint(record, parseCheckpoint(CHECKPOINT), { now: AT, messageCount: 12, bounds: BOUNDS })

    expect(record.context.facts).toContain('the failure is in stage 2 of the build')
    expect(record.context.facts.filter(fact => fact === 'the project uses pnpm')).toHaveLength(1)
    expect(record.memory.length).toBeLessThanOrEqual(BOUNDS.maxEntries)
    expect(record.context.workingMemory).toContain('rerun the bundler')
    expect(record.lastAutoCompaction).toEqual({ at: AT, messageCount: 12 })
    expect(record.updatedAt).toBe(AT)
  })
})

describe('SessionCompactionService.run', () => {
  function service(): SessionCompactionService {
    return new SessionCompactionService({
      timeline: new SessionTimelineService({ now: () => AT }),
      now: () => AT,
      bounds: BOUNDS,
    })
  }

  it('sends the instruction alone and merges the checkpoint answer', async () => {
    const provider = fakeProvider({ id: 'deepseek-web', response: CHECKPOINT })
    const record = sessionRecord()
    record.currentProvider = 'deepseek-web'

    const result = await service().run(record, provider, 12)

    expect(result).toBe('compacted')
    const request = provider.calls[0]!
    expect(request.systemPrompt).toBeUndefined()
    expect(request.messages).toHaveLength(1)
    expect(request.messages[0]!.content).toBe(COMPACTION_INSTRUCTION)
    expect(request.messages[0]!.role).toBe('user')
    expect(record.context.facts).toContain('the failure is in stage 2 of the build')
    expect(record.lastAutoCompaction).toEqual({ at: AT, messageCount: 12 })
    expect(record.timeline.at(-1)).toMatchObject({ kind: 'status', detail: 'compacted at 12 messages' })
  })

  it('reports skipped when the answer carries no checkpoint sections', async () => {
    const provider = fakeProvider({ id: 'deepseek-web', response: 'I cannot do that.' })
    const record = sessionRecord()
    record.currentProvider = 'deepseek-web'

    const result = await service().run(record, provider, 12)

    expect(result).toBe('skipped')
    expect(record.lastAutoCompaction).toBeUndefined()
    expect(record.timeline.at(-1)).toMatchObject({ detail: 'compaction skipped: the answer carried no checkpoint sections' })
  })

  it('reports failed and records the reason when the provider rejects', async () => {
    const provider = fakeProvider({ id: 'deepseek-web', response: new Error('rate limited') })
    const record: ChatSessionRecord = sessionRecord()
    record.currentProvider = 'deepseek-web'

    const result = await service().run(record, provider, 12)

    expect(result).toBe('failed')
    expect(record.lastAutoCompaction).toBeUndefined()
    expect(record.timeline.at(-1)!.detail).toContain('compaction failed')
    expect(record.timeline.at(-1)!.detail).toContain('rate limited')
  })
})
