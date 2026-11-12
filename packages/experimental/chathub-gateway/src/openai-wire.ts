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
    // Sites with a visible reasoning trace send it in a separate channel;
    // without this field a client can only show the finished reply.
    ...assembled.reasoning.length > 0 ? { reasoning_content: assembled.reasoning } : {},
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
 * Render the SSE frames of one completion stream as its chunks arrive.
 *
 * Frames follow the assembled layout the non-streaming response uses — role
 * delta, reasoning deltas, content deltas, one complete tool-call delta, the
 * terminal reason, `[DONE]` — but each frame is produced the moment its chunk
 * lands, so a client watching the event stream sees the thinking and the
 * answer while the site writes them.
 * @param model - model id the caller asked for.
 * @returns The per-frame renderers for one open event stream.
 */
export function sseRenderer(model: string): SseRenderer {
  const header = { id: 'chathub-turn', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
  return {
    role: () => frame({ ...header, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
    content: (text: string) => frame({ ...header, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }),
    reasoning: (text: string) => frame({
      ...header,
      // `reasoning_content` is the DeepSeek/vLLM convention; `reasoning` is
      // the alias several agent clients read. Clients pick one with `??`, so
      // carrying both keeps the thinking panel working across them.
      choices: [{ index: 0, delta: { reasoning_content: text, reasoning: text }, finish_reason: null }],
    }),
    toolCall: (id: string, name: string, argumentsJson: string) => frame({
      ...header,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: argumentsJson } }],
        },
        finish_reason: null,
      }],
    }),
    finish: (reason: 'stop' | 'tool_calls') => frame({ ...header, choices: [{ index: 0, delta: {}, finish_reason: reason }] }),
    done: () => 'data: [DONE]\n',
  }
}

/** The frame renderers of one open SSE completion stream. */
export interface SseRenderer {
  /** @returns The leading role delta frame. */
  role(): string
  /**
   * @param text - one answer delta.
   * @returns The content delta frame for it.
   */
  content(text: string): string
  /**
   * @param text - one reasoning / chain-of-thought delta.
   * @returns The reasoning delta frame for it.
   */
  reasoning(text: string): string
  /**
   * @param id - adapter call id.
   * @param name - tool name.
   * @param argumentsJson - complete call arguments JSON.
   * @returns The single tool-call delta frame for the call.
   */
  toolCall(id: string, name: string, argumentsJson: string): string
  /**
   * @param reason - the successful terminal reason.
   * @returns The finish frame for it.
   */
  finish(reason: 'stop' | 'tool_calls'): string
  /** @returns The `[DONE]` sentinel. */
  done(): string
}

/** One assembled turn: display text, the single accepted call, and metadata. */
interface Assembled {
  text: string
  reasoning: string
  call: { id: string; name: string; arguments: string } | undefined
  messageId: string
  created: number
  usage: Record<string, unknown> | undefined
}

/**
 * Fold adapter chunks, taking the first text block's text, the first reasoning
 * block's text, and the first tool-call block while ignoring later blocks the
 * adapter never emits. The block-end text wins over concatenated deltas: with a live-streaming source
 * the deltas are the answer as it grew, while the block-end carries the
 * bounded, marker-stripped text the protocol accepted.
 * @param chunks - adapter chunks in order.
 * @returns The assembled turn.
 */
function assemble(chunks: readonly StreamChunk[]): Assembled {
  let deltas = ''
  let reasoningDeltas = ''
  let blockText: string | undefined
  let reasoningBlock: string | undefined
  let call: Assembled['call']
  let usage: Record<string, unknown> | undefined
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'text-delta':
        if (call === undefined && blockText === undefined) deltas += chunk.text
        break
      case 'reasoning-delta':
        if (reasoningBlock === undefined) reasoningDeltas += chunk.text
        break
      case 'block-end':
        if (chunk.block.type === 'text' && blockText === undefined) blockText = chunk.block.text
        if (chunk.block.type === 'reasoning' && reasoningBlock === undefined) reasoningBlock = chunk.block.text
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
  return {
    text: blockText ?? deltas,
    reasoning: reasoningBlock ?? reasoningDeltas,
    call,
    messageId: 'turn',
    created: Date.now(),
    usage,
  }
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
