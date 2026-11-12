/** Failure mapping and per-site admission. */

import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { classifyFailure, failureFromError } from '../src/errors.ts'
import { SiteQueues } from '../src/queue.ts'

describe('classifyFailure', () => {
  it('maps sign-out to 401 with a login next action', () => {
    const failure = classifyFailure(new LlmError('signed out', 'AUTH').failure)
    expect(failure.status).toBe(401)
    expect(failure.code).toBe('chathub_signed_out')
    expect(failure.message).toContain('ChatHub panel')
  })

  it('maps rate limits to 429 with a retry delay', () => {
    const failure = classifyFailure(new LlmError('paced', 'RATE_LIMIT').failure)
    expect(failure.status).toBe(429)
    expect(failure.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('maps browser loss to 503 and network loss to 502', () => {
    expect(classifyFailure(new LlmError('closed', 'SERVER').failure).status).toBe(503)
    expect(classifyFailure(new LlmError('offline', 'TRANSPORT').failure).status).toBe(502)
  })

  it('maps prompt overflow to 400 naming the resend', () => {
    const failure = classifyFailure(new LlmError('too long', 'CONTEXT_WINDOW_EXCEEDED').failure)
    expect(failure.status).toBe(400)
    expect(failure.code).toBe('context_length_exceeded')
  })

  it('keeps an unknown code at 500 without inventing a classification', () => {
    const failure = classifyFailure(new LlmError('odd', 'SOMETHING_NEW').failure)
    expect(failure.status).toBe(500)
    expect(failure.message).toBe('odd')
  })
})

describe('failureFromError', () => {
  it('unwraps an LlmError through its failure facts', () => {
    const failure = failureFromError(new LlmError('signed out', 'AUTH'))
    expect(failure.code).toBe('chathub_signed_out')
  })

  it('wraps a plain error as a generic 500', () => {
    const failure = failureFromError(new Error('boom'))
    expect(failure.status).toBe(500)
    expect(failure.message).toBe('boom')
  })
})

describe('SiteQueues', () => {
  it('admits up to the limit and rejects the next on the same site', () => {
    const queues = new SiteQueues(2)
    const first = queues.enter('glm-web')
    const second = queues.enter('glm-web')
    expect(first.kind).toBe('accepted')
    expect(second.kind).toBe('accepted')
    expect(queues.enter('glm-web')).toEqual({ kind: 'queue-full' })
  })

  it('counts sites independently', () => {
    const queues = new SiteQueues(1)
    expect(queues.enter('glm-web').kind).toBe('accepted')
    expect(queues.enter('qianwen-web').kind).toBe('accepted')
    expect(queues.enter('glm-web')).toEqual({ kind: 'queue-full' })
  })

  it('releases a slot for the next request', () => {
    const queues = new SiteQueues(1)
    const admission = queues.enter('glm-web')
    if (admission.kind !== 'accepted') throw new Error('unreachable')
    expect(queues.enter('glm-web')).toEqual({ kind: 'queue-full' })
    admission.release()
    expect(queues.enter('glm-web').kind).toBe('accepted')
  })

  it('clamps a double release instead of undercounting', () => {
    const queues = new SiteQueues(1)
    const admission = queues.enter('glm-web')
    if (admission.kind !== 'accepted') throw new Error('unreachable')
    admission.release()
    admission.release()
    expect(queues.size('glm-web')).toBe(0)
    expect(queues.enter('glm-web').kind).toBe('accepted')
  })
})
