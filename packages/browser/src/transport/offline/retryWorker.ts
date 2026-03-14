import type { TransportGateway } from '../gateway'
import type { RetryRecord, Store, TransportConfig } from '../types'

const RETRY_POLL_INTERVAL_MS = 60_000
const BATCH_DELAY_MS = 500
const LEASE_DURATION_MS = 30_000

export class RetryWorker {
    private timerId: ReturnType<typeof setInterval> | null = null
    private running = false

    constructor(
        private store: Store<RetryRecord>,
        private gateway: TransportGateway,
        private cfg: Required<TransportConfig>
    ) {}

    start(): void {
        if (this.timerId !== null) return
        this.timerId = setInterval(() => void this.tryOnce(), RETRY_POLL_INTERVAL_MS)
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
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return

        this.running = true
        try {
            await this.store.prune(this.cfg.storeMaxItems, this.cfg.storeMaxAgeMs)
            const records = await this.store.getReadyAndLease(10, LEASE_DURATION_MS)
            if (records.length === 0) return

            for (const record of records) {
                const result = await this.gateway.send(record.payload, 'manual')

                if (result.ok) {
                    await this.store.delete([record.id])
                } else {
                    const newRetryCount = record.retryCount + 1
                    if (newRetryCount > this.cfg.retryMaxCount) {
                        await this.store.delete([record.id])
                        continue
                    }
                    const delay = this.cfg.retryBaseDelayMs * Math.pow(this.cfg.retryBackoff, newRetryCount)
                    await this.store.put({
                        ...record,
                        retryCount: newRetryCount,
                        nextRetryAt: Date.now() + delay,
                        leaseUntil: 0,
                    })
                    break // stop on first failure to avoid hammering the backend
                }

                if (BATCH_DELAY_MS > 0) {
                    await new Promise<void>(resolve => setTimeout(resolve, BATCH_DELAY_MS))
                }
            }
        } finally {
            this.running = false
        }
    }
}
