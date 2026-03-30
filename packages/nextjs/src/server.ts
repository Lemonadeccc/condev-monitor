import { createRequire } from 'node:module'

import type { OTelSpanProcessorLike, PrivacyOptions } from '@condev-monitor/monitor-sdk-ai'
import {
    createAISink,
    createVercelAITelemetryIntegration,
    initAIMonitor,
    NodeReporter,
    VercelAIAdapter,
} from '@condev-monitor/monitor-sdk-ai'
import { DEFAULT_TRACE_ID_HEADER } from '@condev-monitor/monitor-sdk-core'

export interface CondevServerOptions {
    /** DSN defaults to CONDEV_SERVER_DSN, then CONDEV_DSN, then NEXT_PUBLIC_CONDEV_DSN */
    dsn?: string
    privacy?: PrivacyOptions
    traceIdHeader?: string
    debug?: boolean
    additionalSpanProcessors?: OTelSpanProcessorLike[]
}

export interface CondevAIRequestContextOptions {
    request: Request
    sessionId?: string | null
    userId?: string | null
    input?: unknown
    name?: string
    model?: string
    provider?: string
    startedAt?: number
    dsn?: string
    traceIdHeader?: string
    debug?: boolean
}

export interface CondevAIRequestLifecycleEvent {
    input?: unknown
    name?: string
    model?: string
    provider?: string
    error?: unknown
    startedAt?: number
    failureMode?: string
}

export interface CondevAIRequestContext {
    traceId: string
    sessionId?: string
    userId?: string
    abortSignal: AbortSignal
    telemetry: {
        isEnabled: true
        metadata: Record<string, string>
    }
    stream<T extends StreamTextOptionsLike>(options: T): T
    emitError(event?: CondevAIRequestLifecycleEvent): Promise<void>
    emitCancelled(event?: Omit<CondevAIRequestLifecycleEvent, 'failureMode'>): Promise<void>
    emitToolError(event: CondevAIRequestLifecycleEvent & { toolName: string }): Promise<void>
}

export interface CondevStreamTextResponseOptions<T extends AIStreamTextOptions = AIStreamTextOptions>
    extends CondevAIRequestContextOptions {
    stream: T
}

let _serverRegistered = false

type MutableTracerProvider = {
    addSpanProcessor?: (processor: OTelSpanProcessorLike) => void
    getDelegate?: () => unknown
    setDelegate?: (delegate: unknown) => void
    _activeSpanProcessor?: {
        _spanProcessors?: unknown[]
    }
}

type AIStreamTextFn = (typeof import('ai'))['streamText']
type AIStreamTextOptions = Parameters<AIStreamTextFn>[0] & StreamTextOptionsLike
type AIStreamTextResult = ReturnType<AIStreamTextFn>
type AIObservationReporter = Pick<NodeReporter, 'send'>
type StreamToolLike = { execute?: (...args: unknown[]) => unknown }
type StreamTextOptionsLike = {
    abortSignal?: AbortSignal
    experimental_telemetry?: {
        isEnabled?: boolean
        metadata?: Record<string, unknown>
    }
    onError?: ((event: { error: unknown }) => unknown | Promise<unknown>) | undefined
    onAbort?: ((...args: unknown[]) => unknown | Promise<unknown>) | undefined
    tools?: Record<string, StreamToolLike>
}

function resolveCondevDsn(dsn?: string): string | undefined {
    return dsn ?? process.env.CONDEV_SERVER_DSN ?? process.env.CONDEV_DSN ?? process.env.NEXT_PUBLIC_CONDEV_DSN
}

function normalizeValue(value?: string | null): string | undefined {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

function toErrorMessage(error?: unknown): string {
    if (error instanceof Error) return error.message
    if (error == null) return ''
    return String(error)
}

function toIso(timestampMs: number): string {
    return new Date(timestampMs).toISOString()
}

async function emitObservation(reporter: AIObservationReporter | null, event: Record<string, unknown>): Promise<void> {
    if (!reporter) return
    reporter.send(event)
}

function resolveAIModule(): { streamText: AIStreamTextFn } {
    const runtimeRequire = createRequire(`${process.cwd()}/package.json`)
    return runtimeRequire('ai') as { streamText: AIStreamTextFn }
}

function createStreamInitErrorResponse(error: unknown): Response {
    const status =
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        typeof (error as { status?: unknown }).status === 'number' &&
        Number.isFinite((error as { status: number }).status)
            ? (error as { status: number }).status
            : 500

    const code = status === 429 ? 'RATE_LIMIT' : status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : 'STREAM_INIT_FAILED'

    const publicMessage =
        status === 429
            ? 'Rate limit exceeded'
            : status === 401
              ? 'Unauthorized'
              : status === 403
                ? 'Forbidden'
                : 'Failed to start streaming chat completion'

    return Response.json(
        {
            error: {
                code,
                message: publicMessage,
                retryable: status === 429 || status >= 500,
            },
        },
        { status: status >= 400 ? status : 500 }
    )
}

function createObservationBase(options: CondevAIRequestContextOptions, traceId: string, event?: CondevAIRequestLifecycleEvent) {
    return {
        source: 'node-sdk',
        framework: 'manual-fallback',
        traceId,
        sessionId: normalizeValue(options.sessionId) ?? '',
        userId: normalizeValue(options.userId) ?? '',
        model: normalizeValue(event?.model) ?? normalizeValue(options.model) ?? '',
        provider: normalizeValue(event?.provider) ?? normalizeValue(options.provider) ?? '',
    }
}

export function createCondevAIRequestContext(options: CondevAIRequestContextOptions): CondevAIRequestContext {
    const traceIdHeader = options.traceIdHeader ?? DEFAULT_TRACE_ID_HEADER
    const traceId = normalizeValue(options.request.headers.get(traceIdHeader)) ?? crypto.randomUUID()
    const sessionId = normalizeValue(options.sessionId)
    const userId = normalizeValue(options.userId)
    const dsn = resolveCondevDsn(options.dsn)
    const reporter = dsn ? new NodeReporter({ dsn, debug: options.debug }) : null
    const requestStartedAt = options.startedAt ?? Date.now()
    let toolErrorReported = false

    const emitError = async (event?: CondevAIRequestLifecycleEvent) => {
        const startedAtMs = event?.startedAt ?? requestStartedAt
        const endedAtMs = Date.now()

        await emitObservation(reporter, {
            event_type: 'ai_span',
            ...createObservationBase(options, traceId, event),
            spanId: traceId,
            parentSpanId: '',
            spanKind: 'entrypoint',
            name: event?.name ?? options.name ?? 'ai.streamText',
            status: 'error',
            startedAt: toIso(startedAtMs),
            endedAt: toIso(endedAtMs),
            durationMs: endedAtMs - startedAtMs,
            input: event?.input ?? options.input,
            errorMessage: toErrorMessage(event?.error),
            metadata: {
                finishReason: 'error',
                failureMode: event?.failureMode ?? 'runtime',
                fallback: true,
            },
        })
    }

    const emitCancelled = async (event?: Omit<CondevAIRequestLifecycleEvent, 'failureMode'>) => {
        const startedAtMs = event?.startedAt ?? requestStartedAt
        const endedAtMs = Date.now()

        await emitObservation(reporter, {
            event_type: 'ai_span',
            ...createObservationBase(options, traceId, event),
            spanId: `${traceId}:cancelled`,
            parentSpanId: traceId,
            spanKind: 'event',
            name: event?.name ?? 'stream.cancelled',
            status: 'cancelled',
            startedAt: toIso(startedAtMs),
            endedAt: toIso(endedAtMs),
            durationMs: endedAtMs - startedAtMs,
            input: event?.input ?? options.input,
            errorMessage: toErrorMessage(event?.error),
            metadata: {
                finishReason: 'cancelled',
                fallback: true,
            },
        })
    }

    const emitToolError = async (event: CondevAIRequestLifecycleEvent & { toolName: string }) => {
        toolErrorReported = true
        const startedAtMs = event.startedAt ?? requestStartedAt
        const endedAtMs = Date.now()
        const errorMessage = toErrorMessage(event.error)

        await emitObservation(reporter, {
            event_type: 'ai_span',
            ...createObservationBase(options, traceId, event),
            spanId: `${traceId}:tool:${event.toolName}`,
            parentSpanId: traceId,
            spanKind: 'tool',
            name: event.toolName,
            status: 'error',
            startedAt: toIso(startedAtMs),
            endedAt: toIso(endedAtMs),
            durationMs: endedAtMs - startedAtMs,
            input: event.input ?? options.input,
            errorMessage,
            metadata: {
                failureMode: event.failureMode ?? 'tool',
                fallback: true,
            },
        })

        await emitError({
            ...event,
            startedAt: startedAtMs,
            error: errorMessage,
            failureMode: event.failureMode ?? 'tool',
        })
    }

    const stream = <T extends StreamTextOptionsLike>(streamOptions: T): T => {
        const wrappedTools = streamOptions.tools
            ? Object.fromEntries(
                  Object.entries(streamOptions.tools).map(([toolName, definition]) => {
                      if (!definition || typeof definition !== 'object' || typeof definition.execute !== 'function') {
                          return [toolName, definition]
                      }

                      const execute = definition.execute
                      return [
                          toolName,
                          {
                              ...definition,
                              execute: async (...args: unknown[]) => {
                                  try {
                                      return await execute(...args)
                                  } catch (error) {
                                      await emitToolError({
                                          toolName,
                                          error,
                                          startedAt: requestStartedAt,
                                          input: args[0],
                                          failureMode: 'tool',
                                      })
                                      throw error
                                  }
                              },
                          },
                      ]
                  })
              )
            : undefined

        return {
            ...streamOptions,
            abortSignal: streamOptions.abortSignal ?? options.request.signal,
            tools: wrappedTools as T['tools'],
            experimental_telemetry: {
                ...(streamOptions.experimental_telemetry ?? {}),
                isEnabled: true,
                metadata: {
                    ...(streamOptions.experimental_telemetry?.metadata ?? {}),
                    condevTraceId: traceId,
                    ...(sessionId && { condevSessionId: sessionId }),
                    ...(userId && { condevUserId: userId }),
                },
            },
            onError: async event => {
                if (!toolErrorReported) {
                    await emitError({
                        error: event.error,
                        startedAt: requestStartedAt,
                    })
                }
                await streamOptions.onError?.(event)
            },
            onAbort: async (...args: unknown[]) => {
                await emitCancelled({
                    name: 'stream.cancelled',
                    error: 'Stream aborted by client',
                    startedAt: requestStartedAt,
                })
                await streamOptions.onAbort?.(...args)
            },
        }
    }

    return {
        traceId,
        sessionId,
        userId,
        abortSignal: options.request.signal,
        telemetry: {
            isEnabled: true,
            metadata: {
                condevTraceId: traceId,
                ...(sessionId && { condevSessionId: sessionId }),
                ...(userId && { condevUserId: userId }),
            },
        },
        stream,
        emitError,
        emitCancelled,
        emitToolError,
    }
}

export function streamTextWithCondev<T extends AIStreamTextOptions>(options: CondevStreamTextResponseOptions<T>): AIStreamTextResult {
    const { stream, ...contextOptions } = options
    const condev = createCondevAIRequestContext(contextOptions)
    const { streamText } = resolveAIModule()

    try {
        return streamText(condev.stream(stream))
    } catch (error) {
        void condev.emitError({
            error,
            startedAt: contextOptions.startedAt,
            model: contextOptions.model,
            provider: contextOptions.provider,
        })
        throw error
    }
}

export async function streamTextResponseWithCondev<T extends AIStreamTextOptions>(
    options: CondevStreamTextResponseOptions<T>
): Promise<Response> {
    const { stream, ...contextOptions } = options
    const condev = createCondevAIRequestContext(contextOptions)
    const { streamText } = resolveAIModule()

    try {
        const result = streamText(condev.stream(stream))
        return result.toUIMessageStreamResponse()
    } catch (error) {
        try {
            await condev.emitError({
                error,
                startedAt: contextOptions.startedAt,
                model: contextOptions.model,
                provider: contextOptions.provider,
            })
        } catch {
            // Ignore fallback-reporting errors and return the original request failure response.
        }

        return createStreamInitErrorResponse(error)
    }
}

/**
 * Call in `instrumentation.ts` register() function.
 * Sets up AI telemetry span processor and registers it with OTel.
 * Idempotent: repeated calls (HMR, tests) are no-ops.
 */
export async function registerCondevServer(options?: CondevServerOptions): Promise<void> {
    if (_serverRegistered) return
    _serverRegistered = true

    const dsn = options?.dsn ?? process.env.CONDEV_SERVER_DSN ?? process.env.CONDEV_DSN ?? process.env.NEXT_PUBLIC_CONDEV_DSN
    if (!dsn) {
        console.warn('[condev-monitor] No DSN provided. Set CONDEV_SERVER_DSN or pass dsn option.')
        return
    }

    const sink = createAISink({ dsn, debug: options?.debug })
    const adapter = new VercelAIAdapter(sink)
    const processor = initAIMonitor({
        dsn,
        adapter,
        privacy: options?.privacy,
        traceIdHeader: options?.traceIdHeader,
        debug: options?.debug,
    })

    const allProcessors: OTelSpanProcessorLike[] = [processor, ...(options?.additionalSpanProcessors ?? [])]

    await registerAISDKTelemetryIntegration({
        dsn,
        privacy: options?.privacy,
        traceIdHeader: options?.traceIdHeader,
        debug: options?.debug,
    })

    try {
        const { trace } = await import('@opentelemetry/api')
        const provider = trace.getTracerProvider() as MutableTracerProvider
        const delegate = typeof provider.getDelegate === 'function' ? provider.getDelegate() : undefined

        // OTel v1 providers expose addSpanProcessor directly.
        if (typeof provider.addSpanProcessor === 'function') {
            for (const p of allProcessors) provider.addSpanProcessor(p)
            if (options?.debug) {
                console.info('[condev-monitor] Attached AI span processor to global tracer provider')
            }
            return
        }

        // In newer OTel builds the global provider is usually a ProxyTracerProvider.
        // If its delegate is mutable, attach there.
        const mutableDelegate = delegate as MutableTracerProvider | undefined
        if (mutableDelegate && typeof mutableDelegate.addSpanProcessor === 'function') {
            for (const p of allProcessors) mutableDelegate.addSpanProcessor(p)
            if (options?.debug) {
                console.info('[condev-monitor] Attached AI span processor to tracer delegate')
            }
            return
        }

        // OTel v2 BasicTracerProvider has no addSpanProcessor(). If we can swap the
        // proxy delegate, rebuild the delegate with the existing processors plus ours.
        const { BasicTracerProvider } = await import('@opentelemetry/sdk-trace-base')
        if (typeof provider.setDelegate === 'function') {
            const existingProcessors = extractSpanProcessors(delegate)
            const nextProvider = new BasicTracerProvider({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                spanProcessors: [...existingProcessors, ...allProcessors] as any[],
            })
            provider.setDelegate(nextProvider)
            if (options?.debug) {
                console.info(
                    `[condev-monitor] Replaced tracer delegate with ${existingProcessors.length + allProcessors.length} span processor(s)`
                )
            }
            return
        }

        // Final fallback: attempt to install our own global provider in clean runtimes.
        const ownProvider = new BasicTracerProvider({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            spanProcessors: allProcessors as any[],
        })
        const didSet = trace.setGlobalTracerProvider(ownProvider)
        if (options?.debug) {
            console.info(`[condev-monitor] Registered fallback tracer provider: ${didSet ? 'ok' : 'skipped'}`)
        }
    } catch (e) {
        if (options?.debug) {
            console.warn('[condev-monitor] OTel registration failed:', e)
        }
    }
}

async function registerAISDKTelemetryIntegration(options: {
    dsn: string
    privacy?: PrivacyOptions
    traceIdHeader?: string
    debug?: boolean
}): Promise<void> {
    try {
        const runtimeRequire = createRequire(`${process.cwd()}/package.json`)
        const aiModule = runtimeRequire('ai') as {
            bindTelemetryIntegration?: (integration: unknown) => unknown
            registerTelemetryIntegration?: (integration: unknown) => void
        }

        if (typeof aiModule.registerTelemetryIntegration !== 'function') {
            return
        }

        const integration = createVercelAITelemetryIntegration(options)
        const bound = typeof aiModule.bindTelemetryIntegration === 'function' ? aiModule.bindTelemetryIntegration(integration) : integration

        aiModule.registerTelemetryIntegration(bound)

        if (options.debug) {
            console.info('[condev-monitor] Registered AI SDK telemetry integration')
        }
    } catch (error) {
        if (options.debug) {
            console.warn('[condev-monitor] AI SDK telemetry integration registration skipped:', error)
        }
    }
}

function extractSpanProcessors(provider: unknown): OTelSpanProcessorLike[] {
    if (!provider || typeof provider !== 'object') return []

    const active = (provider as MutableTracerProvider)._activeSpanProcessor
    if (!active || !Array.isArray(active._spanProcessors)) return []

    return active._spanProcessors.filter(isSpanProcessorLike) as OTelSpanProcessorLike[]
}

function isSpanProcessorLike(value: unknown): boolean {
    return !!value && typeof value === 'object' && typeof (value as { onEnd?: unknown }).onEnd === 'function'
}
