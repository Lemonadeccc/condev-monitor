import type { FlushReason, IScheduler, ReportEnvelope, SendResult } from '../types'
import type { MemoryQueue } from '../queue/memoryQueue'
import type { TransportGateway } from '../gateway'

type FailureHandler = (batch: ReportEnvelope[]) => void

export class FlushScheduler implements IScheduler {
    private timerId: ReturnType<typeof setInterval> | null = null
    private flushing = false
    private flushedOnHide = false

    constructor(
        private queue: MemoryQueue,
        private gateway: TransportGateway,
        private onSendFailure: FailureHandler,
        private queueMax: number,
        private queueWaitMs: number,
        private debug = false
    ) {
        this.startTimer()
        this.bindLifecycle()
    }

    onEnqueue(envelope: ReportEnvelope): void {
        if (envelope.priority === 'immediate') {
            this.scheduleFlush('immediate')
        } else if (this.queue.batchSize() >= this.queueMax) {
            this.scheduleFlush('threshold')
        }
    }

    async flush(reason: FlushReason): Promise<void> {
        if (this.flushing) return
        // Skip flush when offline — data is preserved in queue and will be retried
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
            if (this.debug) console.debug('[Transport] Skipping flush: offline')
            return
        }
        this.flushing = true

        try {
            const batch = this.queue.drain(reason)
            if (batch.length === 0) return

            const result: SendResult = await this.gateway.send(batch, reason)
            if (!result.ok && result.retryable) {
                this.onSendFailure(batch)
            }
        } finally {
            this.flushing = false
        }
    }

    destroy(): void {
        if (this.timerId !== null) {
            clearInterval(this.timerId)
            this.timerId = null
        }
        this.unbindLifecycle()
    }

    // ---- Private ----

    private scheduleFlush(reason: FlushReason): void {
        if (reason === 'immediate') {
            void this.flush('immediate')
            return
        }

        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(() => void this.flush(reason))
        } else {
            setTimeout(() => void this.flush(reason), 0)
        }
    }

    private startTimer(): void {
        this.timerId = setInterval(() => {
            if (this.queue.batchSize() > 0) {
                this.scheduleFlush('timer')
            }
        }, this.queueWaitMs)
    }

    // ---- Lifecycle events ----

    private handleVisibilityChange = (): void => {
        if (document.visibilityState === 'hidden') {
            this.flushedOnHide = true
            void this.flush('visibilitychange')
        } else {
            this.flushedOnHide = false
        }
    }

    private handlePageHide = (): void => {
        // Deduplicate with visibilitychange if already flushed
        if (!this.flushedOnHide) {
            void this.flush('pagehide')
        }
    }

    private bindLifecycle(): void {
        document.addEventListener('visibilitychange', this.handleVisibilityChange)
        window.addEventListener('pagehide', this.handlePageHide)
    }

    private unbindLifecycle(): void {
        document.removeEventListener('visibilitychange', this.handleVisibilityChange)
        window.removeEventListener('pagehide', this.handlePageHide)
    }
}
