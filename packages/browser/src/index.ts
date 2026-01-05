import { Integration, Monitoring } from '@condev-monitor/monitor-sdk-core'

import { BrowserTransport } from './transport'
import { Errors } from './tracing/errorsIntegration'
import { DEFAULT_WHITE_SCREEN_OPTIONS, WhiteScreen, WhiteScreenOptions } from './tracing/whiteScreenIntegration'
import { DEFAULT_RUNTIME_PERFORMANCE_OPTIONS, RuntimePerformance, RuntimePerformanceOptions } from './tracing/runtimePerformanceIntegration'
import { Metrics } from '@condev-monitor/monitor-sdk-browser-utils'

let whiteScreen: WhiteScreen | null = null

export type { WhiteScreenOptions }
export type { RuntimePerformanceOptions }
export { DEFAULT_WHITE_SCREEN_OPTIONS, DEFAULT_RUNTIME_PERFORMANCE_OPTIONS }

export const triggerWhiteScreenCheck = (reason?: string) => {
    whiteScreen?.trigger(reason)
}

export const init = (options: {
    dsn: string
    integrations?: Integration[]
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
}) => {
    const monitoring = new Monitoring({
        dsn: options.dsn,
        integrations: options?.integrations,
    })

    const transport = new BrowserTransport(options.dsn)
    monitoring.init(transport)

    new Errors(transport).init()
    new Metrics(transport).init()

    if (options.performance !== false) {
        const perfOptions = typeof options.performance === 'object' ? options.performance : {}
        new RuntimePerformance(transport, { ...DEFAULT_RUNTIME_PERFORMANCE_OPTIONS, ...perfOptions }).init()
    }

    if (options.whiteScreen !== false) {
        const whiteScreenOptions = typeof options.whiteScreen === 'object' ? options.whiteScreen : {}
        whiteScreen = new WhiteScreen(transport, { ...DEFAULT_WHITE_SCREEN_OPTIONS, ...whiteScreenOptions })
        whiteScreen.init()
    }

    return monitoring
}
