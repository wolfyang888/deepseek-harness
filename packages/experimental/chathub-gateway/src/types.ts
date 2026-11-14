/**
 * Gateway configuration, resolved site roster, and failure mapping inputs.
 *
 * @module @deepseek-ai/dsh-experimental-chathub-gateway/types
 */

import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** Wire protocol a request is answered in. */
export type Wire = 'openai' | 'anthropic'

/** Fully resolved gateway configuration; the schema fills every field. */
export interface ChatHubGatewayConfig {
  /** Bind address; the loopback default keeps the gateway machine-local. */
  host: string
  /** Bind port. */
  port: number
  /**
   * Bearer key every request must present when non-empty; empty means no
   * check, which is only safe because the bind address is loopback.
   */
  apiKey: string
  /**
   * Mounted site ids to expose, each as one model on `/v1/models`. Empty
   * means every health-known site of the transport.
   */
  sites: readonly string[]
  /**
   * Wire protocols the gateway serves: `openai` for
   * `/v1/chat/completions`, `anthropic` for `/v1/messages`. A wire left out
   * answers 404 on its routes.
   */
  wires: readonly Wire[]
  /** Pending requests one site accepts before answering 429. */
  maxQueuePerSite: number
  /** Interval between SSE keepalive writes while a site turn is running. */
  keepaliveMs: number
}

/** One `/v1/models` row derived from a mounted site. */
export interface GatewayModelEntry {
  /** Model id, the site id (for example `glm-web`). */
  id: string
  /** Object discriminator the OpenAI wire requires. */
  object: 'model'
  /** Owner label, stable across sites. */
  owned_by: 'chathub'
  /**
   * Sign-in state of the site, surfaced so a listing agent can mark the row
   * instead of discovering it through a failed call.
   */
  status: 'ready' | 'needs-auth'
}

/** Internal classification of one gateway failure before it becomes a response. */
export interface GatewayFailure {
  /** HTTP status the failure maps to. */
  status: number
  /** Stable machine code for the OpenAI `error.code` field. */
  code: string
  /** User-facing message naming the next action, never site prose. */
  message: string
  /** Suggested retry delay in seconds for 429 answers, else absent. */
  retryAfterSeconds?: number
}

export const GATEWAY_READY = 'ready'
export const GATEWAY_NEEDS_AUTH = 'needs-auth'

/**
 * User message both request folds append when the newest wire message is a
 * tool result. The adapter renders the newest user message as the site's
 * current instruction; without this one, an agent loop's next request reads
 * the original task as "now" and the site repeats the call whose result the
 * transcript already shows.
 */
export const TOOL_RESULT_CONTINUATION = 'The tool result above is the newest state of the task. Continue from it; never repeat a call whose result already appears above, and reply with the final answer when the task is done.'

/**
 * One wire's translation of a turn onto HTTP: the frame vocabulary of its SSE
 * stream, its non-streaming response body, and its error bodies. The server
 * runs one shared turn loop against this interface, so the two wires differ
 * only in presentation, never in admission, routing, or failure mapping.
 */
export interface WireCodec {
  /** Keepalive frame written between events while the site turn runs. */
  readonly keepalive: string
  /** @returns The frames that open the SSE stream. */
  openStream(): string[]
  /**
   * @param chunk - one adapter chunk of the turn.
   * @returns The frames the chunk produces on the open stream.
   */
  renderChunk(chunk: StreamChunk): string[]
  /**
   * The renderer records the turn's finish reason while rendering its chunks.
   * @returns The frames that close the stream after a successful turn.
   */
  closeStream(): string[]
  /**
   * @param model - model id the caller asked for.
   * @param chunks - the turn's adapter chunks in order.
   * @returns The non-streaming response body.
   */
  responseBody(model: string, chunks: readonly StreamChunk[]): Record<string, unknown>
  /**
   * @param failure - the mapped failure.
   * @returns The wire's error body for a failure answered before any stream
   *   opened, as the serialized JSON string.
   */
  errorBody(failure: GatewayFailure): string
  /**
   * @param failure - the mapped failure.
   * @returns The frames surfacing the failure on the already-open stream.
   */
  streamFailure(failure: GatewayFailure): string[]
}
