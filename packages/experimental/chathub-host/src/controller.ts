/**
 * Session lifecycle, persistence, and model switching behind the `chatHub`
 * Remote namespace. The controller owns the ChatHub orchestration objects and
 * the `chathub` storage domain; it never exposes the registry or transport
 * objects to the panel, only DTOs with stable failure codes.
 * @module @deepseek-ai/dsh-experimental-chathub-host/controller
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  ChatHubError,
  CheckpointService,
  ContextCompiler,
  SessionCompactionService,
  SessionManager,
  SessionTimelineService,
  type ChatMessage,
  type ChatSessionRecord,
  type IModelProvider,
  type IProviderRegistry,
  type ProviderStatus,
  type SessionRuntimeStatus,
  type SessionTimelineEntry,
} from '@deepseek-ai/dsh-experimental-chathub'
import { chatHubDomainSpec, ChatHubRepository } from './storage.ts'
import type {
  ChatHubCreateInput,
  ChatHubPanelState,
  ChatHubProviderView,
  ChatHubSessionSummary,
  ChatHubSessionView,
  ChatHubSwitchResult,
  ChatHubTurnResult,
  ProviderStatus as PanelProviderStatus,
} from './types.ts'

/** ChatHubController construction inputs. */
export interface ChatHubControllerOptions {
  /** Provider registry shared with the transport service; login and reauth stay there. */
  registry: IProviderRegistry
  /** Auto-compaction trigger thresholds; defaults apply when absent. */
  compaction?: { maxMessages?: number; minGap?: number }
  /** Clock override for deterministic ids and timestamps in tests. */
  now?: () => number
}

/** Map a readiness probe's status onto the panel-facing connection state. */
function panelStatus(status: ProviderStatus): PanelProviderStatus {
  return status === 'expired' ? 'needs-auth' : status
}

/**
 * The `chatHub` Remote service: session CRUD, one-turn sends, checkpointed
 * model switches, and restart recovery over the `chathub` storage domain.
 * ChatHub messages never enter Harness session logs; they live only here.
 */
export class ChatHubController extends TypertRemoteService {
  static inject = ['typert', 'storageDomain']

  private readonly registry: IProviderRegistry
  private readonly manager: SessionManager
  private readonly compaction: SessionCompactionService
  /** Named `timelineService` because the `timeline` Remote method owns the instance property. */
  private readonly timelineService: SessionTimelineService
  private readonly now: () => number
  private readonly records = new Map<string, ChatSessionRecord>()
  private repositoryPromise?: Promise<ChatHubRepository>
  private loadedPromise?: Promise<ChatHubRepository>

  /**
   * @param ctx - Host context that owns the controller lifetime.
   * @param options - Shared registry and optional clock override.
   */
  constructor(ctx: Context, options: ChatHubControllerOptions) {
    super(ctx, 'chatHub', { namespace: 'chatHub' })
    this.registry = options.registry
    this.now = options.now ?? Date.now
    this.timelineService = new SessionTimelineService({ now: this.now })
    this.compaction = new SessionCompactionService({
      timeline: this.timelineService,
      now: this.now,
      ...options.compaction === undefined ? {} : {
        maxMessages: options.compaction.maxMessages,
        minGap: options.compaction.minGap,
      },
    })
    this.manager = new SessionManager({
      registry: options.registry,
      compiler: new ContextCompiler(),
      checkpoints: new CheckpointService(),
      timeline: this.timelineService,
      now: this.now,
    })
  }

  /**
   * Read every provider's identity and panel-facing status plus the session list.
   * @returns The panel state; sessions are restored from storage on first read.
   */
  @Remote
  async state(): Promise<ChatHubPanelState> {
    await this.ensureLoaded()
    return await this.panelState()
  }

  /**
   * Restore every persisted session from storage, then read the panel state.
   * Idempotent: adopting a stored session rewrites its runtime state.
   * @returns The restored panel state.
   */
  @Remote
  async resume(): Promise<ChatHubPanelState> {
    const repository = await this.openRepository()
    await this.hydrate(repository)
    return await this.panelState()
  }

  /**
   * Create a session bound to a registered provider and persist it.
   * @param input - Title, goal, and starting provider.
   * @returns The new session's view.
   * @throws ChatHubError with `provider-not-registered` when the provider is unknown.
   */
  @Remote
  async create(input: ChatHubCreateInput): Promise<ChatHubSessionView> {
    const repository = await this.ensureLoaded()
    const record = this.manager.create({
      title: input.title,
      goal: input.goal,
      provider: input.provider,
    })
    this.records.set(record.id, record)
    await this.persistSession(repository, record)
    return this.sessionView(record)
  }

  /**
   * Run one turn: persist the user message, ask the current provider, persist
   * the answer. A failed turn keeps the user message and a stable
   * `provider: code` error and writes no assistant message.
   * @param sessionId - Session the turn belongs to.
   * @param content - User message text.
   * @returns The turn outcome.
   * @throws ChatHubError when the session is unknown or its provider unregistered.
   */
  @Remote
  async send(sessionId: string, content: string): Promise<ChatHubTurnResult> {
    const repository = await this.ensureLoaded()
    const record = this.requireRecord(sessionId)
    const provider = this.requireProvider(record.currentProvider)
    const userMessage: ChatMessage = { role: 'user', content, timestamp: this.now() }
    // The user message is durable before the provider runs; a failed turn keeps it.
    await repository.appendMessage(sessionId, userMessage)
    this.manager.setStatus(sessionId, 'thinking')
    await this.persistSession(repository, record)

    // Best-effort context compaction: once the transcript grows past the
    // threshold, the current model condenses its own site conversation into a
    // checkpoint merged into the session memory before the real turn runs.
    const transcript = await repository.listMessages(sessionId)
    if (this.compaction.shouldRun(record, transcript.length)) {
      const result = await this.compaction.run(record, provider, transcript.length)
      if (result === 'compacted') await this.persistSession(repository, record)
    }

    const request = this.manager.buildRequest(record, {
      messages: transcript,
    })
    try {
      const response = await provider.sendMessage(request)
      const at = this.now()
      // The speaker name records which model answered, so the panel can sign
      // the bubble even after the session switched providers since.
      const assistant: ChatMessage = { role: 'assistant', content: response.content, timestamp: at, name: record.currentProvider }
      await repository.appendMessage(sessionId, assistant)
      await repository.markProviderUsed(record.currentProvider, at)
      this.manager.setStatus(sessionId, 'done')
      await this.persistSession(repository, record)
      return { sessionId, status: 'done', assistant }
    } catch (error) {
      // The adapter normalized the rejection; the panel only ever sees the code.
      const code = provider.normalizeError?.(error) ?? 'unknown'
      const lastError = `${record.currentProvider}: ${code}`
      this.manager.setStatus(sessionId, 'failed', lastError)
      await this.persistSession(repository, record)
      return { sessionId, status: 'failed', lastError }
    }
  }

  /**
   * Switch the session's provider through the checkpointed handoff: the
   * checkpoint, canonical context, compiled prompt, provider update, and
   * timeline entry all happen inside the session manager before persistence.
   * The switch leaves the session idle, awaiting its next turn.
   * @param sessionId - Session to switch.
   * @param providerId - Target provider; must be registered and ready.
   * @param reason - User-visible reason recorded in history and the checkpoint.
   * @returns The switch outcome.
   * @throws ChatHubError when the session or provider is unknown, the provider
   *   is not ready, or it already owns the session.
   */
  @Remote
  async switch(sessionId: string, providerId: string, reason: string): Promise<ChatHubSwitchResult> {
    const repository = await this.ensureLoaded()
    const record = this.requireRecord(sessionId)
    const outcome = await this.manager.switchProvider(record, providerId, reason)
    this.manager.setStatus(sessionId, 'idle')
    await this.persistSession(repository, record)
    return {
      sessionId,
      from: outcome.record.from,
      to: outcome.record.to,
      checkpointId: outcome.checkpoint.id,
      status: 'idle',
    }
  }

  /**
   * Read one session's stored messages for a panel that renders the transcript.
   * @param sessionId - Session whose messages to read.
   * @returns The session's messages in conversation order.
   * @throws ChatHubError with `session-not-tracked` when the session is unknown.
   */
  @Remote
  async history(sessionId: string): Promise<ChatMessage[]> {
    const repository = await this.ensureLoaded()
    this.requireRecord(sessionId)
    return await repository.listMessages(sessionId)
  }

  /**
   * Read one session's recorded timeline for a panel that shows switches and status changes.
   * @param sessionId - Session whose timeline to read.
   * @returns The session's timeline entries in recording order.
   * @throws ChatHubError with `session-not-tracked` when the session is unknown.
   */
  @Remote
  async timeline(sessionId: string): Promise<SessionTimelineEntry[]> {
    const repository = await this.ensureLoaded()
    this.requireRecord(sessionId)
    return await repository.listTimeline(sessionId)
  }

  /**
   * Read one session's full panel view, including the goal and provider history
   * the switch handoff preserves.
   * @param sessionId - Session to read.
   * @returns The session's view.
   * @throws ChatHubError with `session-not-tracked` when the session is unknown.
   */
  @Remote
  async read(sessionId: string): Promise<ChatHubSessionView> {
    await this.ensureLoaded()
    return this.sessionView(this.requireRecord(sessionId))
  }

  /**
   * Delete a session and every projected message, timeline, and checkpoint row.
   * @param sessionId - Session to delete.
   * @throws ChatHubError with `session-not-tracked` when the session is unknown.
   */
  @Remote
  async delete(sessionId: string): Promise<void> {
    const repository = await this.ensureLoaded()
    this.requireRecord(sessionId)
    await repository.deleteSession(sessionId)
    this.records.delete(sessionId)
    this.manager.forget(sessionId)
  }

  /** Open the storage domain once and remember the disposer. */
  private openRepository(): Promise<ChatHubRepository> {
    this.repositoryPromise ??= this.ctx.storageDomain.open(chatHubDomainSpec).then((domain) => {
      this.ctx.effect(() => () => domain.close(), 'chatHub: storage domain close')
      return ChatHubRepository.from(domain)
    })
    return this.repositoryPromise
  }

  /** Load every persisted session into the manager once per controller. */
  private ensureLoaded(): Promise<ChatHubRepository> {
    this.loadedPromise ??= this.openRepository().then(repository => this.hydrate(repository))
    return this.loadedPromise
  }

  /** Adopt every stored session; idempotent across repeated calls. */
  private async hydrate(repository: ChatHubRepository): Promise<ChatHubRepository> {
    for (const snapshot of await repository.listSessions()) {
      this.records.set(snapshot.record.id, snapshot.record)
      this.manager.adopt(snapshot.record, snapshot.status, snapshot.lastError)
    }
    return repository
  }

  /** Build the panel state from the live provider probes and tracked sessions. */
  private async panelState(): Promise<ChatHubPanelState> {
    return { providers: await this.providerViews(), sessions: this.sessionSummaries() }
  }

  /** Probe every registered provider into its panel view. */
  private async providerViews(): Promise<ChatHubProviderView[]> {
    const views: ChatHubProviderView[] = []
    for (const providerId of this.registry.list()) {
      const provider = this.registry.get(providerId)
      if (provider === undefined) continue
      const health = await this.registry.health(providerId)
      const view: ChatHubProviderView = {
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        capabilities: provider.capabilities,
        status: panelStatus(health.status),
      }
      if (health.failureReason !== undefined) view.failureReason = health.failureReason
      views.push(view)
    }
    return views
  }

  /** Project tracked sessions onto the panel's list, most recently updated first. */
  private sessionSummaries(): ChatHubSessionSummary[] {
    const summaries: ChatHubSessionSummary[] = []
    for (const record of this.records.values()) {
      const state = this.stateOf(record.id)
      const summary: ChatHubSessionSummary = {
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        currentProvider: record.currentProvider,
        status: state.status,
      }
      if (state.lastError !== undefined) summary.lastError = state.lastError
      summaries.push(summary)
    }
    return summaries.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /** One session's panel view with the task facts a switch preserves. */
  private sessionView(record: ChatSessionRecord): ChatHubSessionView {
    const state = this.stateOf(record.id)
    const view: ChatHubSessionView = {
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      currentProvider: record.currentProvider,
      status: state.status,
      goal: record.goal,
      providerHistory: [...record.providerHistory],
    }
    if (state.lastError !== undefined) view.lastError = state.lastError
    return view
  }

  /** Write a session row plus its projected timeline and checkpoints. */
  private async persistSession(repository: ChatHubRepository, record: ChatSessionRecord): Promise<void> {
    const state = this.stateOf(record.id)
    await repository.putSession(record, state.status, state.lastError)
  }

  /** Read one tracked session's runtime state; the panel consumes status and failure. */
  private stateOf(sessionId: string): { status: SessionRuntimeStatus; lastError: string | undefined } {
    const state = this.manager.getState(sessionId)
    /* v8 ignore next -- a tracked record and its manager state are always populated together */
    return { status: state?.status ?? 'idle', lastError: state?.lastError }
  }

  /**
   * @param sessionId - Session id from a Remote call.
   * @returns The tracked record.
   * @throws ChatHubError with `session-not-tracked` when the session is unknown.
   */
  private requireRecord(sessionId: string): ChatSessionRecord {
    const record = this.records.get(sessionId)
    if (record === undefined) {
      throw new ChatHubError('session-not-tracked', `ChatHub does not track session "${sessionId}".`)
    }
    return record
  }

  /**
   * @param providerId - Provider id from a Remote call.
   * @returns The registered provider.
   * @throws ChatHubError with `provider-not-registered` when the id is unknown.
   */
  private requireProvider(providerId: string): IModelProvider {
    const provider = this.registry.get(providerId)
    if (provider === undefined) {
      throw new ChatHubError('provider-not-registered', `ChatHub has no provider "${providerId}".`)
    }
    return provider
  }
}
