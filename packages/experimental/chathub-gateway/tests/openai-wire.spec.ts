/** OpenAI wire translation: request folding and response unfolding. */

import { describe, expect, it } from 'vitest'
import {
  sseRenderer,
  toCompletionResponse,
  toGenerateOptions,
  type WireCompletionRequest,
} from '../src/openai-wire.ts'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** One text-choice row as the completion response shapes it. */
interface TextChoice {
  message: { content: string }
  finish_reason: string
}

/** One tool-call choice row as the completion response shapes it. */
interface CallChoice {
  message: { tool_calls: { id: string; function: { name: string; arguments: string } }[] }
  finish_reason: string
}

const REQUEST: WireCompletionRequest = {
  model: 'glm-web',
  messages: [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'read the config' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"file_path":"a.ts"}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'file body' },
  ],
  tools: [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object' } } }],
}

describe('toGenerateOptions', () => {
  it('folds system, user, assistant tool calls, and tool results in order', () => {
    const options = toGenerateOptions(REQUEST, 'glm-web-chathub')
    expect(options.provider).toBe('glm-web-chathub')
    expect(options.model).toBe('glm-web')
    expect(options.system).toBe('be terse')
    expect(options.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    const assistant = options.messages.at(2)
    if (assistant === undefined || assistant.role !== 'assistant') throw new Error('unreachable')
    expect(assistant.content).toEqual([
      { type: 'tool-call', id: ToolCallId('call-1'), name: 'read', arguments: '{"file_path":"a.ts"}' },
    ])
    const tool = options.messages.at(3)
    if (tool === undefined || tool.role !== 'tool') throw new Error('unreachable')
    expect(tool.toolCallId).toBe('call-1')
    expect(tool.content[0]).toEqual({ type: 'text', text: 'file body' })
    const continuation = options.messages.at(-1)
    if (continuation === undefined || continuation.role !== 'user') throw new Error('unreachable')
    expect(continuation.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('newest state') })
  })

  it('translates tool declarations into schemas', () => {
    const options = toGenerateOptions(REQUEST, 'glm-web-chathub')
    expect(options.tools).toEqual([{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }])
  })

  it('rejects a tool message without a call id', () => {
    const broken: WireCompletionRequest = {
      model: 'glm-web',
      messages: [{ role: 'tool', content: 'orphan result' }],
    }
    expect(() => toGenerateOptions(broken, 'glm-web-chathub')).toThrow(/tool_call_id/u)
  })

  it('joins mixed assistant content parts as text', () => {
    const request: WireCompletionRequest = {
      model: 'glm-web',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] },
      ],
    }
    const options = toGenerateOptions(request, 'glm-web-chathub')
    const assistant = options.messages.at(1)
    if (assistant === undefined || assistant.role !== 'assistant') throw new Error('unreachable')
    expect(assistant.content).toEqual([{ type: 'text', text: 'thinking' }])
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
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('call-9'), name: 'read', arguments: '{"file_path":"a.ts"}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

describe('toCompletionResponse', () => {
  it('unfolds a text turn into a stop completion', () => {
    const response = toCompletionResponse('glm-web-chathub', 'glm-web', textChunks())
    const choice = (response.choices as TextChoice[]).at(0)
    if (choice === undefined) throw new Error('unreachable')
    expect(choice.message.content).toBe('hello world')
    expect(choice.finish_reason).toBe('stop')
    expect(response.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
    expect(response.parallel_tool_calls).toBe(false)
  })

  it('exposes a reasoning trace as reasoning_content instead of the answer', () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 2, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 2, text: 'step one. ' },
      { type: 'reasoning-delta', index: 2, text: 'step two.' },
      { type: 'block-end', index: 2, block: { type: 'reasoning', text: 'step one. step two.' } },
      ...textChunks(),
    ]
    const response = toCompletionResponse('glm-web-chathub', 'glm-web', chunks)
    const choice = (response.choices as (TextChoice & { message: { reasoning_content?: string } })[]).at(0)
    if (choice === undefined) throw new Error('unreachable')
    expect(choice.message.content).toBe('hello world')
    expect(choice.message.reasoning_content).toBe('step one. step two.')
  })

  it('unfolds a tool turn into tool_calls with the adapter call id', () => {
    const response = toCompletionResponse('glm-web-chathub', 'glm-web', callChunks())
    const choice = (response.choices as CallChoice[]).at(0)
    if (choice === undefined) throw new Error('unreachable')
    expect(choice.message.tool_calls).toEqual([{
      id: 'call-9',
      type: 'function',
      function: { name: 'read', arguments: '{"file_path":"a.ts"}' },
    }])
    expect(choice.finish_reason).toBe('tool_calls')
  })
})

describe('sseRenderer', () => {
  it('renders role, content, finish, and the DONE sentinel as separate frames', () => {
    const sse = sseRenderer('glm-web')
    const role = sse.role()
    expect(role).toMatch(/^data: \{"id":"chathub-/u)
    expect(role).toContain('"delta":{"role":"assistant"}')
    expect(sse.content('hello world')).toContain('"content":"hello world"')
    expect(sse.finish('stop')).toContain('"finish_reason":"stop"')
    expect(sse.done()).toBe('data: [DONE]\n')
  })

  it('renders a reasoning delta under both reasoning field names', () => {
    const frame = sseRenderer('glm-web').reasoning('thinking about it')
    expect(frame).toContain('"reasoning_content":"thinking about it"')
    expect(frame).toContain('"reasoning":"thinking about it"')
    expect(frame).toContain('"finish_reason":null')
  })

  it('carries the tool call as one tool_calls delta with a null finish', () => {
    const sse = sseRenderer('glm-web')
    const callFrame = sse.toolCall('call-9', 'read', '{"file_path":"a.ts"}')
    expect(callFrame).toContain('"tool_calls":[{"index":0,"id":"call-9","type":"function"')
    expect(callFrame).toContain('"finish_reason":null')
    expect(sse.finish('tool_calls')).toContain('"finish_reason":"tool_calls"')
  })
})
