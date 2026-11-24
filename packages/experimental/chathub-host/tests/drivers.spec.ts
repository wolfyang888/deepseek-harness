/** Shipped site drivers, host overrides, and load-time validation. */

import { expect, it } from 'vitest'
import {
  DEFAULT_SITE_DRIVERS,
  assertEveryAdapterHasDriver,
  resolveSiteDrivers,
  validateSiteDriver,
} from '../src/drivers.ts'
import { webProviderAdapters } from '@deepseek-ai/dsh-experimental-chathub'

it('ships a complete driver for every adapter', () => {
  expect(Object.keys(DEFAULT_SITE_DRIVERS).sort()).toEqual(Object.keys(webProviderAdapters).sort())
  for (const driver of Object.values(DEFAULT_SITE_DRIVERS)) {
    expect(driver.url).toMatch(/^https:/)
    expect(driver.submitKey).toBe('Enter')
    expect(driver.signedOutPath).toBeTruthy()
    expect(() => resolveSiteDrivers({})).not.toThrow()
  }
})

it('merges host overrides without dropping shipped fields', () => {
  const drivers = resolveSiteDrivers({ 'deepseek-web': { answer: '.answer', pollMs: 1 } })
  expect(drivers['deepseek-web']).toMatchObject({
    url: DEFAULT_SITE_DRIVERS['deepseek-web']?.url,
    input: DEFAULT_SITE_DRIVERS['deepseek-web']?.input,
    answer: '.answer',
    pollMs: 1,
  })
  expect(drivers['chatgpt-web']).toEqual(DEFAULT_SITE_DRIVERS['chatgpt-web'])
})

it('rejects an override for a provider that is not shipped', () => {
  expect(() => resolveSiteDrivers({ unknown: { url: 'https://example.test/' } }))
    .toThrow('no shipped provider "unknown"')
})

it.each(['url', 'input', 'answer', 'submitKey'] as const)('rejects an empty %s', (field) => {
  expect(() => resolveSiteDrivers({ 'deepseek-web': { [field]: '   ' } }))
    .toThrow(`driver "deepseek-web" has an empty ${field}`)
})

it.each(['fileInput', 'uploadTrigger', 'uploadMenuItem'] as const)('rejects an empty %s', (field) => {
  // An empty attachment selector reads as "this site takes no files", which is
  // silent; a blank one is a configuration mistake.
  expect(() => resolveSiteDrivers({ 'deepseek-web': { [field]: '  ' } }))
    .toThrow(`driver "deepseek-web" has an empty ${field}`)
})

it('declares an upload path for every site whose inputs mount late', () => {
  // 2026-11-24: gemini mounts its inputs only when the upload menu opens,
  // chatgpt mounts four with the image-only ones first, and doubao/qianwen
  // mount none until their menu is used. A driver for any of them that named
  // only `fileInput` left a turn with attachments unsupported or silently
  // file-less.
  for (const providerId of ['chatgpt-web', 'gemini-web', 'doubao-web', 'qianwen-web']) {
    expect(DEFAULT_SITE_DRIVERS[providerId]?.uploadTrigger).toBeTruthy()
  }
  // A menu entry is only named where clicking it starts a real pick; gemini's
  // menu mounts the inputs instead, so its entry would be dead weight.
  expect(DEFAULT_SITE_DRIVERS['gemini-web']?.uploadMenuItem).toBeUndefined()
})

it('rejects poll bounds below one', () => {
  expect(() => resolveSiteDrivers({ 'gemini-web': { pollMs: 0 } })).toThrow('pollMs below 1')
  expect(() => resolveSiteDrivers({ 'gemini-web': { stablePolls: 0 } })).toThrow('stablePolls below 1')
})

it('rejects an empty reasoning expander', () => {
  expect(() => resolveSiteDrivers({ 'qianwen-web': { reasoningExpand: '   ' } }))
    .toThrow('driver "qianwen-web" has an empty reasoningExpand')
})

it('rejects an uncompilable signed-out path', () => {
  expect(() => resolveSiteDrivers({ 'doubao-web': { signedOutPath: '(' } }))
    .toThrow('driver "doubao-web" has invalid signedOutPath')
})

it('rejects an uncompilable thinking-placeholder pattern', () => {
  expect(() => resolveSiteDrivers({ 'qianwen-web': { pending: '(' } }))
    .toThrow('driver "qianwen-web" has invalid pending')
})

it('uses a real visible guest wall for gemini, not the hidden ServiceLogin link', () => {
  // page.ts checks locator.isVisible(), not DOM presence. The
  // accounts.google.com/ServiceLogin anchor exists in the guest DOM but is
  // hidden (verified against a live guest page on 2026-11-13), so declaring
  // it as the wall never fired and turned every unsigned-in gemini turn into
  // a 300s poll. The signed-out sidebar test ids are visible at 1440x960, but
  // the gateway's own profile-restored 800x600 window collapses that sidebar
  // and hides them too — the top-bar `.signed-out-buttons` button measured
  // visible at both widths, so the union must keep it.
  const wall = DEFAULT_SITE_DRIVERS['gemini-web']?.loginWall ?? ''
  expect(wall).not.toContain('ServiceLogin')
  expect(wall).toContain('sidenav-error')
  expect(wall).toContain('.signed-out-buttons')
  expect(DEFAULT_SITE_DRIVERS['gemini-web']?.loginCookie).toBe('SAPISID')
})

it('pins the account cookie each composer-visible site sets on sign-in', () => {
  // Verified against a signed-in Chrome profile (2026-11-22): qianwen.com
  // sets `tongyi_sso_ticket` and chatglm.cn sets `chatglm_refresh_token`.
  // A wrong name never matches, so login waits out the full deadline and the
  // panel keeps every other model's sign-in button disabled meanwhile.
  expect(DEFAULT_SITE_DRIVERS['qianwen-web']?.loginCookie).toBe('tongyi_sso_ticket')
  expect(DEFAULT_SITE_DRIVERS['glm-web']?.loginCookie).toBe('chatglm_refresh_token')
})

it('finds answers in the AgentMore layout chatglm.cn serves since 2026-11', () => {
  // Verified against a live signed-in chatglm.cn turn (2026-11-22): the reply
  // renders as `.markdown-body` inside `[data-message-role="assistant"]`, and
  // the reasoning trace is a `.thinking-group` in the same row. The previous
  // `.answer-content-wrap` markup is gone, so without this the answer is on the
  // page but no selector matches and every turn runs to its timeout.
  const answer = DEFAULT_SITE_DRIVERS['glm-web']?.answer ?? ''
  expect(answer).toContain('[data-message-role="assistant"] .markdown-body')
  expect(DEFAULT_SITE_DRIVERS['glm-web']?.reasoning).toContain('.thinking-group')
})

it('reads the qianwen workbench reply only after the card reports complete', () => {
  // Verified against a live signed-in qianwen.com workbench turn (2026-11-22):
  // the card first holds a stable acknowledgement ("收到，我将为你查询…") and
  // only then swaps in the reply, with the work steps moved under
  // `data-execution-section="process"`. Reading the card without the
  // complete-status gate ended the turn on the acknowledgement.
  const answer = DEFAULT_SITE_DRIVERS['qianwen-web']?.answer ?? ''
  expect(answer).toContain('.chat-answers-card-wrap:has(button[data-status="complete"])')
  expect(answer).toContain('[data-execution-section="process"]')
  expect(DEFAULT_SITE_DRIVERS['qianwen-web']?.pending).toContain('问题分析中')
})

it('also reads the qianwen card the 2026-11 workbench renders', () => {
  // Verified against a live workbench turn (2026-11-24): nothing on the page
  // carries `data-status` or `data-execution-section` any more, so the gated
  // selector alone matched nothing and a finished turn read as an empty
  // answer. The reply lives under `.answer-common-card` and is painted whole
  // instead of streaming (0 chars at t+2s, 201 at t+3s, unchanged after).
  const answer = DEFAULT_SITE_DRIVERS['qianwen-web']?.answer ?? ''
  expect(answer).toContain('.answer-common-card .qk-markdown')
  // The gate stays ahead of it for accounts still on the older build.
  expect(answer.indexOf('.chat-answers-card-wrap')).toBeLessThan(answer.indexOf('.answer-common-card'))
})

it('opens the qianwen work steps before reading them as reasoning', () => {
  // Verified against a live workbench turn (2026-11-23): the process section
  // renders only a divider while `data-collapsed="true"`, so the driver names
  // the status button that reveals its steps.
  const driver = DEFAULT_SITE_DRIVERS['qianwen-web']
  expect(driver?.reasoning).toBe('[data-execution-section="process"]')
  expect(driver?.reasoningExpand).toContain('button[data-status="complete"][data-expandable="true"]')
})

it('reads the doubao assistant reply, not the user echo or search strip', () => {
  // Verified against a live doubao.com searching turn (2026-11-23): the user
  // message renders its own `message_text_content` inside `.md-box-root`, and
  // the assistant turn shows a sibling "搜索 3 个关键词，参考 12 篇资料" block
  // before writing the reply. A selector without the assistant role matched
  // that echo first and read the whole harness prompt back as the answer.
  const driver = DEFAULT_SITE_DRIVERS['doubao-web']
  const answer = driver?.answer ?? ''
  expect(answer).toContain('[data-testid="receive_message"][data-message-role="assistant"]')
  expect(answer).not.toMatch(/(?:^|,\s*)\.md-box-root/)
  expect(driver?.pending).toContain('参考')
  expect(driver?.reasoning).toContain('search_query_result_block')
  // The search card renders its sources by default; the same control
  // collapses it, so naming it would hide the trace.
  expect(driver?.reasoningExpand).toBeUndefined()
})

it('accepts a driver without a signed-out path', () => {
  const driver = { url: 'https://fake.test/', input: '#prompt', answer: '.answer', submitKey: 'Enter' }
  expect(() => { validateSiteDriver('deepseek-web', driver) }).not.toThrow()
})

it('requires a driver for every shipped adapter', () => {
  expect(() => { assertEveryAdapterHasDriver({}) }).toThrow('no site driver for shipped provider')
  expect(() => { assertEveryAdapterHasDriver(resolveSiteDrivers({})) }).not.toThrow()
})
