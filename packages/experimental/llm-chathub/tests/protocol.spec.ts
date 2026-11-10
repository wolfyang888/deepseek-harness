/** Protocol: one delimiter block per reply, validated before anything runs. */

import { describe, expect, it } from 'vitest'
import { END_MARKER, formatToolCall, parseAnswer, TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from '../src/protocol.ts'
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
    expect(parsed.text).toBe('done, nothing to change')
    expect(parsed.call).toBeUndefined()
    expect(parsed.invalid).toBeUndefined()
    expect(parsed.suspected).toBeUndefined()
    // Without the marker the reply may be cut off; enforcing that is the
    // caller's decision, so it is reported rather than rejected.
    expect(parsed.cutOff).toContain(END_MARKER)
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

  it('accepts a block typed with curly quotes by an IME', () => {
    // A real subject (chatglm.cn) answered exactly this way.
    const parsed = parseAnswer(reply('{“name”:“read”,“arguments”:{“file_path”:“src/main.ts”}}'), POLICY)
    expect(parsed.invalid).toBeUndefined()
    expect(parsed.call).toEqual({ name: 'read', arguments: { file_path: 'src/main.ts' } })
  })

  it('accepts a block whose Windows path backslashes the site halved', () => {
    // A real subject (doubao.com) sent exactly this shape: the rendered DOM
    // collapsed "D:\\work" to "D:\work", and \w is not a JSON escape.
    const policy = { ...POLICY, workspaceRoot: 'D:/work' }
    const parsed = parseAnswer(
      reply(String.raw`{"name":"read","arguments":{"file_path":"D:\work\src\a.ts"}}`),
      policy,
    )
    expect(parsed.invalid).toBeUndefined()
    expect(parsed.call).toEqual({ name: 'read', arguments: { file_path: 'D:\\work\\src\\a.ts' } })
    expect(parsed.warnings.join('\n')).toMatch(/repaired the call block/u)
  })

  it('accepts a block whose arguments arrived as a JSON string', () => {
    // The same subject also serialized "arguments" as a string, not an object.
    const parsed = parseAnswer(
      reply('{"name":"read","arguments":"{\\"file_path\\":\\"src/main.ts\\"}"}'),
      POLICY,
    )
    expect(parsed.invalid).toBeUndefined()
    expect(parsed.call).toEqual({ name: 'read', arguments: { file_path: 'src/main.ts' } })
  })

  it('accepts a block whose string values span real lines and keep copied quotes', () => {
    // A real subject (doubao.com) sent exactly this shape for an edit: the
    // old_string carried the file's own lines and its quoted log prefix, and
    // neither the line breaks nor the interior quotes were JSON-escaped.
    const body = [
      '{"name":"edit","arguments":{"file_path":"lua/plugin/service/plugin_manager.lua",',
      '"old_string":"function PluginManager:execute_hook(hook_name, ctx, ...)',
      'local hooks = self.hooks[hook_name]',
      'if not hooks then',
      'Logger:warn("[PluginManager] Unknown hook: " .. hook_name)',
      'return',
      'end",',
      '"new_string":"function PluginManager:execute_hook(hook_name, ctx, ...)',
      'local index = 1"}}',
    ].join('\n')
    const parsed = parseAnswer(reply(body), POLICY)
    expect(parsed.invalid).toBeUndefined()
    expect(parsed.call?.name).toBe('edit')
    const arguments_ = parsed.call?.arguments as { old_string: string; new_string: string }
    expect(arguments_.old_string).toContain('Logger:warn("[PluginManager] Unknown hook: " .. hook_name)')
    expect(arguments_.old_string).toContain('\nlocal hooks = self.hooks[hook_name]')
    expect(parsed.warnings.join('\n')).toMatch(/repaired the call block/u)
  })

  it('accepts a block with both damages: stringified arguments and halved backslashes', () => {
    const policy = { ...POLICY, workspaceRoot: 'D:/work' }
    const parsed = parseAnswer(
      reply(String.raw`{"name":"read","arguments":"{\"file_path\":\"D:\work\src\a.ts\"}"}`),
      policy,
    )
    expect(parsed.invalid).toBeUndefined()
    expect(parsed.call).toEqual({ name: 'read', arguments: { file_path: 'D:\\work\\src\\a.ts' } })
  })

  it('never rewrites a block that is already valid JSON', () => {
    const parsed = parseAnswer(
      reply('{"name":"read","arguments":{"file_path":"D:\\\\work\\\\src\\\\a.ts"}}'),
      { ...POLICY, workspaceRoot: 'D:/work' },
    )
    expect(parsed.invalid).toBeUndefined()
    expect(parsed.call).toEqual({ name: 'read', arguments: { file_path: 'D:\\work\\src\\a.ts' } })
    expect(parsed.warnings).toEqual([])
  })

  it('keeps rejecting text that only looks like a quoted object', () => {
    expect(parseAnswer(reply('“name”:“read”'), POLICY).invalid)
      .toBe('the tool call block carries no JSON object')
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

  it('reads the arguments a reply nested under an alias key', () => {
    const parsed = parseAnswer(reply('{"name":"read","args":{"file_path":"src/main.ts"}}'), POLICY)
    expect(parsed.invalid).toBeUndefined()
    expect(parsed.call).toEqual({ name: 'read', arguments: { file_path: 'src/main.ts' } })
    expect(parsed.warnings.join('\n')).toMatch(/under "args" instead of "arguments"/u)
  })

  it('reads the arguments a reply wrote flat beside the tool name', () => {
    const parsed = parseAnswer(reply('{"name":"read","file_path":"src/main.ts"}'), POLICY)
    expect(parsed.invalid).toBeUndefined()
    expect(parsed.call).toEqual({ name: 'read', arguments: { file_path: 'src/main.ts' } })
    expect(parsed.warnings.join('\n')).toMatch(/flat beside "name"/u)
  })

  it('still rejects a flat call that offers no arguments to read', () => {
    const parsed = parseAnswer(reply('{"name":"read","arguments":["a"],"args":42}'), POLICY)
    expect(parsed.invalid).toBe('tool "read" carries no arguments object')
  })

  it('checks a flat call\u2019s paths against the policy', () => {
    const parsed = parseAnswer(reply('{"name":"read","file_path":"node_modules/x.js"}'), POLICY)
    expect(parsed.call).toBeUndefined()
    expect(parsed.invalid).toContain('forbidden "node_modules"')
  })

  it('accepts a legal call and strips the block from the prose', () => {
    const parsed = parseAnswer(reply('{"name":"read","arguments":{"file_path":"src/main.ts"}}'), POLICY)
    expect(parsed.invalid).toBeUndefined()
    expect(parsed.call).toEqual({ name: 'read', arguments: { file_path: 'src/main.ts' } })
    expect(parsed.text).toBe('here you go')
  })

  it('repairs a native <tool_call> reply whose arguments are array-wrapped and curly-quoted', () => {
    // The exact shape a glm-web turn died on: the model wrote its own
    // tool-call vocabulary instead of the block, twice in one turn.
    const parsed = parseAnswer(
      '继续补齐上下文：<tool_call>read [{“file_path”: “lua/workflow/service/workflow_service.lua”, “offset”: 256, “limit”: 110}]</tool_call>',
      POLICY,
    )
    expect(parsed.invalid).toBeUndefined()
    expect(parsed.suspected).toBeUndefined()
    expect(parsed.cutOff).toBeUndefined()
    expect(parsed.call).toEqual({
      name: 'read',
      arguments: { file_path: 'lua/workflow/service/workflow_service.lua', offset: 256, limit: 110 },
    })
    expect(parsed.warnings.join('\n')).toMatch(/<tool_call>…<\/tool_call> instead of the block/u)
    expect(parsed.text).toBe('继续补齐上下文：')
  })

  it('repairs a plain native <tool_call> reply and strips a trailing END marker from the text', () => {
    const parsed = parseAnswer(
      '<tool_call>read {"file_path":"a.ts"}</tool_call>\n<<<END',
      POLICY,
    )
    expect(parsed.call).toEqual({ name: 'read', arguments: { file_path: 'a.ts' } })
    expect(parsed.text).toBe('')
  })

  it('suspects an unparseable native <tool_call> reply instead of running a guess', () => {
    // The second shape from the same turn: pseudo-attribute body with no
    // JSON object to read — the correction must teach the block format.
    const parsed = parseAnswer(
      '重读文件。<tool_call>read file_path=“a.ts”</arg_value>limit=“2000”</arg_value></tool_call>end',
      POLICY,
    )
    expect(parsed.call).toBeUndefined()
    expect(parsed.suspected).toContain('<tool_call>')
  })

  it('suspects a reply pairing a repairable native call with a second, unclosed one', () => {
    // The dropped-write turn: glm-web paired a repairable native read with an
    // unclosed <tool_call>write whose payload then vanished silently, and the
    // model went on insisting it had saved a file that never landed. The
    // leftover tag must surface as a suspicion so the correction teaches the
    // block format instead of letting the second call disappear.
    const parsed = parseAnswer(
      '关键线索出现：<tool_call>read\n{“file_path”: “lua/init.lua”, “offset”: 720, “limit”: 80}</arg_value></tool_call>调用已确认。'
        + '<tool_call>write\n{“file_path”: “docs/dev/notes/x.md”, “content”: “# 分析\n正文”}\n',
      POLICY,
    )
    expect(parsed.call).toEqual({ name: 'read', arguments: { file_path: 'lua/init.lua', offset: 720, limit: 80 } })
    expect(parsed.suspected).toContain('another call')
  })

  it('suspects a reply carrying two complete native calls and keeps only the first repairable', () => {
    const parsed = parseAnswer(
      '<tool_call>read {"file_path":"a.ts"}</tool_call>继续：<tool_call>write {"file_path":"b.ts","content":"x"}</tool_call>',
      POLICY,
    )
    expect(parsed.call).toEqual({ name: 'read', arguments: { file_path: 'a.ts' } })
    expect(parsed.suspected).toContain('another call')
  })

  it('never repairs a native <tool_call> for a tool outside the whitelist', () => {
    const parsed = parseAnswer('<tool_call>bash {"command":"ls"}</tool_call>', POLICY)
    expect(parsed.call).toBeUndefined()
    expect(parsed.suspected).toContain('<tool_call>')
  })

  it('never repairs a native <tool_call> whose path the policy forbids', () => {
    const parsed = parseAnswer('<tool_call>read {"file_path":"node_modules/x.js"}</tool_call>', POLICY)
    expect(parsed.call).toBeUndefined()
    expect(parsed.suspected).toContain('<tool_call>')
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

describe('parseAnswer typographic repair', () => {
  const policy = {
    allowTools: ['edit', 'write', 'read'],
    denyPaths: ['.git'],
    maxTextChars: 2_000,
    maxToolCallsPerTurn: 1,
  }

  it('folds a rendered en dash back to the double dash a file holds', () => {
    const parsed = parseAnswer(
      formatToolCall({ name: 'edit', arguments: { file_path: 'a.lua', old_string: 'x = 1 – c', new_string: 'x = 2 – c' } }),
      policy,
    )
    expect(parsed.call?.arguments['old_string']).toBe('x = 1 -- c')
    expect(parsed.warnings).toHaveLength(1)
    expect(parsed.warnings[0]).toMatch(/folded 2 typographic/u)
  })

  it('leaves a non-text tool argument alone', () => {
    const parsed = parseAnswer(formatToolCall({ name: 'read', arguments: { file_path: 'a – b.lua' } }), policy)
    expect(parsed.call?.arguments['file_path']).toBe('a – b.lua')
    expect(parsed.warnings).toEqual([])
  })

  it('leaves ASCII text untouched', () => {
    const parsed = parseAnswer(
      formatToolCall({ name: 'edit', arguments: { file_path: 'a.lua', old_string: 'x = 1 -- c', new_string: 'x = 2 -- c' } }),
      policy,
    )
    expect(parsed.warnings).toEqual([])
  })

  it('walks past an argument that is not text', () => {
    const parsed = parseAnswer(
      formatToolCall({ name: 'edit', arguments: { file_path: 'a.lua', old_string: 'x – y', new_string: 'z', offset: 3 } }),
      policy,
    )
    expect(parsed.call?.arguments['offset']).toBe(3)
    expect(parsed.call?.arguments['old_string']).toBe('x -- y')
  })
})

describe('parseAnswer completion marker', () => {
  it('strips the END marker from a final answer', () => {
    const parsed = parseAnswer(`done, nothing to change\n${END_MARKER}\n`, POLICY)
    expect(parsed.text).toBe('done, nothing to change')
    expect(parsed.cutOff).toBeUndefined()
    expect(parsed.suspected).toBeUndefined()
  })

  it('accepts the marker on the same line as the answer', () => {
    const parsed = parseAnswer(`done. ${END_MARKER}`, POLICY)
    expect(parsed.text).toBe('done.')
    expect(parsed.cutOff).toBeUndefined()
  })

  it('flags a blockless reply that ends without the marker', () => {
    const parsed = parseAnswer('把 descr', POLICY)
    expect(parsed.cutOff).toContain(END_MARKER)
    // A cut-off reply is a finding, not a rejection: the caller decides.
    expect(parsed.invalid).toBeUndefined()
  })

  it('does not flag a reply that carries a call block', () => {
    const parsed = parseAnswer(reply('{"name":"read","arguments":{"file_path":"a.ts"}}'), POLICY)
    expect(parsed.cutOff).toBeUndefined()
    expect(parsed.call).toBeDefined()
  })

  it('accepts a final answer whose marker the site mangled to a bare tail', () => {
    // A real subject (doubao.com) ended a complete final answer with `<<` —
    // the reply read as finished, but three fixed characters had become two,
    // and the strict match threw the whole analysis away as cut off.
    const answer = [
      'There is a bug: execute_hook runs a plain loop while process_request cascades.',
      'Do you want me to refactor it?',
      '<<',
    ].join('\n')
    const parsed = parseAnswer(answer, POLICY)
    expect(parsed.cutOff).toBeUndefined()
    expect(parsed.text).toBe([
      'There is a bug: execute_hook runs a plain loop while process_request cascades.',
      'Do you want me to refactor it?',
    ].join('\n'))
    expect(parsed.warnings.join('\n')).toMatch(/damaged END marker/u)
  })

  it('accepts a marker missing one bracket, with or without closing brackets', () => {
    for (const tail of ['<<END', '<<<END>>>', '<<END>>', '<<< end', '<<<end']) {
      const parsed = parseAnswer(`done.\n${tail}`, POLICY)
      expect(parsed.cutOff, tail).toBeUndefined()
      expect(parsed.text, tail).toBe('done.')
      expect(parsed.warnings.join('\n'), tail).toMatch(/damaged END marker/u)
    }
  })

  it('does not warn on the exact marker', () => {
    const parsed = parseAnswer(`done.\n${END_MARKER}`, POLICY)
    expect(parsed.cutOff).toBeUndefined()
    expect(parsed.warnings).toHaveLength(0)
  })

  it('still flags a reply that ends with a single stray bracket', () => {
    const parsed = parseAnswer('done. <', POLICY)
    expect(parsed.cutOff).toContain(END_MARKER)
  })
})

describe('parseAnswer suspected tool narrative', () => {
  it('flags a narrated call copied from the history echoes', () => {
    // A real subject (chatglm.cn) answered a coding turn exactly this way: the
    // read it never ran was narrated as the prompt's own echo format.
    const narrative = [
      '已读：service/condition_evaluator.lua（全文）',
      '[asked for read {"file_path":"service/rule_engine_service.lua"}]',
      'tool(read) -> local log = logger.new(...)',
      '已确认一个实锤 bug，先把 descriptor 翻译部分读完：',
    ].join('\n')
    const parsed = parseAnswer(narrative, POLICY)
    expect(parsed.suspected).toMatch(/asked for/u)
    expect(parsed.cutOff).toContain(END_MARKER)
  })

  it('flags invented tool output rendered with a typographic arrow', () => {
    const parsed = parseAnswer('我先读取 core/rule_engine.lua\ntool(read) → (文件内容省略)', POLICY)
    expect(parsed.suspected).toMatch(/tool\(…\)/u)
  })

  it('flags a bare call JSON outside the block, curly quotes included', () => {
    const parsed = parseAnswer('我来读取配置：{“name”:“read”,“arguments”:{“file_path”:“src/main.ts”}}', POLICY)
    expect(parsed.suspected).toMatch(/bare JSON/u)
  })

  it('leaves a clean prose reply unflagged', () => {
    const parsed = parseAnswer('已读完所有文件，未发现问题。', POLICY)
    expect(parsed.suspected).toBeUndefined()
    expect(parsed.invalid).toBeUndefined()
  })

  it('does not read suspicion into a reply that carries a legal block', () => {
    // The narrative patterns describe how a blockless reply dodges the block;
    // a reply with a valid block has already made its call.
    const parsed = parseAnswer(
      `I will read the file now.\n${formatToolCall({ name: 'read', arguments: { file_path: 'a.ts' } })}`,
      POLICY,
    )
    expect(parsed.suspected).toBeUndefined()
    expect(parsed.call?.name).toBe('read')
  })
})
