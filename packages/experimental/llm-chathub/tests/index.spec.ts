/** Plugin wiring: the mounting row becomes one registered LLM route. */

import { Context } from '@deepseek-ai/cordis'
import type { LlmAdapter, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { apply, resolveConfig, type Config } from '../src/index.ts'
import type { ChatHubTurnObservation } from '../src/types.ts'

const ROW: Config = {
  site: 'deepseek-web',
  model: 'web-model',
  contextWindow: 32_000,
  maxPromptChars: 48_000,
  maxToolResultChars: 6_000,
  maxSystemChars: 4_000,
  historyTurns: 8,
  allowTools: ['read'],
  denyPaths: ['.git'],
  verifyCommands: ['pnpm test'],
  maxToolCallsPerTurn: 1,
  repairAttempts: 1,
}

/**
 * @param stream - chunk stream from one call.
 * @returns Every chunk, in order.
 */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** A mounted plugin, its registered adapter, and what the host was asked for. */
interface Mounted {
  readonly ctx: Context
  readonly adapter: LlmAdapter
  readonly providers: string[]
  readonly emitted: ChatHubTurnObservation[]
  readonly calls: { providers: number; transport: number }
}

/**
 * @param open - what the lent transport answers when the adapter opens a page.
 * @returns The mounted plugin over a fake host layer.
 */
function mount(open: () => Promise<unknown>): Mounted {
  const ctx = new Context()
  const registered: { providers: string[]; adapter: LlmAdapter }[] = []
  const calls = { providers: 0, transport: 0 }
  ctx.provide('llm', {
    registerAdapter: (providers: string[], adapter: LlmAdapter) => {
      registered.push({ providers, adapter })
      const handle = (() => {}) as (() => void) & { replace: () => void }
      handle.replace = () => {}
      return handle
    },
  } as never)
  ctx.provide('webChatTransport', {
    transportForAdapter: () => {
      calls.transport += 1
      return { open }
    },
    providers: () => {
      calls.providers += 1
      return Promise.resolve([{ id: 'deepseek-web', health: { status: 'ready' } }])
    },
  } as never)
  const emitted: ChatHubTurnObservation[] = []
  ctx.on('chathub-llm/turn', (record) => { emitted.push(record) })
  apply(ctx, ROW)
  const first = registered[0]!
  return { ctx, adapter: first.adapter, providers: first.providers, emitted, calls }
}

describe('resolveConfig', () => {
  it('fills the route from the site and the root from the host process', () => {
    const records: ChatHubTurnObservation[] = []
    const resolved = resolveConfig(ROW, record => records.push(record))
    expect(resolved.route).toBe('deepseek-web-chathub')
    expect(resolved.sites).toEqual(['deepseek-web'])
    expect(resolved.routes).toEqual(['deepseek-web-chathub'])
    expect(resolved.workspaceRoot).toBe(process.cwd())
    expect(resolved.site).toBe('deepseek-web')
    expect(resolved.maxToolCallsPerTurn).toBe(1)
    resolved.onTurn?.({ pageKey: 'k', attempt: 1, promptChars: 1, answerChars: 1, ms: 1, droppedEntries: 0 })
    expect(records).toHaveLength(1)
  })

  it('mounts one route per listed site', () => {
    const resolved = resolveConfig(
      { ...ROW, sites: ['deepseek-web', 'qianwen-web'] },
      () => {},
    )
    expect(resolved.sites).toEqual(['deepseek-web', 'qianwen-web'])
    expect(resolved.routes).toEqual(['deepseek-web-chathub', 'qianwen-web-chathub'])
    expect(resolved.route).toBe('deepseek-web-chathub')
  })

  it('keeps an explicit route and root', () => {
    const resolved = resolveConfig({ ...ROW, route: 'web-gpt', workspaceRoot: '/work/repo' }, () => {})
    expect(resolved.route).toBe('web-gpt')
    // An explicit route pins the mount to the default site.
    expect(resolved.sites).toEqual(['deepseek-web'])
    expect(resolved.routes).toEqual(['deepseek-web-chathub'])
    expect(resolved.workspaceRoot).toBe('/work/repo')
  })

  it('refuses auxiliary calls unless the row allows them', () => {
    expect(resolveConfig(ROW, () => {}).auxiliary).toBe('refuse')
    expect(resolveConfig({ ...ROW, auxiliary: 'allow' }, () => {}).auxiliary).toBe('allow')
  })

  it('drops a trailing separator from the stated root', () => {
    const resolved = resolveConfig({ ...ROW, workspaceRoot: '/work/repo/' }, () => {})
    expect(resolved.workspaceRoot).toBe('/work/repo')
  })

  it('rejects a relative root instead of guessing one', () => {
    expect(() => resolveConfig({ ...ROW, workspaceRoot: 'repo' }, () => {}))
      .toThrow(/workspaceRoot "repo" must be an absolute path/u)
  })
})

describe('apply', () => {
  it('registers one route on the site default', () => {
    const mounted = mount(() => Promise.resolve(undefined))
    expect(mounted.providers).toEqual(['deepseek-web-chathub'])
  })

  it('registers one route per listed site', () => {
    const ctx = new Context()
    const registered: string[][] = []
    ctx.provide('llm', {
      registerAdapter: (providers: string[]) => {
        registered.push(providers)
        const handle = (() => {}) as (() => void) & { replace: () => void }
        handle.replace = () => {}
        return handle
      },
    } as never)
    ctx.provide('webChatTransport', {
      transportForAdapter: () => ({ open: () => Promise.resolve(undefined) }),
      providers: () => Promise.resolve([]),
    } as never)
    apply(ctx, { ...ROW, sites: ['deepseek-web', 'qianwen-web'] })
    expect(registered[0]).toEqual(['deepseek-web-chathub', 'qianwen-web-chathub'])
  })

  it('drives the transport the host lent it and reports the turn', async () => {
    const mounted = mount(() => Promise.resolve({
      send: () => Promise.resolve({ content: 'all done' }),
      close: () => Promise.resolve(),
    }))
    const chunks = await collect(mounted.adapter.stream({
      provider: 'deepseek-web-chathub',
      model: 'web-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(mounted.calls).toEqual({ providers: 1, transport: 1 })
    // The mount forwards its one record to the context event.
    expect(mounted.emitted).toHaveLength(1)
    expect(mounted.emitted[0]?.pageKey).toBe('deepseek-web:1')
  })

  it('surfaces a pending sign-in as the auth failure the loop knows', async () => {
    const mounted = mount(() => Promise.resolve(undefined))
    await expect(collect(mounted.adapter.stream({
      provider: 'deepseek-web-chathub',
      model: 'web-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('releases the registration when the context disposes', async () => {
    const ctx = new Context()
    let released = 0
    ctx.provide('llm', {
      registerAdapter: () => {
        const handle = (() => { released += 1 }) as (() => void) & { replace: () => void }
        handle.replace = () => {}
        return handle
      },
    } as never)
    ctx.provide('webChatTransport', {
      transportForAdapter: () => ({ open: () => Promise.resolve(undefined) }),
      providers: () => Promise.resolve([]),
    } as never)
    apply(ctx, ROW)
    await ctx.fiber.dispose()
    expect(released).toBe(1)
  })
})
