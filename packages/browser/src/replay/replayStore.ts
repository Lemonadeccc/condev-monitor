import { openDB } from 'idb'
import type { IDBPDatabase } from 'idb'

export type ReplayStoreRecord = {
    id: string
    url: string
    body: string
    createdAt: number
    nextRetryAt: number
    retryCount: number
    leaseUntil: number
}

const DB_NAME = 'condev-monitor-replay'
const STORE_NAME = 'replay-queue'

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

export class ReplayStore {
    async put(record: ReplayStoreRecord): Promise<void> {
        const db = await getDB()
        await db.put(STORE_NAME, record)
    }

    /**
     * Atomically fetch ready records and stamp a lease on them in a single
     * readwrite transaction, preventing concurrent workers (e.g. multiple tabs)
     * from picking up the same batch.
     */
    async getReadyAndLease(limit: number, leaseDurationMs: number): Promise<ReplayStoreRecord[]> {
        const db = await getDB()
        const now = Date.now()
        const leaseUntil = now + leaseDurationMs
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const index = tx.store.index('nextRetryAt')
        const results: ReplayStoreRecord[] = []

        for await (const cursor of index.iterate(IDBKeyRange.upperBound(now))) {
            const record = cursor.value as ReplayStoreRecord
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

        const ageTx = db.transaction(STORE_NAME, 'readwrite')
        const ageIndex = ageTx.store.index('createdAt')
        for await (const cursor of ageIndex.iterate(IDBKeyRange.upperBound(cutoff))) {
            await cursor.delete()
        }
        await ageTx.done

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
