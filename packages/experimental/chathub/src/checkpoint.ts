/** Context snapshots written before ChatHub model switches. */

import { createCheckpointId } from './ids.ts'
import { clonePlan, memoryHighlights, sessionFacts } from './session-memory.ts'
import type { CheckpointRequest, ICheckpointService, SessionCheckpoint, ChatSessionRecord } from './types.ts'

/** Current checkpoint schema version; bump when the shape changes incompatibly. */
export const CHECKPOINT_SCHEMA_VERSION = 1 as const

/** Builds a checkpoint from the session state a switch is leaving behind. */
export class CheckpointService implements ICheckpointService {
  private sequence = 0

  /**
   * Snapshot the session for a model switch.
   * @param session - Session to snapshot.
   * @param request - Provider, optional switch reason, and timestamp.
   * @returns A new checkpoint; the caller decides whether to attach it to the session.
   */
  generate(session: ChatSessionRecord, request: CheckpointRequest): SessionCheckpoint {
    const plan = clonePlan(session.plan)
    const facts = sessionFacts(session)
    const openQuestions = [...session.context.openQuestions]
    const decisions = [...session.context.decisions]
    const done = plan.filter(step => step.status === 'done').length
    const checkpoint: SessionCheckpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      id: createCheckpointId(request.now, ++this.sequence),
      sessionId: session.id,
      createdAt: request.now,
      provider: request.provider,
      objective: session.goal,
      summary: `${session.goal} (${done}/${plan.length} plan steps done, ${facts.length} facts, `
        + `${openQuestions.length} open questions)`,
      plan,
      facts,
      openQuestions,
      decisions,
      memoryHighlights: memoryHighlights(session),
      modelSwitchHistory: session.context.modelSwitchHistory.map(record => ({ ...record })),
    }
    if (request.reason !== undefined) checkpoint.modelSwitchReason = request.reason
    return checkpoint
  }
}

/**
 * Reapply a checkpoint's semantic state onto a session for recovery.
 *
 * Restores objective, plan, facts, open questions, decisions, working-memory
 * highlights, and switch history. The caller owns the provider and runtime
 * status; this only rebuilds the task context a re-entering provider needs.
 * @param session - Session to restore into.
 * @param checkpoint - Checkpoint to rehydrate from.
 * @returns The session with its semantic context rebuilt from the checkpoint.
 */
export function restoreFromCheckpoint(
  session: ChatSessionRecord,
  checkpoint: SessionCheckpoint,
): ChatSessionRecord {
  session.goal = checkpoint.objective
  session.plan = clonePlan(checkpoint.plan)
  session.context = {
    ...session.context,
    objective: checkpoint.objective,
    plan: clonePlan(checkpoint.plan),
    facts: [...checkpoint.facts],
    openQuestions: [...checkpoint.openQuestions],
    decisions: [...checkpoint.decisions],
    workingMemory: [...new Set([...session.context.workingMemory, ...checkpoint.memoryHighlights])],
    modelSwitchHistory: [...checkpoint.modelSwitchHistory],
  }
  session.updatedAt = checkpoint.createdAt
  return session
}
