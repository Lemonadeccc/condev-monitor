import { subscribePageLifecycle, type PageLifecycleEvent } from '@condev-monitor/monitor-sdk-browser-utils/performance-runtime'

import type { FlushReason, IScheduler, ReportEnvelope, SendResult } from '../types'
import type { MemoryQueue } from '../queue/memoryQueue'
import type { TransportGateway } from '../gateway'

type FailureHandler = (batch: ReportEnvelope[]) => boolean | Promise<boolean>

export class FlushScheduler implements IScheduler {
    private timerId: ReturnType<typeof setInterval> | null = null
    /** Always-settled tail used as a mutex for every explicit and scheduled flush. */
    private flushTail: Promise<void> = Promise.resolve()
    private flushedOnHide = false
    private destroyed = false
    private unsubscribeLifecycle: (() => void) | null = null

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

    flush(reason: FlushReason): Promise<void> {
        if (this.destroyed) return Promise.resolve()

        const flushPromise = this.flushTail.then(() => {
            if (this.destroyed) return
            return this.flushOnce(reason)
        })
        // Keep the mutex usable after a failed send/persist attempt while
        // returning the original rejecting promise to explicit callers.
        this.flushTail = flushPromise.catch(() => undefined)
        return flushPromise
    }

    private async flushOnce(reason: FlushReason): Promise<void> {
        const batch = this.queue.drain(reason)
        if (batch.length === 0) return

        if (typeof navigator !== 'undefined' && !navigator.onLine) {
            if (this.debug) console.debug('[Transport] Persisting offline batch')
            await this.persistOrRestore(batch)
            return
        }

        const result: SendResult = await this.gateway.send(batch, reason)
        if (!result.ok && result.retryable) {
            await this.persistOrRestore(batch)
        }
    }

    private async persistOrRestore(batch: ReportEnvelope[]): Promise<void> {
        let persisted = false
        try {
            persisted = await this.onSendFailure(batch)
        } catch {
            // Persistence is best-effort; restore below so an active page can retry.
        }
        if (!persisted) {
            this.queue.restore(batch)
            throw new Error('[Transport] Batch was not sent or persisted; restored in memory for retry')
        }
    }

    destroy(): void {
        if (this.destroyed) return
        this.destroyed = true
        if (this.timerId !== null) {
            clearInterval(this.timerId)
            this.timerId = null
        }
        this.unbindLifecycle()
    }

    // ---- Private ----

    private scheduleFlush(reason: FlushReason): void {
        if (this.destroyed) return
        if (reason === 'immediate') {
            this.runScheduledFlush('immediate')
            return
        }

        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(() => this.runScheduledFlush(reason))
        } else {
            setTimeout(() => this.runScheduledFlush(reason), 0)
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

    private handleLifecycle = (event: PageLifecycleEvent): void => {
        if (event.type === 'hidden') {
            this.flushedOnHide = true
            this.scheduleLifecycleFlush('visibilitychange')
        } else if (event.type === 'visible' || event.type === 'pageshow') {
            this.flushedOnHide = false
        } else if (event.type === 'pagehide' && !this.flushedOnHide) {
            this.scheduleLifecycleFlush('pagehide')
        }
    }

    private bindLifecycle(): void {
        // Run after collectors and defer the drain to a microtask so any legacy
        // visibility listeners can finalize and enqueue before transport flushes.
        this.unsubscribeLifecycle = subscribePageLifecycle(this.handleLifecycle, { priority: -100 })
    }

    private unbindLifecycle(): void {
        this.unsubscribeLifecycle?.()
        this.unsubscribeLifecycle = null
    }

    private scheduleLifecycleFlush(reason: 'visibilitychange' | 'pagehide'): void {
        Promise.resolve().then(() => {
            if (!this.destroyed) this.runScheduledFlush(reason)
        })
    }

    private runScheduledFlush(reason: FlushReason): void {
        void this.flush(reason).catch(error => {
            if (this.debug) console.debug('[Transport] Scheduled flush deferred for retry', error)
        })
    }
}
