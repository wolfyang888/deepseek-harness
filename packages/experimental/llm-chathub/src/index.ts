/**
 * Cordis plugin: mount one browser-backed site as an LLM provider route.
 *
 * Mounted together with the ChatHub host layer, so the adapter borrows the
 * transport, profile, and login state the panel already needs instead of
 * launching a browser of its own.
 *
 * @module @deepseek-ai/dsh-experimental-llm-chathub
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-chathub-host'
import z from '@deepseek-ai/schemastery'
import { ChatHubLlmAdapter } from './adapter.ts'
import {
  DEFAULT_CHATHUB_LLM_CONFIG,
  type ChatHubLlmConfig,
  type ChatHubTurnObservation,
} from './types.ts'

export { ChatHubLlmAdapter } from './adapter.ts'
export { parseAnswer, formatToolCall, TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from './protocol.ts'
export { renderRequest } from './render.ts'
export { clampText } from './budget.ts'
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
export type Config = Omit<ChatHubLlmConfig, 'onTurn' | 'route' | 'workspaceRoot'> & {
  /** Provider route to register; defaults to `<site>-chathub`. */
  route?: string
  /** Absolute workspace root path arguments must stay under. */
  workspaceRoot?: string
}

/** Schema of the mounting row; every field is optional except the site. */
export const Config = z.object({
  site: z.string().min(1).default('deepseek-web'),
  route: z.string(),
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
})

export const name = 'llm-chathub'
/** The adapter needs the LLM seam and the mounted browser transport. */
export const inject = ['llm', 'webChatTransport']

/**
 * Resolve a mounting row into the adapter's runtime configuration.
 * @param config - row values, with defaults already applied by the schema.
 * @param emit - sink for one record per completed turn.
 * @returns Complete configuration; the route defaults to `<site>-chathub`.
 */
export function resolveConfig(
  config: Config,
  emit: (record: ChatHubTurnObservation) => void,
): ChatHubLlmConfig {
  return {
    site: config.site,
    route: config.route ?? `${config.site}-chathub`,
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
    workspaceRoot: config.workspaceRoot ?? process.cwd(),
    maxToolCallsPerTurn: config.maxToolCallsPerTurn,
    repairAttempts: config.repairAttempts,
    onTurn: emit,
  }
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
  const registration = ctx.llm.registerAdapter([resolved.route], adapter)
  ctx.effect(() => () => { registration() })
}
