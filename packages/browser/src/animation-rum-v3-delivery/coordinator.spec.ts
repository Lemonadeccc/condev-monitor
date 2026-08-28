import { createAnimationRumV3GoldenReport } from '@condev-monitor/animation-rum-contract/testing'

import { AnimationRumV3DeliveryCoordinator } from './coordinator'
import type {
    AnimationRumV3DeliveryScope,
    AnimationRumV3DeliveryStore,
    AnimationRumV3PersistResult,
    AnimationRumV3QueuedReport,
    AnimationRumV3RetryUpdate,
    AnimationRumV3SendResult,
    AnimationRumV3Settlement,
} from './types'

function report(suffix: string) {
    const value = createAnimationRumV3GoldenReport()
    value.eventId = `event_${suffix}`
    value.captureId = `capture_${suffix}`
    value.capturedAt = '1970-01-01T00:00:00.000Z'
    return value
}

class MemoryStore implements AnimationRumV3DeliveryStore {
    readonly records = new Map<string, AnimationRumV3QueuedReport>()
    readonly calls: string[] = []
    readonly close = jest.fn(async () => undefined)

    async persist(
        _scope: AnimationRumV3DeliveryScope,
        reports: readonly AnimationRumV3QueuedReport[]
    ): Promise<AnimationRumV3PersistResult> {
        this.calls.push('persist')
        return {
            reports: reports.map(input => {
                const existing = this.records.get(input.key)
                if (!existing) this.records.set(input.key, { ...input })
                return {
                    key: input.key,
                    eventId: input.eventId,
                    captureId: input.captureId,
                    state: existing?.state ?? input.state,
                    duplicate: existing !== undefined,
                }
            }),
        }
    }

    async prune() {
        this.calls.push('prune')
        return { expired: 0, excess: 0 }
    }

    async leaseReady(
        scope: AnimationRumV3DeliveryScope,
        ownerId: string,
        now: number,
        limit: number,
        leaseDurationMs: number,
        maxBatchBytes: number
    ) {
        this.calls.push(`lease:${ownerId}`)
        const selected: AnimationRumV3QueuedReport[] = []
        let bytes = 0
        for (const item of [...this.records.values()].sort((left, right) => left.createdAt - right.createdAt)) {
            if (item.scopeKey !== scope.scopeKey || item.state !== 'pending' || item.nextAttemptAt > now || item.leaseUntil > now) continue
            const batchBytes = selected.length === 0 ? item.payloadBytes : 2 + bytes + item.payloadBytes + selected.length
            if (batchBytes > maxBatchBytes) continue
            selected.push(item)
            bytes += item.payloadBytes
            if (selected.length >= limit) break
        }
        return selected.map(item => {
            const leased = { ...item, leaseOwner: ownerId, leaseUntil: now + leaseDurationMs, updatedAt: now }
            this.records.set(item.key, leased)
            return { ...leased }
        })
    }

    async renewLeases(scope: AnimationRumV3DeliveryScope, ownerId: string, keys: readonly string[], now: number, leaseDurationMs: number) {
        const reports = keys.map(key => this.records.get(key))
        if (reports.some(item => !item || item.scopeKey !== scope.scopeKey || item.leaseOwner !== ownerId)) return []
        for (const item of reports as AnimationRumV3QueuedReport[]) {
            this.records.set(item.key, { ...item, leaseUntil: now + leaseDurationMs, updatedAt: now })
        }
        return [...keys]
    }

    async settle(scope: AnimationRumV3DeliveryScope, ownerId: string, settlements: readonly AnimationRumV3Settlement[], now: number) {
        const applied: string[] = []
        for (const settlement of settlements) {
            const item = this.records.get(settlement.key)
            if (!item || item.scopeKey !== scope.scopeKey || item.leaseOwner !== ownerId) continue
            this.records.set(item.key, {
                ...item,
                state: settlement.state,
                terminalReason: settlement.terminalReason,
                attemptCount: item.attemptCount + 1,
                leaseOwner: null,
                leaseUntil: 0,
                settledAt: now,
                updatedAt: now,
            })
            applied.push(item.key)
        }
        return applied
    }

    async reschedule(scope: AnimationRumV3DeliveryScope, ownerId: string, updates: readonly AnimationRumV3RetryUpdate[], now: number) {
        const applied: string[] = []
        for (const update of updates) {
            const item = this.records.get(update.key)
            if (!item || item.scopeKey !== scope.scopeKey || item.leaseOwner !== ownerId) continue
            this.records.set(item.key, {
                ...item,
                attemptCount: update.attemptCount,
                nextAttemptAt: update.nextAttemptAt,
                leaseOwner: null,
                leaseUntil: 0,
                updatedAt: now,
            })
            applied.push(item.key)
        }
        return applied
    }

    async releaseLeases(scope: AnimationRumV3DeliveryScope, ownerId: string, now: number) {
        this.calls.push(`release:${ownerId}`)
        for (const item of this.records.values()) {
            if (item.scopeKey === scope.scopeKey && item.leaseOwner === ownerId) {
                this.records.set(item.key, { ...item, leaseOwner: null, leaseUntil: 0, updatedAt: now })
            }
        }
    }
}

function settled(reports: readonly AnimationRumV3QueuedReport[]): AnimationRumV3SendResult {
    return {
        kind: 'settled',
        settlements: reports.map(item => ({ key: item.key, state: 'confirmed', terminalReason: null })),
        receipts: reports.map(item => ({
            eventId: item.eventId,
            captureId: item.captureId,
            receivedAt: '2026-08-29T08:00:00.000Z',
            deliveryState: 'pending',
            duplicate: false,
        })),
    }
}

function options(
    store: MemoryStore,
    send: (reports: readonly AnimationRumV3QueuedReport[]) => Promise<AnimationRumV3SendResult>,
    now: () => number
) {
    return {
        appId: 'appOne123',
        trackingUrl: 'https://collector.test/dsn-api/tracking-v3/appOne123',
        store,
        sender: { send: async (_scope: AnimationRumV3DeliveryScope, reports: readonly AnimationRumV3QueuedReport[]) => send(reports) },
        clock: { now },
        ownerId: 'test-owner',
        config: { retryBaseDelayMs: 100, retryMaxDelayMs: 10_000, retryMaxAttempts: 3, pollIntervalMs: 1_000 },
    }
}

describe('AnimationRumV3DeliveryCoordinator', () => {
    it('persists before sending and batches independent page reports', async () => {
        const store = new MemoryStore()
        const send = jest.fn(async (reports: readonly AnimationRumV3QueuedReport[]) => settled(reports))
        const coordinator = new AnimationRumV3DeliveryCoordinator(options(store, send, () => 100))

        await expect(coordinator.flush([report('first001'), report('second01')])).resolves.toEqual({
            attempted: 2,
            confirmed: 2,
            terminal: 0,
            retried: 0,
        })
        expect(store.calls.slice(0, 3)).toEqual(['persist', 'prune', 'lease:test-owner'])
        expect(send).toHaveBeenCalledWith([
            expect.objectContaining({ eventId: 'event_first001' }),
            expect.objectContaining({ eventId: 'event_second01' }),
        ])
    })

    it('retries the exact durable payload with bounded exponential delay', async () => {
        const store = new MemoryStore()
        let now = 100
        const attempts: AnimationRumV3QueuedReport[][] = []
        const send = jest.fn(async (reports: readonly AnimationRumV3QueuedReport[]) => {
            attempts.push(reports.map(item => ({ ...item })))
            return attempts.length === 1 ? ({ kind: 'retry', retryAfterMs: 50 } as const) : settled(reports)
        })
        const coordinator = new AnimationRumV3DeliveryCoordinator(options(store, send, () => now))

        await expect(coordinator.flush([report('retry001')])).resolves.toEqual({ attempted: 1, confirmed: 0, terminal: 0, retried: 1 })
        expect([...store.records.values()][0]).toEqual(expect.objectContaining({ nextAttemptAt: 200, attemptCount: 1 }))
        now = 200
        await expect(coordinator.flush()).resolves.toEqual({ attempted: 1, confirmed: 1, terminal: 0, retried: 0 })
        expect(attempts[1]![0]).toEqual(
            expect.objectContaining({
                eventId: attempts[0]![0]!.eventId,
                captureId: attempts[0]![0]!.captureId,
                payloadJson: attempts[0]![0]!.payloadJson,
            })
        )
    })

    it('suspends for BFCache, releases leases, closes storage, then resumes polling', async () => {
        const store = new MemoryStore()
        const send = jest.fn(async (reports: readonly AnimationRumV3QueuedReport[]) => settled(reports))
        const setInterval = jest.fn(() => 'timer')
        const clearInterval = jest.fn()
        const coordinator = new AnimationRumV3DeliveryCoordinator({
            ...options(store, send, () => 100),
            timers: { setInterval, clearInterval },
        })
        coordinator.start()
        await Promise.resolve()

        await coordinator.suspend()

        expect(clearInterval).toHaveBeenCalledWith('timer')
        expect(store.calls).toContain('release:test-owner')
        expect(store.close).toHaveBeenCalledTimes(1)
        await expect(coordinator.flush([report('blocked1')])).rejects.toThrow('suspended')

        await coordinator.resume()
        expect(setInterval).toHaveBeenCalledTimes(2)
        await coordinator.stop()
    })

    it('rejects v2 and privacy-bearing data before durable storage or network', async () => {
        const store = new MemoryStore()
        const persist = jest.spyOn(store, 'persist')
        const send = jest.fn(async (reports: readonly AnimationRumV3QueuedReport[]) => settled(reports))
        const coordinator = new AnimationRumV3DeliveryCoordinator(options(store, send, () => 100))
        const invalid = { ...report('privacy1'), contractVersion: 2, selector: '#account-email' }

        await expect(coordinator.persist([invalid])).rejects.toThrow(/unsupported_contract_version|forbidden_field/u)
        expect(persist).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
    })

    it.each(['http-400', 'http-403', 'http-409', 'http-413'] as const)('durably marks an isolated page terminal after %s', async reason => {
        const store = new MemoryStore()
        const send = jest.fn(async () => ({ kind: 'terminal', reason }) as AnimationRumV3SendResult)
        const coordinator = new AnimationRumV3DeliveryCoordinator(options(store, send, () => 100))

        await expect(coordinator.flush([report(`terminal_${reason.slice(-3)}`)])).resolves.toEqual({
            attempted: 1,
            confirmed: 0,
            terminal: 1,
            retried: 0,
        })
        expect([...store.records.values()][0]).toEqual(expect.objectContaining({ state: 'terminal', terminalReason: reason }))
    })

    it.each(['http-400', 'http-403', 'http-409'] as const)(
        'isolates %s to the rejected report without poisoning a valid sibling',
        async reason => {
            const store = new MemoryStore()
            const batches: string[][] = []
            const send = jest.fn(async (reports: readonly AnimationRumV3QueuedReport[]) => {
                batches.push(reports.map(value => value.eventId))
                if (reports.length > 1 || reports[0]!.eventId === 'event_bad_item') return { kind: 'terminal', reason } as const
                return settled(reports)
            })
            const coordinator = new AnimationRumV3DeliveryCoordinator(options(store, send, () => 100))

            await expect(coordinator.flush([report('valid_item'), report('bad_item')])).resolves.toEqual({
                attempted: 2,
                confirmed: 1,
                terminal: 1,
                retried: 0,
            })
            expect(batches).toEqual([['event_valid_item', 'event_bad_item'], ['event_valid_item'], ['event_bad_item']])
            expect([...store.records.values()].find(value => value.eventId === 'event_valid_item')).toEqual(
                expect.objectContaining({ state: 'confirmed', terminalReason: null })
            )
            expect([...store.records.values()].find(value => value.eventId === 'event_bad_item')).toEqual(
                expect.objectContaining({ state: 'terminal', terminalReason: reason })
            )
        }
    )

    it('splits an aggregate HTTP 413 and confirms every smaller accepted subset', async () => {
        const store = new MemoryStore()
        const batchSizes: number[] = []
        const send = jest.fn(async (reports: readonly AnimationRumV3QueuedReport[]) => {
            batchSizes.push(reports.length)
            return reports.length > 2 ? ({ kind: 'terminal', reason: 'http-413' } as const) : settled(reports)
        })
        const coordinator = new AnimationRumV3DeliveryCoordinator(options(store, send, () => 100))

        await expect(coordinator.flush([report('size_001'), report('size_002'), report('size_003'), report('size_004')])).resolves.toEqual({
            attempted: 4,
            confirmed: 4,
            terminal: 0,
            retried: 0,
        })
        expect(batchSizes).toEqual([4, 2, 2])
        expect([...store.records.values()].every(value => value.state === 'confirmed')).toBe(true)
    })

    it('bounds a global HTTP 403 denial to the original request plus one request per report', async () => {
        const store = new MemoryStore()
        const batchSizes: number[] = []
        const send = jest.fn(async (reports: readonly AnimationRumV3QueuedReport[]) => {
            batchSizes.push(reports.length)
            return { kind: 'terminal', reason: 'http-403' } as const
        })
        const coordinator = new AnimationRumV3DeliveryCoordinator(options(store, send, () => 100))

        await expect(coordinator.flush([report('deny_001'), report('deny_002'), report('deny_003'), report('deny_004')])).resolves.toEqual({
            attempted: 4,
            confirmed: 0,
            terminal: 4,
            retried: 0,
        })
        expect(batchSizes).toEqual([4, 1, 1, 1, 1])
        expect([...store.records.values()].every(value => value.state === 'terminal')).toBe(true)
    })

    it('retries only an isolated subset whose settled response has invalid receipts', async () => {
        const store = new MemoryStore()
        const batchSizes: number[] = []
        const send = jest.fn(async (reports: readonly AnimationRumV3QueuedReport[]) => {
            batchSizes.push(reports.length)
            if (batchSizes.length === 1) return { kind: 'terminal', reason: 'http-400' } as const
            if (batchSizes.length === 2) return { kind: 'settled', settlements: [], receipts: [] } as AnimationRumV3SendResult
            return settled(reports)
        })
        const coordinator = new AnimationRumV3DeliveryCoordinator(options(store, send, () => 100))

        await expect(coordinator.flush([report('mixed_01'), report('mixed_02'), report('mixed_03'), report('mixed_04')])).resolves.toEqual({
            attempted: 4,
            confirmed: 2,
            terminal: 0,
            retried: 2,
        })
        expect(batchSizes).toEqual([4, 2, 2])
        expect([...store.records.values()].filter(value => value.state === 'confirmed')).toHaveLength(2)
        expect([...store.records.values()].filter(value => value.state === 'pending' && value.attemptCount === 1)).toHaveLength(2)
    })

    it('stops terminal isolation before another request when lease renewal loses ownership', async () => {
        const store = new MemoryStore()
        const renewLeases = store.renewLeases.bind(store)
        store.renewLeases = jest.fn().mockImplementationOnce(renewLeases).mockResolvedValueOnce([])
        const send = jest.fn(async (reports: readonly AnimationRumV3QueuedReport[]) =>
            reports.length > 1 ? ({ kind: 'terminal', reason: 'http-403' } as const) : settled(reports)
        )
        const coordinator = new AnimationRumV3DeliveryCoordinator(options(store, send, () => 100))

        await expect(coordinator.flush([report('lease_01'), report('lease_02')])).rejects.toThrow('lease changed')
        expect(send).toHaveBeenCalledTimes(2)
        expect([...store.records.values()].filter(value => value.state === 'confirmed')).toHaveLength(1)
        expect([...store.records.values()].filter(value => value.state === 'pending')).toHaveLength(1)
    })

    it.each(['stop', 'suspend'] as const)('does not start another isolation request after %s', async lifecycleMethod => {
        const store = new MemoryStore()
        let finishFirstChild!: (result: AnimationRumV3SendResult) => void
        let markFirstChildStarted!: () => void
        const firstChildStarted = new Promise<void>(resolve => {
            markFirstChildStarted = resolve
        })
        const firstChildResult = new Promise<AnimationRumV3SendResult>(resolve => {
            finishFirstChild = resolve
        })
        const send = jest.fn(async (reports: readonly AnimationRumV3QueuedReport[]) => {
            if (send.mock.calls.length === 1) return { kind: 'terminal', reason: 'http-403' } as const
            if (send.mock.calls.length === 2) {
                markFirstChildStarted()
                return firstChildResult
            }
            return settled(reports)
        })
        const coordinator = new AnimationRumV3DeliveryCoordinator(options(store, send, () => 100))
        const flushing = coordinator.flush([report(`lifecycle_${lifecycleMethod}_1`), report(`lifecycle_${lifecycleMethod}_2`)])
        await firstChildStarted

        const lifecycle = coordinator[lifecycleMethod]()
        finishFirstChild(settled(send.mock.calls[1]![0]))

        await expect(flushing).resolves.toEqual({ attempted: 2, confirmed: 1, terminal: 0, retried: 1 })
        await expect(lifecycle).resolves.toBeUndefined()
        expect(send).toHaveBeenCalledTimes(2)
        expect([...store.records.values()].filter(value => value.state === 'confirmed')).toHaveLength(1)
        expect([...store.records.values()].filter(value => value.state === 'pending' && value.attemptCount === 1)).toHaveLength(1)
    })

    it('durably records a quarantined receipt as terminal', async () => {
        const store = new MemoryStore()
        const send = jest.fn(async (reports: readonly AnimationRumV3QueuedReport[]) => ({
            kind: 'settled' as const,
            settlements: reports.map(item => ({
                key: item.key,
                state: 'terminal' as const,
                terminalReason: 'server-quarantined' as const,
            })),
            receipts: reports.map(item => ({
                eventId: item.eventId,
                captureId: item.captureId,
                receivedAt: '2026-08-29T08:00:00.000Z',
                deliveryState: 'quarantined' as const,
                duplicate: false,
            })),
        }))
        const coordinator = new AnimationRumV3DeliveryCoordinator(options(store, send, () => 100))

        await expect(coordinator.flush([report('quarantine')])).resolves.toEqual({
            attempted: 1,
            confirmed: 0,
            terminal: 1,
            retried: 0,
        })
        expect([...store.records.values()][0]).toEqual(expect.objectContaining({ state: 'terminal', terminalReason: 'server-quarantined' }))
    })

    it('marks retry exhaustion terminal and never sends the page again', async () => {
        const store = new MemoryStore()
        let now = 100
        const send = jest.fn(async () => ({ kind: 'retry' }) as AnimationRumV3SendResult)
        const coordinator = new AnimationRumV3DeliveryCoordinator(options(store, send, () => now))

        await coordinator.flush([report('exhaust1')])
        now = 200
        await coordinator.flush()
        now = 400
        await expect(coordinator.flush()).resolves.toEqual({ attempted: 1, confirmed: 0, terminal: 1, retried: 0 })
        now = 1_000
        await expect(coordinator.flush()).resolves.toEqual({ attempted: 0, confirmed: 0, terminal: 0, retried: 0 })
        expect([...store.records.values()][0]).toEqual(expect.objectContaining({ state: 'terminal', terminalReason: 'retry-exhausted' }))
        expect(send).toHaveBeenCalledTimes(3)
    })

    it('fails closed when settlement loses the lease and lets competing coordinators send only once', async () => {
        const lostStore = new MemoryStore()
        lostStore.settle = jest.fn(async () => [])
        const lostCoordinator = new AnimationRumV3DeliveryCoordinator(
            options(
                lostStore,
                async reports => settled(reports),
                () => 100
            )
        )
        await expect(lostCoordinator.flush([report('lost_lease')])).rejects.toThrow('lease changed')

        const sharedStore = new MemoryStore()
        const firstSend = jest.fn(async (reports: readonly AnimationRumV3QueuedReport[]) => settled(reports))
        const secondSend = jest.fn(async (reports: readonly AnimationRumV3QueuedReport[]) => settled(reports))
        const first = new AnimationRumV3DeliveryCoordinator({ ...options(sharedStore, firstSend, () => 100), ownerId: 'owner-one' })
        const second = new AnimationRumV3DeliveryCoordinator({ ...options(sharedStore, secondSend, () => 100), ownerId: 'owner-two' })
        await first.persist([report('shared01')])

        const results = await Promise.all([first.flush(), second.flush()])

        expect(results.map(result => result.attempted).sort()).toEqual([0, 1])
        expect(firstSend.mock.calls.length + secondSend.mock.calls.length).toBe(1)
    })

    it('recovers after an IndexedDB persistence failure and delivers the later durable retry', async () => {
        const store = new MemoryStore()
        const failure = new Error('IndexedDB unavailable')
        const originalPersist = store.persist.bind(store)
        store.persist = jest.fn().mockRejectedValueOnce(failure).mockImplementation(originalPersist)
        const send = jest.fn(async (reports: readonly AnimationRumV3QueuedReport[]) => settled(reports))
        const coordinator = new AnimationRumV3DeliveryCoordinator(options(store, send, () => 100))
        const value = report('store_fail')

        await expect(coordinator.persist([value])).rejects.toBe(failure)
        await expect(coordinator.flush([value])).resolves.toEqual({ attempted: 1, confirmed: 1, terminal: 0, retried: 0 })
        await expect(coordinator.stop()).resolves.toBeUndefined()
    })

    it('serializes persistence, flush, suspend, and stop without losing pending durable work', async () => {
        const store = new MemoryStore()
        let releasePersist!: () => void
        const gate = new Promise<void>(resolve => {
            releasePersist = resolve
        })
        const originalPersist = store.persist.bind(store)
        store.persist = jest.fn(async (...args: Parameters<MemoryStore['persist']>) => {
            await gate
            return originalPersist(...args)
        })
        const send = jest.fn(async (reports: readonly AnimationRumV3QueuedReport[]) => settled(reports))
        const coordinator = new AnimationRumV3DeliveryCoordinator(options(store, send, () => 100))

        const persistence = coordinator.persist([report('race0001')])
        const flush = coordinator.flush()
        const suspension = coordinator.suspend()
        const stopping = coordinator.stop()
        releasePersist()

        await expect(persistence).resolves.toEqual({ reports: [expect.objectContaining({ duplicate: false })] })
        await expect(flush).resolves.toEqual({ attempted: 0, confirmed: 0, terminal: 0, retried: 0 })
        await expect(suspension).resolves.toBeUndefined()
        await expect(stopping).resolves.toBeUndefined()
        expect(send).not.toHaveBeenCalled()
        expect([...store.records.values()][0]).toEqual(expect.objectContaining({ state: 'pending', leaseOwner: null }))
    })
})
