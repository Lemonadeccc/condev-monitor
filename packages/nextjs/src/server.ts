import type { OTelSpanProcessorLike, PrivacyOptions } from '@condev-monitor/monitor-sdk-ai'
import { initAIMonitor, VercelAIAdapter } from '@condev-monitor/monitor-sdk-ai'

export interface CondevServerOptions {
    /** DSN defaults to CONDEV_DSN or NEXT_PUBLIC_CONDEV_DSN */
    dsn?: string
    privacy?: PrivacyOptions
    traceIdHeader?: string
    debug?: boolean
    additionalSpanProcessors?: OTelSpanProcessorLike[]
}

let _serverRegistered = false

/**
 * Call in `instrumentation.ts` register() function.
 * Sets up AI telemetry span processor and registers it with OTel.
 * Idempotent: repeated calls (HMR, tests) are no-ops.
 */
export async function registerCondevServer(options?: CondevServerOptions): Promise<void> {
    if (_serverRegistered) return
    _serverRegistered = true

    const dsn = options?.dsn ?? process.env.CONDEV_DSN ?? process.env.NEXT_PUBLIC_CONDEV_DSN
    if (!dsn) {
        console.warn('[condev-monitor] No DSN provided. Set CONDEV_DSN or pass dsn option.')
        return
    }

    const adapter = new VercelAIAdapter()
    const processor = initAIMonitor({
        dsn,
        adapter,
        privacy: options?.privacy,
        traceIdHeader: options?.traceIdHeader,
        debug: options?.debug,
    })

    const allProcessors: OTelSpanProcessorLike[] = [processor, ...(options?.additionalSpanProcessors ?? [])]

    try {
        const { trace } = await import('@opentelemetry/api')
        const provider = trace.getTracerProvider()

        // Prefer mutating an existing NodeTracerProvider (addSpanProcessor exists and is callable)
        if ('addSpanProcessor' in provider && typeof (provider as { addSpanProcessor?: unknown }).addSpanProcessor === 'function') {
            const addSpanProcessor = (provider as { addSpanProcessor(p: OTelSpanProcessorLike): void }).addSpanProcessor.bind(provider)
            for (const p of allProcessors) addSpanProcessor(p)
            return
        }

        // Fallback: no compatible global provider — create and register a BasicTracerProvider.
        // This mirrors the behaviour of the old manual OTel setup in instrumentation.ts.
        const { BasicTracerProvider } = await import('@opentelemetry/sdk-trace-base')
        const ownProvider = new BasicTracerProvider({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            spanProcessors: allProcessors as any[],
        })
        trace.setGlobalTracerProvider(ownProvider)
    } catch (e) {
        if (options?.debug) {
            console.warn('[condev-monitor] OTel registration failed:', e)
        }
    }
}
