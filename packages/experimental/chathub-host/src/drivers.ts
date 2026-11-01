/** Shipped site drivers and validated host overrides. */

import { webProviderAdapters } from '@deepseek-ai/dsh-experimental-chathub'
import type { SiteDriverConfig, SiteDrivers } from './types.ts'

/** Path patterns that identify a site's login, logout, or expired-session redirect. */
const SIGNED_OUT_PATH = 'login|logout|sign_in|signin|expired'

/** Site facts for the four shipped browser adapters; hosts override any field. */
export const DEFAULT_SITE_DRIVERS: Readonly<SiteDrivers> = {
  'deepseek-web': {
    url: 'https://chat.deepseek.com/',
    input: 'textarea',
    answer: '.ds-markdown',
    signedOutPath: SIGNED_OUT_PATH,
    submitKey: 'Enter',
  },
  'chatgpt-web': {
    url: 'https://chatgpt.com/',
    input: '#prompt-textarea',
    answer: '[data-message-author-role="assistant"] .markdown',
    loginWall: '[data-testid="login-button"]',
    signedOutPath: SIGNED_OUT_PATH,
    submitKey: 'Enter',
  },
  'gemini-web': {
    url: 'https://gemini.google.com/app',
    input: '.ql-editor',
    answer: 'model-response .markdown',
    signedOutPath: SIGNED_OUT_PATH,
    submitKey: 'Enter',
  },
  'doubao-web': {
    url: 'https://www.doubao.com/chat',
    input: '.ProseMirror[contenteditable="true"]',
    answer: '[class*="markdown"]',
    signedOutPath: SIGNED_OUT_PATH,
    submitKey: 'Enter',
  },
}

/** Shipped driver ids; every one has a shipped adapter. */
const SHIPPED_PROVIDER_IDS = Object.keys(DEFAULT_SITE_DRIVERS)

/**
 * Merge host overrides into the shipped drivers and validate the result.
 * @param overrides - provider-id keyed partial driver fields.
 * @returns Complete drivers for every shipped provider.
 * @throws Error when an override names no shipped provider or leaves a field invalid.
 */
export function resolveSiteDrivers(
  overrides: Record<string, Partial<SiteDriverConfig>> = {},
): SiteDrivers {
  for (const providerId of Object.keys(overrides)) {
    if (!SHIPPED_PROVIDER_IDS.includes(providerId)) {
      throw new Error(`WebChatTransport: no shipped provider "${providerId}" to override`)
    }
  }
  const drivers: SiteDrivers = {}
  for (const [providerId, defaults] of Object.entries(DEFAULT_SITE_DRIVERS)) {
    const override = overrides[providerId] ?? {}
    const driver: SiteDriverConfig = { ...defaults, ...override }
    validateSiteDriver(providerId, driver)
    drivers[providerId] = driver
  }
  return drivers
}

/**
 * Validate one complete driver before any browser work starts.
 * @param providerId - provider the driver serves.
 * @param driver - merged driver facts.
 * @throws Error when a selector, URL, submit key, or poll bound is invalid.
 */
export function validateSiteDriver(providerId: string, driver: SiteDriverConfig): void {
  for (const field of ['url', 'input', 'answer', 'submitKey'] as const) {
    if (driver[field].trim().length === 0) {
      throw new Error(`WebChatTransport: driver "${providerId}" has an empty ${field}`)
    }
  }
  if (driver.pollMs !== undefined && driver.pollMs < 1) {
    throw new Error(`WebChatTransport: driver "${providerId}" has a pollMs below 1`)
  }
  if (driver.stablePolls !== undefined && driver.stablePolls < 1) {
    throw new Error(`WebChatTransport: driver "${providerId}" has a stablePolls below 1`)
  }
  if (driver.signedOutPath !== undefined) validatePathPattern(providerId, driver.signedOutPath)
}

/**
 * Reject an unusable signed-out path pattern at load rather than during a turn.
 * @param providerId - provider the pattern serves.
 * @param pattern - regular-expression source matched against the URL path.
 * @throws Error when the pattern does not compile.
 */
function validatePathPattern(providerId: string, pattern: string): void {
  try {
    new RegExp(pattern, 'i')
  } catch (error) {
    throw new Error(`WebChatTransport: driver "${providerId}" has invalid signedOutPath`, { cause: error })
  }
}

/**
 * Confirm that every shipped adapter has a site driver.
 * @param drivers - resolved drivers.
 * @throws Error when an adapter ships without a driver.
 */
export function assertEveryAdapterHasDriver(
  drivers: SiteDrivers,
): asserts drivers is Record<keyof typeof webProviderAdapters, SiteDriverConfig> {
  for (const providerId of Object.keys(webProviderAdapters)) {
    if (drivers[providerId] === undefined) {
      throw new Error(`WebChatTransport: no site driver for shipped provider "${providerId}"`)
    }
  }
}
