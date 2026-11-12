/**
 * Failure mapping: adapter and site failures into OpenAI-wire error responses.
 *
 * The gateway answers with the stable vocabulary the ChatHub layers already
 * publish and names a next action the user can take; it never embeds raw site
 * prose, which would change under a site redesign and could leak page text.
 *
 * @module @deepseek-ai/dsh-experimental-chathub-gateway/errors
 */

import { LlmError, type LlmFailure } from '@deepseek-ai/dsh-llm'
import type { GatewayFailure } from './types.ts'

/** Default pacing backoff when a site reports a wait we cannot read. */
const DEFAULT_RETRY_SECONDS = 30

/**
 * Map one failed turn into the gateway failure vocabulary.
 * @param failure - normalized failure the llm runtime reported.
 * @returns HTTP status, machine code, message naming the next action, and an
 *   optional retry delay.
 */
export function classifyFailure(failure: LlmFailure): GatewayFailure {
  switch (failure.code) {
    case 'AUTH':
      return {
        status: 401,
        code: 'chathub_signed_out',
        message: 'This site is signed out. Open the ChatHub panel in dsh web and sign in, then retry.',
      }
    case 'RATE_LIMIT':
      return {
        status: 429,
        code: 'rate_limit_exceeded',
        message: 'The site is throttling this account. Wait for the retry delay, then retry.',
        retryAfterSeconds: DEFAULT_RETRY_SECONDS,
      }
    case 'SERVER':
      return {
        status: 503,
        code: 'server_error',
        message: 'The site browser is unavailable or its driver needs an update. Retry later or check the ChatHub panel.',
      }
    case 'TRANSPORT':
      return {
        status: 502,
        code: 'server_error',
        message: 'The site could not be reached. Retry later.',
      }
    case 'MALFORMED_RESPONSE':
      return {
        status: 502,
        code: 'server_error',
        message: 'The site model replied outside the call protocol after its repair budget. Retry, or switch to another site.',
      }
    case 'TIMEOUT':
      return {
        status: 504,
        code: 'timeout',
        message: 'The site turn timed out. Retry later.',
      }
    case 'CONTEXT_WINDOW_EXCEEDED':
      return {
        status: 400,
        code: 'context_length_exceeded',
        message: 'The rendered prompt exceeds the site budget. Shorten the conversation or history you resend.',
      }
    default:
      return {
        status: 500,
        code: 'server_error',
        message: failure.message.length > 0 ? failure.message : 'The site turn failed. Retry later.',
      }
  }
}

/**
 * Normalize one thrown value into a gateway failure.
 * @param error - whatever the turn threw.
 * @returns The mapped failure; an unknown non-LlmError becomes a generic 500.
 */
export function failureFromError(error: unknown): GatewayFailure {
  if (error instanceof LlmError) {
    return classifyFailure(error.failure)
  }
  return {
    status: 500,
    code: 'server_error',
    message: error instanceof Error ? error.message : 'The gateway request failed.',
  }
}
