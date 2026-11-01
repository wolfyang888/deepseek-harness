/** Session creation, model switching, request preparation, and runtime state. */

import { ChatHubError } from './errors.ts'
import { createSessionId } from './ids.ts'
import { probeProvider } from './provider-registry.ts'
import { clonePlan } from './session-memory.ts'
import type { SessionTimelineService } from './timeline.ts'
import type {
  ChatMessage,
  ChatRequest,
  ICheckpointService,
  IContextCompiler,
  IProviderRegistry,
  ModelSwitchRecord,
  PlanStep,
  SemanticContext,
  SessionCheckpoint,
  ChatSessionRecord,
  SessionRuntimeState,
  SessionRuntimeStatus,
} from './types.ts'

/** SessionManager dependencies and clock. */
export interface SessionManagerOptions {
  registry: IProviderRegistry
  compiler: IContextCompiler
  checkpoints: ICheckpointService
  timeline: SessionTimelineService
  now?: () => number
}

/** Inputs for a new session. */
export interface CreateSessionInput {
  id?: string
  title: string
  goal: string
  provider: string
  plan?: PlanStep[]
}

/** Inputs for preparing one provider request. */
export interface BuildRequestInput {
  messages: ChatMessage[]
  metadata?: Record<string, unknown>
}

/** Everything a model switch produced and preserves. */
export interface ModelSwitchOutcome {
  checkpoint: SessionCheckpoint
  record: ModelSwitchRecord
  context: SemanticContext
  prompt: string
}

/** Owns ChatHub session state and the model-switch handoff. */
export class SessionManager {
  private readonly registry: IProviderRegistry
  private readonly compiler: IContextCompiler
  private readonly checkpoints: ICheckpointService
  private readonly timeline: SessionTimelineService
  private readonly now: () => number
  private readonly states = new Map<string, SessionRuntimeState>()
  private readonly sessions = new Map<string, ChatSessionRecord>()
  private sequence = 0

  /**
   * @param options - Registry, compiler, checkpoint builder, timeline, and optional clock override.
   */
  constructor(options: SessionManagerOptions) {
    this.registry = options.registry
    this.compiler = options.compiler
    this.checkpoints = options.checkpoints
    this.timeline = options.timeline
    this.now = options.now ?? Date.now
  }

  /**
   * Create a session bound to a registered provider.
   * @param input - Title, goal, provider, and optional plan.
   * @returns The new idle session.
   * @throws ChatHubError with `provider-not-registered` when the provider is unknown.
   */
  create(input: CreateSessionInput): ChatSessionRecord {
    if (this.registry.get(input.provider) === undefined) {
      throw new ChatHubError('provider-not-registered', `ChatHub has no provider "${input.provider}".`)
    }
    const at = this.now()
    const plan = input.plan === undefined ? [] : clonePlan(input.plan)
    const session: ChatSessionRecord = {
      id: input.id ?? createSessionId(at, ++this.sequence),
      title: input.title,
      createdAt: at,
      updatedAt: at,
      currentProvider: input.provider,
      providerHistory: [input.provider],
      goal: input.goal,
      plan,
      memory: [],
      context: {
        objective: input.goal,
        plan: clonePlan(plan),
        facts: [],
        openQuestions: [],
        decisions: [],
        workingMemory: [],
        modelSwitchHistory: [],
        lastToolResults: [],
      },
      checkpoints: [],
      timeline: [],
    }
    this.sessions.set(session.id, session)
    this.timeline.record(session, {
      kind: 'session-created',
      provider: session.currentProvider,
      detail: `Session created for ${session.currentProvider}.`,
    })
    this.writeState(session, 'idle')
    return session
  }

  /**
   * Prepare one provider request from the session's compiled context.
   * @param session - Session the turn belongs to.
   * @param input - Conversation messages and optional provider metadata.
   * @returns A request carrying the compiled context and its rendered prompt.
   * @throws ChatHubError with `provider-not-registered` when the current provider is unknown.
   */
  buildRequest(session: ChatSessionRecord, input: BuildRequestInput): ChatRequest {
    if (this.registry.get(session.currentProvider) === undefined) {
      throw new ChatHubError(
        'provider-not-registered',
        `ChatHub has no provider "${session.currentProvider}".`,
      )
    }
    const context = this.compiler.compile(session, session.currentProvider)
    const request: ChatRequest = {
      sessionId: session.id,
      providerId: session.currentProvider,
      messages: input.messages,
      systemPrompt: this.compiler.createPrompt(context, session.currentProvider),
      taskContext: context,
    }
    if (input.metadata !== undefined) request.metadata = input.metadata
    return request
  }

  /**
   * Switch the active provider, writing a checkpoint before the target sees the task.
   * @param session - Session to switch.
   * @param toProvider - Provider id that takes the next turn.
   * @param reason - User-visible reason recorded in history and on the checkpoint.
   * @returns The checkpoint, switch record, compiled context, and target prompt.
   * @throws ChatHubError when the target is the active provider, unknown, or not ready.
   */
  async switchProvider(
    session: ChatSessionRecord,
    toProvider: string,
    reason: string,
  ): Promise<ModelSwitchOutcome> {
    if (session.currentProvider === toProvider) {
      throw new ChatHubError(
        'provider-already-active',
        `ChatHub session "${session.id}" already uses "${toProvider}".`,
      )
    }
    const provider = this.registry.get(toProvider)
    if (provider === undefined) {
      throw new ChatHubError('provider-not-registered', `ChatHub has no provider "${toProvider}".`)
    }
    const health = await probeProvider(provider)
    if (!health.ready) {
      const failureDetail = health.failureReason ?? health.status
      throw new ChatHubError(
        'provider-not-ready',
        `ChatHub provider "${toProvider}" is not ready: ${failureDetail}.`,
      )
    }
    const at = this.now()
    const checkpoint = this.checkpoints.generate(session, {
      provider: session.currentProvider,
      reason,
      now: at,
    })
    const context = this.compiler.compile(session, toProvider)
    const record: ModelSwitchRecord = {
      from: session.currentProvider,
      to: toProvider,
      timestamp: at,
      checkpointId: checkpoint.id,
      reason,
    }
    context.modelSwitchHistory = [...context.modelSwitchHistory, record]
    session.currentProvider = toProvider
    session.providerHistory = [...session.providerHistory, toProvider]
    session.context = context
    session.checkpoints = [...session.checkpoints, checkpoint]
    session.updatedAt = at
    this.timeline.record(session, {
      kind: 'provider-switch',
      provider: toProvider,
      detail: `${record.from} -> ${record.to}: ${reason}`,
      checkpointId: checkpoint.id,
    })
    this.writeState(session, 'thinking', checkpoint.id)
    return {
      checkpoint,
      record,
      context,
      prompt: this.compiler.createPrompt(context, toProvider),
    }
  }

  /**
   * Track a session restored from durable storage without re-recording its
   * creation. The record keeps its id, timeline, and checkpoints; the manager
   * only resumes tracking its runtime state.
   * @param session - Persisted session to track again.
   * @param status - Status the storage snapshot recorded; defaults to `idle`.
   * @param lastError - Retained failure from the storage snapshot, when present.
   */
  adopt(session: ChatSessionRecord, status: SessionRuntimeStatus = 'idle', lastError?: string): void {
    this.sessions.set(session.id, session)
    const state: SessionRuntimeState = {
      sessionId: session.id,
      currentProvider: session.currentProvider,
      activeGoal: session.goal,
      status,
    }
    if (lastError !== undefined) state.lastError = lastError
    this.states.set(session.id, state)
  }

  /**
   * Stop tracking a deleted session. The caller owns durable deletion; this
   * only drops the manager's record and runtime state.
   * @param sessionId - Session to stop tracking.
   */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
    this.states.delete(sessionId)
  }

  /**
   * Read a tracked session's runtime state.
   * @param sessionId - Session id to inspect.
   * @returns Its runtime state, or undefined when the manager did not create it.
   */
  getState(sessionId: string): SessionRuntimeState | undefined {
    return this.states.get(sessionId)
  }

  /**
   * Update a tracked session's lifecycle status.
   * @param sessionId - Session id to update.
   * @param status - New status.
   * @param lastError - Optional failure to retain for the next view.
   * @returns The updated runtime state.
   * @throws ChatHubError with `session-not-tracked` when the manager did not create the session.
   */
  setStatus(sessionId: string, status: SessionRuntimeStatus, lastError?: string): SessionRuntimeState {
    const current = this.states.get(sessionId)
    if (current === undefined) {
      throw new ChatHubError('session-not-tracked', `ChatHub does not track session "${sessionId}".`)
    }
    const next: SessionRuntimeState = { ...current, status }
    if (lastError !== undefined) next.lastError = lastError
    this.states.set(sessionId, next)
    const session = this.sessions.get(sessionId)
    /* v8 ignore next -- records and runtime states are always populated together, so a tracked state always has its record */
    if (session !== undefined) {
      this.timeline.record(session, {
        kind: 'status',
        provider: session.currentProvider,
        detail: lastError === undefined ? status : `${status}: ${lastError}`,
      })
    }
    return next
  }

  /**
   * @param session - Session whose state to write.
   * @param status - New status.
   * @param latestCheckpointId - Checkpoint just written, when the transition has one.
   */
  private writeState(
    session: ChatSessionRecord,
    status: SessionRuntimeStatus,
    latestCheckpointId?: string,
  ): void {
    const state: SessionRuntimeState = {
      sessionId: session.id,
      currentProvider: session.currentProvider,
      activeGoal: session.goal,
      status,
    }
    if (latestCheckpointId !== undefined) state.latestCheckpointId = latestCheckpointId
    this.states.set(session.id, state)
  }
}
