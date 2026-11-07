/**
 * Cordis plugin: mount one browser-backed site as an LLM provider route.
 *
 * Mounted together with the ChatHub host layer, so the adapter borrows the
 * transport, profile, and login state the panel already needs instead of
 * launching a browser of its own.
 *
 * @module @deepseek-ai/dsh-experimental-llm-chathub
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-chathub-host'
import z from '@deepseek-ai/schemastery'
import { ChatHubLlmAdapter } from './adapter.ts'
import {
  DEFAULT_CHATHUB_LLM_CONFIG,
  DEFAULT_SITE_RANK,
  DEFAULT_SITE_ROUTING,
  type ChatHubAuxiliaryPolicy,
  type ChatHubLlmConfig,
  type ChatHubTurnObservation,
  type SiteRoutingPolicy,
  type SiteSelectionMode,
  type SiteSelectionStrategy,
} from './types.ts'

export { ChatHubLlmAdapter } from './adapter.ts'
export { parseAnswer, formatToolCall, TOOL_CALL_CLOSE, TOOL_CALL_OPEN, END_MARKER } from './protocol.ts'
export { renderRequest } from './render.ts'
export { SiteRouter, type SiteChoiceRequest } from './router.ts'
export { clampText, clampToolResult } from './budget.ts'
export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One completed ChatHub LLM turn, for budgeting and drift diagnosis.
     * @mode emit
     * @param record - lengths, tool name, and outcome; never prompt or answer text.
     */
    'chathub-llm/turn'(record: ChatHubTurnObservation): void
  }
}

/** Configuration as the mounting profile writes it; defaults fill the rest. */
export type Config = Omit<
  ChatHubLlmConfig,
  'onTurn' | 'route' | 'routes' | 'sites' | 'workspaceRoot' | 'auxiliary' | 'autoRoute' | 'routing'
> & {
  /** Provider route to register; defaults to `<site>-chathub` and forces one site. */
  route?: string
  /** Every site to mount; defaults to `[site]`. Ignored when `route` is set. */
  sites?: readonly string[]
  /** Absolute workspace root path arguments must stay under. */
  workspaceRoot?: string
  /** Whether auxiliary calls may spend a site turn; defaults to `refuse`. */
  auxiliary?: ChatHubAuxiliaryPolicy
  /**
   * Route selection across mounted sites. `auto` also registers one aggregate
   * route that picks a site per turn; `fixed` registers only the per-site
   * routes. Defaults to `auto`, which changes nothing for a single-site mount.
   */
  selection?: SiteSelectionMode
  /** Placement strategy of the aggregate route; defaults to `sticky`. */
  selectionStrategy?: SiteSelectionStrategy
  /** Route id of the aggregate route; defaults to `web-auto-chathub`. */
  autoRoute?: string
  /** How long one topic keeps its site, in milliseconds. */
  stickyTtlMs?: number
  /** Longest pacing wait tolerated to keep a topic on its site. */
  stickyMaxWaitMs?: number
  /** How long a site that failed a turn stays out of rotation. */
  siteCooldownMs?: number
  /** Extra sites one turn may try after a site-level failure. */
  failoverAttempts?: number
  /** Consecutive failures before a topic moves to a stronger site. */
  escalateAfterFailures?: number
  /** How long a site that keeps failing stays benched. */
  siteDemoteMs?: number
  /** Capability rank per site, e.g. `{ 'chatgpt-web': 30 }`. */
  siteRank?: Readonly<Record<string, number>>
  /** Whether a prose reply before any tool run replays on the next site. */
  proseReplay?: boolean
}

/** Schema of the mounting row; every field is optional except the site. */
export const Config = z.object({
  site: z.string().min(1).default('deepseek-web'),
  route: z.string(),
  sites: z.array(z.string().min(1)).default([]),
  model: z.string().min(1).default(DEFAULT_CHATHUB_LLM_CONFIG.model),
  contextWindow: z.natural().min(1).default(DEFAULT_CHATHUB_LLM_CONFIG.contextWindow),
  maxPromptChars: z.natural().min(1).default(DEFAULT_CHATHUB_LLM_CONFIG.maxPromptChars),
  maxToolResultChars: z.natural().min(1).default(DEFAULT_CHATHUB_LLM_CONFIG.maxToolResultChars),
  maxSystemChars: z.natural().default(DEFAULT_CHATHUB_LLM_CONFIG.maxSystemChars),
  historyTurns: z.natural().default(DEFAULT_CHATHUB_LLM_CONFIG.historyTurns),
  allowTools: z.array(z.string()).default([...DEFAULT_CHATHUB_LLM_CONFIG.allowTools]),
  denyPaths: z.array(z.string()).default([...DEFAULT_CHATHUB_LLM_CONFIG.denyPaths]),
  verifyCommands: z.array(z.string()).default([...DEFAULT_CHATHUB_LLM_CONFIG.verifyCommands]),
  workspaceRoot: z.string(),
  maxToolCallsPerTurn: z.natural().min(1).default(DEFAULT_CHATHUB_LLM_CONFIG.maxToolCallsPerTurn),
  repairAttempts: z.natural().default(DEFAULT_CHATHUB_LLM_CONFIG.repairAttempts),
  auxiliary: z.union([z.const('refuse'), z.const('allow')]).default(DEFAULT_CHATHUB_LLM_CONFIG.auxiliary),
  selection: z.union([z.const('auto'), z.const('fixed')]).default('auto'),
  selectionStrategy: z.union([z.const('sticky'), z.const('round-robin')]).default(DEFAULT_SITE_ROUTING.strategy),
  autoRoute: z.string().min(1).default('web-auto-chathub'),
  stickyTtlMs: z.natural().default(DEFAULT_SITE_ROUTING.stickyTtlMs),
  stickyMaxWaitMs: z.natural().default(DEFAULT_SITE_ROUTING.stickyMaxWaitMs),
  siteCooldownMs: z.natural().default(DEFAULT_SITE_ROUTING.cooldownMs),
  failoverAttempts: z.natural().default(DEFAULT_SITE_ROUTING.failoverAttempts),
  escalateAfterFailures: z.natural().default(DEFAULT_SITE_ROUTING.escalateAfterFailures),
  siteDemoteMs: z.natural().default(DEFAULT_SITE_ROUTING.demoteMs),
  siteRank: z.dict(z.natural()).default({}),
  proseReplay: z.boolean().default(DEFAULT_SITE_ROUTING.proseReplay),
})

export const name = 'llm-chathub'
/** The adapter needs the LLM seam and the mounted browser transport. */
export const inject = ['llm', 'webChatTransport']

/**
 * Resolve a mounting row into the adapter's runtime configuration.
 * @param config - row values, with defaults already applied by the schema.
 * @param emit - sink for one record per completed turn.
 * @returns Complete configuration; one route per site, `<site>-chathub` unless
 * the row names a single explicit route.
 */
export function resolveConfig(
  config: Config,
  emit: (record: ChatHubTurnObservation) => void,
): ChatHubLlmConfig {
  // An explicit route pins the mount to one site: two names for one route
  // would make "which site answered" ambiguous.
  const listed = config.sites ?? []
  const sites = config.route !== undefined ? [config.site] : (listed.length === 0 ? [config.site] : listed)
  const siteRoutes = sites.map(site => `${site}-chathub`)
  // Auto selection is an extra route, never a redirection: the per-site routes
  // stay registered, so picking `qianwen-web` in the panel still means qianwen.
  const auto = (config.selection ?? 'auto') === 'auto' && sites.length > 1
  const autoRoute = auto ? config.autoRoute ?? 'web-auto-chathub' : undefined
  const routing: SiteRoutingPolicy | undefined = autoRoute === undefined ? undefined : {
    strategy: config.selectionStrategy ?? DEFAULT_SITE_ROUTING.strategy,
    stickyTtlMs: config.stickyTtlMs ?? DEFAULT_SITE_ROUTING.stickyTtlMs,
    stickyMaxWaitMs: config.stickyMaxWaitMs ?? DEFAULT_SITE_ROUTING.stickyMaxWaitMs,
    cooldownMs: config.siteCooldownMs ?? DEFAULT_SITE_ROUTING.cooldownMs,
    failoverAttempts: config.failoverAttempts ?? DEFAULT_SITE_ROUTING.failoverAttempts,
    escalateAfterFailures: config.escalateAfterFailures ?? DEFAULT_SITE_ROUTING.escalateAfterFailures,
    demoteMs: config.siteDemoteMs ?? DEFAULT_SITE_ROUTING.demoteMs,
    // A mount that ranks only some sites keeps the shipped ranks for the rest:
    // otherwise an unranked chatgpt would rank below a ranked qianwen and the
    // escalation would never reach it.
    siteRank: { ...DEFAULT_SITE_RANK, ...config.siteRank },
    proseReplay: config.proseReplay ?? DEFAULT_SITE_ROUTING.proseReplay,
  }
  return {
    site: config.site,
    sites,
    route: config.route ?? `${sites[0]}-chathub`,
    routes: autoRoute === undefined ? siteRoutes : [...siteRoutes, autoRoute],
    ...autoRoute === undefined ? {} : { autoRoute },
    ...routing === undefined ? {} : { routing },
    model: config.model,
    contextWindow: config.contextWindow,
    maxPromptChars: config.maxPromptChars,
    maxToolResultChars: config.maxToolResultChars,
    maxSystemChars: config.maxSystemChars,
    historyTurns: config.historyTurns,
    allowTools: config.allowTools,
    denyPaths: config.denyPaths,
    verifyCommands: config.verifyCommands,
    // The host process runs inside the workspace, so its cwd is the root the
    // path guard compares against unless the row states another one.
    workspaceRoot: workspaceRootOf(config.workspaceRoot),
    maxToolCallsPerTurn: config.maxToolCallsPerTurn,
    repairAttempts: config.repairAttempts,
    auxiliary: config.auxiliary ?? DEFAULT_CHATHUB_LLM_CONFIG.auxiliary,
    onTurn: emit,
  }
}

/**
 * Resolve the root the path guard compares against.
 *
 * A relative root would make the guard silently accept nothing (or everything,
 * depending on how the call site joins it), so a stated root must be absolute;
 * the trailing separator is dropped so `/repo/` and `/repo` compare equal.
 * @param root - root the mounting row states, if any.
 * @returns An absolute path without a trailing separator.
 * @throws Error when the stated root is not absolute.
 */
function workspaceRootOf(root: string | undefined): string {
  const stated = root?.trim()
  const absolute = stated === undefined || stated.length === 0 ? process.cwd() : stated
  if (!isAbsolute(absolute)) {
    throw new Error(`llm-chathub: workspaceRoot "${absolute}" must be an absolute path`)
  }
  const trimmed = absolute.replace(/[\\/]+$/u, '')
  return trimmed.length === 0 ? absolute : trimmed
}

/**
 * Register the configured site as one LLM provider route.
 * @param ctx - context carrying `llm` and the mounted `webChatTransport`.
 * @param config - mounting row.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config, (record) => { ctx.emit('chathub-llm/turn', record) })
  const adapter = new ChatHubLlmAdapter({
    transportForAdapter: () => ctx.webChatTransport.transportForAdapter(),
    providers: () => ctx.webChatTransport.providers(),
  }, resolved)
  const registration = ctx.llm.registerAdapter([...resolved.routes], adapter)
  ctx.effect(() => () => { registration() })
}
