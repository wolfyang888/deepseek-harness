/**
 * The wire protocol between the adapter and a site that cannot call functions:
 * one delimiter block per reply, at most one call, JSON arguments only.
 *
 * The delimiter is deliberately not a Markdown fence: sites re-render fences,
 * add copy buttons, and sometimes keep line numbers, all of which corrupt a
 * fenced body, while an unknown token survives as plain text.
 *
 * @module @deepseek-ai/dsh-experimental-llm-chathub/protocol
 */

import type { ChatHubParsePolicy, ChatHubParsedAnswer, ChatHubToolCall } from './types.ts'

/** Opening delimiter of the one call block a reply may carry. */
export const TOOL_CALL_OPEN = '<<<TOOL_CALL'
/** Closing delimiter of that block. */
export const TOOL_CALL_CLOSE = 'TOOL_CALL>>>'

/** Argument keys whose string value addresses the filesystem. */
const PATH_KEY = /(?:^|_)(?:path|paths|file|files|dir|directory|glob|pattern|cwd)$/iu
/** Longest echoed path in a rejection message. */
const MAX_ECHO_CHARS = 80

/**
 * Read one reply into display text plus an optional validated call.
 *
 * A reply is rejected rather than repaired when its block is unterminated, its
 * JSON does not parse, its name is outside the whitelist, or an argument
 * addresses a path the policy forbids. Rejection never throws: the caller
 * decides whether a rejection ends the turn or earns a repair round.
 * @param raw - the site's answer text.
 * @param policy - whitelist, path policy, and text budget of this mount.
 * @returns Display text, the accepted call, and any non-fatal findings.
 */
export function parseAnswer(raw: string, policy: ChatHubParsePolicy): ChatHubParsedAnswer {
  const warnings: string[] = []
  const open = raw.indexOf(TOOL_CALL_OPEN)
  if (open < 0) return { text: boundText(raw, policy.maxTextChars), warnings }
  const close = raw.indexOf(TOOL_CALL_CLOSE, open + TOOL_CALL_OPEN.length)
  if (close < 0) {
    return {
      text: boundText(raw.slice(0, open), policy.maxTextChars),
      invalid: 'the tool call block is not closed with TOOL_CALL>>>',
      warnings,
    }
  }
  const text = boundText(`${raw.slice(0, open)}\n${raw.slice(close + TOOL_CALL_CLOSE.length)}`, policy.maxTextChars)
  const blocks = countBlocks(raw)
  if (blocks > policy.maxToolCallsPerTurn) {
    warnings.push(`kept 1 of ${String(blocks)} call blocks: one reply runs at most ${String(policy.maxToolCallsPerTurn)} call`)
  }
  const body = raw.slice(open + TOOL_CALL_OPEN.length, close)
  const json = jsonObjectAt(body)
  if (json === undefined) {
    return { text, invalid: 'the tool call block carries no JSON object', warnings }
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(json) as Record<string, unknown>
  } catch {
    return { text, invalid: 'the tool call block is not valid JSON', warnings }
  }
  const call = readCall(parsed, policy)
  return typeof call === 'string' ? { text, invalid: call, warnings } : { text, call, warnings }
}

/**
 * Serialize a call the way the prompt documents it, for tests and fixtures.
 * @param call - validated call.
 * @returns The block a compliant model would have written.
 */
export function formatToolCall(call: ChatHubToolCall): string {
  return `${TOOL_CALL_OPEN}\n${JSON.stringify({ name: call.name, arguments: call.arguments })}\n${TOOL_CALL_CLOSE}`
}

/**
 * Count opening delimiters so extra blocks can be reported rather than read.
 * @param raw - the site's answer text.
 * @returns How many opening delimiters the answer carries.
 */
function countBlocks(raw: string): number {
  let count = 0
  let at = raw.indexOf(TOOL_CALL_OPEN)
  while (at >= 0) {
    count += 1
    at = raw.indexOf(TOOL_CALL_OPEN, at + TOOL_CALL_OPEN.length)
  }
  return count
}

/**
 * Cut the first balanced JSON object out of a block body, tolerating noise
 * before and after it.
 * @param body - text between the delimiters.
 * @returns The object source, or `undefined` when no balanced object exists.
 */
function jsonObjectAt(body: string): string | undefined {
  const start = body.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < body.length; index += 1) {
    const char = body.charAt(index)
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return body.slice(start, index + 1)
    }
  }
  return undefined
}

/**
 * Validate the parsed block against the policy.
 * @param parsed - decoded block value.
 * @param policy - whitelist and path policy.
 * @returns The accepted call, or the rejection reason.
 */
function readCall(parsed: Record<string, unknown>, policy: ChatHubParsePolicy): ChatHubToolCall | string {
  const name = parsed['name']
  if (typeof name !== 'string' || name.length === 0) return 'the tool call block has no tool name'
  if (!policy.allowTools.includes(name)) {
    return `tool "${clip(name)}" is not allowed; allowed tools: ${policy.allowTools.join(', ')}`
  }
  const args = parsed['arguments']
  if (!isRecord(args)) return `tool "${clip(name)}" carries no arguments object`
  const path = firstRejectedPath(args, policy)
  return path === undefined ? { name, arguments: args } : path
}

/**
 * Report the first argument that addresses a forbidden path.
 * @param args - validated argument object.
 * @param policy - path policy of this mount.
 * @returns A rejection reason naming the offending value, or `undefined`.
 */
function firstRejectedPath(args: Readonly<Record<string, unknown>>, policy: ChatHubParsePolicy): string | undefined {
  for (const value of pathValues(args)) {
    const reason = rejectPath(value, policy)
    if (reason !== undefined) return reason
  }
  return undefined
}

/**
 * Collect every string an argument key declares to be a filesystem address.
 * @param args - argument object at any depth.
 * @param key - key currently being read.
 * @returns Candidate path strings in argument order.
 */
function pathValues(value: unknown, key = ''): string[] {
  if (typeof value === 'string') return PATH_KEY.test(key) ? [value] : []
  if (Array.isArray(value)) return value.flatMap(item => pathValues(item, key))
  if (isRecord(value)) return Object.entries(value).flatMap(([next, item]) => pathValues(item, next))
  return []
}

/**
 * Decide whether one path argument is addressable.
 * @param value - the raw argument string.
 * @param policy - path policy of this mount.
 * @returns A rejection reason, or `undefined` when the path is allowed.
 */
function rejectPath(value: string, policy: ChatHubParsePolicy): string | undefined {
  if (value.includes('\0')) return `path "${clip(value)}" carries a NUL byte`
  const segments = value.split(/[\\/]+/u).filter(segment => segment.length > 0 && segment !== '.')
  if (segments.includes('..')) return `path "${clip(value)}" leaves the workspace through ".."`
  const denied = segments.find(segment => policy.denyPaths.includes(segment))
  if (denied !== undefined) return `path "${clip(value)}" addresses the forbidden "${denied}"`
  if (policy.workspaceRoot === undefined) return undefined
  const absolute = value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)
  if (!absolute) return undefined
  const root = policy.workspaceRoot.replace(/[\\/]+$/u, '').replace(/\\/gu, '/')
  const target = value.replace(/\\/gu, '/')
  return target === root || target.startsWith(`${root}/`) ? undefined : `path "${clip(value)}" is outside ${root}`
}

/**
 * @param value - decoded JSON value.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Shorten a value for a rejection message so a hostile reply cannot bloat a log.
 * @param value - arbitrary argument text.
 * @returns The value, ellipsized past {@link MAX_ECHO_CHARS}.
 */
function clip(value: string): string {
  return value.length <= MAX_ECHO_CHARS ? value : `${value.slice(0, MAX_ECHO_CHARS - 1)}…`
}

/**
 * @param text - candidate display text.
 * @param max - configured ceiling.
 * @returns The text, ellipsized past the ceiling.
 */
function boundText(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, Math.max(0, max - 1))}…`
}
