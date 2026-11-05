/** Placement of a turn across mounted sites: one topic, one model. */

import { describe, expect, it } from 'vitest'
import { SiteRouter } from '../src/router.ts'
import { DEFAULT_SITE_ROUTING, type SiteRoutingPolicy } from '../src/types.ts'

const SITES = ['deepseek-web', 'qianwen-web']

/**
 * @param now - mutable clock reading.
 * @returns A clock whose value the test advances.
 */
function clock(now: { at: number }): () => number {
  return () => now.at
}

/**
 * @param overrides - policy changes for one case.
 * @returns The shipped policy with the changes applied.
 */
function policy(overrides: Partial<SiteRoutingPolicy> = {}): SiteRoutingPolicy {
  return { ...DEFAULT_SITE_ROUTING, ...overrides }
}

describe('SiteRouter', () => {
  it('keeps a topic on the site it started on', () => {
    const now = { at: 1_000 }
    const router = new SiteRouter(policy(), clock(now))
    const first = router.choose({ key: 's1', candidates: SITES, waitOf: () => 0 })
    now.at += 5_000
    const second = router.choose({ key: 's1', candidates: SITES, waitOf: () => 0 })
    expect(second).toBe(first)
  })

  it('starts a second topic on the other site', () => {
    const now = { at: 1_000 }
    const router = new SiteRouter(policy(), clock(now))
    const first = router.choose({ key: 's1', candidates: SITES, waitOf: () => 0 })
    const other = router.choose({ key: 's2', candidates: SITES, waitOf: () => 0 })
    expect(other).not.toBe(first)
  })

  it('moves a topic when its site would stall the turn behind pacing', () => {
    const now = { at: 1_000 }
    const router = new SiteRouter(policy({ stickyMaxWaitMs: 3_000 }), clock(now))
    const first = router.choose({ key: 's1', candidates: SITES, waitOf: () => 0 })
    const second = router.choose({
      key: 's1',
      candidates: SITES,
      waitOf: site => (site === first ? 20_000 : 0),
    })
    expect(second).not.toBe(first)
    // The topic stays on the new site afterwards: switching back and forth
    // every turn is worse than one switch and a consistent voice.
    now.at += 5_000
    const third = router.choose({ key: 's1', candidates: SITES, waitOf: () => 0 })
    expect(third).toBe(second)
  })

  it('waits out a short gap instead of switching', () => {
    const router = new SiteRouter(policy({ stickyMaxWaitMs: 3_000 }), () => 1_000)
    const first = router.choose({ key: 's1', candidates: SITES, waitOf: () => 0 })
    const second = router.choose({
      key: 's1',
      candidates: SITES,
      waitOf: site => (site === first ? 2_000 : 0),
    })
    expect(second).toBe(first)
  })

  it('skips a site that just failed a turn', () => {
    const router = new SiteRouter(policy(), () => 1_000)
    const first = router.choose({ key: 's1', candidates: SITES, waitOf: () => 0 })
    router.penalize(first)
    const next = router.choose({ key: 's1', candidates: SITES, waitOf: () => 0 })
    expect(next).not.toBe(first)
  })

  it('keeps the other topics when one site is penalized', () => {
    const router = new SiteRouter(policy(), () => 1_000)
    router.choose({ key: 's1', candidates: SITES, waitOf: () => 0 })
    router.choose({ key: 's2', candidates: SITES, waitOf: () => 0 })
    // Penalizing one site drops only the topics that were on it.
    router.penalize('deepseek-web')
    expect(router.choose({ key: 's2', candidates: SITES, waitOf: () => 0 })).toBe('qianwen-web')
  })

  it('returns a cooled site to rotation once the cooldown ends', () => {
    const now = { at: 0 }
    const router = new SiteRouter(policy({ cooldownMs: 60_000, stickyTtlMs: 0 }), clock(now))
    router.penalize('deepseek-web')
    expect(router.choose({ key: 's1', candidates: SITES, waitOf: () => 0 })).toBe('qianwen-web')
    now.at = 61_000
    // Both are eligible again; the tie goes to the least recently used site.
    expect(router.choose({ key: 's2', candidates: SITES, waitOf: () => 0 })).toBe('deepseek-web')
  })

  it('forgets a topic once its affinity expires', () => {    const now = { at: 0 }
    const router = new SiteRouter(policy({ stickyTtlMs: 60_000 }), clock(now))
    const first = router.choose({ key: 's1', candidates: SITES, waitOf: () => 0 })
    now.at = 61_000
    const later = router.choose({ key: 's1', candidates: SITES, waitOf: () => 0 })
    expect(later).not.toBe(first)
  })

  it('rotates every turn under round-robin', () => {
    const router = new SiteRouter(policy({ strategy: 'round-robin' }), () => 0)
    const picks = [1, 2, 3].map(() => router.choose({ key: 's1', candidates: SITES, waitOf: () => 0 }))
    expect(picks).toEqual(['deepseek-web', 'qianwen-web', 'deepseek-web'])
  })

  it('never moves a pinned route', () => {
    const router = new SiteRouter(policy(), () => 0)
    for (let turn = 0; turn < 3; turn += 1) {
      expect(router.choose({ key: 's1', candidates: SITES, pinned: 'qianwen-web', waitOf: () => 0 }))
        .toBe('qianwen-web')
    }
  })

  it('refuses a turn no site can take', () => {
    const router = new SiteRouter(policy(), () => 0)
    expect(() => router.choose({ key: 's1', candidates: [], waitOf: () => 0 }))
      .toThrow(/no site can serve/u)
  })
})

const RANKED = ['qianwen-web', 'deepseek-web', 'chatgpt-web']
const RANKS = { 'qianwen-web': 10, 'deepseek-web': 20, 'chatgpt-web': 30 }

describe('SiteRouter escalation', () => {
  it('moves a topic one rank up after it fails twice on its site', () => {
    const router = new SiteRouter(
      policy({ cooldownMs: 0, escalateAfterFailures: 2, siteRank: RANKS }),
      () => 0,
    )
    expect(router.choose({ key: 's1', candidates: RANKED, waitOf: () => 0 })).toBe('qianwen-web')
    router.fail('s1', 'qianwen-web')
    router.fail('s1', 'qianwen-web')
    // One step, not straight to the top: the next model that may follow the
    // protocol is the cheapest replacement.
    expect(router.choose({ key: 's1', candidates: RANKED, waitOf: () => 0 })).toBe('deepseek-web')
  })

  it('keeps climbing while the replacement keeps failing', () => {
    const router = new SiteRouter(
      policy({ cooldownMs: 0, escalateAfterFailures: 2, siteRank: RANKS }),
      () => 0,
    )
    router.choose({ key: 's1', candidates: RANKED, waitOf: () => 0 })
    router.fail('s1', 'qianwen-web')
    router.fail('s1', 'qianwen-web')
    const second = router.choose({ key: 's1', candidates: RANKED, waitOf: () => 0 })
    expect(second).toBe('deepseek-web')
    router.succeed('s1', second)
    router.fail('s1', 'deepseek-web')
    router.fail('s1', 'deepseek-web')
    expect(router.choose({ key: 's1', candidates: RANKED, waitOf: () => 0 })).toBe('chatgpt-web')
  })

  it('does not escalate on a failure streak a success already broke', () => {
    const router = new SiteRouter(
      policy({ cooldownMs: 0, escalateAfterFailures: 2, demoteMs: 60_000 }),
      () => 0,
    )
    router.fail('s1', 'qianwen-web')
    router.succeed('s1', 'qianwen-web')
    router.fail('s2', 'qianwen-web')
    // One failure either side of a working turn is not a broken site: a new
    // topic still prefers it over a site that would make the turn wait.
    expect(router.choose({
      key: 's3',
      candidates: ['qianwen-web', 'deepseek-web'],
      waitOf: site => (site === 'qianwen-web' ? 0 : 30_000),
    })).toBe('qianwen-web')
  })

  it('benches a site that keeps failing for every topic', () => {
    const now = { at: 0 }
    const router = new SiteRouter(
      policy({ cooldownMs: 0, escalateAfterFailures: 2, demoteMs: 60_000 }),
      clock(now),
    )
    router.fail('s1', 'qianwen-web')
    router.fail('s2', 'qianwen-web')
    // A site that failed two turns in a row is no longer a candidate for a
    // fresh topic until its demotion ends, even when it is the readier page.
    expect(router.choose({
      key: 's3',
      candidates: ['qianwen-web', 'deepseek-web'],
      waitOf: site => (site === 'qianwen-web' ? 0 : 30_000),
    })).toBe('deepseek-web')
    now.at = 61_000
    expect(router.choose({
      key: 's4',
      candidates: ['qianwen-web', 'deepseek-web'],
      waitOf: site => (site === 'qianwen-web' ? 0 : 30_000),
    })).toBe('qianwen-web')
  })

  it('runs on the failed site again when nothing outranks it', () => {
    const router = new SiteRouter(
      policy({ cooldownMs: 0, escalateAfterFailures: 2, siteRank: RANKS }),
      () => 0,
    )
    router.fail('s1', 'qianwen-web')
    router.fail('s1', 'qianwen-web')
    // No stronger site is mounted; a stuck turn on the old model still beats
    // no turn at all.
    expect(router.choose({ key: 's1', candidates: ['qianwen-web'], waitOf: () => 0 })).toBe('qianwen-web')
  })

  it('stops escalating when the mount turns it off', () => {
    const router = new SiteRouter(
      policy({ cooldownMs: 0, escalateAfterFailures: 0, siteRank: RANKS }),
      () => 0,
    )
    router.fail('s1', 'qianwen-web')
    router.fail('s1', 'qianwen-web')
    expect(router.choose({ key: 's1', candidates: RANKED, waitOf: () => 0 })).toBe('qianwen-web')
  })

  it('treats a site the mount does not rank as the weakest', () => {
    const router = new SiteRouter(
      policy({ cooldownMs: 0, escalateAfterFailures: 2, siteRank: RANKS }),
      () => 0,
    )
    router.fail('s1', 'custom-web')
    router.fail('s1', 'custom-web')
    expect(router.choose({ key: 's1', candidates: ['custom-web', 'deepseek-web'], waitOf: () => 0 }))
      .toBe('deepseek-web')
  })
})
