/** Task-aware model routing with capability matching, ordered fallbacks, and failure fallback. */

import { ChatHubError, errorMessage } from './errors.ts'
import { probeProvider } from './provider-registry.ts'
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  IModelProvider,
  IProviderRegistry,
  ModelCapabilities,
  SemanticContext,
  SessionRecord,
} from './types.ts'

/** Task class the router uses to select a provider. */
export type TaskType = 'coding' | 'research' | 'quick-answer'

/** One routing request for a turn. */
export interface RouteRequest {
  session: SessionRecord
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

  /**
   * @param options - Registry plus optional per-task routing and fallback order.
   */
  constructor(options: ModelRouterOptions) {
    this.registry = options.registry
    this.routing = options.routing ?? {}
    this.fallbackProviders = options.fallbackProviders ?? []
  }

  /**
   * Select the first ready provider in the candidate order.
   * @param request - Session, task type, and optional per-turn provider preference.
   * @returns The selected provider and why it won.
   * @throws ChatHubError with `no-ready-provider` when every candidate is unavailable.
   */
  async route(request: RouteRequest): Promise<RouteResult> {
    for (const candidate of this.candidates(request)) {
      const provider = this.registry.get(candidate.providerId)
      if (provider === undefined) continue
      if (!(await probeProvider(provider)).ready) continue
      return {
        provider,
        taskType: request.taskType,
        reason: candidate.reason,
        usedFallback: candidate.fallback,
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
    for (const candidate of this.candidates(request)) {
      const provider = this.registry.get(candidate.providerId)
      if (provider === undefined) continue
      if (!(await probeProvider(provider)).ready) continue
      try {
        const response = await provider.sendMessage(this.chatRequest(request, provider.id))
        return {
          provider,
          response,
          usedFallback: attempts.length > 0 || candidate.fallback,
          attempts,
        }
      } catch (error) {
        attempts.push({ providerId: provider.id, error: errorMessage(error) })
      }
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
