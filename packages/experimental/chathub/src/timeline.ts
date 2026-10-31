/** Ordered per-session event log for host views and replay. */

import { createTimelineEntryId } from './ids.ts'
import type { ChatSessionRecord, SessionTimelineEntry, SessionTimelineKind } from './types.ts'

/** Fields supplied when appending one timeline entry. */
export interface TimelineEntryInput {
  kind: SessionTimelineKind
  /** Provider active when the event happened. */
  provider: string
  detail: string
  /** Checkpoint written by the recorded model switch. */
  checkpointId?: string
}

/** Options for reading a session timeline. */
export interface TimelineListOptions {
  /** Keep only the most recent entries. */
  limit?: number
}

/** Appends ordered events to a session record. */
export class SessionTimelineService {
  private sequence = 0
  private readonly now: () => number

  /**
   * @param options - Optional clock override for deterministic ids and timestamps.
   */
  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  /**
   * Append one event to the session's timeline.
   * @param session - Session to update.
   * @param input - Event kind, provider, and detail.
   * @returns The recorded entry.
   */
  record(session: ChatSessionRecord, input: TimelineEntryInput): SessionTimelineEntry {
    const at = this.now()
    const entry: SessionTimelineEntry = {
      id: createTimelineEntryId(at, ++this.sequence),
      kind: input.kind,
      at,
      provider: input.provider,
      detail: input.detail,
    }
    if (input.checkpointId !== undefined) entry.checkpointId = input.checkpointId
    session.timeline.push(entry)
    return entry
  }

  /**
   * Read the session's timeline in recording order.
   * @param session - Session to read.
   * @param options - Optional cap on how many recent entries to keep.
   * @returns A copy of the matching entries.
   */
  list(session: ChatSessionRecord, options: TimelineListOptions = {}): SessionTimelineEntry[] {
    const entries = session.timeline.map(entry => ({ ...entry }))
    return options.limit === undefined ? entries : entries.slice(-options.limit)
  }
}
