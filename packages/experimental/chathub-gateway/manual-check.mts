/* Owner-local real-browser check for the gateway. Run from the repo root:
     pnpm exec tsx packages/experimental/chathub-gateway/manual-check.mts \
       "qianwen-web,deepseek-web"
   Sign in to every listed site in the profile once, then run it.

   The check drives the shipped path an external coding agent uses: an HTTP
   client posts OpenAI-wire requests to the gateway, the gateway translates
   them into `ctx.llm` turns, the llm-chathub adapter opens a real Chrome page
   on the signed-in site, and the answer travels back as a completion or an SSE
   stream. The `llm` seam is a direct forward to the adapter — the same call a
   registered route makes — so the browser turn is real while the check stays
   free of the Cordis profile loader.

   Shape matters more than a smoke test: one topic over two turns, a
   project-sized prompt, and a task that only succeeds with a legal `read`
   tool call. Only `read` is executed (against the working tree); any other
   call is reported and the turn stops. Delete the profile directory when
   done. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolvePacing } from '../chathub-host/src/pacing.ts'
import { discoverChromeExecutable } from '../chathub-host/src/executable.ts'
import { PlaywrightBrowserRuntime } from '../chathub-host/src/runtime.ts'
import { PlaywrightWebChatTransport } from '../chathub-host/src/transport.ts'
import { resolveSiteDrivers } from '../chathub-host/src/drivers.ts'
import { ChatHubLlmAdapter } from '../llm-chathub/src/adapter.ts'
import { resolveConfig } from '../llm-chathub/src/index.ts'
import type { ChatHubTurnObservation } from '../llm-chathub/src/types.ts'
import { ChatHubGateway } from './src/server.ts'

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
  selection: 'fixed',
}, record => records.push(record))

const adapter = new ChatHubLlmAdapter({
  transportForAdapter: () => transport,
  providers: () => Promise.resolve(sites.map(id => ({ id, health: { status: 'ready' } }))),
}, resolved)

// The service surface the gateway consumes: `ctx.llm.stream` forwards to the
// adapter exactly as a registered route would, and the transport listing names
// the mounted sites. Health is declared ready so a signed-out site surfaces as
// a per-turn failure code instead of a 401 that never opens a browser.
const ctx = new Context()
ctx.provide('llm', {
  stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => adapter.stream(options),
} as never)
ctx.provide('webChatTransport', {
  providers: () => Promise.resolve(sites.map(id => ({ id, health: { status: 'ready' } }))),
} as never)

const gateway = new ChatHubGateway(ctx, {
  host: '127.0.0.1',
  port: 0,
  apiKey: '',
  sites,
  maxQueuePerSite: 8,
  keepaliveMs: 15_000,
})
const base = await gateway.start()
console.log(`gateway: ${base}`)

/** A file listing long enough to reach a project-sized prompt. */
const CONTEXT = Array.from({ length: 120 }, (_, index) => `packages/experimental/module-${String(index)}/src/handler.ts`).join('\n')

const TOOLS = [{
  type: 'function' as const,
  function: {
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
}]

/** One OpenAI-wire message the external agent accumulates across steps. */
interface WireTurn {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/** Raw OpenAI-wire tool-call element from an SSE delta. */
interface WireToolCall {
  index: number
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** One decoded step: the assistant text, its call, and the finish reason. */
interface Step {
  text: string
  call: { id: string; name: string; arguments: string } | undefined
  finish: string | undefined
}

/**
 * Post one completion and decode the answer, streaming or not.
 * @param model - gateway model id, the site id.
 * @param messages - the conversation so far.
 * @param stream - whether to read the SSE frames instead of the JSON body.
 * @returns The assistant step.
 * @throws Error carrying the HTTP status and the wire error body.
 */
async function post(model: string, messages: WireTurn[], stream: boolean): Promise<Step> {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, tools: TOOLS, stream }),
  })
  if (!response.ok) {
    throw new Error(`${String(response.status)} ${await response.text()}`)
  }
  if (!stream) {
    const body = await response.json() as {
      choices: {
        message: {
          content: string | null
          tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
        }
        finish_reason: string
      }[]
    }
    const choice = body.choices[0]
    const wireCall = choice?.message.tool_calls?.[0]
    const call = wireCall === undefined ? undefined : {
      id: wireCall.id,
      name: wireCall.function.name,
      arguments: wireCall.function.arguments,
    }
    return { text: choice?.message.content ?? '', call, finish: choice?.finish_reason }
  }
  // SSE: the gateway writes keepalive comments while the site turn runs, then
  // role, content, tool_calls, and finish frames plus the [DONE] sentinel.
  let text = ''
  let call: Step['call']
  let finish: string | undefined
  for await (const line of readSseLines(response)) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice('data: '.length)
    if (payload === '[DONE]') break
    const frame = JSON.parse(payload) as {
      error?: { message: string }
      choices?: { delta?: { content?: string; tool_calls?: WireToolCall[] }; finish_reason?: string | null }[]
    }
    if (frame.error !== undefined) throw new Error(`stream error: ${frame.error.message}`)
    const choice = frame.choices?.[0]
    if (choice?.delta?.content !== undefined) text += choice.delta.content
    const wireCall = choice?.delta?.tool_calls?.[0]
    if (wireCall !== undefined && wireCall.function !== undefined) call = {
      id: wireCall.id,
      name: wireCall.function.name,
      arguments: wireCall.function.arguments,
    }
    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) finish = choice.finish_reason
  }
  return { text, call, finish }
}

/**
 * Yield the complete lines of an SSE response body.
 * @param response - the streaming response.
 * @returns Lines without their terminator, in arrival order.
 */
async function* readSseLines(response: Response): AsyncIterable<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      yield buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  }
  if (buffer.length > 0) yield buffer
}

/**
 * Run one `read` call against the working tree.
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
  const window = lines.slice(from - 1, from - 1 + Math.min(2_000, Math.floor(args.limit ?? 2_000)))
  const body = window.map((line, index) => `${String(from + index)}: ${line}`).join('\n')
  return `<path>${args.file_path ?? ''}</path>\n<type>file</type>\n<content>\n${body}\n(Showing lines ${String(from)}-${String(from + window.length - 1)} of ${String(lines.length)}. Use offset=${String(from + window.length)} to continue.)\n</content>`
}

/** The site one step actually ran on, from the adapter's turn records. */
function siteSince(index: number): string {
  const fresh = records.slice(index)
  const last = fresh.at(-1)
  return last?.site ?? '?'
}

const listing = await fetch(`${base}/v1/models`)
const models = await listing.json() as { data: { id: string; status: string }[] }
console.log(`[models] ${listing.status} ${models.data.map(row => `${row.id}:${row.status}`).join(', ')}`)

const model = sites[0] as string
let exit = 0

// Turn 1: non-streaming. The prompt is project-sized and the task only
// completes with a legal `read` call, so a prose refusal shows up as a
// protocol failure rather than a plausible-looking answer.
const messages: WireTurn[] = [{
  role: 'user',
  content: 'Read packages/experimental/chathub-host/src/pacing.ts and report the default preset name it '
  + `resolves. Repository files:\n${CONTEXT}`,
}]

/** Steps one turn may take; each step is one site conversation on the account. */
const MAX_STEPS = 10

let stepCount = 0
for (let step = 1; step <= MAX_STEPS; step += 1) {
  stepCount = step
  const before = records.length
  try {
    const answer = await post(model, messages, false)
    for (const record of records.slice(before)) {
      console.log(`[turn 1 step ${String(step)}] site=${record.site ?? '?'} failure=${record.failure ?? 'none'} `
        + `prompt=${String(record.promptChars)}ch answer=${String(record.answerChars)}ch `
        + `tool=${record.toolName ?? 'none'} ${String(record.ms)}ms`)
    }
    if (answer.text.length > 0) console.log(`[turn 1 step ${String(step)}] text: ${answer.text.slice(0, 300).replace(/\s+/gu, ' ')}`)
    if (answer.call === undefined) break
    if (answer.call.name !== 'read') {
      console.log(`[turn 1 step ${String(step)}] ${answer.call.name} call not executed in this check; stopping turn`)
      break
    }
    const result = await readResult(answer.call.arguments)
      .catch((error: unknown) => `error: ${error instanceof Error ? error.message : String(error)}`)
    messages.push(
      {
        role: 'assistant',
        content: answer.text.length === 0 ? null : answer.text,
        tool_calls: [{
          id: answer.call.id,
          type: 'function',
          function: { name: answer.call.name, arguments: answer.call.arguments },
        }],
      },
      { role: 'tool', content: result, tool_call_id: answer.call.id },
    )
  } catch (error) {
    exit = 1
    console.log(`\n[turn 1 step ${String(step)}] FAILED: ${error instanceof Error ? error.message : String(error)}`)
    break
  }
}
console.log(`[turn 1] ${String(stepCount)} steps, site=${siteSince(0)}`)

// Turn 2: the same topic over SSE, asking for the follow-up a coding agent
// would send. Streaming is the path Codex and Claude Code use, so the SSE
// frames, the keepalive hold, and the [DONE] sentinel are all exercised here.
messages.push({ role: 'user', content: 'Now read packages/experimental/chathub-host/src/executable.ts and name one platform it searches on Linux.' })
for (let step = 1; step <= MAX_STEPS; step += 1) {
  const before = records.length
  try {
    const answer = await post(model, messages, true)
    for (const record of records.slice(before)) {
      console.log(`[turn 2 step ${String(step)}] site=${record.site ?? '?'} failure=${record.failure ?? 'none'} `
        + `prompt=${String(record.promptChars)}ch answer=${String(record.answerChars)}ch `
        + `tool=${record.toolName ?? 'none'} ${String(record.ms)}ms`)
    }
    if (answer.text.length > 0) console.log(`[turn 2 step ${String(step)}] text: ${answer.text.slice(0, 300).replace(/\s+/gu, ' ')}`)
    if (answer.call === undefined) break
    if (answer.call.name !== 'read') {
      console.log(`[turn 2 step ${String(step)}] ${answer.call.name} call not executed in this check; stopping turn`)
      break
    }
    const result = await readResult(answer.call.arguments)
      .catch((error: unknown) => `error: ${error instanceof Error ? error.message : String(error)}`)
    messages.push(
      {
        role: 'assistant',
        content: answer.text.length === 0 ? null : answer.text,
        tool_calls: [{
          id: answer.call.id,
          type: 'function',
          function: { name: answer.call.name, arguments: answer.call.arguments },
        }],
      },
      { role: 'tool', content: result, tool_call_id: answer.call.id },
    )
  } catch (error) {
    exit = 1
    console.log(`\n[turn 2 step ${String(step)}] FAILED: ${error instanceof Error ? error.message : String(error)}`)
    break
  }
}

console.log(`\nrecords: ${JSON.stringify(records.map(record => ({ site: record.site, failure: record.failure ?? null, tool: record.toolName ?? null })))}`)
await ctx.fiber.dispose()
await transport.dispose()
process.exitCode = exit
