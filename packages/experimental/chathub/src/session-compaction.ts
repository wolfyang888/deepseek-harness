/** LLM-driven session compaction: the current model condenses its own conversation into a reusable checkpoint. */

import { errorMessage } from './errors.ts'
import { SessionMemoryService, type MemoryCompactionOptions } from './session-memory.ts'
import type { SessionTimelineService } from './timeline.ts'
import type { ChatRequest, ChatSessionRecord, IModelProvider } from './types.ts'

/**
 * The checkpoint instruction, adapted from the harness compaction family:
 * the signed-in site keeps the full conversation, so the instruction alone
 * makes the model condense everything above it into a structured checkpoint
 * the next turns (and the next model, after a switch) can build on.
 */
export const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this conversation. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Facts and Conclusions',
  '- [facts established, conclusions reached, and values decided so far]',
  '',
  '## Errors and Fixes',
  '- [what failed, why, and how it was resolved, plus any user corrections]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this point]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this compaction request or that the context was condensed.',
  '- If the conversation already contains a prior checkpoint, do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into one consolidated summary.',
  '- Output only the checkpoint text.',
].join('\n')

/** Default trigger: compact once the transcript reaches this many stored messages. */
const DEFAULT_MAX_MESSAGES = 30

/** Default cooldown: recompact only after this many more messages since the last compaction. */
const DEFAULT_MIN_GAP = 10

/** Default bounds applied to the session memory after each compaction merge. */
const DEFAULT_BOUNDS: MemoryCompactionOptions = {
  maxEntries: 50,
  maxWorkingMemory: 12,
  maxToolResults: 8,
  maxModelSwitches: 10,
}

/** Thresholds for the automatic compaction trigger. */
export interface AutoCompactionOptions {
  /** Stored-message count that enables compaction. */
  maxMessages?: number
  /** Minimum messages since the last compaction before it may run again. */
  minGap?: number
  /** Bounds applied to session memory after each merge. */
  bounds?: MemoryCompactionOptions
}

/** One parsed checkpoint: the facts, decisions, and next actions worth carrying. */
export interface CompactionCheckpoint {
  facts: string[]
  decisions: string[]
  workingMemory: string[]
}

/** Which checkpoint section feeds which semantic-context collection. */
const SECTION_ROUTES: ReadonlyArray<{ section: string; target: keyof CompactionCheckpoint }> = [
  { section: 'Primary Request and Intent', target: 'facts' },
  { section: 'Key Facts and Conclusions', target: 'facts' },
  { section: 'Errors and Fixes', target: 'facts' },
  { section: 'Pending Jobs', target: 'workingMemory' },
  { section: 'Current Work', target: 'workingMemory' },
  { section: 'Next Step', target: 'workingMemory' },
  { section: 'Critical Context', target: 'decisions' },
]

/** Known section names, keyed by lower-case title. */
const SECTION_TARGETS = new Map(SECTION_ROUTES.map(route => [route.section.toLowerCase(), route.target]))

/** Markdown heading marker, e.g. `## ` or `#### `. */
const HEADING_MARKER = /^#{1,6}\s+/

/** Markdown list marker a site may keep in extracted text. */
const LIST_MARKER = /^[-*+]\s+/

/** Filler a model writes for a section it has nothing to add to. */
const EMPTY_MARKER = /^\(?(none|n\/a)\)?(\s+reported)?\.?$/i

/**
 * Read one answer line as a checkpoint heading.
 *
 * A browser site renders `## Title` as an HTML heading and its list items as
 * `<li>`, so the extracted answer carries `Title` and bare lines instead of the
 * markers the instruction asked for; a plain-text answer may instead use
 * `**Title**` or `Title:`. All four forms route. A decorated line whose title
 * is not a known section closes the current section; an undecorated line that
 * merely resembles a title stays content, so a sentence never retargets the
 * lines below it.
 * @param line - One trimmed answer line.
 * @returns The section target, `null` for a closing decoration, or undefined
 * when the line is content.
 */
function headingOf(line: string): keyof CompactionCheckpoint | null | undefined {
  if (LIST_MARKER.test(line)) return undefined
  const decorated = HEADING_MARKER.test(line) || /^\*\*.+\*\*$/.test(line) || line.endsWith(':')
  const title = line
    .replace(HEADING_MARKER, '')
    .replace(/:\s*$/, '')
    .replace(/^[*_\s]+|[*_\s]+$/g, '')
    .trim()
  const known = SECTION_TARGETS.get(title.toLowerCase())
  if (known !== undefined) return known
  return decorated ? null : undefined
}

/**
 * Parse a model-produced checkpoint into semantic-context collections.
 * @param markdown - The model's checkpoint answer.
 * @returns Bullets routed by section; sections the model skipped stay empty.
 */
export function parseCheckpoint(markdown: string): CompactionCheckpoint {
  const checkpoint: CompactionCheckpoint = { facts: [], decisions: [], workingMemory: [] }
  let target: keyof CompactionCheckpoint | undefined
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim()
    const heading = headingOf(line)
    if (heading !== undefined) {
      target = heading ?? undefined
      continue
    }
    if (target === undefined || line === '') continue
    const bullet = line.replace(LIST_MARKER, '').trim()
    if (bullet === '' || EMPTY_MARKER.test(bullet)) continue
    checkpoint[target].push(bullet)
  }
  return checkpoint
}

/**
 * Merge a parsed checkpoint into the session's curated context and prune the
 * older memory, then stamp the compaction position.
 * @param record - Session to update in place.
 * @param checkpoint - Parsed checkpoint bullets.
 * @param options - Timestamp, stored-message count, and memory bounds.
 */
export function mergeCheckpoint(
  record: ChatSessionRecord,
  checkpoint: CompactionCheckpoint,
  options: { now: number; messageCount: number; bounds: MemoryCompactionOptions },
): void {
  record.context.facts = [...new Set([...record.context.facts, ...checkpoint.facts])]
  record.context.decisions = [...new Set([...record.context.decisions, ...checkpoint.decisions])]
  record.context.workingMemory = [...new Set([...record.context.workingMemory, ...checkpoint.workingMemory])]
  new SessionMemoryService({ now: () => options.now }).compact(record, options.bounds)
  record.lastAutoCompaction = { at: options.now, messageCount: options.messageCount }
  record.updatedAt = options.now
}

/** Compaction outcome flag: whether the session context was refreshed. */
export type CompactionResult = 'compacted' | 'skipped' | 'failed'

/** Runs the current provider as the session's own compaction engine. */
export class SessionCompactionService {
  private readonly timeline: SessionTimelineService
  private readonly now: () => number
  private readonly maxMessages: number
  private readonly minGap: number
  private readonly bounds: MemoryCompactionOptions

  /**
   * @param options - Trigger thresholds, memory bounds, timeline, and optional clock override.
   */
  constructor(options: AutoCompactionOptions & { timeline: SessionTimelineService; now?: () => number }) {
    this.timeline = options.timeline
    this.now = options.now ?? Date.now
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES
    this.minGap = options.minGap ?? DEFAULT_MIN_GAP
    this.bounds = options.bounds ?? DEFAULT_BOUNDS
  }

  /**
   * Report whether the transcript has grown enough to deserve a compaction turn.
   * @param record - Session to inspect.
   * @param messageCount - Stored user+assistant messages of the session.
   * @returns `true` when the threshold is met and the cooldown has passed.
   */
  shouldRun(record: ChatSessionRecord, messageCount: number): boolean {
    if (messageCount < this.maxMessages) return false
    const lastAt = record.lastAutoCompaction?.messageCount ?? 0
    return messageCount - lastAt >= this.minGap
  }

  /**
   * Ask the current model to condense the conversation and merge the checkpoint.
   * Best-effort: a failed compaction turn never blocks the real turn that follows.
   * @param record - Session to compact in place.
   * @param provider - Current provider; its site conversation carries the history.
   * @param messageCount - Stored-message count the compaction covers.
   * @returns `compacted` when the context was refreshed, `failed` otherwise.
   */
  async run(record: ChatSessionRecord, provider: IModelProvider, messageCount: number): Promise<CompactionResult> {
    const at = this.now()
    const request: ChatRequest = {
      sessionId: record.id,
      providerId: provider.id,
      messages: [{ role: 'user', content: COMPACTION_INSTRUCTION, timestamp: at }],
    }
    try {
      const response = await provider.sendMessage(request)
      const checkpoint = parseCheckpoint(response.content)
      const bullets = checkpoint.facts.length + checkpoint.decisions.length + checkpoint.workingMemory.length
      if (bullets === 0) {
        this.timeline.record(record, {
          kind: 'status',
          provider: provider.id,
          detail: 'compaction skipped: the answer carried no checkpoint sections',
        })
        return 'skipped'
      }
      mergeCheckpoint(record, checkpoint, { now: at, messageCount, bounds: this.bounds })
      this.timeline.record(record, {
        kind: 'status',
        provider: provider.id,
        detail: `compacted at ${messageCount} messages`,
      })
      return 'compacted'
    } catch (error) {
      this.timeline.record(record, {
        kind: 'status',
        provider: provider.id,
        detail: `compaction failed: ${errorMessage(error)}`,
      })
      return 'failed'
    }
  }
}
