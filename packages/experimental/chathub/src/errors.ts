/** Typed failures for ChatHub registration, routing, and session orchestration. */

/** Failure categories ChatHub consumers branch on. */
export type ChatHubErrorCode =
  | 'provider-not-registered'
  | 'provider-not-ready'
  | 'provider-already-active'
  | 'reauth-not-supported'
  | 'no-ready-provider'
  | 'provider-call-failed'
  | 'rate-limited'
  | 'network-error'
  | 'stream-interrupted'
  | 'unsupported-request'
  | 'invalid-retry-policy'
  | 'invalid-compaction-limit'
  | 'plan-step-not-found'
  | 'session-not-tracked'

/** Structured ChatHub failure carrying a stable discriminator. */
export class ChatHubError extends Error {
  /** Category consumers branch on. */
  readonly code: ChatHubErrorCode

  /**
   * @param code - Category consumers branch on.
   * @param message - Actionable detail for the failing operation.
   * @param options - Optional underlying cause.
   */
  constructor(code: ChatHubErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ChatHubError'
    this.code = code
  }
}

/**
 * Render a rejected value for diagnostics.
 * @param error - Rejected value from a provider or readiness probe.
 * @returns Its message when it is an Error, otherwise the string form.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
