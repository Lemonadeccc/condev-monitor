import type { TransportGateway } from '../gateway'
import type { RetryRecord, RetryScope, ScopedRetryStore, TransportConfig } from '../types'
import { DEFAULT_TRANSPORT_CONFIG } from '../types'
import { RetryWorker } from './retryWorker'

function retryRecord(appId: string, target: string): RetryRecord {
    return {
        id: `record-${appId}`,
        appId,
        target,
        createdAt: 1,
        nextRetryAt: 1,
        retryCount: 0,
        leaseUntil: 0,
        payload: [{ appId } as RetryRecord['payload'][number]],
    }
}

describe('RetryWorker target isolation', () => {
    const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const originalDocument = globalThis.document

    beforeEach(() => {
        Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
        Object.assign(globalThis, { document: { visibilityState: 'visible' } })
    })

    afterEach(() => {
        jest.useRealTimers()
        if (originalNavigatorDescriptor) Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor)
        else delete (globalThis as { navigator?: Navigator }).navigator
        Object.assign(globalThis, { document: originalDocument })
        jest.restoreAllMocks()
    })

    it('never sends a same-origin app A record through app B fixed gateway', async () => {
        const appATarget = 'https://same-origin.test/dsn-api/tracking/app-a'
        const appBTarget = 'https://same-origin.test/dsn-api/tracking/app-b'
        const appARecord = retryRecord('app-a', appATarget)
        const appBRecord = retryRecord('app-b', appBTarget)
        const scope: RetryScope = { appId: 'app-b', target: appBTarget }
        const store: ScopedRetryStore<RetryRecord> = {
            put: jest.fn(async () => undefined),
            // Deliberately simulate a stale/custom store returning both apps;
            // the worker delivery guard must still fail closed for app A.
            getReadyAndLease: jest.fn(async () => [appARecord, appBRecord]),
            delete: jest.fn(async () => undefined),
            count: jest.fn(async () => 2),
            prune: jest.fn(async () => undefined),
        }
        const gateway = {
            send: jest.fn(async () => ({ ok: false, retryable: true }) as const),
        } as unknown as TransportGateway
        const cfg: Required<TransportConfig> = { ...DEFAULT_TRANSPORT_CONFIG }
        const worker = new RetryWorker(store, gateway, cfg, scope)

        await worker.tryOnce()

        expect(store.prune).toHaveBeenCalledWith(scope, cfg.storeMaxItems, cfg.storeMaxAgeMs)
        expect(store.getReadyAndLease).toHaveBeenCalledWith(scope, 10, 30_000)
        expect((gateway as unknown as { send: jest.Mock }).send).toHaveBeenCalledTimes(1)
        expect((gateway as unknown as { send: jest.Mock }).send).toHaveBeenCalledWith(appBRecord.payload, 'manual')
        expect(store.put).toHaveBeenCalledWith(expect.objectContaining({ id: appBRecord.id, appId: 'app-b', target: appBTarget }))
        expect(store.delete).not.toHaveBeenCalledWith([appARecord.id])
    })

    it('contains interval retry failures while leaving explicit tryOnce observable', async () => {
        jest.useFakeTimers()
        const scope: RetryScope = {
            appId: 'app-b',
            target: 'https://same-origin.test/dsn-api/tracking/app-b',
        }
        const failure = new Error('IndexedDB unavailable')
        const store: ScopedRetryStore<RetryRecord> = {
            put: jest.fn(async () => undefined),
            getReadyAndLease: jest.fn(async () => []),
            delete: jest.fn(async () => undefined),
            count: jest.fn(async () => 0),
            prune: jest.fn(async () => {
                throw failure
            }),
        }
        const gateway = { send: jest.fn() } as unknown as TransportGateway
        const cfg: Required<TransportConfig> = { ...DEFAULT_TRANSPORT_CONFIG, debug: true }
        const debug = jest.spyOn(console, 'debug').mockImplementation(() => undefined)
        const unhandled: unknown[] = []
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason)
        }
        process.on('unhandledRejection', onUnhandled)
        const worker = new RetryWorker(store, gateway, cfg, scope)

        try {
            worker.start()
            jest.advanceTimersByTime(60_000)
            for (let i = 0; i < 4; i++) await Promise.resolve()

            expect(unhandled).toEqual([])
            expect(debug).toHaveBeenCalledWith('[Transport] interval offline retry deferred', failure)
            await expect(worker.tryOnce()).rejects.toBe(failure)
        } finally {
            worker.stop()
            process.off('unhandledRejection', onUnhandled)
            debug.mockRestore()
        }
    })
})
