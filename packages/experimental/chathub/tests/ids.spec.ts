/** Date-stamped id formatting. */

import { describe, expect, it } from 'vitest'
import {
  createCheckpointId,
  createMemoryEntryId,
  createSessionId,
  formatDateStamp,
} from '@deepseek-ai/dsh-experimental-chathub'

describe('ChatHub ids', () => {
  it('renders UTC calendar days', () => {
    expect(formatDateStamp(0)).toBe('19700101')
    expect(formatDateStamp(Date.UTC(2026, 9, 31, 23, 59))).toBe('20261031')
  })

  it('builds date-stamped session, checkpoint, and memory ids', () => {
    const at = Date.UTC(2026, 9, 31)
    expect(createSessionId(at, 1)).toBe('sess_20261031_001')
    expect(createCheckpointId(at, 12)).toBe('cp_20261031_012')
    expect(createMemoryEntryId(at, 7)).toBe('mem_20261031_007')
    expect(createSessionId(at, 1000)).toBe('sess_20261031_1000')
  })
})
