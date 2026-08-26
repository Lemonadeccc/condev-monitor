import { subscribePageLifecycle } from '@condev-monitor/monitor-sdk-browser-utils/performance-runtime'

import type { TransportGateway } from '../gateway'
import { MemoryQueue } from '../queue/memoryQueue'
import type { ReportEnvelope, SendResult } from '../types'
import { FlushScheduler } from './flushScheduler'

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
}

describe('FlushScheduler page lifecycle ordering', () => {
    const originalWindow = globalThis.window
    const originalDocument = globalThis.document
    const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

    afterEach(() => {
        jest.useRealTimers()
        Object.assign(globalThis, { window: originalWindow, document: originalDocument })
        if (originalNavigatorDescriptor) Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor)
        else delete (globalThis as { navigator?: Navigator }).navigator
    })

    it('lets collectors finalize before draining the transport queue on hidden', async () => {
        jest.useFakeTimers()
        const fakeWindow = new FakeEventTarget()
        const fakeDocument = Object.assign(new FakeEventTarget(), {
            visibilityState: 'visible' as DocumentVisibilityState,
        })
        Object.assign(globalThis, { window: fakeWindow, document: fakeDocument })
        Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })

        const order: string[] = []
        const queue = {
            batchSize: () => 1,
            drain: () => {
                order.push('transport.flush')
                return []
            },
        } as unknown as MemoryQueue
        const gateway = { send: jest.fn() } as unknown as TransportGateway
        const scheduler = new FlushScheduler(queue, gateway, jest.fn(), 10, 60_000)
        const unsubscribeCollector = subscribePageLifecycle(() => {
            order.push('collector.finalize')
        })

        fakeDocument.visibilityState = 'hidden'
        fakeDocument.dispatch('visibilitychange')

        expect(order).toEqual(['collector.finalize'])
        await Promise.resolve()
        await Promise.resolve()
        expect(order).toEqual(['collector.finalize', 'transport.flush'])

        unsubscribeCollector()
        scheduler.destroy()
    })

    it('waits for an in-flight flush and then drains events finalized behind it', async () => {
        jest.useFakeTimers()
        const fakeWindow = new FakeEventTarget()
        const fakeDocument = Object.assign(new FakeEventTarget(), {
            visibilityState: 'visible' as DocumentVisibilityState,
        })
        Object.assign(globalThis, { window: fakeWindow, document: fakeDocument })
        Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })

        const envelope = {} as ReportEnvelope
        const queue = {
            batchSize: () => 1,
            drain: jest.fn(() => [envelope]),
        } as unknown as MemoryQueue
        let resolveFirst: ((result: SendResult) => void) | undefined
        const firstSend = new Promise<SendResult>(resolve => {
            resolveFirst = resolve
        })
        const gateway = {
            send: jest
                .fn()
                .mockImplementationOnce(() => firstSend)
                .mockResolvedValue({ ok: true }),
        } as unknown as TransportGateway
        const scheduler = new FlushScheduler(queue, gateway, jest.fn(), 10, 60_000)

        const firstFlush = scheduler.flush('timer')
        await Promise.resolve()
        const closingFlush = scheduler.flush('pagehide')
        expect((gateway as unknown as { send: jest.Mock }).send).toHaveBeenCalledTimes(1)

        resolveFirst?.({ ok: true })
        await Promise.all([firstFlush, closingFlush])

        expect((gateway as unknown as { send: jest.Mock }).send).toHaveBeenCalledTimes(2)
        expect((gateway as unknown as { send: jest.Mock }).send.mock.calls[1]?.[1]).toBe('pagehide')
        scheduler.destroy()
    })

    it('serializes an in-flight flush, two waiters, and a newly enqueued batch behind one mutex', async () => {
        jest.useFakeTimers()
        Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })

        const queue = new MemoryQueue()
        const firstEnvelope = { priority: 'batch' } as ReportEnvelope
        const secondEnvelope = { priority: 'batch' } as ReportEnvelope
        queue.enqueue(firstEnvelope)

        let resolveFirst: ((result: SendResult) => void) | undefined
        let resolveSecond: ((result: SendResult) => void) | undefined
        const firstSend = new Promise<SendResult>(resolve => {
            resolveFirst = resolve
        })
        const secondSend = new Promise<SendResult>(resolve => {
            resolveSecond = resolve
        })
        const gateway = {
            send: jest.fn().mockReturnValueOnce(firstSend).mockReturnValueOnce(secondSend),
        } as unknown as TransportGateway
        const scheduler = new FlushScheduler(queue, gateway, jest.fn(), 10, 60_000)

        const inFlight = scheduler.flush('timer')
        await Promise.resolve()
        expect((gateway as unknown as { send: jest.Mock }).send).toHaveBeenCalledTimes(1)

        queue.enqueue(secondEnvelope)
        let secondWaiterSettled = false
        let destroyWaiterSettled = false
        const secondWaiter = scheduler.flush('pagehide').then(() => {
            secondWaiterSettled = true
        })
        const destroyWaiter = scheduler.flush('manual').then(() => {
            scheduler.destroy()
            destroyWaiterSettled = true
        })

        resolveFirst?.({ ok: true })
        await inFlight
        for (let i = 0; i < 4; i++) await Promise.resolve()

        expect((gateway as unknown as { send: jest.Mock }).send).toHaveBeenCalledTimes(2)
        expect((gateway as unknown as { send: jest.Mock }).send.mock.calls[1]).toEqual([[secondEnvelope], 'pagehide'])
        expect(secondWaiterSettled).toBe(false)
        expect(destroyWaiterSettled).toBe(false)

        resolveSecond?.({ ok: true })
        await Promise.all([secondWaiter, destroyWaiter])
        expect(secondWaiterSettled).toBe(true)
        expect(destroyWaiterSettled).toBe(true)
    })

    it('drains an offline closing batch into persistence and keeps flush pending until persistence completes', async () => {
        jest.useFakeTimers()
        const fakeWindow = new FakeEventTarget()
        const fakeDocument = Object.assign(new FakeEventTarget(), {
            visibilityState: 'hidden' as DocumentVisibilityState,
        })
        Object.assign(globalThis, { window: fakeWindow, document: fakeDocument })
        Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })

        const envelope = {} as ReportEnvelope
        const queue = {
            batchSize: () => 1,
            drain: jest.fn(() => [envelope]),
        } as unknown as MemoryQueue
        const gateway = { send: jest.fn() } as unknown as TransportGateway
        let resolvePersistence: ((persisted: boolean) => void) | undefined
        const persistence = new Promise<boolean>(resolve => {
            resolvePersistence = resolve
        })
        const onSendFailure = jest.fn(() => persistence)
        const scheduler = new FlushScheduler(queue, gateway, onSendFailure, 10, 60_000)

        let settled = false
        const flush = scheduler.flush('pagehide').then(() => {
            settled = true
        })
        await Promise.resolve()

        expect(queue.drain).toHaveBeenCalledWith('pagehide')
        expect(onSendFailure).toHaveBeenCalledWith([envelope])
        expect((gateway as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled()
        expect(settled).toBe(false)

        resolvePersistence?.(true)
        await flush
        expect(settled).toBe(true)
        scheduler.destroy()
    })

    it('persists an offline animation report finalized before the hidden lifecycle flush', async () => {
        jest.useFakeTimers()
        const fakeWindow = new FakeEventTarget()
        const fakeDocument = Object.assign(new FakeEventTarget(), {
            visibilityState: 'visible' as DocumentVisibilityState,
        })
        Object.assign(globalThis, { window: fakeWindow, document: fakeDocument })
        Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })

        const envelope = {} as ReportEnvelope
        const pending: ReportEnvelope[] = []
        const order: string[] = []
        const queue = {
            batchSize: () => pending.length,
            drain: jest.fn(() => pending.splice(0)),
        } as unknown as MemoryQueue
        const gateway = { send: jest.fn() } as unknown as TransportGateway
        const onSendFailure = jest.fn(async (batch: ReportEnvelope[]) => {
            order.push('persist')
            expect(batch).toEqual([envelope])
            return true
        })
        const scheduler = new FlushScheduler(queue, gateway, onSendFailure, 10, 60_000)
        const unsubscribeCollector = subscribePageLifecycle(() => {
            order.push('collector.finalize')
            pending.push(envelope)
        })

        fakeDocument.visibilityState = 'hidden'
        fakeDocument.dispatch('visibilitychange')
        expect(order).toEqual(['collector.finalize'])
        await Promise.resolve()
        await Promise.resolve()

        expect(order).toEqual(['collector.finalize', 'persist'])
        expect((gateway as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled()
        unsubscribeCollector()
        scheduler.destroy()
    })

    it('restores the drained batch in memory when offline persistence is unavailable', async () => {
        jest.useFakeTimers()
        const fakeWindow = new FakeEventTarget()
        const fakeDocument = Object.assign(new FakeEventTarget(), {
            visibilityState: 'hidden' as DocumentVisibilityState,
        })
        Object.assign(globalThis, { window: fakeWindow, document: fakeDocument })
        Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })

        const queue = new MemoryQueue()
        const envelope = { priority: 'batch' } as ReportEnvelope
        queue.enqueue(envelope)
        const gateway = { send: jest.fn() } as unknown as TransportGateway
        const scheduler = new FlushScheduler(
            queue,
            gateway,
            jest.fn(async () => false),
            10,
            60_000
        )

        await expect(scheduler.flush('pagehide')).rejects.toThrow('not sent or persisted')

        expect(queue.size()).toBe(1)
        expect((gateway as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled()
        scheduler.destroy()
    })

    it('contains a scheduled flush rejection instead of emitting an unhandled rejection', async () => {
        Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })
        const queue = new MemoryQueue()
        const envelope = { priority: 'immediate' } as ReportEnvelope
        queue.enqueue(envelope)
        const gateway = { send: jest.fn() } as unknown as TransportGateway
        const debug = jest.spyOn(console, 'debug').mockImplementation(() => undefined)
        const unhandled: unknown[] = []
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason)
        }
        process.on('unhandledRejection', onUnhandled)
        const scheduler = new FlushScheduler(
            queue,
            gateway,
            jest.fn(async () => false),
            10,
            60_000,
            true
        )

        try {
            scheduler.onEnqueue(envelope)
            await new Promise<void>(resolve => setImmediate(resolve))

            expect(unhandled).toEqual([])
            expect(queue.size()).toBe(1)
            expect(debug).toHaveBeenCalledWith('[Transport] Scheduled flush deferred for retry', expect.any(Error))
        } finally {
            scheduler.destroy()
            process.off('unhandledRejection', onUnhandled)
            debug.mockRestore()
        }
    })
})
