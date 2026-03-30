import type { AIReporter } from './adapters/base'

export type SpanKind =
    | 'entrypoint'
    | 'llm'
    | 'retrieval'
    | 'rerank'
    | 'embedding'
    | 'chain'
    | 'tool'
    | 'graph_node'
    | 'load'
    | 'split'
    | 'transform'
    | 'cache'
    | 'stage'
    | 'event'

export interface CondevObservationEvent {
    event_type: 'ai_span' | 'ai_feedback' | 'ai_evaluation' | 'ai_ingestion_run'
    traceId: string
    spanId?: string
    parentSpanId?: string
    spanKind?: SpanKind
    name: string
    status?: 'ok' | 'error' | 'cancelled'
    startedAt?: string
    endedAt?: string
    durationMs?: number
    input?: unknown
    output?: unknown
    model?: string
    provider?: string
    inputTokens?: number
    outputTokens?: number
    userId?: string
    sessionId?: string
    environment?: string
    release?: string
    tags?: string[]
    metadata?: Record<string, unknown>
    attributes?: Record<string, unknown>
    source?: string
    framework?: string
    score?: { name: string; value: number; comment?: string }
    errorMessage?: string
    promptName?: string
    promptVersion?: string
    datasetRunId?: string
    experimentRunId?: string
    replayId?: string
}

/** Unified sink — all AI data producers emit through this interface. */
export interface AIEventSink {
    emit(event: CondevObservationEvent): void
    flush?(): Promise<void>
    shutdown?(): Promise<void>
}

/** Forwards events to a NodeReporter (the default transport). */
export class ReporterSink implements AIEventSink {
    constructor(private readonly reporter: AIReporter) {}

    emit(event: CondevObservationEvent): void {
        this.reporter.send(event as unknown as Record<string, unknown>)
    }

    async flush(): Promise<void> {
        await this.reporter.flush?.()
    }

    async shutdown(): Promise<void> {
        await this.flush()
    }
}

/** Fan-out wrapper that forwards the same event to multiple sinks. */
export class CompositeSink implements AIEventSink {
    constructor(private readonly sinks: AIEventSink[]) {}

    emit(event: CondevObservationEvent): void {
        for (const sink of this.sinks) {
            sink.emit(event)
        }
    }

    async flush(): Promise<void> {
        await Promise.all(this.sinks.map(sink => sink.flush?.()))
    }

    async shutdown(): Promise<void> {
        await Promise.all(this.sinks.map(sink => sink.shutdown?.()))
    }
}

/** Wraps any sink with client-side sampling. */
export class SampledSink implements AIEventSink {
    constructor(
        private readonly inner: AIEventSink,
        /** 0.0–1.0 fraction of events to forward. Default 1.0 (all). */
        private readonly sampleRate: number = 1.0
    ) {}

    emit(event: CondevObservationEvent): void {
        if (this.sampleRate < 1.0 && Math.random() > this.sampleRate) return
        this.inner.emit(event)
    }

    async flush(): Promise<void> {
        await this.inner.flush?.()
    }

    async shutdown(): Promise<void> {
        await this.inner.shutdown?.()
    }
}
