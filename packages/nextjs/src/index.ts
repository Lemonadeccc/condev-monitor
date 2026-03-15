// 'use client' is injected by the tsup banner — do not add it here to avoid duplicates.
// Main entry — client-only APIs (no server code leakage)
// Server APIs are available via '@condev-monitor/nextjs/server'
// Named exports required: Next.js forbids `export *` in 'use client' boundaries.

export {
    // Browser SDK
    init,
    triggerWhiteScreenCheck,
    setUser,
    getUser,
    clearUser,
    DEFAULT_WHITE_SCREEN_OPTIONS,
    DEFAULT_RUNTIME_PERFORMANCE_OPTIONS,
    // React components & hooks
    CondevErrorBoundary,
    withErrorBoundary,
    useMonitorUser,
    MonitorUser,
} from '@condev-monitor/react'

export type {
    WhiteScreenOptions,
    RuntimePerformanceOptions,
    ReplayOptions,
    SSETraceOptions,
    UserContext,
    TransportConfig,
    BrowserMonitorOptions,
    CondevErrorBoundaryProps,
} from '@condev-monitor/react'

export { registerCondevClient } from './client'
export type { CondevClientOptions } from './client'
