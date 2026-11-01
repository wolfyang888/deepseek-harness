/**
 * Durable ChatHub panel state over the Host storage domain: one `chathub`
 * unit whose tables hold sessions, messages, timeline entries, checkpoints,
 * and per-provider notes. The zod schemas validate the shipped format at the
 * durability boundary; the repository projects the orchestration record onto
 * the tables and reassembles it on load.
 * @module @deepseek-ai/dsh-experimental-chathub-host/storage
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  ChatMessage,
  ChatSessionRecord,
  PlanStep,
  SessionCheckpoint,
  SessionRuntimeStatus,
  SessionTimelineEntry,
} from '@deepseek-ai/dsh-experimental-chathub'

const planStep = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'running', 'done', 'blocked']),
  parentId: z.string().optional(),
  summary: z.string(),
  evidence: z.array(z.string()),
})

const memoryEntry = z.object({
  id: z.string(),
  type: z.enum(['fact', 'preference', 'plan', 'lesson']),
  content: z.string(),
  source: z.string(),
  importance: z.number(),
  createdAt: z.number(),
})

const modelSwitchRecord = z.object({
  from: z.string(),
  to: z.string(),
  timestamp: z.number(),
  checkpointId: z.string(),
  reason: z.string(),
})

const toolResultSummary = z.object({
  toolCallId: z.string(),
  name: z.string(),
  summary: z.string(),
  createdAt: z.number(),
})

const semanticContext = z.object({
  objective: z.string(),
  plan: z.array(planStep),
  facts: z.array(z.string()),
  openQuestions: z.array(z.string()),
  decisions: z.array(z.string()),
  workingMemory: z.array(z.string()),
  modelSwitchHistory: z.array(modelSwitchRecord),
  lastToolResults: z.array(toolResultSummary),
})

const chatMessage = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  name: z.string().optional(),
  timestamp: z.number().optional(),
  toolCallId: z.string().optional(),
})

const sessionCheckpoint = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  sessionId: z.string(),
  createdAt: z.number(),
  provider: z.string(),
  objective: z.string(),
  summary: z.string(),
  plan: z.array(planStep),
  facts: z.array(z.string()),
  openQuestions: z.array(z.string()),
  decisions: z.array(z.string()),
  memoryHighlights: z.array(z.string()),
  modelSwitchHistory: z.array(modelSwitchRecord),
  modelSwitchReason: z.string().optional(),
})

const sessionTimelineEntry = z.object({
  id: z.string(),
  kind: z.enum(['session-created', 'provider-switch', 'status', 'memory']),
  at: z.number(),
  provider: z.string(),
  detail: z.string(),
  checkpointId: z.string().optional(),
})

/**
 * One stored session row: the orchestration record minus its timeline and
 * checkpoints, which the `timeline` and `checkpoints` tables project, plus
 * the runtime state the panel restores.
 */
export const chatHubStoredSession = z.object({
  record: z.object({
    id: z.string(),
    title: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    currentProvider: z.string(),
    providerHistory: z.array(z.string()),
    goal: z.string(),
    plan: z.array(planStep),
    memory: z.array(memoryEntry),
    context: semanticContext,
  }),
  status: z.enum(['idle', 'thinking', 'tool-running', 'waiting', 'done', 'failed']),
  lastError: z.string().optional(),
})

/** One stored message row, ordered per session by `seq`. */
export const chatHubStoredMessage = z.object({
  sessionId: z.string(),
  seq: z.number(),
  message: chatMessage,
})

/** One stored timeline row, scoped to its session. */
export const chatHubStoredTimelineEntry = z.object({
  sessionId: z.string(),
  entry: sessionTimelineEntry,
})

/** One stored checkpoint row, scoped to its session. */
export const chatHubStoredCheckpoint = z.object({
  sessionId: z.string(),
  checkpoint: sessionCheckpoint,
})

/** Per-provider panel notes; `lastUsedAt` orders the provider selector by recency. */
export const chatHubProviderState = z.object({
  lastUsedAt: z.number(),
})

export type ChatHubStoredSession = z.infer<typeof chatHubStoredSession>
export type ChatHubStoredMessage = z.infer<typeof chatHubStoredMessage>
export type ChatHubStoredTimelineEntry = z.infer<typeof chatHubStoredTimelineEntry>
export type ChatHubStoredCheckpoint = z.infer<typeof chatHubStoredCheckpoint>
export type ChatHubProviderState = z.infer<typeof chatHubProviderState>

/**
 * The `chathub` domain spec: five tables keyed by session, message, timeline,
 * checkpoint, and provider ids. Table names follow the storage unit-name
 * grammar (lowercase and underscores), so the provider table is
 * `provider_state`.
 */
export const chatHubDomainSpec = defineDomain({
  name: 'chathub',
  version: 1,
  tables: {
    sessions: domainTable<string, ChatHubStoredSession>(chatHubStoredSession),
    messages: domainTable<string, ChatHubStoredMessage>(chatHubStoredMessage),
    timeline: domainTable<string, ChatHubStoredTimelineEntry>(chatHubStoredTimelineEntry),
    checkpoints: domainTable<string, ChatHubStoredCheckpoint>(chatHubStoredCheckpoint),
    provider_state: domainTable<string, ChatHubProviderState>(chatHubProviderState),
  },
})

/** One reassembled session: the full orchestration record plus its restored runtime state. */
export interface ChatHubSessionSnapshot {
  record: ChatSessionRecord
  status: SessionRuntimeStatus
  lastError?: string
}

/**
 * zod's `.optional()` widens readback properties to `T | undefined`, while the
 * ChatHub contracts keep them exact-optional. Stored rows come from JSON and
 * never carry explicit undefined, so reads re-emit only the present keys.
 */
function toPlanStep(step: z.infer<typeof planStep>): PlanStep {
  const { parentId, ...required } = step
  return { ...required, ...(parentId !== undefined && { parentId }) }
}

function toMessage(message: z.infer<typeof chatMessage>): ChatMessage {
  const { name, timestamp, toolCallId, ...required } = message
  return {
    ...required,
    ...(name !== undefined && { name }),
    ...(timestamp !== undefined && { timestamp }),
    ...(toolCallId !== undefined && { toolCallId }),
  }
}

function toTimelineEntry(entry: z.infer<typeof sessionTimelineEntry>): SessionTimelineEntry {
  const { checkpointId, ...required } = entry
  return { ...required, ...(checkpointId !== undefined && { checkpointId }) }
}

function toCheckpoint(checkpoint: z.infer<typeof sessionCheckpoint>): SessionCheckpoint {
  const { modelSwitchReason, plan, ...required } = checkpoint
  return {
    ...required,
    plan: plan.map(toPlanStep),
    ...(modelSwitchReason !== undefined && { modelSwitchReason }),
  }
}

/** Reads and writes the `chathub` domain's five tables. */
export class ChatHubRepository {
  private readonly messageSeqs = new Map<string, number>()

  /**
   * @param sessions - session rows keyed by session id.
   * @param messages - message rows keyed by `${sessionId}/${seq}`.
   * @param timeline - timeline rows keyed by entry id.
   * @param checkpoints - checkpoint rows keyed by checkpoint id.
   * @param providerState - per-provider notes keyed by provider id.
   */
  private constructor(
    private readonly sessions: KvTable<string, ChatHubStoredSession>,
    private readonly messages: KvTable<string, ChatHubStoredMessage>,
    private readonly timeline: KvTable<string, ChatHubStoredTimelineEntry>,
    private readonly checkpoints: KvTable<string, ChatHubStoredCheckpoint>,
    private readonly providerState: KvTable<string, ChatHubProviderState>,
  ) {}

  /**
   * @param domain - The opened `chathub` domain.
   * @returns The repository over its five tables.
   */
  static from(domain: Domain<typeof chatHubDomainSpec>): ChatHubRepository {
    return new ChatHubRepository(
      domain.table('sessions'),
      domain.table('messages'),
      domain.table('timeline'),
      domain.table('checkpoints'),
      domain.table('provider_state'),
    )
  }

  /**
   * Upsert a session row and project the record's timeline entries and
   * checkpoints into their tables. Idempotent: rows are keyed by stable ids.
   * @param record - Orchestration record to persist.
   * @param status - Runtime state the panel restores.
   * @param lastError - Retained stable failure, when the session has one.
   */
  async putSession(record: ChatSessionRecord, status: SessionRuntimeStatus, lastError?: string): Promise<void> {
    const row: ChatHubStoredSession = {
      record: {
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        currentProvider: record.currentProvider,
        providerHistory: [...record.providerHistory],
        goal: record.goal,
        plan: record.plan.map(step => ({ ...step, evidence: [...step.evidence] })),
        memory: record.memory.map(entry => ({ ...entry })),
        context: {
          ...record.context,
          plan: record.context.plan.map(step => ({ ...step, evidence: [...step.evidence] })),
          facts: [...record.context.facts],
          openQuestions: [...record.context.openQuestions],
          decisions: [...record.context.decisions],
          workingMemory: [...record.context.workingMemory],
          modelSwitchHistory: record.context.modelSwitchHistory.map(entry => ({ ...entry })),
          lastToolResults: record.context.lastToolResults.map(entry => ({ ...entry })),
        },
      },
      status,
    }
    if (lastError !== undefined) row.lastError = lastError
    await this.sessions.put(record.id, row)
    for (const entry of record.timeline) {
      await this.timeline.put(entry.id, { sessionId: record.id, entry: { ...entry } })
    }
    for (const checkpoint of record.checkpoints) {
      await this.checkpoints.put(checkpoint.id, { sessionId: record.id, checkpoint: { ...checkpoint } })
    }
  }

  /**
   * Reassemble every stored session, most recently updated first.
   * @returns Snapshots with the record's timeline and checkpoints reattached.
   */
  async listSessions(): Promise<ChatHubSessionSnapshot[]> {
    const snapshots: ChatHubSessionSnapshot[] = []
    for (const [id, row] of this.sessions.entries()) {
      snapshots.push(await this.assemble(id, row))
    }
    return snapshots.sort((left, right) => right.record.updatedAt - left.record.updatedAt)
  }

  /**
   * Reassemble one stored session.
   * @param id - Session id to load.
   * @returns The snapshot, or `undefined` when no row holds the id.
   */
  async getSession(id: string): Promise<ChatHubSessionSnapshot | undefined> {
    const row = this.sessions.get(id)
    return row === undefined ? undefined : await this.assemble(id, row)
  }

  /**
   * Append one message row under the session's next sequence number.
   * @param sessionId - Session the message belongs to.
   * @param message - Message to persist.
   * @returns The stored row's key.
   */
  async appendMessage(sessionId: string, message: ChatMessage): Promise<string> {
    const seq = this.nextSeq(sessionId)
    const key = `${sessionId}/${seq}`
    await this.messages.put(key, { sessionId, seq, message: { ...message } })
    return key
  }

  /**
   * @param sessionId - Session whose messages to read.
   * @returns The session's messages in sequence order.
   */
  // oxlint-disable-next-line typescript/require-await -- In-memory table reads stay promise-returning to match the async write contract.
  async listMessages(sessionId: string): Promise<ChatMessage[]> {
    const rows = [...this.messages.entries()]
      .filter(([, row]) => row.sessionId === sessionId)
      .sort((left, right) => left[1].seq - right[1].seq)
    return rows.map(([, row]) => toMessage(row.message))
  }

  /**
   * @param sessionId - Session whose timeline to read.
   * @returns The session's timeline entries in recording order.
   */
  // oxlint-disable-next-line typescript/require-await -- In-memory table reads stay promise-returning to match the async write contract.
  async listTimeline(sessionId: string): Promise<ChatSessionRecord['timeline']> {
    const rows = [...this.timeline.entries()].filter(([, row]) => row.sessionId === sessionId)
    return rows.map(([, row]) => toTimelineEntry(row.entry))
  }

  /**
   * @param sessionId - Session whose checkpoints to read.
   * @returns The session's checkpoints in creation order.
   */
  // oxlint-disable-next-line typescript/require-await -- In-memory table reads stay promise-returning to match the async write contract.
  async listCheckpoints(sessionId: string): Promise<ChatSessionRecord['checkpoints']> {
    const rows = [...this.checkpoints.entries()].filter(([, row]) => row.sessionId === sessionId)
    return rows.map(([, row]) => toCheckpoint(row.checkpoint))
  }

  /**
   * Remove a session's row and every projected message, timeline, and
   * checkpoint row. Unknown ids are a no-op.
   * @param id - Session id to delete.
   */
  async deleteSession(id: string): Promise<void> {
    await this.sessions.delete(id)
    for (const [key, row] of this.messages.entries()) {
      if (row.sessionId === id) await this.messages.delete(key)
    }
    for (const [key, row] of this.timeline.entries()) {
      if (row.sessionId === id) await this.timeline.delete(key)
    }
    for (const [key, row] of this.checkpoints.entries()) {
      if (row.sessionId === id) await this.checkpoints.delete(key)
    }
  }

  /**
   * Record that a provider just served a turn.
   * @param providerId - Provider the turn used.
   * @param at - Epoch millis of the turn.
   */
  async markProviderUsed(providerId: string, at: number): Promise<void> {
    await this.providerState.put(providerId, { lastUsedAt: at })
  }

  /**
   * @returns Each provider's last-used epoch millis, in table order.
   */
  providerLastUsed(): Record<string, number> {
    const used: Record<string, number> = {}
    for (const [id, state] of this.providerState.entries()) used[id] = state.lastUsedAt
    return used
  }

  /** Reattach a row's projected timeline and checkpoints to its record. */
  private async assemble(id: string, row: ChatHubStoredSession): Promise<ChatHubSessionSnapshot> {
    const [timeline, checkpoints] = await Promise.all([
      this.listTimeline(id),
      this.listCheckpoints(id),
    ])
    const snapshot: ChatHubSessionSnapshot = {
      record: {
        ...row.record,
        plan: row.record.plan.map(toPlanStep),
        context: {
          ...row.record.context,
          plan: row.record.context.plan.map(toPlanStep),
        },
        checkpoints: checkpoints.sort((left, right) => left.createdAt - right.createdAt),
        timeline: timeline.sort((left, right) => left.at - right.at),
      },
      status: row.status,
    }
    if (row.lastError !== undefined) snapshot.lastError = row.lastError
    return snapshot
  }

  /** Next per-session sequence number; the first read backfills from stored rows. */
  private nextSeq(sessionId: string): number {
    const known = this.messageSeqs.get(sessionId)
    if (known !== undefined) {
      this.messageSeqs.set(sessionId, known + 1)
      return known + 1
    }
    let max = 0
    for (const row of this.messages.entries()) {
      if (row[1].sessionId === sessionId && row[1].seq > max) max = row[1].seq
    }
    this.messageSeqs.set(sessionId, max + 1)
    return max + 1
  }
}
