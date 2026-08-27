import { observeLongAnimationFrameDiagnostics, observePerformanceEntries } from '../src/performance-runtime'

const REGISTRY_KEY = Symbol.for('@condev-monitor/performance-runtime/v1')

class FakePerformanceObserver {
    static supportedEntryTypes = ['long-animation-frame']

    readonly observe = jest.fn()
    readonly disconnect = jest.fn()
    readonly takeRecords = jest.fn((): PerformanceEntry[] => [])

    constructor(readonly callback: PerformanceObserverCallback) {}

    emit(entries: PerformanceEntry[]): void {
        this.callback({ getEntries: () => entries } as PerformanceObserverEntryList, this as unknown as PerformanceObserver)
    }
}

function loaf(overrides: Record<string, unknown>): PerformanceEntry {
    return {
        entryType: 'long-animation-frame',
        name: 'long-animation-frame',
        startTime: 100,
        duration: 75,
        toJSON: () => ({}),
        ...overrides,
    } as unknown as PerformanceEntry
}

function expectAggregateInvariants(snapshot: ReturnType<ReturnType<typeof observeLongAnimationFrameDiagnostics>['snapshot']>): void {
    for (const aggregate of [snapshot.loafFirstUiEventToFrameEnd, snapshot.loafAttributedForcedStyleLayout]) {
        expect(aggregate.truncated).toBe((aggregate.dropped ?? 0) > 0)
        if (aggregate.accepted === null) {
            expect(aggregate.retained).toBeNull()
            expect(aggregate.dropped).toBeNull()
        } else {
            expect(aggregate.retained).not.toBeNull()
            expect(aggregate.dropped).not.toBeNull()
            expect(aggregate.retained! + aggregate.dropped!).toBe(aggregate.accepted)
        }
    }
}

describe('privacy-safe LoAF diagnostic aggregates', () => {
    const originalWindow = globalThis.window
    const originalDocument = globalThis.document
    const originalPerformanceObserver = globalThis.PerformanceObserver
    let observers: FakePerformanceObserver[]

    beforeEach(() => {
        delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
        observers = []
        class CapturingPerformanceObserver extends FakePerformanceObserver {
            constructor(callback: PerformanceObserverCallback) {
                super(callback)
                observers.push(this)
            }
        }
        Object.assign(globalThis, {
            window: {},
            document: {},
            PerformanceObserver: CapturingPerformanceObserver,
        })
    })

    afterEach(() => {
        delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
        Object.assign(globalThis, {
            window: originalWindow,
            document: originalDocument,
            PerformanceObserver: originalPerformanceObserver,
        })
    })

    it('does not inspect attributed scripts unless the diagnostic observer is active', () => {
        const ordinarySubscriber = jest.fn()
        const unsubscribe = observePerformanceEntries('long-animation-frame', ordinarySubscriber)
        const scriptsGetter = jest.fn(() => [{ forcedStyleAndLayoutDuration: 4 }])
        const entry = loaf({ firstUIEventTimestamp: 80 }) as PerformanceEntry & { scripts?: unknown }
        Object.defineProperty(entry, 'scripts', { get: scriptsGetter })

        observers[0]!.emit([entry])

        expect(ordinarySubscriber).toHaveBeenCalledTimes(1)
        expect(scriptsGetter).not.toHaveBeenCalled()
        unsubscribe()
    })

    it('drains reused queued records to existing ordinary subscribers before opening a new capture', () => {
        const ordinarySubscriber = jest.fn()
        const unsubscribeOrdinary = observePerformanceEntries('long-animation-frame', ordinarySubscriber)
        observers[0]!.takeRecords.mockReturnValueOnce([
            loaf({ startTime: 10, duration: 50, firstUIEventTimestamp: 5, scripts: [{ forcedStyleAndLayoutDuration: 7 }] }),
        ])

        const diagnostics = observeLongAnimationFrameDiagnostics()

        expect(diagnostics.buffered).toBe(false)
        expect(ordinarySubscriber).toHaveBeenCalledTimes(1)
        expect(diagnostics.snapshot().loafFirstUiEventToFrameEnd).toMatchObject({ count: null, status: 'not-observed' })
        observers[0]!.emit([
            loaf({ startTime: 100, duration: 50, firstUIEventTimestamp: 140, scripts: [{ forcedStyleAndLayoutDuration: 3 }] }),
        ])
        expect(diagnostics.snapshot().loafFirstUiEventToFrameEnd).toMatchObject({ count: 1, p95Ms: 10, status: 'measured' })

        diagnostics.disconnect()
        unsubscribeOrdinary()
    })

    it('delivers queued records to an existing diagnostic capture but not a newly joining capture', () => {
        const first = observeLongAnimationFrameDiagnostics()
        expect(observers[0]!.observe).toHaveBeenCalledWith({ type: 'long-animation-frame', buffered: false })
        observers[0]!.takeRecords.mockReturnValueOnce([
            loaf({ startTime: 10, duration: 50, firstUIEventTimestamp: 5, scripts: [{ forcedStyleAndLayoutDuration: 2 }] }),
        ])

        const second = observeLongAnimationFrameDiagnostics()

        expect(first.snapshot().loafFirstUiEventToFrameEnd).toMatchObject({ count: 1, p95Ms: 55, status: 'measured' })
        expect(second.snapshot().loafFirstUiEventToFrameEnd).toMatchObject({ count: null, status: 'not-observed' })
        observers[0]!.emit([
            loaf({ startTime: 100, duration: 50, firstUIEventTimestamp: 140, scripts: [{ forcedStyleAndLayoutDuration: 4 }] }),
        ])
        expect(first.snapshot().loafFirstUiEventToFrameEnd.count).toBe(2)
        expect(second.snapshot().loafFirstUiEventToFrameEnd).toMatchObject({ count: 1, p95Ms: 10, status: 'measured' })

        second.disconnect()
        first.disconnect()
    })

    it('fails a new capture closed when its pre-subscription queue cannot be drained', () => {
        const ordinarySubscriber = jest.fn()
        const unsubscribeOrdinary = observePerformanceEntries('long-animation-frame', ordinarySubscriber)
        observers[0]!.takeRecords.mockImplementationOnce(() => {
            throw new Error('takeRecords failed')
        })

        const diagnostics = observeLongAnimationFrameDiagnostics()

        expect(diagnostics.state).toBe('unknown')
        expect(diagnostics.reason).toBe('long-animation-frame capture boundary drain failed')
        observers[0]!.emit([
            loaf({ startTime: 100, duration: 50, firstUIEventTimestamp: 140, scripts: [{ forcedStyleAndLayoutDuration: 3 }] }),
        ])
        expect(ordinarySubscriber).toHaveBeenCalledTimes(1)
        expect(diagnostics.snapshot().loafFirstUiEventToFrameEnd).toMatchObject({ count: null, status: 'unknown' })

        diagnostics.disconnect()
        unsubscribeOrdinary()
    })

    it('derives the two valid-count/p95 pairs without exposing raw attribution', () => {
        const diagnostics = observeLongAnimationFrameDiagnostics()
        const ordinarySubscriber = jest.fn()
        const unsubscribeOrdinary = observePerformanceEntries('long-animation-frame', ordinarySubscriber)

        expect(observers).toHaveLength(1)
        observers[0]!.emit([
            loaf({
                startTime: 100,
                duration: 75,
                firstUIEventTimestamp: 70,
                scripts: [
                    {
                        forcedStyleAndLayoutDuration: 2,
                        sourceURL: 'https://private.test/account.js?token=secret',
                        functionName: 'privateCheckoutHandler',
                        invoker: '#private-button',
                    },
                    { forcedStyleAndLayoutDuration: 3, sourceURL: 'https://private.test/second.js' },
                ],
            }),
            loaf({
                startTime: 200,
                duration: 60,
                firstUIEventTimestamp: 0,
                scripts: [{ forcedStyleAndLayoutDuration: 0, sourceURL: 'https://private.test/zero.js' }],
            }),
            loaf({
                startTime: 300,
                duration: 50,
                firstUIEventTimestamp: 360,
                scripts: [{ sourceURL: 'https://private.test/missing-field.js' }],
            }),
        ])

        const snapshot = diagnostics.snapshot()
        expectAggregateInvariants(snapshot)
        expect(snapshot.loafFirstUiEventToFrameEnd).toEqual({
            capability: 'supported',
            count: 1,
            p95Ms: 105,
            accepted: 1,
            rejected: 1,
            retained: 1,
            dropped: 0,
            truncated: false,
            status: 'partial',
        })
        expect(snapshot.loafAttributedForcedStyleLayout).toEqual({
            capability: 'supported',
            count: 2,
            p95Ms: 5,
            accepted: 2,
            rejected: 1,
            retained: 2,
            dropped: 0,
            truncated: false,
            status: 'partial',
        })

        const ordinaryEntry = ordinarySubscriber.mock.calls[0]?.[0]
        expect(ordinaryEntry).not.toHaveProperty('firstUIEventTimestamp')
        expect(ordinaryEntry).not.toHaveProperty('scripts')
        expect(Object.getOwnPropertySymbols(ordinaryEntry)).toEqual([])
        const serialized = JSON.stringify({ snapshot, ordinaryEntry })
        expect(serialized).not.toContain('private.test')
        expect(serialized).not.toContain('privateCheckoutHandler')
        expect(serialized).not.toContain('private-button')
        expect(serialized).not.toContain('scripts')
        expect(serialized).not.toContain('sourceURL')
        expect(serialized).not.toContain('firstUIEventTimestamp')

        unsubscribeOrdinary()
        diagnostics.disconnect()
    })

    it('keeps unsupported, not-observed, and a measured zero distinct', () => {
        const diagnostics = observeLongAnimationFrameDiagnostics()

        const empty = diagnostics.snapshot()
        expect(empty.loafFirstUiEventToFrameEnd.capability).toBe('unknown')
        expect(empty.loafFirstUiEventToFrameEnd).toMatchObject({ count: null, p95Ms: null, status: 'not-observed' })

        observers[0]!.emit([loaf({})])
        const unsupported = diagnostics.snapshot()
        expect(unsupported.loafFirstUiEventToFrameEnd).toMatchObject({ count: null, p95Ms: null, status: 'unsupported' })
        expect(unsupported.loafAttributedForcedStyleLayout).toMatchObject({ count: null, p95Ms: null, status: 'unsupported' })

        observers[0]!.emit([
            loaf({
                startTime: 200,
                duration: 50,
                firstUIEventTimestamp: 0,
                scripts: [{ forcedStyleAndLayoutDuration: 0 }],
            }),
        ])
        const measuredZero = diagnostics.snapshot()
        expect(measuredZero.loafFirstUiEventToFrameEnd).toMatchObject({
            capability: 'supported',
            count: 0,
            p95Ms: null,
            accepted: 0,
            rejected: 0,
            status: 'not-observed',
        })
        expect(measuredZero.loafAttributedForcedStyleLayout).toMatchObject({
            capability: 'supported',
            count: 1,
            p95Ms: 0,
            accepted: 1,
            rejected: 0,
            status: 'measured',
        })

        diagnostics.disconnect()
    })

    it('keeps bounded counts measured and marks a bounded p95 partial after sample truncation', () => {
        const diagnostics = observeLongAnimationFrameDiagnostics({ maxSamples: 2 })
        observers[0]!.emit([
            loaf({ startTime: 100, duration: 50, firstUIEventTimestamp: 140, scripts: [{ forcedStyleAndLayoutDuration: 1 }] }),
            loaf({ startTime: 200, duration: 50, firstUIEventTimestamp: 230, scripts: [{ forcedStyleAndLayoutDuration: 2 }] }),
            loaf({ startTime: 300, duration: 50, firstUIEventTimestamp: 320, scripts: [{ forcedStyleAndLayoutDuration: 3 }] }),
        ])

        const snapshot = diagnostics.snapshot()
        expectAggregateInvariants(snapshot)
        expect(snapshot.loafFirstUiEventToFrameEnd).toMatchObject({
            count: 3,
            p95Ms: 20,
            accepted: 3,
            retained: 2,
            dropped: 1,
            truncated: true,
            status: 'partial',
        })
        expect(snapshot.loafAttributedForcedStyleLayout).toMatchObject({
            count: 3,
            p95Ms: 2,
            accepted: 3,
            retained: 2,
            dropped: 1,
            truncated: true,
            status: 'partial',
        })

        diagnostics.disconnect()
    })

    it('never emits a biased prefix sum when one LoAF exceeds the script bound', () => {
        const diagnostics = observeLongAnimationFrameDiagnostics()
        const scripts = Array.from({ length: 513 }, (_, index) => ({
            forcedStyleAndLayoutDuration: 1,
            sourceURL: `https://private.test/${index}.js`,
        }))
        observers[0]!.emit([loaf({ scripts })])

        const snapshot = diagnostics.snapshot()
        expectAggregateInvariants(snapshot)
        const aggregate = snapshot.loafAttributedForcedStyleLayout
        expect(aggregate).toMatchObject({
            capability: 'supported',
            count: 0,
            p95Ms: null,
            accepted: 0,
            rejected: 1,
            retained: 0,
            dropped: 0,
            truncated: false,
            status: 'partial',
        })
        expect(JSON.stringify(aggregate)).not.toContain('private.test')

        diagnostics.disconnect()
    })

    it('marks count saturation partial without misclassifying it as a dropped p95 sample', () => {
        const diagnostics = observeLongAnimationFrameDiagnostics({ maxSamples: 10, maxCount: 2 })
        observers[0]!.emit([
            loaf({ startTime: 100, duration: 50, firstUIEventTimestamp: 140, scripts: [{ forcedStyleAndLayoutDuration: 1 }] }),
            loaf({ startTime: 200, duration: 50, firstUIEventTimestamp: 230, scripts: [{ forcedStyleAndLayoutDuration: 2 }] }),
            loaf({ startTime: 300, duration: 50, firstUIEventTimestamp: 320, scripts: [{ forcedStyleAndLayoutDuration: 3 }] }),
        ])

        const snapshot = diagnostics.snapshot()
        expectAggregateInvariants(snapshot)
        for (const aggregate of [snapshot.loafFirstUiEventToFrameEnd, snapshot.loafAttributedForcedStyleLayout]) {
            expect(aggregate).toMatchObject({
                count: 2,
                accepted: 2,
                rejected: 1,
                retained: 2,
                dropped: 0,
                truncated: false,
                status: 'partial',
            })
        }

        diagnostics.disconnect()
    })

    it('keeps the safe projector active while disconnect drains queued LoAF records', () => {
        const diagnostics = observeLongAnimationFrameDiagnostics()
        observers[0]!.takeRecords.mockReturnValueOnce([
            loaf({ startTime: 100, duration: 50, firstUIEventTimestamp: 140, scripts: [{ forcedStyleAndLayoutDuration: 4 }] }),
        ])

        diagnostics.disconnect()

        expect(diagnostics.snapshot().loafFirstUiEventToFrameEnd).toMatchObject({ count: 1, p95Ms: 10, status: 'measured' })
        expect(diagnostics.snapshot().loafAttributedForcedStyleLayout).toMatchObject({ count: 1, p95Ms: 4, status: 'measured' })
    })

    it('reports observer unsupported and unknown states without manufacturing zero', () => {
        diagnosticsUnsupported()
        diagnosticsUnknown()
    })

    function diagnosticsUnsupported(): void {
        delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
        class UnsupportedPerformanceObserver extends FakePerformanceObserver {
            static supportedEntryTypes: string[] = []
        }
        Object.assign(globalThis, { PerformanceObserver: UnsupportedPerformanceObserver })
        const diagnostics = observeLongAnimationFrameDiagnostics()
        expect(diagnostics.state).toBe('unsupported')
        expect(diagnostics.snapshot().loafFirstUiEventToFrameEnd).toMatchObject({ count: null, p95Ms: null, status: 'unsupported' })
        diagnostics.disconnect()
    }

    function diagnosticsUnknown(): void {
        delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
        class UnknownPerformanceObserver {
            readonly disconnect = jest.fn()

            observe(): void {
                throw new Error('registration failed')
            }
        }
        Object.assign(globalThis, { PerformanceObserver: UnknownPerformanceObserver })
        const diagnostics = observeLongAnimationFrameDiagnostics()
        expect(diagnostics.state).toBe('unknown')
        expect(diagnostics.snapshot().loafFirstUiEventToFrameEnd).toMatchObject({ count: null, p95Ms: null, status: 'unknown' })
        diagnostics.disconnect()
    }

    it('rejects unbounded accumulator capacities', () => {
        expect(() => observeLongAnimationFrameDiagnostics({ maxSamples: 0 })).toThrow(TypeError)
        expect(() => observeLongAnimationFrameDiagnostics({ maxSamples: 20_001 })).toThrow(TypeError)
        expect(() => observeLongAnimationFrameDiagnostics({ maxSamples: 1.5 })).toThrow(TypeError)
        expect(() => observeLongAnimationFrameDiagnostics({ maxCount: 0 })).toThrow(TypeError)
        expect(() => observeLongAnimationFrameDiagnostics({ maxCount: 1_000_000_001 })).toThrow(TypeError)
        expect(() => observeLongAnimationFrameDiagnostics({ maxCount: 1.5 })).toThrow(TypeError)
    })
})
