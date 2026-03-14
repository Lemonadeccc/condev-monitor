// ---- Event classification ----

export type EventCategory = 'error' | 'performance' | 'custom' | 'webvital' | 'ai_streaming'
export type EventPriority = 'immediate' | 'batch'

// ---- Flush trigger reasons ----

export type FlushReason = 'immediate' | 'threshold' | 'timer' | 'visibilitychange' | 'pagehide' | 'manual'

// ---- Core envelope ----

export interface ReportEnvelope {
    eventId: string
    appId: string
    clientCreatedAt: number
    category: EventCategory
    priority: EventPriority
    payload: Record<string, unknown>
    retryCount: number
}

// ---- Offline retry record ----

export interface RetryRecord {
    id: string
    appId: string
    createdAt: number
    nextRetryAt: number
    retryCount: number
    leaseUntil: number
    payload: ReportEnvelope[]
}

// ---- Abstract interfaces (upgrade-friendly) ----

export interface Sender {
    send(payload: string, options?: { keepalive?: boolean }): Promise<SendResult>
}

export interface Store<T> {
    put(item: T): Promise<void>
    getReadyAndLease(limit: number, leaseDurationMs: number): Promise<T[]>
    delete(ids: string[]): Promise<void>
    count(): Promise<number>
    prune(maxItems: number, maxAgeMs: number): Promise<void>
}

export interface IScheduler {
    onEnqueue(envelope: ReportEnvelope): void
    flush(reason: FlushReason): Promise<void>
    destroy(): void
}

// ---- Send result ----

export type SendResult = { ok: true } | { ok: false; retryable: boolean; retryAfterMs?: number }

// ---- Transport configuration ----

export interface TransportConfig {
    /** Max batch queue size before auto-flush. Default: 10 */
    queueMax?: number
    /** Batch flush interval in ms. Default: 5000 */
    queueWaitMs?: number
    /** Max payload bytes for sendBeacon channel. Default: 60000 */
    beaconMaxBytes?: number
    /** Max retry attempts for a failed batch. Default: 3 */
    retryMaxCount?: number
    /** Base delay in ms for exponential backoff. Default: 1000 */
    retryBaseDelayMs?: number
    /** Backoff multiplier. Default: 2 */
    retryBackoff?: number
    /** Max items stored in IndexedDB. Default: 200 */
    storeMaxItems?: number
    /** Max age in ms for stored items. Default: 86400000 (24h) */
    storeMaxAgeMs?: number
    /** Enable IndexedDB offline persistence. Default: true */
    enableOffline?: boolean
    /** Enable debug logging. Default: false */
    debug?: boolean
}

export const DEFAULT_TRANSPORT_CONFIG: Required<TransportConfig> = {
    queueMax: 10,
    queueWaitMs: 5000,
    beaconMaxBytes: 60_000,
    retryMaxCount: 3,
    retryBaseDelayMs: 1000,
    retryBackoff: 2,
    storeMaxItems: 200,
    storeMaxAgeMs: 24 * 60 * 60 * 1000,
    enableOffline: true,
    debug: false,
}
