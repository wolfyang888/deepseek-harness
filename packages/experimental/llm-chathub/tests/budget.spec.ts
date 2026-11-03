/** Budget: one text fitted into a character ceiling without losing its ends. */

import { describe, expect, it } from 'vitest'
import { clampText } from '../src/budget.ts'

describe('clampText', () => {
  it('returns a text that already fits', () => {
    expect(clampText('short', 10)).toBe('short')
  })

  it('keeps the head and tail and states how much it dropped', () => {
    const text = `${'h'.repeat(2_000)}${'m'.repeat(1_000)}${'t'.repeat(2_000)}`
    const clamped = clampText(text, 1_000)
    expect(clamped.startsWith('h'.repeat(600))).toBe(true)
    expect(clamped.endsWith('t'.repeat(300))).toBe(true)
    expect(clamped).toContain('[omitted 4100 chars; re-read with offset and limit]')
  })

  it('keeps nothing at a non-positive budget', () => {
    expect(clampText('anything', 0)).toBe('')
    expect(clampText('anything', -5)).toBe('')
  })

  it('falls back to a plain cut when the marker would not fit', () => {
    const clamped = clampText('abcdefghijklmnopqrstuvwxyz', 10)
    expect(clamped).toBe('abcdefghij')
  })
})
