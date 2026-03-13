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
 * Abstract adapter interface for AI SDK providers.
 *
 * Extension patterns (following Sentry conventions):
 * - OpenAI:    ES Proxy wrapping
 * - Anthropic: AsyncIterable generator wrapping
 * - Google:    AsyncIterable generator wrapping
 * - LangChain: Callback handler pattern
 * - Vercel AI: OTel SpanProcessor
 */
export interface AIAdapter {
    readonly name: string
    install(ctx: { reporter: AIReporter; privacy: PrivacyOptions; traceIdHeader: string }): unknown
    shutdown?(): Promise<void>
}
