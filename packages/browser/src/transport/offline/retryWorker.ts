import type { TransportGateway } from '../gateway'
import type { RetryRecord, RetryScope, ScopedRetryStore, TransportConfig } from '../types'

const RETRY_POLL_INTERVAL_MS = 60_000
const BATCH_DELAY_MS = 500
const LEASE_DURATION_MS = 30_000

export class RetryWorker {
    private timerId: ReturnType<typeof setInterval> | null = null
    private running = false

    constructor(
        private store: ScopedRetryStore<RetryRecord>,
        private gateway: TransportGateway,
        private cfg: Required<TransportConfig>,
        private scope: RetryScope
    ) {}

    start(): void {
        if (this.timerId !== null) return
        this.timerId = setInterval(() => this.runScheduled('interval'), RETRY_POLL_INTERVAL_MS)
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
            await this.store.prune(this.scope, this.cfg.storeMaxItems, this.cfg.storeMaxAgeMs)
            const leasedRecords = await this.store.getReadyAndLease(this.scope, 10, LEASE_DURATION_MS)
            // Keep a second fail-closed guard at the delivery boundary. A stale
            // or custom Store implementation must not route another app/DSN's
            // telemetry through this worker's fixed gateway.
            const records = leasedRecords.filter(record => record.appId === this.scope.appId && record.target === this.scope.target)
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

    /** Fire-and-forget entrypoint for timers/lifecycle hooks. */
    runScheduled(reason: 'initial' | 'interval' | 'online' | 'visible' | 'verified'): void {
        void this.tryOnce().catch(error => {
            if (this.cfg.debug) console.debug(`[Transport] ${reason} offline retry deferred`, error)
        })
    }
}
