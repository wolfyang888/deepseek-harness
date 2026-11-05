/**
 * Request rendering: harness messages plus tool schemas, folded into one
 * self-contained prompt a plain chat box can answer.
 *
 * The site keeps its own history per conversation, but every request here
 * opens a fresh conversation, so the prompt must carry everything the model
 * needs: who it is, which tools exist, how to ask for one, and what has
 * happened so far. Rendering is pure so a snapshot can pin the shape.
 *
 * @module @deepseek-ai/dsh-experimental-llm-chathub/render
 */

import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { clampText } from './budget.ts'
import {
  ChatHubPromptOverflowError,
  DEFAULT_MAX_TOOL_DESCRIPTION_CHARS,
  type ChatHubRenderPolicy,
} from './types.ts'

/** One conversation line, already flattened from its content blocks. */
interface Entry {
  readonly role: 'user' | 'assistant' | 'tool'
  readonly text: string
}

/** A rendered prompt with the budget facts the caller reports. */
export interface RenderedPrompt {
  /** The complete prompt to paste into the site's composer. */
  readonly prompt: string
  /** Conversation entries dropped to fit the budget. */
  readonly droppedEntries: number
}

/** Tool name that stands for "run a command"; only it can execute `verify`. */
const SHELL_TOOL = 'bash'

/** Fixed role text; the protocol is short so a site never rewrites it. */
const ROLE_TEXT = [
  'You operate a coding task one step at a time through tools.',
  'Each reply may ask for at most one tool call, and only through the block format below.',
  'You cannot see the filesystem: everything you know about the project arrives in this prompt.',
].join('\n')

/** Protocol instructions, including the exact delimiters. */
const PROTOCOL_TEXT = [
  'To act, reply with exactly one block and nothing else inside it:',
  '<<<TOOL_CALL',
  '{"name":"<tool>","arguments":{...}}',
  'TOOL_CALL>>>',
  'Put any explanation outside the block. Never invent tool output: you only see what the tools returned.',
  'Copy file text byte for byte: inside "arguments", indentation, spaces, and ASCII punctuation',
  '(--, ", \', ...) must match the tool result exactly; a retyped line will not match the file.',
  'When the task is complete, or when you need the user to decide, reply without a block.',
].join('\n')

/**
 * Render one request into a single prompt.
 *
 * History is dropped oldest-first until the prompt fits `maxPromptChars`; if
 * even a history-free rendering does not fit, the caller gets
 * {@link ChatHubPromptOverflowError} instead of a silently truncated task.
 * @param options - the assembled request the loop handed the adapter.
 * @param policy - tools, project facts, and budgets of this mount.
 * @returns The prompt and how many entries were dropped to build it.
 * @throws ChatHubPromptOverflowError when the task itself exceeds the budget.
 */
export function renderRequest(options: GenerateOptions, policy: ChatHubRenderPolicy): RenderedPrompt {
  const entries = conversationEntries(options.messages, policy.maxToolResultChars)
  // The loop appends surface-owned auxiliary user messages (runtime-context
  // snapshots, <system-reminder> catalogs) after the task; # NOW must stay the
  // task, or the site answers the environment blurb instead of the request.
  const nowIndex = entries.findLastIndex(entry => entry.role === 'user' && !isAuxiliary(entry.text))
  const now = nowIndex >= 0 ? entries[nowIndex] : entries.at(-1)
  const history = entries.filter((_, index) => index !== nowIndex)
  const system = clampText(systemTextOf(options), policy.maxSystemChars)
  const head = [
    '# ROLE', ROLE_TEXT, '',
    ...system.length === 0 ? [] : ['# SYSTEM', system, ''],
    '# TOOLS', toolSection(policy), '',
    '# PROTOCOL', PROTOCOL_TEXT, '',
    '# PROJECT', projectSection(policy), '',
    '# CONVERSATION',
  ]
  const tail = ['', '# NOW', now === undefined ? '(no message)' : renderEntry(now)]
  let smallest = ''
  for (let keep = Math.min(history.length, Math.max(0, policy.historyTurns)); keep >= 0; keep -= 1) {
    const dropped = history.length - keep
    const kept = history.slice(dropped)
    const lines = [
      ...dropped === 0 ? kept.length === 0 ? ['(none)'] : [] : [`[earlier: ${String(dropped)} entries omitted]`],
      ...kept.map(entry => renderEntry(entry)),
    ]
    const prompt = [...head, ...lines, ...tail].join('\n')
    if (keep === 0) smallest = prompt
    if (prompt.length <= policy.maxPromptChars) return { prompt, droppedEntries: dropped }
  }
  throw new ChatHubPromptOverflowError(smallest.length, policy.maxPromptChars)
}

/**
 * Flatten the harness messages into conversation lines.
 * @param messages - request messages in order.
 * @param maxToolResultChars - per-result budget.
 * @returns Entries oldest first; system and developer messages carry no line.
 */
function conversationEntries(messages: readonly RequestMessage[], maxToolResultChars: number): Entry[] {
  const names = new Map<string, string>()
  const entries: Entry[] = []
  for (const message of messages) {
    const role = message.role
    if (role === 'system' || role === 'developer') continue
    const text = blocksText(message.content, names)
    if (role === 'tool') {
      const name = names.get(message.toolCallId) ?? 'tool'
      const flag = message.isError === true ? ' [error]' : ''
      entries.push({ role: 'tool', text: `tool(${name}) ->${flag} ${clampText(text, maxToolResultChars)}` })
      continue
    }
    if (text.length === 0) continue
    entries.push({ role: role === 'assistant' ? 'assistant' : 'user', text })
  }
  return entries
}

/**
 * Flatten content blocks into the text a chat box can read.
 * @param blocks - model-facing blocks of one message.
 * @param names - tool-call id to name map, extended in place so later tool
 *   results can name the call they answer.
 * @returns Joined block text.
 */
function blocksText(blocks: readonly ContentBlock[], names: Map<string, string>): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'tool-call') {
      names.set(block.id, block.name)
      parts.push(`[asked for ${block.name} ${block.arguments}]`)
    } else if (block.type === 'image') parts.push('[an image was attached; this channel is text-only]')
    else if (block.type === 'file') parts.push('[a file was attached; this channel is text-only]')
  }
  return parts.join('\n').trim()
}

/**
 * @param entry - one conversation line.
 * @returns Its renderable text.
 */
function renderEntry(entry: Entry): string {
  return entry.role === 'tool' ? entry.text : `${entry.role}: ${entry.text}`
}

/**
 * Decide whether a message is a loop-owned surface update rather than content.
 * @param text - flattened message text.
 * @returns `true` for runtime-context snapshots and whole-message skill reminders.
 */
function isAuxiliary(text: string): boolean {
  return text.startsWith('Current runtime context')
    || (text.startsWith('<system-reminder>') && text.endsWith('</system-reminder>'))
}

/**
 * Read the harness system prompt the request carries.
 * @param options - the assembled request.
 * @returns `options.system`, else the leading system message's text.
 */
function systemTextOf(options: GenerateOptions): string {
  if (options.system !== undefined) return options.system
  const first = options.messages[0]
  if (first === undefined || first.role !== 'system') return ''
  return blocksText(first.content, new Map()).trim()
}

/**
 * Render the tool declarations the model may use.
 * @param policy - render policy carrying the filtered schemas.
 * @returns One compact JSON object per line.
 */
function toolSection(policy: ChatHubRenderPolicy): string {
  if (policy.tools.length === 0) return '(no tools are available in this session)'
  return policy.tools.map(tool => JSON.stringify({
    name: tool.name,
    description: clampText(tool.description, DEFAULT_MAX_TOOL_DESCRIPTION_CHARS),
    parameters: tool.parameters,
  })).join('\n')
}

/**
 * Render the project block: root and the commands that decide completion.
 *
 * A verification command is only stated as the completion check when the model
 * can actually run it: the prompt must not ask for a shell round the whitelist
 * has already closed, or the model answers "done" without ever checking.
 * @param policy - render policy.
 * @returns Project lines.
 */
function projectSection(policy: ChatHubRenderPolicy): string {
  const canRunCommands = policy.tools.some(tool => tool.name === SHELL_TOOL)
  return [
    `root: ${policy.workspaceRoot ?? '(unknown; use relative paths)'}`,
    policy.verifyCommands.length === 0
      ? 'verify: none configured'
      : canRunCommands
        ? `verify: ${policy.verifyCommands.join(' && ')}`
        : `verify: ${policy.verifyCommands.join(' && ')} (report it; no shell tool is available here)`,
  ].join('\n')
}
