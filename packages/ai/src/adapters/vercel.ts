import type { AIEventSink, CondevObservationEvent } from '../sink'
import type { AIAdapter, AIAdapterContext, AIReporter, OTelSpanProcessorLike, PrivacyOptions } from './base'

interface SpanContext {
    traceId: string
    spanId: string
}

interface ReadableSpan {
    name: string
    attributes: Record<string, unknown>
    startTime: [number, number]
    endTime: [number, number]
    spanContext(): SpanContext
}

interface Span {
    spanContext(): SpanContext
}

interface SpanProcessor {
    onStart(span: Span): void
    onEnd(span: ReadableSpan): void
    forceFlush(): Promise<void>
    shutdown(): Promise<void>
}

export class VercelAIAdapter implements AIAdapter {
    readonly name = 'vercel-ai'
    private processor: VercelAISpanProcessor | null = null

    /**
     * @param sink Optional AIEventSink for dual-write to ai_spans table.
     *   When provided, each Vercel AI span is emitted as both `ai_streaming`
     *   (existing /ai-streaming UI) and `ai_span` (new AI observability tables).
     */
    constructor(private readonly sink?: AIEventSink) {}

    install(ctx: AIAdapterContext): OTelSpanProcessorLike {
        this.processor = new VercelAISpanProcessor(ctx.reporter, ctx.privacy, ctx.traceIdHeader, this.sink, ctx.debug ?? false)
        return this.processor
    }

    async shutdown(): Promise<void> {
        await this.processor?.shutdown()
    }
}

class VercelAISpanProcessor implements SpanProcessor {
    constructor(
        private reporter: AIReporter,
        private privacy: PrivacyOptions,
        private traceIdHeader: string,
        private sink?: AIEventSink,
        private debug: boolean = false
    ) {}

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onStart(_span: Span): void {
        // no-op — we only collect data on span end
    }

    onEnd(span: ReadableSpan): void {
        if (!span.name.startsWith('ai.')) return

        const a = span.attributes
        const traceId = str(a['ai.telemetry.metadata.condevTraceId']) ?? str(a[`ai.request.headers.${this.traceIdHeader}`])

        if (this.debug) {
            console.info('[condev-ai] span end', span.name, {
                operationId: str(a['ai.operationId']),
                metadataTraceId: str(a['ai.telemetry.metadata.condevTraceId']),
                headerTraceId: str(a[`ai.request.headers.${this.traceIdHeader}`]),
            })
        }

        // Drop spans without a condev traceId — no way to correlate with network layer
        if (!traceId) {
            if (this.debug) {
                console.warn('[condev-ai] drop ai span without traceId', span.name)
            }
            return
        }

        const startMs = span.startTime[0] * 1000 + span.startTime[1] / 1e6
        const endMs = span.endTime[0] * 1000 + span.endTime[1] / 1e6

        this.reporter.send({
            event_type: 'ai_streaming',
            type: 'ai_semantic',
            layer: 'semantic',
            traceId,
            ai: {
                system: 'vercel-ai',
                model: a['ai.model.id'] ?? a['gen_ai.request.model'],
                provider: a['ai.model.provider'] ?? a['gen_ai.system'],
                usage: {
                    inputTokens: toNum(a['ai.usage.inputTokens'] ?? a['gen_ai.usage.input_tokens']),
                    outputTokens: toNum(a['ai.usage.outputTokens'] ?? a['gen_ai.usage.output_tokens']),
                },
                response: {
                    finishReason: str(a['ai.response.finishReason'] ?? a['gen_ai.response.finish_reasons']),
                    msToFirstChunk: toNum(a['ai.response.msToFirstChunk']),
                    msToFinish: toNum(a['ai.response.msToFinish']),
                    avgCompletionTokensPerSecond: toNum(a['ai.response.avgCompletionTokensPerSecond']),
                    toolCalls: this.privacy.captureToolCalls === true ? safeJson(a['ai.response.toolCalls']) : undefined,
                },
                prompt: this.privacy.capturePrompt ? safeJson(a['ai.prompt']) : undefined,
            },
            startedAt: startMs,
            endedAt: endMs,
            durationMs: endMs - startMs,
        })

        if (this.sink) {
            this.sink.emit(this.toObservationEvent(span, traceId, startMs, endMs))
        }
    }

    private toObservationEvent(span: ReadableSpan, traceId: string, startMs: number, endMs: number): CondevObservationEvent {
        const a = span.attributes
        return {
            event_type: 'ai_span',
            source: 'node-sdk',
            framework: 'vercel-ai',
            traceId,
            spanId: span.spanContext().spanId,
            spanKind: 'llm',
            name: span.name,
            model: str(a['ai.model.id'] ?? a['gen_ai.request.model']),
            provider: str(a['ai.model.provider'] ?? a['gen_ai.system']),
            inputTokens: toNum(a['ai.usage.inputTokens'] ?? a['gen_ai.usage.input_tokens']),
            outputTokens: toNum(a['ai.usage.outputTokens'] ?? a['gen_ai.usage.output_tokens']),
            sessionId: str(a['ai.telemetry.metadata.condevSessionId']),
            userId: str(a['ai.telemetry.metadata.condevUserId']),
            startedAt: new Date(startMs).toISOString(),
            endedAt: new Date(endMs).toISOString(),
            durationMs: endMs - startMs,
            status: 'ok',
        }
    }

    forceFlush(): Promise<void> {
        return this.reporter.flush?.() ?? Promise.resolve()
    }

    shutdown(): Promise<void> {
        return this.reporter.flush?.() ?? Promise.resolve()
    }
}

// ---- utilities ----

function str(v: unknown): string | undefined {
    return typeof v === 'string' ? v : undefined
}

function toNum(v: unknown): number | undefined {
    if (typeof v === 'number') return v
    if (typeof v === 'string') {
        const n = Number(v)
        return Number.isFinite(n) ? n : undefined
    }
    return undefined
}

function safeJson(v: unknown): unknown {
    if (v == null) return undefined
    if (typeof v === 'string') {
        try {
            return JSON.parse(v)
        } catch {
            return v
        }
    }
    return v
}
