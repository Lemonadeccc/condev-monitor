import { type DBSchema, type IDBPDatabase, openDB } from 'idb'

import type {
    AnimationRumV3DeliveryScope,
    AnimationRumV3DeliveryStore,
    AnimationRumV3PersistResult,
    AnimationRumV3PruneResult,
    AnimationRumV3QueuedReport,
    AnimationRumV3RetryUpdate,
    AnimationRumV3Settlement,
} from './types'

const DATABASE_NAME = 'condev-monitor-animation-rum-v3-soft-navigation'
const DATABASE_VERSION = 1
const STORE_NAME = 'delivery-reports'
const TERMINAL_REASONS = new Set(['http-400', 'http-403', 'http-409', 'http-413', 'retry-exhausted', 'server-quarantined'])

interface AnimationRumV3DeliveryDatabase extends DBSchema {
    'delivery-reports': {
        key: string
        value: AnimationRumV3QueuedReport
        indexes: {
            'by-created-at': number
        }
    }
}

export class AnimationRumV3StoreCapacityError extends Error {
    constructor() {
        super('Animation RUM v3 soft navigation delivery store is full')
        this.name = 'AnimationRumV3StoreCapacityError'
    }
}

function activeLease(report: AnimationRumV3QueuedReport, now: number): boolean {
    return report.leaseOwner !== null && report.leaseUntil > now
}

function sameScope(report: AnimationRumV3QueuedReport, scope: AnimationRumV3DeliveryScope): boolean {
    return report.scopeKey === scope.scopeKey && report.appId === scope.appId && report.trackingUrl === scope.trackingUrl
}

function samePersistedReport(left: AnimationRumV3QueuedReport, right: AnimationRumV3QueuedReport): boolean {
    return (
        left.eventId === right.eventId &&
        left.captureId === right.captureId &&
        left.payloadJson === right.payloadJson &&
        left.payloadBytes === right.payloadBytes
    )
}

function orderedForEviction(left: AnimationRumV3QueuedReport, right: AnimationRumV3QueuedReport): number {
    const leftPending = left.state === 'pending' ? 1 : 0
    const rightPending = right.state === 'pending' ? 1 : 0
    const leftRetentionStart = left.state === 'pending' ? left.createdAt : (left.settledAt ?? left.createdAt)
    const rightRetentionStart = right.state === 'pending' ? right.createdAt : (right.settledAt ?? right.createdAt)
    return leftPending - rightPending || leftRetentionStart - rightRetentionStart || left.key.localeCompare(right.key)
}

function orderedForDelivery(left: AnimationRumV3QueuedReport, right: AnimationRumV3QueuedReport): number {
    return left.nextAttemptAt - right.nextAttemptAt || left.createdAt - right.createdAt || left.key.localeCompare(right.key)
}

function expiredRecordKeys(reports: readonly AnimationRumV3QueuedReport[], cutoff: number, now: number): Set<string> {
    const retentionStart = (report: AnimationRumV3QueuedReport) =>
        report.state === 'pending' ? report.createdAt : (report.settledAt ?? report.createdAt)
    return new Set(reports.filter(report => retentionStart(report) <= cutoff && !activeLease(report, now)).map(report => report.key))
}

function assertLimits(limits: { maxItems: number; maxAgeMs: number }): void {
    if (!Number.isSafeInteger(limits.maxItems) || limits.maxItems < 1)
        throw new TypeError('Invalid Animation RUM v3 soft navigation store item limit')
    if (!Number.isSafeInteger(limits.maxAgeMs) || limits.maxAgeMs < 1)
        throw new TypeError('Invalid Animation RUM v3 soft navigation store age limit')
}

function assertNow(now: number): void {
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid Animation RUM v3 soft navigation store time')
}

function assertOwnerId(ownerId: string): void {
    if (typeof ownerId !== 'string' || ownerId.length === 0 || ownerId.length > 128) {
        throw new TypeError('Invalid Animation RUM v3 soft navigation lease owner')
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

export class IndexedDbAnimationRumV3DeliveryStore implements AnimationRumV3DeliveryStore {
    private databasePromise: Promise<IDBPDatabase<AnimationRumV3DeliveryDatabase>> | null = null

    async close(): Promise<void> {
        const databasePromise = this.databasePromise
        if (databasePromise === null) return

        // Detach the connection before awaiting an in-progress open. A later
        // operation can then create a fresh connection without the old open's
        // rejection clearing that newer promise.
        if (this.databasePromise === databasePromise) this.databasePromise = null
        const database = await databasePromise
        database.close()
    }

    async persist(
        scope: AnimationRumV3DeliveryScope,
        reports: readonly AnimationRumV3QueuedReport[],
        limits: { maxItems: number; maxAgeMs: number },
        now: number
    ): Promise<AnimationRumV3PersistResult> {
        assertLimits(limits)
        assertNow(now)
        if (reports.some(report => !sameScope(report, scope)))
            throw new TypeError('Animation RUM v3 soft navigation persistence scope mismatch')

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
            const pendingNew = new Map<string, AnimationRumV3QueuedReport>()

            for (const report of reports) {
                const existing = currentByKey.get(report.key) ?? pendingNew.get(report.key)
                if (existing) {
                    if (!samePersistedReport(existing, report))
                        throw new TypeError('Animation RUM v3 soft navigation event id conflicts with stored payload')
                    continue
                }

                const captureOwner =
                    currentByCapture.get(report.captureId) ?? [...pendingNew.values()].find(item => item.captureId === report.captureId)
                if (captureOwner && captureOwner.eventId !== report.eventId) {
                    throw new TypeError('Animation RUM v3 soft navigation capture id conflicts with stored event')
                }
                pendingNew.set(report.key, { ...report })
            }

            const desiredCount = current.length + pendingNew.size
            if (desiredCount > limits.maxItems) {
                const requestedKeys = new Set(reports.map(report => report.key))
                const removableSettled = current
                    .filter(report => report.state !== 'pending' && !activeLease(report, now) && !requestedKeys.has(report.key))
                    .sort(orderedForEviction)
                const needed = desiredCount - limits.maxItems
                if (removableSettled.length < needed) throw new AnimationRumV3StoreCapacityError()
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
        scope: AnimationRumV3DeliveryScope,
        limits: { maxItems: number; maxAgeMs: number },
        now: number
    ): Promise<AnimationRumV3PruneResult> {
        assertLimits(limits)
        assertNow(now)
        const database = await this.getDatabase()
        const transaction = database.transaction(STORE_NAME, 'readwrite', { durability: 'strict' })
        const reports = (await transaction.store.getAll()).filter(report => sameScope(report, scope))
        const cutoff = now - limits.maxAgeMs
        const expiredKeys = expiredRecordKeys(reports, cutoff, now)
        let expired = 0
        const retained: AnimationRumV3QueuedReport[] = []

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
        scope: AnimationRumV3DeliveryScope,
        ownerId: string,
        now: number,
        limit: number,
        leaseDurationMs: number,
        maxBatchBytes: number
    ): Promise<AnimationRumV3QueuedReport[]> {
        assertNow(now)
        assertOwnerId(ownerId)
        if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Invalid Animation RUM v3 soft navigation lease limit')
        if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1)
            throw new TypeError('Invalid Animation RUM v3 soft navigation lease duration')
        if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes < 1)
            throw new TypeError('Invalid Animation RUM v3 soft navigation lease byte limit')
        const database = await this.getDatabase()
        const transaction = database.transaction(STORE_NAME, 'readwrite', { durability: 'strict' })
        const candidates = (await transaction.store.getAll())
            .filter(
                report => sameScope(report, scope) && report.state === 'pending' && report.nextAttemptAt <= now && report.leaseUntil <= now
            )
            .sort(orderedForDelivery)

        const selected: AnimationRumV3QueuedReport[] = []
        let selectedPayloadBytes = 0
        for (const report of candidates) {
            const batchBytes =
                selected.length === 0 ? report.payloadBytes : 2 + selectedPayloadBytes + report.payloadBytes + selected.length
            if (batchBytes > maxBatchBytes) continue
            selected.push(report)
            selectedPayloadBytes += report.payloadBytes
            if (selected.length >= limit) break
        }

        const leased: AnimationRumV3QueuedReport[] = []
        for (const report of selected) {
            const updated = { ...report, leaseOwner: ownerId, leaseUntil: now + leaseDurationMs, updatedAt: now }
            await transaction.store.put(updated)
            leased.push(updated)
        }
        await transaction.done
        return leased
    }

    async renewLeases(
        scope: AnimationRumV3DeliveryScope,
        ownerId: string,
        keys: readonly string[],
        now: number,
        leaseDurationMs: number
    ): Promise<string[]> {
        if (keys.length === 0) return []
        assertNow(now)
        assertOwnerId(ownerId)
        if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
            throw new TypeError('Invalid Animation RUM v3 soft navigation lease duration')
        }
        const renewedUntil = now + leaseDurationMs
        if (!Number.isSafeInteger(renewedUntil)) throw new TypeError('Invalid Animation RUM v3 soft navigation lease expiry')

        const uniqueKeys = new Set<string>()
        for (const key of keys) {
            if (typeof key !== 'string' || key.length === 0 || uniqueKeys.has(key)) {
                throw new TypeError('Invalid Animation RUM v3 soft navigation lease renewal identity')
            }
            uniqueKeys.add(key)
        }

        const database = await this.getDatabase()
        const transaction = database.transaction(STORE_NAME, 'readwrite', { durability: 'strict' })
        const reports: AnimationRumV3QueuedReport[] = []
        for (const key of keys) {
            const report = await transaction.store.get(key)
            if (!report || !sameScope(report, scope) || report.state !== 'pending' || report.leaseOwner !== ownerId) {
                // Validate the complete ownership set before writing anything.
                // An expired lease may still be renewed when this owner has not
                // lost the atomic IndexedDB race to another tab.
                await transaction.done
                return []
            }
            reports.push(report)
        }

        for (const report of reports) {
            await transaction.store.put({
                ...report,
                leaseUntil: Math.max(report.leaseUntil, renewedUntil),
                updatedAt: now,
            })
        }
        await transaction.done
        return [...keys]
    }

    async settle(
        scope: AnimationRumV3DeliveryScope,
        ownerId: string,
        settlements: readonly AnimationRumV3Settlement[],
        now: number
    ): Promise<string[]> {
        if (settlements.length === 0) return []
        assertNow(now)
        assertOwnerId(ownerId)
        const settlementKeys = new Set<string>()
        for (const settlement of settlements) {
            if (typeof settlement.key !== 'string' || settlementKeys.has(settlement.key)) {
                throw new TypeError('Invalid Animation RUM v3 soft navigation settlement identity')
            }
            if (
                (settlement.state === 'confirmed' && settlement.terminalReason !== null) ||
                (settlement.state === 'terminal' && !TERMINAL_REASONS.has(settlement.terminalReason ?? '')) ||
                (settlement.state !== 'confirmed' && settlement.state !== 'terminal')
            ) {
                throw new TypeError('Invalid Animation RUM v3 soft navigation settlement state')
            }
            settlementKeys.add(settlement.key)
        }
        const database = await this.getDatabase()
        const transaction = database.transaction(STORE_NAME, 'readwrite', { durability: 'strict' })
        const allReports = await transaction.store.getAll()
        const byKey = new Map(allReports.map(report => [report.key, report] as const))
        const applied: string[] = []

        for (const settlement of settlements) {
            const report = byKey.get(settlement.key)
            if (!report || !sameScope(report, scope) || report.state !== 'pending' || report.leaseOwner !== ownerId) continue
            const terminalReason = settlement.state === 'terminal' ? settlement.terminalReason : null
            const updated: AnimationRumV3QueuedReport = {
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
        }
        await transaction.done
        return applied
    }

    async reschedule(
        scope: AnimationRumV3DeliveryScope,
        ownerId: string,
        updates: readonly AnimationRumV3RetryUpdate[],
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
                throw new TypeError('Invalid Animation RUM v3 soft navigation retry update')
            }
            updateKeys.add(update.key)
        }
        const database = await this.getDatabase()
        const transaction = database.transaction(STORE_NAME, 'readwrite', { durability: 'strict' })
        const pendingUpdates: Array<{ report: AnimationRumV3QueuedReport; update: AnimationRumV3RetryUpdate }> = []
        for (const update of updates) {
            const report = await transaction.store.get(update.key)
            if (!report || !sameScope(report, scope) || report.state !== 'pending' || report.leaseOwner !== ownerId) continue
            if (update.attemptCount !== report.attemptCount + 1)
                throw new TypeError('Invalid Animation RUM v3 soft navigation retry update')
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

    async releaseLeases(scope: AnimationRumV3DeliveryScope, ownerId: string, now: number): Promise<void> {
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

    private getDatabase(): Promise<IDBPDatabase<AnimationRumV3DeliveryDatabase>> {
        if (this.databasePromise === null) {
            let databasePromise!: Promise<IDBPDatabase<AnimationRumV3DeliveryDatabase>>
            databasePromise = openDB<AnimationRumV3DeliveryDatabase>(DATABASE_NAME, DATABASE_VERSION, {
                upgrade(database) {
                    const store = database.createObjectStore(STORE_NAME, { keyPath: 'key' })
                    store.createIndex('by-created-at', 'createdAt')
                },
            }).catch(error => {
                if (this.databasePromise === databasePromise) this.databasePromise = null
                throw error
            })
            this.databasePromise = databasePromise
        }
        return this.databasePromise
    }
}
