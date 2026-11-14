/** Anthropic wire translation: request folding, response unfolding, events. */

import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import {
  anthropicErrorBody,
  anthropicWireCodec,
  toGenerateOptionsFromAnthropic,
  toMessagesResponse,
  type AnthropicRequest,
} from '../src/anthropic-wire.ts'

const REQUEST: AnthropicRequest = {
  model: 'glm-web',
  max_tokens: 2048,
  system: [{ type: 'text', text: 'be terse' }],
  messages: [
    { role: 'user', content: 'read the config' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'looking' },
        { type: 'tool_use', id: 'tu-1', name: 'read', input: { file_path: 'a.ts' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu-1', content: [{ type: 'text', text: 'file body' }] },
        { type: 'text', text: 'continue' },
      ],
    },
  ],
  tools: [{ name: 'read', description: 'Read a file', input_schema: { type: 'object' } }],
}

describe('toGenerateOptionsFromAnthropic', () => {
  it('folds system, user, assistant tool use, and tool results in order', () => {
    const options = toGenerateOptionsFromAnthropic(REQUEST, 'glm-web-chathub')
    expect(options.provider).toBe('glm-web-chathub')
    expect(options.model).toBe('glm-web')
    expect(options.system).toBe('be terse')
    expect(options.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    const assistant = options.messages.at(2)
    if (assistant === undefined || assistant.role !== 'assistant') throw new Error('unreachable')
    expect(assistant.content).toEqual([
      { type: 'text', text: 'looking' },
      { type: 'tool-call', id: ToolCallId('tu-1'), name: 'read', arguments: '{"file_path":"a.ts"}' },
    ])
    const tool = options.messages.at(3)
    if (tool === undefined || tool.role !== 'tool') throw new Error('unreachable')
    expect(tool.toolCallId).toBe('tu-1')
    expect(tool.content[0]).toEqual({ type: 'text', text: 'file body' })
  })

  it('translates tool declarations into schemas', () => {
    const options = toGenerateOptionsFromAnthropic(REQUEST, 'glm-web-chathub')
    expect(options.tools).toEqual([{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }])
  })

  it('rejects a tool result without a tool_use_id', () => {
    const broken: AnthropicRequest = {
      model: 'glm-web',
      messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'orphan' }] }],
    }
    expect(() => toGenerateOptionsFromAnthropic(broken, 'glm-web-chathub')).toThrow(/tool_use_id/u)
  })

  it('skips a user message that carries neither text nor results', () => {
    const request: AnthropicRequest = { model: 'glm-web', messages: [{ role: 'user', content: [] }] }
    expect(toGenerateOptionsFromAnthropic(request, 'glm-web-chathub').messages).toEqual([])
  })

  it('appends a continuation turn when the newest message is a tool result', () => {
    const request: AnthropicRequest = {
      model: 'glm-web',
      messages: [
        { role: 'user', content: 'list the directories' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu-2', name: 'Bash', input: { command: 'ls -d */' } }],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'apps/ docs/' }] },
      ],
    }
    const messages = toGenerateOptionsFromAnthropic(request, 'glm-web-chathub').messages
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    const continuation = messages.at(-1)
    if (continuation === undefined || continuation.role !== 'user') throw new Error('unreachable')
    expect(continuation.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('newest state') })
  })
})

/** Chunks of one text-only turn. */
function textChunks(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hello ' },
    { type: 'text-delta', index: 0, text: 'world' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hello world' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Chunks of one tool-calling turn. */
function callChunks(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'let me look.' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'let me look.' } },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('call-9'), name: 'read', arguments: '{"file_path":"a.ts"}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

describe('toMessagesResponse', () => {
  it('unfolds a text turn into an end_turn message', () => {
    const response = toMessagesResponse('glm-web', textChunks())
    expect(response.type).toBe('message')
    expect(response.role).toBe('assistant')
    expect(response.content).toEqual([{ type: 'text', text: 'hello world' }])
    expect(response.stop_reason).toBe('end_turn')
    expect(response.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
  })

  it('unfolds a tool turn into one tool_use block', () => {
    const response = toMessagesResponse('glm-web', callChunks())
    expect(response.content).toEqual([
      { type: 'text', text: 'let me look.' },
      { type: 'tool_use', id: 'call-9', name: 'read', input: { file_path: 'a.ts' } },
    ])
    expect(response.stop_reason).toBe('tool_use')
  })
})

/**
 * @param codec - the open stream's codec.
 * @param chunks - the turn's chunks.
 * @returns Every frame of the stream, concatenated.
 */
function render(codec: ReturnType<typeof anthropicWireCodec>, chunks: readonly StreamChunk[]): string {
  return [
    ...codec.openStream(),
    ...chunks.flatMap(chunk => codec.renderChunk(chunk)),
    ...codec.closeStream(),
  ].join('')
}

describe('anthropicWireCodec', () => {
  it('wraps text deltas between one block start and stop', () => {
    const stream = render(anthropicWireCodec('glm-web'), textChunks())
    expect(stream).toContain('event: message_start')
    const start = stream.indexOf('"type":"content_block_start"')
    const delta = stream.indexOf('"type":"text_delta","text":"hello "')
    const stop = stream.indexOf('"type":"content_block_stop"')
    expect(start).toBeGreaterThan(-1)
    expect(start).toBeLessThan(delta)
    expect(delta).toBeLessThan(stop)
    expect(stream).toContain('"stop_reason":"end_turn"')
    expect(stream).toContain('"output_tokens":5')
    expect(stream).toContain('event: message_stop')
  })

  it('renders the single call as a tool_use block and reports tool_use', () => {
    const stream = render(anthropicWireCodec('glm-web'), callChunks())
    expect(stream).toContain('"content_block":{"type":"tool_use","id":"call-9","name":"read","input":{}}')
    expect(stream).toContain('"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"a.ts\\"}"')
    expect(stream).toContain('"stop_reason":"tool_use"')
  })

  it('keeps the stream alive with ping events', () => {
    expect(anthropicWireCodec('glm-web').keepalive).toBe('event: ping\ndata: {"type":"ping"}\n\n')
  })

  it('surfaces a failure as an error event', () => {
    const frames = anthropicWireCodec('glm-web').streamFailure({ status: 401, code: 'chathub_signed_out', message: 'sign in' })
    expect(frames).toHaveLength(1)
    expect(frames[0]).toContain('event: error')
    expect(frames[0]).toContain('"type":"authentication_error"')
  })
})

describe('anthropicErrorBody', () => {
  it('maps status families onto Anthropic error types', () => {
    expect(anthropicErrorBody({ status: 401, code: 'x', message: 'm' }).error.type).toBe('authentication_error')
    expect(anthropicErrorBody({ status: 429, code: 'x', message: 'm' }).error.type).toBe('rate_limit_error')
    expect(anthropicErrorBody({ status: 400, code: 'x', message: 'm' }).error.type).toBe('invalid_request_error')
    expect(anthropicErrorBody({ status: 503, code: 'x', message: 'm' }).error.type).toBe('api_error')
  })
})
