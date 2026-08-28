import { createAnimationRumV3GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { openDB } from 'idb'

import { prepareAnimationRumV3QueuedReport } from './report'
import { createAnimationRumV3DeliveryScope } from './scope'
import { AnimationRumV3StoreCapacityError, IndexedDbAnimationRumV3DeliveryStore } from './store'
import type { AnimationRumV3QueuedReport } from './types'

jest.mock('idb', () => ({ openDB: jest.fn() }))

function clone(report: AnimationRumV3QueuedReport): AnimationRumV3QueuedReport {
    return { ...report }
}

class AtomicFakeDatabase {
    private records = new Map<string, AnimationRumV3QueuedReport>()
    private transactionTail: Promise<void> = Promise.resolve()
    readonly close = jest.fn()

    transaction() {
        let release!: () => void
        const previous = this.transactionTail
        this.transactionTail = new Promise<void>(resolve => {
            release = resolve
        })
        let working = new Map<string, AnimationRumV3QueuedReport>()
        let aborted = false
        let completed: Promise<void> | null = null
        const ready = previous.then(() => {
            working = new Map([...this.records].map(([key, report]) => [key, clone(report)]))
        })
        const transaction = {
            store: {
                getAll: async () => {
                    await ready
                    return [...working.values()].map(clone)
                },
                get: async (key: string) => {
                    await ready
                    const report = working.get(key)
                    return report ? clone(report) : undefined
                },
                put: async (report: AnimationRumV3QueuedReport) => {
                    await ready
                    working.set(report.key, clone(report))
                    return report.key
                },
                delete: async (key: string) => {
                    await ready
                    working.delete(key)
                },
            },
            abort: () => {
                aborted = true
            },
        }
        Object.defineProperty(transaction, 'done', {
            get: () => {
                completed ??= ready
                    .then(() => {
                        if (aborted) throw new Error('AbortError')
                        this.records = working
                    })
                    .finally(release)
                return completed
            },
        })
        return transaction
    }
}

function queued(scope: ReturnType<typeof createAnimationRumV3DeliveryScope>, suffix: string, now = 100) {
    const report = createAnimationRumV3GoldenReport()
    report.eventId = `event_${suffix}`
    report.captureId = `capture_${suffix}`
    report.capturedAt = '1970-01-01T00:00:00.000Z'
    return prepareAnimationRumV3QueuedReport(scope, report, now)
}

describe('IndexedDbAnimationRumV3DeliveryStore', () => {
    beforeEach(() => {
        ;(openDB as jest.Mock).mockReset().mockResolvedValue(new AtomicFakeDatabase())
    })

    it('uses its own database and atomically leases page reports without parent ordering', async () => {
        const store = new IndexedDbAnimationRumV3DeliveryStore()
        const scope = createAnimationRumV3DeliveryScope('appOne123', 'https://collector.test/tracking-v3/appOne123')
        const reports = [queued(scope, 'first001'), queued(scope, 'second01')]
        await store.persist(scope, reports, { maxItems: 10, maxAgeMs: 10_000 }, 100)

        const [first, second] = await Promise.all([
            store.leaseReady(scope, 'tab-one', 100, 2, 500, 65_536),
            store.leaseReady(scope, 'tab-two', 100, 2, 500, 65_536),
        ])

        expect(openDB).toHaveBeenCalledWith('condev-monitor-animation-rum-v3-soft-navigation', 1, expect.any(Object))
        expect(first.length + second.length).toBe(2)
        expect([...first, ...second].every(report => !('parentConfirmed' in report) && !('reportScope' in report))).toBe(true)
    })

    it('isolates endpoint scopes and preserves serialized bytes across retry and settlement', async () => {
        const store = new IndexedDbAnimationRumV3DeliveryStore()
        const scope = createAnimationRumV3DeliveryScope('appOne123', 'https://collector-a.test/tracking-v3/appOne123')
        const otherScope = createAnimationRumV3DeliveryScope('appOne123', 'https://collector-b.test/tracking-v3/appOne123')
        const report = queued(scope, 'retry001')
        const other = queued(otherScope, 'retry001')
        await store.persist(scope, [report], { maxItems: 10, maxAgeMs: 10_000 }, 100)
        await store.persist(otherScope, [other], { maxItems: 10, maxAgeMs: 10_000 }, 100)

        const [leased] = await store.leaseReady(scope, 'tab-one', 100, 1, 500, 65_536)
        await expect(store.reschedule(scope, 'tab-one', [{ key: leased!.key, attemptCount: 1, nextAttemptAt: 200 }], 100)).resolves.toEqual(
            [report.key]
        )
        const [retried] = await store.leaseReady(scope, 'tab-one', 200, 1, 500, 65_536)
        expect(retried).toEqual(
            expect.objectContaining({ payloadJson: report.payloadJson, payloadBytes: report.payloadBytes, attemptCount: 1 })
        )
        await expect(
            store.settle(scope, 'tab-one', [{ key: retried!.key, state: 'confirmed', terminalReason: null }], 200)
        ).resolves.toEqual([report.key])
        await expect(store.leaseReady(otherScope, 'tab-other', 100, 1, 500, 65_536)).resolves.toEqual([
            expect.objectContaining({ scopeKey: otherScope.scopeKey }),
        ])
    })

    it('closes without deleting durable work and reopens lazily after BFCache suspension', async () => {
        const database = new AtomicFakeDatabase()
        ;(openDB as jest.Mock).mockResolvedValue(database)
        const store = new IndexedDbAnimationRumV3DeliveryStore()
        const scope = createAnimationRumV3DeliveryScope('appOne123', 'https://collector.test/tracking-v3/appOne123')
        const report = queued(scope, 'reopen01')
        await store.persist(scope, [report], { maxItems: 10, maxAgeMs: 10_000 }, 100)

        await store.close()

        expect(database.close).toHaveBeenCalledTimes(1)
        await expect(store.persist(scope, [report], { maxItems: 10, maxAgeMs: 10_000 }, 110)).resolves.toEqual({
            reports: [expect.objectContaining({ eventId: report.eventId, duplicate: true })],
        })
        expect(openDB).toHaveBeenCalledTimes(2)
    })

    it('rejects event and capture identity conflicts instead of treating them as duplicates', async () => {
        const store = new IndexedDbAnimationRumV3DeliveryStore()
        const scope = createAnimationRumV3DeliveryScope('appOne123', 'https://collector.test/tracking-v3/appOne123')
        const original = queued(scope, 'conflict1')
        await store.persist(scope, [original], { maxItems: 10, maxAgeMs: 1_000 }, 100)

        const sameEvent = queued(scope, 'conflict2', 110)
        sameEvent.eventId = original.eventId
        sameEvent.key = original.key
        await expect(store.persist(scope, [sameEvent], { maxItems: 10, maxAgeMs: 1_000 }, 110)).rejects.toThrow('event id conflicts')

        const sameCapture = queued(scope, 'conflict3', 110)
        sameCapture.captureId = original.captureId
        await expect(store.persist(scope, [sameCapture], { maxItems: 10, maxAgeMs: 1_000 }, 110)).rejects.toThrow('capture id conflicts')
    })

    it('prunes expired work, preserves active leases, and fails closed at pending capacity', async () => {
        const store = new IndexedDbAnimationRumV3DeliveryStore()
        const scope = createAnimationRumV3DeliveryScope('appOne123', 'https://collector.test/tracking-v3/appOne123')
        const active = queued(scope, 'active01', 0)
        const expired = queued(scope, 'expired1', 10)
        await store.persist(scope, [active, expired], { maxItems: 2, maxAgeMs: 1_000 }, 10)
        await store.leaseReady(scope, 'active-tab', 100, 1, 500, 65_536)

        await expect(store.prune(scope, { maxItems: 1, maxAgeMs: 50 }, 100)).resolves.toEqual({ expired: 1, excess: 0 })
        const refreshed = queued(scope, 'expired1', 110)
        await store.persist(scope, [active, refreshed], { maxItems: 2, maxAgeMs: 1_000 }, 110)
        await store.releaseLeases(scope, 'active-tab', 111)

        const overflow = queued(scope, 'overflow', 112)
        await expect(store.persist(scope, [overflow], { maxItems: 1, maxAgeMs: 1_000 }, 112)).rejects.toBeInstanceOf(
            AnimationRumV3StoreCapacityError
        )
    })

    it('retains settled tombstones for idempotency and evicts one to admit new work at quota', async () => {
        const store = new IndexedDbAnimationRumV3DeliveryStore()
        const scope = createAnimationRumV3DeliveryScope('appOne123', 'https://collector.test/tracking-v3/appOne123')
        const first = queued(scope, 'settled1')
        await store.persist(scope, [first], { maxItems: 1, maxAgeMs: 1_000 }, 100)
        await store.leaseReady(scope, 'tab-one', 100, 1, 500, 65_536)
        await store.settle(scope, 'tab-one', [{ key: first.key, state: 'confirmed', terminalReason: null }], 110)

        await expect(store.persist(scope, [first], { maxItems: 1, maxAgeMs: 1_000 }, 115)).resolves.toEqual({
            reports: [expect.objectContaining({ eventId: first.eventId, duplicate: true, state: 'confirmed' })],
        })
        const replacement = queued(scope, 'replace1', 120)
        await expect(store.persist(scope, [replacement], { maxItems: 1, maxAgeMs: 1_000 }, 120)).resolves.toEqual({
            reports: [expect.objectContaining({ eventId: replacement.eventId, duplicate: false, state: 'pending' })],
        })
    })
})
