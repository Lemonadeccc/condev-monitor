import { createAnimationRumV2GoldenReport } from '@condev-monitor/animation-rum-contract/testing'

import { AnimationRumV2DeliveryCoordinator } from './coordinator'
import type {
    AnimationRumV2DeliveryScope,
    AnimationRumV2DeliveryStore,
    AnimationRumV2PersistResult,
    AnimationRumV2PruneResult,
    AnimationRumV2QueuedReport,
    AnimationRumV2RetryUpdate,
    AnimationRumV2SendResult,
    AnimationRumV2Settlement,
} from './types'

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
    report.targetKey = `surface-${suffix}`
    report.metrics[0]!.relation = 'target-temporal-overlap'
    return report
}

class MemoryDeliveryStore implements AnimationRumV2DeliveryStore {
    readonly records = new Map<string, AnimationRumV2QueuedReport>()
    readonly calls: string[] = []
    readonly close = jest.fn(async () => undefined)

    async persist(
        scope: AnimationRumV2DeliveryScope,
        reports: readonly AnimationRumV2QueuedReport[],
        _limits: { maxItems: number; maxAgeMs: number },
        _now: number
    ): Promise<AnimationRumV2PersistResult> {
        this.calls.push('persist')
        const pages = new Map(
            [...this.records.values(), ...reports]
                .filter(report => report.scopeKey === scope.scopeKey && report.reportScope === 'page')
                .map(report => [report.captureId, report] as const)
        )
        const result: AnimationRumV2PersistResult['reports'] = []
        for (const input of reports) {
            const existing = this.records.get(input.key)
            if (existing) {
                if (existing.payloadJson !== input.payloadJson || existing.captureId !== input.captureId)
                    throw new Error('identity conflict')
                result.push({
                    key: existing.key,
                    eventId: existing.eventId,
                    captureId: existing.captureId,
                    state: existing.state,
                    duplicate: true,
                })
                continue
            }
            const record = { ...input }
            if (record.reportScope === 'target') {
                const parent = pages.get(record.parentCaptureId!)
                if (!parent) throw new Error('missing parent')
                record.parentConfirmed = parent.state === 'confirmed'
            }
            this.records.set(record.key, record)
            result.push({ key: record.key, eventId: record.eventId, captureId: record.captureId, state: record.state, duplicate: false })
        }
        return { reports: result }
    }

    async prune(): Promise<AnimationRumV2PruneResult> {
        this.calls.push('prune')
        return { expired: 0, excess: 0 }
    }

    async leaseReady(
        scope: AnimationRumV2DeliveryScope,
        ownerId: string,
        now: number,
        limit: number,
        leaseDurationMs: number,
        maxBatchBytes: number
    ) {
        this.calls.push(`lease:${ownerId}`)
        const ready = [...this.records.values()]
            .filter(
                report =>
                    report.scopeKey === scope.scopeKey &&
                    report.state === 'pending' &&
                    report.nextAttemptAt <= now &&
                    report.leaseUntil <= now &&
                    (report.reportScope === 'page' || report.parentConfirmed)
            )
            .sort((left, right) => Number(left.reportScope === 'target') - Number(right.reportScope === 'target'))
        const selected: AnimationRumV2QueuedReport[] = []
        let payloadBytes = 0
        for (const report of ready) {
            const batchBytes = selected.length === 0 ? report.payloadBytes : 2 + payloadBytes + report.payloadBytes + selected.length
            if (batchBytes > maxBatchBytes) continue
            selected.push(report)
            payloadBytes += report.payloadBytes
            if (selected.length >= limit) break
        }
        return selected.map(report => {
            const leased = { ...report, leaseOwner: ownerId, leaseUntil: now + leaseDurationMs, updatedAt: now }
            this.records.set(report.key, leased)
            return { ...leased }
        })
    }

    async settle(scope: AnimationRumV2DeliveryScope, ownerId: string, settlements: readonly AnimationRumV2Settlement[], now: number) {
        this.calls.push(`settle:${ownerId}`)
        const applied: string[] = []
        for (const settlement of settlements) {
            const report = this.records.get(settlement.key)
            if (!report || report.scopeKey !== scope.scopeKey || report.leaseOwner !== ownerId) continue
            const updated: AnimationRumV2QueuedReport = {
                ...report,
                state: settlement.state,
                terminalReason: settlement.terminalReason,
                attemptCount: report.attemptCount + 1,
                leaseOwner: null,
                leaseUntil: 0,
                updatedAt: now,
                settledAt: now,
            }
            this.records.set(updated.key, updated)
            applied.push(updated.key)
            if (report.reportScope !== 'page') continue
            for (const child of this.records.values()) {
                if (child.scopeKey !== scope.scopeKey || child.parentCaptureId !== report.captureId || child.state !== 'pending') continue
                this.records.set(child.key, {
                    ...child,
                    parentConfirmed: settlement.state === 'confirmed',
                    state: settlement.state === 'terminal' ? 'terminal' : child.state,
                    terminalReason: settlement.state === 'terminal' ? 'parent-terminal' : child.terminalReason,
                    settledAt: settlement.state === 'terminal' ? now : child.settledAt,
                })
            }
        }
        return applied
    }

    async reschedule(scope: AnimationRumV2DeliveryScope, ownerId: string, updates: readonly AnimationRumV2RetryUpdate[], now: number) {
        this.calls.push(`retry:${ownerId}`)
        const applied: string[] = []
        for (const update of updates) {
            const report = this.records.get(update.key)
            if (!report || report.scopeKey !== scope.scopeKey || report.leaseOwner !== ownerId) continue
            this.records.set(report.key, {
                ...report,
                attemptCount: update.attemptCount,
                nextAttemptAt: update.nextAttemptAt,
                leaseOwner: null,
                leaseUntil: 0,
                updatedAt: now,
            })
            applied.push(report.key)
        }
        return applied
    }

    async releaseLeases(scope: AnimationRumV2DeliveryScope, ownerId: string, now: number) {
        this.calls.push(`release:${ownerId}`)
        for (const report of this.records.values()) {
            if (report.scopeKey !== scope.scopeKey || report.leaseOwner !== ownerId) continue
            this.records.set(report.key, { ...report, leaseOwner: null, leaseUntil: 0, updatedAt: now })
        }
    }
}

function settled(reports: readonly AnimationRumV2QueuedReport[]): AnimationRumV2SendResult {
    return {
        kind: 'settled',
        settlements: reports.map(report => ({ key: report.key, state: 'confirmed', terminalReason: null })),
        receipts: reports.map(report => ({
            eventId: report.eventId,
            captureId: report.captureId,
            receivedAt: '2026-08-27T08:00:00.000Z',
            deliveryState: 'pending',
            duplicate: false,
        })),
    }
}

function options(
    store: AnimationRumV2DeliveryStore,
    send: (scope: AnimationRumV2DeliveryScope, reports: readonly AnimationRumV2QueuedReport[]) => Promise<AnimationRumV2SendResult>,
    now: () => number,
    ownerId = 'test-owner'
) {
    return {
        appId: 'appOne123',
        trackingUrl: 'https://collector.test/dsn-api/tracking/appOne123',
        store,
        sender: { send },
        clock: { now },
        ownerId,
        config: {
            retryBaseDelayMs: 100,
            retryMaxDelayMs: 10_000,
            retryMaxAttempts: 3,
            pollIntervalMs: 1_000,
        },
    }
}

describe('AnimationRumV2DeliveryCoordinator', () => {
    it('persists before network and flush waits for a pending persistence operation', async () => {
        const base = new MemoryDeliveryStore()
        let releasePersist!: () => void
        const gate = new Promise<void>(resolve => {
            releasePersist = resolve
        })
        const originalPersist = base.persist.bind(base)
        base.persist = jest.fn(async (...args: Parameters<MemoryDeliveryStore['persist']>) => {
            await gate
            return originalPersist(...args)
        })
        const send = jest.fn(async (_scope, reports) => settled(reports))
        const coordinator = new AnimationRumV2DeliveryCoordinator(options(base, send, () => 100))

        const persistence = coordinator.persist([pageReport('persist01')])
        const flush = coordinator.flush()
        await Promise.resolve()
        expect(send).not.toHaveBeenCalled()
        releasePersist()

        await expect(persistence).resolves.toEqual({ reports: [expect.objectContaining({ duplicate: false })] })
        await expect(flush).resolves.toEqual({ attempted: 1, confirmed: 1, terminal: 0, retried: 0 })
        expect(base.calls.slice(0, 3)).toEqual(['persist', 'prune', 'lease:test-owner'])
    })

    it('starts a post-persist attempt when an older generation is already sending', async () => {
        const store = new MemoryDeliveryStore()
        let finishFirstSend!: (result: AnimationRumV2SendResult) => void
        let markFirstSendStarted!: () => void
        const firstSendStarted = new Promise<void>(resolve => {
            markFirstSendStarted = resolve
        })
        const firstSendResult = new Promise<AnimationRumV2SendResult>(resolve => {
            finishFirstSend = resolve
        })
        const send = jest.fn(async (_scope, reports: readonly AnimationRumV2QueuedReport[]) => {
            if (send.mock.calls.length === 1) {
                markFirstSendStarted()
                return firstSendResult
            }
            return settled(reports)
        })
        const coordinator = new AnimationRumV2DeliveryCoordinator(options(store, send, () => 100))
        await coordinator.persist([pageReport('before01')])
        const olderAttempt = coordinator.attemptOnce()
        await firstSendStarted

        const flushed = coordinator.flush([pageReport('after001')])
        await Promise.resolve()
        expect(send).toHaveBeenCalledTimes(1)
        finishFirstSend(settled(send.mock.calls[0]![1]))

        await expect(olderAttempt).resolves.toEqual({ attempted: 1, confirmed: 1, terminal: 0, retried: 0 })
        await expect(flushed).resolves.toEqual({ attempted: 1, confirmed: 1, terminal: 0, retried: 0 })
        expect(send).toHaveBeenCalledTimes(2)
        expect(send.mock.calls[1]![1]).toEqual([expect.objectContaining({ eventId: 'event_after001' })])
    })

    it('rejects forbidden report fields before IndexedDB or network can observe them', async () => {
        const store = new MemoryDeliveryStore()
        const persist = jest.spyOn(store, 'persist')
        const send = jest.fn(async (_scope, reports) => settled(reports))
        const coordinator = new AnimationRumV2DeliveryCoordinator(options(store, send, () => 100))

        await expect(coordinator.persist([{ ...pageReport('privacy1'), selector: '#account-email' }])).rejects.toThrow(
            /forbidden_field|unknown_root_field/u
        )
        expect(persist).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
    })

    it('delivers a page before its child and requires a later attempt for the target', async () => {
        const store = new MemoryDeliveryStore()
        const batches: string[][] = []
        const send = jest.fn(async (_scope, reports: readonly AnimationRumV2QueuedReport[]) => {
            batches.push(reports.map(report => report.reportScope))
            return settled(reports)
        })
        const coordinator = new AnimationRumV2DeliveryCoordinator(options(store, send, () => 100))
        const page = pageReport('parent01')
        const target = targetReport(page.captureId, 'target01')

        await expect(coordinator.flush([target, page])).resolves.toEqual({ attempted: 1, confirmed: 1, terminal: 0, retried: 0 })
        await expect(coordinator.flush()).resolves.toEqual({ attempted: 1, confirmed: 1, terminal: 0, retried: 0 })
        expect(batches).toEqual([['page'], ['target']])
    })

    it('retries an invalid partial settlement without changing the exact stored payload or ids', async () => {
        const store = new MemoryDeliveryStore()
        let now = 100
        const attempts: AnimationRumV2QueuedReport[][] = []
        const send = jest.fn(async (_scope, reports: readonly AnimationRumV2QueuedReport[]) => {
            attempts.push(reports.map(report => ({ ...report })))
            if (attempts.length === 1) {
                return { kind: 'settled', settlements: [], receipts: [] } as AnimationRumV2SendResult
            }
            return settled(reports)
        })
        const coordinator = new AnimationRumV2DeliveryCoordinator(options(store, send, () => now))

        await expect(coordinator.flush([pageReport('retry001')])).resolves.toEqual({
            attempted: 1,
            confirmed: 0,
            terminal: 0,
            retried: 1,
        })
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

    it('does not trust a non-canonical timestamp returned by an injected sender', async () => {
        const store = new MemoryDeliveryStore()
        const send = jest.fn(async (_scope, reports: readonly AnimationRumV2QueuedReport[]) => {
            const result = settled(reports)
            if (result.kind === 'settled') result.receipts[0]!.receivedAt = '2026-08-27T08:00:00Z'
            return result
        })
        const coordinator = new AnimationRumV2DeliveryCoordinator(options(store, send, () => 100))

        await expect(coordinator.flush([pageReport('timestamp')])).resolves.toEqual({
            attempted: 1,
            confirmed: 0,
            terminal: 0,
            retried: 1,
        })
        expect([...store.records.values()][0]).toEqual(expect.objectContaining({ state: 'pending', attemptCount: 1 }))
    })

    it('honors bounded Retry-After and terminal HTTP outcomes per report', async () => {
        const store = new MemoryDeliveryStore()
        let now = 100
        const send = jest
            .fn<Promise<AnimationRumV2SendResult>, [AnimationRumV2DeliveryScope, readonly AnimationRumV2QueuedReport[]]>()
            .mockResolvedValueOnce({ kind: 'retry', retryAfterMs: 999_999 })
            .mockResolvedValueOnce({ kind: 'terminal', reason: 'http-403' })
        const coordinator = new AnimationRumV2DeliveryCoordinator(options(store, send, () => now))
        await coordinator.flush([pageReport('terminal')])
        const record = [...store.records.values()][0]!
        expect(record.nextAttemptAt).toBe(10_100)

        now = 10_099
        await expect(coordinator.flush()).resolves.toEqual({ attempted: 0, confirmed: 0, terminal: 0, retried: 0 })
        now = 10_100
        await expect(coordinator.flush()).resolves.toEqual({ attempted: 1, confirmed: 0, terminal: 1, retried: 0 })
        expect([...store.records.values()][0]).toEqual(expect.objectContaining({ state: 'terminal', terminalReason: 'http-403' }))
    })

    it('marks retry exhaustion terminal and does not send it again', async () => {
        const store = new MemoryDeliveryStore()
        let now = 100
        const send = jest.fn(async () => ({ kind: 'retry' }) as AnimationRumV2SendResult)
        const coordinator = new AnimationRumV2DeliveryCoordinator(options(store, send, () => now))
        await coordinator.flush([pageReport('exhaust1')])
        now = 200
        await coordinator.flush()
        now = 400
        await expect(coordinator.flush()).resolves.toEqual({ attempted: 1, confirmed: 0, terminal: 1, retried: 0 })
        now = 1_000
        await expect(coordinator.flush()).resolves.toEqual({ attempted: 0, confirmed: 0, terminal: 0, retried: 0 })
        expect([...store.records.values()][0]).toEqual(expect.objectContaining({ state: 'terminal', terminalReason: 'retry-exhausted' }))
        expect(send).toHaveBeenCalledTimes(3)
    })

    it('does not claim confirmation when the atomic store no longer owns the whole lease', async () => {
        const store = new MemoryDeliveryStore()
        store.settle = jest.fn(async () => [])
        const send = jest.fn(async (_scope, reports) => settled(reports))
        const coordinator = new AnimationRumV2DeliveryCoordinator(options(store, send, () => 100))

        await expect(coordinator.flush([pageReport('lost_lease')])).rejects.toThrow('lease changed')
    })

    it('uses an atomic shared lease so concurrent coordinators make only one network attempt', async () => {
        const store = new MemoryDeliveryStore()
        const firstSend = jest.fn(async (_scope, reports) => settled(reports))
        const secondSend = jest.fn(async (_scope, reports) => settled(reports))
        const first = new AnimationRumV2DeliveryCoordinator(options(store, firstSend, () => 100, 'owner-one'))
        const second = new AnimationRumV2DeliveryCoordinator(options(store, secondSend, () => 100, 'owner-two'))
        await first.persist([pageReport('shared01')])

        const results = await Promise.all([first.flush(), second.flush()])

        expect(results.map(result => result.attempted).sort()).toEqual([0, 1])
        expect(firstSend.mock.calls.length + secondSend.mock.calls.length).toBe(1)
    })

    it('keeps different app and tracking endpoint partitions out of this coordinator sender', async () => {
        const store = new MemoryDeliveryStore()
        const firstSend = jest.fn(async (_scope, reports) => settled(reports))
        const secondSend = jest.fn(async (_scope, reports) => settled(reports))
        const first = new AnimationRumV2DeliveryCoordinator(options(store, firstSend, () => 100, 'owner-one'))
        const second = new AnimationRumV2DeliveryCoordinator({
            ...options(store, secondSend, () => 100, 'owner-two'),
            appId: 'appTwo123',
            trackingUrl: 'https://collector-two.test/tracking/appTwo123',
        })
        await first.persist([pageReport('scope001')])
        await second.persist([pageReport('scope002')])

        await Promise.all([first.flush(), second.flush()])

        expect(firstSend.mock.calls[0]![0]).toEqual(expect.objectContaining({ appId: 'appOne123' }))
        expect(firstSend.mock.calls[0]![1]).toEqual([expect.objectContaining({ eventId: 'event_scope001' })])
        expect(secondSend.mock.calls[0]![0]).toEqual(expect.objectContaining({ appId: 'appTwo123' }))
        expect(secondSend.mock.calls[0]![1]).toEqual([expect.objectContaining({ eventId: 'event_scope002' })])
    })

    it('clears its timer and releases its owner leases after an in-flight attempt settles', async () => {
        const store = new MemoryDeliveryStore()
        const callbacks: Array<() => void> = []
        const clearInterval = jest.fn()
        let finishSend!: (result: AnimationRumV2SendResult) => void
        const sendResult = new Promise<AnimationRumV2SendResult>(resolve => {
            finishSend = resolve
        })
        const send = jest.fn(async () => sendResult)
        const coordinator = new AnimationRumV2DeliveryCoordinator({
            ...options(store, send, () => 100),
            timers: {
                setInterval(callback) {
                    callbacks.push(callback)
                    return 'timer-one'
                },
                clearInterval,
            },
        })
        await coordinator.persist([pageReport('stop0001')])
        coordinator.start()
        await Promise.resolve()
        const stopping = coordinator.stop()
        expect(coordinator.stop()).toBe(stopping)
        expect(clearInterval).toHaveBeenCalledWith('timer-one')
        expect(store.calls).not.toContain('release:test-owner')
        finishSend({ kind: 'retry' })

        await stopping
        expect(store.calls[store.calls.length - 1]).toBe('release:test-owner')
        expect(callbacks).toHaveLength(1)
    })

    it('suspends polling synchronously, preserves durable work, and resumes it after storage closes', async () => {
        const store = new MemoryDeliveryStore()
        const callbacks: Array<() => void> = []
        const clearInterval = jest.fn()
        let now = 100
        let finishFirstSend!: (result: AnimationRumV2SendResult) => void
        let markFirstSendStarted!: () => void
        const firstSendStarted = new Promise<void>(resolve => {
            markFirstSendStarted = resolve
        })
        const firstSendResult = new Promise<AnimationRumV2SendResult>(resolve => {
            finishFirstSend = resolve
        })
        const send = jest.fn(async (_scope, reports: readonly AnimationRumV2QueuedReport[]) => {
            if (send.mock.calls.length === 1) {
                markFirstSendStarted()
                return firstSendResult
            }
            return settled(reports)
        })
        const coordinator = new AnimationRumV2DeliveryCoordinator({
            ...options(store, send, () => now),
            timers: {
                setInterval(callback) {
                    callbacks.push(callback)
                    return `timer-${callbacks.length}`
                },
                clearInterval,
            },
        })
        await coordinator.persist([pageReport('cachepage')])
        coordinator.start()
        await firstSendStarted

        const suspension = coordinator.suspend()

        expect(clearInterval).toHaveBeenCalledWith('timer-1')
        expect(store.close).not.toHaveBeenCalled()
        finishFirstSend({ kind: 'retry' })
        await suspension
        expect(store.close).toHaveBeenCalledTimes(1)
        expect([...store.records.values()][0]).toEqual(expect.objectContaining({ state: 'pending', leaseOwner: null, attemptCount: 1 }))
        await expect(coordinator.persist([pageReport('while_suspended')])).rejects.toThrow('coordinator is suspended')

        now = 200
        await coordinator.resume()
        await coordinator.flush()

        expect(callbacks).toHaveLength(2)
        expect(send).toHaveBeenCalledTimes(2)
        expect([...store.records.values()][0]).toEqual(expect.objectContaining({ state: 'confirmed', leaseOwner: null }))
        await coordinator.stop()
    })

    it('serializes concurrent persistence, flush, suspension, and stop without losing the durable report', async () => {
        const store = new MemoryDeliveryStore()
        let releasePersist!: () => void
        const persistGate = new Promise<void>(resolve => {
            releasePersist = resolve
        })
        const originalPersist = store.persist.bind(store)
        store.persist = jest.fn(async (...args: Parameters<MemoryDeliveryStore['persist']>) => {
            await persistGate
            return originalPersist(...args)
        })
        const send = jest.fn(async (_scope, reports) => settled(reports))
        const coordinator = new AnimationRumV2DeliveryCoordinator(options(store, send, () => 100))

        const persistence = coordinator.persist([pageReport('race0001')])
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

    it('does not let one persistence failure poison a later successful retry and flush', async () => {
        const store = new MemoryDeliveryStore()
        const failure = new Error('IndexedDB unavailable')
        const originalPersist = store.persist.bind(store)
        store.persist = jest.fn().mockRejectedValueOnce(failure).mockImplementation(originalPersist)
        const send = jest.fn(async (_scope, reports) => settled(reports))
        const coordinator = new AnimationRumV2DeliveryCoordinator(options(store, send, () => 100))
        const report = pageReport('store_fail')

        await expect(coordinator.persist([report])).rejects.toBe(failure)
        await expect(coordinator.flush([report])).resolves.toEqual({ attempted: 1, confirmed: 1, terminal: 0, retried: 0 })
        expect(send).toHaveBeenCalledTimes(1)
        await expect(coordinator.stop()).resolves.toBeUndefined()
    })

    it('still sends durable work before surfacing an unrelated outstanding persistence failure', async () => {
        const store = new MemoryDeliveryStore()
        const failure = new Error('IndexedDB write unavailable')
        const originalPersist = store.persist.bind(store)
        let failSecondReport = true
        store.persist = jest.fn(async (...args: Parameters<MemoryDeliveryStore['persist']>) => {
            if (failSecondReport && args[1].some(report => report.eventId === 'event_failed02')) throw failure
            return originalPersist(...args)
        })
        const send = jest.fn(async (_scope, reports) => settled(reports))
        const coordinator = new AnimationRumV2DeliveryCoordinator(options(store, send, () => 100))
        const durable = pageReport('durable1')
        const failed = pageReport('failed02')
        await coordinator.persist([durable])
        await expect(coordinator.persist([failed])).rejects.toBe(failure)

        await expect(coordinator.flush()).rejects.toBe(failure)
        expect(send).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({ eventId: durable.eventId })])
        expect(store.records.get(JSON.stringify([coordinator.scope.scopeKey, durable.eventId]))).toEqual(
            expect.objectContaining({ state: 'confirmed' })
        )

        failSecondReport = false
        await expect(coordinator.flush([failed])).resolves.toEqual({ attempted: 1, confirmed: 1, terminal: 0, retried: 0 })
        await expect(coordinator.stop()).resolves.toBeUndefined()
    })

    it('allows stop to retry lease release after its previous stop promise rejected', async () => {
        const store = new MemoryDeliveryStore()
        const failure = new Error('IndexedDB release unavailable')
        let rejectFirstRelease!: (error: Error) => void
        const firstRelease = new Promise<void>((_resolve, reject) => {
            rejectFirstRelease = reject
        })
        const originalRelease = store.releaseLeases.bind(store)
        store.releaseLeases = jest
            .fn()
            .mockImplementationOnce(() => firstRelease)
            .mockImplementation(originalRelease)
        const coordinator = new AnimationRumV2DeliveryCoordinator(options(store, jest.fn(), () => 100))

        const firstStop = coordinator.stop()
        const concurrentStop = coordinator.stop()
        expect(concurrentStop).toBe(firstStop)
        rejectFirstRelease(failure)
        await expect(firstStop).rejects.toBe(failure)

        const retryStop = coordinator.stop()
        expect(retryStop).not.toBe(firstStop)
        await expect(retryStop).resolves.toBeUndefined()
        expect(store.releaseLeases).toHaveBeenCalledTimes(2)
        expect(store.calls[store.calls.length - 1]).toBe('release:test-owner')
    })

    it('allows stop to retry release after waiting for a failed in-flight attempt', async () => {
        const store = new MemoryDeliveryStore()
        const failure = new Error('IndexedDB prune unavailable')
        let rejectPrune!: (error: Error) => void
        const prune = new Promise<never>((_resolve, reject) => {
            rejectPrune = reject
        })
        store.prune = jest.fn(() => prune)
        const coordinator = new AnimationRumV2DeliveryCoordinator(options(store, jest.fn(), () => 100))
        const attemptResult = coordinator.attemptOnce().catch(error => error)

        const firstStop = coordinator.stop()
        expect(coordinator.stop()).toBe(firstStop)
        rejectPrune(failure)

        await expect(attemptResult).resolves.toBe(failure)
        await expect(firstStop).rejects.toBe(failure)
        await expect(coordinator.stop()).resolves.toBeUndefined()
        expect(store.calls.filter(call => call === 'release:test-owner')).toHaveLength(2)
    })

    it('requires the default request timeout to remain shorter than the cross-tab lease', () => {
        const store = new MemoryDeliveryStore()
        expect(
            () =>
                new AnimationRumV2DeliveryCoordinator({
                    ...options(store, jest.fn(), () => 100),
                    config: { leaseDurationMs: 10_000, requestTimeoutMs: 10_000 },
                })
        ).toThrow('shorter than its lease')
    })
})
