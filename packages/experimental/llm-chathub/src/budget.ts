/**
 * Character budgets: one tool result inside a prompt, and the prompt itself.
 *
 * The site gives no token accounting and silently truncates long input, so the
 * adapter bounds text before it leaves the process. Trimming keeps both ends —
 * a file's header names it, its tail usually holds the change under review —
 * and states how much was dropped so the model can re-read with an offset.
 *
 * @module @deepseek-ai/dsh-experimental-llm-chathub/budget
 */

/** Share of a clamped text kept from the head. */
const HEAD_RATIO = 0.6
/** Share of a clamped text kept from the tail. */
const TAIL_RATIO = 0.3

/** A numbered result line, global for `matchAll` scans, which clone it per call. */
const NUMBERED_LINE = /^[ \t]*(\d+): /gmu

/**
 * Join head and tail around one marker; a budget too small for all three
 * degrades to a plain cut so the caller still sees the beginning.
 * @param text - candidate text of any length.
 * @param max - configured ceiling.
 * @param marker - the omission line between head and tail.
 * @returns The fitted text.
 */
function fitWithMiddle(text: string, max: number, marker: string): string {
  const head = Math.floor(max * HEAD_RATIO)
  const tail = Math.floor(max * TAIL_RATIO)
  if (head + marker.length + tail > max) return text.slice(0, max)
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`
}

/**
 * Fit one text into a character budget by dropping its middle.
 * @param text - candidate text of any length.
 * @param max - configured ceiling; values at or below zero keep nothing.
 * @returns The text unchanged when it fits, else head, marker, and tail.
 */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 0) return ''
  const omitted = text.length - Math.floor(max * HEAD_RATIO) - Math.floor(max * TAIL_RATIO)
  return fitWithMiddle(text, max, `\n[omitted ${String(omitted)} chars; re-read with offset and limit]\n`)
}

/**
 * Fit one tool result into a character budget, naming the omitted line range
 * when the result carries line numbers.
 *
 * The fs `read` result is a numbered envelope, so the model can page through
 * the dropped middle with the `read` tool's own `offset`/`limit` window: the
 * marker states the exact line numbers to resume from instead of a bare
 * character count it cannot act on. Results without line numbers keep the
 * generic marker.
 * @param text - tool result text of any length.
 * @param max - configured ceiling; values at or below zero keep nothing.
 * @returns The text unchanged when it fits, else head, marker, and tail.
 */
export function clampToolResult(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 0) return ''
  const head = Math.floor(max * HEAD_RATIO)
  const tail = Math.floor(max * TAIL_RATIO)
  const omitted = text.length - head - tail
  const after = lastNumberedLine(text.slice(0, head))
  const before = after === undefined ? undefined : firstNumberedLineAfter(text.slice(text.length - tail), after)
  const marker = after !== undefined && before !== undefined && before > after + 1
    ? `\n[omitted ${String(omitted)} chars, file lines ${String(after + 1)}-${String(before - 1)}; call read again with offset=${String(after + 1)} and a limit to see them]\n`
    : `\n[omitted ${String(omitted)} chars; re-read with offset and limit]\n`
  return fitWithMiddle(text, max, marker)
}

/**
 * @param chunk - text that may carry numbered result lines.
 * @returns The last line number it carries, or `undefined` when it carries none.
 */
function lastNumberedLine(chunk: string): number | undefined {
  let last: RegExpExecArray | undefined
  for (const match of chunk.matchAll(NUMBERED_LINE)) last = match
  return last === undefined ? undefined : Number(last[1])
}

/**
 * @param chunk - text that may carry numbered result lines.
 * @param after - the last line number the kept head showed.
 * @returns The first line number past `after` it carries. A number prefix the
 *   tail cut can only shrink, so a match at or below `after` is that cut, not
 *   a line to resume from; `undefined` when none qualifies.
 */
function firstNumberedLineAfter(chunk: string, after: number): number | undefined {
  for (const match of chunk.matchAll(NUMBERED_LINE)) {
    if (Number(match[1]) > after) return Number(match[1])
  }
  return undefined
}
