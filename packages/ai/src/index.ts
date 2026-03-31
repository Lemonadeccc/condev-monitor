export { VercelAIAdapter } from './adapters/vercel'
export type { AIAdapter, AIAdapterContext, AIReporter, OTelSpanProcessorLike, PrivacyOptions } from './adapters/base'
export { createVercelAITelemetryIntegration } from './integrations/vercel-ai-sdk'

export { NodeReporter } from './reporter'
export type { ReporterOptions } from './reporter'

export { CondevAIClient, CondevTrace, CondevSpan, CondevGeneration } from './client'
export type { AIEventSink, CondevObservationEvent, SpanKind } from './sink'
export { CompositeSink, ReporterSink, SampledSink } from './sink'
// LangChain integration (requires @langchain/core peer dependency):
// import { CondevCallbackHandler } from '@condev-monitor/monitor-sdk-ai/langchain'

import { DEFAULT_TRACE_ID_HEADER } from '@condev-monitor/monitor-sdk-core'

import type { AIAdapter, OTelSpanProcessorLike, PrivacyOptions } from './adapters/base'
import { NodeReporter } from './reporter'
import type { AIEventSink } from './sink'
import { ReporterSink } from './sink'

export function initAIMonitor(options: {
    dsn: string
    adapter: AIAdapter
    privacy?: PrivacyOptions
    /** Must match the browser SDK's traceIdHeader if customized. Default: 'x-condev-trace-id' */
    traceIdHeader?: string
    debug?: boolean
}): OTelSpanProcessorLike {
    const reporter = new NodeReporter({
        dsn: options.dsn,
        debug: options.debug,
    })
    return options.adapter.install({
        reporter,
        privacy: options.privacy ?? {},
        traceIdHeader: options.traceIdHeader ?? DEFAULT_TRACE_ID_HEADER,
        debug: options.debug,
    })
}

/** Create a ReporterSink-backed AIEventSink from a DSN string. */
export function createAISink(options: { dsn: string; debug?: boolean }): AIEventSink {
    return new ReporterSink(new NodeReporter({ dsn: options.dsn, debug: options.debug }))
}
