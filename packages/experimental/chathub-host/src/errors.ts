/** Stable transport failure tokens and page-error classification. */

import { errorMessage } from '@deepseek-ai/dsh-experimental-chathub'

/** Failure tokens the host transport raises; every message starts with one. */
export type BrowserTransportErrorCode =
  | 'chathub-signed-out'
  | 'chathub-driver-missing'
  | 'chathub-ui-drift'
  | 'chathub-turn-timeout'
  | 'chathub-busy'
  | 'chathub-network'
  | 'chathub-profile-locked'
  | 'chathub-browser-unavailable'

/** Transport rejection carrying a stable, provider-mappable token. */
export class BrowserTransportError extends Error {
  /** Stable token that provider failure rules match. */
  readonly token: BrowserTransportErrorCode

  /**
   * @param token - stable failure token.
   * @param detail - structural context without site prose.
   * @param options - optional original rejection kept in the cause chain.
   */
  constructor(token: BrowserTransportErrorCode, detail: string, options?: { cause?: unknown }) {
    super(`${token}: ${detail}`, options)
    this.name = 'BrowserTransportError'
    this.token = token
  }
}

/**
 * Reduce a page operation rejection to a stable transport failure.
 * @param error - rejected value from a Playwright call.
 * @param detail - structural context naming the selector or operation.
 * @returns The classified transport failure.
 */
export function classifyPageError(error: unknown, detail: string): BrowserTransportError {
  if (error instanceof BrowserTransportError) return error
  const message = errorMessage(error).toLowerCase()
  if (/target (page|context|browser)|browser has been closed|page has been closed|execution context was destroyed/.test(message)) {
    return new BrowserTransportError('chathub-signed-out', detail, { cause: error })
  }
  if (/(econn|enotfound|fetch failed|net::err|network|socket hang up)/.test(message)) {
    return new BrowserTransportError('chathub-network', detail, { cause: error })
  }
  return new BrowserTransportError('chathub-ui-drift', detail, { cause: error })
}

/**
 * @param error - rejected value.
 * @returns Whether the rejection is a Playwright operation timeout.
 */
export function isOperationTimeout(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    return (error as { name?: unknown }).name === 'TimeoutError'
  }
  return false
}
