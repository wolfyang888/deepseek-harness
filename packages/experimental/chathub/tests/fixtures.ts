/** Test doubles and fixtures shared by ChatHub specs. */

import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  IModelProvider,
  ModelCapabilities,
  ModelKind,
  PlanStep,
  SessionRecord,
  SemanticContext,
} from '@deepseek-ai/dsh-experimental-chathub'

/** One fake provider's behavior. */
export interface FakeProviderOptions {
  id: string
  kind?: ModelKind
  name?: string
  capabilities?: Partial<ModelCapabilities>
  /** Readiness result, or an error the probe rejects with. */
  ready?: boolean | Error
  /** Response content, or an error `sendMessage` rejects with. */
  response?: string | Error
}

/** A provider double that records every request it receives. */
export class FakeProvider implements IModelProvider {
  readonly id: string
  readonly kind: ModelKind
  readonly name: string
  readonly capabilities: ModelCapabilities
  readonly calls: ChatRequest[] = []
  readonly #ready: boolean | Error
  readonly #response: string | Error

  constructor(options: FakeProviderOptions) {
    this.id = options.id
    this.kind = options.kind ?? 'web'
    this.name = options.name ?? options.id
    this.capabilities = {
      reasoning: false,
      coding: false,
      vision: false,
      webAccess: false,
      streaming: true,
      ...options.capabilities,
    }
    this.#ready = options.ready ?? true
    this.#response = options.response ?? `${options.id} answer`
  }

  async init(): Promise<void> {}

  async isReady(): Promise<boolean> {
    if (this.#ready instanceof Error) throw this.#ready
    return this.#ready
  }

  async sendMessage(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request)
    if (this.#response instanceof Error) throw this.#response
    return {
      providerId: this.id,
      sessionId: request.sessionId,
      content: this.#response,
      finishReason: 'stop',
    }
  }

  async *streamMessage(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    this.calls.push(request)
    if (this.#response instanceof Error) throw this.#response
    yield { index: 0, delta: this.#response, finishReason: 'stop' }
  }

  async close(): Promise<void> {}
}

/**
 * Create a provider double.
 * @param options - Identity, capabilities, readiness, and response behavior.
 * @returns The configured fake provider.
 */
export function fakeProvider(options: FakeProviderOptions): FakeProvider {
  return new FakeProvider(options)
}

/**
 * Create a plan step with sensible defaults.
 * @param overrides - Fields to override.
 * @returns One plan step.
 */
export function planStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: 'p1',
    title: 'locate the error',
    status: 'running',
    summary: 'scanning build output',
    evidence: [],
    ...overrides,
  }
}

/**
 * Create an empty semantic context.
 * @param overrides - Fields to override.
 * @returns A semantic context.
 */
export function semanticContext(overrides: Partial<SemanticContext> = {}): SemanticContext {
  return {
    objective: '',
    plan: [],
    facts: [],
    openQuestions: [],
    decisions: [],
    workingMemory: [],
    modelSwitchHistory: [],
    lastToolResults: [],
    ...overrides,
  }
}

/**
 * Create a session fixture.
 * @param overrides - Fields to override.
 * @returns A session record.
 */
export function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess_20261031_001',
    title: 'Fix the build',
    createdAt: 1,
    updatedAt: 1,
    currentProvider: 'deepseek-web',
    providerHistory: ['deepseek-web'],
    goal: 'fix the build error',
    plan: [],
    memory: [],
    context: semanticContext({ objective: 'fix the build error' }),
    checkpoints: [],
    ...overrides,
  }
}

/**
 * Create one user message.
 * @param content - Message text.
 * @returns A user message.
 */
export function userMessage(content: string): ChatMessage {
  return { role: 'user', content }
}
