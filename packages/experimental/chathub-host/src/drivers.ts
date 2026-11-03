/** Shipped site drivers and validated host overrides. */

import { webProviderAdapters } from '@deepseek-ai/dsh-experimental-chathub'
import type { SiteDriverConfig, SiteDrivers } from './types.ts'

/** Path patterns that identify a site's login, logout, or expired-session redirect. */
const SIGNED_OUT_PATH = 'login|logout|sign_in|signin|expired'

/** Site facts for the six shipped browser adapters; hosts override any field. */
export const DEFAULT_SITE_DRIVERS: Readonly<SiteDrivers> = {
  'deepseek-web': {
    url: 'https://chat.deepseek.com/',
    input: 'textarea',
    answer: '.ds-markdown',
    // DeepSeek shows a bare status line in the answer slot while it works.
    pending: '问题分析中|正在分析|思考中|正在思考|搜索中|\\d+\\s*(?:s|秒)',
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
    // Doubao restructured its DOM in May 2026: assistant answers render in
    // `.flow-markdown-body` / `.md-box-root` containers and older
    // `receive_message` markers are kept only as legacy fallbacks, so the
    // answer probe unions every receive-side candidate.
    answer: '[data-testid="receive_message"], [class*="bg-g-receive-msg-bubble"], .flow-markdown-body, .md-box-root',
    pending: '思考中|正在思考|正在生成|生成中',
    signedOutPath: SIGNED_OUT_PATH,
    submitKey: 'Enter',
  },
  'qianwen-web': {
    url: 'https://www.qianwen.com/',
    input: 'div[contenteditable="true"], textarea.ant-input',
    // Qianwen renders each answer inside a chat-answers-card-wrap block on the
    // new qianwen.com UI; the hashed answerItem classes are kept as the
    // legacy tongyi.aliyun.com fallback.
    answer: '[class*="chat-answers-card-wrap"], [class*="answerItem"]',
    // The answer card shows "问题分析中" while the model works, then swaps in
    // the reply; accepts both the bare status and its timed variants.
    pending: '问题分析中|正在分析|分析中|思考中|正在思考|生成中|正在生成|\\d+\\s*(?:s|秒)',
    signedOutPath: SIGNED_OUT_PATH,
    submitKey: 'Enter',
  },
  'glm-web': {
    url: 'https://chatglm.cn/',
    // The composer is a contenteditable rich editor; the plain textarea is the
    // fallback for the older chatglm UI.
    input: 'div[contenteditable="true"], textarea',
    // Answers render in a markdown body inside the answer block; the hashed
    // answer-item containers are the fallback when the class names churn.
    answer: '.markdown-body, [class*="answer-content"], [class*="answerItem"]',
    pending: '思考中|正在思考|生成中|正在生成|输出中|停止生成',
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
  if (driver.pending !== undefined) validatePendingPattern(providerId, driver.pending)
}

/**
 * Reject a thinking-placeholder pattern that does not compile.
 * @param providerId - provider the pattern serves.
 * @param pattern - regular-expression source matched against the whole answer text.
 * @throws Error when the pattern does not compile.
 */
function validatePendingPattern(providerId: string, pattern: string): void {
  try {
    new RegExp(pattern, 'i')
  } catch (error) {
    throw new Error(`WebChatTransport: driver "${providerId}" has invalid pending`, { cause: error })
  }
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
