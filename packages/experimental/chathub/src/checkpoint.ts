/** Context snapshots written before ChatHub model switches. */

import { createCheckpointId } from './ids.ts'
import { clonePlan, memoryHighlights, sessionFacts } from './session-memory.ts'
import type { CheckpointRequest, ICheckpointService, SessionCheckpoint, ChatSessionRecord } from './types.ts'

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
    const done = plan.filter(step => step.status === 'done').length
    const checkpoint: SessionCheckpoint = {
      id: createCheckpointId(request.now, ++this.sequence),
      createdAt: request.now,
      provider: request.provider,
      objective: session.goal,
      summary: `${session.goal} (${done}/${plan.length} plan steps done, ${facts.length} facts, `
        + `${openQuestions.length} open questions)`,
      plan,
      facts,
      openQuestions,
      memoryHighlights: memoryHighlights(session),
    }
    if (request.reason !== undefined) checkpoint.modelSwitchReason = request.reason
    return checkpoint
  }
}
