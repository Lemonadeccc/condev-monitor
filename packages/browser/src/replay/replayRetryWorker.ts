import { ReplayStore } from './replayStore'
import type { ReplayStoreRecord } from './replayStore'

const POLL_INTERVAL = 60_000
const LEASE_DURATION = 30_000
const MAX_RETRY = 3
const BASE_DELAY = 1_000
const BACKOFF = 2
const MAX_ITEMS = 20
const MAX_AGE = 24 * 60 * 60 * 1000

function parseRetryAfter(header: string | null): number | undefined {
    if (!header) return undefined
    if (/^\d+$/.test(header)) return parseInt(header, 10) * 1000
    const date = Date.parse(header)
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

export class ReplayRetryWorker {
    private timerId: ReturnType<typeof setInterval> | null = null
    private running = false

    constructor(private store: ReplayStore) {}

    start(): void {
        if (this.timerId !== null) return
        this.timerId = setInterval(() => void this.tryOnce(), POLL_INTERVAL)
    }

    stop(): void {
        if (this.timerId !== null) {
            clearInterval(this.timerId)
            this.timerId = null
        }
    }

    async tryOnce(): Promise<void> {
        if (this.running) return
        if (typeof navigator !== 'undefined' && !navigator.onLine) return

        this.running = true
        try {
            await this.store.prune(MAX_ITEMS, MAX_AGE)
            const records = await this.store.getReadyAndLease(5, LEASE_DURATION)
            if (records.length === 0) return

            for (const record of records) {
                const result = await this.send(record)

                if (result.ok) {
                    await this.store.delete([record.id])
                    continue
                }

                if (result.retryable && record.retryCount < MAX_RETRY) {
                    const delay = result.retryAfterMs ?? BASE_DELAY * Math.pow(BACKOFF, record.retryCount)
                    await this.store.put({
                        ...record,
                        retryCount: record.retryCount + 1,
                        nextRetryAt: Date.now() + delay,
                        leaseUntil: 0,
                    })
                    break
                }

                await this.store.delete([record.id])
            }
        } finally {
            this.running = false
        }
    }

    private shouldRetry(status: number): boolean {
        if (status === 408 || status === 429) return true
        return status >= 500 && status <= 599
    }

    private async send(record: ReplayStoreRecord): Promise<{ ok: boolean; retryable: boolean; retryAfterMs?: number }> {
        try {
            const res = await fetch(record.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: record.body,
            })
            if (res.ok) return { ok: true, retryable: false }
            const retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'))
            return { ok: false, retryable: this.shouldRetry(res.status), retryAfterMs }
        } catch {
            return { ok: false, retryable: true }
        }
    }
}
