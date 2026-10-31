/** Session-scoped memory operations and the derivations shared by compilation and checkpoints. */

import { ChatHubError } from './errors.ts'
import { createMemoryEntryId } from './ids.ts'
import type { SessionTimelineService } from './timeline.ts'
import type { MemoryEntry, MemoryEntryType, PlanStep, PlanStepStatus, ChatSessionRecord } from './types.ts'

/** Input for one memory entry. */
export interface RecordMemoryInput {
  type: MemoryEntryType
  content: string
  source: string
  importance?: number
}

/** Bounds applied by one long-session memory compaction. */
export interface MemoryCompactionOptions {
  /** Memory entries kept after deduplication, ordered by importance then recency. */
  maxEntries: number
  /** Most recent working-memory items kept. */
  maxWorkingMemory: number
  /** Most recent tool results kept. */
  maxToolResults: number
  /** Most recent model switches kept. */
  maxModelSwitches: number
}

/** Outcome of one long-session memory compaction. */
export interface MemoryCompactionResult {
  /** Entries removed because they duplicated content or fell outside the bound. */
  removedEntries: MemoryEntry[]
  /** Entries left on the session. */
  retainedEntries: number
}

/** Dependencies for session-scoped memory writes. */
export interface SessionMemoryOptions {
  /** Clock override for deterministic ids and timestamps. */
  now?: () => number
  /** Optional timeline that receives one entry per recorded memory write. */
  timeline?: SessionTimelineService
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
export function memoryHighlights(session: ChatSessionRecord): string[] {
  const ordered = [...session.memory]
    .sort((left, right) => right.importance - left.importance || right.createdAt - left.createdAt)
  return [...new Set(ordered.map(entry => entry.content))]
}

/**
 * Facts recorded for the session, from typed memory entries and the last compiled context.
 * @param session - Session whose facts to read.
 * @returns Unique fact strings.
 */
export function sessionFacts(session: ChatSessionRecord): string[] {
  const recorded = session.memory
    .filter(entry => entry.type === 'fact')
    .map(entry => entry.content)
  return [...new Set([...recorded, ...session.context.facts])]
}

/** Session-scoped memory writes with deterministic, date-stamped entry ids. */
export class SessionMemoryService {
  private sequence = 0
  private readonly now: () => number
  private readonly timeline: SessionTimelineService | undefined

  /**
   * @param options - Optional clock override and timeline for recorded writes.
   */
  constructor(options: SessionMemoryOptions = {}) {
    this.now = options.now ?? Date.now
    this.timeline = options.timeline
  }

  /**
   * Record one memory entry and bump the session update time.
   * @param session - Session to update.
   * @param input - Entry type, content, source, and optional importance.
   * @returns The recorded entry.
   */
  record(session: ChatSessionRecord, input: RecordMemoryInput): MemoryEntry {
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
    this.timeline?.record(session, {
      kind: 'memory',
      provider: session.currentProvider,
      detail: `${entry.type}: ${entry.content}`,
    })
    return entry
  }

  /**
   * Replace the session plan.
   * @param session - Session to update.
   * @param plan - New plan steps.
   */
  setPlan(session: ChatSessionRecord, plan: PlanStep[]): void {
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
  updatePlanStep(session: ChatSessionRecord, stepId: string, update: PlanStepUpdate): PlanStep {
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
  addOpenQuestion(session: ChatSessionRecord, question: string): void {
    session.context.openQuestions = [...new Set([...session.context.openQuestions, question])]
    session.updatedAt = this.now()
  }

  /**
   * Remove an open question.
   * @param session - Session to update.
   * @param question - Question text to close.
   */
  resolveOpenQuestion(session: ChatSessionRecord, question: string): void {
    session.context.openQuestions = session.context.openQuestions.filter(open => open !== question)
    session.updatedAt = this.now()
  }

  /**
   * Record a decision.
   * @param session - Session to update.
   * @param decision - Decision text.
   */
  addDecision(session: ChatSessionRecord, decision: string): void {
    session.context.decisions = [...new Set([...session.context.decisions, decision])]
    session.updatedAt = this.now()
  }

  /**
   * Bound the session's growing memory so long sessions keep the most useful state.
   *
   * Memory entries are deduplicated by type and content, then kept by importance
   * and recency. Working memory, tool results, and model switches keep their
   * most recent values. Facts, decisions, and open questions are curated state
   * and stay untouched.
   * @param session - Session to compact.
   * @param options - Positive bounds for each retained collection.
   * @returns Removed entries and the retained count.
   * @throws ChatHubError with `invalid-compaction-limit` for a non-positive or
   *   fractional bound.
   */
  compact(session: ChatSessionRecord, options: MemoryCompactionOptions): MemoryCompactionResult {
    assertLimit('maxEntries', options.maxEntries)
    assertLimit('maxWorkingMemory', options.maxWorkingMemory)
    assertLimit('maxToolResults', options.maxToolResults)
    assertLimit('maxModelSwitches', options.maxModelSwitches)
    const removedEntries: MemoryEntry[] = []
    const retained: MemoryEntry[] = []
    const seen = new Set<string>()
    const ordered = [...session.memory]
      .sort((left, right) => right.importance - left.importance || right.createdAt - left.createdAt)
    for (const entry of ordered) {
      const key = `${entry.type}\u0000${entry.content}`
      if (seen.has(key)) {
        removedEntries.push(entry)
        continue
      }
      seen.add(key)
      if (retained.length >= options.maxEntries) {
        removedEntries.push(entry)
        continue
      }
      retained.push(entry)
    }
    session.memory = retained
    session.context.workingMemory = recentUnique(session.context.workingMemory, options.maxWorkingMemory)
    session.context.lastToolResults = session.context.lastToolResults.slice(-options.maxToolResults)
    session.context.modelSwitchHistory = session.context.modelSwitchHistory.slice(-options.maxModelSwitches)
    session.updatedAt = this.now()
    return { removedEntries, retainedEntries: retained.length }
  }
}

/**
 * @param name - Bound name for the diagnostic.
 * @param value - Bound supplied by the caller.
 */
function assertLimit(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ChatHubError(
      'invalid-compaction-limit',
      `ChatHub compaction bound "${name}" must be a positive integer.`,
    )
  }
}

/**
 * @param values - Strings that may repeat.
 * @param limit - Number of most recent values to keep.
 * @returns The last values without duplicates.
 */
function recentUnique(values: string[], limit: number): string[] {
  const unique = [
    ...new Set(values),
  ]
  return unique.slice(-limit)
}
