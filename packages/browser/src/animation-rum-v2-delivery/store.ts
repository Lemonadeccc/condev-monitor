import { type DBSchema, type IDBPDatabase, openDB } from 'idb'

import type {
    AnimationRumV2DeliveryScope,
    AnimationRumV2DeliveryStore,
    AnimationRumV2PersistResult,
    AnimationRumV2PruneResult,
    AnimationRumV2QueuedReport,
    AnimationRumV2RetryUpdate,
    AnimationRumV2Settlement,
} from './types'

const DATABASE_NAME = 'condev-monitor-animation-rum-v2'
const DATABASE_VERSION = 1
const STORE_NAME = 'delivery-reports'
const TERMINAL_REASONS = new Set([
    'http-400',
    'http-403',
    'http-409',
    'http-413',
    'retry-exhausted',
    'server-quarantined',
    'parent-terminal',
])

interface AnimationRumV2DeliveryDatabase extends DBSchema {
    'delivery-reports': {
        key: string
        value: AnimationRumV2QueuedReport
        indexes: {
            'by-created-at': number
        }
    }
}

export class AnimationRumV2StoreCapacityError extends Error {
    constructor() {
        super('Animation RUM v2 delivery store is full')
        this.name = 'AnimationRumV2StoreCapacityError'
    }
}

function activeLease(report: AnimationRumV2QueuedReport, now: number): boolean {
    return report.leaseOwner !== null && report.leaseUntil > now
}

function sameScope(report: AnimationRumV2QueuedReport, scope: AnimationRumV2DeliveryScope): boolean {
    return report.scopeKey === scope.scopeKey && report.appId === scope.appId && report.trackingUrl === scope.trackingUrl
}

function samePersistedReport(left: AnimationRumV2QueuedReport, right: AnimationRumV2QueuedReport): boolean {
    return (
        left.eventId === right.eventId &&
        left.captureId === right.captureId &&
        left.reportScope === right.reportScope &&
        left.parentCaptureId === right.parentCaptureId &&
        left.payloadJson === right.payloadJson &&
        left.payloadBytes === right.payloadBytes
    )
}

function orderedForEviction(left: AnimationRumV2QueuedReport, right: AnimationRumV2QueuedReport): number {
    const leftPending = left.state === 'pending' ? 1 : 0
    const rightPending = right.state === 'pending' ? 1 : 0
    const leftRetentionStart = left.state === 'pending' ? left.createdAt : (left.settledAt ?? left.createdAt)
    const rightRetentionStart = right.state === 'pending' ? right.createdAt : (right.settledAt ?? right.createdAt)
    return leftPending - rightPending || leftRetentionStart - rightRetentionStart || left.key.localeCompare(right.key)
}

function orderedForDelivery(left: AnimationRumV2QueuedReport, right: AnimationRumV2QueuedReport): number {
    const leftTarget = left.reportScope === 'target' ? 1 : 0
    const rightTarget = right.reportScope === 'target' ? 1 : 0
    return (
        leftTarget - rightTarget ||
        left.nextAttemptAt - right.nextAttemptAt ||
        left.createdAt - right.createdAt ||
        left.key.localeCompare(right.key)
    )
}

function expiredRecordKeys(reports: readonly AnimationRumV2QueuedReport[], cutoff: number, now: number): Set<string> {
    const retentionStart = (report: AnimationRumV2QueuedReport) =>
        report.state === 'pending' ? report.createdAt : (report.settledAt ?? report.createdAt)
    const expired = new Set(
        reports.filter(report => retentionStart(report) <= cutoff && !activeLease(report, now)).map(report => report.key)
    )
    const unavailableParents = new Set(
        reports
            .filter(report => report.reportScope === 'page' && report.state !== 'confirmed' && expired.has(report.key))
            .map(report => report.captureId)
    )
    for (const report of reports) {
        if (
            report.reportScope === 'target' &&
            report.parentCaptureId !== null &&
            unavailableParents.has(report.parentCaptureId) &&
            !activeLease(report, now)
        ) {
            expired.add(report.key)
        }
    }
    return expired
}

function assertLimits(limits: { maxItems: number; maxAgeMs: number }): void {
    if (!Number.isSafeInteger(limits.maxItems) || limits.maxItems < 1) throw new TypeError('Invalid Animation RUM v2 store item limit')
    if (!Number.isSafeInteger(limits.maxAgeMs) || limits.maxAgeMs < 1) throw new TypeError('Invalid Animation RUM v2 store age limit')
}

function assertNow(now: number): void {
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid Animation RUM v2 store time')
}

function assertOwnerId(ownerId: string): void {
    if (typeof ownerId !== 'string' || ownerId.length === 0 || ownerId.length > 128) {
        throw new TypeError('Invalid Animation RUM v2 lease owner')
    }
}

async function abortTransaction(transaction: { abort(): void; done: Promise<unknown> }): Promise<void> {
    try {
        transaction.abort()
    } catch {
        // The transaction may already have been aborted by IndexedDB.
    }
    try {
        await transaction.done
    } catch {
        // The caller retains the original validation or capacity error.
    }
}

export class IndexedDbAnimationRumV2DeliveryStore implements AnimationRumV2DeliveryStore {
    private databasePromise: Promise<IDBPDatabase<AnimationRumV2DeliveryDatabase>> | null = null

    async persist(
        scope: AnimationRumV2DeliveryScope,
        reports: readonly AnimationRumV2QueuedReport[],
        limits: { maxItems: number; maxAgeMs: number },
        now: number
    ): Promise<AnimationRumV2PersistResult> {
        assertLimits(limits)
        assertNow(now)
        if (reports.some(report => !sameScope(report, scope))) throw new TypeError('Animation RUM v2 persistence scope mismatch')

        const database = await this.getDatabase()
        const transaction = database.transaction(STORE_NAME, 'readwrite', { durability: 'strict' })
        try {
            const allReports = await transaction.store.getAll()
            const cutoff = now - limits.maxAgeMs
            const retained = allReports.filter(report => sameScope(report, scope))
            const expiredKeys = expiredRecordKeys(retained, cutoff, now)

            for (const report of retained) {
                if (expiredKeys.has(report.key)) await transaction.store.delete(report.key)
            }

            const current = retained.filter(report => !expiredKeys.has(report.key))
            const currentByKey = new Map(current.map(report => [report.key, report] as const))
            const currentByCapture = new Map(current.map(report => [report.captureId, report] as const))
            const pendingNew = new Map<string, AnimationRumV2QueuedReport>()

            for (const report of reports) {
                const existing = currentByKey.get(report.key) ?? pendingNew.get(report.key)
                if (existing) {
                    if (!samePersistedReport(existing, report))
                        throw new TypeError('Animation RUM v2 event id conflicts with stored payload')
                    continue
                }

                const captureOwner =
                    currentByCapture.get(report.captureId) ?? [...pendingNew.values()].find(item => item.captureId === report.captureId)
                if (captureOwner && captureOwner.eventId !== report.eventId) {
                    throw new TypeError('Animation RUM v2 capture id conflicts with stored event')
                }
                pendingNew.set(report.key, { ...report })
            }

            const pageByCapture = new Map<string, AnimationRumV2QueuedReport>()
            for (const report of [...current, ...pendingNew.values()]) {
                if (report.reportScope === 'page') pageByCapture.set(report.captureId, report)
            }

            for (const report of pendingNew.values()) {
                if (report.reportScope === 'target') {
                    const parent = pageByCapture.get(report.parentCaptureId!)
                    if (!parent) throw new TypeError('Animation RUM v2 target parent is not durably queued')
                    if (parent.state === 'terminal') {
                        report.state = 'terminal'
                        report.parentConfirmed = false
                        report.terminalReason = 'parent-terminal'
                        report.updatedAt = now
                        report.settledAt = now
                    } else {
                        report.parentConfirmed = parent.state === 'confirmed'
                    }
                }
            }

            const desiredCount = current.length + pendingNew.size
            if (desiredCount > limits.maxItems) {
                const requestedKeys = new Set(reports.map(report => report.key))
                const removableSettled = current
                    .filter(report => report.state !== 'pending' && !activeLease(report, now) && !requestedKeys.has(report.key))
                    .sort(orderedForEviction)
                const needed = desiredCount - limits.maxItems
                if (removableSettled.length < needed) throw new AnimationRumV2StoreCapacityError()
                for (const report of removableSettled.slice(0, needed)) {
                    await transaction.store.delete(report.key)
                    currentByKey.delete(report.key)
                }
            }

            for (const report of pendingNew.values()) await transaction.store.put(report)
            await transaction.done

            const returnedKeys = new Set<string>()
            return {
                reports: reports.map(report => {
                    const existing = currentByKey.get(report.key)
                    const stored = existing ?? pendingNew.get(report.key)!
                    const duplicate = existing !== undefined || returnedKeys.has(report.key)
                    returnedKeys.add(report.key)
                    return {
                        key: stored.key,
                        eventId: stored.eventId,
                        captureId: stored.captureId,
                        state: stored.state,
                        duplicate,
                    }
                }),
            }
        } catch (error) {
            await abortTransaction(transaction)
            throw error
        }
    }

    async prune(
        scope: AnimationRumV2DeliveryScope,
        limits: { maxItems: number; maxAgeMs: number },
        now: number
    ): Promise<AnimationRumV2PruneResult> {
        assertLimits(limits)
        assertNow(now)
        const database = await this.getDatabase()
        const transaction = database.transaction(STORE_NAME, 'readwrite', { durability: 'strict' })
        const reports = (await transaction.store.getAll()).filter(report => sameScope(report, scope))
        const cutoff = now - limits.maxAgeMs
        const expiredKeys = expiredRecordKeys(reports, cutoff, now)
        let expired = 0
        const retained: AnimationRumV2QueuedReport[] = []

        for (const report of reports) {
            if (expiredKeys.has(report.key)) {
                await transaction.store.delete(report.key)
                expired += 1
            } else {
                retained.push(report)
            }
        }

        const excessCount = Math.max(0, retained.length - limits.maxItems)
        // Settled tombstones are the only quota-eviction candidates. Pending
        // reports are never discarded merely because configuration changed;
        // persist() fails closed until enough durable work has settled/expired.
        const removable = retained
            .filter(report => report.state !== 'pending' && !activeLease(report, now))
            .sort(orderedForEviction)
            .slice(0, excessCount)
        for (const report of removable) await transaction.store.delete(report.key)
        await transaction.done
        return { expired, excess: removable.length }
    }

    async leaseReady(
        scope: AnimationRumV2DeliveryScope,
        ownerId: string,
        now: number,
        limit: number,
        leaseDurationMs: number,
        maxBatchBytes: number
    ): Promise<AnimationRumV2QueuedReport[]> {
        assertNow(now)
        assertOwnerId(ownerId)
        if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Invalid Animation RUM v2 lease limit')
        if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) throw new TypeError('Invalid Animation RUM v2 lease duration')
        if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes < 1) throw new TypeError('Invalid Animation RUM v2 lease byte limit')
        const database = await this.getDatabase()
        const transaction = database.transaction(STORE_NAME, 'readwrite', { durability: 'strict' })
        const candidates = (await transaction.store.getAll())
            .filter(
                report =>
                    sameScope(report, scope) &&
                    report.state === 'pending' &&
                    report.nextAttemptAt <= now &&
                    report.leaseUntil <= now &&
                    (report.reportScope === 'page' || report.parentConfirmed)
            )
            .sort(orderedForDelivery)

        const selected: AnimationRumV2QueuedReport[] = []
        let selectedPayloadBytes = 0
        for (const report of candidates) {
            const batchBytes =
                selected.length === 0 ? report.payloadBytes : 2 + selectedPayloadBytes + report.payloadBytes + selected.length
            if (batchBytes > maxBatchBytes) continue
            selected.push(report)
            selectedPayloadBytes += report.payloadBytes
            if (selected.length >= limit) break
        }

        const leased: AnimationRumV2QueuedReport[] = []
        for (const report of selected) {
            const updated = { ...report, leaseOwner: ownerId, leaseUntil: now + leaseDurationMs, updatedAt: now }
            await transaction.store.put(updated)
            leased.push(updated)
        }
        await transaction.done
        return leased
    }

    async settle(
        scope: AnimationRumV2DeliveryScope,
        ownerId: string,
        settlements: readonly AnimationRumV2Settlement[],
        now: number
    ): Promise<string[]> {
        if (settlements.length === 0) return []
        assertNow(now)
        assertOwnerId(ownerId)
        const settlementKeys = new Set<string>()
        for (const settlement of settlements) {
            if (typeof settlement.key !== 'string' || settlementKeys.has(settlement.key)) {
                throw new TypeError('Invalid Animation RUM v2 settlement identity')
            }
            if (
                (settlement.state === 'confirmed' && settlement.terminalReason !== null) ||
                (settlement.state === 'terminal' && !TERMINAL_REASONS.has(settlement.terminalReason ?? '')) ||
                (settlement.state !== 'confirmed' && settlement.state !== 'terminal')
            ) {
                throw new TypeError('Invalid Animation RUM v2 settlement state')
            }
            settlementKeys.add(settlement.key)
        }
        const database = await this.getDatabase()
        const transaction = database.transaction(STORE_NAME, 'readwrite', { durability: 'strict' })
        const allReports = await transaction.store.getAll()
        const byKey = new Map(allReports.map(report => [report.key, report] as const))
        const confirmedPages = new Set<string>()
        const terminalPages = new Set<string>()
        const applied: string[] = []

        for (const settlement of settlements) {
            const report = byKey.get(settlement.key)
            if (!report || !sameScope(report, scope) || report.state !== 'pending' || report.leaseOwner !== ownerId) continue
            const terminalReason = settlement.state === 'terminal' ? settlement.terminalReason : null
            const updated: AnimationRumV2QueuedReport = {
                ...report,
                state: settlement.state,
                terminalReason,
                attemptCount: report.attemptCount + 1,
                leaseOwner: null,
                leaseUntil: 0,
                updatedAt: now,
                settledAt: now,
            }
            await transaction.store.put(updated)
            applied.push(updated.key)
            byKey.set(updated.key, updated)
            if (report.reportScope === 'page') {
                if (settlement.state === 'confirmed') confirmedPages.add(report.captureId)
                else terminalPages.add(report.captureId)
            }
        }

        for (const report of byKey.values()) {
            if (
                !sameScope(report, scope) ||
                report.reportScope !== 'target' ||
                report.state !== 'pending' ||
                report.parentCaptureId === null
            )
                continue
            if (confirmedPages.has(report.parentCaptureId)) {
                await transaction.store.put({ ...report, parentConfirmed: true, updatedAt: now })
            } else if (terminalPages.has(report.parentCaptureId)) {
                await transaction.store.put({
                    ...report,
                    state: 'terminal',
                    terminalReason: 'parent-terminal',
                    leaseOwner: null,
                    leaseUntil: 0,
                    updatedAt: now,
                    settledAt: now,
                })
            }
        }
        await transaction.done
        return applied
    }

    async reschedule(
        scope: AnimationRumV2DeliveryScope,
        ownerId: string,
        updates: readonly AnimationRumV2RetryUpdate[],
        now: number
    ): Promise<string[]> {
        if (updates.length === 0) return []
        assertNow(now)
        assertOwnerId(ownerId)
        const updateKeys = new Set<string>()
        for (const update of updates) {
            if (
                typeof update.key !== 'string' ||
                updateKeys.has(update.key) ||
                !Number.isSafeInteger(update.attemptCount) ||
                update.attemptCount < 1 ||
                !Number.isSafeInteger(update.nextAttemptAt) ||
                update.nextAttemptAt < now
            ) {
                throw new TypeError('Invalid Animation RUM v2 retry update')
            }
            updateKeys.add(update.key)
        }
        const database = await this.getDatabase()
        const transaction = database.transaction(STORE_NAME, 'readwrite', { durability: 'strict' })
        const pendingUpdates: Array<{ report: AnimationRumV2QueuedReport; update: AnimationRumV2RetryUpdate }> = []
        for (const update of updates) {
            const report = await transaction.store.get(update.key)
            if (!report || !sameScope(report, scope) || report.state !== 'pending' || report.leaseOwner !== ownerId) continue
            if (update.attemptCount !== report.attemptCount + 1) throw new TypeError('Invalid Animation RUM v2 retry update')
            pendingUpdates.push({ report, update })
        }
        for (const { report, update } of pendingUpdates) {
            await transaction.store.put({
                ...report,
                attemptCount: update.attemptCount,
                nextAttemptAt: update.nextAttemptAt,
                leaseOwner: null,
                leaseUntil: 0,
                updatedAt: now,
            })
        }
        await transaction.done
        return pendingUpdates.map(({ report }) => report.key)
    }

    async releaseLeases(scope: AnimationRumV2DeliveryScope, ownerId: string, now: number): Promise<void> {
        assertNow(now)
        assertOwnerId(ownerId)
        const database = await this.getDatabase()
        const transaction = database.transaction(STORE_NAME, 'readwrite', { durability: 'strict' })
        for (const report of await transaction.store.getAll()) {
            if (!sameScope(report, scope) || report.state !== 'pending' || report.leaseOwner !== ownerId) continue
            await transaction.store.put({ ...report, leaseOwner: null, leaseUntil: 0, updatedAt: now })
        }
        await transaction.done
    }

    private getDatabase(): Promise<IDBPDatabase<AnimationRumV2DeliveryDatabase>> {
        if (this.databasePromise === null) {
            this.databasePromise = openDB<AnimationRumV2DeliveryDatabase>(DATABASE_NAME, DATABASE_VERSION, {
                upgrade(database) {
                    const store = database.createObjectStore(STORE_NAME, { keyPath: 'key' })
                    store.createIndex('by-created-at', 'createdAt')
                },
            }).catch(error => {
                this.databasePromise = null
                throw error
            })
        }
        return this.databasePromise
    }
}
