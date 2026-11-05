/** Semantic compilation and provider-specific prompt rendering. */

import { describe, expect, it } from 'vitest'
import { ContextCompiler } from '@deepseek-ai/dsh-experimental-chathub'
import type { MemoryEntry, ChatSessionRecord } from '@deepseek-ai/dsh-experimental-chathub'
import { planStep, semanticContext, sessionRecord } from './fixtures.ts'

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

function fixture(): ChatSessionRecord {
  return sessionRecord({
    goal: 'fix the build error',
    providerHistory: ['chatgpt-web', 'deepseek-web'],
    timeline: [
      { id: 'tl_1', kind: 'session-created', at: 1, provider: 'chatgpt-web', detail: 'Session created for chatgpt-web.' },
      { id: 'tl_2', kind: 'status', at: 2, provider: 'chatgpt-web', detail: 'done' },
      { id: 'tl_3', kind: 'status', at: 3, provider: 'deepseek-web', detail: 'done' },
      { id: 'tl_4', kind: 'status', at: 4, provider: 'deepseek-web', detail: 'failed: deepseek-web: rate-limited' },
    ],
    plan: [
      planStep({ id: 'p1', title: 'locate', status: 'done', summary: 'found config path bug', evidence: ['build.log'] }),
      planStep({ id: 'p2', title: 'patch', status: 'blocked', summary: '' }),
      planStep({ id: 'p3', title: 'verify', status: 'running', summary: 'waiting for build' }),
    ],
    memory: [
      memory({ id: 'm1', type: 'fact', content: 'project uses pnpm' }),
      memory({ id: 'm2', type: 'preference', content: 'prefer minimal diffs', importance: 1, createdAt: 2 }),
    ],
    context: semanticContext({
      objective: 'stale compiled objective',
      plan: [planStep({ id: 'stale' })],
      facts: ['build fails in stage 2', 'project uses pnpm', 'f4', 'f5'],
      openQuestions: ['is there a second failure?'],
      decisions: ['keep pnpm'],
      workingMemory: ['config path located'],
      modelSwitchHistory: [
        { from: 'chatgpt-web', to: 'deepseek-web', timestamp: 1, checkpointId: 'cp_1', reason: 'coding' },
      ],
      lastToolResults: [{ toolCallId: 't1', name: 'read_file', summary: 'read tsconfig', createdAt: 1 }],
    }),
  })
}

describe('ContextCompiler.compile', () => {
  it('extracts canonical state from the session and its memory', () => {
    const compiler = new ContextCompiler()
    const session = fixture()
    const context = compiler.compile(session, 'deepseek-web')

    expect(context.objective).toBe('fix the build error')
    expect(context.plan.map(step => step.id)).toEqual(['p1', 'p2', 'p3'])
    expect(context.facts).toEqual(['project uses pnpm', 'build fails in stage 2', 'f4', 'f5'])
    expect(context.openQuestions).toEqual(['is there a second failure?'])
    expect(context.decisions).toEqual(['keep pnpm'])
    expect(context.workingMemory).toEqual([
      'config path located',
      'project uses pnpm',
      'prefer minimal diffs',
    ])
    expect(context.modelSwitchHistory).toEqual(session.context.modelSwitchHistory)
    expect(context.lastToolResults).toEqual(session.context.lastToolResults)
    expect(context.conversationStatus).toEqual([
      'Active model: deepseek-web',
      'Completed turns: 2',
      'Failed turns: 1',
      'Last failure: deepseek-web: rate-limited',
      'Models involved so far: chatgpt-web, deepseek-web',
    ])
  })

  it('returns copies that cannot mutate the session', () => {
    const compiler = new ContextCompiler()
    const session = fixture()
    const context = compiler.compile(session, 'deepseek-web')

    context.plan[0]!.status = 'pending'
    context.plan[0]!.evidence.push('extra')
    context.openQuestions.push('new question')
    context.decisions.push('new decision')
    context.modelSwitchHistory[0]!.reason = 'changed'
    context.lastToolResults[0]!.summary = 'changed'

    expect(session.plan[0]!.status).toBe('done')
    expect(session.plan[0]!.evidence).toEqual(['build.log'])
    expect(session.context.openQuestions).toEqual(['is there a second failure?'])
    expect(session.context.decisions).toEqual(['keep pnpm'])
    expect(session.context.modelSwitchHistory[0]!.reason).toBe('coding')
    expect(session.context.lastToolResults[0]!.summary).toBe('read tsconfig')
  })
})

describe('ContextCompiler.createPrompt', () => {
  it('renders the full handoff by default', () => {
    const compiler = new ContextCompiler()
    const prompt = compiler.createPrompt(compiler.compile(fixture(), 'deepseek-web'), 'deepseek-web')

    expect(prompt.startsWith('# Task context for deepseek-web')).toBe(true)
    expect(prompt).toContain('## Objective\nfix the build error')
    expect(prompt).toContain('- [done] locate — found config path bug (evidence: build.log)')
    expect(prompt).toContain('- [blocked] patch')
    expect(prompt).toContain('## Facts\n- project uses pnpm\n- build fails in stage 2\n- f4\n- f5')
    expect(prompt).toContain('## Open Questions\n- is there a second failure?')
    expect(prompt).toContain('## Decisions\n- keep pnpm')
    expect(prompt).toContain('## Working Memory\n- config path located')
    expect(prompt).toContain(
      '## Conversation Status'
      + '\n- Active model: deepseek-web'
      + '\n- Completed turns: 2'
      + '\n- Failed turns: 1'
      + '\n- Last failure: deepseek-web: rate-limited'
      + '\n- Models involved so far: chatgpt-web, deepseek-web',
    )
    expect(prompt).not.toContain('## Model Switches')
    expect(prompt).not.toContain('chatgpt-web -> deepseek-web')
    expect(prompt).toContain('## Recent Tool Results\n- read_file: read tsconfig')
  })

  it('renders the compact handoff for providers that select it', () => {
    const compiler = new ContextCompiler({ details: { 'gemini-web': 'compact' } })
    const prompt = compiler.createPrompt(compiler.compile(fixture(), 'gemini-web'), 'gemini-web')

    expect(prompt.startsWith('# Task context for gemini-web')).toBe(true)
    expect(prompt).toContain('## Plan\n- [done] locate — found config path bug')
    expect(prompt).toContain('## Latest Facts\n- build fails in stage 2\n- f4\n- f5')
    expect(prompt).toContain('## Obstacles\n- is there a second failure?')
    expect(prompt).toContain('## Next Actions\n- config path located')
    expect(prompt).not.toContain('## Decisions')
    expect(prompt).not.toContain('evidence:')
    expect(prompt).not.toContain('## Model Switches')
  })

  it('renders the detailed handoff for complex code analysis', () => {
    const compiler = new ContextCompiler({ details: { 'chatgpt-web': 'detailed' } })
    const prompt = compiler.createPrompt(compiler.compile(fixture(), 'chatgpt-web'), 'chatgpt-web')

    expect(prompt).toContain('## Attempted and Blocked Steps')
    expect(prompt).toContain('- [done] locate — found config path bug (evidence: build.log)')
    expect(prompt).toContain('- [blocked] patch')
    expect(prompt).toContain('## Current Blockers\n- is there a second failure?')
    expect(prompt).toContain('## Next Actions\n- config path located')
    expect(prompt).toContain('## Conversation Status\n- Active model: chatgpt-web')
    expect(prompt).not.toContain('## Model Switches')
    expect(prompt).toContain('## Recent Tool Results\n- read_file: read tsconfig')
  })

  it('falls back to the configured default detail for unmapped providers', () => {
    const compiler = new ContextCompiler({
      details: { 'gemini-web': 'compact' },
      defaultDetail: 'detailed',
    })
    const context = compiler.compile(fixture(), 'unknown')
    const prompt = compiler.createPrompt(context, 'unknown')

    expect(prompt.startsWith('# Task context for unknown')).toBe(true)
    expect(prompt).toContain('## Attempted and Blocked Steps')
    expect(prompt).not.toContain('## Latest Facts')
  })

  it('renders only the heading for an empty context', () => {
    const compiler = new ContextCompiler()
    expect(compiler.createPrompt(semanticContext(), 'deepseek-web')).toBe('# Task context for deepseek-web')
  })

  it('omits an empty objective in compact and detailed prompts', () => {
    const compiler = new ContextCompiler({ details: { 'gemini-web': 'compact', 'chatgpt-web': 'detailed' } })
    expect(compiler.createPrompt(semanticContext(), 'gemini-web')).toBe('# Task context for gemini-web')
    expect(compiler.createPrompt(semanticContext(), 'chatgpt-web')).toBe('# Task context for chatgpt-web')
  })
})
