/** HTTP integration: the gateway over a fake llm stream and transport health. */

import { Context } from '@deepseek-ai/cordis'
import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { ChatHubGateway } from '../src/server.ts'
import type { ChatHubGatewayConfig, Wire } from '../src/types.ts'

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
 * @param wires - wire protocols the row serves.
 * @returns The mounted gateway over fake llm and transport services, bound to
 *   an ephemeral port so parallel specs never collide.
 */
async function mount(
  apiKey = '',
  sites: string[] = [],
  wires: Wire[] = ['openai', 'anthropic'],
): Promise<Mounted> {
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
    wires,
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
 * @returns One turn where the site's real sign-in check reports signed out.
 */
async function* signedOutTurn(): AsyncIterable<StreamChunk> {
  throw new LlmError('site requires sign-in', 'AUTH')
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

  it('does not reject a needs-auth model before the real sign-in check', async () => {
    // Health probing never opens a browser, so `needs-auth` also describes a
    // signed-in site whose session simply has not been opened yet. Only the
    // adapter's transport.open()/waitForInput can tell the two apart.
    const mounted = await mount()
    mounted.streams.push(textTurn('hello'))
    const response = await fetch(`${mounted.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qianwen-web', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { choices: { message: { content: string } }[] }
    expect(body.choices.at(0)?.message.content).toBe('hello')
    expect(mounted.requests.at(0)?.provider).toBe('qianwen-web-chathub')
    await mounted.ctx.fiber.dispose()
  })

  it('maps a genuine adapter sign-in failure to 401 with the panel hint', async () => {
    const mounted = await mount()
    mounted.streams.push(signedOutTurn())
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

  it('forwards content frames while the site turn is still running', async () => {
    const mounted = await mount()
    const turn = { finished: false }
    async function* slowTurn(): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'first ' }
      // The gap the site takes to write the rest of its answer.
      await new Promise((resolve) => { setTimeout(resolve, 120) })
      yield { type: 'text-delta', index: 0, text: 'second' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'first second' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      turn.finished = true
    }
    mounted.streams.push(slowTurn())
    const response = await fetch(`${mounted.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-web', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(200)
    const reader = (response.body ?? new ReadableStream<Uint8Array>()).getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sawFirstWhileRunning = false
    let sawSecond = false
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // Freeze on the read that first carried the delta, so later reads after
      // the turn finished cannot rewrite the liveness observation.
      if (!sawFirstWhileRunning && buffer.includes('"content":"first "')) sawFirstWhileRunning = !turn.finished
      if (buffer.includes('"content":"second"')) sawSecond = true
    }
    // The first delta reached the client before the turn completed, and the
    // rest still followed through to the sentinel.
    expect(sawFirstWhileRunning).toBe(true)
    expect(sawSecond).toBe(true)
    expect(buffer.trimEnd().endsWith('data: [DONE]')).toBe(true)
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

describe('ChatHubGateway bare-path aliases', () => {
  it('serves /models like /v1/models', async () => {
    const mounted = await mount()
    const bare = await fetch(`${mounted.url}/models`)
    expect(bare.status).toBe(200)
    expect((await bare.json() as { data: { id: string }[] }).data.map(row => row.id)).toEqual(['glm-web', 'qianwen-web'])
    await mounted.ctx.fiber.dispose()
  })

  it('serves /chat/completions like /v1/chat/completions', async () => {
    const mounted = await mount()
    mounted.streams.push(textTurn('hello'))
    const response = await fetch(`${mounted.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-web', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { choices: { message: { content: string } }[] }
    expect(body.choices[0]?.message.content).toBe('hello')
    expect(mounted.requests).toHaveLength(1)
    await mounted.ctx.fiber.dispose()
  })

  it('still rejects an unknown route', async () => {
    const mounted = await mount()
    const response = await fetch(`${mounted.url}/v2/chat/completions`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(404)
    expect((await response.json() as { error: { message: string } }).error.message).toBe('No route: POST /v2/chat/completions')
    await mounted.ctx.fiber.dispose()
  })
})

describe('ChatHubGateway /v1/messages', () => {
  it('answers a non-streaming message in the Anthropic message shape', async () => {
    const mounted = await mount()
    mounted.streams.push(textTurn('hello'))
    const response = await fetch(`${mounted.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-web', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { type: string; content: { type: string; text?: string }[]; stop_reason: string }
    expect(body.type).toBe('message')
    expect(body.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(body.stop_reason).toBe('end_turn')
    expect(mounted.requests.at(0)?.provider).toBe('glm-web-chathub')
    await mounted.ctx.fiber.dispose()
  })

  it('streams Anthropic events from message_start to message_stop', async () => {
    const mounted = await mount()
    mounted.streams.push(textTurn('streamed'))
    const response = await fetch(`${mounted.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-web', max_tokens: 1024, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const text = await response.text()
    expect(text).toContain('event: message_start')
    expect(text).toContain('"type":"text_delta","text":"streamed"')
    expect(text).toContain('"stop_reason":"end_turn"')
    expect(text).toContain('event: message_stop')
    await mounted.ctx.fiber.dispose()
  })

  it('accepts the Anthropic x-api-key header', async () => {
    const mounted = await mount('secret')
    const denied = await fetch(`${mounted.url}/v1/messages`, { method: 'POST', body: '{}' })
    expect(denied.status).toBe(401)
    const denial = await denied.json() as { type: string; error: { type: string } }
    expect(denial.type).toBe('error')
    expect(denial.error.type).toBe('authentication_error')
    const allowed = await fetch(`${mounted.url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-web', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    })
    // The key check passes; the fake has no queued stream, so an empty turn
    // still answers a well-formed message object.
    expect(allowed.status).toBe(200)
    await mounted.ctx.fiber.dispose()
  })

  it('answers an authentication_error envelope for a signed-out site', async () => {
    const mounted = await mount()
    mounted.streams.push(signedOutTurn())
    const response = await fetch(`${mounted.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-web', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(401)
    const body = await response.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe('authentication_error')
    expect(body.error.message).toContain('ChatHub panel')
    await mounted.ctx.fiber.dispose()
  })

  it('serves /messages and answers 404 when the wire is disabled', async () => {
    const enabled = await mount()
    enabled.streams.push(textTurn('bare'))
    const bare = await fetch(`${enabled.url}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-web', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(bare.status).toBe(200)
    await enabled.ctx.fiber.dispose()

    const disabled = await mount('', [], ['openai'])
    const refused = await fetch(`${disabled.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-web', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(refused.status).toBe(404)
    await disabled.ctx.fiber.dispose()
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
      wires: ['openai', 'anthropic'],
      maxQueuePerSite: 8,
      keepaliveMs: 15_000,
    })
    // apply starts asynchronously; disposing right after still runs the
    // registered close effect without throwing.
    await new Promise((resolve) => { setImmediate(resolve) })
    await ctx.fiber.dispose()
  })
})
