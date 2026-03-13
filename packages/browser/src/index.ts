import { Integration, Monitoring } from '@condev-monitor/monitor-sdk-core'

import { BrowserTransport } from './transport'
import type { TransportConfig } from './transport/types'
import { Errors } from './tracing/errorsIntegration'
import { DEFAULT_WHITE_SCREEN_OPTIONS, WhiteScreen, WhiteScreenOptions } from './tracing/whiteScreenIntegration'
import { DEFAULT_RUNTIME_PERFORMANCE_OPTIONS, RuntimePerformance, RuntimePerformanceOptions } from './tracing/runtimePerformanceIntegration'
import { SSETraceIntegration } from './tracing/sseTraceIntegration'
import type { SSETraceOptions } from './tracing/sseTraceTypes'
import { Metrics } from '@condev-monitor/monitor-sdk-browser-utils'
import { Replay, ReplayOptions } from './replay/replayIntegration'

let whiteScreen: WhiteScreen | null = null
let _initialized = false

export type { WhiteScreenOptions }
export type { RuntimePerformanceOptions }
export type { ReplayOptions }
export type { SSETraceOptions }
export { DEFAULT_WHITE_SCREEN_OPTIONS, DEFAULT_RUNTIME_PERFORMANCE_OPTIONS }

export const triggerWhiteScreenCheck = (reason?: string) => {
    whiteScreen?.trigger(reason)
}

export { setUser, getUser, clearUser } from '@condev-monitor/monitor-sdk-core'
export type { UserContext } from '@condev-monitor/monitor-sdk-core'
export type { TransportConfig }

export const init = (options: {
    dsn: string
    integrations?: Integration[]
    /**
     * Release identifier for sourcemap mapping, e.g. 1.2.3-20250118-153000.
     */
    release?: string
    /**
     * Optional distribution identifier, e.g. web or mobile.
     */
    dist?: string
    /**
     * Enable/disable white-screen detection, or configure its options.
     * Defaults to enabled.
     */
    whiteScreen?: boolean | WhiteScreenOptions
    /**
     * Enable/disable runtime performance (longtask/jank/fps), or configure its options.
     * Defaults to enabled.
     */
    performance?: boolean | RuntimePerformanceOptions
    /**
     * Enable/disable minimal session replay (DOM snapshot + event trail) on errors.
     * Requires app-level toggle enabled in the monitor UI.
     * Defaults to disabled.
     */
    replay?: boolean | ReplayOptions
    /**
     * Transport reliability configuration (queue, retry, offline persistence).
     */
    transport?: TransportConfig
    /**
     * Enable SSE/AI streaming fetch interception for TTFB, TTLB, stall
     * detection and chunk-level timing on streaming responses.
     * Pass `true` for defaults or an options object for fine-grained control.
     * Defaults to disabled (opt-in).
     */
    aiStreaming?: boolean | SSETraceOptions
}) => {
    if (_initialized) return
    _initialized = true

    const monitoring = new Monitoring({
        dsn: options.dsn,
        integrations: options?.integrations,
    })

    const transport = new BrowserTransport(
        options.dsn,
        {
            release: options.release,
            dist: options.dist,
        },
        options.transport
    )
    monitoring.init(transport)

    new Errors(transport).init()
    new Metrics(transport).init()

    if (options.replay) {
        const replayOptions = typeof options.replay === 'object' ? options.replay : undefined
        new Replay(transport, options.dsn, replayOptions).init()
    }

    if (options.performance !== false) {
        const perfOptions = typeof options.performance === 'object' ? options.performance : {}
        new RuntimePerformance(transport, { ...DEFAULT_RUNTIME_PERFORMANCE_OPTIONS, ...perfOptions }).init()
    }

    if (options.whiteScreen !== false) {
        const whiteScreenOptions = typeof options.whiteScreen === 'object' ? options.whiteScreen : {}
        whiteScreen = new WhiteScreen(transport, { ...DEFAULT_WHITE_SCREEN_OPTIONS, ...whiteScreenOptions })
        whiteScreen.init()
    }

    if (options.aiStreaming) {
        const sseOpts = typeof options.aiStreaming === 'object' ? options.aiStreaming : {}
        new SSETraceIntegration(transport, options.dsn, sseOpts).init()
    }

    return monitoring
}
