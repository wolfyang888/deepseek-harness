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

/**
 * Fit one text into a character budget by dropping its middle.
 * @param text - candidate text of any length.
 * @param max - configured ceiling; values at or below zero keep nothing.
 * @returns The text unchanged when it fits, else head, marker, and tail.
 */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 0) return ''
  const head = Math.floor(max * HEAD_RATIO)
  const tail = Math.floor(max * TAIL_RATIO)
  const omitted = text.length - head - tail
  const marker = `\n[omitted ${String(omitted)} chars; re-read with offset and limit]\n`
  // A budget too small for head, marker, and tail degrades to a plain cut so
  // the caller still sees the beginning of what it asked for.
  if (head + marker.length + tail > max) return text.slice(0, max)
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`
}
