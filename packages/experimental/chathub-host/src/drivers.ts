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
    // Every site hides a real file input behind its paper-clip button;
    // clicking that button only opens the operating system's picker.
    fileInput: 'input[type="file"]',

    answer: '.ds-markdown',
    // DeepSeek shows a bare status line in the answer slot while it works.
    pending: '问题分析中|正在分析|思考中|正在思考|搜索中|\\d+\\s*(?:s|秒)',
    signedOutPath: SIGNED_OUT_PATH,
    submitKey: 'Enter',
    // The composer accepts inserted text but drops a synthetic Enter;
    // the send button next to it is the only path that actually submits.
    submitButton: 'button[aria-label="发送"]',
  },
  'chatgpt-web': {
    url: 'https://chatgpt.com/',
    // The 2026-11 redesign (verified against a logged-in profile with a real
    // browser) replaced the `<textarea id="prompt-textarea">` composer with a
    // ProseMirror editor. Verified again 2026-11-24 on a Chinese-locale
    // account: neither `#pending-home-input` nor `#prompt-textarea` exists on
    // the home screen, the editor is a bare `<div class="ProseMirror"
    // contenteditable role="textbox">`, and its aria-label is localized
    // ("询问 ChatGPT"), so an aria-label match is a locale trap — the composer
    // read as absent and every turn ended as provider-unavailable after the
    // 15s box wait. The class is locale-independent and survives the upload,
    // which swaps nothing out; the old ids and the English label stay as
    // fallbacks for other accounts and older markup.
    input: '#prompt-textarea, div.ProseMirror, [role="textbox"][aria-label="Ask ChatGPT"]',
    // Four inputs ship on the home screen: image, image+video, image, and one
    // with no `accept`. The first three look like "the" attachment input, but
    // the site ignores a document written to them without an error, so the
    // host would send a question about a file the model never received
    // (2026-11-24). The upload therefore goes through the menu a user opens,
    // and the entry starts a real pick.
    //
    // That entry disappears when the account's upload quota is spent: the menu
    // then opens on "订阅 Plus，获得更多上传额度 或等待 23小时 后再上传" and
    // no local upload exists at all (seen 2026-11-24 on this free account,
    // minutes after the same menu did offer it). Writing the file straight to
    // the input that accepts anything paints nothing in that state, so a turn
    // with attachments fails as `chathub-ui-drift` on the missing entry — the
    // honest outcome, since sending the prompt alone would answer a question
    // about a file the model never saw.
    fileInput: 'input[type="file"]',
    uploadTrigger: '[aria-label="添加文件等内容"], [aria-label="Add files and more"]',
    uploadMenuItem: 'text=/添加照片和文件|Add photos and files/',
    // The same redesign dropped `data-message-author-role`; each assistant
    // reply now roots at `<div data-dil-response data-dil-message-id="…">`.
    // The legacy selector is kept as a fallback for pages that still render
    // the old markup; `answerHtml` reads the last match, which is the newest
    // reply in either layout.
    answer: '[data-dil-response], [data-message-author-role="assistant"] .markdown',
    // The signed-out CTA moved from `data-testid="login-button"` to
    // `data-login-button` (verified on the guest page, where the header and
    // banner buttons both carry it and are visible).
    loginWall: '[data-login-button]',
    signedOutPath: SIGNED_OUT_PATH,
    submitKey: 'Enter',
    // A synthetic Enter never leaves this editor: text inserted by the host
    // stays in the composer and the turn dies as UI drift (verified
    // 2026-11-24). The send button next to it works, and its label is
    // localized, so the stable `data-testid` comes first.
    submitButton: '[data-testid="send-button"], [aria-label="发送"], [aria-label="Send"]',
  },
  'gemini-web': {
    url: 'https://gemini.google.com/app',
    input: '.ql-editor',
    // The app screen ships no file input at rest: all three mount only once
    // the "上传和工具" menu opens, and the first and third accept documents
    // while the second is images/video only (verified 2026-11-24 with a real
    // browser). Without opening that menu a turn with attachments had nothing
    // to write to and failed as unsupported-capability in 0.0s.
    fileInput: 'input[type="file"]',
    uploadTrigger: '[aria-label="上传和工具"], [aria-label*="Upload and tools"]',
    // Verified 2026-11-26: the chip carries a `mat-spinner` from the moment the
    // pick is answered until the file is stored, 6–15s for a 112KB .docx. The
    // send button is a Material icon button that stays visible and enabled the
    // whole time, so nothing but this spinner says "not yet".
    uploadBusy: 'gem-attachment mat-spinner',
    answer: 'model-response .markdown',
    // A guest page renders the composer and answers turns too, but a guest
    // conversation is never saved to the Google account: turns that ran as a
    // guest (2026-11-13: "list 当前目录下有哪些目录" — answered, yet absent
    // from the signed-in history with the answer tape as the only record)
    // cannot be found afterwards at all. `SAPISID` is the persistent Google
    // session cookie; the wall fails an unsigned-in turn fast instead of
    // letting it run unrecorded. Both fields matter: the wall alone never
    // runs — a visible input returns first when no cookie is declared — and
    // the cookie alone would poll a guest composer to the 300s deadline.
    //
    // The wall MUST be visible on the real guest page: page.ts checks
    // locator.isVisible(), not DOM presence. Hidden candidates that already
    // burned this driver once, each verified 2026-11-13 with a real browser
    // probe at the gateway's own 800x600 viewport:
    //   - a[href*="accounts.google.com/ServiceLogin"] — in the guest DOM,
    //     `visible=false` (hidden template), and logged-in pages carry account
    //     links on the same host, so a broad match would misfire anyway.
    //   - a[data-test-id="sidenav-error-action-link"], [data-test-id=
    //     "sidenav-error-text"] — visible at 1440x960, but the 800x600 window
    //     the profile stores collapses the sidebar, and both read `false`.
    // `.signed-out-buttons` is the top-bar container Gemini renders for a
    // guest only; its button measured visible at 800x600 and 1440x960, so the
    // union keeps a visible wall at either width. The sidebar test ids stay as
    // the wider-layout primary; a signed-in page renders neither.
    loginCookie: 'SAPISID',
    loginWall: 'a[data-test-id="sidenav-error-action-link"], [data-test-id="sidenav-error-text"], .signed-out-buttons button',
    signedOutPath: SIGNED_OUT_PATH,
    submitKey: 'Enter',
  },
  'doubao-web': {
    url: 'https://www.doubao.com/chat',
    input: '.ProseMirror[contenteditable="true"]',
    // The composer's file inputs mount late, so a turn that arrived early
    // found none and failed as unsupported-capability; the attach button,
    // however, is on the composer from the start and its test id is stable
    // across locales. Its menu entry starts a real pick (verified 2026-11-24).
    fileInput: 'input[type="file"]',
    uploadTrigger: '[data-testid="upload_file_button"]',
    uploadMenuItem: 'text=/上传文件或图片/',
    // Doubao renders each assistant turn as a `receive_message` block whose
    // reply text lives in `message_text_content`. Only the assistant role is
    // named: the user's own message renders the same test id inside
    // `.md-box-root`, and while a turn was starting the selector's last match
    // was that echo — the gateway read the whole prompt back as the answer and
    // failed its call protocol (verified 2026-11-23). A searching turn also
    // shows a sibling status block ("搜索 3 个关键词，参考 12 篇资料") before
    // writing the reply, so the reply node, never the message container, is
    // named.
    answer: '[data-testid="receive_message"][data-message-role="assistant"] [data-testid="message_text_content"], [data-message-role="assistant"] .md-box-root, [data-message-role="assistant"] .flow-markdown-body',
    // The search / thinking blocks sit outside the reply text and are the only
    // place the site shows its work. The search card renders its queries and
    // sources by default and the same control collapses it, so no expander is
    // named: clicking it hid the trace instead of showing it (verified
    // 2026-11-23).
    reasoning: '[data-testid="receive_message"] [data-plugin-identifier*="search_query_result_block"], [data-testid="receive_message"] [data-plugin-identifier*="thinking"]',
    pending: '思考中|正在思考|正在生成|生成中|等待中|正在回复|搜索中|正在搜索|搜索\\s*\\d+\\s*个关键词|参考\\s*\\d+\\s*篇资料|找到\\s*\\d+\\s*篇资料',
    signedOutPath: SIGNED_OUT_PATH,
    submitKey: 'Enter',
    // Doubao renders its composer for a guest too and its QR login modal has
    // no URL change and no selector stable across its DOM churn, so the only
    // reliable sign-in proof is the `sessionid` cookie a scan lands. Without
    // this, a guest page opens "ready", the send is silently dropped, and the
    // turn dies as ui-drift instead of asking for sign-in.
    loginCookie: 'sessionid',
    // Doubao shows "登录/注册" in header when signed out; hidden after sign-in.
    // Must be specific to avoid matching logged-in page elements.
    loginWall: 'button:has-text("登录/注册"), a:has-text("登录/注册")',
    // Allow longer prompts
    maxPromptChars: 12_000,
  },
  'qianwen-web': {
    url: 'https://www.qianwen.com/',
    input: 'div[contenteditable="true"], textarea.ant-input',
    // No file input exists until the paper-clip menu opens, and the input it
    // mounts there is created for the pick itself; the menu entry is the only
    // path that starts one (verified 2026-11-24).
    fileInput: 'input[type="file"]',
    uploadTrigger: '[aria-label="添加附件"]',
    uploadMenuItem: 'text=/上传文档/',
    // Qianwen renders each turn inside a chat-answers-card-wrap block on the
    // qianwen.com workbench UI; the hashed answerItem classes are kept as the
    // legacy tongyi.aliyun.com fallback.
    //
    // The card is rewritten while the site works (verified 2026-11-22): it
    // first holds a one-line acknowledgement such as "收到，我将为你查询…",
    // which is stable for several polls and used to end the turn before the
    // reply existed. Once the turn ends, the status button flips to
    // data-status="complete" and the work steps move under
    // data-execution-section="process", leaving the reply as the only
    // qk-markdown outside that section. Gating both on the complete status
    // keeps the acknowledgement and the step cards out; while it is absent no
    // answer container matches, and the session keeps polling the page body.
    //
    // The 2026-11 workbench drops both hooks (verified 2026-11-24 with a real
    // browser): no element carries `data-status` or `data-execution-section`,
    // so the gated selector above matched nothing at all and a finished turn
    // read as an empty answer. The reply now renders inside
    // `.message-card-* > .answer-common-card > .markdown-pc-special-class >
    // .qk-markdown`, and it appears complete rather than streaming (sampled
    // once a second: 0 characters at t+2s, 201 at t+3s, unchanged for the next
    // 22s), which is what makes reading the card directly safe. The gated
    // legacy selector stays ahead of it for accounts still on the older build.
    answer: '.chat-answers-card-wrap:has(button[data-status="complete"]) .qk-markdown:not([data-execution-section="process"] *), .answer-common-card .qk-markdown, [class*="answerItem"], [class*="message-bubble"][class*="assistant"], .chat-message-item[class*="assistant"]',
    // The reply body inside a legacy container; the workbench answer above is
    // already the markdown block and reads as its own body.
    answerBody: '.qk-markdown, .markdown-body, [class*="message-bubble"][class*="assistant"] [class*="markdown"]',
    // The work steps live under `data-execution-section="process"`, which the
    // site keeps collapsed (and empty) until its status button is opened. The
    // newest control is clicked after the reply settles, then every expanded
    // process section is read as the turn's reasoning.
    reasoning: '[data-execution-section="process"]',
    reasoningExpand: '.chat-answers-card-wrap button[data-status="complete"][data-expandable="true"]',
    // The legacy card shows "问题分析中" while the model works, then swaps in
    // the reply; accepts both the bare status and its timed variants.
    pending: '问题分析中|正在分析|分析中|思考中|正在思考|生成中|正在生成|等待中|正在回复|\\d+\\s*(?:s|秒)',
    signedOutPath: SIGNED_OUT_PATH,
    submitKey: 'Enter',
    // The composer accepts inserted text but drops a synthetic Enter; the
    // send button next to it is the only path that actually submits.
    submitButton: 'button[aria-label="发送消息"]',
    // A guest session never stops showing this sidebar line, and a guest
    // send is accepted but never generates; surfacing it turns the guest
    // wall into an immediate auth-required instead of a turn timeout.
    loginWall: 'p:has-text("登录可同步历史对话")',
    // The Slate editor keeps the first 10 000 inserted characters and drops
    // the rest without any signal; leave headroom under the hard cap.
    maxPromptChars: 9_000,
    // A signed-in qianwen.com account carries `tongyi_sso_ticket` (HttpOnly,
    // one-year expiry) and its readable `tongyi_sso_ticket_hash`; guests carry
    // neither. A guest composer is visible but sends are silently dropped, so
    // the cookie makes the transport reject a guest page fast instead of
    // waiting for the turn timeout.
    loginCookie: 'tongyi_sso_ticket',
  },
  'glm-web': {
    url: 'https://chatglm.cn/',
    // The composer is a contenteditable rich editor; the plain textarea is the
    // fallback for the older chatglm UI.
    input: 'div[contenteditable="true"], textarea',
    fileInput: 'input[type="file"]',
    // Answers render in a markdown body inside the answer block; the hashed
    // answer-item containers are the fallback when the class names churn.
    // The reply sits in an `answer-content-wrap`; the thinking card reuses that
    // wrap with an extra `text-advance-thinking-content` class, and the landing
    // page's promo blocks carry their own markdown. Naming the reply's wrapper
    // and excluding the thinking variant keeps every other markdown block on
    // the page out of the answer.
    // Updated 2026-11: added broader selectors for new UI versions.
    // The 2026-11 "AgentMore" redesign renders each reply inside
    // `[data-message-role="assistant"]` and drops the old answer wraps; the
    // reasoning trace is a `.thinking-group` that also holds a markdown body,
    // and it precedes the reply, so the last markdown body is the answer.
    answer: '[data-message-role="assistant"] .markdown-body, .answer-content-wrap:not([class*="thinking"]), [class*="message-bubble"][class*="assistant"], .chat-message[class*="assistant"]',
    // Deep-thinking turns write their chain of thought into sibling wraps that
    // carry the `text-advance-thinking-content` class. They are not part of the
    // reply (the selector above excludes them), but they are the only place the
    // site exposes a reasoning trace, so collect them separately. The AgentMore
    // layout names the same trace `.thinking-group`.
    reasoning: '[data-message-role="assistant"] .thinking-group, .answer-content-wrap[class*="thinking"]',
    pending: '思考中|正在思考|生成中|正在生成|输出中|停止生成|等待中|正在回复',
    signedOutPath: SIGNED_OUT_PATH,
    submitKey: 'Enter',
    // A signed-in chatglm.cn account carries `chatglm_refresh_token` (the
    // durable credential) plus the short-lived `chatglm_token` and
    // `chatglm_user_id`; guests carry only `acw_tc` / `cdn_sec_tc`. A guest
    // composer is visible but sends are silently dropped, so the cookie makes
    // the transport reject a guest page fast instead of waiting for the turn
    // timeout.
    loginCookie: 'chatglm_refresh_token',
    // GLM shows "登录/注册" in header when signed out; hidden after sign-in.
    // Must be specific to avoid matching logged-in page elements.
    loginWall: 'button:has-text("登录/注册"), a:has-text("登录/注册")',
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
  if (driver.answerBody !== undefined && driver.answerBody.trim().length === 0) {
    throw new Error(`WebChatTransport: driver "${providerId}" has an empty answerBody`)
  }
  // An attachment selector is declared or absent; an empty one would silently
  // turn an upload path into "this site takes no files".
  for (const field of ['fileInput', 'uploadTrigger', 'uploadMenuItem', 'uploadBusy'] as const) {
    const selector = driver[field]
    if (selector !== undefined && selector.trim().length === 0) {
      throw new Error(`WebChatTransport: driver "${providerId}" has an empty ${field}`)
    }
  }
  if (driver.reasoning !== undefined && driver.reasoning.trim().length === 0) {
    throw new Error(`WebChatTransport: driver "${providerId}" has an empty reasoning`)
  }
  if (driver.reasoningExpand !== undefined && driver.reasoningExpand.trim().length === 0) {
    throw new Error(`WebChatTransport: driver "${providerId}" has an empty reasoningExpand`)
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
 * @returns Nothing; the assertion narrows `drivers` to the shipped provider ids.
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
