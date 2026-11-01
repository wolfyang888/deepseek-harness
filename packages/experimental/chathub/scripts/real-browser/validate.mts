/**
 * Owner-local real-browser validation driver for the shipped ChatHub web adapters.
 *
 * Usage (from the repo root, with tsx):
 *   node_modules/.bin/tsx packages/experimental/chathub/scripts/real-browser/validate.mts <command>
 *
 * Commands:
 *   login <providerId>            Open the site headful; sign in manually; exits when the chat box appears.
 *   health <providerId>           Probe readiness through ProviderRegistry.
 *   send <providerId> [prompt]    One sendMessage turn; prints the normalized response.
 *   stream <providerId> [prompt]  One streamMessage turn; prints deltas as they arrive.
 *   switch <fromId> <toId>        SessionManager switch drill: seed a fact on `from`, switch, recall on `to`.
 *
 * Login state persists in packages/experimental/chathub/.real-browser-profile/.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CheckpointService } from '../../src/checkpoint.ts'
import { ContextCompiler } from '../../src/context-compiler.ts'
import { ChatHubError } from '../../src/errors.ts'
import { ProviderRegistry } from '../../src/provider-registry.ts'
import { webProviderAdapters } from '../../src/providers/adapters.ts'
import { SessionManager } from '../../src/session-manager.ts'
import { SessionTimelineService } from '../../src/timeline.ts'
import { PlaywrightWebChatTransport, SITE_DRIVERS } from './playwright-transport.mts'

const PROFILE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.real-browser-profile',
)
const STATE_FILE = path.join(PROFILE_DIR, 'storage-state.json')
const DEFAULT_PROMPT = 'Reply with exactly: ok'

function providerIds(): string {
  return Object.keys(SITE_DRIVERS).join('|')
}

async function withTransport<T>(run: (transport: PlaywrightWebChatTransport) => Promise<T>): Promise<T> {
  const transport = new PlaywrightWebChatTransport({
    profileDir: PROFILE_DIR,
    storageState: STATE_FILE,
    headless: process.env.CHATHUB_HEADLESS === '1',
    loginWaitMs: Number(process.env.CHATHUB_LOGIN_WAIT_MS ?? 20000),
  })
  try {
    return await run(transport)
  } finally {
    await transport.dispose()
  }
}

function buildRegistry(transport: PlaywrightWebChatTransport, ids: readonly string[]): ProviderRegistry {
  const registry = new ProviderRegistry()
  for (const id of ids) registry.register(webProviderAdapters[id as keyof typeof webProviderAdapters]({ transport }))
  return registry
}

async function login(providerId: string): Promise<void> {
  const transport = new PlaywrightWebChatTransport({ profileDir: PROFILE_DIR, loginWaitMs: 600_000 })
  try {
    console.log(`[login] opening ${SITE_DRIVERS[providerId]?.url ?? providerId}; sign in within 10 minutes`)
    const result = await transport.open(providerId)
    if (result !== undefined && 'closed' in result) {
      console.log(`[login] still signed out: ${result.reason}`)
      process.exitCode = 1
      return
    }
    await transport.saveStorageState(STATE_FILE)
    console.log(`[login] chat box detected; storage state saved to ${STATE_FILE}`)
  } finally {
    await transport.dispose()
  }
}

async function health(providerId: string): Promise<void> {
  await withTransport(async transport => {
    const registry = buildRegistry(transport, [providerId])
    await registry.get(providerId)!.init()
    const snapshot = await registry.health(providerId)
    console.log('[health]', JSON.stringify(snapshot))
  })
}

async function send(providerId: string, prompt: string): Promise<void> {
  await withTransport(async transport => {
    const registry = buildRegistry(transport, [providerId])
    const provider = registry.get(providerId)!
    await provider.init()
    try {
      const response = await provider.sendMessage({
        sessionId: 'real-browser-validation',
        providerId,
        messages: [{ role: 'user', content: prompt }],
      })
      console.log('[send] content:', JSON.stringify(response.content))
      console.log('[send] finishReason:', response.finishReason)
    } catch (error) {
      reportFailure('send', error)
    }
  })
}

async function stream(providerId: string, prompt: string): Promise<void> {
  await withTransport(async transport => {
    const registry = buildRegistry(transport, [providerId])
    const provider = registry.get(providerId)!
    await provider.init()
    let deltas = 0
    try {
      for await (const chunk of provider.streamMessage({
        sessionId: 'real-browser-validation',
        providerId,
        messages: [{ role: 'user', content: prompt }],
      })) {
        if (chunk.delta !== undefined) {
          deltas += 1
          process.stdout.write(chunk.delta)
        }
        if (chunk.finishReason !== undefined) console.log(`\n[stream] finishReason: ${chunk.finishReason}`)
      }
      console.log(`[stream] deltas: ${deltas}`)
    } catch (error) {
      console.log('')
      reportFailure('stream', error)
    }
  })
}

async function switchDrill(fromId: string, toId: string): Promise<void> {
  await withTransport(async transport => {
    const registry = buildRegistry(transport, [fromId, toId])
    const manager = new SessionManager({
      registry,
      compiler: new ContextCompiler(),
      checkpoints: new CheckpointService(),
      timeline: new SessionTimelineService(),
    })
    const magic = `harbor-${Math.floor(Math.random() * 100_000)}`
    const session = manager.create({ title: 'switch drill', goal: 'remember a fact across a model switch', provider: fromId })
    await registry.get(fromId)!.init()
    await registry.get(toId)!.init()

    const seedRequest = manager.buildRequest(session, {
      messages: [{ role: 'user', content: `Remember this magic token and nothing else matters: ${magic}. Reply with: remembered` }],
    })
    const seed = await registry.get(fromId)!.sendMessage(seedRequest)
    console.log(`[switch] ${fromId} seed answer:`, JSON.stringify(seed.content.slice(0, 120)))

    const outcome = await manager.switchProvider(session, toId, 'real-browser switch drill')
    console.log(`[switch] checkpoint ${outcome.checkpoint.id} written; timeline entries: ${session.timeline.length}`)

    const recallRequest = manager.buildRequest(session, {
      messages: [{ role: 'user', content: 'What is the magic token I asked you to remember? Reply with just the token.' }],
    })
    const recall = await registry.get(toId)!.sendMessage(recallRequest)
    console.log(`[switch] ${toId} recall answer:`, JSON.stringify(recall.content.slice(0, 200)))
    console.log(`[switch] context carried: ${recall.content.includes(magic) ? 'YES' : 'NO (token not in answer)'}`)
  })
}

function reportFailure(label: string, error: unknown): void {
  if (error instanceof ChatHubError) {
    console.log(`[${label}] ChatHubError code=${error.code} message=${JSON.stringify(error.message)}`)
    const cause = error.cause instanceof Error ? error.cause.message : String(error.cause ?? '')
    console.log(`[${label}] cause: ${cause.slice(0, 200)}`)
  } else {
    console.log(`[${label}] unexpected error:`, error)
  }
  process.exitCode = 1
}

const [command, ...args] = process.argv.slice(2)
switch (command) {
  case 'login':
    await login(args[0] ?? '')
    break
  case 'health':
    await health(args[0] ?? '')
    break
  case 'send':
    await send(args[0] ?? '', args[1] ?? DEFAULT_PROMPT)
    break
  case 'stream':
    await stream(args[0] ?? '', args[1] ?? DEFAULT_PROMPT)
    break
  case 'switch':
    await switchDrill(args[0] ?? '', args[1] ?? '')
    break
  default:
    console.log(`commands: login|health|send|stream|switch <${providerIds()}> [prompt]`)
    process.exitCode = 1
}
