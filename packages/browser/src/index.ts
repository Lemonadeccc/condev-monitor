import { Monitoring, type IntegrationLike, type MonitoringOptions } from '@condev-monitor/monitor-sdk-core'

import { BrowserTransport } from './transport'
import type { TransportConfig } from './transport/types'
import { Errors } from './tracing/errorsIntegration'
import { DEFAULT_WHITE_SCREEN_OPTIONS, WhiteScreen, WhiteScreenOptions } from './tracing/whiteScreenIntegration'
import { DEFAULT_RUNTIME_PERFORMANCE_OPTIONS, RuntimePerformance, RuntimePerformanceOptions } from './tracing/runtimePerformanceIntegration'
import { SSETraceIntegration } from './tracing/sseTraceIntegration'
import type { SSETraceOptions } from './tracing/sseTraceTypes'
import { Metrics } from '@condev-monitor/monitor-sdk-browser-utils'
import { Replay, ReplayOptions } from './replay/replayIntegration'

let activeClient: BrowserMonitorClient | null = null
let localAnimationOwner: object | null = null

function setActiveClient(client: BrowserMonitorClient | null): void {
    activeClient = client
}

/** @internal Coordinates the optional animation subpath without exposing a client on globalThis. */
export function __hasActiveBrowserMonitoring(): boolean {
    return activeClient !== null || localAnimationOwner !== null
}

/** @internal Reserves the one-client slot for a transport-free animation client. */
export function __reserveLocalAnimationClient(owner: object): boolean {
    if (activeClient || (localAnimationOwner && localAnimationOwner !== owner)) return false
    localAnimationOwner = owner
    return true
}

/** @internal Releases a reservation only when it still belongs to the caller. */
export function __releaseLocalAnimationClient(owner: object): void {
    if (localAnimationOwner === owner) localAnimationOwner = null
}

export type { WhiteScreenOptions }
export type { RuntimePerformanceOptions }
export type { ReplayOptions }
export type { SSETraceOptions }
export { DEFAULT_WHITE_SCREEN_OPTIONS, DEFAULT_RUNTIME_PERFORMANCE_OPTIONS }

export const triggerWhiteScreenCheck = (reason?: string) => {
    activeClient?.triggerBuiltInWhiteScreenCheck(reason)
}

export { setUser, getUser, clearUser } from '@condev-monitor/monitor-sdk-core'
export type { MonitorIntegration, UserContext } from '@condev-monitor/monitor-sdk-core'
export type { TransportConfig }

export interface BrowserMonitorOptions {
    dsn: string
    integrations?: IntegrationLike[]
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
}

export class BrowserMonitorClient extends Monitoring {
    constructor(
        options: MonitoringOptions,
        private readonly onDestroyed: () => void,
        private readonly builtInWhiteScreen: WhiteScreen | null
    ) {
        super(options)
    }

    triggerBuiltInWhiteScreenCheck(reason?: string): void {
        this.builtInWhiteScreen?.trigger(reason)
    }

    override destroy(): Promise<void> {
        return super.destroy().then(
            () => {
                this.onDestroyed()
            },
            error => {
                if (this.isDestroyed()) this.onDestroyed()
                throw error
            }
        )
    }

    /** @internal Releases the root singleton only after partial-init cleanup completes. */
    abortInitialization(): Promise<void> {
        return super.abortInitialization().then(
            () => {
                this.onDestroyed()
            },
            error => {
                if (this.isDestroyed()) this.onDestroyed()
                throw error
            }
        )
    }
}

export const init = (options: BrowserMonitorOptions): BrowserMonitorClient | undefined => {
    // Preserve the original public contract: the first call returns the
    // Monitoring instance and duplicate calls in this SDK instance return
    // undefined. In particular, never silently route a second DSN through the
    // first client's transport.
    if (activeClient || localAnimationOwner) return undefined

    const transport = new BrowserTransport(
        options.dsn,
        {
            release: options.release,
            dist: options.dist,
        },
        options.transport
    )
    const integrations: IntegrationLike[] = [...(options.integrations ?? [])]
    let builtInWhiteScreen: WhiteScreen | null = null

    integrations.push(new Errors(transport), new Metrics(transport))

    if (options.replay) {
        const replayOptions = typeof options.replay === 'object' ? options.replay : undefined
        integrations.push(new Replay(transport, options.dsn, replayOptions))
    }

    if (options.performance !== false) {
        const perfOptions = typeof options.performance === 'object' ? options.performance : {}
        integrations.push(new RuntimePerformance(transport, { ...DEFAULT_RUNTIME_PERFORMANCE_OPTIONS, ...perfOptions }))
    }

    if (options.whiteScreen !== false) {
        const whiteScreenOptions = typeof options.whiteScreen === 'object' ? options.whiteScreen : {}
        builtInWhiteScreen = new WhiteScreen(transport, { ...DEFAULT_WHITE_SCREEN_OPTIONS, ...whiteScreenOptions })
        integrations.push(builtInWhiteScreen)
    }

    if (options.aiStreaming) {
        const sseOpts = typeof options.aiStreaming === 'object' ? options.aiStreaming : {}
        integrations.push(new SSETraceIntegration(transport, options.dsn, sseOpts))
    }

    const client = new BrowserMonitorClient(
        { dsn: options.dsn, integrations },
        () => {
            if (activeClient === client) setActiveClient(null)
        },
        builtInWhiteScreen
    )
    setActiveClient(client)

    try {
        client.init(transport)
    } catch (error) {
        void client.abortInitialization().catch(() => undefined)
        throw error
    }
    return client
}
