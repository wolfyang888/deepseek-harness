/**
 * The HTTP server: OpenAI and Anthropic wire routes over `ctx.llm` site routes.
 *
 * `/v1/models` lists the exposed sites with their sign-in state;
 * `/v1/chat/completions` and `/v1/messages` translate one request into one
 * adapter turn and render the answer in the caller's wire. Both wires share
 * one turn loop and differ only through their {@link WireCodec}, so admission,
 * routing, queueing, and failure mapping cannot drift between them.
 *
 * The bare `/models`, `/chat/completions`, and `/messages` paths are accepted
 * as aliases for clients that append those suffixes to a root base URL. The
 * server owns no browser state and stores nothing; login lives in the ChatHub
 * host layer and the site answer's identity stays in the external agent's own
 * conversation.
 *
 * @module @deepseek-ai/dsh-experimental-chathub-gateway/server
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { LlmError, type FinishReason, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  anthropicErrorBody,
  anthropicWireCodec,
  toGenerateOptionsFromAnthropic,
  type AnthropicRequest,
} from './anthropic-wire.ts'
import { failureFromError } from './errors.ts'
import {
  openAiErrorBody,
  openAiWireCodec,
  toGenerateOptions,
  type WireCompletionRequest,
} from './openai-wire.ts'
import { SiteQueues } from './queue.ts'
import {
  GATEWAY_NEEDS_AUTH,
  GATEWAY_READY,
  type ChatHubGatewayConfig,
  type GatewayFailure,
  type GatewayModelEntry,
  type Wire,
  type WireCodec,
} from './types.ts'

/** One translated request, or the failure that refuses it. */
type Translation =
  | { kind: 'request'; model: string; stream: boolean; options: GenerateOptions }
  | { kind: 'failure'; failure: GatewayFailure }

/**
 * One ChatHub site gateway: HTTP listener plus the site roster it exposes.
 */
export class ChatHubGateway {
  private readonly queues: SiteQueues
  private server: Server | undefined

  /**
   * @param ctx - context carrying `llm` and the mounted `webChatTransport`.
   * @param config - resolved gateway configuration.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: ChatHubGatewayConfig,
  ) {
    this.queues = new SiteQueues(config.maxQueuePerSite)
  }

  /**
   * Start listening and register shutdown with the context effect.
   *
   * `port: 0` binds an ephemeral port; the resolved URL names it.
   * @returns The bound base URL, once the listener is ready.
   * @throws The bind error, so a taken port fails the mount loudly.
   */
  async start(): Promise<string> {
    const server = createServer((request, response) => { void this.dispatch(request, response) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.config.port, this.config.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    this.ctx.effect(() => () => {
      // Keep-alive connections would hold the port past close; dropping them
      // first makes the disposer release the port for a next listener on the
      // same address.
      server.closeAllConnections()
      server.close()
    })
    this.ctx.logger.info(
      'chathub-gateway: listening on %s, wires: %s, sites: %s',
      this.url,
      this.config.wires.join(','),
      this.config.sites.length === 0 ? '(all mounted)' : this.config.sites.join(','),
    )
    return this.url
  }

  /** The bound base URL; meaningful once {@link start} has resolved. */
  get url(): string {
    const address = this.server?.address()
    if (address === undefined || address === null || typeof address === 'string') {
      return `http://${this.config.host}:${this.config.port}`
    }
    return `http://${this.config.host}:${address.port}`
  }

  /**
   * The exposed models with sign-in state, read from the transport health.
   * @returns One row per exposed site.
   */
  async models(): Promise<readonly GatewayModelEntry[]> {
    const providers = await this.ctx.webChatTransport.providers()
    const exposed = this.config.sites.length === 0
      ? providers.map(provider => provider.id)
      : this.config.sites
    const rows: GatewayModelEntry[] = []
    for (const id of exposed) {
      const provider = providers.find(candidate => candidate.id === id)
      // A configured site the transport does not know is a mount-order or
      // typo defect; listing it as needs-auth would hide that behind a login
      // screen that cannot fix it.
      if (provider === undefined) continue
      rows.push({
        id,
        object: 'model',
        owned_by: 'chathub',
        status: provider.health.status === GATEWAY_READY ? GATEWAY_READY : GATEWAY_NEEDS_AUTH,
      })
    }
    return rows
  }

  /**
   * Route one request to its handler.
   * @param request - the incoming request.
   * @param response - the response writer.
   */
  private async dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let wire: Wire = 'openai'
    try {
      const url = new URL(request.url ?? '/', `http://${this.config.host}`)
      const route = normalizeRoute(url.pathname)
      wire = route === '/v1/messages' ? 'anthropic' : 'openai'
      this.ctx.logger.info('chathub-gateway: %s %s (%s)', request.method, url.pathname, wire)
      const body = await readBody(request)
      if (this.config.apiKey.length > 0 && !this.authorized(request)) {
        this.writeFailure(response, { status: 401, code: 'invalid_api_key', message: 'Invalid API key.' }, wire)
        return
      }
      if (request.method === 'GET' && route === '/v1/models') {
        this.writeJson(response, 200, { object: 'list', data: await this.models() })
        return
      }
      if (request.method === 'POST' && route === '/v1/chat/completions' && this.config.wires.includes('openai')) {
        await this.turn(response, body, 'openai')
        return
      }
      if (request.method === 'POST' && route === '/v1/messages' && this.config.wires.includes('anthropic')) {
        await this.turn(response, body, 'anthropic')
        return
      }
      this.ctx.logger.warn('chathub-gateway: no route for %s %s', request.method, url.pathname)
      this.writeFailure(response, {
        status: 404,
        code: 'not_found',
        message: `No route: ${request.method} ${url.pathname}`,
      }, wire)
    } catch (error) {
      const failure = failureFromError(error)
      // A handler that already answered leaves nothing to write; a second
      // writeHead would throw and kill the listener for every later request.
      if (response.headersSent) {
        if (!response.writableEnded) response.end()
        return
      }
      this.writeFailure(response, failure, wire)
    }
  }

  /**
   * Run one turn of the given wire: translate, admit, stream, and render.
   * @param response - the response writer.
   * @param body - the raw request body.
   * @param wire - the wire the route answers in.
   */
  private async turn(response: ServerResponse, body: string, wire: Wire): Promise<void> {
    const translated = translate(body, wire)
    if (translated.kind === 'failure') {
      this.writeFailure(response, translated.failure, wire)
      return
    }
    const { model, stream, options } = translated
    const models = await this.models()
    if (!models.some(row => row.id === model)) {
      this.writeFailure(response, {
        status: 404,
        code: 'model_not_found',
        message: `Model "${model}" is not exposed. GET /v1/models lists the exposed site models.`,
      }, wire)
      return
    }
    // Do not reject on `needs-auth`: health probing never opens a browser, so
    // that status also covers a signed-in site whose session simply has not
    // been opened yet. The adapter's transport.open()/waitForInput is the real
    // sign-in check; a genuinely signed-out site fails there as an AUTH turn,
    // which failureFromError maps to the same 401 chathub_signed_out. Rejecting
    // here would make a logged-in profile permanently unusable until someone
    // opened the panel by hand.
    const admission = this.queues.enter(model)
    if (admission.kind === 'queue-full') {
      this.writeFailure(response, {
        status: 429,
        code: 'rate_limit_exceeded',
        message: 'This site already has too many requests waiting. Retry after the delay.',
        retryAfterSeconds: 30,
      }, wire)
      return
    }
    const codec = wire === 'anthropic' ? anthropicWireCodec(model) : openAiWireCodec(model)
    const chunks: StreamChunk[] = []
    let keepalive: ReturnType<typeof setInterval> | undefined
    try {
      if (stream) {
        // Open the SSE stream and hold it with keepalive writes between
        // frames, so a proxy or client does not time the response out while
        // the site turn runs.
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' })
        response.write(codec.keepalive)
        keepalive = setInterval(() => { response.write(codec.keepalive) }, this.config.keepaliveMs)
        this.writeFrames(response, codec.openStream())
      }
      for await (const chunk of this.ctx.llm.stream(options)) {
        chunks.push(chunk)
        if (!stream) continue
        this.writeFrames(response, codec.renderChunk(chunk))
      }
    } catch (error) {
      const failure = failureFromError(error)
      // The SSE stream already carries a 200; the failure has to ride the
      // event stream, because a second status line cannot be sent.
      if (stream && response.headersSent) {
        this.writeStreamFailure(response, failure, codec)
      } else {
        this.writeFailure(response, failure, wire)
      }
      return
    } finally {
      if (keepalive !== undefined) clearInterval(keepalive)
      admission.release()
    }
    const finish = terminal(chunks)
    if (finish !== undefined && finish.reason.kind !== 'stop' && finish.reason.kind !== 'tool-calls') {
      const failure = failureFromError(new LlmError(finishReasonMessage(finish.reason), finishFailureCode(finish.reason)))
      if (stream) {
        // The SSE stream is already open with a 200; surface the failure on
        // the open stream rather than attempting a second status line.
        this.writeStreamFailure(response, failure, codec)
      } else {
        this.writeFailure(response, failure, wire)
      }
      return
    }
    if (stream) {
      this.writeFrames(response, codec.closeStream())
      response.end()
      return
    }
    this.writeJson(response, 200, codec.responseBody(model, chunks))
  }

  /**
   * Check one request's key: OpenAI clients send a bearer token, Anthropic
   * clients send `x-api-key`.
   * @param request - the incoming request.
   * @returns Whether a presented key matches.
   */
  private authorized(request: IncomingMessage): boolean {
    if (request.headers.authorization === `Bearer ${this.config.apiKey}`) return true
    return request.headers['x-api-key'] === this.config.apiKey
  }

  /**
   * Write one JSON answer.
   * @param response - the response writer.
   * @param status - HTTP status.
   * @param body - the serializable body.
   */
  private writeJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }

  /**
   * Write one SSE frame list in order.
   * @param response - the response writer.
   * @param frames - the frames to write.
   */
  private writeFrames(response: ServerResponse, frames: readonly string[]): void {
    for (const frame of frames) response.write(frame)
  }

  /**
   * Write one gateway failure in the wire's error envelope.
   * @param response - the response writer.
   * @param failure - the mapped failure.
   * @param wire - the wire the route answers in.
   */
  private writeFailure(response: ServerResponse, failure: GatewayFailure, wire: Wire): void {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (failure.retryAfterSeconds !== undefined) headers['retry-after'] = String(failure.retryAfterSeconds)
    response.writeHead(failure.status, headers)
    response.end(JSON.stringify(wire === 'anthropic' ? anthropicErrorBody(failure) : openAiErrorBody(failure)))
  }

  /**
   * Surface a failure on a stream that already answered 200, using the wire's
   * error event so the client sees the failure instead of a silent truncation.
   * @param response - the SSE response writer.
   * @param failure - the mapped failure.
   * @param codec - the codec of the open stream.
   */
  private writeStreamFailure(response: ServerResponse, failure: GatewayFailure, codec: WireCodec): void {
    this.writeFrames(response, codec.streamFailure(failure))
    response.end()
  }
}

/**
 * Translate one request body into adapter options for its wire.
 * @param body - the raw request body.
 * @param wire - the wire the route answers in.
 * @returns The translated request, or a 400 failure naming the first field
 *   that cannot be translated.
 */
function translate(body: string, wire: Wire): Translation {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { kind: 'failure', failure: { status: 400, code: 'invalid_request_error', message: 'The request body is not valid JSON.' } }
  }
  try {
    if (wire === 'anthropic') {
      const request = parsed as AnthropicRequest
      const model = modelOf(request.model)
      return {
        kind: 'request',
        model,
        stream: request.stream === true,
        options: toGenerateOptionsFromAnthropic(request, routeOf(model)),
      }
    }
    const request = parsed as WireCompletionRequest
    const model = modelOf(request.model)
    return {
      kind: 'request',
      model,
      stream: request.stream === true,
      options: toGenerateOptions(request, routeOf(model)),
    }
  } catch (error) {
    return {
      kind: 'failure',
      failure: {
        status: 400,
        code: 'invalid_request_error',
        message: error instanceof Error ? error.message : 'The request cannot be translated.',
      },
    }
  }
}

/**
 * Read the required model id of one request.
 * @param model - the parsed model field.
 * @returns The model id.
 * @throws Error when the request names no model.
 */
function modelOf(model: unknown): string {
  if (typeof model !== 'string' || model.length === 0) throw new Error('The request must name a model.')
  return model
}

/**
 * Resolve the `llm-chathub` provider route of one site model id.
 * @param model - site id such as `glm-web`.
 * @returns The provider route, for example `glm-web-chathub`.
 */
function routeOf(model: string): string {
  return `${model}-chathub`
}

/**
 * Canonicalize a request path.
 *
 * OpenAI-compatible clients disagree on what a "base URL" means: the OpenAI
 * SDK appends `/chat/completions` to a base that already carries `/v1`, while
 * custom-model forms such as WorkBuddy's append the same suffix to whatever
 * the user typed. A user who enters `http://host:8787` therefore reaches
 * `/chat/completions`, and a GET probe reaches `/models`. Accept those bare
 * aliases so both conventions work against one gateway; Anthropic clients get
 * the same treatment for `/messages`.
 * @param pathname - the requested path.
 * @returns The canonical gateway route.
 */
function normalizeRoute(pathname: string): string {
  if (pathname === '/models' || pathname === '/chat/completions' || pathname === '/messages') return `/v1${pathname}`
  return pathname
}

/**
 * Read one request body as text, size-capped to reject obvious abuse.
 * @param request - the incoming request.
 * @returns The body text.
 */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 32 * 1024 * 1024) {
        reject(new Error('Request body exceeds 32 MiB.'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    request.on('error', reject)
  })
}

/**
 * Find the terminal finish chunk of one turn.
 * @param chunks - adapter chunks in order.
 * @returns The finish chunk, or undefined when the turn produced none.
 */
function terminal(chunks: readonly StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> | undefined {
  return chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')
}

/** The finish reasons the error paths handle; successful stops return normally. */
type UnsuccessfulFinish = Exclude<FinishReason, { kind: 'stop' } | { kind: 'tool-calls' }>

/**
 * Render one non-successful finish reason as a message.
 * @param reason - the finish reason.
 * @returns A user-facing message.
 */
function finishReasonMessage(reason: UnsuccessfulFinish): string {
  switch (reason.kind) {
    case 'aborted':
      return 'The turn was aborted before the site answered.'
    case 'error':
      return reason.failure.message
    case 'max-tokens':
      return 'The site answer hit the declared output cap.'
    default:
      return reason satisfies never
  }
}

/**
 * Name the stable failure code of a non-successful finish reason so the
 * non-streaming error path reuses the failure mapping.
 * @param reason - the finish reason.
 * @returns The LlmError code `classifyFailure` maps.
 */
function finishFailureCode(reason: UnsuccessfulFinish): string {
  switch (reason.kind) {
    case 'aborted':
      return 'ABORTED'
    case 'error':
      return reason.failure.code
    case 'max-tokens':
      return 'MAX_TOKENS'
    default:
      return reason satisfies never
  }
}
