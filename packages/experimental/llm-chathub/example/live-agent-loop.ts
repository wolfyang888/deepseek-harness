/**
 * Live end-to-end demo: a real agent loop whose model is a chat web site.
 *
 * `live-site-turn.ts` proves one round trip — prompt in, legal `TOOL_CALL`
 * out — and executes nothing. This script closes the loop: it keeps the
 * harness side shipped (render, protocol, page wrapper, chat session, site
 * driver, adapter), executes the calls the site asks for against a real
 * workspace, feeds the results back, and stops when the site answers without
 * a call. The file's last step runs the project's own test command, so
 * "the model said done" is never the evidence.
 *
 * What it does:
 *   1. launches a throwaway Chrome profile and opens the site once,
 *   2. runs up to `DEMO_ROUNDS` steps of the loop, each a fresh site
 *      conversation carrying the whole history in its prompt,
 *   3. executes `read` / `edit` / `write` under `DEMO_ROOT`, refusing any path
 *      that escapes it,
 *   4. prints the diff and runs `DEMO_VERIFY`, so the outcome is measured.
 *
 * Run from a source checkout, against a site the machine can reach:
 *   DEMO_ROOT=D:/work/code/gitee/lua_device \
 *   pnpm exec tsx packages/experimental/llm-chathub/example/live-agent-loop.ts
 *
 * Environment:
 *   DEMO_SITE             site driver id (default `glm-web`)
 *   DEMO_ROOT             workspace the tools may touch (default cwd)
 *   DEMO_TASK             task text (default: a one-line change in the demo plugin)
 *   DEMO_VERIFY           completion command, run after the loop (default: the
 *                         demo plugin's own test under fengari)
 *   DEMO_ROUNDS           loop steps allowed (default `6`)
 *   DEMO_HEADLESS         `false` shows the window (default `true`)
 *   DEMO_PLAYWRIGHT_ROOT  project whose node_modules has `playwright-core`
 *                         (default `DEMO_ROOT`; set it when the checkout has no browser)
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { GenerateOptions, RequestMessage, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { ChatHubLlmAdapter } from '../src/adapter.ts'
import { DEFAULT_CHATHUB_LLM_CONFIG, type ChatHubTransport, type ChatHubTransportSource } from '../src/types.ts'
import { DEFAULT_SITE_DRIVERS } from '../../chathub-host/src/drivers.ts'
import { PlaywrightPage } from '../../chathub-host/src/page.ts'
import { PlaywrightChatSession } from '../../chathub-host/src/session.ts'
import type { BrowserPageLike, SiteDriverConfig, TransportConfig, TurnGate } from '../../chathub-host/src/types.ts'

/** Site the demo drives; `glm-web` accepts a guest session, the others do not. */
const SITE = process.env.DEMO_SITE ?? 'glm-web'
/** Workspace the tools operate on; every path is resolved under it. */
const ROOT = resolve(process.env.DEMO_ROOT ?? process.cwd())
const PLAYWRIGHT_ROOT = process.env.DEMO_PLAYWRIGHT_ROOT ?? ROOT
const HEADLESS = process.env.DEMO_HEADLESS !== 'false'
const ROUNDS = Number(process.env.DEMO_ROUNDS ?? '6')

/** A change small enough to state exactly, on a line that also appears elsewhere. */
const TASK = process.env.DEMO_TASK ?? [
  '把 lua/plugin/demoDeviceHealthPlugin.lua 里 config 默认值 slow_ms 从 200 改成 150。',
  '注意文件里有两个 200：第 19 行是 load_plugin 的调用参数，第 45 行才是 config 默认值。',
  '只改第 45 行那一处。先 read 看一遍，再用 edit 改。',
].join('')

/**
 * The project's own test; a pass is the only accepted proof of "done".
 *
 * The default assumes a `lua` on PATH, which is what this project's own
 * Makefile uses. A machine without one points this at its runtime, e.g.
 * `DEMO_VERIFY="node C:/tools/fengari/node_modules/.bin/fengari tests/lua/test_demo_device_health_plugin.lua"`.
 */
const VERIFY = process.env.DEMO_VERIFY ?? 'lua tests/lua/test_demo_device_health_plugin.lua'

/** The slice of a persistent browser context this demo uses. */
interface PersistentContextLike {
  newPage(): Promise<BrowserPageLike>
  close(): Promise<void>
  setDefaultTimeout(ms: number): void
}

/** The slice of Playwright's Chromium entry point this demo uses. */
interface ChromiumLike {
  launchPersistentContext(dir: string, options: Record<string, unknown>): Promise<PersistentContextLike>
}

/** One step of the loop, assembled from the stream. */
interface Turn {
  readonly text: string
  readonly call?: { readonly id: string; readonly name: string; readonly arguments: string }
}

/** What one tool execution returns to the model. */
interface Outcome {
  readonly text: string
  readonly isError?: true
}

/**
 * Load Playwright from wherever the workspace installed it.
 *
 * `playwright-core` is a host dependency, not one of this package's; a demo
 * script must not change the package contract to import it.
 * @returns The Chromium launcher.
 */
function chromiumOf(): ChromiumLike {
  const require = createRequire(join(PLAYWRIGHT_ROOT, 'package.json'))
  return (require('playwright-core') as { chromium: ChromiumLike }).chromium
}

/** One lease per key: the demo runs a single turn at a time. */
const GATE: TurnGate = {
  acquireTurn: () => Promise.resolve(() => {}),
  release: () => Promise.resolve(),
}

/** Turn numbers a live demo can afford. */
const TRANSPORT: TransportConfig = {
  loginTimeoutMs: 60_000,
  // Shorter than the panel's: a demo has a human watching, and a turn that
  // never starts its answer should fail visibly instead of hanging.
  turnTimeoutMs: 90_000,
  actionTimeoutMs: 30_000,
  pollMs: 500,
  stablePolls: 3,
  maxQueuedTurns: 1,
  typeDelayMs: 0,
}

/** The tools the site may ask for, declared exactly as the harness would. */
const TOOLS: readonly ToolSchema[] = [
  {
    name: 'read',
    description: 'Read a UTF-8 file and return its text unchanged',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string', description: 'Path relative to the project root' } },
      required: ['file_path'],
    },
  },
  {
    name: 'edit',
    description: 'Replace one exact string in a file; old_string must occur exactly once',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path relative to the project root' },
        old_string: { type: 'string', description: 'Exact text to replace, copied byte for byte' },
        new_string: { type: 'string', description: 'Replacement text' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'write',
    description: 'Create or overwrite a file with the given text',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path relative to the project root' },
        content: { type: 'string', description: 'Complete new contents' },
      },
      required: ['file_path', 'content'],
    },
  },
]

/**
 * Resolve a model-supplied path inside the workspace.
 * @param path - path the site asked for.
 * @returns Its absolute form.
 * @throws Error when the path is absolute elsewhere or climbs out of the root.
 */
function within(path: string): string {
  const full = isAbsolute(path) ? path : resolve(ROOT, path)
  const rel = relative(ROOT, full)
  if (rel.length === 0) return full
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path "${path}" is outside the workspace root`)
  }
  return full
}

/**
 * Execute one tool call the way the harness would.
 * @param name - tool the site asked for.
 * @param raw - its arguments as JSON text.
 * @returns The text handed back to the model.
 */
function runTool(name: string, raw: string): Outcome {
  if (name !== 'read' && name !== 'edit' && name !== 'write') {
    return { text: `unknown tool "${name}"`, isError: true }
  }
  let args: Record<string, unknown>
  try {
    args = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { text: `arguments are not JSON: ${raw.slice(0, 200)}`, isError: true }
  }
  const path = typeof args['file_path'] === 'string' ? args['file_path'] : ''
  if (path.length === 0) return { text: 'file_path is required', isError: true }
  let full: string
  try {
    full = within(path)
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true }
  }
  try {
    if (name === 'read') {
      const text = readFileSync(full, 'utf8')
      // The adapter bounds tool results anyway; this keeps one reply readable.
      return { text: text.length > 12_000 ? `${text.slice(0, 12_000)}\n[truncated]` : text }
    }
    if (name === 'write') {
      const content = typeof args['content'] === 'string' ? args['content'] : undefined
      if (content === undefined) return { text: 'content is required', isError: true }
      writeFileSync(full, content, 'utf8')
      return { text: `wrote ${path} (${String(content.length)} chars)` }
    }
    const before = readFileSync(full, 'utf8')
    const oldString = typeof args['old_string'] === 'string' ? args['old_string'] : undefined
    const newString = typeof args['new_string'] === 'string' ? args['new_string'] : undefined
    if (oldString === undefined || newString === undefined) {
      return { text: 'old_string and new_string are required', isError: true }
    }
    const at = before.indexOf(oldString)
    if (at < 0) return { text: `old_string does not occur in ${path}`, isError: true }
    if (before.indexOf(oldString, at + 1) >= 0) {
      return { text: `old_string occurs more than once in ${path}; include more context`, isError: true }
    }
    writeFileSync(full, `${before.slice(0, at)}${newString}${before.slice(at + oldString.length)}`, 'utf8')
    return { text: `edited ${path}` }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true }
  }
}

/**
 * Drain one stream into the step it describes.
 * @param chunks - adapter output for one loop step.
 * @returns The reply text and the single allowed call.
 */
async function collect(chunks: AsyncIterable<StreamChunk>): Promise<Turn> {
  let text = ''
  let call: Turn['call']
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'tool-call-delta') {
      call = { id: String(chunk.id), name: chunk.name ?? '', arguments: chunk.argumentsDelta }
    }
  }
  return { text: text.trim(), ...call === undefined ? {} : { call } }
}

/**
 * Open one signed-in page per step and close the previous one.
 *
 * The adapter asks for a new conversation each step, so the page is new too:
 * re-navigating a page that already holds a transcript made the site show its
 * landing recommendations where the answer belongs.
 * @param driver - shipped site facts.
 * @returns An opener the transport calls per step, the live URL, and the context to close.
 */
async function openBrowser(driver: SiteDriverConfig): Promise<{
  openStep: () => Promise<PlaywrightChatSession>
  url: () => string
  bodyText: () => Promise<string>
  close: () => Promise<void>
}> {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-chathub-loop-'))
  const context = await chromiumOf().launchPersistentContext(profile, {
    headless: HEADLESS,
    viewport: null,
    args: ['--no-first-run', '--no-default-browser-check'],
  })
  context.setDefaultTimeout(TRANSPORT.actionTimeoutMs)
  let current: BrowserPageLike | undefined
  return {
    openStep: async () => {
      if (current !== undefined) {
        try {
          await current.close()
        } catch {
          // A page the site already dropped needs no closing.
        }
      }
      const raw = await context.newPage()
      current = raw
      const page = new PlaywrightPage(raw, SITE, TRANSPORT.actionTimeoutMs)
      await page.goto(driver.url)
      const ready = await page.waitForInput(driver.input, driver.loginWall, TRANSPORT.loginTimeoutMs, TRANSPORT.pollMs)
      if (!ready) throw new Error(`${SITE}: no chat input appeared; sign in or fix the driver selectors`)
      return new PlaywrightChatSession(`${SITE}:loop`, page, driver, TRANSPORT, GATE)
    },
    url: () => {
      try {
        return current?.url() ?? ''
      } catch {
        return ''
      }
    },
    bodyText: async () => {
      // A failed turn is diagnosed from what the site actually showed: a rate
      // limit, a sign-in wall, and an empty conversation look the same from
      // the answer container, which is always empty in all three.
      try {
        const html = await current?.locator('body').innerHTML({ timeout: 5_000 }) ?? ''
        return html.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 800)
      } catch {
        return ''
      }
    },
    close: () => context.close(),
  }
}

/** A request shaped like one loop step. */
function request(messages: readonly RequestMessage[]): GenerateOptions {
  return {
    provider: `${SITE}-chathub`,
    model: DEFAULT_CHATHUB_LLM_CONFIG.model,
    messages,
    tools: [...TOOLS],
  }
}

const driver = DEFAULT_SITE_DRIVERS[SITE]
if (driver === undefined) throw new Error(`unknown site "${SITE}"`)

const browser = await openBrowser(driver)
const source: ChatHubTransportSource = {
  transportForAdapter: (): ChatHubTransport => ({ open: () => browser.openStep() }),
  providers: () => Promise.resolve([{ id: SITE, health: { status: 'ready' } }]),
}

const adapter = new ChatHubLlmAdapter(source, {
  ...DEFAULT_CHATHUB_LLM_CONFIG,
  site: SITE,
  sites: [SITE],
  route: `${SITE}-chathub`,
  routes: [`${SITE}-chathub`],
  workspaceRoot: ROOT,
  allowTools: ['read', 'edit', 'write'],
  verifyCommands: [VERIFY],
  auxiliary: 'refuse',
  onTurn: (record) => {
    console.log(`  turn: prompt=${String(record.promptChars)}ch answer=${String(record.answerChars)}ch ${String(record.ms)}ms`)
    if (record.invalid !== undefined) console.log(`  invalid: ${record.invalid}`)
    if (record.warnings !== undefined) console.log(`  warnings: ${record.warnings.join('; ')}`)
  },
})

const messages: RequestMessage[] = [
  { role: 'user', content: [{ type: 'text', text: TASK }] },
]

console.log(`site=${SITE} root=${ROOT} headless=${HEADLESS} rounds=${String(ROUNDS)}`)
let finished = false
try {
  for (let round = 1; round <= ROUNDS; round += 1) {
    console.log(`\n[round ${String(round)}]`)
    const step = await collect(adapter.stream(request(messages)))
    if (step.text.length > 0) console.log(`  say: ${step.text.replace(/\s+/gu, ' ').slice(0, 300)}`)
    if (step.call === undefined) {
      finished = true
      console.log(`  url: ${browser.url()}`)
      break
    }
    const outcome = runTool(step.call.name, step.call.arguments)
    console.log(`  call: ${step.call.name} ${step.call.arguments.slice(0, 300)}`)
    console.log(`  result: ${outcome.isError === true ? '[error] ' : ''}${outcome.text.slice(0, 300).replace(/\s+/gu, ' ')}`)
    // The assistant turn is what the site asked for; the tool turn answers it.
    messages.push({
      role: 'assistant',
      id: `demo-assistant-${String(round)}`,
      content: [{ type: 'tool-call', id: step.call.id, name: step.call.name, arguments: step.call.arguments }],
      source: { kind: 'model', provider: `${SITE}-chathub`, model: DEFAULT_CHATHUB_LLM_CONFIG.model },
    } as unknown as RequestMessage)
    messages.push({
      role: 'tool',
      id: `demo-tool-${String(round)}`,
      toolCallId: step.call.id,
      content: [{ type: 'text', text: outcome.text }],
      ...outcome.isError === true ? { isError: true } : {},
      source: { kind: 'tool' },
    } as unknown as RequestMessage)
  }
} catch (error) {
  console.log(`\n  failed at: ${browser.url()}`)
  console.log(`  page: ${await browser.bodyText()}`)
  throw error
} finally {
  await browser.close()
}

console.log(`\nloop finished=${String(finished)} steps=${String(messages.length)}`)

const diff = spawnSync('git', ['--no-pager', 'diff', '--stat', '--', '.'], { cwd: ROOT, encoding: 'utf8' })
console.log(`\n--- git diff --stat ---\n${diff.stdout.trim() || '(no change)'}`)

const verify = spawnSync(VERIFY, { cwd: ROOT, encoding: 'utf8', shell: true })
console.log(`\n--- verify: ${VERIFY} ---`)
console.log(`${verify.stdout.trim()}\n${verify.stderr.trim()}`.trim().slice(-1_500))
console.log(`verify exit: ${String(verify.status)}`)
