/** HTTP integration: the gateway over a fake llm stream and transport health. */

import { Context } from '@deepseek-ai/cordis'
import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { ChatHubGateway } from '../src/server.ts'
import type { ChatHubGatewayConfig } from '../src/types.ts'

/** A mounted gateway and the knobs its fakes expose. */
interface Mounted {
  readonly gateway: ChatHubGateway
  readonly url: string
  readonly ctx: Context
  streams: AsyncIterable<StreamChunk>[]
  health: { id: string; health: { status: string } }[]
  requests: GenerateOptions[]
}

/**
 * @param apiKey - bearer key the row configures; empty disables checking.
 * @param sites - explicit site roster; empty exposes every health-known site.
 * @returns The mounted gateway over fake llm and transport services, bound to
 *   an ephemeral port so parallel specs never collide.
 */
async function mount(apiKey = '', sites: string[] = []): Promise<Mounted> {
  const ctx = new Context()
  const state = {
    streams: [] as AsyncIterable<StreamChunk>[],
    health: [] as { id: string; health: { status: string } }[],
    requests: [] as GenerateOptions[],
  }
  state.health = [
    { id: 'glm-web', health: { status: 'ready' } },
    { id: 'qianwen-web', health: { status: 'needs-auth' } },
  ]
  ctx.provide('llm', {
    stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => {
      state.requests.push(options)
      return state.streams.shift() ?? emptyStream()
    },
  } as never)
  ctx.provide('webChatTransport', {
    providers: () => Promise.resolve(state.health),
  } as never)
  const config: ChatHubGatewayConfig = {
    host: '127.0.0.1',
    port: 0,
    apiKey,
    sites,
    maxQueuePerSite: 1,
    keepaliveMs: 15_000,
  }
  const gateway = new ChatHubGateway(ctx, config)
  const url = await gateway.start()
  return { gateway, url, ctx, streams: state.streams, health: state.health, requests: state.requests }
}

/**
 * @returns One empty stream that ends without a finish chunk.
 */
async function* emptyStream(): AsyncIterable<StreamChunk> {}

/**
 * @param text - the answer text.
 * @returns One completed text turn.
 */
async function* textTurn(text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/**
 * @returns One turn that fails after the response has started streaming.
 */
async function* failingStream(): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  throw new LlmError('site exploded', 'SERVER')
}

describe('ChatHubGateway /v1/models', () => {
  it('lists health-known sites with sign-in state', async () => {
    const mounted = await mount()
    const response = await fetch(`${mounted.url}/v1/models`)
    expect(response.status).toBe(200)
    const body = await response.json() as { data: { id: string; status: string }[] }
    expect(body.data).toEqual([
      { id: 'glm-web', object: 'model', owned_by: 'chathub', status: 'ready' },
      { id: 'qianwen-web', object: 'model', owned_by: 'chathub', status: 'needs-auth' },
    ])
    await mounted.ctx.fiber.dispose()
  })

  it('limits the roster to the configured sites', async () => {
    const mounted = await mount('', ['glm-web'])
    const response = await fetch(`${mounted.url}/v1/models`)
    const body = await response.json() as { data: { id: string }[] }
    expect(body.data.map(row => row.id)).toEqual(['glm-web'])
    await mounted.ctx.fiber.dispose()
  })

  it('drops a configured site the transport does not know', async () => {
    const mounted = await mount('', ['glm-web', 'chatgpt-web'])
    const response = await fetch(`${mounted.url}/v1/models`)
    const body = await response.json() as { data: { id: string }[] }
    // chatgpt-web is not health-known in the fake, so it is absent rather
    // than listed as needs-auth behind a login screen that cannot fix it.
    expect(body.data.map(row => row.id)).toEqual(['glm-web'])
    await mounted.ctx.fiber.dispose()
  })
})

describe('ChatHubGateway /v1/chat/completions', () => {
  it('answers a ready model with the translated turn', async () => {
    const mounted = await mount()
    mounted.streams.push(textTurn('hello'))
    const response = await fetch(`${mounted.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-web', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { choices: { message: { content: string } }[] }
    const choice = body.choices.at(0)
    if (choice === undefined) throw new Error('unreachable')
    expect(choice.message.content).toBe('hello')
    expect(mounted.requests.at(0)?.provider).toBe('glm-web-chathub')
    await mounted.ctx.fiber.dispose()
  })

  it('rejects an unlisted model with 404 and a listing hint', async () => {
    const mounted = await mount()
    const response = await fetch(`${mounted.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(404)
    const body = await response.json() as { error: { code: string } }
    expect(body.error.code).toBe('model_not_found')
    await mounted.ctx.fiber.dispose()
  })

  it('rejects a signed-out model with 401 and the panel hint', async () => {
    const mounted = await mount()
    const response = await fetch(`${mounted.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qianwen-web', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(401)
    const body = await response.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('chathub_signed_out')
    expect(body.error.message).toContain('ChatHub panel')
    await mounted.ctx.fiber.dispose()
  })

  it('enforces the configured key', async () => {
    const mounted = await mount('secret')
    const denied = await fetch(`${mounted.url}/v1/models`)
    expect(denied.status).toBe(401)
    const allowed = await fetch(`${mounted.url}/v1/models`, { headers: { authorization: 'Bearer secret' } })
    expect(allowed.status).toBe(200)
    await mounted.ctx.fiber.dispose()
  })

  it('rejects malformed JSON with 400', async () => {
    const mounted = await mount()
    const response = await fetch(`${mounted.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(response.status).toBe(400)
    await mounted.ctx.fiber.dispose()
  })

  it('answers an unknown route with 404', async () => {
    const mounted = await mount()
    const response = await fetch(`${mounted.url}/v1/embeddings`)
    expect(response.status).toBe(404)
    await mounted.ctx.fiber.dispose()
  })

  it('streams a completion with keepalive headers and a DONE sentinel', async () => {
    const mounted = await mount()
    mounted.streams.push(textTurn('streamed'))
    const response = await fetch(`${mounted.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-web', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const text = await response.text()
    expect(text).toContain('"role":"assistant"')
    expect(text).toContain('"content":"streamed"')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    await mounted.ctx.fiber.dispose()
  })

  it('rides a mid-stream failure on the open event stream and keeps listening', async () => {
    const mounted = await mount()
    mounted.streams.push(failingStream())
    const response = await fetch(`${mounted.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-web', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    // The 200 is already sent, so the failure has to be an error event; a
    // second status line would throw and take the listener down with it.
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('"code":"server_error"')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    const next = await fetch(`${mounted.url}/v1/models`)
    expect(next.status).toBe(200)
    await mounted.ctx.fiber.dispose()
  })
})

describe('plugin wiring', () => {
  it('apply starts a listener on the row port and stops with the context', async () => {
    const ctx = new Context()
    ctx.provide('llm', { stream: () => emptyStream() } as never)
    ctx.provide('webChatTransport', { providers: () => Promise.resolve([]) } as never)
    apply(ctx, {
      host: '127.0.0.1',
      port: 0,
      apiKey: '',
      sites: [],
      maxQueuePerSite: 8,
      keepaliveMs: 15_000,
    })
    // apply starts asynchronously; disposing right after still runs the
    // registered close effect without throwing.
    await new Promise((resolve) => { setImmediate(resolve) })
    await ctx.fiber.dispose()
  })
})
