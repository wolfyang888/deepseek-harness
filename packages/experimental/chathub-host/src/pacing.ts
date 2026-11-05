/**
 * Turn pacing: the anti-abuse policy between the harness and a chat site.
 *
 * A web model is not an API. Every harness step spends one site conversation,
 * and a large refactor spends dozens: rapid-fire turns, back-to-back new
 * conversations, and retry storms are exactly the shape that gets an account
 * flagged. The governor keeps the loop inside a human-looking envelope —
 * a minimum gap between turns and a rolling hourly budget — and refuses a
 * turn it cannot legalize within a bounded wait instead of silently stalling.
 *
 * @module @deepseek-ai/dsh-experimental-chathub-host/pacing
 */

import { setTimeout as sleep } from 'node:timers/promises'
import { BrowserTransportError } from './errors.ts'
import type { PacingConfig, PacingPolicy, PacingProfile } from './types.ts'

/** One hour in milliseconds; the rolling budget window. */
const HOUR_MS = 3_600_000

/**
 * Shipped profiles, ordered from most cautious to most permissive.
 *
 * `conservative` is the default: a turn every 20 s and 40 turns an hour fits
 * an interactive session with room for the site's own limits, while still
 * letting a multi-file task finish in a working day. `balanced` halves the gap
 * for supervised runs; `responsive` is for short exploratory sessions where
 * the user is watching every step.
 */
export const PACING_PRESETS: Readonly<Record<Exclude<PacingProfile, 'off'>, PacingPolicy>> = {
  conservative: { minTurnGapMs: 20_000, maxTurnsPerHour: 40, maxWaitMs: 30_000 },
  balanced: { minTurnGapMs: 10_000, maxTurnsPerHour: 90, maxWaitMs: 20_000 },
  responsive: { minTurnGapMs: 3_000, maxTurnsPerHour: 240, maxWaitMs: 10_000 },
}

/** The policy of a site that opts out entirely. */
const UNPACED: PacingPolicy = { minTurnGapMs: 0, maxTurnsPerHour: 0, maxWaitMs: 0 }

/**
 * Fold a partial configuration into one policy.
 * @param config - profile choice plus optional per-field overrides.
 * @returns The effective policy; `off` disables pacing.
 */
export function resolvePacing(config: PacingConfig | undefined): PacingPolicy {
  const profile = config?.profile ?? 'conservative'
  if (profile === 'off') return UNPACED
  const preset = PACING_PRESETS[profile]
  return {
    minTurnGapMs: config?.minTurnGapMs ?? preset.minTurnGapMs,
    maxTurnsPerHour: config?.maxTurnsPerHour ?? preset.maxTurnsPerHour,
    maxWaitMs: config?.maxWaitMs ?? preset.maxWaitMs,
  }
}

/**
 * Admits turns only while the site's pacing envelope allows them.
 *
 * State is per site: two providers are two accounts, two envelopes. The
 * governor records a turn when it admits one, so the gap is measured between
 * turn starts — a turn that itself takes 40 s already satisfies a 20 s gap.
 */
export class PacingGovernor {
  private readonly lastStart = new Map<string, number>()
  private readonly starts = new Map<string, number[]>()

  /**
   * @param policy - resolved envelope.
   * @param now - clock, injectable for tests.
   * @param wait - sleep, injectable for tests.
   */
  constructor(
    private readonly policy: PacingPolicy,
    private readonly now: () => number = () => Date.now(),
    private readonly wait: (ms: number) => Promise<void> = async (ms) => {
      await sleep(ms)
    },
  ) {}

  /**
   * Wait for the site's next legal turn, or refuse when the wait is too long.
   * @param site - site provider id; its envelope is independent of the others.
   * @returns Resolves when a turn may start; the turn is recorded then.
   * @throws BrowserTransportError with `chathub-paced` when the required wait
   *   exceeds `maxWaitMs` — the caller should retry later, not now.
   */
  async admit(site: string): Promise<void> {
    if (this.policy.minTurnGapMs === 0 && this.policy.maxTurnsPerHour === 0) return
    const required = this.requiredWait(site, this.now())
    if (required > this.policy.maxWaitMs) {
      throw new BrowserTransportError(
        'chathub-paced',
        `${site}: the anti-abuse budget needs a ${Math.ceil(required / 1000)}s wait `
          + `(gap ${this.policy.minTurnGapMs}ms, ${this.policy.maxTurnsPerHour} turns/hour); retry later`,
      )
    }
    if (required > 0) await this.wait(required)
    this.record(site, this.now())
  }

  /**
   * @param site - site provider id.
   * @param at - current clock reading.
   * @returns Milliseconds before the next turn is legal; 0 means now.
   */
  private requiredWait(site: string, at: number): number {
    let wait = 0
    const last = this.lastStart.get(site)
    if (last !== undefined && this.policy.minTurnGapMs > 0) {
      wait = Math.max(wait, last + this.policy.minTurnGapMs - at)
    }
    if (this.policy.maxTurnsPerHour > 0) {
      const window = this.windowOf(site, at)
      const oldest = window[0]
      // The budget frees up when the oldest recorded turn leaves the window.
      if (oldest !== undefined && window.length >= this.policy.maxTurnsPerHour) {
        wait = Math.max(wait, oldest + HOUR_MS - at)
      }
    }
    return Math.max(0, wait)
  }

  /**
   * @param site - site provider id.
   * @param at - current clock reading.
   * @returns Recorded turn starts still inside the rolling hour, oldest first.
   */
  private windowOf(site: string, at: number): number[] {
    const kept = (this.starts.get(site) ?? []).filter(start => at - start < HOUR_MS)
    this.starts.set(site, kept)
    return kept
  }

  /**
   * @param site - site provider id.
   * @param at - turn start to record.
   */
  private record(site: string, at: number): void {
    this.lastStart.set(site, at)
    if (this.policy.maxTurnsPerHour > 0) this.windowOf(site, at).push(at)
  }
}
