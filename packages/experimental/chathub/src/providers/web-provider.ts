/** Browser-backed provider base class plus the transport seam it drives. */

import { ChatHubError, errorMessage, type ChatHubErrorCode } from '../errors.ts'
import type {
  ChatFinishReason,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ChatUsage,
  IModelProvider,
  ModelCapabilities,
  ModelKind,
  ProviderErrorCode,
  ProviderStatus,
} from '../types.ts'

/** Page-level payload one browser transport sends on the model's own site. */
export interface WebChatPayload {
  /** Provider id the transport opened the session for. */
  providerId: string
  /** System text folded from `systemPrompt` and `system` messages. */
  system: string
  /** Conversation messages without `system` entries. */
  messages: ChatMessage[]
  /** Single prompt rendered in the provider's style for the site's chat box. */
  prompt: string
  /** Whether the rendered prompt carries compiled task context. */
  meta: { origin: 'semantic-context' | 'raw-messages' }
}

/** Answer a browser transport returns before provider normalization. */
export interface WebChatRawResponse {
  content: string
  usage?: ChatUsage
  finishReason?: ChatFinishReason
  metadata?: Record<string, unknown>
}

/** One opened browser chat session bound to a signed-in site. */
export interface WebChatTransportSession {
  /**
   * Send one prompt and wait for the site's complete answer.
   * @param payload - Provider-normalized page payload.
   * @returns The raw answer before normalization.
   */
  send(payload: WebChatPayload): Promise<WebChatRawResponse>
  /**
   * Send one prompt and yield the site's answer as text deltas, when supported.
   * @param payload - Provider-normalized page payload.
   * @returns Text deltas in page order.
   */
  stream?: (payload: WebChatPayload) => AsyncIterable<string>
  /**
   * Release the page or tab backing this session.
   * @returns Resolves when the page is released.
   */
  close(): Promise<void>
}

/** Opener for browser chat sessions; the host owns login and page isolation. */
export interface WebChatTransport {
  /**
   * Open or reuse a signed-in chat session.
   * @param providerId - Site identity the session must belong to.
   * @param sessionKey - Optional site-side conversation to resume.
   * @returns The session when signed in, a closed result explaining why it
   *   could not open, or `undefined` when the user still has to sign in.
   */
  open(providerId: string, sessionKey?: string): Promise<WebChatTransportSession | WebChatTransportClosed | undefined>
}

/** Result from opening a browser session when the site refuses to start one. */
export interface WebChatTransportClosed {
  /** Marker distinguishing this from an open session. */
  closed: true
  /** Why no session could be opened. */
  reason: 'not-signed-in' | 'expired'
}

/** Map a normalized provider failure code to the runtime error code it surfaces. */
function runtimeErrorCode(code: ProviderErrorCode): ChatHubErrorCode {
  switch (code) {
    case 'auth-required':
      return 'provider-not-ready'
    case 'rate-limited':
      return 'rate-limited'
    case 'network-error':
      return 'network-error'
    case 'stream-interrupted':
      return 'stream-interrupted'
    case 'unsupported-capability':
      return 'unsupported-request'
    case 'provider-unavailable':
    case 'unknown':
      return 'provider-call-failed'
  }
}

/** Provider-specific prompt style from the design's adaptation layer. */
export interface WebPromptStyle {
  /** Heading that introduces the compiled task context. */
  heading: string
}

/**
 * Split one request into system text and conversation messages.
 * @param request - Request carrying the caller's messages and system prompt.
 * @returns Trimmed system text and the non-system messages.
 * @throws ChatHubError with `unsupported-request` for tool messages or an empty conversation.
 */
export function splitRequestMessages(request: ChatRequest): { system: string; messages: ChatMessage[] } {
  const system = [request.systemPrompt ?? '', ...request.messages
    .filter(message => message.role === 'system')
    .map(message => message.content)]
    .map(text => text.trim())
    .filter(text => text.length > 0)
    .join('\n\n')
  const messages = request.messages
    .filter(message => message.role !== 'system')
    .map(message => ({ ...message }))
  for (const message of messages) {
    if (message.role === 'tool') {
      throw new ChatHubError(
        'unsupported-request',
        `${request.providerId}: tool messages cannot be represented in a browser chat prompt`,
      )
    }
  }
  if (messages.length === 0) {
    throw new ChatHubError(
      'unsupported-request',
      `${request.providerId}: a browser chat request needs at least one user or assistant message`,
    )
  }
  return { system, messages }
}

/**
 * Render one provider-styled prompt for a browser chat box.
 * @param system - Compiled task context, empty when the caller sent none.
 * @param messages - Conversation messages, in order.
 * @param style - Provider-specific heading.
 * @returns The prompt a transport types into the site's chat box.
 */
export function renderWebPrompt(system: string, messages: readonly ChatMessage[], style: WebPromptStyle): string {
  const conversation = messages.map(message => `${message.role}: ${message.content}`).join('\n')
  return system.length > 0
    ? `${style.heading}\n${system}\n\nConversation:\n${conversation}`
    : `Conversation:\n${conversation}`
}

/**
 * Base adapter for providers reached through a signed-in browser page.
 *
 * Subclasses declare identity, declared capabilities, and prompt style; this
 * class owns readiness, request normalization, streaming, and failure wrapping.
 * The host supplies the transport, so cookies and login state never enter
 * provider code, session state, or logs.
 */
export abstract class WebModelProvider implements IModelProvider {
  /** Site identity used for registry lookup and transport sessions. */
  abstract readonly id: string
  /** Human-readable provider name. */
  abstract readonly name: string
  readonly kind: ModelKind = 'web'
  /** Capabilities this adapter's text payload can carry, not the site's full feature set. */
  abstract readonly capabilities: ModelCapabilities
  /** Heading used to render compiled task context. */
  protected abstract readonly promptStyle: WebPromptStyle

  /** Browser session opener owned by the host. */
  protected readonly transport: WebChatTransport
  #session: WebChatTransportSession | undefined
  #sessionKey: string | undefined
  #closedReason: 'not-signed-in' | 'expired' | undefined
  #initialized = false

  /**
   * @param transport - Opener for the provider's signed-in browser sessions.
   */
  constructor(transport: WebChatTransport) {
    this.transport = transport
  }

  /**
   * Open the signed-in browser session; readiness follows the site login state.
   * @returns Resolves when the transport has answered.
   */
  async init(): Promise<void> {
    const result = await this.transport.open(this.id, this.#sessionKey)
    this.#initialized = true
    this.applyOpenResult(result)
  }

  /**
   * Report whether a signed-in session is currently open.
   * @returns `true` once {@link init} or {@link switchSession} opened a session.
   */
  async isReady(): Promise<boolean> {
    return Promise.resolve(this.#session !== undefined)
  }

  /**
   * Report the provider's connection state for login, refresh, or fallback decisions.
   * @returns The current lifecycle state.
   */
  healthStatus(): Promise<ProviderStatus> {
    if (this.#session !== undefined) return Promise.resolve('ready')
    if (!this.#initialized) return Promise.resolve('not-started')
    return Promise.resolve(this.#closedReason === 'expired' ? 'expired' : 'needs-auth')
  }

  /**
   * Reopen the site session under another conversation key.
   * @param sessionKey - Site-side conversation to resume next.
   * @returns Resolves when the former session closed and the new one opened.
   */
  async switchSession(sessionKey: string): Promise<void> {
    this.#sessionKey = sessionKey
    await this.close()
    this.applyOpenResult(await this.transport.open(this.id, sessionKey))
  }

  /**
   * Send one turn and normalize the site's answer.
   * @param request - The provider-agnostic turn.
   * @returns The normalized answer.
   */
  async sendMessage(request: ChatRequest): Promise<ChatResponse> {
    const payload = this.normalizeRequest(request)
    try {
      const raw = await this.session().send(payload)
      return this.normalizeResponse(raw, request.sessionId, this.id)
    } catch (error) {
      throw this.failure(error)
    }
  }

  /**
   * Stream one turn, using the session's delta stream when it offers one.
   * @param request - The provider-agnostic turn.
   * @returns Normalized chunks, ending with the finish reason.
   */
  async *streamMessage(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const payload = this.normalizeRequest(request)
    const session = this.session()
    const stream = session.stream
    if (stream === undefined) {
      try {
        const raw = await session.send(payload)
        yield {
          index: 0,
          content: raw.content,
          finishReason: raw.finishReason ?? 'stop',
          metadata: raw.usage === undefined ? {} : { usage: raw.usage },
        }
        return
      } catch (error) {
        throw this.failure(error)
      }
    }
    try {
      for await (const delta of stream(payload)) {
        yield { index: 0, delta }
      }
    } catch (error) {
      throw this.failure(error)
    }
    yield { index: 0, finishReason: 'stop' }
  }

  /**
   * Release the current browser session; repeated calls are no-ops.
   * @returns Resolves when the session closed.
   */
  async close(): Promise<void> {
    const session = this.#session
    this.#session = undefined
    this.#initialized = false
    this.#closedReason = undefined
    if (session !== undefined) await session.close()
  }

  /**
   * Store an open result as either a live session or a recorded close reason.
   * @param result - Value returned by the transport's `open`.
   */
  private applyOpenResult(result: WebChatTransportSession | WebChatTransportClosed | undefined): void {
    if (isClosedResult(result)) {
      this.#session = undefined
      this.#closedReason = result.reason
    } else {
      this.#session = result
      this.#closedReason = undefined
    }
  }

  /**
   * Turn the request into the payload a browser transport types on the site.
   * @param request - The provider-agnostic turn.
   * @returns The normalized page payload.
   */
  protected normalizeRequest(request: ChatRequest): WebChatPayload {
    const { system, messages } = splitRequestMessages(request)
    return {
      providerId: this.id,
      system,
      messages,
      prompt: renderWebPrompt(system, messages, this.promptStyle),
      meta: { origin: system.length > 0 ? 'semantic-context' : 'raw-messages' },
    }
  }

  /**
   * Shape a raw site answer into the provider-agnostic response.
   * @param raw - Answer returned by the browser session.
   * @param sessionId - Session that issued the turn.
   * @param providerId - Provider that answered.
   * @returns The normalized response.
   */
  protected normalizeResponse(raw: WebChatRawResponse, sessionId: string, providerId: string): ChatResponse {
    return {
      providerId,
      sessionId,
      content: raw.content,
      ...raw.usage === undefined ? {} : { usage: raw.usage },
      finishReason: raw.finishReason ?? 'stop',
      ...raw.metadata === undefined ? {} : { metadata: raw.metadata },
    }
  }

  /**
   * Require an open session before sending.
   * @returns The open browser session.
   * @throws ChatHubError with `provider-not-ready` when no session is open.
   */
  protected session(): WebChatTransportSession {
    if (this.#session === undefined) {
      throw new ChatHubError(
        'provider-not-ready',
        `${this.id}: call init() and finish the browser login before sending a turn`,
      )
    }
    return this.#session
  }

  /**
   * Wrap a transport failure in the provider's typed error.
   * @param error - Rejected value from the browser session.
   * @returns The structured provider failure.
   */
  protected failure(error: unknown): ChatHubError {
    if (error instanceof ChatHubError) return error
    const code = this.normalizeError(error)
    return new ChatHubError(
      runtimeErrorCode(code),
      `${this.id}: ${errorMessage(error)}`,
      { cause: error },
    )
  }

  /**
   * Reduce a raw transport rejection to a stable provider failure code.
   *
   * Subclasses override this for site-specific message patterns; the default
   * matches common auth, rate-limit, network, and stream-interruption signals.
   * @param error - Rejected value from the browser session.
   * @returns The stable failure category.
   */
  normalizeError(error: unknown): ProviderErrorCode {
    const message = errorMessage(error).toLowerCase()
    if (/(auth|login|signed.?out|expired|session.*expired|unauthorized)/.test(message)) {
      return 'auth-required'
    }
    if (/(rate.?limit|too many requests|429|throttl)/.test(message)) {
      return 'rate-limited'
    }
    if (/(network|timeout|econnrefused|fetch failed|enotfound|aborted)/.test(message)) {
      return 'network-error'
    }
    if (/(stream|interrupt|chunk|connection.*reset)/.test(message)) {
      return 'stream-interrupted'
    }
    if (/(unsupported|not supported|capability)/.test(message)) {
      return 'unsupported-capability'
    }
    if (/(unavailable|503|502|overloaded|maintenance)/.test(message)) {
      return 'provider-unavailable'
    }
    return 'unknown'
  }
}

/**
 * Narrow a transport open result to its closed variant.
 * @param result - Value returned by `WebChatTransport.open`.
 * @returns `true` when the result is a closed marker rather than a session.
 */
function isClosedResult(
  result: WebChatTransportSession | WebChatTransportClosed | undefined,
): result is WebChatTransportClosed {
  return result !== undefined && 'closed' in result
}
