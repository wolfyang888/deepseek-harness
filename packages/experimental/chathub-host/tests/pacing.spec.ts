/** Pacing: the anti-abuse envelope between the loop and a chat site. */

import { describe, expect, it } from 'vitest'
import { PACING_PRESETS, PacingGovernor, resolvePacing } from '../src/pacing.ts'

/** Fake clock plus a sleep that advances it. */
function clock(start = 1_000_000): {
  now: () => number
  wait: (ms: number) => Promise<void>
  waits: number[]
} {
  let at = start
  const waits: number[] = []
  return {
    now: () => at,
    wait: async (ms: number) => {
      waits.push(ms)
      at += ms
    },
    waits,
  }
}

describe('resolvePacing', () => {
  it('defaults to the conservative profile', () => {
    expect(resolvePacing(undefined)).toEqual(PACING_PRESETS.conservative)
  })

  it('lets one field override its profile', () => {
    expect(resolvePacing({ profile: 'balanced', minTurnGapMs: 0 })).toEqual({
      ...PACING_PRESETS.balanced,
      minTurnGapMs: 0,
    })
  })

  it('turns every rule off with the off profile', () => {
    expect(resolvePacing({ profile: 'off', maxTurnsPerHour: 1 })).toEqual({
      minTurnGapMs: 0,
      maxTurnsPerHour: 0,
      maxWaitMs: 0,
    })
  })
})

describe('PacingGovernor', () => {
  it('admits the first turn immediately', async () => {
    const time = clock()
    const governor = new PacingGovernor(PACING_PRESETS.conservative, time.now, time.wait)
    await governor.admit('qianwen-web')
    expect(time.waits).toEqual([])
  })

  it('waits out the gap between two turn starts', async () => {
    const time = clock()
    const governor = new PacingGovernor({ minTurnGapMs: 20_000, maxTurnsPerHour: 0, maxWaitMs: 30_000 }, time.now, time.wait)
    await governor.admit('qianwen-web')
    await governor.admit('qianwen-web')
    expect(time.waits).toEqual([20_000])
  })

  it('keeps each site on its own envelope', async () => {
    const time = clock()
    const governor = new PacingGovernor({ minTurnGapMs: 20_000, maxTurnsPerHour: 0, maxWaitMs: 30_000 }, time.now, time.wait)
    await governor.admit('qianwen-web')
    await governor.admit('deepseek-web')
    expect(time.waits).toEqual([])
  })

  it('refuses a turn whose wait would exceed the ceiling', async () => {
    const time = clock()
    const governor = new PacingGovernor({ minTurnGapMs: 20_000, maxTurnsPerHour: 0, maxWaitMs: 5_000 }, time.now, time.wait)
    await governor.admit('qianwen-web')
    await expect(governor.admit('qianwen-web')).rejects.toMatchObject({ token: 'chathub-paced' })
  })

  it('refuses once the hourly budget is spent, naming the wait', async () => {
    const time = clock()
    const governor = new PacingGovernor({ minTurnGapMs: 0, maxTurnsPerHour: 2, maxWaitMs: 1_000 }, time.now, time.wait)
    await governor.admit('qianwen-web')
    await governor.admit('qianwen-web')
    await expect(governor.admit('qianwen-web')).rejects.toMatchObject({ token: 'chathub-paced' })
  })

  it('frees budget as old turns leave the hour', async () => {
    const time = clock()
    // A ceiling above one hour lets the third turn wait the window out.
    const governor = new PacingGovernor({ minTurnGapMs: 0, maxTurnsPerHour: 2, maxWaitMs: 4_000_000 }, time.now, time.wait)
    await governor.admit('qianwen-web')
    await governor.admit('qianwen-web')
    await governor.admit('qianwen-web')
    expect(time.waits).toEqual([3_600_000])
  })

  it('does nothing at all when pacing is off', async () => {
    const time = clock()
    const governor = new PacingGovernor(resolvePacing({ profile: 'off' }), time.now, time.wait)
    for (let turn = 0; turn < 5; turn += 1) await governor.admit('qianwen-web')
    expect(time.waits).toEqual([])
  })
})
