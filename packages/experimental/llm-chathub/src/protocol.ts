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
/**
 * Completion marker a blockless reply must end with, so a reply the site cut
 * off mid-stream is distinguishable from one the model finished.
 */
export const END_MARKER = '<<<END'

/**
 * Narrative tool-call shapes a reply uses to dodge the block format, each with
 * the repair reason it yields. Every shape was a real subject's answer: the
 * history echoes the prompt renders (`[asked for …]`, `tool(…) ->`) copied into
 * a reply as if they executed, a whole call written as bare JSON, and the
 * model's own tool-call vocabulary — GLM answered `<tool_call>read …
 * </tool_call>` twice in one turn when a long edit task wore the documented
 * format down.
 */
const SUSPECTED_NARRATIVE: readonly (readonly [RegExp, string])[] = [
  [/\[asked for \w+[ \]]/u, 'the reply narrates a tool call as "[asked for …]" instead of using the block'],
  [/\btool\(\w+\)\s*(?:->|→)/u, 'the reply invents tool output as "tool(…) ->" instead of using the block'],
  [/\{\s*[“"]name[”"]\s*:\s*[“"][\w-]+[”"]\s*,\s*[“"]arguments[”"]/u,
    'the reply writes a tool call as bare JSON outside the block'],
  [/<\s*\/?\s*tool_call\s*>/u,
    'the reply writes the call in "<tool_call>…</tool_call>" tags instead of using the block'],
]

/**
 * Read one reply into display text plus an optional validated call.
 *
 * A reply is rejected rather than repaired when its block is unterminated, its
 * JSON does not parse, its name is outside the whitelist, or an argument
 * addresses a path the policy forbids. Rejection never throws: the caller
 * decides whether a rejection ends the turn or earns a repair round. A
 * blockless reply additionally reports whether it ended with the
 * {@link END_MARKER} and whether it narrates a tool call in prose; both are
 * findings the caller may enforce, not rejections.
 * @param raw - the site's answer text.
 * @param policy - whitelist, path policy, and text budget of this mount.
 * @returns Display text, the accepted call, and any non-fatal findings.
 */
export function parseAnswer(raw: string, policy: ChatHubParsePolicy): ChatHubParsedAnswer {
  const warnings: string[] = []
  const open = raw.indexOf(TOOL_CALL_OPEN)
  if (open < 0) {
    const native = repairedNativeCall(raw, policy, warnings)
    if (native !== undefined) return native
    const suspicion = suspectedToolNarrative(raw)
    const { text, ended, damaged } = finalTextOf(raw)
    if (damaged === true) {
      warnings.push('accepted a damaged END marker: the reply ended with a mangled form of <<<END')
    }
    return {
      text: boundText(text, policy.maxTextChars),
      warnings,
      ...suspicion === undefined ? {} : { suspected: suspicion },
      ...ended ? {} : { cutOff: `the reply ends without the ${END_MARKER} completion marker, so it may be cut off` },
    }
  }
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
  const decoded = decodeBlock(body)
  if (decoded.repaired === true) {
    warnings.push('repaired the call block before parsing: quotes, backslashes, or line breaks the site damaged were folded back')
  }
  if (decoded.parsed === undefined) {
    return {
      text,
      invalid: decoded.found
        ? 'the tool call block is not valid JSON'
        : 'the tool call block carries no JSON object',
      warnings,
    }
  }
  const call = readCall(decoded.parsed, policy, warnings)
  if (typeof call === 'string') return { text, invalid: call, warnings }
  return { text, call: repairArguments(call, warnings), warnings }
}

/**
 * END-marker tails a reply may still count as complete with.
 *
 * A subject types the marker from the protocol text, but the site between the
 * model and the reader can mangle it: a DOM serializer eats one `<`, a
 * renderer folds the spaces, or the model itself mistypes the run. Doubao
 * ended a full, final answer with a bare `<<` — everything before it read as
 * finished — so the tails below keep the marker's evidence while tolerating
 * the damage a transport can do to three fixed characters. The bare-tail
 * pattern only fires at the very end of a blockless reply: prose that merely
 * contains `<` never matches, and an unterminated call block takes the
 * block path before this runs.
 */
const END_TAILS: readonly RegExp[] = [
  /<{2,3}\s*end\s*>+\s*$/iu,
  /<{2,3}\s*end$/iu,
  /<{2,3}\s*$/,
]

/**
 * Strip the completion marker from a blockless reply.
 * @param raw - the site's answer text.
 * @returns The text without its trailing marker, whether the marker counted,
 *   and whether what matched was a damaged spelling rather than the exact
 *   `<<<END`.
 */
function finalTextOf(raw: string): { text: string; ended: boolean; damaged?: boolean } {
  const trimmed = raw.trimEnd()
  for (const tail of END_TAILS) {
    const match = tail.exec(trimmed)
    if (match === null) continue
    const damaged = match[0] !== END_MARKER
    return { text: trimmed.slice(0, match.index).trimEnd(), ended: true, ...damaged ? { damaged } : {} }
  }
  return { text: raw, ended: false }
}

/**
 * Read the narrative tool-call shapes a reply carries.
 * @param text - the site's answer text.
 * @returns The first matching reason, or `undefined` for a clean reply.
 */
function suspectedToolNarrative(text: string): string | undefined {
  for (const [pattern, reason] of SUSPECTED_NARRATIVE) {
    if (pattern.test(text)) return reason
  }
  return undefined
}

/** Opening tag of a model's native tool-call vocabulary. */
const NATIVE_OPEN = /<\s*tool_call\s*>/iu
/** Closing tag of that vocabulary. */
const NATIVE_CLOSE = /<\s*\/\s*tool_call\s*>/iu
/** Bare tool name a native call body opens with. */
const NATIVE_NAME = /^[\s[({]*([A-Za-z][\w-]*)/u

/**
 * Repair a call a reply wrote in its native `<tool_call>…</tool_call>`
 * vocabulary instead of the block.
 *
 * GLM drifts into this shape on long edit tasks: the body carries the tool
 * name as a bare word followed by its arguments as JSON — sometimes wrapped
 * in an array, sometimes curly-quoted, the same damages the block repairs.
 * The call is accepted only when every check a block call passes passes here
 * too (whitelist, path policy); anything else is left to the narrative
 * suspicion, which teaches the block format instead of executing a guess.
 * @param raw - the site's answer text.
 * @param policy - whitelist and path policy.
 * @param warnings - sink for the non-fatal repair.
 * @returns The accepted call with the tags stripped from the text, or
 *   `undefined` when the native body offers nothing safe to run.
 */
function repairedNativeCall(
  raw: string,
  policy: ChatHubParsePolicy,
  warnings: string[],
): ChatHubParsedAnswer | undefined {
  const openMatch = NATIVE_OPEN.exec(raw)
  if (openMatch === null) return undefined
  const closeMatch = NATIVE_CLOSE.exec(raw)
  if (closeMatch === null || closeMatch.index < openMatch.index) return undefined
  const body = raw.slice(openMatch.index + openMatch[0].length, closeMatch.index)
  const nameMatch = NATIVE_NAME.exec(body)
  if (nameMatch === null) return undefined
  const name = nameMatch[1] ?? ''
  if (!policy.allowTools.includes(name)) return undefined
  let rest = body.slice(nameMatch[0].length).trim()
  if (rest.startsWith('[') && rest.endsWith(']')) rest = rest.slice(1, -1).trim()
  const args = decodeJsonObject(rest)
  if (args === undefined) return undefined
  if (firstRejectedPath(args, policy) !== undefined) return undefined
  warnings.push('repaired the call the reply wrote as <tool_call>…</tool_call> instead of the block')
  const joined = `${raw.slice(0, openMatch.index)}\n${raw.slice(closeMatch.index + closeMatch[0].length)}`
  const { text } = finalTextOf(joined)
  return { text: boundText(text.trim(), policy.maxTextChars), call: { name, arguments: args }, warnings }
}

/** Argument keys whose string value addresses the filesystem. */
const PATH_KEY = /(?:^|_)(?:path|paths|file|files|dir|directory|glob|pattern|cwd)$/iu
/** Longest echoed path in a rejection message. */
const MAX_ECHO_CHARS = 80

/** Tools whose string arguments are file text, where ASCII spelling matters. */
const TEXT_TOOLS: ReadonlySet<string> = new Set(['edit', 'write'])

/** Typographic characters a site's Markdown pass substitutes, and their ASCII source. */
const TYPOGRAPHY_FOLDS: Readonly<Record<string, string>> = {
  '\u00a0': ' ', // no-break space pasted from rendered prose
  '\u2013': '--', // en dash: Markdown renders `--` this way
  '\u2014': '--', // em dash: the same pass, for a longer run of dashes
}
const TYPOGRAPHY_FOLD = /[\u00a0\u2013\u2014]/gu

/**
 * Fold typographic substitutions back to the ASCII the file really holds.
 *
 * Answers are read out of the site's rendered DOM, and a Markdown renderer
 * turns `--` (a Lua comment, a CLI flag, a SQL comment) into an en dash. A
 * model that copies the line it was shown therefore sends an `old_string` that
 * no file contains. Only file-text tools are repaired, only these characters
 * are folded, and every fold is reported, so a repair is never silent.
 * @param call - the accepted call.
 * @param warnings - sink for the non-fatal finding.
 * @returns The call with its string arguments folded.
 */
function repairArguments(call: ChatHubToolCall, warnings: string[]): ChatHubToolCall {
  if (!TEXT_TOOLS.has(call.name)) return call
  let folds = 0
  const fold = (value: string): string => value.replace(TYPOGRAPHY_FOLD, (char) => {
    folds += 1
    return TYPOGRAPHY_FOLDS[char] ?? char
  })
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return fold(value)
    if (Array.isArray(value)) return value.map(item => walk(item))
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]))
    return value
  }
  const arguments_ = walk(call.arguments) as Readonly<Record<string, unknown>>
  if (folds > 0) {
    warnings.push(`folded ${String(folds)} typographic character(s) in "${call.name}" arguments back to ASCII`)
  }
  return { name: call.name, arguments: arguments_ }
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
 * Quote characters an IME or a site's rich-text pass substitutes for ASCII
 * quotes, mapped back to the character JSON requires.
 */
const QUOTE_FOLD = /[\u201c\u201d\u201e\u201f\u2018\u2019\u201a\u201b]/gu
const QUOTE_FOLDS: Readonly<Record<string, string>> = {
  '\u201c': '"',
  '\u201d': '"',
  '\u201e': '"',
  '\u201f': '"',
  '\u2018': "'",
  '\u2019': "'",
  '\u201a': "'",
  '\u201b': "'",
}

/**
 * Decode the JSON object a block body carries.
 *
 * A reply typed through a Chinese IME arrives with curly quotes — a real
 * subject wrote `{“name”:“grep”}` — a site's render pass can halve the
 * backslashes of a Windows path, and an argument that carries file text spans
 * real lines with the copied code's own quotes, so the body needs every one
 * of these repairs before strict JSON accepts it. The literal text is tried
 * first so a well-formed block is never rewritten, and each repair is only
 * accepted when its output parses.
 * @param body - text between the block delimiters.
 * @returns Whether an object was found, and its value when it parsed.
 */
function decodeBlock(body: string): { found: boolean; parsed?: Record<string, unknown>; repaired?: boolean } {
  let found = false
  for (const [index, source] of candidatesOf(body).entries()) {
    const json = jsonObjectAt(source)
    if (json === undefined) continue
    found = true
    const parsed = parseObject(json)
    if (parsed !== undefined) return { found: true, parsed, ...index > 0 ? { repaired: true } : {} }
  }
  return { found }
}

/**
 * Every reading of a JSON-carrying text, literal first, then each repair.
 * @param text - block body, or an `arguments` value that arrived as a string.
 * @returns Sources to try in order; a well-formed one is never rewritten.
 */
function candidatesOf(text: string): readonly string[] {
  const foldQuotes = text.replace(QUOTE_FOLD, char => QUOTE_FOLDS[char] ?? char)
  const escaped = [repairEscapes(text), repairEscapes(foldQuotes)]
  const rawString = [repairRawStrings(text), repairRawStrings(foldQuotes)]
  return [
    text,
    foldQuotes,
    ...escaped,
    ...rawString,
    ...rawString.map(repairEscapes),
  ]
}

/**
 * Decode the first JSON object a text carries, through every repair channel.
 * @param text - block body, or an `arguments` value that arrived as a string.
 * @returns The decoded object, or `undefined` when no repair yields one.
 */
function decodeJsonObject(text: string): Record<string, unknown> | undefined {
  for (const source of candidatesOf(text)) {
    const json = jsonObjectAt(source)
    if (json === undefined) continue
    const parsed = parseObject(json)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/** One character class JSON permits after a backslash inside a string. */
const JSON_ESCAPE_NEXT = /^["\\/bfnrtu]$/u

/**
 * Repair backslashes a site's render pass halved: a Windows path arrives as
 * `D:\work` where `\w` is not a JSON escape. Every backslash that does not
 * open a valid escape is doubled, so valid JSON is never rewritten — the
 * literal source is always tried before its repaired form.
 * @param source - candidate JSON text.
 * @returns The source with stray backslashes escaped.
 */
function repairEscapes(source: string): string {
  let out = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index)
    if (char !== '\\') {
      out += char
      continue
    }
    const next = source.charAt(index + 1)
    if (JSON_ESCAPE_NEXT.test(next)) {
      out += char + next
      index += 1
    } else {
      out += '\\\\'
    }
  }
  return out
}

/**
 * Escape the raw characters a multi-line block body carries inside strings.
 *
 * A model that pastes file text into an argument writes the JSON the way a
 * human would: the string spans real lines and the quoted fragments of the
 * copied code keep their own double quotes — `Logger:warn("[PluginManager] …")`
 * — and both are illegal inside a JSON string, so strict parsing rejects a
 * block whose intent is perfectly clear. Every newline inside a string becomes
 * `\n`, and a quote becomes `\"` unless what follows it (whitespace skipped)
 * is a JSON structural character, which reads as the string's real end.
 * The candidate is only accepted when it parses, so a mis-guessed quote can
 * never corrupt an otherwise valid reading.
 * @param source - candidate JSON text.
 * @returns The source with raw line breaks and interior quotes escaped.
 */
function repairRawStrings(source: string): string {
  let out = ''
  let inString = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index)
    if (!inString) {
      if (char === '"') inString = true
      out += char
      continue
    }
    if (char === '\\') {
      const next = source.charAt(index + 1)
      if (next === '') {
        out += '\\\\'
        continue
      }
      out += char + next
      index += 1
      continue
    }
    if (char === '"') {
      let ahead = index + 1
      while (ahead < source.length && /\s/u.test(source.charAt(ahead))) ahead += 1
      const following = ahead < source.length ? source.charAt(ahead) : ''
      if (following === '' || ',:}]'.includes(following)) {
        inString = false
        out += char
      } else {
        out += '\\"'
      }
      continue
    }
    if (char === '\n') {
      out += '\\n'
      continue
    }
    if (char === '\r') {
      out += '\\r'
      continue
    }
    if (char === '\t') {
      out += '\\t'
      continue
    }
    out += char
  }
  return out
}

/**
 * @param json - balanced object source.
 * @returns The decoded object, or `undefined` when it is not a JSON object.
 */
function parseObject(json: string): Record<string, unknown> | undefined {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return undefined
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
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
 * Keys a reply may nest the arguments under besides the documented
 * `arguments` — a model that half-remembers the block format reaches for one
 * of these spellings before it gives up.
 */
const ARGUMENT_KEYS: readonly string[] = ['arguments', 'args', 'parameters', 'params']

/**
 * Validate the parsed block against the policy.
 *
 * A reply that nests no arguments object is repaired before it is rejected:
 * the arguments may sit under an alias key (`args`, `parameters`, `params`),
 * or flat beside the tool name (`{"name":"read","file_path":…}` — the shape a
 * model writes when it flattens the call the way prose would). Every repair is
 * reported; a block that offers nothing to read is still rejected, because
 * guessing arguments the model never stated would invent a call.
 * @param parsed - decoded block value.
 * @param policy - whitelist and path policy.
 * @param warnings - sink for the non-fatal repairs.
 * @returns The accepted call, or the rejection reason.
 */
function readCall(
  parsed: Record<string, unknown>,
  policy: ChatHubParsePolicy,
  warnings: string[],
): ChatHubToolCall | string {
  const name = parsed['name']
  if (typeof name !== 'string' || name.length === 0) return 'the tool call block has no tool name'
  if (!policy.allowTools.includes(name)) {
    return `tool "${clip(name)}" is not allowed; allowed tools: ${policy.allowTools.join(', ')}`
  }
  // A site that serializes tools itself sends `arguments` as a JSON string —
  // `{"name":"glob","arguments":"{\"pattern\":…}"}` — so a string is decoded
  // through the same repair channels before it is rejected.
  let decoded = decodeArguments(parsed['arguments'])
  if (decoded === undefined) {
    for (const key of ARGUMENT_KEYS) {
      if (key === 'arguments') continue
      const candidate = decodeArguments(parsed[key])
      if (candidate === undefined) continue
      decoded = candidate
      warnings.push(`read the arguments under "${key}" instead of "arguments"`)
      break
    }
  }
  if (decoded === undefined) {
    const flat = flatArgumentsOf(parsed)
    if (flat !== undefined) {
      decoded = flat
      warnings.push('read the arguments the reply wrote flat beside "name" instead of nested under "arguments"')
    }
  }
  if (decoded === undefined) return `tool "${clip(name)}" carries no arguments object`
  const path = firstRejectedPath(decoded, policy)
  return path === undefined ? { name, arguments: decoded } : path
}

/**
 * Read the arguments a reply wrote flat beside the tool name.
 * @param parsed - decoded block value.
 * @returns The non-`name`, non-alias keys as an arguments object, or
 *   `undefined` when nothing is left to read.
 */
function flatArgumentsOf(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  const flat: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'name' || ARGUMENT_KEYS.includes(key)) continue
    flat[key] = value
  }
  return Object.keys(flat).length === 0 ? undefined : flat
}

/**
 * Decode one candidate arguments value.
 * @param value - the value an `arguments`-shaped key carried.
 * @returns The arguments object, or `undefined` when the value is neither an
 *   object nor a decodable string.
 */
function decodeArguments(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : typeof value === 'string' ? decodeJsonObject(value) : undefined
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
