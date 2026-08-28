import type {
    AnimationPageLifecycleEvent,
    AnimationRuntime,
    AnimationSoftNavigationFinalizedSegmentSnapshot,
    PerformanceObserverHandle,
} from '@condev-monitor/monitor-sdk-animation'

import { createBrowserAnimationRumV3SoftNavigationController } from './animation-rum-v3'
import type { AnimationRumV3DeliveryPort } from './animation-rum-v3'

const CAPTURED_AT = Date.parse('2026-08-29T08:00:00.000Z')
const DSN = 'https://collector.test/dsn-api/tracking/appOne123'

function segment(
    overrides: Partial<AnimationSoftNavigationFinalizedSegmentSnapshot> = {}
): AnimationSoftNavigationFinalizedSegmentSnapshot {
    return {
        schemaVersion: 1,
        segmentId: 7,
        startedAt: 1_000,
        finalizedAt: 3_000,
        elapsedMs: 2_000,
        reason: 'next-soft-navigation',
        capability: { CLS: 'supported', INP: 'supported', LCP: 'supported' },
        observedUpdateCount: 3,
        droppedEntryCount: 0,
        rejectedUpdateCount: 0,
        latest: {
            CLS: {
                name: 'CLS',
                value: 0.025,
                delta: 0.025,
                rating: 'good',
                navigationType: 'soft-navigation',
                segmentId: 7,
                startedAt: 1_000,
                attribution: { largestShiftTime: 1_500, largestShiftValue: 0.025 },
            },
            INP: {
                name: 'INP',
                value: 120,
                delta: 120,
                rating: 'good',
                navigationType: 'soft-navigation',
                segmentId: 7,
                startedAt: 1_000,
                attribution: { interactionTime: 1_800, interactionType: 'pointer' },
            },
            LCP: {
                name: 'LCP',
                value: 1_250,
                delta: 1_250,
                rating: 'good',
                navigationType: 'soft-navigation',
                segmentId: 7,
                startedAt: 1_000,
                attribution: { paintTime: 2_250, size: 42_000 },
            },
        },
        ...overrides,
    }
}

function runtimeHarness() {
    let finalizedSubscriber: ((value: AnimationSoftNavigationFinalizedSegmentSnapshot) => void) | undefined
    let lifecycleSubscriber: ((event: AnimationPageLifecycleEvent) => void) | undefined
    const unsupportedObserver: PerformanceObserverHandle = { state: 'unsupported', buffered: false, disconnect() {} }
    const runtime: AnimationRuntime = {
        isBrowser: true,
        now: () => 3_000,
        wallNow: () => CAPTURED_AT,
        subscribeFrames: () => () => undefined,
        getVisibilityState: () => 'visible',
        onVisibilityChange: () => () => undefined,
        onPageLifecycle(callback) {
            lifecycleSubscriber = callback
            return () => {
                if (lifecycleSubscriber === callback) lifecycleSubscriber = undefined
            }
        },
        getReducedMotion: () => false,
        onReducedMotionChange: () => () => undefined,
        subscribeSoftNavigationFinalizedSegments(callback) {
            finalizedSubscriber = callback
            return () => {
                if (finalizedSubscriber === callback) finalizedSubscriber = undefined
            }
        },
        observePerformance: () => unsupportedObserver,
    }
    return {
        runtime,
        emitSegment(value: AnimationSoftNavigationFinalizedSegmentSnapshot) {
            finalizedSubscriber?.(value)
        },
        emitLifecycle(event: AnimationPageLifecycleEvent) {
            lifecycleSubscriber?.(event)
        },
        hasSegmentSubscriber: () => finalizedSubscriber !== undefined,
    }
}

function deliveryHarness() {
    const delivery: AnimationRumV3DeliveryPort = {
        start: jest.fn(),
        suspend: jest.fn(async () => undefined),
        resume: jest.fn(async () => undefined),
        persist: jest.fn(async reports => ({
            reports: reports.map((report, index) => {
                const value = report as { eventId: string; captureId: string }
                return {
                    key: `key-${index}`,
                    eventId: value.eventId,
                    captureId: value.captureId,
                    state: 'pending' as const,
                    duplicate: false,
                }
            }),
        })),
        flush: jest.fn(async () => ({ attempted: 0, confirmed: 0, terminal: 0, retried: 0 })),
        stop: jest.fn(async () => undefined),
    }
    return delivery
}

let sampleKeySequence = 0

function createController(
    runtime: AnimationRuntime,
    delivery: AnimationRumV3DeliveryPort,
    sampleRate = 1,
    sampleKey = `stable-page-${++sampleKeySequence}`
) {
    return createBrowserAnimationRumV3SoftNavigationController({
        dsn: DSN,
        rum: { sampleRate, sampleKey, seed: 'stable-seed', policyVersion: 2 },
        runtime,
        context: {
            routeKey: 'catalog.product-detail',
            release: 'web-1.0.0',
            dist: '42',
            environment: 'test',
            sdkVersion: '1.0.0',
            runtime: { framework: 'react', renderer: 'dom', backend: 'dom' },
        },
        delivery,
    })
}

describe('BrowserAnimationRumV3SoftNavigationController', () => {
    it('projects and persists a finalized segment exactly once without local segment identity', async () => {
        const harness = runtimeHarness()
        const delivery = deliveryHarness()
        const controller = createController(harness.runtime, delivery)

        harness.emitSegment(segment())
        harness.emitSegment(segment())
        await controller.flush()

        expect(delivery.start).toHaveBeenCalledTimes(1)
        expect(delivery.persist).toHaveBeenCalledTimes(1)
        const report = (delivery.persist as jest.Mock).mock.calls[0]![0][0] as Record<string, unknown>
        expect(report).toEqual(
            expect.objectContaining({
                contractVersion: 3,
                captureKind: 'soft-navigation',
                capturedAt: '2026-08-29T08:00:00.000Z',
                context: expect.objectContaining({ routeKey: 'catalog.product-detail' }),
            })
        )
        expect((report.metrics as Array<{ metricId: string }>).map(metric => metric.metricId)).toEqual([
            'vital.soft-navigation.cls.latest',
            'vital.soft-navigation.inp.latest',
            'vital.soft-navigation.lcp.latest',
        ])
        const serialized = JSON.stringify(report)
        expect(serialized).not.toContain('segmentId')
        expect(serialized).not.toContain('startedAt')
        expect(serialized).not.toContain('largestShiftTime')
    })

    it('retries persistence with the same frozen report after an IndexedDB failure', async () => {
        const harness = runtimeHarness()
        const delivery = deliveryHarness()
        ;(delivery.persist as jest.Mock).mockRejectedValueOnce(new Error('idb unavailable'))
        const controller = createController(harness.runtime, delivery)

        harness.emitSegment(segment())
        await expect(controller.flush()).rejects.toThrow('idb unavailable')
        await controller.flush()

        expect(delivery.persist).toHaveBeenCalledTimes(2)
        const first = (delivery.persist as jest.Mock).mock.calls[0]![0][0]
        const second = (delivery.persist as jest.Mock).mock.calls[1]![0][0]
        expect(second).toBe(first)
    })

    it('drains a segment finalized while the preceding durable persistence is still in flight', async () => {
        const harness = runtimeHarness()
        const delivery = deliveryHarness()
        let releaseFirst!: () => void
        const firstPersistence = new Promise<void>(resolve => {
            releaseFirst = resolve
        })
        ;(delivery.persist as jest.Mock).mockImplementationOnce(async () => {
            await firstPersistence
            return { reports: [] }
        })
        const controller = createController(harness.runtime, delivery)

        harness.emitSegment(segment())
        await Promise.resolve()
        harness.emitSegment(
            segment({
                segmentId: 8,
                startedAt: 4_000,
                finalizedAt: 5_500,
                elapsedMs: 1_500,
                latest: {
                    CLS: {
                        name: 'CLS',
                        value: 0.01,
                        delta: 0.01,
                        rating: 'good',
                        navigationType: 'soft-navigation',
                        segmentId: 8,
                        startedAt: 4_000,
                        attribution: {},
                    },
                    INP: null,
                    LCP: null,
                },
            })
        )
        releaseFirst()
        await controller.flush()

        expect(delivery.persist).toHaveBeenCalledTimes(2)
        expect((delivery.persist as jest.Mock).mock.calls[0]![0]).toHaveLength(1)
        expect((delivery.persist as jest.Mock).mock.calls[1]![0]).toHaveLength(1)
    })

    it('reuses the complete retained report identity when replayLatest runs after controller reinitialization', async () => {
        const firstHarness = runtimeHarness()
        const firstDelivery = deliveryHarness()
        const first = createController(firstHarness.runtime, firstDelivery, 1, 'reinitialized-page')
        const value = segment()

        firstHarness.emitSegment(value)
        await first.flush()
        first.dispose()

        const secondHarness = runtimeHarness()
        const secondDelivery = deliveryHarness()
        const second = createController(secondHarness.runtime, secondDelivery, 1, 'reinitialized-page')
        secondHarness.emitSegment(value)
        await second.flush()

        const firstReport = (firstDelivery.persist as jest.Mock).mock.calls[0]![0][0]
        const replayedReport = (secondDelivery.persist as jest.Mock).mock.calls[0]![0][0]
        expect(replayedReport).toBe(firstReport)
        expect(replayedReport).toEqual(
            expect.objectContaining({
                eventId: (firstReport as { eventId: string }).eventId,
                captureId: (firstReport as { captureId: string }).captureId,
                capturedAt: (firstReport as { capturedAt: string }).capturedAt,
            })
        )
    })

    it('reports conflicting evidence for a retained segment instead of silently deduplicating it', async () => {
        const harness = runtimeHarness()
        const delivery = deliveryHarness()
        const controller = createController(harness.runtime, delivery)

        harness.emitSegment(segment())
        await controller.flush()
        harness.emitSegment(segment({ observedUpdateCount: 4 }))

        await expect(controller.flush()).rejects.toThrow('replay identity conflicts with retained segment evidence')
        await expect(controller.flush()).resolves.toBeUndefined()
        expect(delivery.persist).toHaveBeenCalledTimes(1)
    })

    it('contains malformed custom-runtime segment identity and surfaces it on explicit flush', async () => {
        const harness = runtimeHarness()
        const delivery = deliveryHarness()
        const controller = createController(harness.runtime, delivery)

        expect(() => harness.emitSegment(null as never)).not.toThrow()
        await expect(controller.flush()).rejects.toBeInstanceOf(TypeError)
        await expect(controller.flush()).resolves.toBeUndefined()
        expect(delivery.persist).not.toHaveBeenCalled()
    })

    it('drains valid reports after a malformed segment and consumes the projection failure once', async () => {
        const harness = runtimeHarness()
        const delivery = deliveryHarness()
        ;(delivery.persist as jest.Mock).mockRejectedValueOnce(new Error('idb unavailable'))
        const controller = createController(harness.runtime, delivery)

        harness.emitSegment(segment({ segmentId: 51, startedAt: 10_000, finalizedAt: 11_000, elapsedMs: 500 }))
        harness.emitSegment(segment())
        await Promise.resolve()

        await expect(controller.flush()).rejects.toThrow('window timestamps and elapsedMs are inconsistent')
        await expect(controller.flush()).resolves.toBeUndefined()
        expect(delivery.persist).toHaveBeenCalledTimes(2)
    })

    it('suspends durable delivery for BFCache and resumes it without resubscribing the segment stream', async () => {
        const harness = runtimeHarness()
        const delivery = deliveryHarness()
        const controller = createController(harness.runtime, delivery)

        harness.emitSegment(segment())
        harness.emitLifecycle({ type: 'pagehide', persisted: true })
        await controller.flush()
        expect(delivery.suspend).toHaveBeenCalledTimes(1)
        expect(harness.hasSegmentSubscriber()).toBe(true)

        harness.emitLifecycle({ type: 'pageshow', persisted: true })
        await controller.flush()
        expect(delivery.resume).toHaveBeenCalledTimes(1)
        await controller.stopDelivery()
    })

    it('surfaces a failed BFCache suspension once and allows a later resume transition', async () => {
        const harness = runtimeHarness()
        const delivery = deliveryHarness()
        ;(delivery.suspend as jest.Mock).mockRejectedValueOnce(new Error('storage close failed'))
        const controller = createController(harness.runtime, delivery)

        harness.emitLifecycle({ type: 'pagehide', persisted: true })
        await expect(controller.flush()).rejects.toThrow('storage close failed')
        expect(delivery.flush).toHaveBeenCalledTimes(1)

        harness.emitLifecycle({ type: 'pageshow', persisted: true })
        await expect(controller.flush()).resolves.toBeUndefined()
        expect(delivery.resume).toHaveBeenCalledTimes(1)
    })

    it('still stops durable delivery when the preceding BFCache transition failed', async () => {
        const harness = runtimeHarness()
        const delivery = deliveryHarness()
        ;(delivery.suspend as jest.Mock).mockRejectedValueOnce(new Error('lease release failed'))
        const controller = createController(harness.runtime, delivery)

        harness.emitLifecycle({ type: 'pagehide', persisted: true })
        await expect(controller.stopDelivery()).rejects.toThrow('lease release failed')
        expect(delivery.stop).toHaveBeenCalledTimes(1)
        await expect(controller.stopDelivery()).resolves.toBeUndefined()
    })

    it('keeps sampleRate zero inert and reports malformed finalized evidence on explicit flush', async () => {
        const inertHarness = runtimeHarness()
        const inertDelivery = deliveryHarness()
        const inert = createController(inertHarness.runtime, inertDelivery, 0)
        expect(inert.sampled).toBe(false)
        expect(inertHarness.hasSegmentSubscriber()).toBe(false)
        expect(inertDelivery.start).not.toHaveBeenCalled()

        const failingHarness = runtimeHarness()
        const failingDelivery = deliveryHarness()
        const failing = createController(failingHarness.runtime, failingDelivery)
        failingHarness.emitSegment(segment({ elapsedMs: 1_000 }))
        await expect(failing.flush()).rejects.toThrow('window timestamps and elapsedMs are inconsistent')
        await expect(failing.flush()).resolves.toBeUndefined()
        expect(failingDelivery.persist).not.toHaveBeenCalled()
    })
})
