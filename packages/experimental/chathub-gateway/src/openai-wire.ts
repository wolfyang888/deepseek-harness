/**
 * OpenAI wire translation: `/v1/chat/completions` request bodies in, adapter
 * stream chunks out, OpenAI response and SSE frames back.
 *
 * One seam, one direction pair: the request side folds OpenAI messages and
 * tools into `GenerateOptions`, the response side unfolds adapter chunks into
 * the completion object or the SSE event sequence. The per-reply single call
 * block is preserved as `parallel_tool_calls: false` in the response, which
 * every OpenAI-compatible agent loop already handles.
 *
 * @module @deepseek-ai/dsh-experimental-chathub-gateway/openai-wire
 */

import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
  type ContentBlock,
  type GenerateOptions,
  type RequestMessage,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'

/** One OpenAI chat message as an external agent posts it. */
export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /**
   * String content, or the assistant's mixed content array. A wire message
   * may omit the field entirely, so `undefined` reads as empty text.
   */
  content: string | readonly WireContentPart[] | null | undefined
  /** Assistant tool calls, OpenAI shape. */
  tool_calls?: readonly WireToolCall[]
  /** Tool message: the id of the call it answers. */
  tool_call_id?: string
  /** Tool message: whether the tool reported failure. */
  isError?: boolean
}

/** One OpenAI assistant content part. */
export interface WireContentPart {
  type: 'text' | 'tool_call'
  text?: string
  tool_call?: WireToolCall
}

/** One OpenAI assistant tool call. */
export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** One OpenAI tool declaration. */
export interface WireTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** One `/v1/chat/completions` request body. */
export interface WireCompletionRequest {
  model: string
  messages: readonly WireMessage[]
  tools?: readonly WireTool[]
  stream?: boolean
}

/**
 * Fold one wire request into adapter options.
 * @param request - the parsed request body.
 * @param route - provider route the model id resolves to.
 * @returns Complete options for one `ctx.llm.stream` call.
 * @throws Error naming the first field the request cannot translate.
 */
export function toGenerateOptions(request: WireCompletionRequest, route: string): GenerateOptions {
  const messages: RequestMessage[] = []
  let system: string | undefined
  for (const message of request.messages) {
    switch (message.role) {
      case 'system':
        system = textOf(message.content)
        break
      case 'user':
        messages.push(createUserMessage({ content: [{ type: 'text', text: textOf(message.content) }], source: { kind: 'user' } }))
        break
      case 'assistant': {
        const content: ContentBlock[] = []
        const text = textOf(message.content)
        if (text.length > 0) content.push({ type: 'text', text })
        for (const call of message.tool_calls ?? []) {
          content.push({
            type: 'tool-call',
            id: ToolCallId(call.id),
            name: call.function.name,
            arguments: call.function.arguments,
          })
        }
        // An assistant turn with neither text nor calls still contributes an
        // empty entry, keeping positions aligned with the tool results that
        // answer it.
        messages.push(createAssistantMessage({ content, source: { provider: route, model: request.model } }))
        break
      }
      case 'tool': {
        const id = message.tool_call_id ?? ''
        if (id.length === 0) throw new Error('tool message without tool_call_id')
        messages.push(createToolResultMessage({
          callId: ToolCallId(id),
          content: [{ type: 'text', text: textOf(message.content) }],
          isError: message.isError === true,
        }))
        break
      }
    }
  }
  if (system !== undefined) messages.unshift(createSystemMessage(system))
  const tools: ToolSchema[] | undefined = request.tools === undefined ? undefined : request.tools.map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }))
  return {
    provider: route,
    model: request.model,
    messages,
    ...system === undefined ? {} : { system },
    ...tools === undefined ? {} : { tools },
  }
}

/**
 * Collect the adapter chunks of one turn into a non-streaming response body.
 * @param route - provider route that answered.
 * @param model - model id the caller asked for.
 * @param chunks - the turn's adapter chunks in order.
 * @returns The OpenAI completion object.
 */
export function toCompletionResponse(route: string, model: string, chunks: readonly StreamChunk[]): Record<string, unknown> {
  const assembled = assemble(chunks)
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: assembled.text.length === 0 ? null : assembled.text,
  }
  if (assembled.call !== undefined) {
    message.tool_calls = [{
      id: assembled.call.id,
      type: 'function',
      function: { name: assembled.call.name, arguments: assembled.call.arguments },
    }]
  }
  return {
    id: `chathub-${assembled.messageId}`,
    object: 'chat.completion',
    created: Math.floor(assembled.created / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: assembled.call !== undefined ? 'tool_calls' : 'stop',
    }],
    ...assembled.usage === undefined ? {} : { usage: assembled.usage },
    // The adapter protocol allows at most one call block per reply; stating
    // it lets agents that parallelize skip re-asking.
    parallel_tool_calls: false,
    _provider: route,
  }
}

/**
 * Render the SSE event frames of one assembled turn, including the leading
 * role delta and the final `[DONE]` sentinel.
 * @param model - model id the caller asked for.
 * @param chunks - the turn's adapter chunks in order.
 * @returns The exact `data:` frames to write, newline-terminated.
 */
export function toSseFrames(model: string, chunks: readonly StreamChunk[]): string[] {
  const assembled = assemble(chunks)
  const id = `chathub-${assembled.messageId}`
  const created = Math.floor(assembled.created / 1000)
  const header = { id, object: 'chat.completion.chunk', created, model }
  const frames: string[] = []
  frames.push(frame({ ...header, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }))
  if (assembled.text.length > 0) {
    frames.push(frame({ ...header, choices: [{ index: 0, delta: { content: assembled.text }, finish_reason: null }] }))
  }
  if (assembled.call !== undefined) {
    frames.push(frame({
      ...header,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: assembled.call.id,
            type: 'function',
            function: { name: assembled.call.name, arguments: assembled.call.arguments },
          }],
        },
        finish_reason: null,
      }],
    }))
  }
  frames.push(frame({ ...header, choices: [{ index: 0, delta: {}, finish_reason: assembled.call !== undefined ? 'tool_calls' : 'stop' }] }))
  frames.push('data: [DONE]\n')
  return frames
}

/** One assembled turn: display text, the single accepted call, and metadata. */
interface Assembled {
  text: string
  call: { id: string; name: string; arguments: string } | undefined
  messageId: string
  created: number
  usage: Record<string, unknown> | undefined
}

/**
 * Fold adapter chunks, taking the first text and the first tool-call block
 * and ignoring later blocks the adapter never emits.
 * @param chunks - adapter chunks in order.
 * @returns The assembled turn.
 */
function assemble(chunks: readonly StreamChunk[]): Assembled {
  let text = ''
  let call: Assembled['call']
  const messageId = 'turn'
  const created = Date.now()
  let usage: Record<string, unknown> | undefined
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'text-delta':
        if (call === undefined) text += chunk.text
        break
      case 'block-end':
        if (chunk.block.type === 'tool-call' && call === undefined) {
          call = { id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments }
        }
        break
      case 'usage':
        usage = {
          prompt_tokens: chunk.usage.inputTokens,
          completion_tokens: chunk.usage.outputTokens,
          total_tokens: chunk.usage.totalTokens ?? (chunk.usage.inputTokens + chunk.usage.outputTokens),
        }
        break
      default:
        break
    }
  }
  return { text, call, messageId, created, usage }
}

/**
 * Extract the text of one wire content value.
 * @param content - string, parts array, or null.
 * @returns The concatenated text; an empty string for none.
 */
function textOf(content: WireMessage['content']): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  return content.map(part => part.type === 'text' ? part.text ?? '' : '').join('')
}

/**
 * Render one SSE frame.
 * @param payload - the chunk object.
 * @returns The `data: <json>\n\n` frame.
 */
function frame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}
