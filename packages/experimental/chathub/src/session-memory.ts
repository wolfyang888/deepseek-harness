/** Session-scoped memory operations and the derivations shared by compilation and checkpoints. */

import { ChatHubError } from './errors.ts'
import { createMemoryEntryId } from './ids.ts'
import type { MemoryEntry, MemoryEntryType, PlanStep, PlanStepStatus, SessionRecord } from './types.ts'

/** Input for one memory entry. */
export interface RecordMemoryInput {
  type: MemoryEntryType
  content: string
  source: string
  importance?: number
}

/** Fields changed by one plan-step update; omitted fields stay unchanged. */
export interface PlanStepUpdate {
  status?: PlanStepStatus
  summary?: string
  evidence?: string[]
}

/**
 * Copy plan steps so a compiled context cannot mutate session state.
 * @param plan - Plan steps to copy.
 * @returns Independent step objects and evidence arrays.
 */
export function clonePlan(plan: PlanStep[]): PlanStep[] {
  return plan.map(step => ({ ...step, evidence: [...step.evidence] }))
}

/**
 * Memory contents ordered by importance, then recency, without duplicates.
 * @param session - Session whose memory to read.
 * @returns Unique memory contents.
 */
export function memoryHighlights(session: SessionRecord): string[] {
  const ordered = [...session.memory]
    .sort((left, right) => right.importance - left.importance || right.createdAt - left.createdAt)
  return [...new Set(ordered.map(entry => entry.content))]
}

/**
 * Facts recorded for the session, from typed memory entries and the last compiled context.
 * @param session - Session whose facts to read.
 * @returns Unique fact strings.
 */
export function sessionFacts(session: SessionRecord): string[] {
  const recorded = session.memory
    .filter(entry => entry.type === 'fact')
    .map(entry => entry.content)
  return [...new Set([...recorded, ...session.context.facts])]
}

/** Session-scoped memory writes with deterministic, date-stamped entry ids. */
export class SessionMemoryService {
  private sequence = 0
  private readonly now: () => number

  /**
   * @param options - Optional clock override for deterministic ids and timestamps.
   */
  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  /**
   * Record one memory entry and bump the session update time.
   * @param session - Session to update.
   * @param input - Entry type, content, source, and optional importance.
   * @returns The recorded entry.
   */
  record(session: SessionRecord, input: RecordMemoryInput): MemoryEntry {
    const at = this.now()
    const entry: MemoryEntry = {
      id: createMemoryEntryId(at, ++this.sequence),
      type: input.type,
      content: input.content,
      source: input.source,
      importance: input.importance ?? 1,
      createdAt: at,
    }
    session.memory.push(entry)
    session.updatedAt = at
    return entry
  }

  /**
   * Replace the session plan.
   * @param session - Session to update.
   * @param plan - New plan steps.
   */
  setPlan(session: SessionRecord, plan: PlanStep[]): void {
    session.plan = clonePlan(plan)
    session.updatedAt = this.now()
  }

  /**
   * Update one plan step.
   * @param session - Session to update.
   * @param stepId - Step identifier.
   * @param update - Fields to change.
   * @returns The updated step.
   * @throws ChatHubError with `plan-step-not-found` when the id is absent.
   */
  updatePlanStep(session: SessionRecord, stepId: string, update: PlanStepUpdate): PlanStep {
    const step = session.plan.find(candidate => candidate.id === stepId)
    if (step === undefined) {
      throw new ChatHubError('plan-step-not-found', `ChatHub plan has no step "${stepId}".`)
    }
    if (update.status !== undefined) step.status = update.status
    if (update.summary !== undefined) step.summary = update.summary
    if (update.evidence !== undefined) step.evidence = [...update.evidence]
    session.updatedAt = this.now()
    return step
  }

  /**
   * Add an open question unless it is already open.
   * @param session - Session to update.
   * @param question - Question text.
   */
  addOpenQuestion(session: SessionRecord, question: string): void {
    session.context.openQuestions = [...new Set([...session.context.openQuestions, question])]
    session.updatedAt = this.now()
  }

  /**
   * Remove an open question.
   * @param session - Session to update.
   * @param question - Question text to close.
   */
  resolveOpenQuestion(session: SessionRecord, question: string): void {
    session.context.openQuestions = session.context.openQuestions.filter(open => open !== question)
    session.updatedAt = this.now()
  }

  /**
   * Record a decision.
   * @param session - Session to update.
   * @param decision - Decision text.
   */
  addDecision(session: SessionRecord, decision: string): void {
    session.context.decisions = [...new Set([...session.context.decisions, decision])]
    session.updatedAt = this.now()
  }
}
