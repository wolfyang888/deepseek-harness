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
  ReasoningEffortId,
  ToolCallId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmModelReasoningInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { appendFile } from 'node:fs/promises'
import { answerMessageText } from '@deepseek-ai/dsh-experimental-chathub-host'
import { END_MARKER, TOOL_CALL_OPEN, isToolAllowed, parseAnswer, visibleTextOf } from './protocol.ts'
import { renderRequest } from './render.ts'
import { SiteRouter } from './router.ts'
import {
  CHATHUB_LLM_AUTH_CODE,
  CHATHUB_LLM_MALFORMED_CODE,
  CHATHUB_LLM_PROSE_CODE,
  CHATHUB_LLM_TRANSPORT_CODE,
  DEFAULT_SITE_ROUTING,
  type ChatHubLlmConfig,
  type ChatHubParsePolicy,
  type ChatHubParsedAnswer,
  type ChatHubRenderPolicy,
  type ChatHubToolCall,
  type ChatHubTransport,
  type ChatHubTransportClosed,
  type ChatHubTransportSession,
  type ChatHubTransportSource,
  type ChatHubTurnObservation,
} from './types.ts'

/**
 * Reasoning efforts the route accepts and ignores. A site composer exposes no
 * reasoning control, but a session-level default model can still carry an
 * effort into a request routed here; without declared efforts the loop fails
 * the turn with `UNSUPPORTED_REASONING_EFFORT` before the browser ever opens.
 * The value is dropped: the site never sees it, and no default effort is
 * materialized. An id outside this list still fails resolution loudly.
 */
const ACCEPTED_REASONING: LlmModelReasoningInfo = {
  efforts: [
    { id: ReasoningEffortId('off'), name: 'Off' },
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('medium'), name: 'Medium' },
    { id: ReasoningEffortId('high'), name: 'High' },
    { id: ReasoningEffortId('max'), name: 'Max' },
  ],
}

/** Site token to harness failure code; unmatched tokens are transport failures. */
const TRANSPORT_CODES: Readonly<Record<string, string>> = {
  'chathub-signed-out': CHATHUB_LLM_AUTH_CODE,
  'chathub-busy': 'RATE_LIMIT',
  'chathub-paced': 'RATE_LIMIT',
  'chathub-turn-timeout': 'TIMEOUT',
  'chathub-ui-drift': 'SERVER',
  'chathub-browser-unavailable': 'SERVER',
  'chathub-profile-locked': 'SERVER',
  'chathub-network': CHATHUB_LLM_TRANSPORT_CODE,
}

/** Route ids are `<site>` plus this suffix; stripping it recovers the site. */
const ROUTE_SUFFIX = '-chathub'

/** Answer-text budget for a compaction turn: a checkpoint outgrows a reply. */
const COMPACTION_ANSWER_CHARS = 16_000

/** Answer-text budget for a conversational turn. */
const ANSWER_CHARS = 2_000

/**
 * Drives one route per configured site as LLM routes.
 *
 * The adapter owns no browser: it borrows the host transport, so login,
 * profile, and per-page serialization stay where the panel already needs them.
 */
export class ChatHubLlmAdapter extends LlmAdapter {
  /** Monotonic page counter; every attempt gets a fresh site conversation. */
  private sequence = 0

  /** The transport the host lent once; the adapter borrows it, not owns it. */
  private lentTransport: ChatHubTransport | undefined

  /** Placement of a turn across mounted sites; inert on a pinned route. */
  private readonly router: SiteRouter

  /**
   * @param source - host layer providing the transport and provider health.
   * @param config - route, budgets, and policy of this mount.
   */
  constructor(
    private readonly source: ChatHubTransportSource,
    private readonly config: ChatHubLlmConfig,
  ) {
    super()
    this.router = new SiteRouter(config.routing ?? DEFAULT_SITE_ROUTING)
  }

  /**
   * @returns The host transport, borrowed on first use.
   */
  private transport(): ChatHubTransport {
    return this.lentTransport ??= this.source.transportForAdapter()
  }

  /**
   * @param provider - the registered route.
   * @returns Display metadata naming the site behind the route.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    if (this.isAutoRoute(provider)) {
      return { id: provider, name: `ChatHub auto (${this.config.sites.join(', ')})` }
    }
    return { id: provider, name: `ChatHub ${this.siteOf(provider)}` }
  }

  /**
   * @param provider - the registered route.
   * @returns The single model this route advertises.
   */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // The id stays the configured model (`web-model`): it is the selection key
    // a saved session re-resolves against. The name is the site behind the
    // route, so the panel lists `doubao-web` under `ChatHub doubao-web` instead
    // of one indistinguishable `web-model` under every provider.
    return Promise.resolve([{ provider, id: this.config.model, name: this.siteLabel(provider) }])
  }

  /**
   * @param provider - the registered route.
   * @param model - configured model id.
   * @returns Identity, the declared context capacity, and the
   *   accepted-and-ignored reasoning efforts; no default effort is
   *   materialized because the site never sees the value.
   */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: this.siteLabel(provider),
      context: { contextWindow: this.config.contextWindow },
      reasoning: ACCEPTED_REASONING,
    })
  }

  /**
   * Resolve the site label a route's model is listed under.
   * @param provider - the registered route.
   * @returns The site id for a per-site route, or `auto` for the aggregate one.
   */
  private siteLabel(provider: string): string {
    if (this.isAutoRoute(provider)) return 'auto'
    return this.siteOf(provider)
  }

  /**
   * Run one step of the loop against the site.
   *
   * A pinned route on a transport that reports answer snapshots streams them
   * as text deltas while the site is still writing; every other combination
   * (the aggregate route, compaction, snapshot-less sessions) keeps the
   * repair-and-rotation pipeline and emits the answer once it completes.
   * @param options - assembled request, including tool schemas and history.
   * @returns Text block, the optional single tool call, and the finish reason.
   * @throws LlmError when the site cannot be reached, refuses, or answers illegally.
   */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const started = Date.now()
    const pinned = this.pinnedSiteOf(options.provider)
    const live = pinned !== undefined && (options.purpose as string | undefined) !== 'compaction'
      ? new LiveQueue()
      : undefined
    if (live === undefined) {
      const turn = await this.runTurn(options, started)
      yield* this.emitTurn(turn, options, started)
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    let failure: unknown
    let turn: Awaited<ReturnType<ChatHubLlmAdapter['runTurn']>> | undefined
    let settled = false
    const run = this.runTurn(options, started, live).then(
      (result) => { turn = result },
      (error) => { failure = error },
    ).finally(() => {
      settled = true
      live.wake()
    })
    while (!settled || live.pending() > 0) {
      if (live.pending() === 0) {
        await live.idle()
        continue
      }
      for (const delta of live.take()) yield { type: 'text-delta', index: 0, text: delta }
    }
    await run
    if (failure !== undefined) throw failure
    if (turn === undefined) throw new Error('unreachable')
    yield* this.emitTurnRest(turn, options, started, live.emittedChars())
  }

  /**
   * Report a completed turn and emit its answer as one block.
   * @param turn - the legal answer with its site and render facts.
   * @param options - the request the turn answered.
   * @param started - `Date.now()` when the request began.
   * @returns The turn's chunks, ending in a finish reason.
   * @throws LlmError when the answer stayed illegal after the repair budget.
   */
  private *emitTurn(
    turn: Awaited<ReturnType<ChatHubLlmAdapter['runTurn']>>,
    options: GenerateOptions,
    started: number,
  ): Iterable<StreamChunk> {
    const call = turn.parsed.call
    if (turn.parsed.invalid !== undefined) {
      // The attempt that produced it is already on the tape as a failure.
      throw new LlmError(
        `chathub-llm: ${turn.site} answered illegally: ${turn.parsed.invalid}`,
        CHATHUB_LLM_MALFORMED_CODE,
      )
    }
    this.reportTurn(turn, options, started)
    yield* this.reasoningChunks(turn.parsed.reasoning)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (turn.parsed.text.length > 0) yield { type: 'text-delta', index: 0, text: turn.parsed.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: turn.parsed.text } }
    if (call === undefined) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield* this.toolCallChunks(call)
  }

  /**
   * Emit the rest of a live-streamed turn: the block never re-sends what the
   * deltas already delivered, so a session without snapshots still works
   * through the same path as one lump.
   * @param turn - the legal answer with its site and render facts.
   * @param options - the request the turn answered.
   * @param started - `Date.now()` when the request began.
   * @param emitted - characters the live deltas already emitted.
   * @returns The remaining chunks, ending in a finish reason.
   * @throws LlmError when the answer stayed illegal once the live deltas had
   *   committed the attempt.
   */
  private *emitTurnRest(
    turn: Awaited<ReturnType<ChatHubLlmAdapter['runTurn']>>,
    options: GenerateOptions,
    started: number,
    emitted: number,
  ): Iterable<StreamChunk> {
    const call = turn.parsed.call
    if (turn.parsed.invalid !== undefined) {
      // The attempt that produced it is already on the tape as a failure.
      throw new LlmError(
        `chathub-llm: ${turn.site} answered illegally: ${turn.parsed.invalid}`,
        CHATHUB_LLM_MALFORMED_CODE,
      )
    }
    this.reportTurn(turn, options, started)
    yield* this.reasoningChunks(turn.parsed.reasoning)
    if (emitted === 0 && turn.parsed.text.length > 0) {
      yield { type: 'text-delta', index: 0, text: turn.parsed.text }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: turn.parsed.text } }
    if (call === undefined) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield* this.toolCallChunks(call)
  }

  /**
   * Record the observation for a turn that is about to be emitted.
   * @param turn - the legal answer with its site and render facts.
   * @param options - the request the turn answered.
   * @param started - `Date.now()` when the request began.
   */
  private reportTurn(
    turn: Awaited<ReturnType<ChatHubLlmAdapter['runTurn']>>,
    options: GenerateOptions,
    started: number,
  ): void {
    const call = turn.parsed.call
    this.report({
      site: turn.site,
      ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
      pageKey: this.pageKeyOf(turn.site),
      attempt: turn.parsed.attempt,
      promptChars: turn.rendered.prompt.length,
      answerChars: turn.parsed.answerChars,
      ...call === undefined ? {} : { toolName: call.name },
      ...turn.parsed.warnings.length === 0 ? {} : { warnings: turn.parsed.warnings },
      ms: Date.now() - started,
      droppedEntries: turn.rendered.droppedEntries,
    })
  }

  /**
   * Open the next attempt's session on a site, mapping transport errors.
   *
   * Opening hits the same transport tokens `send` does (a closed page, a
   * locked profile, a disposed browser); without this mapping those bypass
   * the site-failure codes and reach the loop unclassified.
   * @param site - site provider the route selected.
   * @param signal - cancels the open when the caller gave up on the turn.
   * @returns The session, a refusal, or `undefined` while sign-in is pending.
   * @throws LlmError when the transport itself fails to open.
   */
  private async openAttempt(
    site: string,
    signal?: AbortSignal,
  ): Promise<ChatHubTransportSession | ChatHubTransportClosed | undefined> {
    try {
      return await this.transport().open(site, this.nextPageKey(site), signal)
    } catch (error) {
      throw transportFailure(error, site)
    }
  }

  /**
   * Place the turn on a site, render for it, and read one legal answer.
   *
   * On the aggregate route the site is chosen per turn: the topic keeps its
   * site while that site is ready, and a site that fails a turn is replaced
   * within the same request instead of failing the whole step. A reply that
   * breaks the protocol counts as a site failure too — the prompt is fixed and
   * self-contained, so a model that twice answers without a legal call block is
   * a model this topic should leave, not a request to repeat. A pinned route
   * never moves — the user picked that model, and answering from another one
   * silently is worse than failing.
   * @param options - assembled request.
   * @param started - clock reading when the step began, for attempt records.
   * @param sink - live emission channel for the streaming caller, when the
   *   route pins a site and the request is not compaction.
   * @returns The site that served, what it was shown, and how it answered.
   * @throws LlmError when no site serves the turn.
   */
  private async runTurn(
    options: GenerateOptions,
    started: number,
    sink?: ChatHubLiveSink,
  ): Promise<{
    site: string
    rendered: { prompt: string; droppedEntries: number }
    parsed: Awaited<ReturnType<ChatHubLlmAdapter['askUntilLegal']>>
  }> {
    this.assertConversational(options, options.provider)
    const pinned = this.pinnedSiteOf(options.provider)
    const key = this.topicKeyOf(options)
    const answerBudget = (options.purpose as string | undefined) === 'compaction'
      ? COMPACTION_ANSWER_CHARS
      : ANSWER_CHARS
    const routing = this.config.routing ?? DEFAULT_SITE_ROUTING
    let candidates = await this.candidateSites(pinned)
    let failures = 0
    // The last prose answer, kept until a later attempt beats it: a replay
    // that finds no site left still delivers something.
    let lastProse: { site: string; rendered: { prompt: string; droppedEntries: number }; parsed: Awaited<ReturnType<ChatHubLlmAdapter['askUntilLegal']>> } | undefined
    for (;;) {
      let site: string
      try {
        site = this.router.choose({
          key,
          candidates,
          ...pinned === undefined ? {} : { pinned },
          waitOf: candidate => this.transport().waitForTurnMs?.(candidate) ?? 0,
        })
      } catch (error) {
        if (lastProse !== undefined) return lastProse
        throw error
      }
      const rendered = this.render(options, site)
      await this.recordPrompt(site, rendered.prompt)
      let parsed: Awaited<ReturnType<ChatHubLlmAdapter['askUntilLegal']>>
      try {
        parsed = await this.askUntilLegal(rendered.prompt, site, options.signal, answerBudget, {
          narrative: (options.purpose as string | undefined) !== 'compaction',
        }, sink)
      } catch (error) {
        this.reportAttempt(options, site, rendered, failures + 1, started, failureCodeOf(error))
        if (pinned !== undefined || failures >= routing.failoverAttempts || !failoverEligible(error)) throw error
        failures += 1
        this.router.fail(key, site)
        candidates = candidates.filter(candidate => candidate !== site)
        continue
      }
      if (parsed.invalid !== undefined) {
        // The repair rounds already ran on this site, so a still-illegal reply
        // is the site's ceiling for this request, not a prompt to send again.
        this.reportAttempt(options, site, rendered, failures + 1, started, CHATHUB_LLM_MALFORMED_CODE)
        if (pinned !== undefined || failures >= routing.failoverAttempts) {
          this.router.fail(key, site)
          return { site, rendered, parsed }
        }
        failures += 1
        this.router.fail(key, site)
        candidates = candidates.filter(candidate => candidate !== site)
        continue
      }
      if (
        parsed.call === undefined
        && parsed.text.length > 0
        && routing.proseReplay
        && pinned === undefined
        && failures < routing.failoverAttempts
        && candidates.length > 1
        && !hadToolActivity(options)
        && (options.purpose as string | undefined) !== 'compaction'
      ) {
        // A prose reply before any tool has run is a protocol miss, not a
        // finished task: the loop asked for file work and got a refusal
        // question instead. Replay it on the next site — the prompt is fixed,
        // the model is what varies. The miss counts toward escalation without
        // benching the account, and when no other site is left this prose
        // still reaches the caller, so nothing is lost.
        lastProse = { site, rendered, parsed }
        this.reportAttempt(options, site, rendered, failures + 1, started, CHATHUB_LLM_PROSE_CODE)
        failures += 1
        this.router.miss(key, site)
        candidates = candidates.filter(candidate => candidate !== site)
        continue
      }
      this.router.succeed(key, site)
      return { site, rendered, parsed }
    }
  }

  /**
   * Emit the record of an attempt that produced no answer, so a turn that
   * moved between sites is visible site by site instead of only as a failure.
   * @param options - the assembled request.
   * @param site - site the attempt ran on.
   * @param rendered - the prompt it was shown, for its length.
   * @param attempt - 1-based attempt number within this step.
   * @param started - clock reading when the step began.
   * @param failure - stable code of the failure.
   */
  private reportAttempt(
    options: GenerateOptions,
    site: string,
    rendered: { prompt: string; droppedEntries: number },
    attempt: number,
    started: number,
    failure: string,
  ): void {
    this.report({
      site,
      ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
      pageKey: this.pageKeyOf(site),
      attempt,
      promptChars: rendered.prompt.length,
      answerChars: 0,
      failure,
      ms: Date.now() - started,
      droppedEntries: rendered.droppedEntries,
    })
  }

  /**
   * @param options - the assembled request.
   * @returns The key a topic is tracked under: its session, else one bucket.
   */
  private topicKeyOf(options: GenerateOptions): string {
    return options.sessionId === undefined ? 'default' : String(options.sessionId)
  }

  /**
   * @param pinned - the site a pinned route fixes, if any.
   * @returns Sites that may serve this turn, health allowing.
   */
  private async candidateSites(pinned: string | undefined): Promise<string[]> {
    if (pinned !== undefined) return [pinned]
    const views = await this.source.providers()
    const healthy = new Set(views
      .filter(view => view.health.status !== 'needs-auth' && view.health.status !== 'failed')
      .map(view => view.id))
    const mounted = this.config.sites.filter(site => healthy.has(site))
    // When nothing is healthy the turn still runs on a mounted site, so the
    // failure names the real problem (sign-in) instead of "no route".
    return mounted.length > 0 ? mounted : [...this.config.sites]
  }

  /**
   * @param route - the registered route the registry called with.
   * @returns The site it pins, or `undefined` for the aggregate route.
   * @throws LlmError for a route this mount does not serve.
   */
  private pinnedSiteOf(route: string): string | undefined {
    if (this.isAutoRoute(route)) return undefined
    return this.siteOf(route)
  }

  /**
   * @param route - a registered route.
   * @returns Whether the route spans every mounted site.
   */
  private isAutoRoute(route: string): boolean {
    return this.config.autoRoute !== undefined && route === this.config.autoRoute
  }

  /**
   * Refuse an auxiliary request before a browser turn is spent on it.
   *
   * A titled request is not conversation: it arrives with no tools and a
   * prompt written for a fast text model, so answering it burns a page and
   * returns text the caller cannot use — and, on a site that reads the newest
   * message as the task, it is what made a coding session look like it was
   * summarising titles. The caller fails over to its configured API route.
   *
   * The `compaction` purpose is served regardless: its output IS the caller's
   * result, and refusing it makes every model switch fail on a web-only mount,
   * where no API route exists to summarize the history instead. The site sees
   * the replayed conversation plus the checkpoint instruction, which is exactly
   * the self-compaction turn a web model can run.
   * @param options - the assembled request.
   * @param site - site provider the route selected.
   * @throws LlmError with `INVALID_REQUEST` for a refused auxiliary purpose.
   */
  private assertConversational(options: GenerateOptions, site: string): void {
    // A forwarding adapter sees whatever purpose string a caller declares; this
    // package declares none of its own, so the field types as `never` here.
    const purpose = options.purpose as string | undefined
    if (purpose === undefined || purpose === 'compaction') return
    if (this.config.auxiliary === 'allow') return
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
  private render(options: GenerateOptions, site: string): { prompt: string; droppedEntries: number } {
    return renderRequest(options, this.renderPolicy(options, site))
  }

  /**
   * Ask the site until the reply is legal, or the repair budget runs out.
   *
   * Beyond a rejected call block, a narrated tool call earns a repair round.
   * A missing `<<<END` marker used to earn one too, but the host now waits for
   * the answer container to stabilize, and site tail matter (sources,
   * disclaimers) can leave a complete answer without a trailing marker. That
   * finding is recorded as a warning instead: spending a whole site turn
   * re-asking a finished reply, then dropping it, made long GLM turns fail
   * with MALFORMED_RESPONSE even though the site had answered. A still-failing
   * call protocol after the budget still ends the step as
   * `MALFORMED_RESPONSE`, so an unsafe call is never executed.
   * @param prompt - the rendered prompt.
   * @param site - site provider the route selected.
   * @param signal - caller cancellation.
   * @param maxTextChars - answer-text budget; compaction turns raise it.
   * @param repairs - which reply findings this request enforces.
   * @param sink - live emission channel, when the caller streams: once it has
   *   emitted, a rejected reply cannot be re-asked invisibly, so repairs stop
   *   and the rejection surfaces.
   * @returns The last reply with its attempt count and answer length.
   */
  private async askUntilLegal(
    prompt: string,
    site: string,
    signal?: AbortSignal,
    maxTextChars = ANSWER_CHARS,
    repairs: Repairs = { narrative: true },
    sink?: ChatHubLiveSink,
  ): Promise<{
    text: string
    reasoning: string
    call?: ChatHubToolCall
    invalid?: string
    warnings: readonly string[]
    attempt: number
    answerChars: number
  }> {
    let question = prompt
    let attempt = 0
    for (;;) {
      attempt += 1
      this.assertNotAborted(site, signal)
      const { text: answer, reasoning } = await this.ask(question, site, signal, sink)
      const parsed = parseAnswer(answer, { ...this.parsePolicy(), maxTextChars })
      await this.recordAnswer(site, attempt, answer, parsed.invalid)
      // A missing END marker is evidence, not a verdict. The host already
      // waits for the answer container to stabilize, and a site's trailing
      // sources/disclaimers can leave a complete reply without the marker, so
      // record it as a warning and never re-ask or discard a finished answer.
      // Deliberately no enforcement switch lives here: turning this back into a
      // rejection made long GLM turns fail with MALFORMED_RESPONSE even though
      // the site had answered. See the END-marker regression tests.
      const warnings = parsed.cutOff !== undefined
        ? [...parsed.warnings, parsed.cutOff]
        : [...parsed.warnings]
      const repair = repairOf(parsed, repairs)
      if (repair === undefined || attempt > this.config.repairAttempts || (sink?.emittedChars() ?? 0) > 0) {
        return {
          ...parsed,
          warnings,
          reasoning,
          ...repair === undefined ? {} : { invalid: parsed.invalid ?? repair.reason },
          attempt,
          answerChars: answer.length,
        }
      }
      // The site cannot be told "that was wrong" in its own vocabulary, so the
      // correction rides the next prompt inside a fresh conversation.
      question = `${prompt}\n\n# CORRECTION\nThe previous reply was rejected: ${repair.reason}\n${repair.advice}`
    }
  }

  /**
   * Send one prompt and read the whole answer.
   *
   * With a live sink and a session that reports answer snapshots, the answer
   * is also streamed to the sink as it is written; the returned text stays
   * the complete answer either way.
   * @param prompt - self-contained prompt.
   * @param site - site provider the route selected.
   * @param signal - caller cancellation.
   * @param sink - live emission channel for the streaming caller.
   * @returns The site's answer as visible text, plus any reasoning trace the
   *   host collected from the page.
   */
  private async ask(
    prompt: string,
    site: string,
    signal?: AbortSignal,
    sink?: ChatHubLiveSink,
  ): Promise<{ text: string; reasoning: string }> {
    await this.assertHealthy(site)
    const opened = await this.openAttempt(site, signal)
    if (opened === undefined) {
      throw new LlmError(`chathub-llm: ${site} is waiting for sign-in`, CHATHUB_LLM_AUTH_CODE)
    }
    if (!('send' in opened)) {
      throw new LlmError(`chathub-llm: ${site} refused the session (${opened.reason})`, CHATHUB_LLM_AUTH_CODE)
    }
    const session: ChatHubTransportSession = opened
    const payload = {
      providerId: site,
      system: '',
      messages: [],
      prompt,
      meta: { origin: 'raw-messages' as const },
    }
    try {
      // The transport carries answers as markup for the panel; the protocol
      // here parses plain text, and the conversion also unescapes the
      // `&lt;&lt;&lt;TOOL_CALL` delimiters a site's DOM serializes. It restores
      // the reply's own blocks — paragraphs, headings, lists, fenced code —
      // because this text is also the answer the transcript shows; code is
      // left verbatim so a JSON argument read from the block still matches the
      // bytes an `edit` searches for.
      const toText = (markup: string): string => answerMessageText(markup)
      if (sink !== undefined && session.watch !== undefined) {
        let emitted = 0
        let snapshot = ''
        for await (const current of session.watch(payload)) {
          snapshot = current
          this.assertNotAborted(site, signal)
          const delta = emittableSuffix(toText(current), emitted)
          if (delta.length > 0) {
            emitted += delta.length
            sink.emit(delta)
          }
        }
        const rest = finalSuffix(toText(snapshot), emitted)
        if (rest.length > 0) sink.emit(rest)
        this.assertNotAborted(site, signal)
        return { text: toText(snapshot), reasoning: session.lastReasoning?.() ?? '' }
      }
      const answer = await session.send(payload)
      this.assertNotAborted(site, signal)
      return { text: toText(answer.content), reasoning: session.lastReasoning?.() ?? '' }
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
   * Emit the site's visible chain of thought as its own reasoning block.
   *
   * Index 2 keeps it clear of the text block (0) and the tool call (1). The
   * gateway maps these deltas to `reasoning_content` SSE frames, which is what
   * lets a client render a thinking panel instead of only the final reply.
   * @param reasoning - joined text of the site's thinking blocks.
   * @returns A complete reasoning block, or nothing when the site showed none.
   */
  private *reasoningChunks(reasoning: string): Iterable<StreamChunk> {
    if (reasoning.length === 0) return
    const index = 2
    yield { type: 'block-start', index, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index, text: reasoning }
    yield { type: 'block-end', index, block: { type: 'reasoning', text: reasoning } }
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
   * Append the raw answer the site gave to an opt-in tape.
   *
   * The prompt tape shows what the model was asked; this one shows what it
   * answered. An illegal reply is reported to the loop only as its rejection
   * reason — `tool "read" carries no arguments object` names the verdict, not
   * the bytes that earned it — so a protocol bug that keeps recurring (the
   * mangled END marker, the arguments-less call) stays undiagnosable from the
   * session log alone. `DSH_CHATHUB_LLM_ANSWER_LOG=<file>` turns the tape on;
   * every answer is recorded, rejected or not, and logging never fails a turn.
   * @param site - site provider the answer came from.
   * @param attempt - 1-based ask count within this turn.
   * @param answer - the raw answer text as the protocol read it.
   * @param invalid - the rejection reason, when the answer was illegal.
   */
  private async recordAnswer(
    site: string,
    attempt: number,
    answer: string,
    invalid: string | undefined,
  ): Promise<void> {
    const path = process.env.DSH_CHATHUB_LLM_ANSWER_LOG
    if (path === undefined || path === '') return
    try {
      await appendFile(path, `${JSON.stringify({
        at: new Date().toISOString(),
        site,
        attempt,
        chars: answer.length,
        ...invalid === undefined ? {} : { invalid },
        answer,
      })}\n`, 'utf8')
    } catch {
      // A tape that cannot be written must not cost the turn it records.
    }
  }

  /**
   * Append the exact prompt the site will read to an opt-in tape.
   *
   * The rendered prompt is the only artifact that shows what the model was
   * actually asked, and the two most expensive bugs on this channel — a task
   * replaced by a runtime-context blurb, a prompt truncated by a composer
   * cap — were invisible from the panel and obvious from this text.
   * `DSH_CHATHUB_LLM_PROMPT_LOG=<file>` turns the tape on; logging never
   * fails a turn.
   * @param site - site provider the route selected.
   * @param prompt - the rendered prompt.
   */
  private async recordPrompt(site: string, prompt: string): Promise<void> {
    const path = process.env.DSH_CHATHUB_LLM_PROMPT_LOG
    if (path === undefined || path === '') return
    try {
      await appendFile(path, `${JSON.stringify({
        at: new Date().toISOString(),
        site,
        chars: prompt.length,
        prompt,
      })}\n`, 'utf8')
    } catch {
      // A tape that cannot be written must not cost the turn it records.
    }
  }

  /**
   * @param options - assembled request whose tool schemas fill the prompt.
   * @param site - site provider the route selected.
   * @returns The render policy of this mount, clamped to the site's composer ceiling.
   */
  private renderPolicy(options: GenerateOptions, site: string): ChatHubRenderPolicy {
    // The whitelist filters by name, never by spelling: a mount that lists
    // `read` still declares the caller's `Read`, which is the name its
    // registry executes. Filtering on exact case here emptied `# TOOLS`.
    const tools = (options.tools ?? [])
      .filter(tool => isToolAllowed(this.config, tool.name))
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }))
    // A composer caps insertions silently; rendering above the site's ceiling
    // would only guarantee a truncated prompt on the page.
    const siteLimit = this.transport().maxPromptChars?.(site)
    return {
      tools,
      ...this.config.workspaceRoot === undefined ? {} : { workspaceRoot: this.config.workspaceRoot },
      verifyCommands: this.config.verifyCommands,
      maxPromptChars: Math.min(this.config.maxPromptChars, siteLimit ?? this.config.maxPromptChars),
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

/** Failure codes that blame the site rather than the request or the answer. */
const SITE_FAILURE_CODES: ReadonlySet<string> = new Set([
  CHATHUB_LLM_AUTH_CODE,
  'RATE_LIMIT',
  'TIMEOUT',
  'SERVER',
  CHATHUB_LLM_TRANSPORT_CODE,
])

/**
 * Whether the same request may be replayed on another site.
 *
 * A site that is signed out, throttled, timed out, or whose page drifted says
 * nothing about the request; another site deserves the turn. An overflow, a
 * cancelled turn, or an illegal request does not — those fail the same way
 * everywhere and the caller must decide. An answer that breaks the protocol is
 * neither: `runTurn` replays it on a stronger site, because the prompt is fixed
 * and the model is the part that varies.
 * @param error - rejection from one site's turn.
 * @returns Whether failover to the next site is meaningful.
 */
function failoverEligible(error: unknown): boolean {
  if (!(error instanceof LlmError)) return false
  return SITE_FAILURE_CODES.has(error.code)
}

/**
 * Whether the conversation already carries a tool call the loop executed.
 *
 * This is what separates a protocol miss from a finished task: a final summary
 * only happens after tools have run, so prose once tools have run is the
 * caller's answer, while prose on a fresh topic is a model dodging the block
 * format.
 * @param options - the assembled request.
 * @returns Whether any message carries an executed tool call.
 */
function hadToolActivity(options: GenerateOptions): boolean {
  return options.messages.some(message => Array.isArray(message.content)
    && message.content.some((block: { type?: string }) => block.type === 'tool-call'))
}

/**
 * Which reply findings one request enforces with a repair round.
 *
 * Intentionally only `narrative`. A missing `<<<END` marker was once enforced
 * here too, but that spent a whole extra site turn re-asking an answer the
 * site had already finished, then threw MALFORMED_RESPONSE when the correction
 * also lacked the marker. The protocol layer still reports it as `cutOff`, and
 * `askUntilLegal` records it as a warning — do not add an enforcement flag
 * back without reinstating the failure it caused.
 */
interface Repairs {
  /** Repair replies that narrate a tool call instead of using the block. */
  readonly narrative: boolean
}

/**
 * The repair one reply earns, with the advice that corrects it.
 *
 * The advice names the defect it fixes where the reason allows it: a correction
 * that only repeats "use the block format" told a subject its `{"name":"read"}`
 * was malformed twice, while what it needed to hear was where the arguments
 * belong.
 * @param parsed - the parsed reply.
 * @param repairs - which findings this request enforces.
 * @returns The rejection reason and advice, or `undefined` when the reply stands.
 */
function repairOf(parsed: ChatHubParsedAnswer, repairs: Repairs): { reason: string; advice: string } | undefined {
  if (parsed.invalid !== undefined) {
    return { reason: parsed.invalid, advice: adviceForInvalid(parsed.invalid) }
  }
  if (repairs.narrative && parsed.suspected !== undefined) {
    return {
      reason: parsed.suspected,
      advice: 'Reply again with the call inside the <<<TOOL_CALL ... TOOL_CALL>>> block, or with a final answer that mentions no tool.',
    }
  }
  // `parsed.cutOff` is a warning, not a repair: see the Repairs note above.
  return undefined
}

/**
 * Advice that teaches the defect a rejection names, rather than repeating the
 * whole protocol at it.
 * @param invalid - the rejection reason the reply earned.
 * @returns Advice naming the fix, or the generic protocol reminder.
 */
function adviceForInvalid(invalid: string): string {
  if (invalid.endsWith('carries no arguments object')) {
    return 'Reply again and nest the arguments under "arguments", e.g. {"name":"read","arguments":{"file_path":"src/main.lua"}} — an arguments key with nothing readable in it cannot run.'
  }
  if (invalid.includes('TOOL_CALL>>>')) {
    return 'Reply again and close the block with a line reading exactly TOOL_CALL>>>'
  }
  return 'Reply again using only the block format above.'
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

/**
 * Marker opens that end the visible portion of a reply while it is still
 * being written: everything from the first marker on belongs to the protocol,
 * not the reader.
 */
const MARKER_OPENS = [TOOL_CALL_OPEN, END_MARKER] as const

/**
 * Characters a mid-stream projection holds back so a marker split across
 * snapshots is never emitted as answer text: one less than the longest marker.
 */
const MARKER_HOLDBACK = TOOL_CALL_OPEN.length - 1

/**
 * The answer text a projection may emit next, honoring the marker holdback.
 *
 * @param projected - the snapshot's visible text.
 * @param emitted - how much of the previous projections was already emitted.
 * @returns The next safe suffix, or empty when the projection shrank, has not
 *   grown past the holdback, or reached a marker.
 */
function emittableSuffix(projected: string, emitted: number): string {
  let bound = projected.length - MARKER_HOLDBACK
  for (const marker of MARKER_OPENS) {
    const at = projected.indexOf(marker)
    if (at >= 0) bound = Math.min(bound, at)
  }
  if (bound <= emitted) return ''
  return projected.slice(emitted, bound)
}

/**
 * The answer text the final projection still owes, with no holdback left:
 * once the site has stopped writing, a projection that never grew a marker is
 * all visible answer.
 *
 * The boundary comes from the protocol's own marker stripping. A site that
 * stopped mid-marker (gemini-web left a bare `\n<<` behind) has a damaged END
 * tail there, not answer text: releasing the holdback up to `answer.length`
 * used to stream that tail, so the SSE content disagreed with the clean text
 * the final block reported.
 *
 * @param answer - the stable answer's visible text.
 * @param emitted - how much the mid-stream deltas already emitted.
 * @returns The remaining visible text, or empty when nothing is owed. Text the
 *   protocol parses after a tool call block is not re-emitted: the block-end
 *   block still carries it for non-streaming consumers.
 */
function finalSuffix(answer: string, emitted: number): string {
  let bound = visibleTextOf(answer).text.length
  for (const marker of MARKER_OPENS) {
    const at = answer.indexOf(marker)
    if (at >= 0) bound = Math.min(bound, at)
  }
  if (bound <= emitted) return ''
  return answer.slice(emitted, bound)
}

/**
 * The live-emission channel between an in-flight attempt and the streaming
 * caller. Emission commits the attempt: once text has been emitted, the
 * repair pipeline stops retrying that answer invisibly.
 */
interface ChatHubLiveSink {
  /**
   * @param text - one answer delta, safe for the consumer to show.
   */
  emit(text: string): void
  /**
   * @returns Characters emitted so far.
   */
  emittedChars(): number
}

/** Queue-backed sink the streaming caller drains while the turn runs. */
class LiveQueue implements ChatHubLiveSink {
  private readonly deltas: string[] = []
  private emitted = 0
  private waiter: (() => void) | undefined

  /** @param text - one answer delta, safe for the consumer to show. */
  emit(text: string): void {
    this.emitted += text.length
    this.deltas.push(text)
    this.waiter?.()
  }

  /** @returns Characters emitted so far. */
  emittedChars(): number {
    return this.emitted
  }

  /** @returns Deltas queued but not yet drained. */
  pending(): number {
    return this.deltas.length
  }

  /** @returns Every queued delta, leaving the queue empty. */
  take(): string[] {
    return this.deltas.splice(0)
  }

  /** Wake a waiter without queueing anything. */
  wake(): void {
    this.waiter?.()
  }

  /** @returns Resolves on the next emit or wake. */
  async idle(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.waiter = resolve
    })
  }
}

/**
 * Name the failure an attempt ended with, for its turn record.
 * @param error - rejection from one site's attempt.
 * @returns The harness failure code, or the transport code when none applies.
 */
function failureCodeOf(error: unknown): string {
  if (error instanceof LlmError) return error.code
  if (!(error instanceof Error)) return CHATHUB_LLM_TRANSPORT_CODE
  return readToken(error) ?? CHATHUB_LLM_TRANSPORT_CODE
}
