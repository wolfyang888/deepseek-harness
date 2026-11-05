/** Page wrapper navigation, visibility polls, answer reads, and submission. */

import { expect, it } from 'vitest'
import { PlaywrightPage } from '../src/page.ts'
import { FakePage } from './support/fake-browser.ts'

const KEY = 'deepseek-web'
const DRIVER = { url: 'https://fake.test/chat', input: '#prompt', answer: '.answer', submitKey: 'Enter' }

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

it('waits for a visible chat input', async () => {
  const { wrapper, fake } = page()
  fake.visible.add(DRIVER.input)
  await expect(wrapper.waitForInput(DRIVER.input, undefined, 20, 1)).resolves.toBe(true)
})

it('stops waiting when the login wall appears', async () => {
  const { wrapper, fake } = page()
  fake.visible.add('.login-wall')
  await expect(wrapper.waitForInput(DRIVER.input, '.login-wall', 20, 1)).resolves.toBe(false)
})

it('reports an unsigned-in site after the deadline', async () => {
  const { wrapper } = page()
  await expect(wrapper.waitForInput(DRIVER.input, '.login-wall', 2, 1)).resolves.toBe(false)
})

it('stops immediately when the deadline has already passed', async () => {
  const { wrapper } = page()
  await expect(wrapper.waitForInput(DRIVER.input, undefined, 1, 10)).resolves.toBe(false)
})

it('stops when a visibility check outlasts the deadline', async () => {
  const { wrapper, fake } = page()
  fake.isVisibleDelayMs = 5
  await expect(wrapper.waitForInput(DRIVER.input, undefined, 2, 1)).resolves.toBe(false)
})

it('stops with a false result when the caller aborts', async () => {
  const { wrapper } = page()
  await expect(wrapper.waitForInput(DRIVER.input, undefined, 20, 1, AbortSignal.abort())).resolves.toBe(false)
  const controller = new AbortController()
  const waiting = wrapper.waitForInput(DRIVER.input, undefined, 50, 5, controller.signal)
  controller.abort()
  await expect(waiting).resolves.toBe(false)
})

it('rejects a page that closes while waiting', async () => {
  const { wrapper, fake } = page()
  fake.closed = true
  await expect(wrapper.waitForInput(DRIVER.input, undefined, 20, 1))
    .rejects.toMatchObject({ token: 'chathub-signed-out' })
})

it('classifies a thrown visibility check', async () => {
  const { wrapper, fake } = page()
  // The visibility scan asks for matches first; one match must exist for the
  // per-element isVisible call to run and fail.
  fake.counts[DRIVER.input] = 1
  fake.errors.isVisible = new Error('element is not attached')
  await expect(wrapper.waitForInput(DRIVER.input, undefined, 20, 1))
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
  await expect(wrapper.answerHtml(DRIVER.answer)).rejects.toMatchObject({ token: 'chathub-signed-out' })
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
})

it('reports a composer that keeps the prompt as UI drift', async () => {
  const { wrapper, fake } = page()
  fake.boxes[DRIVER.input] = { x: 0, y: 0, width: 10, height: 10 }
  fake.texts[DRIVER.input] = '<p>hello world</p>'
  await expect(wrapper.submit('hello world', DRIVER, 1)).rejects.toMatchObject({ token: 'chathub-ui-drift' })
  // One submit plus the one retry, never an unbounded loop.
  expect(fake.keys).toEqual(['Enter', 'Enter'])
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
