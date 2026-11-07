/** Budget: one text fitted into a character ceiling without losing its ends. */

import { describe, expect, it } from 'vitest'
import { clampText, clampToolResult } from '../src/budget.ts'

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

describe('clampToolResult', () => {
  /** 300 numbered lines, the envelope shape the fs read tool renders. */
  const numbered = Array.from({ length: 300 }, (_unused, index) => `${String(index + 1)}: ${'x'.repeat(20)}`).join('\n')

  it('returns a result that already fits', () => {
    expect(clampToolResult('1: short', 10)).toBe('1: short')
  })

  it('names the omitted line range and the offset to resume from', () => {
    const clamped = clampToolResult(numbered, 1_000)
    const match = new RegExp(
      '\\[omitted (\\d+) chars, file lines (\\d+)-(\\d+); '
      + 'call read again with offset=(\\d+) and a limit to see them\\]',
      'u',
    ).exec(clamped)
    expect(match).not.toBeNull()
    const [, omitted, from, to, offset] = match as RegExpExecArray
    // The omitted count covers exactly the middle the budget dropped.
    expect(Number(omitted)).toBe(numbered.length - 600 - 300)
    // The window to resume reading is the omitted range itself.
    expect(Number(offset)).toBe(Number(from))
    expect(Number(to)).toBeGreaterThan(Number(from))
    expect(clamped.startsWith('1: ')).toBe(true)
    expect(clamped.endsWith(`${String(300)}: ${'x'.repeat(20)}`)).toBe(true)
  })

  it('keeps the generic marker for a result without line numbers', () => {
    const clamped = clampToolResult(`${'h'.repeat(2_000)}${'m'.repeat(1_000)}${'t'.repeat(2_000)}`, 1_000)
    expect(clamped).toContain('[omitted 4100 chars; re-read with offset and limit]')
    expect(clamped).not.toContain('file lines')
  })

  it('keeps nothing at a non-positive budget', () => {
    expect(clampToolResult(numbered, 0)).toBe('')
  })
})
