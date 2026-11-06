/* Owner-local real-browser check for the web-model route. Run from the repo root:
     pnpm exec tsx packages/experimental/llm-chathub/manual-check.mts \
       "qianwen-web,deepseek-web,chatgpt-web"
   Sign in to every listed site in the profile once, then run it. The check is
   deliberately shaped like the way this route is used, not like a smoke test:
   two turns of one topic, a multi-kilobyte prompt, and a tool call per turn.
   A single "reply ok" proves the page loads, not that a coding turn works.
   Delete the profile directory when done. */
import { chromium } from 'playwright-core'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
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
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const drivers = resolveSiteDrivers({})
const runtime = new PlaywrightBrowserRuntime(
  { mode: 'managed', profileDir, executablePath, headless: false },
  { actionTimeoutMs: 15_000, pollMs: 500 },
  chromium,
)
const transport = new PlaywrightWebChatTransport(
  runtime,
  {
    browser: { mode: 'managed', profileDir, executablePath, headless: false },
    loginTimeoutMs: 300_000,
    turnTimeoutMs: 180_000,
    actionTimeoutMs: 15_000,
    pollMs: 500,
    stablePolls: 3,
    maxQueuedTurns: 2,
    typeDelayMs: 0,
    drivers: {},
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
  { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'edit', description: 'Replace one exact string in a file', parameters: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] } },
]

const turns = [
  `Read packages/experimental/chathub-host/src/transport.ts and report the stable failure token used when a site is paced. Then replace the word RUNAWAY with PACED in the constant list. Repository files:\n${CONTEXT}`,
  'Same task for packages/experimental/chathub-host/src/pacing.ts: report its default preset name and the one change you would make to shorten the wait.',
]

let exit = 0
for (const [index, text] of turns.entries()) {
  const before = records.length
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of adapter.stream({
      provider: 'web-auto-chathub',
      model: 'web-model',
      sessionId: 'manual-check' as never,
      tools: TOOLS,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    })) chunks.push(chunk)
  } catch (error) {
    exit = 1
    console.log(`\n[turn ${String(index + 1)}] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const record of records.slice(before)) {
    console.log(`[turn ${String(index + 1)}] site=${record.site ?? '?'} failure=${record.failure ?? 'none'} `
      + `prompt=${String(record.promptChars)}ch answer=${String(record.answerChars)}ch tool=${record.toolName ?? 'none'} `
      + `attempt=${String(record.attempt)} ${String(record.ms)}ms`)
  }
  const text = chunks.flatMap(chunk => (chunk.type === 'text-delta' ? [chunk.text] : [])).join('')
  if (text.length > 0) console.log(`[turn ${String(index + 1)}] answer: ${text.slice(0, 300).replace(/\s+/gu, ' ')}`)
}

console.log(`\nrecords: ${JSON.stringify(records.map(record => ({ site: record.site, failure: record.failure ?? null, tool: record.toolName ?? null })))}`)
await transport.dispose()
process.exitCode = exit
