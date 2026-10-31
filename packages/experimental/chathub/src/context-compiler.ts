/** Provider-independent semantic compilation and provider-specific prompt rendering. */

import { clonePlan, memoryHighlights, sessionFacts } from './session-memory.ts'
import type { IContextCompiler, PlanStep, SemanticContext, ChatSessionRecord } from './types.ts'

/** How much semantic detail one provider prompt carries. */
export type ContextDetail = 'full' | 'compact' | 'detailed'

/** Prompt detail selection per provider. */
export interface ContextCompilerOptions {
  details?: Partial<Record<string, ContextDetail>>
  defaultDetail?: ContextDetail
}

/** Facts kept by the compact prompt style. */
const COMPACT_FACT_LIMIT = 3

/** Working-memory items kept by the compact prompt style. */
const COMPACT_MEMORY_LIMIT = 3

/** One prompt renderer for a detail level. */
type PromptRenderer = (context: SemanticContext, providerId: string) => string

/** Detail-level dispatch table; every closed-union member has one renderer. */
const RENDERERS: Record<ContextDetail, PromptRenderer> = {
  full: fullPrompt,
  compact: compactPrompt,
  detailed: detailedPrompt,
}

/** Compiles canonical semantic context and renders it for a target provider. */
export class ContextCompiler implements IContextCompiler {
  private readonly details: Partial<Record<string, ContextDetail>>
  private readonly defaultDetail: ContextDetail

  /**
   * @param options - Per-provider detail mapping and the fallback detail level.
   */
  constructor(options: ContextCompilerOptions = {}) {
    this.details = options.details ?? {}
    this.defaultDetail = options.defaultDetail ?? 'full'
  }

  /**
   * Extract the session's canonical task state.
   * @param session - Session to compile.
   * @param _providerId - Reserved by the compiler contract; semantic context is provider-independent.
   * @returns A fresh semantic context.
   */
  compile(session: ChatSessionRecord, _providerId: string): SemanticContext {
    return {
      objective: session.goal,
      plan: clonePlan(session.plan),
      facts: sessionFacts(session),
      openQuestions: [...session.context.openQuestions],
      decisions: [...session.context.decisions],
      workingMemory: [...new Set([...session.context.workingMemory, ...memoryHighlights(session)])],
      modelSwitchHistory: session.context.modelSwitchHistory.map(record => ({ ...record })),
      lastToolResults: session.context.lastToolResults.map(result => ({ ...result })),
    }
  }

  /**
   * Render a prompt for one provider's configured detail level.
   * @param context - Semantic context to render.
   * @param providerId - Provider whose detail mapping applies.
   * @returns Prompt text without a trailing newline.
   */
  createPrompt(context: SemanticContext, providerId: string): string {
    const detail = this.details[providerId] ?? this.defaultDetail
    return RENDERERS[detail](context, providerId)
  }
}

/**
 * Render the complete task handoff.
 * @param context - Semantic context to render.
 * @param providerId - Provider receiving the prompt.
 * @returns Full-detail prompt.
 */
function fullPrompt(context: SemanticContext, providerId: string): string {
  return joinSections([
    heading(providerId),
    section('Objective', context.objective === '' ? [] : [context.objective]),
    section('Plan', context.plan.map(step => planLine(step, true))),
    section('Facts', bulleted(context.facts)),
    section('Open Questions', bulleted(context.openQuestions)),
    section('Decisions', bulleted(context.decisions)),
    section('Working Memory', bulleted(context.workingMemory)),
    section('Model Switches', context.modelSwitchHistory.map(switchLine)),
    section('Recent Tool Results', context.lastToolResults.map(toolLine)),
  ])
}

/**
 * Render the token-constrained handoff: objective, current plan, latest facts, obstacles, next actions.
 * @param context - Semantic context to render.
 * @param providerId - Provider receiving the prompt.
 * @returns Compact prompt.
 */
function compactPrompt(context: SemanticContext, providerId: string): string {
  return joinSections([
    heading(providerId),
    section('Objective', context.objective === '' ? [] : [context.objective]),
    section('Plan', context.plan.map(step => planLine(step, false))),
    section('Latest Facts', bulleted(context.facts.slice(-COMPACT_FACT_LIMIT))),
    section('Obstacles', bulleted(context.openQuestions)),
    section('Next Actions', bulleted(context.workingMemory.slice(-COMPACT_MEMORY_LIMIT))),
  ])
}

/**
 * Render the high-detail handoff for complex code analysis.
 * @param context - Semantic context to render.
 * @param providerId - Provider receiving the prompt.
 * @returns Detailed prompt.
 */
function detailedPrompt(context: SemanticContext, providerId: string): string {
  return joinSections([
    heading(providerId),
    section('Objective', context.objective === '' ? [] : [context.objective]),
    section('Plan', context.plan.map(step => planLine(step, true))),
    section('Facts', bulleted(context.facts)),
    section('Decisions', bulleted(context.decisions)),
    section('Attempted and Blocked Steps', context.plan
      .filter(step => step.status === 'done' || step.status === 'blocked')
      .map(step => planLine(step, true))),
    section('Current Blockers', bulleted(context.openQuestions)),
    section('Next Actions', bulleted(context.workingMemory)),
    section('Recent Tool Results', context.lastToolResults.map(toolLine)),
  ])
}

/**
 * @param providerId - Provider receiving the prompt.
 * @returns The prompt's leading heading.
 */
function heading(providerId: string): string {
  return `# Task context for ${providerId}`
}

/**
 * @param title - Section heading.
 * @param lines - Rendered section body lines.
 * @returns The section, or an empty string when it has no lines.
 */
function section(title: string, lines: string[]): string {
  return lines.length === 0 ? '' : `## ${title}\n${lines.join('\n')}`
}

/**
 * @param values - Plain strings to render.
 * @returns One bullet per value.
 */
function bulleted(values: string[]): string[] {
  return values.map(value => `- ${value}`)
}

/**
 * @param step - Plan step to render.
 * @param includeEvidence - Whether to append recorded evidence.
 * @returns One plan line.
 */
function planLine(step: PlanStep, includeEvidence: boolean): string {
  const summary = step.summary === '' ? '' : ` — ${step.summary}`
  const evidence = includeEvidence && step.evidence.length > 0
    ? ` (evidence: ${step.evidence.join('; ')})`
    : ''
  return `- [${step.status}] ${step.title}${summary}${evidence}`
}

/**
 * @param record - Completed switch.
 * @returns One switch line.
 */
function switchLine(record: SemanticContext['modelSwitchHistory'][number]): string {
  return `- ${record.from} -> ${record.to}: ${record.reason}`
}

/**
 * @param result - Condensed tool result.
 * @returns One tool-result line.
 */
function toolLine(result: SemanticContext['lastToolResults'][number]): string {
  return `- ${result.name}: ${result.summary}`
}

/**
 * @param sections - Rendered sections, possibly empty.
 * @returns Non-empty sections separated by blank lines.
 */
function joinSections(sections: string[]): string {
  return sections.filter(entry => entry !== '').join('\n\n')
}
