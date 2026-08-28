import { isAnimationRumV2RouteKey } from '@condev-monitor/animation-rum-contract'
import {
    deterministicAnimationRumSample,
    toAnimationRumV3SoftNavigationReport,
    type AnimationRumV3Report,
    type AnimationRuntime,
    type AnimationRuntimeFamily,
    type AnimationSoftNavigationFinalizedSegmentSnapshot,
} from '@condev-monitor/monitor-sdk-animation'
import { parseDsn } from '@condev-monitor/monitor-sdk-core'

import { AnimationRumV3DeliveryCoordinator, createAnimationRumV3DeliveryScope } from './animation-rum-v3-delivery'
import type { AnimationRumV3AttemptResult, AnimationRumV3PersistResult } from './animation-rum-v3-delivery'

const DEFAULT_SAMPLING_POLICY_VERSION = 1
const PAGE_SAMPLE_KEY = Symbol.for('@condev-monitor/browser-animation-rum/soft-navigation-page-sample-key/v3')
const PAGE_REPORT_LEDGER = Symbol.for('@condev-monitor/browser-animation-rum/soft-navigation-page-report-ledger/v3')
const MAX_RETAINED_PAGE_REPORTS = 32

interface PageReportLedgerEntry {
    readonly sourceJson: string
    readonly report: AnimationRumV3Report
}

interface PageReportLedger {
    readonly entries: Map<string, PageReportLedgerEntry>
    readonly order: string[]
}

export interface BrowserAnimationRumV3SoftNavigationOptions {
    sampleRate: number
    sampleKey?: string
    seed?: string
    policyVersion?: number
}

export interface AnimationRumV3DeliveryPort {
    start(): void
    suspend(): Promise<void>
    resume(): Promise<void>
    persist(reports: readonly unknown[]): Promise<AnimationRumV3PersistResult>
    flush(reports?: readonly unknown[]): Promise<AnimationRumV3AttemptResult>
    stop(): Promise<void>
}

interface BrowserAnimationRumV3SoftNavigationControllerOptions {
    dsn: string
    rum: BrowserAnimationRumV3SoftNavigationOptions
    runtime: AnimationRuntime
    context: {
        routeKey: string
        release?: string
        dist?: string
        environment?: string
        sdkVersion?: string
        runtimeFamily?: AnimationRuntimeFamily
        runtime?: AnimationRumV3Report['context']['runtime']
    }
    delivery?: AnimationRumV3DeliveryPort
}

export interface BrowserAnimationRumV3SoftNavigationController {
    readonly sampled: boolean
    flush(): Promise<void>
    stopDelivery(): Promise<void>
    dispose(): void
}

function randomPart(): string {
    const cryptoValue = typeof globalThis.crypto === 'undefined' ? undefined : globalThis.crypto
    if (typeof cryptoValue?.randomUUID === 'function') return cryptoValue.randomUUID()
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
}

function reportId(prefix: 'event' | 'capture'): string {
    return `${prefix}_soft_navigation_${randomPart()}`.slice(0, 80)
}

function stickyPageSampleKey(): string {
    const root = globalThis as typeof globalThis & { [PAGE_SAMPLE_KEY]?: string }
    root[PAGE_SAMPLE_KEY] ??= `soft-navigation-page-${randomPart()}`
    return root[PAGE_SAMPLE_KEY]
}

function pageReportLedger(): PageReportLedger {
    const root = globalThis as typeof globalThis & { [PAGE_REPORT_LEDGER]?: PageReportLedger }
    const current = root[PAGE_REPORT_LEDGER]
    if (current?.entries instanceof Map && Array.isArray(current.order)) return current
    const ledger = { entries: new Map<string, PageReportLedgerEntry>(), order: [] }
    root[PAGE_REPORT_LEDGER] = ledger
    return ledger
}

function rememberPageReport(key: string, sourceJson: string, create: () => AnimationRumV3Report): AnimationRumV3Report {
    const ledger = pageReportLedger()
    const existing = ledger.entries.get(key)
    if (existing) {
        if (existing.sourceJson !== sourceJson) {
            throw new TypeError('Animation RUM v3 soft navigation replay identity conflicts with retained segment evidence')
        }
        return existing.report
    }

    const report = create()
    ledger.entries.set(key, { sourceJson, report })
    ledger.order.push(key)
    while (ledger.order.length > MAX_RETAINED_PAGE_REPORTS) {
        const expired = ledger.order.shift()
        if (expired !== undefined) ledger.entries.delete(expired)
    }
    return report
}

function frameworkFromRuntimeFamily(
    runtimeFamily: AnimationRuntimeFamily | undefined
): AnimationRumV3Report['context']['runtime']['framework'] {
    if (runtimeFamily === undefined) return 'unknown'
    if (
        runtimeFamily === 'vanilla' ||
        runtimeFamily === 'react' ||
        runtimeFamily === 'vue' ||
        runtimeFamily === 'angular' ||
        runtimeFamily === 'svelte' ||
        runtimeFamily === 'solid'
    ) {
        return runtimeFamily
    }
    return 'unknown'
}

function defaultRuntimeContext(runtimeFamily: AnimationRuntimeFamily | undefined): AnimationRumV3Report['context']['runtime'] {
    return {
        framework: frameworkFromRuntimeFamily(runtimeFamily),
        renderer: 'unknown',
        backend: 'unknown',
    }
}

function viewportBucket(): AnimationRumV3Report['context']['viewportBucket'] {
    const width = typeof window === 'undefined' ? Number.NaN : window.innerWidth
    if (!Number.isFinite(width) || width < 0) return 'unknown'
    if (width < 480) return 'tiny'
    if (width < 768) return 'small'
    if (width < 1_280) return 'medium'
    if (width < 1_920) return 'large'
    return 'xlarge'
}

function dprBucket(): AnimationRumV3Report['context']['dprBucket'] {
    const dpr = typeof window === 'undefined' ? Number.NaN : window.devicePixelRatio
    if (!Number.isFinite(dpr) || dpr <= 0) return 'unknown'
    if (dpr <= 1.25) return '1'
    if (dpr <= 1.75) return '1.5'
    if (dpr <= 2.5) return '2'
    if (dpr <= 3.5) return '3'
    return '4+'
}

function wallNow(runtime: AnimationRuntime): number {
    const value = runtime.wallNow?.() ?? Date.now()
    if (!Number.isFinite(value) || value < 0 || value > 8_640_000_000_000_000) {
        throw new TypeError('Animation RUM v3 soft navigation runtime returned an invalid wall clock')
    }
    return value
}

function segmentKey(segment: AnimationSoftNavigationFinalizedSegmentSnapshot): string {
    return `${segment.segmentId}:${segment.startedAt}:${segment.finalizedAt}`
}

export function validateBrowserAnimationRumV3SoftNavigationOptions(
    options: BrowserAnimationRumV3SoftNavigationOptions
): Required<BrowserAnimationRumV3SoftNavigationOptions> {
    if (!Number.isFinite(options.sampleRate) || options.sampleRate < 0 || options.sampleRate > 1) {
        throw new TypeError('animation.rum.sampleRate must be between 0 and 1')
    }
    const policyVersion = options.policyVersion ?? DEFAULT_SAMPLING_POLICY_VERSION
    if (!Number.isInteger(policyVersion) || policyVersion < 1 || policyVersion > 255) {
        throw new TypeError('animation.rum.policyVersion must be an integer between 1 and 255')
    }
    if (options.sampleKey !== undefined && typeof options.sampleKey !== 'string') {
        throw new TypeError('animation.rum.sampleKey must be a string')
    }
    const sampleKey = options.sampleKey ?? stickyPageSampleKey()
    if (sampleKey.length < 1 || sampleKey.length > 256) {
        throw new TypeError('animation.rum.sampleKey must contain 1 to 256 characters')
    }
    if (options.seed !== undefined && typeof options.seed !== 'string') {
        throw new TypeError('animation.rum.seed must be a string')
    }
    const seed = options.seed ?? 'condev-animation-rum-v3-soft-navigation'
    if (seed.length < 1 || seed.length > 128) {
        throw new TypeError('animation.rum.seed must contain 1 to 128 characters')
    }
    return { sampleRate: options.sampleRate, sampleKey, seed, policyVersion }
}

export function validateBrowserAnimationRumV3SoftNavigationConfiguration(
    dsn: string,
    options: BrowserAnimationRumV3SoftNavigationOptions,
    routeKey: string | undefined
): void {
    validateBrowserAnimationRumV3SoftNavigationOptions(options)
    if (!routeKey || !isAnimationRumV2RouteKey(routeKey)) {
        throw new TypeError('animation.rum.softNavigation requires animation.context.routeKey to be a static registered route key')
    }
    const parsed = parseDsn(dsn)
    if (!parsed) throw new TypeError('animation.rum softNavigation requires a valid Browser DSN')
    createAnimationRumV3DeliveryScope(parsed.appId, `${parsed.origin}${parsed.basePath}/tracking-v3/${parsed.appId}`)
}

function deliveryFromDsn(dsn: string): AnimationRumV3DeliveryPort {
    const parsed = parseDsn(dsn)
    if (!parsed) throw new TypeError('animation.rum softNavigation requires a valid Browser DSN')
    return new AnimationRumV3DeliveryCoordinator({
        appId: parsed.appId,
        trackingUrl: `${parsed.origin}${parsed.basePath}/tracking-v3/${parsed.appId}`,
    })
}

export function createBrowserAnimationRumV3SoftNavigationController(
    options: BrowserAnimationRumV3SoftNavigationControllerOptions
): BrowserAnimationRumV3SoftNavigationController {
    const rum = validateBrowserAnimationRumV3SoftNavigationOptions(options.rum)
    validateBrowserAnimationRumV3SoftNavigationConfiguration(options.dsn, options.rum, options.context.routeKey)
    const sampled = rum.sampleRate > 0 && deterministicAnimationRumSample(rum.sampleKey, rum.sampleRate, rum.seed)
    const delivery = rum.sampleRate === 0 ? null : (options.delivery ?? deliveryFromDsn(options.dsn))
    const parsedDsn = parseDsn(options.dsn)
    if (!parsedDsn) throw new TypeError('animation.rum softNavigation requires a valid Browser DSN')
    const reportLedgerScope = JSON.stringify([
        parsedDsn.origin,
        parsedDsn.basePath,
        parsedDsn.appId,
        rum.sampleKey,
        options.context.routeKey,
    ])
    const pendingReports = new Map<string, AnimationRumV3Report>()
    const retainedSegmentKeys: string[] = []
    const retainedSegmentSet = new Set<string>()
    let unsubscribeSegments: (() => void) | undefined
    let unsubscribeLifecycle: (() => void) | undefined
    let deliveryLifecycle: Promise<void> = Promise.resolve()
    let deliveryLifecycleFailure: unknown
    let persistence: Promise<void> | null = null
    let projectionFailure: unknown
    let disposed = false

    function rememberSegment(key: string): boolean {
        if (retainedSegmentSet.has(key)) return false
        retainedSegmentSet.add(key)
        retainedSegmentKeys.push(key)
        while (retainedSegmentKeys.length > 4) {
            const expired = retainedSegmentKeys.shift()
            if (expired !== undefined) retainedSegmentSet.delete(expired)
        }
        return true
    }

    function buildReport(segment: AnimationSoftNavigationFinalizedSegmentSnapshot): AnimationRumV3Report {
        const sourceJson = JSON.stringify(segment)
        const ledgerKey = `${reportLedgerScope}:${segmentKey(segment)}`
        return rememberPageReport(ledgerKey, sourceJson, () => {
            const capturedAtEpochMs = wallNow(options.runtime)
            return toAnimationRumV3SoftNavigationReport(segment, {
                eventId: reportId('event'),
                captureId: reportId('capture'),
                capturedAtEpochMs,
                sampleRate: rum.sampleRate,
                samplingPolicyVersion: rum.policyVersion,
                routeKey: options.context.routeKey,
                release: options.context.release,
                dist: options.context.dist,
                environment: options.context.environment,
                sdkVersion: options.context.sdkVersion,
                visibilityState: options.runtime.getVisibilityState(),
                reducedMotion: options.runtime.getReducedMotion(),
                viewportBucket: viewportBucket(),
                dprBucket: dprBucket(),
                runtime: options.context.runtime ?? defaultRuntimeContext(options.context.runtimeFamily),
            })
        })
    }

    function persistPending(): Promise<void> {
        if (!delivery || pendingReports.size === 0) return Promise.resolve()
        if (persistence) return persistence
        const attempt = (async () => {
            while (pendingReports.size > 0) {
                const reports = [...pendingReports.values()]
                await delivery.persist(reports)
                for (const report of reports) {
                    if (pendingReports.get(report.eventId) === report) pendingReports.delete(report.eventId)
                }
            }
        })()
        const finalAttempt = attempt.finally(() => {
            if (persistence === finalAttempt) persistence = null
        })
        persistence = finalAttempt
        return finalAttempt
    }

    function queueDeliveryLifecycle(operation: () => Promise<void>): void {
        deliveryLifecycle = deliveryLifecycle.then(operation).catch(error => {
            deliveryLifecycleFailure ??= error
        })
    }

    function takeProjectionFailure(): unknown {
        const failure = projectionFailure
        projectionFailure = undefined
        return failure
    }

    function takeDeliveryLifecycleFailure(): unknown {
        const failure = deliveryLifecycleFailure
        deliveryLifecycleFailure = undefined
        return failure
    }

    async function drainDeliveryWork(): Promise<void> {
        let failure: unknown
        try {
            await persistPending()
        } catch (error) {
            failure = error
        }
        await deliveryLifecycle
        if (delivery) {
            try {
                await delivery.flush()
            } catch (error) {
                failure ??= error
            }
        }
        if (failure !== undefined) throw failure
    }

    function onFinalizedSegment(segment: AnimationSoftNavigationFinalizedSegmentSnapshot): void {
        if (disposed || !sampled) return
        try {
            const key = segmentKey(segment)
            const report = buildReport(segment)
            if (!rememberSegment(key)) return
            pendingReports.set(report.eventId, report)
            void persistPending().catch(() => undefined)
        } catch (error) {
            projectionFailure ??= error
            // Invalid source evidence is fail-closed and never enters durable delivery.
        }
    }

    const controller: BrowserAnimationRumV3SoftNavigationController = {
        sampled,
        async flush() {
            if (disposed) return
            let failure = takeProjectionFailure()
            try {
                await drainDeliveryWork()
            } catch (error) {
                failure ??= error
            }
            failure ??= takeDeliveryLifecycleFailure()
            if (failure !== undefined) throw failure
        },
        async stopDelivery() {
            let failure: unknown
            await deliveryLifecycle
            failure = takeDeliveryLifecycleFailure()
            try {
                await (delivery?.stop() ?? Promise.resolve())
            } catch (error) {
                failure ??= error
            }
            if (failure !== undefined) throw failure
        },
        dispose() {
            if (disposed) return
            disposed = true
            unsubscribeSegments?.()
            unsubscribeSegments = undefined
            unsubscribeLifecycle?.()
            unsubscribeLifecycle = undefined
        },
    }

    try {
        delivery?.start()
        if (sampled) unsubscribeSegments = options.runtime.subscribeSoftNavigationFinalizedSegments?.(onFinalizedSegment)
        if (delivery) {
            unsubscribeLifecycle = options.runtime.onPageLifecycle?.(
                event => {
                    if (event.type === 'pageshow' && event.persisted) {
                        queueDeliveryLifecycle(() => delivery.resume())
                        return
                    }
                    if (event.type !== 'hidden' && event.type !== 'pagehide') return
                    void persistPending().catch(() => undefined)
                    if (event.type === 'pagehide' && event.persisted) {
                        queueDeliveryLifecycle(async () => {
                            await persistPending()
                            await delivery.suspend()
                        })
                    } else {
                        void drainDeliveryWork().catch(() => undefined)
                    }
                },
                { priority: 40 }
            )
        }
    } catch (error) {
        controller.dispose()
        void delivery?.stop().catch(() => undefined)
        throw error
    }

    return controller
}
