import type { AIReporter } from './adapters/base'

function now(): number {
    return Date.now()
}

function nowIso(): string {
    return new Date().toISOString()
}

/** Langfuse-compatible imperative tracing API for Node.js. */
export class CondevAIClient {
    constructor(private readonly reporter: AIReporter) {}

    trace(params: {
        name: string
        traceId?: string
        input?: unknown
        sessionId?: string
        userId?: string
        metadata?: Record<string, unknown>
        tags?: string[]
    }): CondevTrace {
        const id = params.traceId ?? crypto.randomUUID()
        return new CondevTrace(this.reporter, id, params)
    }
}

export class CondevTrace {
    private readonly startedAt: number

    constructor(
        private readonly reporter: AIReporter,
        readonly traceId: string,
        private readonly params: {
            name: string
            input?: unknown
            sessionId?: string
            userId?: string
            metadata?: Record<string, unknown>
            tags?: string[]
        }
    ) {
        this.startedAt = now()
        this.reporter.send({
            event_type: 'ai_span',
            source: 'node-sdk',
            framework: 'manual',
            traceId,
            spanId: traceId,
            parentSpanId: '',
            spanKind: 'entrypoint',
            name: params.name,
            input: params.input,
            sessionId: params.sessionId ?? '',
            userId: params.userId ?? '',
            tags: params.tags,
            metadata: params.metadata,
            startedAt: nowIso(),
        })
    }

    span(params: { name: string; spanKind?: string; input?: unknown; metadata?: Record<string, unknown> }): CondevSpan {
        return new CondevSpan(this.reporter, this.traceId, this.traceId, params)
    }

    generation(params: {
        name: string
        model?: string
        modelParameters?: Record<string, unknown>
        input?: unknown
        metadata?: Record<string, unknown>
    }): CondevGeneration {
        return new CondevGeneration(this.reporter, this.traceId, this.traceId, params)
    }

    score(params: { name: string; value: number; comment?: string }): void {
        this.reporter.send({
            event_type: 'ai_feedback',
            source: 'node-sdk',
            traceId: this.traceId,
            name: params.name,
            value: params.value,
            comment: params.comment ?? '',
            createdAt: nowIso(),
        })
    }

    update(params: { output?: unknown; status?: 'ok' | 'error'; metadata?: Record<string, unknown> }): void {
        const endedAt = now()
        this.reporter.send({
            event_type: 'ai_span',
            source: 'node-sdk',
            framework: 'manual',
            traceId: this.traceId,
            spanId: this.traceId,
            spanKind: 'entrypoint',
            name: this.params.name,
            output: params.output,
            status: params.status ?? 'ok',
            metadata: params.metadata,
            endedAt: nowIso(),
            durationMs: endedAt - this.startedAt,
        })
    }
}

export class CondevSpan {
    protected readonly spanId: string
    protected readonly startedAt: number

    constructor(
        protected readonly reporter: AIReporter,
        protected readonly traceId: string,
        protected readonly parentSpanId: string,
        protected readonly params: {
            name: string
            spanKind?: string
            input?: unknown
            metadata?: Record<string, unknown>
        }
    ) {
        this.spanId = crypto.randomUUID()
        this.startedAt = now()
        this.reporter.send({
            event_type: 'ai_span',
            source: 'node-sdk',
            framework: 'manual',
            traceId,
            spanId: this.spanId,
            parentSpanId,
            spanKind: params.spanKind ?? 'span',
            name: params.name,
            input: params.input,
            metadata: params.metadata,
            startedAt: nowIso(),
        })
    }

    span(params: { name: string; spanKind?: string; input?: unknown; metadata?: Record<string, unknown> }): CondevSpan {
        return new CondevSpan(this.reporter, this.traceId, this.spanId, params)
    }

    generation(params: { name: string; model?: string; input?: unknown; metadata?: Record<string, unknown> }): CondevGeneration {
        return new CondevGeneration(this.reporter, this.traceId, this.spanId, params)
    }

    end(params?: { output?: unknown; status?: 'ok' | 'error' }): void {
        const endedAt = now()
        this.reporter.send({
            event_type: 'ai_span',
            source: 'node-sdk',
            framework: 'manual',
            traceId: this.traceId,
            spanId: this.spanId,
            parentSpanId: this.parentSpanId,
            spanKind: this.params.spanKind ?? 'span',
            name: this.params.name,
            output: params?.output,
            status: params?.status ?? 'ok',
            endedAt: nowIso(),
            durationMs: endedAt - this.startedAt,
        })
    }
}

export class CondevGeneration extends CondevSpan {
    constructor(
        reporter: AIReporter,
        traceId: string,
        parentSpanId: string,
        private readonly genParams: {
            name: string
            model?: string
            modelParameters?: Record<string, unknown>
            input?: unknown
            metadata?: Record<string, unknown>
        }
    ) {
        super(reporter, traceId, parentSpanId, { ...genParams, spanKind: 'llm' })
    }

    end(params?: {
        output?: unknown
        model?: string
        usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
        status?: 'ok' | 'error'
    }): void {
        const endedAt = now()
        this.reporter.send({
            event_type: 'ai_span',
            source: 'node-sdk',
            framework: 'manual',
            traceId: this.traceId,
            spanId: this.spanId,
            parentSpanId: this.parentSpanId,
            spanKind: 'llm',
            name: this.genParams.name,
            model: params?.model ?? this.genParams.model,
            output: params?.output,
            inputTokens: params?.usage?.inputTokens,
            outputTokens: params?.usage?.outputTokens,
            status: params?.status ?? 'ok',
            endedAt: nowIso(),
            durationMs: endedAt - this.startedAt,
        })
    }
}
