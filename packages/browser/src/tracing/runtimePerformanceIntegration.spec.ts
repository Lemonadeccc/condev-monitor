import { RuntimePerformance } from './runtimePerformanceIntegration'

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

    listenerCount(type: string): number {
        return this.listeners.get(type)?.size ?? 0
    }

    dispatchEvent(event: Event): boolean {
        for (const listener of this.listeners.get(event.type) ?? []) listener(event)
        return true
    }
}

describe('RuntimePerformance lifecycle', () => {
    const originalWindow = globalThis.window
    const originalDocument = globalThis.document
    const originalPerformanceObserver = globalThis.PerformanceObserver

    afterEach(() => {
        Object.assign(globalThis, {
            window: originalWindow,
            document: originalDocument,
            PerformanceObserver: originalPerformanceObserver,
        })
    })

    it('disconnects its shared observer, frame subscription, timers, and lifecycle subscription exactly once', () => {
        const fakeWindow = Object.assign(new FakeEventTarget(), {
            location: { pathname: '/animation' },
            setInterval: jest.fn(() => 1),
            clearInterval: jest.fn(),
            requestAnimationFrame: jest.fn(() => 11),
            cancelAnimationFrame: jest.fn(),
        })
        const fakeDocument = Object.assign(new FakeEventTarget(), {
            visibilityState: 'visible' as DocumentVisibilityState,
        })
        const observers: FakePerformanceObserver[] = []

        class FakePerformanceObserver {
            static supportedEntryTypes = ['longtask']
            readonly observe = jest.fn()
            readonly disconnect = jest.fn()
            private records: PerformanceEntry[] = []

            constructor(readonly callback: PerformanceObserverCallback) {
                observers.push(this)
            }

            queue(entry: PerformanceEntry): void {
                this.records.push(entry)
            }

            takeRecords(): PerformanceEntryList {
                return this.records.splice(0) as PerformanceEntryList
            }
        }

        Object.assign(globalThis, {
            window: fakeWindow,
            document: fakeDocument,
            PerformanceObserver: FakePerformanceObserver,
        })

        const transport = { send: jest.fn() }
        const runtime = new RuntimePerformance(transport, {
            longTask: true,
            jank: true,
            fps: true,
        })
        runtime.init()

        expect(observers).toHaveLength(1)
        expect(fakeWindow.setInterval).toHaveBeenCalledTimes(2)
        expect(fakeWindow.requestAnimationFrame).toHaveBeenCalledTimes(1)
        expect(fakeDocument.listenerCount('visibilitychange')).toBe(1)

        observers[0]!.queue({
            entryType: 'longtask',
            name: 'self',
            startTime: 1,
            duration: 60,
            toJSON: () => ({}),
        } as PerformanceEntry)
        runtime.flush()
        expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'performance', type: 'longTask', startTime: 1 }))

        runtime.destroy()
        runtime.destroy()

        expect(observers[0]!.disconnect).toHaveBeenCalledTimes(1)
        expect(fakeWindow.clearInterval).toHaveBeenCalledTimes(2)
        expect(fakeWindow.cancelAnimationFrame).toHaveBeenCalledTimes(1)
        expect(fakeDocument.listenerCount('visibilitychange')).toBe(0)
    })

    it('keeps the legacy metric contract by discarding a partial jank window when the page becomes hidden', () => {
        const fakeWindow = Object.assign(new FakeEventTarget(), {
            location: { pathname: '/legacy-performance' },
            setInterval: jest.fn(() => 1),
            clearInterval: jest.fn(),
            requestAnimationFrame: jest.fn(() => 11),
            cancelAnimationFrame: jest.fn(),
        })
        const fakeDocument = Object.assign(new FakeEventTarget(), {
            visibilityState: 'visible' as DocumentVisibilityState,
        })
        Object.assign(globalThis, { window: fakeWindow, document: fakeDocument })

        const transport = { send: jest.fn() }
        const runtime = new RuntimePerformance(transport, { longTask: false, jank: true, fps: false })
        runtime.init()
        Object.assign(runtime as unknown as Record<string, unknown>, {
            jankCount: 1,
            jankLagSum: 80,
            jankLagMax: 80,
        })

        runtime.flush()
        expect(transport.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'jank' }))

        fakeDocument.visibilityState = 'hidden'
        fakeDocument.dispatchEvent(new Event('visibilitychange'))

        expect(transport.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'jank' }))
        runtime.destroy()
    })
})
