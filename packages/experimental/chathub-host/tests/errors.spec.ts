/** Stable transport tokens and page-error classification. */

import { expect, it } from 'vitest'
import { BrowserTransportError, classifyPageError, isOperationTimeout } from '../src/errors.ts'

it('keeps an existing transport failure unchanged', () => {
  const error = new BrowserTransportError('chathub-busy', 'already queued')
  expect(classifyPageError(error, 'ignored')).toBe(error)
  expect(error.message).toBe('chathub-busy: already queued')
  expect(error.token).toBe('chathub-busy')
  expect(error.name).toBe('BrowserTransportError')
})

it('classifies lost pages as signed-out', () => {
  for (const message of [
    'Target page, context or browser has been closed',
    'browser has been closed',
    'page has been closed',
    'Execution context was destroyed',
  ]) {
    expect(classifyPageError(new Error(message), 'poll').token).toBe('chathub-signed-out')
  }
})

it('classifies transport-level failures as network errors', () => {
  for (const message of ['connect ECONNREFUSED', 'fetch failed', 'net::ERR_NAME_NOT_RESOLVED', 'socket hang up']) {
    expect(classifyPageError(new Error(message), 'navigate').token).toBe('chathub-network')
  }
})

it('classifies everything else as an unstable UI', () => {
  const cause = new Error('element is not attached')
  const error = classifyPageError(cause, 'answer')
  expect(error.token).toBe('chathub-ui-drift')
  expect(error.cause).toBe(cause)
})

it('recognizes operation timeouts by name', () => {
  expect(isOperationTimeout({ name: 'TimeoutError' })).toBe(true)
  expect(isOperationTimeout(new Error('timed out'))).toBe(false)
  expect(isOperationTimeout(null)).toBe(false)
})
