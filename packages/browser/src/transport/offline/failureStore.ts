import { openDB } from 'idb'
import type { IDBPDatabase } from 'idb'

import type { RetryRecord, Store } from '../types'

const DB_NAME = 'condev-monitor-transport'
const STORE_NAME = 'retry-queue'

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

export class FailureStore implements Store<RetryRecord> {
    async put(record: RetryRecord): Promise<void> {
        const db = await getDB()
        await db.put(STORE_NAME, record)
    }

    /**
     * Atomically fetch ready records and stamp a lease on them in a single
     * readwrite transaction, preventing concurrent workers (e.g. multiple tabs)
     * from picking up the same batch.
     */
    async getReadyAndLease(limit: number, leaseDurationMs: number): Promise<RetryRecord[]> {
        const db = await getDB()
        const now = Date.now()
        const leaseUntil = now + leaseDurationMs
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const index = tx.store.index('nextRetryAt')
        const results: RetryRecord[] = []

        for await (const cursor of index.iterate(IDBKeyRange.upperBound(now))) {
            const record = cursor.value as RetryRecord
            if (record.leaseUntil >= now) continue
            await cursor.update({ ...record, leaseUntil })
            results.push(record)
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

    async prune(maxItems: number, maxAgeMs: number): Promise<void> {
        const db = await getDB()
        const cutoff = Date.now() - maxAgeMs

        // Delete by age
        const ageTx = db.transaction(STORE_NAME, 'readwrite')
        const ageIndex = ageTx.store.index('createdAt')
        for await (const cursor of ageIndex.iterate(IDBKeyRange.upperBound(cutoff))) {
            await cursor.delete()
        }
        await ageTx.done

        // Delete excess items (oldest first)
        const total = await db.count(STORE_NAME)
        if (total <= maxItems) return

        const excess = total - maxItems
        const excessTx = db.transaction(STORE_NAME, 'readwrite')
        const excessIndex = excessTx.store.index('createdAt')
        let deleted = 0
        for await (const cursor of excessIndex.iterate()) {
            if (deleted >= excess) break
            await cursor.delete()
            deleted++
        }
        await excessTx.done
    }
}
