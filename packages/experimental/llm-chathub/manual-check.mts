/* Owner-local real-browser check for the web-model route. Run from the repo root:
     pnpm exec tsx packages/experimental/llm-chathub/manual-check.mts \
       "qianwen-web,deepseek-web,chatgpt-web"
   Sign in to every listed site in the profile once, then run it. The check is
   deliberately shaped like the way this route is used, not like a smoke test:
   multi-step turns that read real files until the model answers, a
   multi-kilobyte prompt, and a directory turn that forces several consecutive
   reads plus offset/limit paging past the result clamp. A single "reply ok"
   proves the page loads, not that a coding turn works. Only `read` calls are
   executed (against the working tree); an edit or write call is reported and
   the turn stops. Delete the profile directory when done. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'
import {
  createAssistantMessage,
  createToolResultMessage,
  type RequestMessage,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { resolvePacing } from '../chathub-host/src/pacing.ts'
import { discoverChromeExecutable } from '../chathub-host/src/executable.ts'
import { PlaywrightBrowserRuntime } from '../chathub-host/src/runtime.ts'
import { PlaywrightWebChatTransport } from '../chathub-host/src/transport.ts'
import { resolveSiteDrivers } from '../chathub-host/src/drivers.ts'
import { ChatHubLlmAdapter } from './src/adapter.ts'
import { resolveConfig } from './src/index.ts'
import type { ChatHubTurnObservation } from './src/types.ts'

const sites = (process.argv[2] ?? process.env.DSH_CHATHUB_LLM_SITES ?? 'qianwen-web')
  .split(',')
  .map(site => site.trim())
  .filter(Boolean)
if (sites.length === 0) throw new Error('name at least one site')

const profileDir = process.env.DSH_CHATHUB_PROFILE_DIR
  ?? `${process.env.HOME ?? process.env.USERPROFILE ?? '.'}/.dsh/chathub-profile`
const executablePath = process.env.DSH_CHATHUB_EXECUTABLE_PATH
  ?? discoverChromeExecutable()
const browserConfig = {
  mode: 'managed' as const,
  profileDir,
  headless: false,
  ...executablePath === undefined ? {} : { executablePath },
}

const drivers = resolveSiteDrivers({})
const runtime = new PlaywrightBrowserRuntime(
  browserConfig,
  { actionTimeoutMs: 15_000, pollMs: 500 },
  chromium,
)
const transport = new PlaywrightWebChatTransport(
  runtime,
  {
    browser: browserConfig,
    loginTimeoutMs: 300_000,
    turnTimeoutMs: 180_000,
    actionTimeoutMs: 15_000,
    pollMs: 500,
    stablePolls: 3,
    maxQueuedTurns: 2,
    typeDelayMs: 0,
    drivers: {},
    // Supervised, watched run: the responsive envelope keeps a multi-step
    // turn moving where the default conservative gap would stall it.
    pacing: resolvePacing({ profile: 'responsive' }),
  },
  drivers,
)

const records: ChatHubTurnObservation[] = []
const resolved = resolveConfig({
  site: sites[0] as string,
  sites,
  model: 'web-model',
  contextWindow: 128_000,
  maxPromptChars: 48_000,
  maxToolResultChars: 6_000,
  maxSystemChars: 4_000,
  historyTurns: 8,
  allowTools: ['read', 'grep', 'glob', 'edit', 'write'],
  denyPaths: ['.git', 'node_modules'],
  verifyCommands: ['pnpm run typecheck'],
  workspaceRoot: process.cwd(),
  maxToolCallsPerTurn: 1,
  repairAttempts: 1,
  auxiliary: 'refuse',
  selection: 'auto',
  selectionStrategy: 'sticky',
  autoRoute: 'web-auto-chathub',
  stickyTtlMs: 1_800_000,
  stickyMaxWaitMs: 3_000,
  siteCooldownMs: 600_000,
  failoverAttempts: 1,
  escalateAfterFailures: 2,
  siteDemoteMs: 1_800_000,
  siteRank: {},
}, record => records.push(record))

const adapter = new ChatHubLlmAdapter({
  transportForAdapter: () => transport,
  providers: () => Promise.resolve(sites.map(id => ({ id, health: { status: 'ready' } }))),
}, resolved)

/** A file listing long enough to hit a composer ceiling if one exists. */
const CONTEXT = Array.from({ length: 120 }, (_, index) => `packages/experimental/module-${String(index)}/src/handler.ts`).join('\n')

const TOOLS = [
  {
    name: 'read',
    description: 'Read a file; offset is the 1-based first line, limit caps the line count',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['file_path'],
    },
  },
  { name: 'edit', description: 'Replace one exact string in a file', parameters: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] } },
]

const turns = [
  `Read packages/experimental/chathub-host/src/transport.ts and report the stable failure token used when a site is paced. Then replace the word RUNAWAY with PACED in the constant list. Repository files:\n${CONTEXT}`,
  'Same task for packages/experimental/chathub-host/src/pacing.ts: report its default preset name and the one change you would make to shorten the wait.',
  'Read every file under packages/experimental/llm-chathub/src (adapter.ts, budget.ts, index.ts, protocol.ts, render.ts, router.ts, types.ts), one read call per file, until all seven are read — then report one line per file: its path and the main export it declares.',
]

/** Steps one turn may take; each step is one site conversation on the account. */
const MAX_STEPS = 14
/** Lines one local read returns, matching the fs read tool's default window. */
const READ_LIMIT = 2_000

/**
 * Run one `read` call against the working tree, honoring the offset/limit
 * paging the clamp marker tells the model to use.
 * @param argumentsDelta - raw JSON arguments of the call.
 * @returns The numbered envelope the fs read tool renders.
 */
async function readResult(argumentsDelta: string): Promise<string> {
  const args = JSON.parse(argumentsDelta) as { file_path?: string; offset?: number; limit?: number }
  const root = process.cwd()
  const path = resolve(root, args.file_path ?? '')
  if (!path.startsWith(root)) return 'denied: outside the workspace root'
  const lines = (await readFile(path, 'utf8')).split('\n')
  const from = Math.max(1, Math.floor(args.offset ?? 1))
  const window = lines.slice(from - 1, from - 1 + Math.min(READ_LIMIT, Math.floor(args.limit ?? READ_LIMIT)))
  const body = window.map((line, index) => `${String(from + index)}: ${line}`).join('\n')
  return `<path>${args.file_path ?? ''}</path>\n<type>file</type>\n<content>\n${body}\n(Showing lines ${String(from)}-${String(from + window.length - 1)} of ${String(lines.length)}. Use offset=${String(from + window.length)} to continue.)\n</content>`
}

let exit = 0
for (const [index, turnText] of turns.entries()) {
  const tag = `turn ${String(index + 1)}`
  const messages: RequestMessage[] = [{ role: 'user', content: [{ type: 'text', text: turnText }] }]
  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const before = records.length
    const chunks: StreamChunk[] = []
    try {
      for await (const chunk of adapter.stream({
        provider: 'web-auto-chathub',
        model: 'web-model',
        sessionId: 'manual-check' as never,
        tools: TOOLS,
        messages,
      })) chunks.push(chunk)
    } catch (error) {
      exit = 1
      console.log(`\n[${tag} step ${String(step)}] FAILED: ${error instanceof Error ? error.message : String(error)}`)
      break
    }
    for (const record of records.slice(before)) {
      console.log(`[${tag} step ${String(step)}] site=${record.site ?? '?'} failure=${record.failure ?? 'none'} `
        + `prompt=${String(record.promptChars)}ch answer=${String(record.answerChars)}ch tool=${record.toolName ?? 'none'} `
        + `attempt=${String(record.attempt)} ${String(record.ms)}ms`)
    }
    const answer = chunks.flatMap(chunk => (chunk.type === 'text-delta' ? [chunk.text] : [])).join('')
    if (answer.length > 0) console.log(`[${tag} step ${String(step)}] text: ${answer.slice(0, 300).replace(/\s+/gu, ' ')}`)
    const call = chunks.flatMap(chunk =>
      (chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block] : []))[0]
    if (call === undefined) break
    if (call.name !== 'read') {
      console.log(`[${tag} step ${String(step)}] ${call.name} call not executed in this check; stopping turn`)
      break
    }
    const result = await readResult(call.arguments)
      .catch((error: unknown) => `error: ${error instanceof Error ? error.message : String(error)}`)
    messages.push(
      createAssistantMessage({
        content: [...answer.length === 0 ? [] : [{ type: 'text' as const, text: answer }], call],
        source: { provider: 'web-auto-chathub', model: 'web-model' },
      }),
      createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: result }], isError: false }),
    )
  }
}

console.log(`\nrecords: ${JSON.stringify(records.map(record => ({ site: record.site, failure: record.failure ?? null, tool: record.toolName ?? null })))}`)
await transport.dispose()
process.exitCode = exit
