/** Render: one self-contained prompt per request, inside a character budget. */

import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
  type GenerateOptions,
  type RequestMessage,
} from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { renderRequest } from '../src/render.ts'
import { ChatHubPromptOverflowError, type ChatHubRenderPolicy } from '../src/types.ts'

const POLICY: ChatHubRenderPolicy = {
  tools: [
    { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
    { name: 'edit', description: 'Edit a file', parameters: { type: 'object', properties: {} } },
  ],
  workspaceRoot: '/work/repo',
  verifyCommands: ['pnpm run typecheck'],
  maxPromptChars: 48_000,
  maxToolResultChars: 6_000,
  maxSystemChars: 4_000,
  historyTurns: 8,
}

/**
 * @param messages - request messages in order.
 * @returns A request carrying them.
 */
function request(...messages: RequestMessage[]): GenerateOptions {
  return { provider: 'deepseek-web-chathub', model: 'web-model', messages }
}

/**
 * @param text - user text.
 * @returns One user message.
 */
function user(text: string): RequestMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('renderRequest', () => {
  it('renders the fixed sections around the last message', () => {
    const { prompt, droppedEntries } = renderRequest(request(user('fix the build')), POLICY)
    expect(droppedEntries).toBe(0)
    expect(prompt.indexOf('# ROLE')).toBe(0)
    expect(prompt).toContain('# TOOLS')
    expect(prompt).toContain('"name":"read"')
    expect(prompt).toContain('# PROTOCOL')
    expect(prompt).toContain('<<<TOOL_CALL')
    expect(prompt).toContain('root: /work/repo')
    expect(prompt).toContain('verify: pnpm run typecheck')
    expect(prompt).toContain('# CONVERSATION\n(none)')
    expect(prompt).toContain('# NOW\nuser: fix the build')
    // No system prompt means no SYSTEM section at all.
    expect(prompt).not.toContain('# SYSTEM')
  })

  it('carries the one-shot system prompt', () => {
    const { prompt } = renderRequest({ ...request(user('go')), system: 'be terse' }, POLICY)
    expect(prompt).toContain('# SYSTEM\nbe terse')
  })

  it('reads a leading system message when the request has no system field', () => {
    const { prompt } = renderRequest(request(createSystemMessage('rendered prompt text'), user('go')), POLICY)
    expect(prompt).toContain('# SYSTEM\nrendered prompt text')
  })

  it('clamps the system prompt to its budget', () => {
    const { prompt } = renderRequest({ ...request(user('go')), system: 's'.repeat(100) }, { ...POLICY, maxSystemChars: 10 })
    expect(prompt).toContain('# SYSTEM\nssssssssss')
    expect(prompt).not.toContain('s'.repeat(11))
  })

  it('states when no tools are available', () => {
    const { prompt } = renderRequest(request(user('go')), { ...POLICY, tools: [] })
    expect(prompt).toContain('(no tools are available in this session)')
  })

  it('states an unknown root and an unconfigured verification', () => {
    const { prompt } = renderRequest(request(user('go')), {
      ...POLICY, workspaceRoot: undefined, verifyCommands: [],
    })
    expect(prompt).toContain('root: (unknown; use relative paths)')
    expect(prompt).toContain('verify: none configured')
  })

  it('renders a tool result under the name of the call it answers', () => {
    const callId = ToolCallId('call-1')
    const { prompt } = renderRequest(request(
      user('read main.ts'),
      createAssistantMessage({
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{"file_path":"src/main.ts"}' }],
        source: { provider: 'deepseek-web-chathub', model: 'web-model' },
      }),
      createToolResultMessage({ callId, content: [{ type: 'text', text: 'export const x = 1' }], isError: false }),
      user('now fix it'),
    ), POLICY)
    expect(prompt).toContain('assistant: [asked for read {"file_path":"src/main.ts"}]')
    expect(prompt).toContain('tool(read) -> export const x = 1')
    expect(prompt).toContain('# NOW\nuser: now fix it')
  })

  it('marks a failed tool result and names an unknown call plainly', () => {
    const callId = ToolCallId('call-2')
    const { prompt } = renderRequest(request(
      user('go'),
      createToolResultMessage({ callId, content: [{ type: 'text', text: 'no such file' }], isError: true }),
    ), POLICY)
    expect(prompt).toContain('tool(tool) -> [error] no such file')
  })

  it('clamps one tool result to the configured budget', () => {
    const callId = ToolCallId('call-3')
    const { prompt } = renderRequest(request(
      user('go'),
      createToolResultMessage({ callId, content: [{ type: 'text', text: 'a'.repeat(2_000) }], isError: false }),
    ), { ...POLICY, maxToolResultChars: 1_000 })
    expect(prompt).toContain('[omitted 1100 chars;')
  })

  it('notes attachments this channel cannot carry', () => {
    // Only the block tags matter here: the adapter never reads attachment refs.
    const attachment = {} as never
    const { prompt } = renderRequest(request(createUserMessage({
      content: [
        { type: 'image', attachment },
        { type: 'file', attachment },
        { type: 'text', text: 'what is this?' },
      ],
      source: { kind: 'user' },
    })), POLICY)
    expect(prompt).toContain('[an image was attached; this channel is text-only]')
    expect(prompt).toContain('[a file was attached; this channel is text-only]')
  })

  it('ignores blocks a chat box cannot express', () => {
    const { prompt } = renderRequest(request(
      user('go'),
      createAssistantMessage({
        content: [{ type: 'reasoning', text: 'weighing options' }, { type: 'text', text: 'done thinking' }],
        source: { provider: 'deepseek-web-chathub', model: 'web-model' },
      }),
    ), POLICY)
    expect(prompt).toContain('assistant: done thinking')
    expect(prompt).not.toContain('weighing options')
  })

  it('skips messages that carry nothing renderable', () => {
    const { prompt } = renderRequest(request(user('go'), createAssistantMessage({
      content: [], source: { provider: 'deepseek-web-chathub', model: 'web-model' },
    })), POLICY)
    expect(prompt).toContain('# NOW\nuser: go')
  })

  it('renders a request with no messages at all', () => {
    const { prompt } = renderRequest(request(), POLICY)
    expect(prompt).toContain('# CONVERSATION\n(none)')
    expect(prompt).toContain('# NOW\n(no message)')
  })

  it('drops the oldest entries until the prompt fits, and says how many', () => {
    const messages = Array.from({ length: 6 }, (_unused, index) => user(`${'x'.repeat(300)} step ${String(index)}`))
    const full = renderRequest(request(...messages), POLICY)
    expect(full.prompt).toMatch(/# NOW\nuser: x+ step 5$/u)
    const squeezed = renderRequest(request(...messages), { ...POLICY, maxPromptChars: full.prompt.length - 40 })
    expect(squeezed.droppedEntries).toBeGreaterThan(0)
    expect(squeezed.prompt).toContain('entries omitted]')
    expect(squeezed.prompt).toMatch(/# NOW\nuser: x+ step 5$/u)
    expect(squeezed.prompt.length).toBeLessThanOrEqual(full.prompt.length - 40)
  })

  it('keeps no history when the policy allows none', () => {
    const { prompt, droppedEntries } = renderRequest(request(user('a'), user('b')), { ...POLICY, historyTurns: 0 })
    expect(droppedEntries).toBe(1)
    expect(prompt).toContain('[earlier: 1 entries omitted]')
  })

  it('refuses a task that does not fit even without history', () => {
    let thrown: unknown
    try {
      renderRequest(request(user('x'.repeat(5_000))), { ...POLICY, maxPromptChars: 1_000 })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ChatHubPromptOverflowError)
    expect((thrown as ChatHubPromptOverflowError).maxChars).toBe(1_000)
    expect((thrown as ChatHubPromptOverflowError).chars).toBeGreaterThan(1_000)
  })
})
