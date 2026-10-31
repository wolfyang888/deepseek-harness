/** Task-aware model routing with capability matching, ordered fallbacks, and failure fallback. */

import { ChatHubError, errorMessage, type ChatHubErrorCode } from './errors.ts'
import { probeProvider } from './provider-registry.ts'
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  IModelProvider,
  IProviderRegistry,
  ModelCapabilities,
  ProviderErrorCode,
  SemanticContext,
  ChatSessionRecord,
} from './types.ts'

/** Task class the router uses to select a provider. */
export type TaskType = 'coding' | 'research' | 'quick-answer'

/** One routing request for a turn. */
export interface RouteRequest {
  session: ChatSessionRecord
  taskType: TaskType
  preferredProvider?: string
}

/** The provider selected for a turn. */
export interface RouteResult {
  provider: IModelProvider
  taskType: TaskType
  reason: string
  usedFallback: boolean
}

/** Router dependencies and routing policy. */
export interface ModelRouterOptions {
  registry: IProviderRegistry
  routing?: Partial<Record<TaskType, string>>
  fallbackProviders?: string[]
  retry?: RetryPolicy
}

/** Failure codes a retry policy may treat as transient. */
export type RetryableErrorCode = ChatHubErrorCode | ProviderErrorCode

/** Retry policy applied inside one provider before the router falls back. */
export interface RetryPolicy {
  /** Total attempts per provider, including the first call. */
  maxAttempts: number
  /** Delay between attempts in milliseconds. */
  delayMs: number
  /** Failure codes that justify retrying the same provider. */
  retryOn: readonly RetryableErrorCode[]
}

/** One routed turn with the semantic context the selected provider receives. */
export interface CompletionRequest extends RouteRequest {
  messages: ChatMessage[]
  taskContext: SemanticContext
  systemPrompt?: string
  metadata?: Record<string, unknown>
}

/** One failed provider call during a fallback chain. */
export interface ProviderAttempt {
  providerId: string
  /** One-based attempt number on that provider. */
  attempt: number
  error: string
}

/** The provider that produced a response, plus every earlier failed attempt. */
export interface CompletionResult {
  provider: IModelProvider
  response: ChatResponse
  usedFallback: boolean
  attempts: ProviderAttempt[]
}

/** One provider in the candidate order. */
interface RouteCandidate {
  providerId: string
  reason: string
  fallback: boolean
}

/** Selects providers by task type and calls them with ordered fallbacks. */
export class ModelRouter {
  private readonly registry: IProviderRegistry
  private readonly routing: Partial<Record<TaskType, string>>
  private readonly fallbackProviders: string[]
  private readonly retry: RetryPolicy | undefined

  /**
   * @param options - Registry plus optional routing, fallback order, and retry policy.
   * @throws ChatHubError with `invalid-retry-policy` when a policy bound is invalid.
   */
  constructor(options: ModelRouterOptions) {
    this.registry = options.registry
    this.routing = options.routing ?? {}
    this.fallbackProviders = options.fallbackProviders ?? []
    this.retry = options.retry
    if (this.retry !== undefined) assertRetryPolicy(this.retry)
  }

  /**
   * Select the first ready provider in the candidate order.
   * @param request - Session, task type, and optional per-turn provider preference.
   * @returns The selected provider and why it won.
   * @throws ChatHubError with `no-ready-provider` when every candidate is unavailable.
   */
  async route(request: RouteRequest): Promise<RouteResult> {
    let usedFallback = false
    for (const candidate of this.candidates(request)) {
      const provider = this.registry.get(candidate.providerId)
      if (provider === undefined) {
        usedFallback = true
        continue
      }
      if (!(await probeProvider(provider)).ready) {
        usedFallback = true
        continue
      }
      return {
        provider,
        taskType: request.taskType,
        reason: candidate.reason,
        usedFallback: candidate.fallback || usedFallback,
      }
    }
    throw new ChatHubError('no-ready-provider', `No ready provider routes ${request.taskType}.`)
  }

  /**
   * Send one turn, retrying the next candidate when a provider call fails.
   * @param request - Routed turn with messages and semantic context.
   * @returns The first successful response and every earlier failed attempt.
   * @throws ChatHubError with `no-ready-provider` when no candidate is ready, or
   * `provider-call-failed` when every ready provider rejects.
   */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const attempts: ProviderAttempt[] = []
    let usedFallback = false
    for (const candidate of this.candidates(request)) {
      const provider = this.registry.get(candidate.providerId)
      if (provider === undefined) {
        usedFallback = true
        continue
      }
      if (!(await probeProvider(provider)).ready) {
        usedFallback = true
        continue
      }
      const maxAttempts = this.retry?.maxAttempts ?? 1
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const response = await provider.sendMessage(this.chatRequest(request, provider.id))
          return {
            provider,
            response,
            usedFallback: candidate.fallback || usedFallback,
            attempts,
          }
        } catch (error) {
          attempts.push({ providerId: provider.id, attempt, error: errorMessage(error) })
          if (this.retry === undefined || attempt >= maxAttempts) break
          if (!retryable(error, this.retry.retryOn, provider)) break
          if (this.retry.delayMs > 0) await delay(this.retry.delayMs)
        }
      }
      usedFallback = true
    }
    if (attempts.length === 0) {
      throw new ChatHubError('no-ready-provider', `No ready provider routes ${request.taskType}.`)
    }
    const failures = attempts.map(attempt => `${attempt.providerId}: ${attempt.error}`).join('; ')
    throw new ChatHubError('provider-call-failed', `Every ready provider failed: ${failures}.`)
  }

  /**
   * Build the candidate order: configured policy, explicit preference, capability matches,
   * configured fallbacks, then every other provider.
   * @param request - Routing request.
   * @returns Deduplicated candidates in preference order.
   */
  private candidates(request: RouteRequest): RouteCandidate[] {
    const primary: RouteCandidate[] = []
    const configured = this.routing[request.taskType]
    if (configured !== undefined) {
      primary.push({ providerId: configured, reason: `routing.${request.taskType}`, fallback: false })
    }
    if (request.preferredProvider !== undefined) {
      primary.push({ providerId: request.preferredProvider, reason: 'request.preferredProvider', fallback: false })
    }
    if (request.taskType === 'quick-answer') {
      primary.push({
        providerId: request.session.currentProvider,
        reason: 'session.currentProvider',
        fallback: false,
      })
    }
    const fallbacks = this.fallbackProviders.map(providerId => ({
      providerId,
      reason: 'fallbackProviders',
      fallback: true,
    }))
    const remaining = this.registry.list().map(providerId => ({
      providerId,
      reason: 'registry',
      fallback: true,
    }))
    return dedupe([...primary, ...this.capabilityCandidates(request.taskType), ...fallbacks, ...remaining])
  }

  /**
   * @param taskType - Task class to match.
   * @returns Providers advertising the capability that task class needs.
   */
  private capabilityCandidates(taskType: TaskType): RouteCandidate[] {
    const candidates: RouteCandidate[] = []
    for (const providerId of this.registry.list()) {
      const provider = this.registry.get(providerId)
      if (provider === undefined) continue
      if (!matchesCapability(provider.capabilities, taskType)) continue
      candidates.push({ providerId, reason: `capability.${taskType}`, fallback: false })
    }
    return candidates
  }

  /**
   * @param request - Routed turn.
   * @param providerId - Provider the request targets.
   * @returns The normalized request with optional fields only when supplied.
   */
  private chatRequest(request: CompletionRequest, providerId: string): ChatRequest {
    const chatRequest: ChatRequest = {
      sessionId: request.session.id,
      providerId,
      messages: request.messages,
      taskContext: request.taskContext,
    }
    if (request.systemPrompt !== undefined) chatRequest.systemPrompt = request.systemPrompt
    if (request.metadata !== undefined) chatRequest.metadata = request.metadata
    return chatRequest
  }
}

/**
 * @param capabilities - Provider capabilities.
 * @param taskType - Task class to match.
 * @returns Whether the capabilities suit the task class.
 */
function matchesCapability(capabilities: ModelCapabilities, taskType: TaskType): boolean {
  if (taskType === 'coding') return capabilities.coding
  if (taskType === 'research') return capabilities.webAccess
  return false
}

/**
 * @param candidates - Ordered candidates, possibly repeating one provider.
 * @returns The first occurrence of each provider id.
 */
function dedupe(candidates: RouteCandidate[]): RouteCandidate[] {
  const seen = new Set<string>()
  const unique: RouteCandidate[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate.providerId)) continue
    seen.add(candidate.providerId)
    unique.push(candidate)
  }
  return unique
}

/**
 * @param policy - Retry policy supplied by the host.
 * @throws ChatHubError with `invalid-retry-policy` for invalid attempt or delay bounds.
 */
function assertRetryPolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new ChatHubError(
      'invalid-retry-policy',
      'ChatHub retry maxAttempts must be a positive integer.',
    )
  }
  if (!Number.isInteger(policy.delayMs) || policy.delayMs < 0) {
    throw new ChatHubError(
      'invalid-retry-policy',
      'ChatHub retry delayMs must be a non-negative integer.',
    )
  }
}

/**
 * @param error - Rejected provider call.
 * @param codes - Codes the policy treats as transient.
 * @param provider - Provider that rejected the call, whose normalizer classifies its cause.
 * @returns Whether the call may be retried on the same provider.
 */
function retryable(
  error: unknown,
  codes: readonly RetryableErrorCode[],
  provider: IModelProvider,
): boolean {
  return failureCodes(error, provider).some(code => codes.includes(code))
}

/**
 * Collect every stable failure code one rejection carries.
 *
 * A `ChatHubError` exposes its wrapper code; when it wraps a provider rejection,
 * the provider's normalizer supplies the underlying failure category, so retry
 * policies branch on stable failure semantics instead of the wrapper's aggregate.
 * @param error - Rejected provider call.
 * @param provider - Provider whose normalizer classifies a wrapped cause.
 * @returns The wrapper code plus any provider-level code derived from the cause.
 */
function failureCodes(error: unknown, provider: IModelProvider): RetryableErrorCode[] {
  if (error instanceof ChatHubError) {
    const codes: RetryableErrorCode[] = [error.code]
    if (provider.normalizeError !== undefined && error.cause !== undefined) {
      codes.push(provider.normalizeError(error.cause))
    }
    return codes
  }
  if (provider.normalizeError !== undefined) return [provider.normalizeError(error)]
  return ['unknown']
}

/**
 * @param delayMs - Non-negative delay in milliseconds.
 * @returns Resolves after the delay.
 */
function delay(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs))
}
