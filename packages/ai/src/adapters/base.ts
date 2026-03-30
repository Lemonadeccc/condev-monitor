export interface AIReporter {
    send(event: Record<string, unknown>): void
    flush?(): Promise<void>
}

export interface PrivacyOptions {
    /** Capture the raw prompt text. Default: false */
    capturePrompt?: boolean
    /** Capture tool call payloads. Default: false */
    captureToolCalls?: boolean
}

/**
 * Minimal OTel-compatible SpanProcessor interface.
 * Allows condev adapters to be used as OTel span processors
 * without requiring a direct dependency on @opentelemetry/sdk-trace-base.
 */
export interface OTelSpanProcessorLike {
    onStart(span: unknown, parentContext: unknown): void
    onEnding?(span: unknown): void
    onEnd(span: unknown): void
    forceFlush(): Promise<void>
    shutdown(): Promise<void>
}

export interface AIAdapterContext {
    reporter: AIReporter
    privacy: PrivacyOptions
    traceIdHeader: string
    debug?: boolean
}

/**
 * Abstract adapter interface for AI SDK providers.
 *
 * Extension patterns (following Sentry conventions):
 * - OpenAI:    ES Proxy wrapping
 * - Anthropic: AsyncIterable generator wrapping
 * - Google:    AsyncIterable generator wrapping
 * - LangChain: Callback handler pattern
 * - Vercel AI: OTel SpanProcessor
 */
export interface AIAdapter<P extends OTelSpanProcessorLike = OTelSpanProcessorLike> {
    readonly name: string
    install(ctx: AIAdapterContext): P
    shutdown?(): Promise<void>
}
