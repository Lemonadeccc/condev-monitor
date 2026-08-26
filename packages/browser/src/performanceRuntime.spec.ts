import {
    drainPerformanceEntries,
    getPerformanceRuntimeCapabilities,
    observePerformanceEntries,
    subscribeFrame,
    subscribePageLifecycle,
    subscribeResourceTimingBufferFull,
    supportsPerformanceEntryType,
} from '@condev-monitor/monitor-sdk-browser-utils/performance-runtime'

type Listener = (event: Event) => void

class FakeEventTarget {
    private listeners = new Map<string, Set<Listener>>()

    addEventListener(type: string, listener: Listener): void {
        const listeners = this.listeners.get(type) ?? new Set<Listener>()
        listeners.add(listener)
        this.listeners.set(type, listeners)
    }

    removeEventListener(type: string, listener: Listener): void {
        this.listeners.get(type)?.delete(listener)
    }

    dispatch(type: string, event: Event = { type } as Event): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event)
    }

    listenerCount(type: string): number {
        return this.listeners.get(type)?.size ?? 0
    }
}

describe('shared performance runtime', () => {
    const originalWindow = globalThis.window
    const originalDocument = globalThis.document
    const originalPerformanceObserver = globalThis.PerformanceObserver
    let fakeWindow: FakeEventTarget & {
        requestAnimationFrame: jest.Mock<number, [FrameRequestCallback]>
        cancelAnimationFrame: jest.Mock<void, [number]>
    }
    let fakeDocument: FakeEventTarget & { visibilityState: DocumentVisibilityState }
    let rafCallbacks: Map<number, FrameRequestCallback>
    let nextRafId: number

    beforeEach(() => {
        rafCallbacks = new Map()
        nextRafId = 1
        fakeWindow = Object.assign(new FakeEventTarget(), {
            requestAnimationFrame: jest.fn((callback: FrameRequestCallback) => {
                const id = nextRafId++
                rafCallbacks.set(id, callback)
                return id
            }),
            cancelAnimationFrame: jest.fn((id: number) => {
                rafCallbacks.delete(id)
            }),
        })
        fakeDocument = Object.assign(new FakeEventTarget(), {
            visibilityState: 'visible' as DocumentVisibilityState,
        })
        Object.assign(globalThis, { window: fakeWindow, document: fakeDocument })
    })

    afterEach(() => {
        Object.assign(globalThis, {
            window: originalWindow,
            document: originalDocument,
            PerformanceObserver: originalPerformanceObserver,
        })
    })

    it('shares one requestAnimationFrame loop and releases it after the final subscriber', () => {
        const first = jest.fn()
        const second = jest.fn()
        const unsubscribeFirst = subscribeFrame(first)
        const unsubscribeSecond = subscribeFrame(second)

        expect(fakeWindow.requestAnimationFrame).toHaveBeenCalledTimes(1)
        expect(fakeDocument.listenerCount('visibilitychange')).toBe(1)

        const firstFrame = rafCallbacks.values().next().value as FrameRequestCallback
        firstFrame(100)
        expect(first).toHaveBeenCalledWith({ timestamp: 100, deltaMs: null })
        expect(second).toHaveBeenCalledWith({ timestamp: 100, deltaMs: null })

        unsubscribeFirst()
        expect(fakeWindow.cancelAnimationFrame).not.toHaveBeenCalled()

        unsubscribeSecond()
        expect(fakeWindow.cancelAnimationFrame).toHaveBeenCalledTimes(1)
        expect(fakeDocument.listenerCount('visibilitychange')).toBe(0)
    })

    it('reuses the global frame clock across module reloads without leaking lifecycle listeners', () => {
        const unsubscribeFirst = subscribeFrame(jest.fn())
        jest.resetModules()
        const reloadedRuntime =
            require('@condev-monitor/monitor-sdk-browser-utils/performance-runtime') as typeof import('@condev-monitor/monitor-sdk-browser-utils/performance-runtime')
        const unsubscribeReloaded = reloadedRuntime.subscribeFrame(jest.fn())

        expect(fakeWindow.requestAnimationFrame).toHaveBeenCalledTimes(1)
        expect(fakeDocument.listenerCount('visibilitychange')).toBe(1)

        unsubscribeFirst()
        unsubscribeReloaded()
        expect(fakeWindow.cancelAnimationFrame).toHaveBeenCalledTimes(1)
        expect(fakeDocument.listenerCount('visibilitychange')).toBe(0)
    })

    it('is SSR-safe and reports unavailable capabilities without creating resources', () => {
        const observerConstructor = jest.fn()
        class ServerPerformanceObserver {
            static supportedEntryTypes = ['event']

            constructor() {
                observerConstructor()
            }
        }
        Object.assign(globalThis, {
            window: undefined,
            document: undefined,
            PerformanceObserver: ServerPerformanceObserver,
        })

        expect(getPerformanceRuntimeCapabilities()).toEqual({
            frame: false,
            entryTypes: {
                longtask: false,
                'long-animation-frame': false,
                event: false,
                resource: false,
            },
        })
        expect(supportsPerformanceEntryType('longtask')).toBe(false)
        expect(() => subscribeFrame(jest.fn())()).not.toThrow()
        expect(() => subscribePageLifecycle(jest.fn())()).not.toThrow()
        const observerSubscription = observePerformanceEntries('event', jest.fn())
        expect(observerSubscription.state).toBe('unsupported')
        expect(observerSubscription.buffered).toBe(false)
        expect(() => observerSubscription()).not.toThrow()
        expect(observerConstructor).not.toHaveBeenCalled()
    })

    it('preserves unknown capability state while still attempting standards-compatible observation', () => {
        let observer: FakePerformanceObserver | undefined

        class FakePerformanceObserver {
            readonly disconnect = jest.fn()
            readonly observe = jest.fn()

            constructor(readonly callback: PerformanceObserverCallback) {
                observer = this
            }
        }

        Object.assign(globalThis, { PerformanceObserver: FakePerformanceObserver })
        expect(getPerformanceRuntimeCapabilities().entryTypes.event).toBeNull()
        expect(supportsPerformanceEntryType('event')).toBe(false)

        const callback = jest.fn()
        const unsubscribe = observePerformanceEntries('event', callback)
        expect(unsubscribe.state).toBe('supported')
        expect(unsubscribe.buffered).toBe(true)
        expect(observer?.observe).toHaveBeenCalled()
        unsubscribe()
        expect(observer?.disconnect).toHaveBeenCalledTimes(1)
    })

    it('shares one PerformanceObserver per entry type and disconnects it after the final subscriber', () => {
        const observers: FakePerformanceObserver[] = []

        class FakePerformanceObserver {
            static supportedEntryTypes = ['longtask']
            readonly observe = jest.fn()
            readonly disconnect = jest.fn()

            constructor(readonly callback: PerformanceObserverCallback) {
                observers.push(this)
            }

            emit(entries: PerformanceEntry[]): void {
                this.callback({ getEntries: () => entries } as PerformanceObserverEntryList, this as unknown as PerformanceObserver)
            }
        }

        Object.assign(globalThis, { PerformanceObserver: FakePerformanceObserver })
        const first = jest.fn()
        const second = jest.fn()
        const unsubscribeFirst = observePerformanceEntries('longtask', first)
        const unsubscribeSecond = observePerformanceEntries('longtask', second)

        expect(observers).toHaveLength(1)
        expect(unsubscribeFirst.state).toBe('supported')
        expect(unsubscribeSecond.state).toBe('supported')
        observers[0]!.emit([
            {
                entryType: 'longtask',
                name: 'self',
                startTime: 1,
                duration: 60,
                attribution: [
                    {
                        containerType: 'iframe',
                        containerName: 'private-frame-name',
                        containerId: 'private-frame-id',
                        containerSrc: 'https://private.test/frame',
                    },
                ],
                toJSON: () => ({}),
            } as PerformanceEntry,
        ])
        expect(first).toHaveBeenCalledTimes(1)
        expect(second).toHaveBeenCalledTimes(1)
        expect(first).toHaveBeenCalledWith({
            entryType: 'longtask',
            name: 'self',
            startTime: 1,
            duration: 60,
            attribution: [
                {
                    containerType: 'iframe',
                    containerName: 'private-frame-name',
                    containerId: 'private-frame-id',
                    containerSrc: 'https://private.test/frame',
                },
            ],
        })

        unsubscribeFirst()
        expect(observers[0]!.disconnect).not.toHaveBeenCalled()
        unsubscribeSecond()
        expect(observers[0]!.disconnect).toHaveBeenCalledTimes(1)
    })

    it('keeps Resource Timing useful without retaining resource names or URLs', () => {
        let observer: FakePerformanceObserver | undefined

        class FakePerformanceObserver {
            static supportedEntryTypes = ['resource']
            readonly observe = jest.fn()
            readonly disconnect = jest.fn()

            constructor(readonly callback: PerformanceObserverCallback) {
                observer = this
            }

            emit(entries: PerformanceEntry[]): void {
                this.callback({ getEntries: () => entries } as PerformanceObserverEntryList, this as unknown as PerformanceObserver)
            }
        }

        Object.assign(globalThis, { PerformanceObserver: FakePerformanceObserver })
        const callback = jest.fn()
        const unsubscribe = observePerformanceEntries('resource', callback)
        observer?.emit([
            {
                entryType: 'resource',
                name: 'https://private.example/account/avatar.png?token=secret',
                startTime: 25,
                duration: 40,
                responseEnd: 65,
                initiatorType: 'img',
                transferSize: 0,
                encodedBodySize: 4_000,
                decodedBodySize: 12_000,
                toJSON: () => ({}),
            } as PerformanceResourceTiming,
        ])

        expect(callback).toHaveBeenCalledWith({
            entryType: 'resource',
            startTime: 25,
            duration: 40,
            responseEnd: 65,
            initiatorType: 'img',
            transferSize: 0,
            encodedBodySize: 4_000,
            decodedBodySize: 12_000,
        })
        expect(JSON.stringify(callback.mock.calls)).not.toContain('private.example')
        unsubscribe()
    })

    it('shares Resource Timing buffer-full evidence and isolates subscribers', () => {
        const originalPerformance = globalThis.performance
        const fakePerformance = new FakeEventTarget()
        Object.assign(globalThis, { performance: fakePerformance })

        try {
            const first = jest.fn(() => {
                throw new Error('isolated subscriber')
            })
            const second = jest.fn()
            const unsubscribeFirst = subscribeResourceTimingBufferFull(first)
            const unsubscribeSecond = subscribeResourceTimingBufferFull(second)

            expect(unsubscribeFirst.state).toBe('supported')
            expect(fakePerformance.listenerCount('resourcetimingbufferfull')).toBe(1)
            fakePerformance.dispatch('resourcetimingbufferfull')
            expect(first).toHaveBeenCalledTimes(1)
            expect(second).toHaveBeenCalledTimes(1)

            unsubscribeFirst()
            expect(fakePerformance.listenerCount('resourcetimingbufferfull')).toBe(1)
            unsubscribeSecond()
            expect(fakePerformance.listenerCount('resourcetimingbufferfull')).toBe(0)
        } finally {
            Object.assign(globalThis, { performance: originalPerformance })
        }
    })

    it('drains queued observer records before hidden and pagehide lifecycle subscribers run', () => {
        const order: string[] = []
        let observer: FakePerformanceObserver | undefined

        class FakePerformanceObserver {
            static supportedEntryTypes = ['longtask']
            readonly disconnect = jest.fn()
            readonly observe = jest.fn()
            private records: PerformanceEntry[] = []

            constructor(readonly callback: PerformanceObserverCallback) {
                observer = this
            }

            queue(entry: PerformanceEntry): void {
                this.records.push(entry)
            }

            takeRecords(): PerformanceEntryList {
                order.push('takeRecords')
                return this.records.splice(0) as PerformanceEntryList
            }
        }

        Object.assign(globalThis, { PerformanceObserver: FakePerformanceObserver })
        const failingSubscriber = jest.fn(() => {
            throw new Error('subscriber failure')
        })
        const unsubscribeFailing = observePerformanceEntries('longtask', failingSubscriber)
        const unsubscribeEntries = observePerformanceEntries('longtask', entry => {
            order.push(`entry:${entry.startTime}`)
            expect(entry.attribution).toEqual([
                {
                    containerType: 'iframe',
                    containerName: null,
                    containerId: null,
                    containerSrc: 'https://private.test/frame',
                },
            ])
        })
        const unsubscribeLifecycle = subscribePageLifecycle(event => {
            order.push(`lifecycle:${event.type}`)
        })
        const queuedEntry = (startTime: number) =>
            ({
                entryType: 'longtask',
                name: 'self',
                startTime,
                duration: 60,
                attribution: [{ containerType: 'iframe', containerSrc: 'https://private.test/frame' }],
                toJSON: () => ({}),
            }) as PerformanceEntry

        observer!.queue(queuedEntry(1))
        fakeDocument.visibilityState = 'hidden'
        fakeDocument.dispatch('visibilitychange')
        expect(order).toEqual(['takeRecords', 'entry:1', 'lifecycle:hidden'])

        order.length = 0
        observer!.queue(queuedEntry(2))
        fakeWindow.dispatch('pagehide', { type: 'pagehide', persisted: false } as PageTransitionEvent)
        expect(order).toEqual(['takeRecords', 'entry:2', 'lifecycle:pagehide'])

        order.length = 0
        observer!.queue(queuedEntry(3))
        const unsubscribeCurrent = subscribePageLifecycle(event => order.push(`current:${event.type}`), { emitCurrent: true })
        expect(order).toEqual(['takeRecords', 'entry:3', 'current:hidden'])
        expect(failingSubscriber).toHaveBeenCalledTimes(3)

        unsubscribeCurrent()
        unsubscribeLifecycle()
        unsubscribeEntries()
        unsubscribeFailing()
    })

    it('drains pending records before the final unsubscribe disconnects the observer', () => {
        const order: string[] = []
        let observer: FakePerformanceObserver | undefined

        class FakePerformanceObserver {
            static supportedEntryTypes = ['event']
            readonly observe = jest.fn()
            private records: PerformanceEntry[] = []

            constructor(readonly callback: PerformanceObserverCallback) {
                observer = this
            }

            readonly disconnect = jest.fn(() => {
                order.push('disconnect')
            })

            queue(entry: PerformanceEntry): void {
                this.records.push(entry)
            }

            takeRecords(): PerformanceEntryList {
                order.push('takeRecords')
                return this.records.splice(0) as PerformanceEntryList
            }
        }

        Object.assign(globalThis, { PerformanceObserver: FakePerformanceObserver })
        const onEntry = jest.fn(() => {
            order.push('entry')
        })
        const unsubscribe = observePerformanceEntries('event', onEntry)
        observer!.queue({
            entryType: 'event',
            name: 'click',
            startTime: 10,
            duration: 48,
            processingStart: 12,
            processingEnd: 30,
            interactionId: 7,
            target: '#private-selector',
            toJSON: () => ({}),
        } as PerformanceEntry)

        unsubscribe()

        expect(order).toEqual(['takeRecords', 'entry', 'disconnect'])
        expect(onEntry).toHaveBeenCalledWith({
            entryType: 'event',
            name: 'click',
            startTime: 10,
            duration: 48,
            processingStart: 12,
            processingEnd: 30,
            interactionId: 7,
        })
    })

    it('exposes an explicit type-scoped drain without affecting other observer queues', () => {
        const observers = new Map<string, FakePerformanceObserver>()

        class FakePerformanceObserver {
            static supportedEntryTypes = ['longtask', 'event']
            readonly disconnect = jest.fn()
            private entryType = ''
            private records: PerformanceEntry[] = []

            constructor(readonly callback: PerformanceObserverCallback) {}

            observe(options: PerformanceObserverInit): void {
                this.entryType = String(options.type ?? options.entryTypes?.[0] ?? '')
                observers.set(this.entryType, this)
            }

            queue(entry: PerformanceEntry): void {
                this.records.push(entry)
            }

            takeRecords(): PerformanceEntryList {
                return this.records.splice(0) as PerformanceEntryList
            }
        }

        Object.assign(globalThis, { PerformanceObserver: FakePerformanceObserver })
        const onLongTask = jest.fn()
        const onEvent = jest.fn()
        const unsubscribeLongTask = observePerformanceEntries('longtask', onLongTask)
        const unsubscribeEvent = observePerformanceEntries('event', onEvent)
        observers.get('longtask')!.queue({
            entryType: 'longtask',
            name: 'self',
            startTime: 1,
            duration: 60,
            toJSON: () => ({}),
        } as PerformanceEntry)
        observers.get('event')!.queue({
            entryType: 'event',
            name: 'click',
            startTime: 10,
            duration: 48,
            toJSON: () => ({}),
        } as PerformanceEntry)

        drainPerformanceEntries('longtask')
        expect(onLongTask).toHaveBeenCalledTimes(1)
        expect(onEvent).not.toHaveBeenCalled()

        drainPerformanceEntries()
        expect(onEvent).toHaveBeenCalledTimes(1)
        unsubscribeLongTask()
        unsubscribeEvent()
    })

    it('isolates takeRecords and disconnect failures from lifecycle delivery and registry cleanup', () => {
        let constructorCount = 0

        class FailingPerformanceObserver {
            static supportedEntryTypes = ['longtask']
            readonly observe = jest.fn()

            constructor(_callback: PerformanceObserverCallback) {
                constructorCount += 1
            }

            takeRecords(): PerformanceEntryList {
                throw new Error('takeRecords failure')
            }

            disconnect(): void {
                throw new Error('disconnect failure')
            }
        }

        Object.assign(globalThis, { PerformanceObserver: FailingPerformanceObserver })
        const unsubscribeEntries = observePerformanceEntries('longtask', jest.fn())
        const onLifecycle = jest.fn()
        const unsubscribeLifecycle = subscribePageLifecycle(onLifecycle)

        fakeDocument.visibilityState = 'hidden'
        expect(() => fakeDocument.dispatch('visibilitychange')).not.toThrow()
        expect(onLifecycle).toHaveBeenCalledWith({ type: 'hidden' })
        expect(() => unsubscribeEntries()).not.toThrow()

        const unsubscribeReplacement = observePerformanceEntries('longtask', jest.fn())
        expect(constructorCount).toBe(2)
        expect(() => unsubscribeReplacement()).not.toThrow()
        unsubscribeLifecycle()
    })

    it('exposes only aggregation-safe Event Timing and LoAF fields and isolates subscriber errors', () => {
        const observers = new Map<string, FakePerformanceObserver>()

        class FakePerformanceObserver {
            static supportedEntryTypes = ['event', 'long-animation-frame']
            readonly disconnect = jest.fn()
            private entryType = ''

            constructor(readonly callback: PerformanceObserverCallback) {}

            observe(options: PerformanceObserverInit): void {
                this.entryType = String(options.type ?? options.entryTypes?.[0] ?? '')
                observers.set(this.entryType, this)
            }

            emit(entries: PerformanceEntry[]): void {
                this.callback({ getEntries: () => entries } as PerformanceObserverEntryList, this as unknown as PerformanceObserver)
            }
        }

        Object.assign(globalThis, { PerformanceObserver: FakePerformanceObserver })
        const onEvent = jest.fn()
        const unsubscribeEvent = observePerformanceEntries('event', onEvent)
        observers.get('event')!.emit([
            {
                entryType: 'event',
                name: 'click',
                startTime: 10,
                duration: 48,
                processingStart: 12,
                processingEnd: 30,
                interactionId: 7,
                target: '#private-selector',
                toJSON: () => ({}),
            } as PerformanceEntry,
        ])
        expect(onEvent).toHaveBeenCalledWith({
            entryType: 'event',
            name: 'click',
            startTime: 10,
            duration: 48,
            processingStart: 12,
            processingEnd: 30,
            interactionId: 7,
        })

        const failingSubscriber = jest.fn(() => {
            throw new Error('subscriber failure')
        })
        const safeSubscriber = jest.fn()
        const deferredThrow = jest.spyOn(globalThis, 'setTimeout')
        const unsubscribeFailing = observePerformanceEntries('long-animation-frame', failingSubscriber)
        const unsubscribeSafe = observePerformanceEntries('long-animation-frame', safeSubscriber)
        expect(() =>
            observers.get('long-animation-frame')!.emit([
                {
                    entryType: 'long-animation-frame',
                    name: 'frame',
                    startTime: 100,
                    duration: 75,
                    blockingDuration: 30,
                    renderStart: 140,
                    styleAndLayoutStart: 150,
                    paintTime: 170,
                    presentationTime: null,
                    scripts: [{ sourceURL: 'https://private.test/app.js' }],
                    toJSON: () => ({}),
                } as PerformanceEntry,
            ])
        ).not.toThrow()
        expect(safeSubscriber).toHaveBeenCalledWith({
            entryType: 'long-animation-frame',
            name: 'frame',
            startTime: 100,
            duration: 75,
            blockingDuration: 30,
            renderStart: 140,
            styleAndLayoutStart: 150,
            paintTime: 170,
            presentationTime: null,
        })
        expect(deferredThrow).not.toHaveBeenCalled()
        deferredThrow.mockRestore()

        unsubscribeEvent()
        unsubscribeFailing()
        unsubscribeSafe()
    })

    it('shares page lifecycle listeners and reports visibility and page transitions', () => {
        const first = jest.fn()
        const second = jest.fn()
        const unsubscribeFirst = subscribePageLifecycle(first)
        const unsubscribeSecond = subscribePageLifecycle(second)

        expect(fakeDocument.listenerCount('visibilitychange')).toBe(1)
        expect(fakeWindow.listenerCount('pagehide')).toBe(1)
        expect(fakeWindow.listenerCount('pageshow')).toBe(1)

        fakeDocument.visibilityState = 'hidden'
        fakeDocument.dispatch('visibilitychange')
        fakeWindow.dispatch('pagehide', { type: 'pagehide', persisted: true } as PageTransitionEvent)

        expect(first).toHaveBeenNthCalledWith(1, { type: 'hidden' })
        expect(first).toHaveBeenNthCalledWith(2, { type: 'pagehide', persisted: true })
        expect(second).toHaveBeenCalledTimes(2)

        unsubscribeFirst()
        unsubscribeSecond()
        expect(fakeDocument.listenerCount('visibilitychange')).toBe(0)
        expect(fakeWindow.listenerCount('pagehide')).toBe(0)
        expect(fakeWindow.listenerCount('pageshow')).toBe(0)
    })
})
