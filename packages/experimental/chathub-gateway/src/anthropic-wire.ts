/**
 * Anthropic wire translation: `/v1/messages` request bodies in, adapter
 * stream chunks out, Anthropic response and SSE events back.
 *
 * The seam mirrors {@link ./openai-wire.ts}: the request side folds Anthropic
 * messages and tools into `GenerateOptions`, the response side unfolds
 * adapter chunks into the message object or the SSE event sequence Claude
 * Code reads. The per-reply single call block maps to at most one `tool_use`
 * content block, which the Anthropic client loop already handles serially.
 *
 * `max_tokens` is required by the wire but ignored here: the adapter carries
 * its own output budgets, and inventing a token cap over a character-bounded
 * site answer would only truncate legal replies.
 *
 * @module @deepseek-ai/dsh-experimental-chathub-gateway/anthropic-wire
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
import { TOOL_RESULT_CONTINUATION, type GatewayFailure, type WireCodec } from './types.ts'

/** One Anthropic messages request as Claude Code posts it. */
export interface AnthropicRequest {
  model: string
  /** Top-level system prompt: a string or a block list; absent means none. */
  system?: string | readonly AnthropicSystemBlock[] | null
  messages: readonly AnthropicMessage[]
  tools?: readonly AnthropicTool[]
  stream?: boolean
  /** Accepted and ignored; the adapter carries its own output budgets. */
  max_tokens?: number
  /** Accepted and ignored; a site composer has no sampling controls. */
  temperature?: number
}

/** One system-prompt block; only text carries meaning for a site turn. */
export interface AnthropicSystemBlock {
  type: 'text'
  text?: string
}

/** One Anthropic conversation message. */
export interface AnthropicMessage {
  role: 'user' | 'assistant'
  /**
   * String content, or the block list the wire carries. A message may omit
   * the field entirely, so `undefined` reads as empty text.
   */
  content: string | readonly AnthropicContentBlock[] | null | undefined
}

/** One user or assistant content block. */
export type AnthropicContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
  | { type: 'tool_result'; tool_use_id?: string; content?: string | readonly { type: 'text'; text?: string }[] | null; is_error?: boolean }

/** One Anthropic tool declaration. */
export interface AnthropicTool {
  name?: string
  description?: string
  input_schema?: Record<string, unknown>
}

/**
 * Fold one Anthropic wire request into adapter options.
 * @param request - the parsed request body.
 * @param route - provider route the model id resolves to.
 * @returns Complete options for one `ctx.llm.stream` call.
 * @throws Error naming the first field the request cannot translate.
 */
export function toGenerateOptionsFromAnthropic(request: AnthropicRequest, route: string): GenerateOptions {
  const messages: RequestMessage[] = []
  for (const message of request.messages) {
    const blocks = blockList(message.content)
    if (message.role === 'user') {
      // Tool results answer the immediately preceding assistant call, so they
      // land before any new user text carried in the same message.
      for (const block of blocks) {
        if (block.type !== 'tool_result') continue
        const id = block.tool_use_id ?? ''
        if (id.length === 0) throw new Error('tool_result block without tool_use_id')
        messages.push(createToolResultMessage({
          callId: ToolCallId(id),
          content: [{ type: 'text', text: toolResultText(block.content) }],
          isError: block.is_error === true,
        }))
      }
      const text = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
      if (text.length > 0) {
        messages.push(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      }
      continue
    }
    // Assistant: text blocks and tool_use blocks fold into one turn, exactly
    // as the OpenAI wire folds text and `tool_calls`.
    const content: ContentBlock[] = []
    const text = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    if (text.length > 0) content.push({ type: 'text', text })
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      const id = block.id ?? ''
      if (id.length === 0) throw new Error('tool_use block without id')
      if (typeof block.name !== 'string' || block.name.length === 0) throw new Error('tool_use block without name')
      content.push({
        type: 'tool-call',
        id: ToolCallId(id),
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      })
    }
    messages.push(createAssistantMessage({ content, source: { provider: route, model: request.model } }))
  }
  const system = systemText(request.system)
  if (system !== undefined) messages.unshift(createSystemMessage(system))
  if (messages.at(-1)?.role === 'tool') {
    messages.push(createUserMessage({
      content: [{ type: 'text', text: TOOL_RESULT_CONTINUATION }],
      source: { kind: 'user' },
    }))
  }
  const tools: ToolSchema[] | undefined = request.tools === undefined ? undefined : request.tools.map((tool) => {
    if (typeof tool.name !== 'string' || tool.name.length === 0) throw new Error('tool without name')
    return {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.input_schema ?? { type: 'object' },
    }
  })
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
 * @param model - model id the caller asked for.
 * @param chunks - the turn's adapter chunks in order.
 * @returns The Anthropic message object.
 */
export function toMessagesResponse(model: string, chunks: readonly StreamChunk[]): Record<string, unknown> {
  const assembled = assemble(chunks)
  const content: Record<string, unknown>[] = []
  if (assembled.text.length > 0) content.push({ type: 'text', text: assembled.text })
  if (assembled.call !== undefined) {
    content.push({
      type: 'tool_use',
      id: assembled.call.id,
      name: assembled.call.name,
      input: JSON.parse(assembled.call.arguments) as Record<string, unknown>,
    })
  }
  return {
    id: `msg_chathub_${assembled.messageId}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: assembled.call !== undefined ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    ...assembled.usage === undefined ? {} : { usage: assembled.usage },
  }
}

/**
 * Render the SSE events of one message stream as its chunks arrive.
 *
 * The event vocabulary is Anthropic's: `message_start`, one `content_block`
 * pair per adapter block with `content_block_delta` text in between, the
 * terminal `message_delta` and `message_stop`, and `ping` as the keepalive
 * event. Each event is produced the moment its chunk lands, so a client
 * watching the stream sees the answer while the site writes it.
 * @param model - model id the caller asked for.
 * @returns The per-event renderers for one open message stream.
 */
export function anthropicSseRenderer(model: string): AnthropicSseRenderer {
  const message = {
    id: 'msg_chathub_turn',
    type: 'message',
    role: 'assistant',
    model,
    content: [] as unknown[],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
  return {
    messageStart: () => event('message_start', { type: 'message_start', message }),
    textStart: (index: number) => event('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    }),
    textDelta: (index: number, text: string) => event('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text },
    }),
    textStop: (index: number) => event('content_block_stop', { type: 'content_block_stop', index }),
    toolStart: (index: number, id: string, name: string) => event('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id, name, input: {} },
    }),
    toolDelta: (index: number, argumentsJson: string) => event('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: argumentsJson },
    }),
    toolStop: (index: number) => event('content_block_stop', { type: 'content_block_stop', index }),
    messageDelta: (stopReason: 'end_turn' | 'tool_use', outputTokens: number) => event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    }),
    messageStop: () => event('message_stop', { type: 'message_stop' }),
    ping: () => event('ping', { type: 'ping' }),
    failure: (type: string, errorMessage: string) => event('error', {
      type: 'error',
      error: { type, message: errorMessage },
    }),
  }
}

/** The event renderers of one open Anthropic SSE message stream. */
export interface AnthropicSseRenderer {
  /** @returns The opening `message_start` event. */
  messageStart(): string
  /**
   * @param index - content block index.
   * @returns The text block's `content_block_start` event.
   */
  textStart(index: number): string
  /**
   * @param index - content block index.
   * @param text - one answer delta.
   * @returns The `text_delta` event for it.
   */
  textDelta(index: number, text: string): string
  /**
   * @param index - content block index.
   * @returns The text block's `content_block_stop` event.
   */
  textStop(index: number): string
  /**
   * @param index - content block index.
   * @param id - adapter call id.
   * @param name - tool name.
   * @returns The `tool_use` block's `content_block_start` event.
   */
  toolStart(index: number, id: string, name: string): string
  /**
   * @param index - content block index.
   * @param argumentsJson - complete call arguments JSON.
   * @returns The one-shot `input_json_delta` event carrying it.
   */
  toolDelta(index: number, argumentsJson: string): string
  /**
   * @param index - content block index.
   * @returns The `tool_use` block's `content_block_stop` event.
   */
  toolStop(index: number): string
  /**
   * @param stopReason - the successful terminal reason.
   * @param outputTokens - provider-reported output tokens, zero when unknown.
   * @returns The terminal `message_delta` event for it.
   */
  messageDelta(stopReason: 'end_turn' | 'tool_use', outputTokens: number): string
  /** @returns The closing `message_stop` event. */
  messageStop(): string
  /** @returns The `ping` keepalive event. */
  ping(): string
  /**
   * @param type - Anthropic error type.
   * @param errorMessage - user-facing message.
   * @returns The `error` event riding the open stream.
   */
  failure(type: string, errorMessage: string): string
}

/** The Anthropic error envelope every Anthropic-wire failure writes. */
export interface AnthropicErrorBody {
  type: 'error'
  error: { type: string; message: string }
}

/**
 * Render one gateway failure as an Anthropic error envelope.
 * @param failure - the mapped failure.
 * @returns The serializable error body.
 */
export function anthropicErrorBody(failure: GatewayFailure): AnthropicErrorBody {
  let type: string
  if (failure.status === 401) type = 'authentication_error'
  else if (failure.status === 429) type = 'rate_limit_error'
  else if (failure.status === 400) type = 'invalid_request_error'
  else type = 'api_error'
  return { type: 'error', error: { type, message: failure.message } }
}

/**
 * Anthropic presentation of one turn: `message_start`, one content block per
 * adapter block, the terminal `message_delta` and `message_stop`.
 *
 * Reasoning deltas are dropped: an Anthropic `thinking` block is only legal
 * with a provider signature, and inventing one would be rejected by the
 * client. The answer text and the single tool call are what the wire carries.
 * @param model - model id the caller asked for.
 * @returns The codec the server's shared turn loop drives.
 */
export function anthropicWireCodec(model: string): WireCodec {
  const sse = anthropicSseRenderer(model)
  let nextIndex = 0
  let open: number | undefined
  let toolCall = false
  let outputTokens = 0
  const closeOpen = (): string[] => {
    if (open === undefined) return []
    const index = open
    open = undefined
    return [sse.textStop(index)]
  }
  const openText = (): { index: number; frames: string[] } => {
    if (open !== undefined) return { index: open, frames: [] }
    const index = nextIndex
    nextIndex += 1
    open = index
    return { index, frames: [sse.textStart(index)] }
  }
  return {
    keepalive: sse.ping(),
    openStream: () => [sse.messageStart()],
    renderChunk: (chunk) => {
      switch (chunk.type) {
        case 'text-delta': {
          const text = openText()
          return [...text.frames, sse.textDelta(text.index, chunk.text)]
        }
        case 'block-end':
          if (chunk.block.type === 'text') return closeOpen()
          if (chunk.block.type !== 'tool-call') return []
          // The adapter carries the complete call id and arguments by the time
          // the block ends, so the whole `tool_use` block renders at once.
          toolCall = true
          const index = nextIndex
          nextIndex += 1
          return [
            ...closeOpen(),
            sse.toolStart(index, chunk.block.id, chunk.block.name),
            sse.toolDelta(index, chunk.block.arguments),
            sse.toolStop(index),
          ]
        case 'usage':
          outputTokens = chunk.usage.outputTokens
          return []
        default:
          return []
      }
    },
    closeStream: () => [
      ...closeOpen(),
      sse.messageDelta(toolCall ? 'tool_use' : 'end_turn', outputTokens),
      sse.messageStop(),
    ],
    responseBody: (model, chunks) => toMessagesResponse(model, chunks),
    errorBody: (failure) => JSON.stringify(anthropicErrorBody(failure)),
    streamFailure: (failure) => [sse.failure(anthropicErrorBody(failure).error.type, failure.message)],
  }
}

/** One assembled turn: display text, the single accepted call, and metadata. */
interface Assembled {
  text: string
  call: { id: string; name: string; arguments: string } | undefined
  messageId: string
  usage: Record<string, unknown> | undefined
}

/**
 * Fold adapter chunks, taking the first text block's text and the first
 * tool-call block and ignoring later blocks the adapter never emits. The
 * block-end text wins over concatenated deltas: with a live-streaming source
 * the deltas are the answer as it grew, while the block-end carries the
 * bounded, marker-stripped text the protocol accepted.
 * @param chunks - adapter chunks in order.
 * @returns The assembled turn.
 */
function assemble(chunks: readonly StreamChunk[]): Assembled {
  let deltas = ''
  let blockText: string | undefined
  let call: Assembled['call']
  let usage: Record<string, unknown> | undefined
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'text-delta':
        if (call === undefined && blockText === undefined) deltas += chunk.text
        break
      case 'block-end':
        if (chunk.block.type === 'text' && blockText === undefined) blockText = chunk.block.text
        if (chunk.block.type === 'tool-call' && call === undefined) {
          call = { id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments }
        }
        break
      case 'usage':
        usage = {
          input_tokens: chunk.usage.inputTokens,
          output_tokens: chunk.usage.outputTokens,
        }
        break
      default:
        break
    }
  }
  return { text: blockText ?? deltas, call, messageId: 'turn', usage }
}

/**
 * Normalize one message content value into its block list.
 * @param content - string, block list, or null.
 * @returns The blocks; an empty list for none.
 */
function blockList(content: AnthropicMessage['content']): readonly AnthropicContentBlock[] {
  if (typeof content === 'string') return content.length === 0 ? [] : [{ type: 'text', text: content }]
  if (content === null || content === undefined) return []
  return content
}

/**
 * Extract the system prompt of one request.
 * @param system - top-level string or block list.
 * @returns The concatenated text, or undefined when the request carries none.
 */
function systemText(system: AnthropicRequest['system']): string | undefined {
  if (typeof system === 'string') return system.length === 0 ? undefined : system
  if (system === null || system === undefined) return undefined
  const text = system.map(block => block.type === 'text' ? block.text ?? '' : '').join('')
  return text.length === 0 ? undefined : text
}

/**
 * Extract the text of one tool result content value.
 * @param content - string, text-block list, or null.
 * @returns The concatenated text; an empty string for none.
 */
function toolResultText(content: string | readonly { type: 'text'; text?: string }[] | null | undefined): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  return content.map(part => part.type === 'text' ? part.text ?? '' : '').join('')
}

/**
 * Render one SSE event with its type line.
 * @param type - the event type name.
 * @param payload - the event object.
 * @returns The `event: <type>\ndata: <json>\n\n` frame.
 */
function event(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}
