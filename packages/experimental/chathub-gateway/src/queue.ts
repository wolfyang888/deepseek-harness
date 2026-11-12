/**
 * Per-site admission counting: pending requests over the limit answer 429
 * immediately instead of piling up.
 *
 * The host transport already serializes turns on one site page; this counter
 * exists so an agent flooding a site with concurrent requests gets a bounded
 * answer rather than unbounded sockets. Different sites never share counts.
 *
 * @module @deepseek-ai/dsh-experimental-chathub-gateway/queue
 */

/** Rejection an over-limit admission produces. */
export type QueueRejection = { kind: 'queue-full' }

/** One accepted admission and how the request ends it. */
export type QueueAdmission =
  | { kind: 'accepted'; release: () => void }
  | QueueRejection

/**
 * Registry of per-site pending counters with one shared limit.
 */
export class SiteQueues {
  private readonly pending = new Map<string, number>()

  /**
   * @param limit - pending requests every site accepts before rejecting.
   */
  constructor(readonly limit: number) {}

  /**
   * Count one request as pending on its site.
   * @param site - the model id, which is the site id.
   * @returns The admission, or the rejection when the site is over the limit.
   */
  enter(site: string): QueueAdmission {
    const current = this.pending.get(site) ?? 0
    if (current >= this.limit) return { kind: 'queue-full' }
    this.pending.set(site, current + 1)
    // The HTTP layer runs release exactly once per accepted request from a
    // finally block; the clamp keeps a stray double call from undercounting.
    return {
      kind: 'accepted',
      release: () => {
        const now = this.pending.get(site) ?? 1
        this.pending.set(site, Math.max(0, now - 1))
      },
    }
  }

  /**
   * Read one site's pending count.
   * @param site - the model id, which is the site id.
   * @returns Pending requests on that site.
   */
  size(site: string): number {
    return this.pending.get(site) ?? 0
  }
}
