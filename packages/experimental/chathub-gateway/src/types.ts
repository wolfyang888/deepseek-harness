/**
 * Gateway configuration, resolved site roster, and failure mapping inputs.
 *
 * @module @deepseek-ai/dsh-experimental-chathub-gateway/types
 */

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
