/** Page wrapper navigation, visibility polls, answer reads, and submission. */

import { expect, it } from 'vitest'
import { PlaywrightPage } from '../src/page.ts'
import { FakePage } from './support/fake-browser.ts'

const KEY = 'deepseek-web'
const DRIVER = { url: 'https://fake.test/chat', input: '#prompt', answer: '.answer', submitKey: 'Enter' }
/** A driver whose site shows its wall as an element. */
const LOGIN_DRIVER = { ...DRIVER, loginWall: '.login-wall' }
/** Doubao's shape: the composer renders for a guest, so a cookie proves sign-in. */
const COOKIE_DRIVER = { ...DRIVER, loginCookie: 'sessionid' }

function page(fake = new FakePage()): { wrapper: PlaywrightPage; fake: FakePage } {
  return { wrapper: new PlaywrightPage(fake, KEY, 10), fake }
}

it('navigates to the site entry', async () => {
  const { wrapper, fake } = page()
  await wrapper.goto(DRIVER.url)
  expect(fake.visited).toEqual([DRIVER.url])
  expect(wrapper.url()).toBe(DRIVER.url)
})

it('maps navigation failures to network errors', async () => {
  const { wrapper, fake } = page()
  fake.errors.goto = new Error('net::ERR_NAME_NOT_RESOLVED')
  await expect(wrapper.goto(DRIVER.url)).rejects.toMatchObject({ token: 'chathub-network' })
})

it('maps a navigation timeout to a turn timeout, not UI drift', async () => {
  const { wrapper, fake } = page()
  fake.errors.goto = Object.assign(new Error('Timeout 10ms exceeded'), { name: 'TimeoutError' })
  await expect(wrapper.goto(DRIVER.url)).rejects.toMatchObject({ token: 'chathub-turn-timeout' })
})

it('waits for a visible chat input', async () => {
  const { wrapper, fake } = page()
  fake.visible.add(DRIVER.input)
  await expect(wrapper.waitForInput(DRIVER, 20, 1)).resolves.toBe(true)
})

it('reports a cookie-gated site as unsigned-in while the cookie is absent', async () => {
  // A guest page still renders the composer; only the session cookie says
  // the page can really send.
  const { wrapper, fake } = page()
  fake.visible.add(DRIVER.input)
  await expect(wrapper.waitForInput(COOKIE_DRIVER, 2, 1)).resolves.toBe(false)
})

it('waits until the session cookie lands, then reports the site ready', async () => {
  // The window is generous because Windows timer granularity stretches the
  // 1ms polls; only the cookie's arrival ends the wait early.
  const { wrapper, fake } = page()
  fake.visible.add(DRIVER.input)
  const waiting = wrapper.waitForInput(COOKIE_DRIVER, 200, 1)
  setTimeout(() => {
    if (fake.contextValue !== undefined) fake.contextValue.cookieNames = ['sessionid']
  }, 20)
  await expect(waiting).resolves.toBe(true)
})

it('stops waiting when the login wall appears', async () => {
  const { wrapper, fake } = page()
  fake.visible.add('.login-wall')
  await expect(wrapper.waitForInput(LOGIN_DRIVER, 20, 1)).resolves.toBe(false)
})

it('reports an unsigned-in site after the deadline', async () => {
  const { wrapper } = page()
  await expect(wrapper.waitForInput(LOGIN_DRIVER, 2, 1)).resolves.toBe(false)
})

it('stops immediately when the deadline has already passed', async () => {
  const { wrapper } = page()
  await expect(wrapper.waitForInput(DRIVER, 1, 10)).resolves.toBe(false)
})

it('stops when a visibility check outlasts the deadline', async () => {
  const { wrapper, fake } = page()
  fake.isVisibleDelayMs = 5
  await expect(wrapper.waitForInput(DRIVER, 2, 1)).resolves.toBe(false)
})

it('stops with a false result when the caller aborts', async () => {
  const { wrapper } = page()
  await expect(wrapper.waitForInput(DRIVER, 20, 1, AbortSignal.abort())).resolves.toBe(false)
  const controller = new AbortController()
  const waiting = wrapper.waitForInput(DRIVER, 50, 5, controller.signal)
  controller.abort()
  await expect(waiting).resolves.toBe(false)
})

it('rejects a page that closes while waiting', async () => {
  const { wrapper, fake } = page()
  fake.closed = true
  await expect(wrapper.waitForInput(DRIVER, 20, 1))
    .rejects.toMatchObject({ token: 'chathub-browser-unavailable' })
})

it('classifies a thrown visibility check', async () => {
  const { wrapper, fake } = page()
  // The visibility scan asks for matches first; one match must exist for the
  // per-element isVisible call to run and fail.
  fake.counts[DRIVER.input] = 1
  fake.errors.isVisible = new Error('element is not attached')
  await expect(wrapper.waitForInput(DRIVER, 20, 1))
    .rejects.toMatchObject({ token: 'chathub-ui-drift' })
})

it('reads the last answer container markup', async () => {
  const { wrapper, fake } = page()
  fake.counts[DRIVER.answer] = 2
  fake.texts[DRIVER.answer] = '  <p>answer</p>  '
  await expect(wrapper.answerHtml(DRIVER.answer)).resolves.toBe('<p>answer</p>')
})

it('treats a missing answer container as no answer', async () => {
  const { wrapper } = page()
  await expect(wrapper.answerHtml(DRIVER.answer)).resolves.toBe('')
})

it('reads the reply body inside the last answer container', async () => {
  const { wrapper, fake } = page()
  fake.counts[DRIVER.answer] = 1
  fake.counts[`${DRIVER.answer} >> .body`] = 2
  fake.texts[`${DRIVER.answer} >> .body`] = '  <p>reply</p>  '
  await expect(wrapper.answerHtml(DRIVER.answer, '.body')).resolves.toBe('<p>reply</p>')
})

it('falls back to the container when the body selector matches nothing', async () => {
  const { wrapper, fake } = page()
  fake.counts[DRIVER.answer] = 1
  fake.texts[DRIVER.answer] = '<p>whole card</p>'
  await expect(wrapper.answerHtml(DRIVER.answer, '.body')).resolves.toBe('<p>whole card</p>')
})

it('treats an answer read timeout as no answer yet', async () => {
  const { wrapper, fake } = page()
  fake.counts[DRIVER.answer] = 1
  fake.errors.innerHTML = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
  await expect(wrapper.answerHtml(DRIVER.answer)).resolves.toBe('')
})

it('classifies other answer read failures', async () => {
  const { wrapper, fake } = page()
  fake.counts[DRIVER.answer] = 1
  fake.errors.innerHTML = new Error('element is not attached')
  await expect(wrapper.answerHtml(DRIVER.answer)).rejects.toMatchObject({ token: 'chathub-ui-drift' })
  fake.errors.innerHTML = undefined
  fake.errors.count = new Error('browser has been closed')
  await expect(wrapper.answerHtml(DRIVER.answer)).rejects.toMatchObject({ token: 'chathub-browser-unavailable' })
})

it('clicks the input, inserts the prompt as one text insertion, and submits', async () => {
  const { wrapper, fake } = page()
  fake.boxes[DRIVER.input] = { x: 10, y: 20, width: 100, height: 40 }
  await wrapper.submit('hello\nworld', DRIVER, 5)
  expect(fake.clicks).toEqual([{ x: 60, y: 40 }])
  expect(fake.typed).toEqual(['hello\nworld'])
  expect(fake.keys).toEqual(['Enter'])
})

it('reports an input without a layout box as UI drift', async () => {
  const { wrapper } = page()
  await expect(wrapper.submit('hello', DRIVER, 5)).rejects.toMatchObject({ token: 'chathub-ui-drift' })
})

it('presses submit again while the composer still holds the prompt', async () => {
  const { wrapper, fake } = page()
  fake.boxes[DRIVER.input] = { x: 0, y: 0, width: 10, height: 10 }
  // The composer mounts before its handler does: the first Enter is dropped.
  fake.texts[DRIVER.input] = '<p>hello world</p>'
  fake.clearAfterPresses = 2
  await wrapper.submit('hello world', DRIVER, 1)
  expect(fake.keys).toEqual(['Enter', 'Enter'])
  expect(fake.typed).toEqual(['hello world'])
  // The retry refocuses the composer before pressing: a key press lands
  // wherever the focus is.
  expect(fake.clicks).toEqual([{ x: 5, y: 5 }, { x: 5, y: 5 }])
})

it('keeps submitting when the composer only wires up after a beat', async () => {
  // Doubao.com hydration: the editor is in the DOM (and takes the text) well
  // before its send handler answers a key press. Two presses left the turn to
  // fail and open a fresh page; the third lands in the same page.
  const { wrapper, fake } = page()
  fake.boxes[DRIVER.input] = { x: 0, y: 0, width: 10, height: 10 }
  fake.texts[DRIVER.input] = '<p>hello world</p>'
  fake.clearAfterPresses = 3
  await expect(wrapper.submit('hello world', DRIVER, 1)).resolves.toBeUndefined()
  expect(fake.keys).toEqual(['Enter', 'Enter', 'Enter'])
  expect(fake.typed).toEqual(['hello world'])
})

it('reports a composer that keeps the prompt as UI drift', async () => {
  const { wrapper, fake } = page()
  fake.boxes[DRIVER.input] = { x: 0, y: 0, width: 10, height: 10 }
  fake.texts[DRIVER.input] = '<p>hello world</p>'
  await expect(wrapper.submit('hello world', DRIVER, 1)).rejects.toMatchObject({ token: 'chathub-ui-drift' })
  // Every attempt at the send, never an unbounded loop.
  expect(fake.keys).toEqual(['Enter', 'Enter', 'Enter'])
})

it('accepts a send whose composer lingers while the conversation advanced', async () => {
  // A real subject (doubao.com) clears its editor with a transition and had
  // already started answering; reading the composer once accused the send of
  // being dropped. The answer container moving is the send's real receipt.
  const { wrapper, fake } = page()
  fake.boxes[DRIVER.input] = { x: 0, y: 0, width: 10, height: 10 }
  fake.texts[DRIVER.input] = '<p>hello world</p>'
  fake.counts[DRIVER.answer] = 1
  fake.texts[DRIVER.answer] = '<p>previous answer</p>'
  const press = fake.keyboard.press
  fake.keyboard.press = async (key: string): Promise<void> => {
    await press(key)
    fake.texts[DRIVER.answer] = '<p>thinking</p>'
  }
  await expect(wrapper.submit('hello world', DRIVER, 1)).resolves.toBeUndefined()
})

it('reports a dropped send on a cookie-gated site as signed-out, not drift', async () => {
  // Doubao's guest gate swallows the send while the QR wall is up; the absent
  // session cookie is what names the cause.
  const { wrapper, fake } = page()
  fake.boxes[DRIVER.input] = { x: 0, y: 0, width: 10, height: 10 }
  fake.texts[DRIVER.input] = '<p>hello world</p>'
  await expect(wrapper.submit('hello world', COOKIE_DRIVER, 1))
    .rejects.toMatchObject({ token: 'chathub-signed-out' })
  expect(fake.keys).toEqual(['Enter', 'Enter', 'Enter'])
})

it('retypes when the composer never took the prompt', async () => {
  const { wrapper, fake } = page()
  fake.boxes[DRIVER.input] = { x: 0, y: 0, width: 10, height: 10 }
  fake.texts[DRIVER.input] = '<p>something else</p>'
  await expect(wrapper.submit('hello world', DRIVER, 1)).rejects.toMatchObject({ token: 'chathub-ui-drift' })
  expect(fake.typed).toEqual(['hello world', 'hello world', 'hello world'])
  expect(fake.keys).toEqual([])
})

it('classifies submission failures', async () => {
  const { wrapper, fake } = page()
  fake.boxes[DRIVER.input] = { x: 0, y: 0, width: 10, height: 10 }
  fake.errors.insertText = new Error('connect ECONNREFUSED')
  await expect(wrapper.submit('hello', DRIVER, 5)).rejects.toMatchObject({ token: 'chathub-network' })
})

const BUTTON = 'button[aria-label="发送消息"]'
const BUTTON_DRIVER = { ...DRIVER, submitButton: BUTTON }

it('clicks the send button instead of pressing the key when the driver names one', async () => {
  const { wrapper, fake } = page()
  fake.boxes[DRIVER.input] = { x: 0, y: 0, width: 10, height: 10 }
  fake.visible.add(BUTTON)
  fake.texts[DRIVER.input] = '<p>hello world</p>'
  fake.clearAfterClicks = 1
  await wrapper.submit('hello world', BUTTON_DRIVER, 1)
  expect(fake.locatorClicks).toEqual([BUTTON])
  expect(fake.keys).toEqual([])
})

it('falls back to the submit key when the send button is absent', async () => {
  const { wrapper, fake } = page()
  fake.boxes[DRIVER.input] = { x: 0, y: 0, width: 10, height: 10 }
  fake.texts[DRIVER.input] = '<p>hello world</p>'
  fake.clearAfterPresses = 1
  await wrapper.submit('hello world', BUTTON_DRIVER, 1)
  expect(fake.locatorClicks).toEqual([])
  expect(fake.keys).toEqual(['Enter'])
})

it('falls back to the submit key when the send button is disabled', async () => {
  const { wrapper, fake } = page()
  fake.boxes[DRIVER.input] = { x: 0, y: 0, width: 10, height: 10 }
  fake.visible.add(BUTTON)
  fake.disabledButtons.add(BUTTON)
  fake.texts[DRIVER.input] = '<p>hello world</p>'
  fake.clearAfterPresses = 1
  await wrapper.submit('hello world', BUTTON_DRIVER, 1)
  expect(fake.locatorClicks).toEqual([])
  expect(fake.keys).toEqual(['Enter'])
})

it('closes an open page once and ignores a closed one', async () => {
  const { wrapper, fake } = page()
  await wrapper.close()
  expect(fake.closeCount).toBe(1)
  await wrapper.close()
  expect(fake.closeCount).toBe(1)
})

it('ignores a close rejection for a tab that is already gone', async () => {
  const { wrapper, fake } = page()
  fake.errors.close = new Error('page has been closed')
  await expect(wrapper.close()).resolves.toBeUndefined()
})
