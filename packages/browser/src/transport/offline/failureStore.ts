import { openDB } from 'idb'
import type { IDBPDatabase } from 'idb'

import type { RetryRecord, RetryScope, ScopedRetryStore } from '../types'

const DB_NAME = 'condev-monitor-transport'
const STORE_NAME = 'retry-queue'

function belongsToScope(record: RetryRecord, scope: RetryScope): boolean {
    return record.appId === scope.appId && record.target === scope.target
}

function canAdoptLegacyRecord(record: RetryRecord, scope: RetryScope): boolean {
    return (
        record.target === undefined &&
        record.appId === scope.appId &&
        Array.isArray(record.payload) &&
        record.payload.every(envelope => envelope.appId === scope.appId)
    )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getDB(): Promise<IDBPDatabase<any>> {
    return openDB(DB_NAME, 1, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        upgrade(db: IDBPDatabase<any>) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
            store.createIndex('nextRetryAt', 'nextRetryAt')
            store.createIndex('createdAt', 'createdAt')
        },
    })
}

export class FailureStore implements ScopedRetryStore<RetryRecord> {
    async put(record: RetryRecord): Promise<void> {
        const db = await getDB()
        await db.put(STORE_NAME, record)
    }

    /**
     * Atomically fetch ready records and stamp a lease on them in a single
     * readwrite transaction, preventing concurrent workers (e.g. multiple tabs)
     * from picking up the same batch.
     */
    async getReadyAndLease(scope: RetryScope, limit: number, leaseDurationMs: number): Promise<RetryRecord[]> {
        const db = await getDB()
        const now = Date.now()
        const leaseUntil = now + leaseDurationMs
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const index = tx.store.index('nextRetryAt')
        const results: RetryRecord[] = []

        for await (const cursor of index.iterate(IDBKeyRange.upperBound(now))) {
            const record = cursor.value as RetryRecord
            let scopedRecord = record
            if (!belongsToScope(record, scope)) {
                if (!canAdoptLegacyRecord(record, scope)) continue
                // v1 records did not persist a target. Preserve their original
                // retry behavior only when both the record and every envelope
                // belong to the currently initialized app, then persist the
                // chosen target before delivery.
                scopedRecord = { ...record, target: scope.target }
            }
            if (record.leaseUntil >= now) continue
            await cursor.update({ ...scopedRecord, leaseUntil })
            results.push(scopedRecord)
            if (results.length >= limit) break
        }

        await tx.done
        return results
    }

    async delete(ids: string[]): Promise<void> {
        if (ids.length === 0) return
        const db = await getDB()
        const tx = db.transaction(STORE_NAME, 'readwrite')
        await Promise.all(ids.map(id => tx.store.delete(id)))
        await tx.done
    }

    async count(): Promise<number> {
        const db = await getDB()
        return db.count(STORE_NAME)
    }

    async prune(scope: RetryScope, maxItems: number, maxAgeMs: number): Promise<void> {
        const db = await getDB()
        const cutoff = Date.now() - maxAgeMs

        // Delete expired records only within this worker's exact target scope.
        const ageTx = db.transaction(STORE_NAME, 'readwrite')
        const ageIndex = ageTx.store.index('createdAt')
        for await (const cursor of ageIndex.iterate(IDBKeyRange.upperBound(cutoff))) {
            const record = cursor.value as RetryRecord
            // Old unscoped records used to participate in global age pruning;
            // continue removing them so an app that is never initialized again
            // cannot leave permanent IndexedDB residue.
            if (record.target === undefined || belongsToScope(record, scope)) await cursor.delete()
        }
        await ageTx.done

        // Compute quota per target, retaining the index's oldest-first order.
        // Same-app v1 records are claimed into the current scope as part of the
        // same transaction before quota is applied.
        const countTx = db.transaction(STORE_NAME, 'readwrite')
        const countIndex = countTx.store.index('createdAt')
        const scopedIds: string[] = []
        for await (const cursor of countIndex.iterate()) {
            const record = cursor.value as RetryRecord
            if (belongsToScope(record, scope)) {
                scopedIds.push(record.id)
            } else if (canAdoptLegacyRecord(record, scope)) {
                await cursor.update({ ...record, target: scope.target })
                scopedIds.push(record.id)
            }
        }
        await countTx.done

        const excess = scopedIds.length - maxItems
        if (excess <= 0) return
        const excessTx = db.transaction(STORE_NAME, 'readwrite')
        await Promise.all(scopedIds.slice(0, excess).map(id => excessTx.store.delete(id)))
        await excessTx.done
    }
}
