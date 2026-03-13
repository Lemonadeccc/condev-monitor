import { DEFAULT_TRACE_ID_HEADER } from '@condev-monitor/monitor-sdk-core'

export interface SSETraceOptions {
    /**
     * URL patterns to intercept. If empty, detect by Content-Type only.
     * Supports string (includes match) and RegExp.
     */
    urlPatterns?: (string | RegExp)[]

    /**
     * Stall detection threshold in ms. Default: 3000
     */
    stallThresholdMs?: number

    /**
     * Auto-inject trace header on matching same-origin requests.
     * Only takes effect when urlPatterns is non-empty — in auto-detect mode
     * (urlPatterns=[]), headers are never injected to avoid polluting unrelated requests.
     * Default: true
     */
    injectTraceId?: boolean

    /**
     * Custom header name for trace correlation. Default: 'x-condev-trace-id'
     */
    traceIdHeader?: string

    /**
     * URLs to exclude (e.g., SDK's own DSN endpoint). String = includes match.
     */
    excludeUrls?: (string | RegExp)[]

    /**
     * Max chunks to observe before releasing the probe stream.
     * Prevents memory growth on very long-lived streams.
     * Default: 50000 (effectively unlimited for normal AI chat)
     */
    maxProbeChunks?: number

    /**
     * Max bytes to buffer before releasing the probe stream.
     * Prevents excessive memory usage on large payloads.
     * Default: 10MB
     */
    maxProbeBytes?: number
}

export const DEFAULT_SSE_TRACE_OPTIONS: Required<SSETraceOptions> = {
    urlPatterns: [],
    stallThresholdMs: 3000,
    injectTraceId: true,
    traceIdHeader: DEFAULT_TRACE_ID_HEADER,
    excludeUrls: [],
    maxProbeChunks: 50_000,
    maxProbeBytes: 10 * 1024 * 1024,
}
