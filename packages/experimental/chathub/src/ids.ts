/** Date-stamped identifiers for ChatHub sessions, checkpoints, and memory entries. */

/**
 * Render a UTC calendar day as `yyyyMMdd`.
 * @param at - Epoch milliseconds.
 * @returns Eight-digit date stamp.
 */
export function formatDateStamp(at: number): string {
  const date = new Date(at)
  const year = String(date.getUTCFullYear()).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/**
 * Create a session identifier in the `sess_yyyyMMdd_xxx` form.
 * @param at - Epoch milliseconds of creation.
 * @param sequence - Creation order, padded to three digits.
 * @returns Session identifier.
 */
export function createSessionId(at: number, sequence: number): string {
  return `sess_${formatDateStamp(at)}_${padSequence(sequence)}`
}

/**
 * Create a checkpoint identifier in the `cp_yyyyMMdd_xxx` form.
 * @param at - Epoch milliseconds of creation.
 * @param sequence - Creation order, padded to three digits.
 * @returns Checkpoint identifier.
 */
export function createCheckpointId(at: number, sequence: number): string {
  return `cp_${formatDateStamp(at)}_${padSequence(sequence)}`
}

/**
 * Create a memory-entry identifier in the `mem_yyyyMMdd_xxx` form.
 * @param at - Epoch milliseconds of creation.
 * @param sequence - Creation order, padded to three digits.
 * @returns Memory-entry identifier.
 */
export function createMemoryEntryId(at: number, sequence: number): string {
  return `mem_${formatDateStamp(at)}_${padSequence(sequence)}`
}

/**
 * Create a timeline-entry identifier in the `tl_yyyyMMdd_xxx` form.
 * @param at - Epoch milliseconds of the event.
 * @param sequence - Event order within the session, padded to three digits.
 * @returns Timeline-entry identifier.
 */
export function createTimelineEntryId(at: number, sequence: number): string {
  return `tl_${formatDateStamp(at)}_${padSequence(sequence)}`
}

function padSequence(sequence: number): string {
  return String(sequence).padStart(3, '0')
}
