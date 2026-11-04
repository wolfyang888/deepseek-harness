/**
 * The adapter: a signed-in web chat site driven as a text-only tool-calling
 * model behind the harness's own agent loop.
 *
 * One `stream()` call is one step of that loop. Each attempt opens its own
 * site conversation, so a retry never appends to the previous attempt's page,
 * and the prompt is self-contained because the loop — not the site — owns the
 * conversation.
 *
 * @module @deepseek-ai/dsh-experimental-llm-chathub/adapter
 */

import {
  LlmAdapter,
  LlmError,
  ToolCallId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { answerTextOf } from '@deepseek-ai/dsh-experimental-chathub-host'
import { parseAnswer } from './protocol.ts'
import { renderRequest } from './render.ts'
import {
  CHATHUB_LLM_AUTH_CODE,
  CHATHUB_LLM_MALFORMED_CODE,
  CHATHUB_LLM_TRANSPORT_CODE,
  type ChatHubLlmConfig,
  type ChatHubParsePolicy,
  type ChatHubRenderPolicy,
  type ChatHubToolCall,
  type ChatHubTransportSession,
  type ChatHubTransportSource,
  type ChatHubTurnObservation,
} from './types.ts'

/** Site token to harness failure code; unmatched tokens are transport failures. */
const TRANSPORT_CODES: Readonly<Record<string, string>> = {
  'chathub-signed-out': CHATHUB_LLM_AUTH_CODE,
  'chathub-busy': 'RATE_LIMIT',
  'chathub-turn-timeout': 'TIMEOUT',
  'chathub-ui-drift': 'SERVER',
  'chathub-browser-unavailable': 'SERVER',
  'chathub-profile-locked': 'SERVER',
  'chathub-network': CHATHUB_LLM_TRANSPORT_CODE,
}

/** Route ids are `<site>` plus this suffix; stripping it recovers the site. */
const ROUTE_SUFFIX = '-chathub'

/**
 * Drives one route per configured site as LLM routes.
 *
 * The adapter owns no browser: it borrows the host transport, so login,
 * profile, and per-page serialization stay where the panel already needs them.
 */
export class ChatHubLlmAdapter extends LlmAdapter {
  /** Monotonic page counter; every attempt gets a fresh site conversation. */
  private sequence = 0

  /**
   * @param source - host layer providing the transport and provider health.
   * @param config - route, budgets, and policy of this mount.
   */
  constructor(
    private readonly source: ChatHubTransportSource,
    private readonly config: ChatHubLlmConfig,
  ) {
    super()
  }

  /**
   * @param provider - the registered route.
   * @returns Display metadata naming the site behind the route.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: `ChatHub ${this.siteOf(provider)}` }
  }

  /**
   * @param provider - the registered route.
   * @returns The single model this route advertises.
   */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: this.config.model, name: this.config.model }])
  }

  /**
   * @param provider - the registered route.
   * @param model - configured model id.
   * @returns Identity plus the declared context capacity.
   */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: this.config.model,
      context: { contextWindow: this.config.contextWindow },
    })
  }

  /**
   * Run one step of the loop against the site.
   * @param options - assembled request, including tool schemas and history.
   * @returns Text block, the optional single tool call, and the finish reason.
   * @throws LlmError when the site cannot be reached, refuses, or answers illegally.
   */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const started = Date.now()
    const site = this.siteOf(options.provider)
    this.assertConversational(options, site)
    const rendered = this.render(options)
    const parsed = await this.askUntilLegal(rendered.prompt, site, options.signal)
    const call = parsed.call
    this.report({
      ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
      pageKey: this.pageKeyOf(site),
      attempt: parsed.attempt,
      promptChars: rendered.prompt.length,
      answerChars: parsed.answerChars,
      ...call === undefined ? {} : { toolName: call.name },
      ...parsed.invalid === undefined ? {} : { invalid: parsed.invalid },
      ms: Date.now() - started,
      droppedEntries: rendered.droppedEntries,
    })
    if (parsed.invalid !== undefined) {
      throw new LlmError(`chathub-llm: ${site} answered illegally: ${parsed.invalid}`, CHATHUB_LLM_MALFORMED_CODE)
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (parsed.text.length > 0) yield { type: 'text-delta', index: 0, text: parsed.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: parsed.text } }
    if (call === undefined) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield* this.toolCallChunks(call)
  }

  /**
   * Refuse an auxiliary request before a browser turn is spent on it.
   *
   * A titled request is not conversation: it arrives with no tools and a
   * prompt written for a fast text model, so answering it burns a page and
   * returns text the caller cannot use — and, on a site that reads the newest
   * message as the task, it is what made a coding session look like it was
   * summarising titles. The caller fails over to its configured API route.
   * @param options - the assembled request.
   * @param site - site provider the route selected.
   * @throws LlmError with `INVALID_REQUEST` for a refused auxiliary purpose.
   */
  private assertConversational(options: GenerateOptions, site: string): void {
    const purpose = options.purpose
    if (purpose === undefined || this.config.auxiliary === 'allow') return
    throw new LlmError(
      `chathub-llm: ${site} does not serve auxiliary "${purpose}" requests; `
      + "point that caller at an API route, or mount with auxiliary: 'allow'",
      'INVALID_REQUEST',
    )
  }

  /**
   * Render one request; a budget refusal propagates with its own failure code.
   * @param options - assembled request.
   * @returns The prompt and its budget facts.
   */
  private render(options: GenerateOptions): { prompt: string; droppedEntries: number } {
    return renderRequest(options, this.renderPolicy(options))
  }

  /**
   * Ask the site until the reply is legal, or the repair budget runs out.
   * @param prompt - the rendered prompt.
   * @param site - site provider the route selected.
   * @param signal - caller cancellation.
   * @returns The last reply with its attempt count and answer length.
   */
  private async askUntilLegal(prompt: string, site: string, signal?: AbortSignal): Promise<{
    text: string
    call?: ChatHubToolCall
    invalid?: string
    attempt: number
    answerChars: number
  }> {
    let question = prompt
    let attempt = 0
    for (;;) {
      attempt += 1
      this.assertNotAborted(site, signal)
      const answer = await this.ask(question, site, signal)
      const parsed = parseAnswer(answer, this.parsePolicy())
      if (parsed.invalid === undefined || attempt > this.config.repairAttempts) {
        return { ...parsed, attempt, answerChars: answer.length }
      }
      // The site cannot be told "that was wrong" in its own vocabulary, so the
      // correction rides the next prompt inside a fresh conversation.
      question = `${prompt}\n\n# CORRECTION\nThe previous reply was rejected: ${parsed.invalid}\nReply again using only the block format above.`
    }
  }

  /**
   * Send one prompt and read the whole answer.
   * @param prompt - self-contained prompt.
   * @param site - site provider the route selected.
   * @param signal - caller cancellation.
   * @returns The site's answer as visible text.
   */
  private async ask(prompt: string, site: string, signal?: AbortSignal): Promise<string> {
    await this.assertHealthy(site)
    const opened = await this.source.transportForAdapter().open(site, this.nextPageKey(site))
    if (opened === undefined) {
      throw new LlmError(`chathub-llm: ${site} is waiting for sign-in`, CHATHUB_LLM_AUTH_CODE)
    }
    if (!('send' in opened)) {
      throw new LlmError(`chathub-llm: ${site} refused the session (${opened.reason})`, CHATHUB_LLM_AUTH_CODE)
    }
    const session: ChatHubTransportSession = opened
    try {
      const answer = await session.send({
        providerId: site,
        system: '',
        messages: [],
        prompt,
        meta: { origin: 'raw-messages' },
      })
      this.assertNotAborted(site, signal)
      // The transport carries answers as markup for the panel; the protocol
      // here parses plain text, and the conversion also unescapes the
      // `&lt;&lt;&lt;TOOL_CALL` delimiters a site's DOM serializes.
      return answerTextOf(answer.content)
    } catch (error) {
      throw transportFailure(error, site)
    } finally {
      await session.close()
    }
  }

  /**
   * Refuse a signed-out or failed provider before a browser is launched.
   * @param site - site provider the route selected.
   * @throws LlmError with `AUTH` for a provider that needs sign-in.
   */
  private async assertHealthy(site: string): Promise<void> {
    const views = await this.source.providers()
    const view = views.find(candidate => candidate.id === site)
    if (view === undefined) {
      throw new LlmError(`chathub-llm: no site provider "${site}" is registered`, 'INVALID_REQUEST')
    }
    if (view.health.status === 'needs-auth' || view.health.status === 'failed') {
      throw new LlmError(
        `chathub-llm: ${site} is ${view.health.status}; sign in from the ChatHub panel first`,
        CHATHUB_LLM_AUTH_CODE,
      )
    }
  }

  /**
   * @param site - site provider the route selected.
   * @param signal - caller cancellation.
   * @throws LlmError with `ABORTED` once the caller cancelled.
   */
  private assertNotAborted(site: string, signal?: AbortSignal): void {
    if (signal?.aborted !== true) return
    throw new LlmError(`chathub-llm: ${site} turn cancelled`, 'ABORTED')
  }

  /**
   * Emit the call block the loop executes.
   * @param call - validated call from the reply.
   * @returns The tool-call chunks and the terminal finish.
   */
  private *toolCallChunks(call: ChatHubToolCall): Iterable<StreamChunk> {
    const id = ToolCallId(`chathub-call-${String(this.sequence)}`)
    const args = JSON.stringify(call.arguments)
    yield { type: 'block-start', index: 1, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 1, id, name: call.name, argumentsDelta: args }
    yield { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: call.name, arguments: args } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }

  /**
   * @param site - site provider the route selected.
   * @returns The page key of the attempt in flight.
   */
  private pageKeyOf(site: string): string {
    return `${site}:${String(this.sequence)}`
  }

  /**
   * Allocate the page key of the next attempt: a new key is a new site
   * conversation, which is what makes a retry safe.
   * @param site - site provider the route selected.
   * @returns The page key for one attempt.
   */
  private nextPageKey(site: string): string {
    this.sequence += 1
    return this.pageKeyOf(site)
  }

  /**
   * Resolve the site behind a registered route.
   * @param route - provider route the registry called with, e.g. `qianwen-web-chathub`.
   * @returns The site provider id the transport and drivers know.
   * @throws LlmError for a route this mount does not serve.
   */
  private siteOf(route: string): string {
    const site = route.endsWith(ROUTE_SUFFIX) ? route.slice(0, route.length - ROUTE_SUFFIX.length) : route
    if (!this.config.sites.includes(site)) {
      throw new LlmError(`chathub-llm: route "${route}" is not one of ${this.config.sites.join(', ')}`, 'INVALID_REQUEST')
    }
    return site
  }

  /**
   * @param options - assembled request whose tool schemas fill the prompt.
   * @returns The render policy of this mount.
   */
  private renderPolicy(options: GenerateOptions): ChatHubRenderPolicy {
    const tools = (options.tools ?? [])
      .filter(tool => this.config.allowTools.includes(tool.name))
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }))
    return {
      tools,
      ...this.config.workspaceRoot === undefined ? {} : { workspaceRoot: this.config.workspaceRoot },
      verifyCommands: this.config.verifyCommands,
      maxPromptChars: this.config.maxPromptChars,
      maxToolResultChars: this.config.maxToolResultChars,
      maxSystemChars: this.config.maxSystemChars,
      historyTurns: this.config.historyTurns,
    }
  }

  /**
   * @returns The parse policy of this mount.
   */
  private parsePolicy(): ChatHubParsePolicy {
    return {
      allowTools: this.config.allowTools,
      denyPaths: this.config.denyPaths,
      ...this.config.workspaceRoot === undefined ? {} : { workspaceRoot: this.config.workspaceRoot },
      maxTextChars: 2_000,
      maxToolCallsPerTurn: this.config.maxToolCallsPerTurn,
    }
  }

  /**
   * Hand one turn record to the mount, which decides where it goes.
   * @param record - observable facts without prompt or answer text.
   */
  private report(record: ChatHubTurnObservation): void {
    this.config.onTurn?.(record)
  }
}

/**
 * Map a rejection from the transport onto a harness failure code.
 * @param error - value thrown while opening or driving the page.
 * @param site - site provider id, for the message only.
 * @returns An LlmError carrying a stable code; unrelated errors pass through.
 */
function transportFailure(error: unknown, site: string): unknown {
  if (error instanceof LlmError) return error
  if (!(error instanceof Error)) return error
  const token = readToken(error)
  const code = token === undefined ? CHATHUB_LLM_TRANSPORT_CODE : TRANSPORT_CODES[token] ?? CHATHUB_LLM_TRANSPORT_CODE
  return new LlmError(`chathub-llm: ${site}: ${error.message}`, code, { cause: error })
}

/**
 * Read the stable token a transport rejection carries.
 * @param error - rejection from the transport layer.
 * @returns The token, from its own field or its message prefix.
 */
function readToken(error: Error): string | undefined {
  const own = (error as { token?: unknown }).token
  if (typeof own === 'string') return own
  const prefix = /^(chathub-[a-z-]+):/u.exec(error.message)
  return prefix?.[1]
}
