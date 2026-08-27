import { createAnimationRumV2GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { openDB } from 'idb'

import { prepareAnimationRumV2QueuedReport } from './report'
import { createAnimationRumV2DeliveryScope } from './scope'
import { AnimationRumV2StoreCapacityError, IndexedDbAnimationRumV2DeliveryStore } from './store'
import type { AnimationRumV2QueuedReport } from './types'

jest.mock('idb', () => ({ openDB: jest.fn() }))

function clone(report: AnimationRumV2QueuedReport): AnimationRumV2QueuedReport {
    return { ...report }
}

class AtomicFakeDatabase {
    private records = new Map<string, AnimationRumV2QueuedReport>()
    private transactionTail: Promise<void> = Promise.resolve()
    readonly close = jest.fn()

    transaction() {
        let release!: () => void
        const previous = this.transactionTail
        this.transactionTail = new Promise<void>(resolve => {
            release = resolve
        })
        let working = new Map<string, AnimationRumV2QueuedReport>()
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
                put: async (report: AnimationRumV2QueuedReport) => {
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
                if (!completed) {
                    completed = ready
                        .then(() => {
                            if (aborted) throw new Error('AbortError')
                            this.records = working
                        })
                        .finally(release)
                }
                return completed
            },
        })
        return transaction
    }
}

function pageReport(suffix: string) {
    const report = createAnimationRumV2GoldenReport()
    report.eventId = `event_${suffix}`
    report.captureId = `capture_${suffix}`
    report.capturedAt = '1970-01-01T00:00:00.000Z'
    return report
}

function targetReport(parentCaptureId: string, suffix: string) {
    const report = pageReport(suffix)
    report.scope = 'target'
    report.parentCaptureId = parentCaptureId
    report.targetKey = `target-${suffix}`
    report.metrics[0]!.relation = 'target-temporal-overlap'
    return report
}

describe('IndexedDbAnimationRumV2DeliveryStore', () => {
    beforeEach(() => {
        ;(openDB as jest.Mock).mockReset().mockResolvedValue(new AtomicFakeDatabase())
    })

    it('atomically leases a report to only one tab and isolates app plus canonical endpoint scopes', async () => {
        const store = new IndexedDbAnimationRumV2DeliveryStore()
        const scope = createAnimationRumV2DeliveryScope('appOne123', 'https://collector-a.test/tracking/appOne123')
        const otherScope = createAnimationRumV2DeliveryScope('appOne123', 'https://collector-b.test/tracking/appOne123')
        const report = prepareAnimationRumV2QueuedReport(scope, pageReport('atomic01'), 100)
        const otherReport = prepareAnimationRumV2QueuedReport(otherScope, pageReport('atomic01'), 100)
        await store.persist(scope, [report], { maxItems: 10, maxAgeMs: 1_000 }, 100)
        await store.persist(otherScope, [otherReport], { maxItems: 10, maxAgeMs: 1_000 }, 100)

        const [first, second] = await Promise.all([
            store.leaseReady(scope, 'tab-one', 100, 10, 500, 65_536),
            store.leaseReady(scope, 'tab-two', 100, 10, 500, 65_536),
        ])

        expect(first.length + second.length).toBe(1)
        expect((first[0] ?? second[0])?.eventId).toBe(report.eventId)
        await expect(store.leaseReady(otherScope, 'tab-other', 100, 10, 500, 65_536)).resolves.toEqual([
            expect.objectContaining({ eventId: otherReport.eventId, scopeKey: otherScope.scopeKey }),
        ])
    })

    it('closes the current connection without deleting reports and lazily reopens on the next operation', async () => {
        const database = new AtomicFakeDatabase()
        ;(openDB as jest.Mock).mockResolvedValue(database)
        const store = new IndexedDbAnimationRumV2DeliveryStore()
        const scope = createAnimationRumV2DeliveryScope('appOne123', 'https://collector.test/tracking/appOne123')
        const report = prepareAnimationRumV2QueuedReport(scope, pageReport('reopen01'), 100)
        await store.persist(scope, [report], { maxItems: 10, maxAgeMs: 1_000 }, 100)

        await store.close()

        expect(database.close).toHaveBeenCalledTimes(1)
        await expect(store.persist(scope, [report], { maxItems: 10, maxAgeMs: 1_000 }, 110)).resolves.toEqual({
            reports: [expect.objectContaining({ eventId: report.eventId, duplicate: true })],
        })
        expect(openDB).toHaveBeenCalledTimes(2)
    })

    it('does not let a detached open failure clear a newer reopened connection', async () => {
        const firstOpenFailure = new Error('old IndexedDB open failed')
        let rejectFirstOpen!: (error: Error) => void
        const firstOpen = new Promise<AtomicFakeDatabase>((_resolve, reject) => {
            rejectFirstOpen = reject
        })
        const reopenedDatabase = new AtomicFakeDatabase()
        ;(openDB as jest.Mock).mockReturnValueOnce(firstOpen).mockResolvedValue(reopenedDatabase)
        const store = new IndexedDbAnimationRumV2DeliveryStore()
        const scope = createAnimationRumV2DeliveryScope('appOne123', 'https://collector.test/tracking/appOne123')

        const oldPersistence = store.persist(
            scope,
            [prepareAnimationRumV2QueuedReport(scope, pageReport('old_open'), 100)],
            { maxItems: 10, maxAgeMs: 1_000 },
            100
        )
        const closing = store.close()
        const reopenedReport = prepareAnimationRumV2QueuedReport(scope, pageReport('new_open'), 110)
        const reopenedPersistence = store.persist(scope, [reopenedReport], { maxItems: 10, maxAgeMs: 1_000 }, 110)
        const oldPersistenceRejection = expect(oldPersistence).rejects.toBe(firstOpenFailure)
        const closingRejection = expect(closing).rejects.toBe(firstOpenFailure)

        rejectFirstOpen(firstOpenFailure)

        await oldPersistenceRejection
        await closingRejection
        await expect(reopenedPersistence).resolves.toEqual({
            reports: [expect.objectContaining({ eventId: reopenedReport.eventId, duplicate: false })],
        })
        const laterReport = prepareAnimationRumV2QueuedReport(scope, pageReport('later001'), 120)
        await store.persist(scope, [laterReport], { maxItems: 10, maxAgeMs: 1_000 }, 120)
        expect(openDB).toHaveBeenCalledTimes(2)
    })

    it('leases the page first, unlocks its target only after confirmation, and propagates terminal parent state', async () => {
        const store = new IndexedDbAnimationRumV2DeliveryStore()
        const scope = createAnimationRumV2DeliveryScope('appOne123', 'https://collector.test/tracking/appOne123')
        const page = prepareAnimationRumV2QueuedReport(scope, pageReport('parent01'), 100)
        const target = prepareAnimationRumV2QueuedReport(scope, targetReport(page.captureId, 'child001'), 100)
        await store.persist(scope, [target, page], { maxItems: 10, maxAgeMs: 1_000 }, 100)

        const pageLease = await store.leaseReady(scope, 'tab-one', 100, 10, 500, 65_536)
        expect(pageLease.map(report => report.eventId)).toEqual([page.eventId])
        await store.settle(scope, 'tab-one', [{ key: page.key, state: 'confirmed', terminalReason: null }], 110)
        await expect(store.leaseReady(scope, 'tab-two', 110, 10, 500, 65_536)).resolves.toEqual([
            expect.objectContaining({ eventId: target.eventId, parentConfirmed: true }),
        ])

        const terminalPage = prepareAnimationRumV2QueuedReport(scope, pageReport('parent02'), 120)
        const terminalTarget = prepareAnimationRumV2QueuedReport(scope, targetReport(terminalPage.captureId, 'child002'), 120)
        await store.persist(scope, [terminalPage, terminalTarget], { maxItems: 10, maxAgeMs: 1_000 }, 120)
        const terminalLease = await store.leaseReady(scope, 'tab-three', 120, 1, 500, 65_536)
        expect(terminalLease[0]?.eventId).toBe(terminalPage.eventId)
        await store.settle(scope, 'tab-three', [{ key: terminalPage.key, state: 'terminal', terminalReason: 'http-403' }], 130)

        const duplicate = await store.persist(scope, [terminalTarget], { maxItems: 10, maxAgeMs: 1_000 }, 130)
        expect(duplicate.reports[0]).toEqual(expect.objectContaining({ duplicate: true, state: 'terminal' }))
        const lateTarget = prepareAnimationRumV2QueuedReport(scope, targetReport(terminalPage.captureId, 'child003'), 130)
        await expect(store.persist(scope, [lateTarget], { maxItems: 10, maxAgeMs: 1_000 }, 130)).resolves.toEqual({
            reports: [expect.objectContaining({ eventId: lateTarget.eventId, state: 'terminal' })],
        })
        const laterLease = await store.leaseReady(scope, 'tab-four', 130, 10, 500, 65_536)
        expect(laterLease.some(report => report.eventId === terminalTarget.eventId)).toBe(false)
        expect(laterLease.some(report => report.eventId === lateTarget.eventId)).toBe(false)
    })

    it('never propagates a same-named parent across app or endpoint scopes', async () => {
        const store = new IndexedDbAnimationRumV2DeliveryStore()
        const firstScope = createAnimationRumV2DeliveryScope('appOne123', 'https://collector-a.test/tracking/appOne123')
        const secondScope = createAnimationRumV2DeliveryScope('appTwo123', 'https://collector-b.test/tracking/appTwo123')
        const firstPage = prepareAnimationRumV2QueuedReport(firstScope, pageReport('shared01'), 100)
        const secondPage = prepareAnimationRumV2QueuedReport(secondScope, pageReport('shared01'), 100)
        const secondTarget = prepareAnimationRumV2QueuedReport(secondScope, targetReport(secondPage.captureId, 'scoped01'), 100)
        await store.persist(firstScope, [firstPage], { maxItems: 10, maxAgeMs: 1_000 }, 100)
        await store.persist(secondScope, [secondPage, secondTarget], { maxItems: 10, maxAgeMs: 1_000 }, 100)
        await store.leaseReady(firstScope, 'first-tab', 100, 1, 500, 65_536)
        await store.settle(firstScope, 'first-tab', [{ key: firstPage.key, state: 'confirmed', terminalReason: null }], 110)

        const secondLease = await store.leaseReady(secondScope, 'second-tab', 110, 10, 500, 65_536)

        expect(secondLease.map(report => report.eventId)).toEqual([secondPage.eventId])
        expect(secondTarget.parentConfirmed).toBe(false)
    })

    it('never treats a conflicting event or capture identity as an idempotent duplicate', async () => {
        const store = new IndexedDbAnimationRumV2DeliveryStore()
        const scope = createAnimationRumV2DeliveryScope('appOne123', 'https://collector.test/tracking/appOne123')
        const original = prepareAnimationRumV2QueuedReport(scope, pageReport('conflict1'), 100)
        await store.persist(scope, [original], { maxItems: 10, maxAgeMs: 1_000 }, 100)

        const sameEventDifferentCapture = prepareAnimationRumV2QueuedReport(
            scope,
            { ...pageReport('conflict2'), eventId: original.eventId },
            110
        )
        await expect(store.persist(scope, [sameEventDifferentCapture], { maxItems: 10, maxAgeMs: 1_000 }, 110)).rejects.toThrow(
            'event id conflicts'
        )

        const sameCaptureDifferentEvent = prepareAnimationRumV2QueuedReport(
            scope,
            { ...pageReport('conflict3'), captureId: original.captureId },
            110
        )
        await expect(store.persist(scope, [sameCaptureDifferentEvent], { maxItems: 10, maxAgeMs: 1_000 }, 110)).rejects.toThrow(
            'capture id conflicts'
        )
    })

    it('reports an exact repeated item in one persistence batch as a duplicate after its first occurrence', async () => {
        const store = new IndexedDbAnimationRumV2DeliveryStore()
        const scope = createAnimationRumV2DeliveryScope('appOne123', 'https://collector.test/tracking/appOne123')
        const report = prepareAnimationRumV2QueuedReport(scope, pageReport('duplicate'), 100)

        await expect(store.persist(scope, [report, report], { maxItems: 10, maxAgeMs: 1_000 }, 100)).resolves.toEqual({
            reports: [
                expect.objectContaining({ eventId: report.eventId, duplicate: false }),
                expect.objectContaining({ eventId: report.eventId, duplicate: true }),
            ],
        })
        await expect(store.leaseReady(scope, 'tab-one', 100, 10, 500, 65_536)).resolves.toHaveLength(1)
    })

    it('prunes by age and quota without evicting an active lease and fails closed at live capacity', async () => {
        const store = new IndexedDbAnimationRumV2DeliveryStore()
        const scope = createAnimationRumV2DeliveryScope('appOne123', 'https://collector.test/tracking/appOne123')
        const active = prepareAnimationRumV2QueuedReport(scope, pageReport('active01'), 0)
        const expired = prepareAnimationRumV2QueuedReport(scope, pageReport('expired1'), 10)
        await store.persist(scope, [active, expired], { maxItems: 2, maxAgeMs: 1_000 }, 10)
        await store.leaseReady(scope, 'active-tab', 100, 1, 500, 65_536)

        await expect(store.prune(scope, { maxItems: 1, maxAgeMs: 50 }, 100)).resolves.toEqual({ expired: 1, excess: 0 })
        const refreshedExpired = prepareAnimationRumV2QueuedReport(scope, pageReport('expired1'), 110)
        const persisted = await store.persist(scope, [active, refreshedExpired], { maxItems: 2, maxAgeMs: 1_000 }, 110)
        expect(persisted.reports).toEqual([
            expect.objectContaining({ eventId: active.eventId, duplicate: true }),
            expect.objectContaining({ eventId: expired.eventId, duplicate: false }),
        ])

        await expect(store.prune(scope, { maxItems: 1, maxAgeMs: 1_000 }, 110)).resolves.toEqual({ expired: 0, excess: 0 })
        await store.releaseLeases(scope, 'active-tab', 111)
        await expect(store.leaseReady(scope, 'next-tab', 111, 10, 500, 65_536)).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ eventId: active.eventId }),
                expect.objectContaining({ eventId: expired.eventId }),
            ])
        )

        const overflow = prepareAnimationRumV2QueuedReport(scope, pageReport('overflow'), 112)
        await expect(store.persist(scope, [overflow], { maxItems: 1, maxAgeMs: 1_000 }, 112)).rejects.toBeInstanceOf(
            AnimationRumV2StoreCapacityError
        )
    })

    it('uses settled records as bounded tombstones before admitting new work', async () => {
        const store = new IndexedDbAnimationRumV2DeliveryStore()
        const scope = createAnimationRumV2DeliveryScope('appOne123', 'https://collector.test/tracking/appOne123')
        const first = prepareAnimationRumV2QueuedReport(scope, pageReport('settled1'), 100)
        await store.persist(scope, [first], { maxItems: 1, maxAgeMs: 1_000 }, 100)
        await store.leaseReady(scope, 'tab-one', 100, 1, 500, 65_536)
        await store.settle(scope, 'tab-one', [{ key: first.key, state: 'confirmed', terminalReason: null }], 110)

        const replacement = prepareAnimationRumV2QueuedReport(scope, pageReport('replace1'), 120)
        await expect(store.persist(scope, [replacement], { maxItems: 1, maxAgeMs: 1_000 }, 120)).resolves.toEqual({
            reports: [expect.objectContaining({ eventId: replacement.eventId, duplicate: false, state: 'pending' })],
        })
    })

    it('evicts the oldest settlement tombstone instead of a recently confirmed older capture', async () => {
        const store = new IndexedDbAnimationRumV2DeliveryStore()
        const scope = createAnimationRumV2DeliveryScope('appOne123', 'https://collector.test/tracking/appOne123')
        const olderCapture = prepareAnimationRumV2QueuedReport(scope, pageReport('created1'), 100)
        const newerCapture = prepareAnimationRumV2QueuedReport(scope, pageReport('created2'), 200)
        await store.persist(scope, [olderCapture, newerCapture], { maxItems: 2, maxAgeMs: 10_000 }, 200)
        await store.leaseReady(scope, 'tab-one', 200, 2, 1_000, 65_536)
        await store.settle(scope, 'tab-one', [{ key: newerCapture.key, state: 'confirmed', terminalReason: null }], 300)
        await store.settle(scope, 'tab-one', [{ key: olderCapture.key, state: 'confirmed', terminalReason: null }], 400)

        const replacement = prepareAnimationRumV2QueuedReport(scope, pageReport('created3'), 500)
        await store.persist(scope, [replacement], { maxItems: 2, maxAgeMs: 10_000 }, 500)
        const tombstones = await store.persist(scope, [olderCapture, newerCapture], { maxItems: 3, maxAgeMs: 10_000 }, 500)

        expect(tombstones.reports).toEqual([
            expect.objectContaining({ eventId: olderCapture.eventId, duplicate: true }),
            expect.objectContaining({ eventId: newerCapture.eventId, duplicate: false }),
        ])
    })

    it('leases a byte-bounded keepalive batch without modifying stored payloads', async () => {
        const store = new IndexedDbAnimationRumV2DeliveryStore()
        const scope = createAnimationRumV2DeliveryScope('appOne123', 'https://collector.test/tracking/appOne123')
        const enlarge = (report: AnimationRumV2QueuedReport, character: string) => {
            const payloadJson = JSON.stringify({ event_type: 'animation_rum', padding: character.repeat(39_000) })
            return { ...report, payloadJson, payloadBytes: new TextEncoder().encode(payloadJson).byteLength }
        }
        const first = enlarge(prepareAnimationRumV2QueuedReport(scope, pageReport('bytes001'), 100), 'a')
        const second = enlarge(prepareAnimationRumV2QueuedReport(scope, pageReport('bytes002'), 100), 'b')
        await store.persist(scope, [first, second], { maxItems: 10, maxAgeMs: 1_000 }, 100)

        const leased = await store.leaseReady(scope, 'tab-one', 100, 10, 500, 65_536)

        expect(leased).toHaveLength(1)
        expect(leased[0]).toEqual(expect.objectContaining({ eventId: first.eventId, payloadJson: first.payloadJson }))
        expect(leased[0]!.payloadBytes).toBe(new TextEncoder().encode(leased[0]!.payloadJson).byteLength)
    })
})
