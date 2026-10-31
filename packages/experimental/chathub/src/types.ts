/** Provider, session, and semantic-context contracts for the ChatHub runtime core. */

/** How a model provider reaches its model. */
export type ModelKind = 'web' | 'api' | 'local'

/** Lifecycle state of one provider's connection to its model. */
export type ProviderStatus = 'not-started' | 'ready' | 'needs-auth' | 'expired' | 'failed'

/**
 * Stable failure categories an adapter maps raw site errors into.
 *
 * Adapters never leak raw site text or DOM fragments across the runtime
 * boundary; `normalizeError` reduces every rejection to one of these codes so
 * orchestration can branch deterministically.
 */
export type ProviderErrorCode =
  | 'auth-required'
  | 'provider-unavailable'
  | 'rate-limited'
  | 'network-error'
  | 'stream-interrupted'
  | 'unsupported-capability'
  | 'unknown'

/** Capabilities a provider advertises to routing and prompt compilation. */
export interface ModelCapabilities {
  reasoning: boolean
  coding: boolean
  vision: boolean
  webAccess: boolean
  streaming: boolean
}

/** Author of one chat message. */
export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

/** One provider-agnostic chat message. */
export interface ChatMessage {
  role: ChatRole
  content: string
  name?: string
  timestamp?: number
  toolCallId?: string
}

/** One request handed to a provider, with the session's semantic task state. */
export interface ChatRequest {
  sessionId: string
  providerId: string
  messages: ChatMessage[]
  systemPrompt?: string
  taskContext?: SemanticContext
  metadata?: Record<string, unknown>
}

/** Token counts reported by a provider. */
export interface ChatUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

/** Why a provider stopped generating. */
export type ChatFinishReason = 'stop' | 'length' | 'tool_calls' | 'error'

/** One normalized provider answer. */
export interface ChatResponse {
  providerId: string
  sessionId: string
  content: string
  usage?: ChatUsage
  finishReason?: ChatFinishReason
  metadata?: Record<string, unknown>
}

/** One normalized streaming fragment. */
export interface ChatStreamChunk {
  index: number
  delta?: string
  content?: string
  finishReason?: string
  metadata?: Record<string, unknown>
}

/** Uniform model adapter implemented by every ChatHub provider. */
export interface IModelProvider {
  readonly id: string
  readonly kind: ModelKind
  readonly name: string
  readonly capabilities: ModelCapabilities

  init(): Promise<void>
  isReady(): Promise<boolean>
  healthStatus?(): Promise<ProviderStatus>
  /**
   * Map a raw provider rejection to a stable failure code.
   *
   * Implementations must not surface raw site HTML, stack frames, or
   * provider-specific message strings; callers branch on the returned code.
   * @param error - Rejected value from the provider's transport.
   * @returns The stable failure category.
   */
  normalizeError?(error: unknown): ProviderErrorCode
  sendMessage(request: ChatRequest): Promise<ChatResponse>
  streamMessage(request: ChatRequest): AsyncIterable<ChatStreamChunk>
  switchSession?(sessionKey: string): Promise<void>
  close(): Promise<void>
}

/** Registry contract consumed by routers and session orchestration. */
export interface IProviderRegistry {
  register(provider: IModelProvider): void
  get(providerId: string): IModelProvider | undefined
  list(): string[]
  getByKind(kind: ModelKind): IModelProvider[]
}

/** Readiness snapshot for one provider. */
export interface ProviderHealth {
  providerId: string
  ready: boolean
  /** Connection state consumers branch on for login, refresh, or fallback. */
  status: ProviderStatus
  /** Epoch millis when this probe completed. */
  lastCheckedAt: number
  /** Stable failure reason when the probe could not confirm readiness. */
  failureReason?: string
}

/** Progress state of one plan step. */
export type PlanStepStatus = 'pending' | 'running' | 'done' | 'blocked'

/** One decomposed task step carried across model switches. */
export interface PlanStep {
  id: string
  title: string
  status: PlanStepStatus
  parentId?: string
  summary: string
  evidence: string[]
}

/** Kind of durable session memory. */
export type MemoryEntryType = 'fact' | 'preference' | 'plan' | 'lesson'

/** One remembered fact, preference, plan note, or lesson. */
export interface MemoryEntry {
  id: string
  type: MemoryEntryType
  content: string
  source: string
  importance: number
  createdAt: number
}

/** One completed provider switch. */
export interface ModelSwitchRecord {
  from: string
  to: string
  timestamp: number
  checkpointId: string
  reason: string
}

/** Condensed result of one tool call kept for the next model. */
export interface ToolResultSummary {
  toolCallId: string
  name: string
  summary: string
  createdAt: number
}

/** Provider-independent task state compiled from a session. */
export interface SemanticContext {
  objective: string
  plan: PlanStep[]
  facts: string[]
  openQuestions: string[]
  decisions: string[]
  workingMemory: string[]
  modelSwitchHistory: ModelSwitchRecord[]
  lastToolResults: ToolResultSummary[]
}

/** Context snapshot written before a model switch. */
export interface SessionCheckpoint {
  /** Schema version for forward-compatible rehydration. */
  schemaVersion: 1
  id: string
  sessionId: string
  createdAt: number
  provider: string
  objective: string
  summary: string
  plan: PlanStep[]
  facts: string[]
  openQuestions: string[]
  decisions: string[]
  memoryHighlights: string[]
  modelSwitchHistory: ModelSwitchRecord[]
  modelSwitchReason?: string
}

/** Durable state of one ChatHub session. */
export interface ChatSessionRecord {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  currentProvider: string
  providerHistory: string[]
  goal: string
  plan: PlanStep[]
  memory: MemoryEntry[]
  context: SemanticContext
  checkpoints: SessionCheckpoint[]
}

/** Lifecycle state exposed to session views. */
export type SessionRuntimeStatus = 'idle' | 'thinking' | 'tool-running' | 'waiting' | 'done'

/** Snapshot of a session's runtime lifecycle. */
export interface SessionRuntimeState {
  sessionId: string
  currentProvider: string
  activeGoal: string
  status: SessionRuntimeStatus
  latestCheckpointId?: string
  lastError?: string
}

/** Inputs for building one checkpoint. */
export interface CheckpointRequest {
  provider: string
  reason?: string
  now: number
}

/** Checkpoint builder contract used by session orchestration. */
export interface ICheckpointService {
  generate(session: ChatSessionRecord, request: CheckpointRequest): SessionCheckpoint
}

/** Semantic compiler contract used by session orchestration. */
export interface IContextCompiler {
  compile(session: ChatSessionRecord, providerId: string): SemanticContext
  createPrompt(context: SemanticContext, providerId: string): string
}
