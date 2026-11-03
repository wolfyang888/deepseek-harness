/** Protocol: one delimiter block per reply, validated before anything runs. */

import { describe, expect, it } from 'vitest'
import { formatToolCall, parseAnswer, TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from '../src/protocol.ts'
import type { ChatHubParsePolicy } from '../src/types.ts'

const POLICY: ChatHubParsePolicy = {
  allowTools: ['read', 'edit'],
  denyPaths: ['.git', 'node_modules'],
  workspaceRoot: '/work/repo',
  maxTextChars: 2_000,
  maxToolCallsPerTurn: 1,
}

/**
 * @param body - block body text.
 * @returns A reply holding exactly that block.
 */
function reply(body: string): string {
  return `here you go\n${TOOL_CALL_OPEN}\n${body}\n${TOOL_CALL_CLOSE}`
}

describe('parseAnswer', () => {
  it('returns plain prose unchanged when the reply carries no block', () => {
    const parsed = parseAnswer('  done, nothing to change  ', POLICY)
    expect(parsed).toEqual({ text: 'done, nothing to change', warnings: [] })
    expect(parsed.call).toBeUndefined()
    expect(parsed.invalid).toBeUndefined()
  })

  it('ellipsizes prose beyond the text budget', () => {
    const parsed = parseAnswer('x'.repeat(30), { ...POLICY, maxTextChars: 5 })
    expect(parsed.text).toBe('xxxx…')
  })

  it('rejects a block that never closes', () => {
    const parsed = parseAnswer(`thinking\n${TOOL_CALL_OPEN}\n{"name":"read"}`, POLICY)
    expect(parsed.invalid).toBe('the tool call block is not closed with TOOL_CALL>>>')
    expect(parsed.text).toBe('thinking')
  })

  it('rejects a block with no JSON object in it', () => {
    expect(parseAnswer(reply('read src/main.ts'), POLICY).invalid)
      .toBe('the tool call block carries no JSON object')
  })

  it('rejects a block whose braces never balance', () => {
    expect(parseAnswer(reply('{"name":"read"'), POLICY).invalid)
      .toBe('the tool call block carries no JSON object')
  })

  it('rejects a block whose JSON does not parse', () => {
    expect(parseAnswer(reply('{"name": }'), POLICY).invalid).toBe('the tool call block is not valid JSON')
  })

  it('rejects a block whose only JSON is an array of values', () => {
    expect(parseAnswer(reply('["read"]'), POLICY).invalid).toBe('the tool call block carries no JSON object')
  })

  it('shortens a hostile tool name in the rejection message', () => {
    const long = 'x'.repeat(200)
    expect(parseAnswer(reply(JSON.stringify({ name: long, arguments: {} })), POLICY).invalid)
      .toBe(`tool "${'x'.repeat(79)}…" is not allowed; allowed tools: read, edit`)
  })

  it('rejects a block without a tool name', () => {
    expect(parseAnswer(reply('{"arguments":{}}'), POLICY).invalid).toBe('the tool call block has no tool name')
    expect(parseAnswer(reply('{"name":42,"arguments":{}}'), POLICY).invalid).toBe('the tool call block has no tool name')
  })

  it('rejects a tool outside the whitelist and names what is allowed', () => {
    expect(parseAnswer(reply('{"name":"bash","arguments":{}}'), POLICY).invalid)
      .toBe('tool "bash" is not allowed; allowed tools: read, edit')
  })

  it('rejects a call without an arguments object', () => {
    expect(parseAnswer(reply('{"name":"read"}'), POLICY).invalid).toBe('tool "read" carries no arguments object')
    expect(parseAnswer(reply('{"name":"read","arguments":["a"]}'), POLICY).invalid)
      .toBe('tool "read" carries no arguments object')
  })

  it('accepts a legal call and strips the block from the prose', () => {
    const parsed = parseAnswer(reply('{"name":"read","arguments":{"file_path":"src/main.ts"}}'), POLICY)
    expect(parsed.invalid).toBeUndefined()
    expect(parsed.call).toEqual({ name: 'read', arguments: { file_path: 'src/main.ts' } })
    expect(parsed.text).toBe('here you go')
  })

  it('reads the object out of prose and nested braces inside strings', () => {
    const parsed = parseAnswer(
      reply('sure: {"name":"edit","arguments":{"file_path":"a.ts","old_string":"if (x) { y() }"}} trailing noise'),
      POLICY,
    )
    expect(parsed.call).toEqual({ name: 'edit', arguments: { file_path: 'a.ts', old_string: 'if (x) { y() }' } })
  })

  it('keeps the first of several blocks and reports the rest', () => {
    const parsed = parseAnswer(
      `${reply('{"name":"read","arguments":{"file_path":"a.ts"}}')}\n${reply('{"name":"read","arguments":{"file_path":"b.ts"}}')}`,
      POLICY,
    )
    expect(parsed.call?.arguments).toEqual({ file_path: 'a.ts' })
    expect(parsed.warnings).toEqual(['kept 1 of 2 call blocks: one reply runs at most 1 call'])
  })

  it('rejects a path that walks out with ..', () => {
    expect(parseAnswer(reply('{"name":"read","arguments":{"file_path":"../secrets.txt"}}'), POLICY).invalid)
      .toBe('path "../secrets.txt" leaves the workspace through ".."')
  })

  it('rejects a path inside a denied segment', () => {
    expect(parseAnswer(reply('{"name":"read","arguments":{"file_path":".git/config"}}'), POLICY).invalid)
      .toBe('path ".git/config" addresses the forbidden ".git"')
  })

  it('rejects a NUL byte in a path', () => {
    expect(parseAnswer(reply(String.raw`{"name":"read","arguments":{"file_path":"a\u0000b"}}`), POLICY).invalid)
      .toBe('path "a\u0000b" carries a NUL byte')
  })

  it('rejects an absolute path outside the workspace root', () => {
    expect(parseAnswer(reply('{"name":"read","arguments":{"file_path":"/etc/passwd"}}'), POLICY).invalid)
      .toBe('path "/etc/passwd" is outside /work/repo')
  })

  it('accepts absolute and relative paths inside the root, on either separator', () => {
    for (const file_path of ['/work/repo/src/a.ts', 'src/a.ts', '.\\src\\a.ts', 'C:\\other']) {
      const parsed = parseAnswer(reply(JSON.stringify({ name: 'read', arguments: { file_path } })), POLICY)
      // 'C:\other' is absolute on a POSIX root, so it is the one rejection here.
      if (file_path === 'C:\\other') expect(parsed.invalid).toBe('path "C:\\other" is outside /work/repo')
      else expect(parsed.invalid).toBeUndefined()
    }
  })

  it('accepts the root itself but not a sibling that merely shares its prefix', () => {
    const policy = { ...POLICY, workspaceRoot: '/work/repo/' }
    expect(parseAnswer(reply('{"name":"read","arguments":{"file_path":"/work/repo"}}'), policy).invalid).toBeUndefined()
    expect(parseAnswer(reply('{"name":"read","arguments":{"file_path":"/work/repo2/a.ts"}}'), policy).invalid)
      .toBe('path "/work/repo2/a.ts" is outside /work/repo')
  })

  it('checks every string of a path-shaped array and ignores other keys', () => {
    const allowed = parseAnswer(
      reply('{"name":"read","arguments":{"files":["src/a.ts","src/b.ts"],"content":"../not-a-path.txt"}}'),
      POLICY,
    )
    expect(allowed.invalid).toBeUndefined()
    const denied = parseAnswer(reply('{"name":"read","arguments":{"files":["src/a.ts","../b.ts"]}}'), POLICY)
    expect(denied.invalid).toBe('path "../b.ts" leaves the workspace through ".."')
  })

  it('enforces only traversal and the deny list when no root is configured', () => {
    const policy: ChatHubParsePolicy = { ...POLICY, workspaceRoot: undefined }
    expect(parseAnswer(reply('{"name":"read","arguments":{"file_path":"/etc/passwd"}}'), policy).invalid).toBeUndefined()
    expect(parseAnswer(reply('{"name":"read","arguments":{"file_path":"../a"}}'), policy).invalid)
      .toBe('path "../a" leaves the workspace through ".."')
  })

  it('ignores non-object arguments nested inside an allowed object', () => {
    const parsed = parseAnswer(reply('{"name":"read","arguments":{"limit":5,"deep":{"file_path":7}}}'), POLICY)
    expect(parsed.invalid).toBeUndefined()
  })

  it('keeps the text budget for prose around a rejected block', () => {
    const parsed = parseAnswer(`abcdefghij${reply('{"name":"bash","arguments":{}}')}`, { ...POLICY, maxTextChars: 5 })
    expect(parsed.text).toBe('abcd…')
    expect(parsed.invalid).toBeDefined()
  })
})

describe('formatToolCall', () => {
  it('round-trips through the parser', () => {
    const call = { name: 'read', arguments: { file_path: 'src/main.ts' } }
    const parsed = parseAnswer(formatToolCall(call), POLICY)
    expect(parsed.call).toEqual(call)
    expect(parsed.text).toBe('')
  })
})
