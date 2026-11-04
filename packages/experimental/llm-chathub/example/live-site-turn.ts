/**
 * Live example: drive one real browser turn through the real adapter.
 *
 * This is the smallest end-to-end demonstration of the web-model route: the
 * harness-side pieces are the shipped ones (render, protocol, page wrapper,
 * chat session, site driver), and only the browser launch is done here, so the
 * file doubles as documentation for how to plug a transport in.
 *
 * What it does:
 *   1. launches a throwaway Chrome profile,
 *   2. opens the site with the shipped `glm-web` driver (url, input, answer,
 *      answerBody) using the shipped page wrapper and chat session,
 *   3. hands that session to `ChatHubLlmAdapter` as the transport,
 *   4. renders a real coding request, sends it, and prints the parsed reply —
 *      text plus the one tool call the protocol allowed.
 *
 * Nothing is executed and no workspace file is touched: the point is the
 * round trip (prompt in, legal `TOOL_CALL` out) against a live site.
 *
 * Run from a source checkout, with a site the machine can reach:
 *   pnpm exec tsx packages/experimental/llm-chathub/example/live-site-turn.ts
 *
 * Environment:
 *   DEMO_SITE       site driver id (default `glm-web`)
 *   DEMO_ROOT       workspace root stated in the prompt (default process.cwd())
 *   DEMO_PROMPT     task text (default: a small edit to the demo Lua plugin)
 *   DEMO_HEADLESS   `false` shows the window (default `true`)
 *   DEMO_PLAYWRIGHT_ROOT  project whose node_modules has `playwright-core`
 *                   (default `DEMO_ROOT`; set it when the checkout has no browser)
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ChatHubLlmAdapter } from '../src/adapter.ts'
import { DEFAULT_CHATHUB_LLM_CONFIG, type ChatHubTransport, type ChatHubTransportSource } from '../src/types.ts'
import { DEFAULT_SITE_DRIVERS } from '../../chathub-host/src/drivers.ts'
import { PlaywrightPage } from '../../chathub-host/src/page.ts'
import { PlaywrightChatSession } from '../../chathub-host/src/session.ts'
import type { BrowserPageLike, SiteDriverConfig, TransportConfig, TurnGate } from '../../chathub-host/src/types.ts'

/** Site the demo drives; `glm-web` accepts a guest session, the others do not. */
const SITE = process.env.DEMO_SITE ?? 'glm-web'
const ROOT = process.env.DEMO_ROOT ?? process.cwd()
const PLAYWRIGHT_ROOT = process.env.DEMO_PLAYWRIGHT_ROOT ?? ROOT
const HEADLESS = process.env.DEMO_HEADLESS !== 'false'
const PROMPT = process.env.DEMO_PROMPT ?? [
  '在 lua/plugin/demoDeviceHealthPlugin.lua 里把 slow_ms 的默认值从 200 改成 150，',
  '并给 execute("report") 的 stats 增加 slow_ratio 字段（慢请求数 / 响应数，保留两位小数）。',
  '先读文件确认当前内容，再改。',
].join('')

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

/** Transport numbers a live demo can afford. */
const TRANSPORT: TransportConfig = {
  loginTimeoutMs: 60_000,
  turnTimeoutMs: 180_000,
  actionTimeoutMs: 30_000,
  pollMs: 500,
  stablePolls: 3,
  maxQueuedTurns: 1,
  typeDelayMs: 0,
}

/**
 * Open one signed-in site page and wrap it as a transport session.
 * @param driver - shipped site facts.
 * @returns A session the adapter can send a prompt through.
 * @throws Error when the site never shows a chat input (signed-out wall, drift).
 */
async function openSession(driver: SiteDriverConfig): Promise<{
  session: PlaywrightChatSession
  close: () => Promise<void>
}> {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-chathub-demo-'))
  const context = await chromiumOf().launchPersistentContext(profile, {
    headless: HEADLESS,
    viewport: null,
    args: ['--no-first-run', '--no-default-browser-check'],
  })
  context.setDefaultTimeout(TRANSPORT.actionTimeoutMs)
  const raw = await context.newPage()
  const page = new PlaywrightPage(raw, SITE, TRANSPORT.actionTimeoutMs)
  await page.goto(driver.url)
  const ready = await page.waitForInput(driver.input, driver.loginWall, TRANSPORT.loginTimeoutMs, TRANSPORT.pollMs)
  if (!ready) {
    await context.close()
    throw new Error(`${SITE}: no chat input appeared; sign in or fix the driver selectors`)
  }
  return {
    session: new PlaywrightChatSession(`${SITE}:demo`, page, driver, TRANSPORT, GATE),
    close: () => context.close(),
  }
}

/** A request shaped like one agent-loop step. */
function request(): GenerateOptions {
  return {
    provider: `${SITE}-chathub`,
    model: DEFAULT_CHATHUB_LLM_CONFIG.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
    tools: [
      {
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { file_path: { type: 'string', description: 'Path to read' } },
          required: ['file_path'],
        },
      },
      {
        name: 'edit',
        description: 'Replace one exact string in a file',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Path to edit' },
            old_string: { type: 'string', description: 'Exact text to replace' },
            new_string: { type: 'string', description: 'Replacement text' },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
      },
    ],
  }
}

const driver = DEFAULT_SITE_DRIVERS[SITE]
if (driver === undefined) throw new Error(`unknown site "${SITE}"`)

const opened = await openSession(driver)
let openedOnce = false
const source: ChatHubTransportSource = {
  transportForAdapter: (): ChatHubTransport => ({
    open: async () => {
      // The demo opens the page once and reuses it: one attempt, one turn.
      if (openedOnce) return opened.session
      openedOnce = true
      return opened.session
    },
  }),
  providers: () => Promise.resolve([{ id: SITE, health: { status: 'ready' } }]),
}

const adapter = new ChatHubLlmAdapter(source, {
  ...DEFAULT_CHATHUB_LLM_CONFIG,
  site: SITE,
  sites: [SITE],
  route: `${SITE}-chathub`,
  routes: [`${SITE}-chathub`],
  workspaceRoot: ROOT,
  allowTools: ['read', 'edit'],
  verifyCommands: [],
  repairAttempts: 0,
  auxiliary: 'refuse',
  onTurn: (record) => {
    console.log(`turn: site=${SITE} attempt=${record.attempt} prompt=${record.promptChars}ch answer=${record.answerChars}ch ${record.ms}ms`)
    if (record.invalid !== undefined) console.log(`invalid: ${record.invalid}`)
    if (record.toolName !== undefined) console.log(`tool: ${record.toolName}`)
  },
})

console.log(`site=${SITE} root=${ROOT} headless=${HEADLESS}`)
try {
  for await (const chunk of adapter.stream(request())) {
    if (chunk.type === 'text-delta') console.log(`text: ${chunk.text.slice(0, 500)}`)
    else if (chunk.type === 'tool-call-delta') console.log(`call: ${chunk.name} ${chunk.argumentsDelta}`)
    else if (chunk.type === 'finish') console.log(`finish: ${JSON.stringify(chunk.reason)}`)
  }
} finally {
  await opened.close()
}
