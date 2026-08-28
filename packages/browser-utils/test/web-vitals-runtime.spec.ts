const mockOnCLS = jest.fn()
const mockOnINP = jest.fn()
const mockOnLCP = jest.fn()

jest.mock('../src/metrics/attribution/onCLS', () => ({ onCLS: (...args: unknown[]) => mockOnCLS(...args) }))
jest.mock('../src/metrics/attribution/onINP', () => ({ onINP: (...args: unknown[]) => mockOnINP(...args) }))
jest.mock('../src/metrics/attribution/onLCP', () => ({ onLCP: (...args: unknown[]) => mockOnLCP(...args) }))

import { getFinalReportCallback } from '../src/metrics/lib/finalReport'
import type { CLSMetricWithAttribution, LCPMetricWithAttribution, ReportOpts } from '../src/metrics/types'
import {
    type CLSWebVitalSnapshot,
    getLatestSoftNavigationWebVitals,
    getLatestWebVital,
    getSoftNavigationWebVitalsCapability,
    type LCPWebVitalSnapshot,
    subscribeSoftNavigationWebVitals,
    subscribeWebVitals,
} from '../src/web-vitals-runtime'

const REGISTRY_KEY = Symbol.for('@condev-monitor/web-vitals-runtime/v1')
const SOFT_NAVIGATION_REGISTRY_KEY = Symbol.for('@condev-monitor/soft-navigation-web-vitals-runtime/v1')

function clsMetric(value = 0.15): CLSMetricWithAttribution {
    const privateNode = { nodeType: 1, id: 'private-node' }
    const privateEntry = { startTime: 42, value, sources: [{ node: privateNode }] }
    return {
        name: 'CLS',
        value,
        delta: value,
        rating: 'needs-improvement',
        navigationType: 'navigate',
        id: 'private-metric-id',
        entries: [privateEntry],
        attribution: {
            largestShiftTarget: '#private-node',
            largestShiftTime: 42,
            largestShiftValue: value,
            largestShiftEntry: privateEntry,
            largestShiftSource: privateEntry.sources[0],
            loadState: 'complete',
        },
    } as unknown as CLSMetricWithAttribution
}

function lcpMetric(): LCPMetricWithAttribution {
    const privateEntry = { startTime: 1200, url: 'https://private.test/hero.png', element: { id: 'hero' } }
    return {
        name: 'LCP',
        value: 1200,
        delta: 1200,
        rating: 'good',
        navigationType: 'reload',
        id: 'private-lcp-id',
        entries: [privateEntry],
        attribution: {
            element: '#hero',
            url: privateEntry.url,
            timeToFirstByte: 100,
            resourceLoadDelay: 20,
            resourceLoadDuration: 300,
            elementRenderDelay: 780,
            navigationEntry: { name: 'https://private.test/page' },
            lcpResourceEntry: { name: privateEntry.url },
            lcpEntry: privateEntry,
        },
    } as unknown as LCPMetricWithAttribution
}

describe('shared Web Vitals runtime', () => {
    const originalWindow = globalThis.window
    const originalDocument = globalThis.document

    beforeEach(() => {
        delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
        mockOnCLS.mockReset()
        mockOnINP.mockReset()
        mockOnLCP.mockReset()
        Object.assign(globalThis, { window: {}, document: {} })
    })

    afterEach(() => {
        delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
        Object.assign(globalThis, { window: originalWindow, document: originalDocument })
    })

    it('starts one observer set, isolates subscribers, replays latest, and strips private attribution', () => {
        const throwingSubscriber = jest.fn(() => {
            throw new Error('consumer failure')
        })
        const healthySubscriber = jest.fn()
        const unsubscribeThrowing = subscribeWebVitals(throwingSubscriber)
        const unsubscribeHealthy = subscribeWebVitals(healthySubscriber)

        expect(mockOnCLS).toHaveBeenCalledTimes(1)
        expect(mockOnINP).toHaveBeenCalledTimes(1)
        expect(mockOnLCP).toHaveBeenCalledTimes(1)
        expect(mockOnCLS.mock.calls[0]?.[1]).toMatchObject({ reportAllChanges: true })

        const reportCLS = mockOnCLS.mock.calls[0]?.[0] as (metric: CLSMetricWithAttribution) => void
        reportCLS(clsMetric())

        const expected: CLSWebVitalSnapshot = {
            name: 'CLS',
            value: 0.15,
            delta: 0.15,
            rating: 'needs-improvement',
            navigationType: 'navigate',
            attribution: {
                largestShiftTime: 42,
                largestShiftValue: 0.15,
                loadState: 'complete',
            },
        }
        expect(healthySubscriber).toHaveBeenCalledWith(expected)
        expect(throwingSubscriber).toHaveBeenCalledTimes(1)

        const latest = getLatestWebVital('CLS') as CLSWebVitalSnapshot
        expect(latest).toEqual(expected)
        expect(Object.isFrozen(latest)).toBe(true)
        expect(Object.isFrozen(latest.attribution)).toBe(true)
        expect(JSON.stringify(latest)).not.toMatch(/private|target|entry|source|node|url|element/i)

        const replaySubscriber = jest.fn()
        const unsubscribeReplay = subscribeWebVitals(replaySubscriber, { replayLatest: true })
        expect(replaySubscriber).toHaveBeenCalledTimes(1)
        expect(replaySubscriber).toHaveBeenCalledWith(expected)

        unsubscribeHealthy()
        unsubscribeHealthy()
        reportCLS(clsMetric(0.2))
        expect(healthySubscriber).toHaveBeenCalledTimes(1)
        expect(replaySubscriber).toHaveBeenCalledTimes(2)

        unsubscribeThrowing()
        unsubscribeReplay()
    })

    it('keeps live and legacy-final delivery separate', () => {
        const liveSubscriber = jest.fn()
        const finalSubscriber = jest.fn()
        subscribeWebVitals(liveSubscriber)
        subscribeWebVitals(finalSubscriber, { delivery: 'final' })

        const reportLCP = mockOnLCP.mock.calls[0]?.[0] as (metric: LCPMetricWithAttribution) => void
        const options = mockOnLCP.mock.calls[0]?.[1] as ReportOpts
        const reportFinalLCP = getFinalReportCallback<LCPMetricWithAttribution>(options)
        const metric = lcpMetric()

        reportLCP(metric)
        expect(liveSubscriber).toHaveBeenCalledTimes(1)
        expect(finalSubscriber).not.toHaveBeenCalled()

        reportFinalLCP?.(metric)
        const expected: LCPWebVitalSnapshot = {
            name: 'LCP',
            value: 1200,
            delta: 1200,
            rating: 'good',
            navigationType: 'reload',
            attribution: {
                timeToFirstByte: 100,
                resourceLoadDelay: 20,
                resourceLoadDuration: 300,
                elementRenderDelay: 780,
            },
        }
        expect(finalSubscriber).toHaveBeenCalledWith(expected)
        expect(liveSubscriber).toHaveBeenCalledTimes(1)
        expect(getLatestWebVital('LCP', 'final')).toEqual(expected)
    })

    it('shares the singleton across module reloads', async () => {
        const unsubscribeFirst = subscribeWebVitals(jest.fn())
        jest.resetModules()
        const reloadedRuntime = await import('../src/web-vitals-runtime')
        const unsubscribeReloaded = reloadedRuntime.subscribeWebVitals(jest.fn())

        expect(mockOnCLS).toHaveBeenCalledTimes(1)
        expect(mockOnINP).toHaveBeenCalledTimes(1)
        expect(mockOnLCP).toHaveBeenCalledTimes(1)

        unsubscribeFirst()
        unsubscribeReloaded()
    })

    it('is SSR-safe and returns an idempotent no-op unsubscribe', () => {
        Object.assign(globalThis, { window: undefined, document: undefined })
        const callback = jest.fn()
        const unsubscribe = subscribeWebVitals(callback, { replayLatest: true })

        expect(() => {
            unsubscribe()
            unsubscribe()
        }).not.toThrow()
        expect(callback).not.toHaveBeenCalled()
        expect(mockOnCLS).not.toHaveBeenCalled()
        expect(mockOnINP).not.toHaveBeenCalled()
        expect(mockOnLCP).not.toHaveBeenCalled()
    })
})

class FakePerformanceObserver {
    static supportedEntryTypes: string[] = []
    static instances: FakePerformanceObserver[] = []
    static rejectedTypes = new Set<string>()
    static throwOnTakeRecords = false

    readonly observed: PerformanceObserverInit[] = []
    private readonly records: PerformanceEntry[] = []

    constructor(private readonly callback: PerformanceObserverCallback) {
        FakePerformanceObserver.instances.push(this)
    }

    observe(options: PerformanceObserverInit): void {
        if (typeof options.type === 'string' && FakePerformanceObserver.rejectedTypes.has(options.type)) {
            throw new Error(`unsupported ${options.type}`)
        }
        this.observed.push(options)
    }

    disconnect(): void {}

    takeRecords(): PerformanceEntryList {
        if (FakePerformanceObserver.throwOnTakeRecords) throw new Error('takeRecords failed')
        return this.records.splice(0) as unknown as PerformanceEntryList
    }

    emit(entries: readonly PerformanceEntry[], flush = true): void {
        this.callback(
            {
                getEntries: () => [...entries],
            } as PerformanceObserverEntryList,
            this as unknown as PerformanceObserver
        )
        if (flush) jest.runOnlyPendingTimers()
    }
}

class SupportedSoftNavigation {
    getLargestInteractionContentfulPaint(): null {
        return null
    }
}

class SupportedEventTiming {
    get interactionId(): number {
        return 0
    }
}

function performanceEntry(entryType: string, startTime: number, duration = 0, fields: Record<string, unknown> = {}): PerformanceEntry {
    return {
        name: 'https://private.test/never-retain',
        entryType,
        startTime,
        duration,
        toJSON: () => ({ privateText: 'never-retain' }),
        ...fields,
    } as unknown as PerformanceEntry
}

describe('soft-navigation Web Vitals runtime', () => {
    const originalWindow = globalThis.window
    const originalDocument = globalThis.document
    const originalPerformanceObserver = globalThis.PerformanceObserver
    const originalPerformanceSoftNavigation = (
        globalThis as typeof globalThis & { PerformanceSoftNavigation?: typeof SupportedSoftNavigation }
    ).PerformanceSoftNavigation
    const originalPerformanceEventTiming = (globalThis as typeof globalThis & { PerformanceEventTiming?: typeof SupportedEventTiming })
        .PerformanceEventTiming
    const originalAddEventListener = globalThis.addEventListener
    let documentListeners: Map<string, Set<EventListener>>
    let globalListeners: Map<string, Set<EventListener>>
    let fakeDocument: Document & { visibilityState: DocumentVisibilityState }

    beforeEach(() => {
        jest.useFakeTimers()
        delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
        delete (globalThis as unknown as Record<symbol, unknown>)[SOFT_NAVIGATION_REGISTRY_KEY]
        mockOnCLS.mockReset()
        mockOnINP.mockReset()
        mockOnLCP.mockReset()
        FakePerformanceObserver.instances = []
        FakePerformanceObserver.rejectedTypes = new Set()
        FakePerformanceObserver.throwOnTakeRecords = false
        FakePerformanceObserver.supportedEntryTypes = [
            'soft-navigation',
            'layout-shift',
            'event',
            'first-input',
            'interaction-contentful-paint',
        ]
        documentListeners = new Map()
        globalListeners = new Map()
        fakeDocument = {
            visibilityState: 'visible',
            addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
                const callback = listener as EventListener
                const listeners = documentListeners.get(type) ?? new Set<EventListener>()
                listeners.add(callback)
                documentListeners.set(type, listeners)
            },
        } as unknown as Document & { visibilityState: DocumentVisibilityState }
        Object.assign(globalThis, {
            window: {},
            document: fakeDocument,
            PerformanceObserver: FakePerformanceObserver,
            PerformanceSoftNavigation: SupportedSoftNavigation,
            PerformanceEventTiming: SupportedEventTiming,
            addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
                const callback = listener as EventListener
                const listeners = globalListeners.get(type) ?? new Set<EventListener>()
                listeners.add(callback)
                globalListeners.set(type, listeners)
            },
        })
    })

    afterEach(() => {
        jest.runOnlyPendingTimers()
        jest.useRealTimers()
        delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
        delete (globalThis as unknown as Record<symbol, unknown>)[SOFT_NAVIGATION_REGISTRY_KEY]
        Object.assign(globalThis, {
            window: originalWindow,
            document: originalDocument,
            PerformanceObserver: originalPerformanceObserver,
            PerformanceSoftNavigation: originalPerformanceSoftNavigation,
            PerformanceEventTiming: originalPerformanceEventTiming,
            addEventListener: originalAddEventListener,
        })
    })

    it('reports explicit unknown and unsupported capability without starting either stream', () => {
        Object.assign(globalThis, { window: undefined, document: undefined })
        expect(getSoftNavigationWebVitalsCapability()).toEqual({
            status: 'unknown',
            reason: 'not-browser-runtime',
            metrics: { CLS: 'unknown', INP: 'unknown', LCP: 'unknown' },
        })
        const serverCallback = jest.fn()
        subscribeSoftNavigationWebVitals(serverCallback)
        expect(serverCallback).not.toHaveBeenCalled()

        Object.assign(globalThis, { window: {}, document: fakeDocument })
        Object.assign(globalThis, {
            PerformanceSoftNavigation: class UnsupportedSoftNavigation {},
        })
        expect(getSoftNavigationWebVitalsCapability()).toEqual({
            status: 'unsupported',
            reason: 'largest-interaction-contentful-paint-unsupported',
            metrics: { CLS: 'unsupported', INP: 'unsupported', LCP: 'unsupported' },
        })

        Object.assign(globalThis, { PerformanceSoftNavigation: SupportedSoftNavigation })
        FakePerformanceObserver.supportedEntryTypes = ['layout-shift']
        expect(getSoftNavigationWebVitalsCapability()).toEqual({
            status: 'unsupported',
            reason: 'soft-navigation-entry-unsupported',
            metrics: { CLS: 'unsupported', INP: 'unsupported', LCP: 'unsupported' },
        })
        subscribeSoftNavigationWebVitals(jest.fn())
        expect(FakePerformanceObserver.instances).toHaveLength(0)
        expect(mockOnCLS).not.toHaveBeenCalled()
        expect(mockOnINP).not.toHaveBeenCalled()
        expect(mockOnLCP).not.toHaveBeenCalled()
    })

    it('does not claim complete INP support from first-input alone or a failed event registration', () => {
        FakePerformanceObserver.supportedEntryTypes = ['soft-navigation', 'layout-shift', 'first-input', 'interaction-contentful-paint']
        subscribeSoftNavigationWebVitals(jest.fn())
        expect(getSoftNavigationWebVitalsCapability()).toMatchObject({
            status: 'supported',
            metrics: { CLS: 'supported', INP: 'unsupported', LCP: 'supported' },
        })

        delete (globalThis as unknown as Record<symbol, unknown>)[SOFT_NAVIGATION_REGISTRY_KEY]
        FakePerformanceObserver.instances = []
        FakePerformanceObserver.supportedEntryTypes.push('event')
        FakePerformanceObserver.rejectedTypes.add('event')
        subscribeSoftNavigationWebVitals(jest.fn())
        expect(getSoftNavigationWebVitalsCapability()).toMatchObject({
            status: 'supported',
            metrics: { CLS: 'supported', INP: 'unsupported', LCP: 'supported' },
        })
    })

    it('segments live and final metrics while retaining only privacy-safe attribution', () => {
        const throwingLive = jest.fn(() => {
            throw new Error('consumer failure')
        })
        const healthyLive = jest.fn()
        const healthyFinal = jest.fn()
        subscribeSoftNavigationWebVitals(throwingLive)
        subscribeSoftNavigationWebVitals(healthyLive)
        subscribeSoftNavigationWebVitals(healthyFinal, { delivery: 'final' })

        expect(getSoftNavigationWebVitalsCapability()).toMatchObject({ status: 'supported' })
        expect(FakePerformanceObserver.instances).toHaveLength(1)
        expect(mockOnCLS).not.toHaveBeenCalled()
        const observer = FakePerformanceObserver.instances[0]!
        const privateNode = { id: 'private-node', textContent: 'private text' }
        const initialPaint = performanceEntry('interaction-contentful-paint', 160, 0, {
            interactionId: 90011,
            largestContentfulPaint: {
                startTime: 450,
                renderTime: 450,
                size: 6400,
                url: 'https://private.test/hero.png',
                element: privateNode,
            },
        })
        observer.emit([
            performanceEntry('soft-navigation', 100, 0, {
                navigationId: 7001,
                interactionId: 90011,
                navigationURL: 'https://private.test/account/secret',
                getLargestInteractionContentfulPaint: () => initialPaint,
            }),
        ])
        observer.emit([
            performanceEntry('layout-shift', 150, 0, {
                value: 0.12,
                hadRecentInput: false,
                sources: [{ node: privateNode }],
            }),
            performanceEntry('event', 200, 240, {
                name: 'click',
                interactionId: 90012,
                processingStart: 220,
                processingEnd: 360,
                target: privateNode,
            }),
            performanceEntry('interaction-contentful-paint', 300, 0, {
                interactionId: 123456,
                largestContentfulPaint: {
                    renderTime: 9000,
                    size: 9999,
                    url: 'https://private.test/wrong-navigation.png',
                    element: privateNode,
                },
            }),
        ])

        expect(healthyLive.mock.calls.map(call => call[0].name)).toEqual(['CLS', 'LCP', 'CLS', 'INP'])
        expect(throwingLive).toHaveBeenCalledTimes(4)
        expect(healthyFinal).not.toHaveBeenCalled()

        observer.emit([
            performanceEntry('soft-navigation', 1000, 0, {
                navigationId: 7002,
                interactionId: 90021,
                getLargestInteractionContentfulPaint: () => null,
            }),
        ])
        expect(healthyFinal.mock.calls.map(call => call[0].name)).toEqual(['CLS', 'INP', 'LCP'])
        expect(healthyFinal.mock.calls.every(call => call[0].segmentId === 1)).toBe(true)

        const retained = getLatestSoftNavigationWebVitals()
        expect(retained.find(metric => metric.name === 'LCP' && metric.segmentId === 1)).toMatchObject({
            value: 350,
            segmentId: 1,
            startedAt: 100,
            attribution: { paintTime: 450, size: 6400 },
        })
        expect(retained.find(metric => metric.name === 'INP' && metric.segmentId === 1)).toMatchObject({
            value: 240,
            attribution: {
                interactionTime: 200,
                nextPaintTime: 440,
                interactionType: 'pointer',
                inputDelay: 20,
                processingDuration: 140,
                presentationDelay: 80,
            },
        })
        expect(JSON.stringify([...retained, ...getLatestSoftNavigationWebVitals('final')])).not.toMatch(
            /private|navigationId|interactionId|navigationURL|selector|textContent|target|element|sources|https:/iu
        )
    })

    it('keeps the longest INP candidates and ranks them using the full interaction range', () => {
        subscribeSoftNavigationWebVitals(jest.fn())
        const observer = FakePerformanceObserver.instances[0]!
        observer.emit([
            performanceEntry('soft-navigation', 100, 0, {
                navigationId: 7001,
                interactionId: 777,
                getLargestInteractionContentfulPaint: () => null,
            }),
        ])

        const events = Array.from({ length: 61 }, (_, index) =>
            performanceEntry('event', 200 + index, index === 0 ? 900 : index === 1 ? 400 : 100, {
                name: 'click',
                navigationId: 7001,
                interactionId: 1000 + index * 7,
            })
        )
        observer.emit([
            ...events,
            performanceEntry('event', 300, 50, {
                name: 'pointerup',
                navigationId: 7001,
                interactionId: 1000,
            }),
        ])
        observer.emit([
            performanceEntry('soft-navigation', 1000, 0, {
                navigationId: 7002,
                interactionId: 888,
                getLargestInteractionContentfulPaint: () => null,
            }),
        ])

        expect(getLatestSoftNavigationWebVitals('final').find(metric => metric.segmentId === 1 && metric.name === 'INP')).toMatchObject({
            value: 400,
            attribution: { interactionTime: 201 },
        })
    })

    it('batches a soft-navigation boundary with Event Timing delivered by the next observer callback', () => {
        subscribeSoftNavigationWebVitals(jest.fn())
        const observer = FakePerformanceObserver.instances[0]!
        observer.emit([
            performanceEntry('soft-navigation', 100, 0, {
                navigationId: 7001,
                interactionId: 70,
                getLargestInteractionContentfulPaint: () => null,
            }),
        ])
        observer.emit(
            [
                performanceEntry('soft-navigation', 1000, 0, {
                    navigationId: 7002,
                    interactionId: 140,
                    getLargestInteractionContentfulPaint: () => null,
                }),
            ],
            false
        )
        observer.emit([
            performanceEntry('event', 1000, 360, {
                name: 'click',
                navigationId: 7002,
                interactionId: 140,
            }),
        ])
        observer.emit([
            performanceEntry('soft-navigation', 2000, 0, {
                navigationId: 7003,
                interactionId: 210,
                getLargestInteractionContentfulPaint: () => null,
            }),
        ])

        expect(getLatestSoftNavigationWebVitals('final').find(metric => metric.segmentId === 2 && metric.name === 'INP')).toMatchObject({
            value: 360,
            attribution: { interactionTime: 1000 },
        })
    })

    it('uses strict CLS session boundaries and attributes the largest shift in the winning session', () => {
        subscribeSoftNavigationWebVitals(jest.fn())
        const observer = FakePerformanceObserver.instances[0]!
        observer.emit([
            performanceEntry('soft-navigation', 100, 0, {
                navigationId: 7001,
                interactionId: 70,
                getLargestInteractionContentfulPaint: () => null,
            }),
        ])
        observer.emit([
            performanceEntry('layout-shift', 200, 0, { navigationId: 7001, value: 0.2, hadRecentInput: false }),
            performanceEntry('layout-shift', 500, 0, { navigationId: 7001, value: 0.1, hadRecentInput: false }),
        ])
        expect(getLatestSoftNavigationWebVitals().find(metric => metric.name === 'CLS')).toMatchObject({
            value: 0.30000000000000004,
            attribution: { largestShiftTime: 200, largestShiftValue: 0.2 },
        })

        observer.emit([
            performanceEntry('layout-shift', 1500, 0, { navigationId: 7001, value: 0.25, hadRecentInput: false }),
            performanceEntry('layout-shift', 6500, 0, { navigationId: 7001, value: 0.4, hadRecentInput: false }),
        ])
        expect(getLatestSoftNavigationWebVitals().find(metric => metric.name === 'CLS')).toMatchObject({
            value: 0.4,
            attribution: { largestShiftTime: 6500, largestShiftValue: 0.4 },
        })
    })

    it('rejects mismatched navigation entries, refreshes final LCP, and closes hidden segments', () => {
        const live = jest.fn()
        const final = jest.fn()
        subscribeSoftNavigationWebVitals(live)
        subscribeSoftNavigationWebVitals(final, { delivery: 'final' })
        const observer = FakePerformanceObserver.instances[0]!
        let latestPaint: PerformanceEntry | null = null
        const largeNavigationId = Number.MAX_SAFE_INTEGER + 100
        observer.emit([
            performanceEntry('soft-navigation', 100, 0, {
                navigationId: largeNavigationId,
                interactionId: 91,
                getLargestInteractionContentfulPaint: () => latestPaint,
            }),
        ])
        observer.emit([
            performanceEntry('layout-shift', 150, 0, {
                navigationId: largeNavigationId + 2,
                value: 0.4,
                hadRecentInput: false,
            }),
            performanceEntry('event', 160, 600, {
                name: 'click',
                navigationId: largeNavigationId + 2,
                interactionId: 98,
            }),
        ])
        latestPaint = performanceEntry('interaction-contentful-paint', 100, 0, {
            interactionId: 91,
            largestContentfulPaint: {
                startTime: 620,
                renderTime: 0,
                loadTime: 620,
                size: 2048,
            },
        })

        Object.assign(fakeDocument, { visibilityState: 'hidden' })
        for (const listener of documentListeners.get('visibilitychange') ?? []) listener(new Event('visibilitychange'))
        const liveCallsAtClose = live.mock.calls.length
        observer.emit([
            performanceEntry('layout-shift', 700, 0, {
                navigationId: largeNavigationId,
                value: 0.5,
                hadRecentInput: false,
            }),
            performanceEntry('event', 710, 800, {
                name: 'click',
                navigationId: largeNavigationId,
                interactionId: 105,
            }),
        ])

        expect(live).toHaveBeenCalledTimes(liveCallsAtClose)
        expect(final.mock.calls.map(call => call[0].name)).toEqual(['CLS', 'LCP'])
        expect(final).toHaveBeenCalledWith(expect.objectContaining({ name: 'CLS', value: 0 }))
        expect(final).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'LCP', value: 520, attribution: { paintTime: 620, size: 2048 } })
        )
    })

    it('does not publish stale final evidence when the final LCP read fails', () => {
        const final = jest.fn()
        subscribeSoftNavigationWebVitals(jest.fn())
        subscribeSoftNavigationWebVitals(final, { delivery: 'final' })
        const observer = FakePerformanceObserver.instances[0]!
        let failFinalRead = false
        const initialPaint = performanceEntry('interaction-contentful-paint', 100, 0, {
            interactionId: 70,
            largestContentfulPaint: { startTime: 500, renderTime: 500, size: 1000 },
        })
        observer.emit([
            performanceEntry('soft-navigation', 100, 0, {
                navigationId: 7001,
                interactionId: 70,
                getLargestInteractionContentfulPaint: () => {
                    if (failFinalRead) throw new Error('getter failed')
                    return initialPaint
                },
            }),
        ])
        failFinalRead = true
        Object.assign(fakeDocument, { visibilityState: 'hidden' })
        for (const listener of documentListeners.get('visibilitychange') ?? []) listener(new Event('visibilitychange'))

        expect(final.mock.calls.map(call => call[0].name)).toEqual(['CLS'])
        expect(getSoftNavigationWebVitalsCapability()).toMatchObject({
            status: 'supported',
            reason: 'runtime-read-failed',
            metrics: { CLS: 'supported', INP: 'supported', LCP: 'unknown' },
        })
    })

    it('does not publish final metrics when takeRecords fails during hidden flush', () => {
        const final = jest.fn()
        subscribeSoftNavigationWebVitals(final, { delivery: 'final' })
        const observer = FakePerformanceObserver.instances[0]!
        observer.emit([
            performanceEntry('soft-navigation', 100, 0, {
                navigationId: 7001,
                interactionId: 70,
                getLargestInteractionContentfulPaint: () => null,
            }),
            performanceEntry('layout-shift', 200, 0, { navigationId: 7001, value: 0.2, hadRecentInput: false }),
        ])
        const secondPaint = performanceEntry('interaction-contentful-paint', 1000, 0, {
            interactionId: 140,
            largestContentfulPaint: { startTime: 1500, renderTime: 1500, size: 2000 },
        })
        observer.emit(
            [
                performanceEntry('soft-navigation', 1000, 0, {
                    navigationId: 7002,
                    interactionId: 140,
                    getLargestInteractionContentfulPaint: () => secondPaint,
                }),
                performanceEntry('event', 1100, 300, {
                    name: 'click',
                    navigationId: 7002,
                    interactionId: 147,
                }),
            ],
            false
        )
        FakePerformanceObserver.throwOnTakeRecords = true
        Object.assign(fakeDocument, { visibilityState: 'hidden' })
        for (const listener of documentListeners.get('visibilitychange') ?? []) listener(new Event('visibilitychange'))

        expect(final).not.toHaveBeenCalled()
        expect(getSoftNavigationWebVitalsCapability()).toEqual({
            status: 'supported',
            reason: 'runtime-read-failed',
            metrics: { CLS: 'unknown', INP: 'unknown', LCP: 'unknown' },
        })
    })

    it('suppresses every final touched by an overflowing observer batch', () => {
        const final = jest.fn()
        subscribeSoftNavigationWebVitals(final, { delivery: 'final' })
        const observer = FakePerformanceObserver.instances[0]!
        observer.emit([
            performanceEntry('soft-navigation', 100, 0, {
                navigationId: 7001,
                interactionId: 70,
                getLargestInteractionContentfulPaint: () => null,
            }),
        ])

        const overflowBatch = [
            ...Array.from({ length: 2049 }, (_, index) => performanceEntry('resource', 200 + index)),
            performanceEntry('soft-navigation', 3000, 0, {
                navigationId: 7002,
                interactionId: 140,
                getLargestInteractionContentfulPaint: () => null,
            }),
            performanceEntry('event', 3100, 320, {
                name: 'click',
                navigationId: 7002,
                interactionId: 147,
            }),
        ]
        observer.emit(overflowBatch)
        observer.emit([
            performanceEntry('soft-navigation', 4000, 0, {
                navigationId: 7003,
                interactionId: 210,
                getLargestInteractionContentfulPaint: () => null,
            }),
        ])

        expect(final).not.toHaveBeenCalled()
        expect(getSoftNavigationWebVitalsCapability()).toEqual({
            status: 'supported',
            reason: 'runtime-read-failed',
            metrics: { CLS: 'unknown', INP: 'unknown', LCP: 'unknown' },
        })
    })

    it('retains and replays only the two newest navigation segments', () => {
        subscribeSoftNavigationWebVitals(jest.fn())
        const observer = FakePerformanceObserver.instances[0]!
        for (const [index, navigationId] of [101, 202, 303].entries()) {
            observer.emit([
                performanceEntry('soft-navigation', (index + 1) * 100, 0, {
                    navigationId,
                    interactionId: navigationId * 10,
                    getLargestInteractionContentfulPaint: () => null,
                }),
            ])
        }

        expect(getLatestSoftNavigationWebVitals().map(metric => metric.segmentId)).toEqual([2, 3])
        expect(getLatestSoftNavigationWebVitals('final').map(metric => metric.segmentId)).toEqual([1, 2])

        const replayLive = jest.fn()
        const replayFinal = jest.fn()
        subscribeSoftNavigationWebVitals(replayLive, { replayLatest: true })
        subscribeSoftNavigationWebVitals(replayFinal, { delivery: 'final', replayLatest: true })
        expect(replayLive.mock.calls.map(call => call[0].segmentId)).toEqual([2, 3])
        expect(replayFinal.mock.calls.map(call => call[0].segmentId)).toEqual([1, 2])
    })

    it('shares a single soft-navigation observer across module reloads', async () => {
        const unsubscribeFirst = subscribeSoftNavigationWebVitals(jest.fn())
        jest.resetModules()
        const reloadedRuntime = await import('../src/web-vitals-runtime')
        const unsubscribeReloaded = reloadedRuntime.subscribeSoftNavigationWebVitals(jest.fn())

        expect(FakePerformanceObserver.instances).toHaveLength(1)
        expect(mockOnCLS).not.toHaveBeenCalled()
        expect(mockOnINP).not.toHaveBeenCalled()
        expect(mockOnLCP).not.toHaveBeenCalled()

        unsubscribeFirst()
        unsubscribeReloaded()
    })

    it('finalizes once on hidden and isolates live, final, and throwing subscribers', () => {
        const live = jest.fn()
        const throwingFinal = jest.fn(() => {
            throw new Error('final failure')
        })
        const healthyFinal = jest.fn()
        const unsubscribeLive = subscribeSoftNavigationWebVitals(live)
        subscribeSoftNavigationWebVitals(throwingFinal, { delivery: 'final' })
        subscribeSoftNavigationWebVitals(healthyFinal, { delivery: 'final' })
        const observer = FakePerformanceObserver.instances[0]!
        observer.emit([
            performanceEntry('soft-navigation', 100, 0, {
                navigationId: 1,
                interactionId: 10,
                getLargestInteractionContentfulPaint: () => null,
            }),
        ])

        unsubscribeLive()
        unsubscribeLive()
        Object.assign(fakeDocument, { visibilityState: 'hidden' })
        for (const listener of documentListeners.get('visibilitychange') ?? []) listener(new Event('visibilitychange'))
        for (const listener of documentListeners.get('visibilitychange') ?? []) listener(new Event('visibilitychange'))

        expect(live).toHaveBeenCalledTimes(1)
        expect(throwingFinal).toHaveBeenCalledTimes(1)
        expect(healthyFinal).toHaveBeenCalledTimes(1)
        expect(healthyFinal).toHaveBeenCalledWith(expect.objectContaining({ name: 'CLS', segmentId: 1, value: 0 }))
        expect(mockOnCLS).not.toHaveBeenCalled()
        expect(mockOnINP).not.toHaveBeenCalled()
        expect(mockOnLCP).not.toHaveBeenCalled()
    })
})
