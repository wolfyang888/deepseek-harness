/**
 * Configuration, protocol vocabulary, and observability records of the ChatHub
 * LLM adapter.
 *
 * The adapter treats a signed-in web chat site as a text-only model: one reply
 * carries at most one tool call, serialized as a delimiter block. Everything
 * the site cannot express natively — tool schemas, history, budgets — is
 * rendered into a single self-contained prompt per request.
 *
 * @module @deepseek-ai/dsh-experimental-llm-chathub/types
 */

import type { WebChatPayload } from '@deepseek-ai/dsh-experimental-chathub'

/** Stable failure codes this adapter raises; each maps to one harness reaction. */
export const CHATHUB_LLM_AUTH_CODE = 'AUTH'
/** The page answered, but the reply could not be parsed into a legal answer. */
export const CHATHUB_LLM_MALFORMED_CODE = 'MALFORMED_RESPONSE'
/** The rendered request cannot fit the declared prompt budget. */
export const CHATHUB_LLM_OVERFLOW_CODE = 'CONTEXT_WINDOW_EXCEEDED'
/** The site answered with a status the transport classifies as transport/UI failure. */
export const CHATHUB_LLM_TRANSPORT_CODE = 'TRANSPORT'

/**
 * What this route does with a request that declares an auxiliary purpose.
 *
 * A browser turn costs one whole site conversation and one model round trip on
 * the user's own account, and an auxiliary prompt carries neither the tool
 * schemas nor the conversation, so sending one here spends a page and returns
 * an answer the caller cannot use. Refusing keeps the route for the work it was
 * mounted for and lets the auxiliary caller fail over to a configured API route.
 */
export type ChatHubAuxiliaryPolicy = 'refuse' | 'allow'

/** Default text head so a prompt always names the task even when budgets bite. */
export const DEFAULT_MAX_TEXT_CHARS = 2_000
/** Description budget of one tool schema inside the rendered prompt. */
export const DEFAULT_MAX_TOOL_DESCRIPTION_CHARS = 240

/**
 * Runtime configuration of one adapter instance.
 *
 * One instance drives one route per configured site: the registry calls the
 * adapter with the route id, and the adapter derives the site from it, so two
 * sites stay two routes over one transport and one browser profile.
 */
export interface ChatHubLlmConfig {
  /** Site provider id the host transport and drivers know, e.g. `deepseek-web`. */
  readonly site: string
  /** Every site this instance serves; `site` is the default and first member. */
  readonly sites: readonly string[]
  /** LLM provider route registered for this adapter, e.g. `deepseek-web-chathub`. */
  readonly route: string
  /** One route per site, in `sites` order; a single-site mount has exactly one. */
  readonly routes: readonly string[]
  /** Model id advertised on that route; the site selects the model itself. */
  readonly model: string
  /** Declared context capacity in tokens, used by harness budget planning. */
  readonly contextWindow: number
  /** Hard upper bound of one rendered prompt, in characters. */
  readonly maxPromptChars: number
  /** Upper bound of one tool result inside the rendered prompt, in characters. */
  readonly maxToolResultChars: number
  /** Upper bound of the harness system prompt carried into the rendered prompt. */
  readonly maxSystemChars: number
  /** How many recent conversation entries stay verbatim; older ones collapse. */
  readonly historyTurns: number
  /** Tool names the model may call; anything else is a rejected answer. */
  readonly allowTools: readonly string[]
  /** Path segments no argument may address, e.g. `.git` or `node_modules`. */
  readonly denyPaths: readonly string[]
  /** Commands the prompt states as the completion check, e.g. a typecheck. */
  readonly verifyCommands: readonly string[]
  /**
   * Absolute workspace root every path argument must stay under. When absent,
   * only traversal and the deny list are enforced, because the adapter has no
   * way to learn the root without the host's sandbox policy.
   */
  readonly workspaceRoot?: string | undefined
  /** Upper bound of tool calls accepted from one reply; the protocol allows one. */
  readonly maxToolCallsPerTurn: number
  /** Extra rounds granted to a reply whose call block was rejected as illegal. */
  readonly repairAttempts: number
  /**
   * Whether a request carrying a declared auxiliary purpose — a session title,
   * a compaction summary — may spend a site turn here. `refuse` is the
   * default: those callers expect a fast, cheap classification call, and a
   * page turn is neither.
   */
  readonly auxiliary: ChatHubAuxiliaryPolicy
  /** Receives one record per completed turn; never carries prompt or answer text. */
  readonly onTurn?: (record: ChatHubTurnObservation) => void
}

/** Site status facts the adapter reads before opening a page. */
export interface ChatHubProviderHealthView {
  /** Site provider id. */
  readonly id: string
  /** Host-reported health, of which only the status string matters here. */
  readonly health: { readonly status: string }
}

/**
 * What the adapter needs from the mounted host layer.
 *
 * Declared structurally so the adapter depends on the transport contract, not
 * on the Remote service class: a test double is a two-method object.
 */
export interface ChatHubTransportSource {
  /**
   * @returns The transport the host built for its adapters, without page handles.
   */
  transportForAdapter(): ChatHubTransport
  /**
   * @returns One health row per shipped site provider.
   */
  providers(): Promise<readonly ChatHubProviderHealthView[]>
}

/** The subset of the host transport contract this adapter calls. */
export interface ChatHubTransport {
  /**
   * Open or reuse a signed-in chat session for one site and page key.
   * @param providerId - site provider id.
   * @param sessionKey - page key; a new key means a new site conversation.
   * @returns The session, a refusal, or `undefined` while sign-in is pending.
   */
  open(providerId: string, sessionKey?: string): Promise<ChatHubTransportSession | ChatHubTransportClosed | undefined>
}

/** Result of opening a session when the site refuses to start one. */
export interface ChatHubTransportClosed {
  /** Marker separating a refusal from an open session. */
  readonly closed: true
  /** Why the site refused. */
  readonly reason: 'not-signed-in' | 'expired'
}

/** One turn over an open page. */
export interface ChatHubTransportSession {
  /**
   * @param payload - provider-normalized page payload; the adapter fills `prompt`.
   * @returns The site's answer markup before provider normalization.
   */
  send(payload: ChatHubTransportPayload): Promise<{ readonly content: string }>
  /**
   * @returns Resolves when the page backing this session is released.
   */
  close(): Promise<void>
}

/** Page payload as the transport's own contract defines it. */
export interface ChatHubTransportPayload {
  /** Site provider id the session belongs to. */
  readonly providerId: string
  /** Unused by this adapter: rendering happens before the transport sees it. */
  readonly system: string
  /** Empty: the rendered prompt carries the whole conversation. */
  readonly messages: WebChatPayload['messages']
  /** The single self-contained prompt. */
  readonly prompt: string
  /** Honest declaration that the adapter, not the provider, rendered the text. */
  readonly meta: { readonly origin: 'raw-messages' }
}

/** One tool call a reply asked for, already validated against the policy. */
export interface ChatHubToolCall {
  /** Whitelisted tool name. */
  readonly name: string
  /** JSON object of arguments, parsed and path-checked. */
  readonly arguments: Readonly<Record<string, unknown>>
}

/** Outcome of interpreting one reply. */
export interface ChatHubParsedAnswer {
  /** Human-facing text with the call block removed. */
  readonly text: string
  /** The single accepted call, when the reply asked for one. */
  readonly call?: ChatHubToolCall
  /** Why the reply was rejected; present means no call may run. */
  readonly invalid?: string
  /** Non-fatal findings, such as a dropped second call block. */
  readonly warnings: readonly string[]
}

/** What one parsed reply is allowed to contain. */
export interface ChatHubParsePolicy {
  /** Tool names the model may call. */
  readonly allowTools: readonly string[]
  /** Path segments no argument may address. */
  readonly denyPaths: readonly string[]
  /** Absolute workspace root path arguments must stay under, when known. */
  readonly workspaceRoot?: string | undefined
  /** Upper bound of the returned `text`. */
  readonly maxTextChars: number
  /** Upper bound of accepted calls; extra blocks are dropped with a warning. */
  readonly maxToolCallsPerTurn: number
}

/** Everything one rendered prompt is built from. */
export interface ChatHubRenderPolicy {
  /** Tool schemas the model may see, already filtered to the whitelist. */
  readonly tools: readonly { readonly name: string; readonly description: string; readonly parameters: unknown }[]
  /** Workspace root stated in the prompt's project block. */
  readonly workspaceRoot?: string | undefined
  /** Verification commands the prompt states as the completion check. */
  readonly verifyCommands: readonly string[]
  /** Hard upper bound of the rendered prompt. */
  readonly maxPromptChars: number
  /** Upper bound of one tool result inside the conversation. */
  readonly maxToolResultChars: number
  /** Upper bound of the harness system prompt. */
  readonly maxSystemChars: number
  /** How many recent entries stay verbatim. */
  readonly historyTurns: number
}

/** One turn's observable facts; no prompt, answer, or argument text. */
export interface ChatHubTurnObservation {
  /** Harness session the turn belongs to, when the loop stamped one. */
  readonly sessionId?: string
  /** Page key used for the last attempt. */
  readonly pageKey: string
  /** 1-based count of the attempt that produced the answer. */
  readonly attempt: number
  /** Rendered prompt length in characters. */
  readonly promptChars: number
  /** Answer length in characters. */
  readonly answerChars: number
  /** Tool name the reply asked for, when it asked for one. */
  readonly toolName?: string
  /** Rejection reason of the last reply, when it was rejected. */
  readonly invalid?: string
  /** Non-fatal findings about the reply, such as a repaired argument. */
  readonly warnings?: readonly string[]
  /** Wall-clock duration of the whole turn. */
  readonly ms: number
  /** Conversation entries dropped to fit the prompt budget. */
  readonly droppedEntries: number
}

/**
 * Raised when a request cannot be rendered inside the declared prompt budget.
 *
 * It carries the harness failure code as an own property, which is how the
 * runtime reads a failure code off an adapter throw: no mapping layer is
 * needed, and the loop reacts by compacting instead of retrying.
 */
export class ChatHubPromptOverflowError extends Error {
  /** Stable harness code this refusal maps to. */
  readonly code = CHATHUB_LLM_OVERFLOW_CODE

  /**
   * @param chars - length the smallest possible rendering still needs.
   * @param maxChars - configured ceiling.
   */
  constructor(readonly chars: number, readonly maxChars: number) {
    super(`rendered prompt needs ${chars} characters, over the ${maxChars} budget`)
    this.name = 'ChatHubPromptOverflowError'
  }
}

/** Shipped defaults; a mount supplies only what differs. */
export const DEFAULT_CHATHUB_LLM_CONFIG = {
  model: 'web-model',
  contextWindow: 32_000,
  maxPromptChars: 48_000,
  maxToolResultChars: 6_000,
  maxSystemChars: 4_000,
  historyTurns: 8,
  allowTools: ['read', 'grep', 'glob', 'edit', 'write'] as const,
  denyPaths: ['.git', 'node_modules', '.env'] as const,
  verifyCommands: ['pnpm run typecheck'] as const,
  maxToolCallsPerTurn: 1,
  repairAttempts: 1,
  auxiliary: 'refuse',
} as const
