export type AnimationRumV2ReportScope = 'page' | 'target'

export type AnimationRumV2DeliveryState = 'pending' | 'confirmed' | 'terminal'

export type AnimationRumV2ServerDeliveryState = 'pending' | 'published' | 'persisted' | 'quarantined'

export interface AnimationRumV2DeliveryScope {
    appId: string
    /** Canonical DSN tracking endpoint. This is never derived from a page URL. */
    trackingUrl: string
    /** Stable storage partition for one app and one canonical tracking endpoint. */
    scopeKey: string
}

export interface AnimationRumV2QueuedReport {
    key: string
    scopeKey: string
    appId: string
    trackingUrl: string
    eventId: string
    captureId: string
    reportScope: AnimationRumV2ReportScope
    parentCaptureId: string | null
    /** Serialized exactly once before persistence and reused byte-for-byte on retries. */
    payloadJson: string
    payloadBytes: number
    createdAt: number
    updatedAt: number
    nextAttemptAt: number
    attemptCount: number
    state: AnimationRumV2DeliveryState
    parentConfirmed: boolean
    leaseOwner: string | null
    leaseUntil: number
    settledAt: number | null
    terminalReason: AnimationRumV2TerminalReason | null
}

export type AnimationRumV2TerminalReason =
    | 'http-400'
    | 'http-403'
    | 'http-409'
    | 'http-413'
    | 'retry-exhausted'
    | 'server-quarantined'
    | 'parent-terminal'

export interface AnimationRumV2PersistResult {
    reports: Array<{
        key: string
        eventId: string
        captureId: string
        state: AnimationRumV2DeliveryState
        duplicate: boolean
    }>
}

export interface AnimationRumV2PruneResult {
    expired: number
    excess: number
}

export interface AnimationRumV2RetryUpdate {
    key: string
    nextAttemptAt: number
    attemptCount: number
}

export interface AnimationRumV2Settlement {
    key: string
    state: Exclude<AnimationRumV2DeliveryState, 'pending'>
    terminalReason: AnimationRumV2TerminalReason | null
}

export interface AnimationRumV2DeliveryStore {
    persist(
        scope: AnimationRumV2DeliveryScope,
        reports: readonly AnimationRumV2QueuedReport[],
        limits: { maxItems: number; maxAgeMs: number },
        now: number
    ): Promise<AnimationRumV2PersistResult>
    prune(
        scope: AnimationRumV2DeliveryScope,
        limits: { maxItems: number; maxAgeMs: number },
        now: number
    ): Promise<AnimationRumV2PruneResult>
    leaseReady(
        scope: AnimationRumV2DeliveryScope,
        ownerId: string,
        now: number,
        limit: number,
        leaseDurationMs: number,
        maxBatchBytes: number
    ): Promise<AnimationRumV2QueuedReport[]>
    /** Extends every requested lease atomically, or returns no keys and changes none of them. */
    renewLeases(
        scope: AnimationRumV2DeliveryScope,
        ownerId: string,
        keys: readonly string[],
        now: number,
        leaseDurationMs: number
    ): Promise<string[]>
    settle(
        scope: AnimationRumV2DeliveryScope,
        ownerId: string,
        settlements: readonly AnimationRumV2Settlement[],
        now: number
    ): Promise<string[]>
    reschedule(
        scope: AnimationRumV2DeliveryScope,
        ownerId: string,
        updates: readonly AnimationRumV2RetryUpdate[],
        now: number
    ): Promise<string[]>
    releaseLeases(scope: AnimationRumV2DeliveryScope, ownerId: string, now: number): Promise<void>
    /**
     * Close an already-open storage connection without deleting durable work.
     * Implementations must be safe to use again after close().
     */
    close?(): void | Promise<void>
}

export interface AnimationRumV2AdmissionReceipt {
    eventId: string
    captureId: string
    receivedAt: string
    deliveryState: AnimationRumV2ServerDeliveryState
    duplicate: boolean
}

export type AnimationRumV2SendResult =
    | {
          kind: 'settled'
          settlements: AnimationRumV2Settlement[]
          receipts: AnimationRumV2AdmissionReceipt[]
      }
    | {
          kind: 'terminal'
          reason: Extract<AnimationRumV2TerminalReason, `http-${number}`>
      }
    | {
          kind: 'retry'
          retryAfterMs?: number
      }

export interface AnimationRumV2DeliverySender {
    send(scope: AnimationRumV2DeliveryScope, reports: readonly AnimationRumV2QueuedReport[]): Promise<AnimationRumV2SendResult>
}

export interface AnimationRumV2Clock {
    now(): number
}

export interface AnimationRumV2TimerApi {
    setInterval(callback: () => void, intervalMs: number): unknown
    clearInterval(timer: unknown): void
}

export interface AnimationRumV2TimeoutApi {
    setTimeout(callback: () => void, timeoutMs: number): unknown
    clearTimeout(timer: unknown): void
}

export interface AnimationRumV2DeliveryConfig {
    batchSize?: number
    leaseDurationMs?: number
    requestTimeoutMs?: number
    pollIntervalMs?: number
    retryBaseDelayMs?: number
    retryBackoff?: number
    retryMaxDelayMs?: number
    retryMaxAttempts?: number
    storeMaxItems?: number
    storeMaxAgeMs?: number
    debug?: boolean
}

export interface AnimationRumV2DeliveryOptions {
    appId: string
    trackingUrl: string
    store?: AnimationRumV2DeliveryStore
    sender?: AnimationRumV2DeliverySender
    clock?: AnimationRumV2Clock
    timers?: AnimationRumV2TimerApi
    ownerId?: string
    config?: AnimationRumV2DeliveryConfig
}

export interface AnimationRumV2AttemptResult {
    attempted: number
    confirmed: number
    terminal: number
    retried: number
}
