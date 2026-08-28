export type AnimationRumV3DeliveryState = 'pending' | 'confirmed' | 'terminal'

export type AnimationRumV3ServerDeliveryState = 'pending' | 'published' | 'persisted' | 'quarantined'

export interface AnimationRumV3DeliveryScope {
    appId: string
    /** Canonical DSN tracking endpoint. This is never derived from a page URL. */
    trackingUrl: string
    /** Stable storage partition for one app and one canonical tracking endpoint. */
    scopeKey: string
}

export interface AnimationRumV3QueuedReport {
    key: string
    scopeKey: string
    appId: string
    trackingUrl: string
    eventId: string
    captureId: string
    /** Serialized exactly once before persistence and reused byte-for-byte on retries. */
    payloadJson: string
    payloadBytes: number
    createdAt: number
    updatedAt: number
    nextAttemptAt: number
    attemptCount: number
    state: AnimationRumV3DeliveryState
    leaseOwner: string | null
    leaseUntil: number
    settledAt: number | null
    terminalReason: AnimationRumV3TerminalReason | null
}

export type AnimationRumV3TerminalReason = 'http-400' | 'http-403' | 'http-409' | 'http-413' | 'retry-exhausted' | 'server-quarantined'

export interface AnimationRumV3PersistResult {
    reports: Array<{
        key: string
        eventId: string
        captureId: string
        state: AnimationRumV3DeliveryState
        duplicate: boolean
    }>
}

export interface AnimationRumV3PruneResult {
    expired: number
    excess: number
}

export interface AnimationRumV3RetryUpdate {
    key: string
    nextAttemptAt: number
    attemptCount: number
}

export interface AnimationRumV3Settlement {
    key: string
    state: Exclude<AnimationRumV3DeliveryState, 'pending'>
    terminalReason: AnimationRumV3TerminalReason | null
}

export interface AnimationRumV3DeliveryStore {
    persist(
        scope: AnimationRumV3DeliveryScope,
        reports: readonly AnimationRumV3QueuedReport[],
        limits: { maxItems: number; maxAgeMs: number },
        now: number
    ): Promise<AnimationRumV3PersistResult>
    prune(
        scope: AnimationRumV3DeliveryScope,
        limits: { maxItems: number; maxAgeMs: number },
        now: number
    ): Promise<AnimationRumV3PruneResult>
    leaseReady(
        scope: AnimationRumV3DeliveryScope,
        ownerId: string,
        now: number,
        limit: number,
        leaseDurationMs: number,
        maxBatchBytes: number
    ): Promise<AnimationRumV3QueuedReport[]>
    /** Extends every requested lease atomically, or returns no keys and changes none of them. */
    renewLeases(
        scope: AnimationRumV3DeliveryScope,
        ownerId: string,
        keys: readonly string[],
        now: number,
        leaseDurationMs: number
    ): Promise<string[]>
    settle(
        scope: AnimationRumV3DeliveryScope,
        ownerId: string,
        settlements: readonly AnimationRumV3Settlement[],
        now: number
    ): Promise<string[]>
    reschedule(
        scope: AnimationRumV3DeliveryScope,
        ownerId: string,
        updates: readonly AnimationRumV3RetryUpdate[],
        now: number
    ): Promise<string[]>
    releaseLeases(scope: AnimationRumV3DeliveryScope, ownerId: string, now: number): Promise<void>
    /**
     * Close an already-open storage connection without deleting durable work.
     * Implementations must be safe to use again after close().
     */
    close?(): void | Promise<void>
}

export interface AnimationRumV3AdmissionReceipt {
    eventId: string
    captureId: string
    receivedAt: string
    deliveryState: AnimationRumV3ServerDeliveryState
    duplicate: boolean
}

export type AnimationRumV3SendResult =
    | {
          kind: 'settled'
          settlements: AnimationRumV3Settlement[]
          receipts: AnimationRumV3AdmissionReceipt[]
      }
    | {
          kind: 'terminal'
          reason: Extract<AnimationRumV3TerminalReason, `http-${number}`>
      }
    | {
          kind: 'retry'
          retryAfterMs?: number
      }

export interface AnimationRumV3DeliverySender {
    send(scope: AnimationRumV3DeliveryScope, reports: readonly AnimationRumV3QueuedReport[]): Promise<AnimationRumV3SendResult>
}

export interface AnimationRumV3Clock {
    now(): number
}

export interface AnimationRumV3TimerApi {
    setInterval(callback: () => void, intervalMs: number): unknown
    clearInterval(timer: unknown): void
}

export interface AnimationRumV3TimeoutApi {
    setTimeout(callback: () => void, timeoutMs: number): unknown
    clearTimeout(timer: unknown): void
}

export interface AnimationRumV3DeliveryConfig {
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

export interface AnimationRumV3DeliveryOptions {
    appId: string
    trackingUrl: string
    store?: AnimationRumV3DeliveryStore
    sender?: AnimationRumV3DeliverySender
    clock?: AnimationRumV3Clock
    timers?: AnimationRumV3TimerApi
    ownerId?: string
    config?: AnimationRumV3DeliveryConfig
}

export interface AnimationRumV3AttemptResult {
    attempted: number
    confirmed: number
    terminal: number
    retried: number
}
