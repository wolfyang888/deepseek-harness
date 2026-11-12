/**
 * The HTTP server: OpenAI wire routes over `ctx.llm` site routes.
 *
 * `/v1/models` lists the exposed sites with their sign-in state, and
 * `/v1/chat/completions` translates one request into one adapter turn. The
 * server owns no browser state and stores nothing; login lives in the ChatHub
 * host layer and the site answer's identity stays in the external agent's own
 * conversation.
 *
 * @module @deepseek-ai/dsh-experimental-chathub-gateway/server
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { LlmError, type FinishReason, type LlmRuntime, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { failureFromError } from './errors.ts'
import { sseRenderer, toCompletionResponse, toGenerateOptions, type SseRenderer, type WireCompletionRequest } from './openai-wire.ts'
import { SiteQueues } from './queue.ts'
import { GATEWAY_NEEDS_AUTH, GATEWAY_READY, type ChatHubGatewayConfig, type GatewayFailure, type GatewayModelEntry } from './types.ts'

/** The wire failure body every error path writes. */
interface WireErrorBody {
  error: { message: string; type: string; code: string }
}

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
      'chathub-gateway: listening on %s, sites: %s',
      this.url,
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
    try {
      const url = new URL(request.url ?? '/', `http://${this.config.host}`)
      const body = await readBody(request)
      if (this.config.apiKey.length > 0 && !this.authorized(request)) {
        this.writeJson(response, 401, { error: { message: 'Invalid API key.', type: 'invalid_request_error', code: 'invalid_api_key' } } satisfies WireErrorBody)
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        this.writeJson(response, 200, { object: 'list', data: await this.models() })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        await this.completions(response, body)
        return
      }
      this.writeJson(response, 404, { error: { message: `No route: ${request.method} ${url.pathname}`, type: 'invalid_request_error', code: 'not_found' } } satisfies WireErrorBody)
    } catch (error) {
      const failure = failureFromError(error)
      // A handler that already answered leaves nothing to write; a second
      // writeHead would throw and kill the listener for every later request.
      if (response.headersSent) {
        if (!response.writableEnded) response.end()
        return
      }
      this.writeFailure(response, failure)
    }
  }

  /**
   * Handle one completion request.
   * @param response - the response writer.
   * @param body - the parsed or raw request body.
   */
  private async completions(response: ServerResponse, body: string): Promise<void> {
    let parsed: WireCompletionRequest
    try {
      parsed = JSON.parse(body) as WireCompletionRequest
    } catch {
      this.writeFailure(response, { status: 400, code: 'invalid_request_error', message: 'The request body is not valid JSON.' })
      return
    }
    if (typeof parsed.model !== 'string' || parsed.model.length === 0) {
      this.writeFailure(response, { status: 400, code: 'invalid_request_error', message: 'The request must name a model.' })
      return
    }
    const models = await this.models()
    const model = models.find(row => row.id === parsed.model)
    if (model === undefined) {
      this.writeFailure(response, {
        status: 404,
        code: 'model_not_found',
        message: `Model "${parsed.model}" is not exposed. GET /v1/models lists the exposed site models.`,
      })
      return
    }
    if (model.status === GATEWAY_NEEDS_AUTH) {
      this.writeFailure(response, {
        status: 401,
        code: 'chathub_signed_out',
        message: 'This site is signed out. Open the ChatHub panel in dsh web and sign in, then retry.',
      })
      return
    }
    const admission = this.queues.enter(parsed.model)
    if (admission.kind === 'queue-full') {
      this.writeFailure(response, {
        status: 429,
        code: 'rate_limit_exceeded',
        message: 'This site already has too many requests waiting. Retry after the delay.',
        retryAfterSeconds: 30,
      })
      return
    }
    const route = `${parsed.model}-chathub`
    let options
    try {
      options = toGenerateOptions(parsed, route)
    } catch (error) {
      this.writeFailure(response, {
        status: 400,
        code: 'invalid_request_error',
        message: error instanceof Error ? error.message : 'The request cannot be translated.',
      })
      return
    }
    const chunks: StreamChunk[] = []
    let keepalive: ReturnType<typeof setInterval> | undefined
    let sse: SseRenderer | undefined
    try {
      if (parsed.stream === true) {
        // Open the SSE stream and hold it with keepalive writes between
        // frames, so a proxy or client does not time the response out while
        // the site turn runs.
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' })
        response.write(': keepalive\n\n')
        keepalive = setInterval(() => { response.write(': keepalive\n\n') }, this.config.keepaliveMs)
        sse = sseRenderer(parsed.model)
        response.write(sse.role())
      }
      for await (const chunk of this.stream(route, options)) {
        chunks.push(chunk)
        if (sse === undefined) continue
        switch (chunk.type) {
          case 'text-delta':
            response.write(sse.content(chunk.text))
            break
          case 'block-end':
            if (chunk.block.type === 'tool-call') {
              response.write(sse.toolCall(chunk.block.id, chunk.block.name, chunk.block.arguments))
            }
            break
          default:
            break
        }
      }
    } catch (error) {
      const failure = failureFromError(error)
      // The SSE stream already carries a 200; the failure has to ride the
      // event stream, because a second status line cannot be sent.
      if (parsed.stream === true && response.headersSent) {
        this.writeStreamFailure(response, failure)
      } else {
        this.writeFailure(response, failure)
      }
      return
    } finally {
      if (keepalive !== undefined) clearInterval(keepalive)
      admission.release()
    }
    const finish = terminal(chunks)
    if (finish !== undefined && finish.reason.kind !== 'stop' && finish.reason.kind !== 'tool-calls') {
      const failure = failureFromError(new LlmError(finishReasonMessage(finish.reason), finishFailureCode(finish.reason)))
      if (parsed.stream === true) {
        // The SSE stream is already open with a 200; surface the failure as
        // an error event and close, which OpenAI-compatible clients read.
        this.writeStreamFailure(response, failure)
      } else {
        this.writeFailure(response, failure)
      }
      return
    }
    if (sse !== undefined) {
      // The adapter contract ends the stream in a finish chunk; the fallback
      // only covers streams that ended without one.
      const reason = finish?.reason.kind === 'tool-calls'
        ? 'tool_calls'
        : finish?.reason.kind === 'stop'
          ? 'stop'
          : chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call') ? 'tool_calls' : 'stop'
      response.write(sse.finish(reason))
      response.write(sse.done())
      response.end()
    } else {
      this.writeJson(response, 200, toCompletionResponse(route, parsed.model, chunks))
    }
  }

  /**
   * Read the `ctx.llm` stream for one request; a small seam for tests.
   * @param route - provider route.
   * @param options - the translated request.
   * @returns The runtime's chunk stream.
   */
  private stream(route: string, options: Parameters<LlmRuntime['stream']>[0]): AsyncIterable<StreamChunk> {
    void route
    return this.ctx.llm.stream(options)
  }

  /**
   * Check one request's bearer key.
   * @param request - the incoming request.
   * @returns Whether the presented key matches.
   */
  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization ?? ''
    return header === `Bearer ${this.config.apiKey}`
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
   * Write one gateway failure as an OpenAI wire error.
   * @param response - the response writer.
   * @param failure - the mapped failure.
   */
  private writeFailure(response: ServerResponse, failure: GatewayFailure): void {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (failure.retryAfterSeconds !== undefined) headers['retry-after'] = String(failure.retryAfterSeconds)
    response.writeHead(failure.status, headers)
    const body: WireErrorBody = {
      error: {
        message: failure.message,
        type: failure.status === 401 ? 'authentication_error' : failure.status >= 500 ? 'server_error' : 'invalid_request_error',
        code: failure.code,
      },
    }
    response.end(JSON.stringify(body))
  }

  /**
   * Surface a failure on a stream that already answered 200 by writing the
   * error event OpenAI-compatible clients read, then the closing sentinel.
   * @param response - the SSE response writer.
   * @param failure - the mapped failure.
   */
  private writeStreamFailure(response: ServerResponse, failure: GatewayFailure): void {
    const body: WireErrorBody = { error: { message: failure.message, type: 'server_error', code: failure.code } }
    response.write(`data: ${JSON.stringify(body)}\n\n`)
    response.write('data: [DONE]\n')
    response.end()
  }
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
