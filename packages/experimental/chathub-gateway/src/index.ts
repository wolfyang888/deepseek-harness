/**
 * Cordis plugin: expose mounted ChatHub site routes over a local OpenAI wire.
 *
 * Mounted after the ChatHub host layer and the llm-chathub adapter, the
 * gateway answers `/v1/models` and `/v1/chat/completions` by forwarding to
 * the `ctx.llm` routes those layers already registered, so an external coding
 * agent (Codex, Trae, WorkBuddy, …) can list and use the site models through
 * its own model selector. Anthropic-wire routes are deferred work.
 *
 * @module @deepseek-ai/dsh-experimental-chathub-gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-chathub-host'
import z from '@deepseek-ai/schemastery'
import { ChatHubGateway } from './server.ts'
import type { ChatHubGatewayConfig } from './types.ts'

export { ChatHubGateway } from './server.ts'
export { classifyFailure, failureFromError } from './errors.ts'
export { sseRenderer, toCompletionResponse, toGenerateOptions } from './openai-wire.ts'
export * from './types.ts'

/** Configuration as the mounting profile writes it; defaults fill the rest. */
export interface Config {
  /** Bind address; the loopback default keeps the gateway machine-local. */
  host: string
  /** Bind port. */
  port: number
  /** Bearer key; empty means no check, safe only on a loopback bind. */
  apiKey: string
  /** Mounted site ids to expose; empty means every health-known site. */
  sites: readonly string[]
  /** Pending requests one site accepts before answering 429. */
  maxQueuePerSite: number
  /** Interval between SSE keepalive writes while a site turn runs. */
  keepaliveMs: number
}

/** Schema of the mounting row; every field carries a default. */
export const Config = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.natural().max(65_535).default(8787),
  apiKey: z.string().default(''),
  sites: z.array(z.string().min(1)).default([]),
  maxQueuePerSite: z.natural().min(1).default(8),
  keepaliveMs: z.natural().min(1).default(15_000),
})

export const name = 'chathub-gateway'
/** The gateway needs the LLM seam and the mounted browser transport health. */
export const inject = ['llm', 'webChatTransport']

/**
 * Mount the gateway: resolve the row, start listening, stop with the context.
 * @param ctx - context carrying `llm` and the mounted `webChatTransport`.
 * @param config - mounting row with defaults applied.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ChatHubGatewayConfig = {
    host: config.host,
    port: config.port,
    apiKey: config.apiKey,
    sites: config.sites,
    maxQueuePerSite: config.maxQueuePerSite,
    keepaliveMs: config.keepaliveMs,
  }
  const gateway = new ChatHubGateway(ctx, resolved)
  // Bind errors reject here and crash the mount, matching fail-loud
  // misconfiguration handling.
  void gateway.start()
}
