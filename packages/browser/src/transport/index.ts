import type { Transport } from '@condev-monitor/monitor-sdk-core'

import { createEnvelope, enrichPayload, parseDsn } from './envelope'
import { TransportGateway } from './gateway'
import { MemoryQueue } from './queue/memoryQueue'
import { FlushScheduler } from './scheduler/flushScheduler'
import type { FlushReason, ReportEnvelope, TransportConfig } from './types'
import { DEFAULT_TRANSPORT_CONFIG } from './types'

export class BrowserTransport implements Transport {
    private readonly appId: string
    private readonly trackingUrl: string
    private readonly queue: MemoryQueue
    private readonly scheduler: FlushScheduler
    private readonly gateway: TransportGateway
    private readonly cfg: Required<TransportConfig>
    private readonly interceptors: ((data: Record<string, unknown>) => Record<string, unknown>)[] = []
    private offlineWorker: { stop(): void } | null = null
    private offlineNetMgr: { stop(): void } | null = null
    private _destroyed = false

    constructor(
        dsn: string,
        private readonly context?: { release?: string; dist?: string },
        config?: TransportConfig
    ) {
        this.cfg = { ...DEFAULT_TRANSPORT_CONFIG, ...config }

        const parsed = parseDsn(dsn)
        this.appId = parsed?.appId ?? 'unknown'
        this.trackingUrl = parsed ? `${parsed.origin}${parsed.basePath}/tracking/${parsed.appId}` : dsn

        this.gateway = new TransportGateway(this.trackingUrl, this.cfg.beaconMaxBytes, this.cfg.debug)
        this.queue = new MemoryQueue(this.cfg.debug)
        this.scheduler = new FlushScheduler(
            this.queue,
            this.gateway,
            failed => {
                void this.handleSendFailure(failed)
            },
            this.cfg.queueMax,
            this.cfg.queueWaitMs,
            this.cfg.debug
        )

        if (this.cfg.enableOffline) {
            void this.initOffline()
        }
    }

    // ---- Transport interface ----

    send(data: Record<string, unknown>): void {
        let processed = data
        for (const fn of this.interceptors) processed = fn(processed)
        const enriched = enrichPayload(processed, this.context)
        const envelope = createEnvelope(enriched, this.appId)
        this.queue.enqueue(envelope)
        this.scheduler.onEnqueue(envelope)
    }

    // ---- Extended API ----

    /** Register a pre-enqueue interceptor (used by Replay integration). */
    addBeforeEnqueue(fn: (data: Record<string, unknown>) => Record<string, unknown>): void {
        this.interceptors.push(fn)
    }

    async flush(reason?: FlushReason): Promise<void> {
        return this.scheduler.flush(reason ?? 'manual')
    }

    destroy(): void {
        this._destroyed = true
        this.scheduler.destroy()
        this.offlineNetMgr?.stop()
        this.offlineWorker?.stop()
        this.offlineNetMgr = null
        this.offlineWorker = null
    }

    // ---- Private ----

    private async handleSendFailure(failed: ReportEnvelope[]): Promise<void> {
        if (!this.cfg.enableOffline) return
        try {
            const { FailureStore } = await import('./offline/failureStore')
            const store = new FailureStore()
            await store.put({
                id: `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                appId: this.appId,
                createdAt: Date.now(),
                nextRetryAt: Date.now() + this.cfg.retryBaseDelayMs,
                retryCount: 0,
                leaseUntil: 0,
                payload: failed.map(e => ({ ...e, retryCount: e.retryCount + 1 })),
            })
        } catch {
            // IndexedDB unavailable — silently discard
        }
    }

    private async initOffline(): Promise<void> {
        try {
            const [{ FailureStore }, { RetryWorker }, { NetworkManager }] = await Promise.all([
                import('./offline/failureStore'),
                import('./offline/retryWorker'),
                import('./offline/networkManager'),
            ])
            const store = new FailureStore()
            const worker = new RetryWorker(store, this.gateway, this.cfg)
            const netMgr = new NetworkManager(this.trackingUrl, worker, this.cfg.debug)
            this.offlineWorker = worker
            this.offlineNetMgr = netMgr
            if (this._destroyed) {
                worker.stop()
                netMgr.stop()
                return
            }
            void worker.tryOnce()
            netMgr.start()
        } catch {
            // Offline modules unavailable
        }
    }
}
