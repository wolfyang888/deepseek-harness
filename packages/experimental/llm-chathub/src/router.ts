/**
 * Placement of one turn across the mounted sites.
 *
 * A web model is spent per turn: one page, one conversation, one account
 * budget. When several sites are mounted, which one answers is a policy
 * question, not an accident — a topic should keep one model so its follow-ups
 * read consistently, a new topic should land somewhere fresh so one account
 * does not absorb a whole session, and a site that is throttled or refusing
 * should cost the turn a different site rather than twenty seconds of sleep.
 *
 * @module @deepseek-ai/dsh-experimental-llm-chathub/router
 */

import { DEFAULT_SITE_ROUTING, type SiteRoutingPolicy } from './types.ts'

/** One turn's placement inputs. */
export interface SiteChoiceRequest {
  /** Topic key: the harness session, or `default` when the caller stamped none. */
  readonly key: string
  /** Sites that may serve this turn, already health-checked and mounted. */
  readonly candidates: readonly string[]
  /** The site a pinned route fixes; when present no selection happens. */
  readonly pinned?: string | undefined
  /** Milliseconds each site must still wait before its next legal turn. */
  readonly waitOf: (site: string) => number
}

/** What the router remembers about one topic. */
interface Affinity {
  readonly site: string
  readonly at: number
}

/**
 * Turns a set of healthy sites into one choice per turn, and remembers it.
 *
 * The router holds no browser and no config beyond its policy: it is the
 * decision layer between "these sites can serve" and "this site serves".
 */
export class SiteRouter {
  /** Topic key to the site its conversation is currently on. */
  private readonly affinities = new Map<string, Affinity>()
  /** Site to the instant its cooldown ends. */
  private readonly cooldowns = new Map<string, number>()
  /** Site to the last instant it was picked, for spreading new topics. */
  private readonly lastPicked = new Map<string, number>()
  /** `topic\0site` to consecutive failures, reset by a turn that succeeds. */
  private readonly topicFailures = new Map<string, number>()
  /** Site to consecutive failed turns, reset by a turn that succeeds. */
  private readonly siteFailures = new Map<string, number>()
  /** Site to the instant its demotion ends. */
  private readonly demotions = new Map<string, number>()
  /** Topic key to the lowest rank its next site must beat. */
  private readonly floors = new Map<string, number>()
  /** Rotation cursor of the `round-robin` strategy. */
  private cursor = 0

  /**
   * @param policy - placement policy; defaults to the shipped one.
   * @param now - clock, injectable for tests.
   */
  constructor(
    private readonly policy: SiteRoutingPolicy = DEFAULT_SITE_ROUTING,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Pick the site that serves this turn.
   * @param request - topic key, eligible sites, and the per-site waits.
   * @returns The chosen site provider id.
   * @throws Error when the request carries no candidate at all.
   */
  choose(request: SiteChoiceRequest): string {
    if (request.pinned !== undefined) return request.pinned
    const at = this.now()
    // A cooled-down or benched site is skipped while any other can serve; when
    // every candidate is out, the turn still runs, and its failure reports why.
    const open = request.candidates.filter(site => !this.cooling(site, at))
    const fresh = open.filter(site => !this.demoted(site, at))
    const pool = this.stricter(request.key, fresh.length > 0 ? fresh : open)
    const first = pool[0]
    if (first === undefined) throw new Error('chathub-llm: no site can serve this turn')

    if (this.policy.strategy === 'round-robin') return this.pin(request.key, this.rotate(pool), at)

    const affine = this.affine(request.key, at)
    if (affine !== undefined && pool.includes(affine)) {
      // Keep one voice unless doing so would stall the turn behind pacing.
      if (request.waitOf(affine) <= this.policy.stickyMaxWaitMs) return this.pin(request.key, affine, at)
    }
    return this.pin(request.key, this.soonest(pool, request.waitOf), at)
  }

  /**
   * Record that a site answered off-protocol without penalizing the account.
   *
   * A prose reply before any tool has run is the model dodging the block
   * format, not a page or sign-in failure: the site served the turn and its
   * answer may still be delivered when nothing stronger exists. Only the
   * topic's escalation counter moves, so repeated misses steer the topic to a
   * stronger site while the account keeps serving other topics.
   * @param key - topic key.
   * @param site - site whose reply missed the protocol.
   */
  miss(key: string, site: string): void {
    const pair = topicSite(key, site)
    const forTopic = (this.topicFailures.get(pair) ?? 0) + 1
    this.topicFailures.set(pair, forTopic)
    const limit = this.policy.escalateAfterFailures
    if (limit > 0 && forTopic >= limit) {
      this.topicFailures.delete(pair)
      this.floors.set(key, Math.max(this.floors.get(key) ?? Number.NEGATIVE_INFINITY, this.rankOf(site)))
    }
    // The topic must not stick to a site that dodges the protocol.
    this.affinities.delete(key)
  }

  /**
   * Record that a turn on this site succeeded; the topic stays where it ran.
   *
   * A success is also the only thing that clears a failure streak: one working
   * turn proves the account and the page are usable again, so the site returns
   * to the rotation with its rank intact.
   * @param key - topic key.
   * @param site - site that answered.
   */
  succeed(key: string, site: string): void {
    this.topicFailures.delete(topicSite(key, site))
    this.siteFailures.delete(site)
    this.pin(key, site, this.now())
  }

  /**
   * Record that an attempt on this site failed.
   *
   * Beyond the per-site cooldown, repeated failure changes what the topic is
   * allowed to run on: the site is benched from fresh topics for `demoteMs`
   * once it fails `escalateAfterFailures` turns in a row, and the topic's next
   * site must rank above the one that failed it `escalateAfterFailures` times.
   * That is the difference between "wait and retry the same model" and "this
   * conversation needs a model that follows the protocol".
   * @param key - topic key.
   * @param site - site whose attempt failed.
   */
  fail(key: string, site: string): void {
    const pair = topicSite(key, site)
    const forTopic = (this.topicFailures.get(pair) ?? 0) + 1
    this.topicFailures.set(pair, forTopic)
    const forSite = (this.siteFailures.get(site) ?? 0) + 1
    this.siteFailures.set(site, forSite)
    const limit = this.policy.escalateAfterFailures
    if (limit > 0) {
      if (forTopic >= limit) {
        this.topicFailures.delete(pair)
        this.floors.set(key, Math.max(this.floors.get(key) ?? Number.NEGATIVE_INFINITY, this.rankOf(site)))
      }
      if (forSite >= limit) {
        this.siteFailures.delete(site)
        this.demotions.set(site, this.now() + this.policy.demoteMs)
      }
    }
    this.penalize(site)
    // The failed site must not keep the topic's affinity; otherwise the topic
    // would return to it as soon as its cooldown ends.
    this.affinities.delete(key)
  }

  /**
   * Record that a site failed a turn without blaming one topic.
   * @param site - site that failed.
   */
  penalize(site: string): void {
    if (this.policy.cooldownMs <= 0) return
    const until = this.now() + this.policy.cooldownMs
    this.cooldowns.set(site, until)
    for (const [key, affinity] of this.affinities) {
      if (affinity.site === site) this.affinities.delete(key)
    }
  }

  /**
   * @param site - site provider id.
   * @returns Its configured capability rank, or 0 when the mount ranks it not.
   */
  private rankOf(site: string): number {
    return this.policy.siteRank[site] ?? 0
  }

  /**
   * Narrow a pool to sites that can lift a stuck topic.
   * @param key - topic key.
   * @param pool - sites that may serve this turn.
   * @returns The nearest stronger rank, or the pool unchanged when no site
   * ranks above the topic's floor.
   */
  private stricter(key: string, pool: readonly string[]): readonly string[] {
    const floor = this.floors.get(key)
    if (floor === undefined) return pool
    const stronger = pool.filter(site => this.rankOf(site) > floor)
    if (stronger.length === 0) {
      // Nothing stronger is left; a stuck turn on the old model still beats no
      // turn at all, so the floor stops constraining this topic.
      this.floors.delete(key)
      return pool
    }
    // One capability step, not straight to the top: the cheapest model that may
    // still follow the protocol is the right replacement first.
    const nearest = Math.min(...stronger.map(site => this.rankOf(site)))
    return stronger.filter(site => this.rankOf(site) === nearest)
  }

  /**
   * @param key - topic key.
   * @param at - current clock reading.
   * @returns The site the topic is on, if the affinity is still fresh.
   */
  private affine(key: string, at: number): string | undefined {
    if (this.policy.stickyTtlMs <= 0) return undefined
    const affinity = this.affinities.get(key)
    if (affinity === undefined) return undefined
    if (at - affinity.at > this.policy.stickyTtlMs) {
      this.affinities.delete(key)
      return undefined
    }
    return affinity.site
  }

  /**
   * @param site - site provider id.
   * @param at - current clock reading.
   * @returns Whether the site is still inside a failure cooldown.
   */
  private cooling(site: string, at: number): boolean {
    const until = this.cooldowns.get(site)
    if (until === undefined) return false
    if (at < until) return true
    this.cooldowns.delete(site)
    return false
  }

  /**
   * @param site - site provider id.
   * @param at - current clock reading.
   * @returns Whether the site is still benched for repeated failure.
   */
  private demoted(site: string, at: number): boolean {
    const until = this.demotions.get(site)
    if (until === undefined) return false
    if (at < until) return true
    this.demotions.delete(site)
    return false
  }

  /**
   * @param pool - eligible sites.
   * @param waitOf - per-site pacing wait.
   * @returns The site that can start soonest, oldest-used first on a tie.
   */
  private soonest(pool: readonly string[], waitOf: (site: string) => number): string {
    const waits = pool.map(site => waitOf(site))
    const soonestWait = Math.min(...waits)
    const ready = pool.filter((_, index) => waits[index] === soonestWait)
    const first = ready[0] as string
    if (ready.length === 1) return first
    // Among equally ready sites, spread topics: the one used longest ago wins,
    // and sites never used at all take turns in rotation so two fresh topics
    // do not both land on the same account.
    const used = ready.map(site => this.lastPicked.get(site) ?? Number.NEGATIVE_INFINITY)
    const oldest = Math.min(...used)
    const candidates = ready.filter((_, index) => used[index] === oldest)
    if (candidates.length === 1) return candidates[0] as string
    const pick = candidates[this.cursor % candidates.length] as string
    this.cursor += 1
    return pick
  }

  /**
   * @param pool - eligible sites.
   * @returns The next site in rotation.
   */
  private rotate(pool: readonly string[]): string {
    const site = pool[this.cursor % pool.length] as string
    this.cursor += 1
    return site
  }

  /**
   * @param key - topic key.
   * @param site - site to bind the topic to.
   * @param at - current clock reading.
   * @returns The site, so callers can return the binding they just made.
   */
  private pin(key: string, site: string, at: number): string {
    this.affinities.set(key, { site, at })
    this.lastPicked.set(site, at)
    return site
  }
}

/**
 * @param key - topic key.
 * @param site - site provider id.
 * @returns The map key of one topic's failure streak on one site.
 */
function topicSite(key: string, site: string): string {
  return `${key}\u0000${site}`
}
