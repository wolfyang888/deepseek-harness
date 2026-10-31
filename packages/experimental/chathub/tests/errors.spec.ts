/** Structured ChatHub failures. */

import { describe, expect, it } from 'vitest'
import { ChatHubError, errorMessage } from '@deepseek-ai/dsh-experimental-chathub'

describe('ChatHubError', () => {
  it('carries a discriminator and the underlying cause', () => {
    const cause = new Error('offline')
    const error = new ChatHubError('provider-not-ready', 'deepseek-web is not ready', { cause })
    expect(error.name).toBe('ChatHubError')
    expect(error.code).toBe('provider-not-ready')
    expect(error.message).toBe('deepseek-web is not ready')
    expect(error.cause).toBe(cause)
  })

  it('renders errors and non-error rejections for diagnostics', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain failure')).toBe('plain failure')
    expect(errorMessage(7)).toBe('7')
  })
})
