export { VercelAIAdapter } from './adapters/vercel'
export type { AIAdapter, AIAdapterContext, AIReporter, OTelSpanProcessorLike, PrivacyOptions } from './adapters/base'

export { NodeReporter } from './reporter'
export type { ReporterOptions } from './reporter'

import { DEFAULT_TRACE_ID_HEADER } from '@condev-monitor/monitor-sdk-core'

import type { AIAdapter, OTelSpanProcessorLike, PrivacyOptions } from './adapters/base'
import { NodeReporter } from './reporter'

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
    })
}
