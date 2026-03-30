import { createRequire } from 'node:module'

import type { OTelSpanProcessorLike, PrivacyOptions } from '@condev-monitor/monitor-sdk-ai'
import { createAISink, createVercelAITelemetryIntegration, initAIMonitor, VercelAIAdapter } from '@condev-monitor/monitor-sdk-ai'

export interface CondevServerOptions {
    /** DSN defaults to CONDEV_DSN or NEXT_PUBLIC_CONDEV_DSN */
    dsn?: string
    privacy?: PrivacyOptions
    traceIdHeader?: string
    debug?: boolean
    additionalSpanProcessors?: OTelSpanProcessorLike[]
}

let _serverRegistered = false

type MutableTracerProvider = {
    addSpanProcessor?: (processor: OTelSpanProcessorLike) => void
    getDelegate?: () => unknown
    setDelegate?: (delegate: unknown) => void
    _activeSpanProcessor?: {
        _spanProcessors?: unknown[]
    }
}

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

    const sink = createAISink({ dsn, debug: options?.debug })
    const adapter = new VercelAIAdapter(sink)
    const processor = initAIMonitor({
        dsn,
        adapter,
        privacy: options?.privacy,
        traceIdHeader: options?.traceIdHeader,
        debug: options?.debug,
    })

    const allProcessors: OTelSpanProcessorLike[] = [processor, ...(options?.additionalSpanProcessors ?? [])]

    await registerAISDKTelemetryIntegration({
        dsn,
        privacy: options?.privacy,
        traceIdHeader: options?.traceIdHeader,
        debug: options?.debug,
    })

    try {
        const { trace } = await import('@opentelemetry/api')
        const provider = trace.getTracerProvider() as MutableTracerProvider
        const delegate = typeof provider.getDelegate === 'function' ? provider.getDelegate() : undefined

        // OTel v1 providers expose addSpanProcessor directly.
        if (typeof provider.addSpanProcessor === 'function') {
            for (const p of allProcessors) provider.addSpanProcessor(p)
            if (options?.debug) {
                console.info('[condev-monitor] Attached AI span processor to global tracer provider')
            }
            return
        }

        // In newer OTel builds the global provider is usually a ProxyTracerProvider.
        // If its delegate is mutable, attach there.
        const mutableDelegate = delegate as MutableTracerProvider | undefined
        if (mutableDelegate && typeof mutableDelegate.addSpanProcessor === 'function') {
            for (const p of allProcessors) mutableDelegate.addSpanProcessor(p)
            if (options?.debug) {
                console.info('[condev-monitor] Attached AI span processor to tracer delegate')
            }
            return
        }

        // OTel v2 BasicTracerProvider has no addSpanProcessor(). If we can swap the
        // proxy delegate, rebuild the delegate with the existing processors plus ours.
        const { BasicTracerProvider } = await import('@opentelemetry/sdk-trace-base')
        if (typeof provider.setDelegate === 'function') {
            const existingProcessors = extractSpanProcessors(delegate)
            const nextProvider = new BasicTracerProvider({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                spanProcessors: [...existingProcessors, ...allProcessors] as any[],
            })
            provider.setDelegate(nextProvider)
            if (options?.debug) {
                console.info(
                    `[condev-monitor] Replaced tracer delegate with ${existingProcessors.length + allProcessors.length} span processor(s)`
                )
            }
            return
        }

        // Final fallback: attempt to install our own global provider in clean runtimes.
        const ownProvider = new BasicTracerProvider({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            spanProcessors: allProcessors as any[],
        })
        const didSet = trace.setGlobalTracerProvider(ownProvider)
        if (options?.debug) {
            console.info(`[condev-monitor] Registered fallback tracer provider: ${didSet ? 'ok' : 'skipped'}`)
        }
    } catch (e) {
        if (options?.debug) {
            console.warn('[condev-monitor] OTel registration failed:', e)
        }
    }
}

async function registerAISDKTelemetryIntegration(options: {
    dsn: string
    privacy?: PrivacyOptions
    traceIdHeader?: string
    debug?: boolean
}): Promise<void> {
    try {
        const runtimeRequire = createRequire(`${process.cwd()}/package.json`)
        const aiModule = runtimeRequire('ai') as {
            bindTelemetryIntegration?: (integration: unknown) => unknown
            registerTelemetryIntegration?: (integration: unknown) => void
        }

        if (typeof aiModule.registerTelemetryIntegration !== 'function') {
            return
        }

        const integration = createVercelAITelemetryIntegration(options)
        const bound = typeof aiModule.bindTelemetryIntegration === 'function' ? aiModule.bindTelemetryIntegration(integration) : integration

        aiModule.registerTelemetryIntegration(bound)

        if (options.debug) {
            console.info('[condev-monitor] Registered AI SDK telemetry integration')
        }
    } catch (error) {
        if (options.debug) {
            console.warn('[condev-monitor] AI SDK telemetry integration registration skipped:', error)
        }
    }
}

function extractSpanProcessors(provider: unknown): OTelSpanProcessorLike[] {
    if (!provider || typeof provider !== 'object') return []

    const active = (provider as MutableTracerProvider)._activeSpanProcessor
    if (!active || !Array.isArray(active._spanProcessors)) return []

    return active._spanProcessors.filter(isSpanProcessorLike) as OTelSpanProcessorLike[]
}

function isSpanProcessorLike(value: unknown): boolean {
    return !!value && typeof value === 'object' && typeof (value as { onEnd?: unknown }).onEnd === 'function'
}
