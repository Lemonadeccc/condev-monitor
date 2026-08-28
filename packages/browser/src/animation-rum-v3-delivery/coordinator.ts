import { prepareAnimationRumV3QueuedReport } from './report'
import { createAnimationRumV3DeliveryScope } from './scope'
import { AnimationRumV3FetchSender } from './sender'
import { IndexedDbAnimationRumV3DeliveryStore } from './store'
import type {
    AnimationRumV3AttemptResult,
    AnimationRumV3Clock,
    AnimationRumV3DeliveryConfig,
    AnimationRumV3DeliveryOptions,
    AnimationRumV3DeliveryScope,
    AnimationRumV3DeliverySender,
    AnimationRumV3DeliveryStore,
    AnimationRumV3PersistResult,
    AnimationRumV3QueuedReport,
    AnimationRumV3SendResult,
    AnimationRumV3Settlement,
    AnimationRumV3TimerApi,
} from './types'

const DEFAULT_CONFIG: Required<AnimationRumV3DeliveryConfig> = {
    batchSize: 32,
    leaseDurationMs: 30_000,
    requestTimeoutMs: 15_000,
    pollIntervalMs: 60_000,
    retryBaseDelayMs: 1_000,
    retryBackoff: 2,
    retryMaxDelayMs: 5 * 60_000,
    retryMaxAttempts: 8,
    storeMaxItems: 200,
    storeMaxAgeMs: 24 * 60 * 60_000,
    debug: false,
}

const EMPTY_ATTEMPT: AnimationRumV3AttemptResult = { attempted: 0, confirmed: 0, terminal: 0, retried: 0 }
const MAX_KEEPALIVE_BODY_BYTES = 64 * 1024
const OWNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SERVER_DELIVERY_STATES = new Set(['pending', 'published', 'persisted', 'quarantined'])

interface RunningAnimationRumV3Attempt {
    generation: number
    promise: Promise<AnimationRumV3AttemptResult>
}

function positiveSafeInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid Animation RUM v3 soft navigation ${label}`)
    return value
}

function resolveConfig(input: AnimationRumV3DeliveryConfig | undefined): Required<AnimationRumV3DeliveryConfig> {
    const config = { ...DEFAULT_CONFIG, ...input }
    positiveSafeInteger(config.batchSize, 'batch size')
    if (config.batchSize > 64) throw new TypeError('Animation RUM v3 soft navigation batch size exceeds the server limit')
    positiveSafeInteger(config.leaseDurationMs, 'lease duration')
    positiveSafeInteger(config.requestTimeoutMs, 'request timeout')
    if (config.requestTimeoutMs >= config.leaseDurationMs) {
        throw new TypeError('Animation RUM v3 soft navigation request timeout must be shorter than its lease')
    }
    positiveSafeInteger(config.pollIntervalMs, 'poll interval')
    positiveSafeInteger(config.retryBaseDelayMs, 'retry base delay')
    if (!Number.isFinite(config.retryBackoff) || config.retryBackoff < 1 || config.retryBackoff > 16) {
        throw new TypeError('Invalid Animation RUM v3 soft navigation retry backoff')
    }
    positiveSafeInteger(config.retryMaxDelayMs, 'retry maximum delay')
    positiveSafeInteger(config.retryMaxAttempts, 'retry maximum attempts')
    positiveSafeInteger(config.storeMaxItems, 'store item limit')
    positiveSafeInteger(config.storeMaxAgeMs, 'store age limit')
    if (typeof config.debug !== 'boolean') throw new TypeError('Invalid Animation RUM v3 soft navigation debug option')
    return config
}

function defaultOwnerId(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') return `rum-v3-soft-nav-${globalThis.crypto.randomUUID()}`
    return `rum-v3-soft-nav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

function defaultTimers(): AnimationRumV3TimerApi {
    return {
        setInterval: (callback, intervalMs) => globalThis.setInterval(callback, intervalMs),
        clearInterval: timer => globalThis.clearInterval(timer as ReturnType<typeof setInterval>),
    }
}

function terminalSettlements(reports: readonly AnimationRumV3QueuedReport[], reason: AnimationRumV3Settlement['terminalReason']) {
    return reports.map(report => ({ key: report.key, state: 'terminal' as const, terminalReason: reason }))
}

function validateSettledResult(
    result: Extract<AnimationRumV3SendResult, { kind: 'settled' }>,
    reports: readonly AnimationRumV3QueuedReport[]
): boolean {
    if (!Array.isArray(result.settlements) || !Array.isArray(result.receipts)) return false
    if (result.settlements.length !== reports.length || result.receipts.length !== reports.length) return false
    const expected = new Set(reports.map(report => report.key))
    const seen = new Set<string>()
    const settlementByKey = new Map<string, AnimationRumV3Settlement>()
    for (const settlement of result.settlements) {
        if (settlement === null || typeof settlement !== 'object') return false
        if (!expected.has(settlement.key) || seen.has(settlement.key)) return false
        if (settlement.state === 'confirmed' && settlement.terminalReason !== null) return false
        if (settlement.state === 'terminal' && settlement.terminalReason !== 'server-quarantined') return false
        if (settlement.state !== 'confirmed' && settlement.state !== 'terminal') return false
        seen.add(settlement.key)
        settlementByKey.set(settlement.key, settlement)
    }
    if (seen.size !== expected.size) return false

    const reportByReceipt = new Map(reports.map(report => [JSON.stringify([report.eventId, report.captureId]), report] as const))
    const seenReceipts = new Set<string>()
    for (const receipt of result.receipts) {
        if (receipt === null || typeof receipt !== 'object') return false
        const key = JSON.stringify([receipt.eventId, receipt.captureId])
        const report = reportByReceipt.get(key)
        if (!report || seenReceipts.has(key) || typeof receipt.duplicate !== 'boolean') return false
        if (!SERVER_DELIVERY_STATES.has(receipt.deliveryState)) return false
        if (typeof receipt.receivedAt !== 'string') return false
        const receivedAtEpoch = Date.parse(receipt.receivedAt)
        if (!Number.isFinite(receivedAtEpoch) || new Date(receivedAtEpoch).toISOString() !== receipt.receivedAt) return false
        const settlement = settlementByKey.get(report.key)
        const expectedState = receipt.deliveryState === 'quarantined' ? 'terminal' : 'confirmed'
        if (settlement?.state !== expectedState) return false
        seenReceipts.add(key)
    }
    return seenReceipts.size === reports.length
}

function assertAppliedKeys(expectedReports: readonly AnimationRumV3QueuedReport[], appliedKeys: readonly string[]): void {
    const expected = new Set(expectedReports.map(report => report.key))
    const applied = new Set(appliedKeys)
    if (applied.size !== expected.size || [...applied].some(key => !expected.has(key))) {
        throw new Error('Animation RUM v3 soft navigation delivery lease changed before durable state was recorded')
    }
}

export class AnimationRumV3DeliveryCoordinator {
    readonly scope: AnimationRumV3DeliveryScope

    private readonly store: AnimationRumV3DeliveryStore
    private readonly sender: AnimationRumV3DeliverySender
    private readonly clock: AnimationRumV3Clock
    private readonly timers: AnimationRumV3TimerApi
    private readonly ownerId: string
    private readonly config: Required<AnimationRumV3DeliveryConfig>
    private persistenceQueue: Promise<void> = Promise.resolve()
    private readonly persistenceFailures = new Map<string, unknown>()
    private attemptGeneration = 0
    private runningAttempt: RunningAnimationRumV3Attempt | null = null
    private stopping: Promise<void> | null = null
    private suspending: Promise<void> | null = null
    private timer: unknown = null
    private suspended = false
    private lifecycleIntent: 'active' | 'suspended' = 'active'
    private stopped = false

    constructor(options: AnimationRumV3DeliveryOptions) {
        this.scope = createAnimationRumV3DeliveryScope(options.appId, options.trackingUrl)
        this.store = options.store ?? new IndexedDbAnimationRumV3DeliveryStore()
        this.clock = options.clock ?? { now: () => Date.now() }
        this.config = resolveConfig(options.config)
        this.sender = options.sender ?? new AnimationRumV3FetchSender({ clock: this.clock, requestTimeoutMs: this.config.requestTimeoutMs })
        this.timers = options.timers ?? defaultTimers()
        this.ownerId = options.ownerId ?? defaultOwnerId()
        if (!OWNER_ID_PATTERN.test(this.ownerId)) throw new TypeError('Invalid Animation RUM v3 soft navigation delivery owner id')
    }

    start(): void {
        if (this.stopped) throw new Error('Animation RUM v3 soft navigation delivery coordinator is stopped')
        if (this.suspended || this.suspending) {
            throw new Error('Animation RUM v3 soft navigation delivery coordinator is suspended; call resume()')
        }
        this.startPolling()
    }

    /**
     * Synchronously stops polling, then best-effort releases this tab's leases
     * and closes its storage connection. Durable reports remain in IndexedDB.
     */
    suspend(): Promise<void> {
        if (this.stopped) return this.stopping ?? Promise.resolve()
        this.lifecycleIntent = 'suspended'
        if (this.suspended) return this.suspending ?? Promise.resolve()

        this.suspended = true
        this.clearPolling()
        const suspending = this.finishSuspend()
        this.suspending = suspending
        void suspending.then(
            () => {
                if (this.suspending === suspending) this.suspending = null
            },
            () => {
                if (this.suspending === suspending) this.suspending = null
            }
        )
        return suspending
    }

    /** Reopens storage lazily and restarts polling after a BFCache restore. */
    async resume(): Promise<void> {
        if (this.stopped) return
        this.lifecycleIntent = 'active'
        const suspending = this.suspending
        if (suspending) await suspending
        if (this.stopped || this.lifecycleIntent !== 'active') return

        this.suspended = false
        this.startPolling()
    }

    private startPolling(): void {
        if (this.timer !== null) return
        this.timer = this.timers.setInterval(() => this.runScheduled(), this.config.pollIntervalMs)
        this.runScheduled()
    }

    persist(reports: readonly unknown[]): Promise<AnimationRumV3PersistResult> {
        if (this.stopped) return Promise.reject(new Error('Animation RUM v3 soft navigation delivery coordinator is stopped'))
        if (this.suspended) return Promise.reject(new Error('Animation RUM v3 soft navigation delivery coordinator is suspended'))
        const now = this.now()
        let prepared: AnimationRumV3QueuedReport[]
        try {
            prepared = reports.map(report => prepareAnimationRumV3QueuedReport(this.scope, report, now))
        } catch (error) {
            return Promise.reject(error)
        }

        let resolveResult!: (result: AnimationRumV3PersistResult) => void
        let rejectResult!: (error: unknown) => void
        const result = new Promise<AnimationRumV3PersistResult>((resolve, reject) => {
            resolveResult = resolve
            rejectResult = reject
        })
        this.persistenceQueue = this.persistenceQueue.then(async () => {
            try {
                const persisted = await this.store.persist(
                    this.scope,
                    prepared,
                    { maxItems: this.config.storeMaxItems, maxAgeMs: this.config.storeMaxAgeMs },
                    now
                )
                for (const report of prepared) this.persistenceFailures.delete(report.key)
                resolveResult(persisted)
            } catch (error) {
                const failure = error ?? new Error('Animation RUM v3 soft navigation persistence failed')
                for (const report of prepared) {
                    this.rememberPersistenceFailure(report.key, failure)
                }
                rejectResult(failure)
            }
        })
        return result
    }

    async flush(reports?: readonly unknown[]): Promise<AnimationRumV3AttemptResult> {
        const hasSuppliedReports = reports !== undefined
        if (reports !== undefined) {
            await this.persist(reports)
        }
        await this.persistenceQueue
        if (this.stopped || this.suspended) {
            const persistenceFailure = hasSuppliedReports ? null : this.firstPersistenceFailure()
            if (persistenceFailure !== null) throw persistenceFailure
            return { ...EMPTY_ATTEMPT }
        }
        // A currently running attempt may have leased before the persistence
        // operation above committed. Require a strictly newer generation so a
        // successful flush always includes at least one post-persist attempt.
        const attempt = await this.attemptAfter(this.attemptGeneration)
        const persistenceFailure = hasSuppliedReports ? null : this.firstPersistenceFailure()
        if (persistenceFailure !== null) throw persistenceFailure
        return attempt
    }

    attemptOnce(): Promise<AnimationRumV3AttemptResult> {
        if (this.stopped || this.suspended) return Promise.resolve({ ...EMPTY_ATTEMPT })
        if (this.runningAttempt) return this.runningAttempt.promise
        const generation = this.attemptGeneration + 1
        this.attemptGeneration = generation
        const promise = this.runAttempt()
        const running = { generation, promise }
        this.runningAttempt = running
        void promise.then(
            () => {
                if (this.runningAttempt === running) this.runningAttempt = null
            },
            () => {
                if (this.runningAttempt === running) this.runningAttempt = null
            }
        )
        return promise
    }

    stop(): Promise<void> {
        if (this.stopping) return this.stopping
        this.stopped = true
        this.lifecycleIntent = 'suspended'
        this.clearPolling()
        const stopping = this.finishStop()
        this.stopping = stopping
        void stopping.catch(() => {
            // A failed wait/release must be retryable. Concurrent callers still
            // share the same in-flight stop promise; only a rejection clears it.
            if (this.stopping === stopping) this.stopping = null
        })
        return stopping
    }

    private async attemptAfter(generation: number): Promise<AnimationRumV3AttemptResult> {
        while (!this.stopped && !this.suspended) {
            const running = this.runningAttempt
            if (!running) return this.attemptOnce()
            if (running.generation > generation) return running.promise
            try {
                await running.promise
            } catch {
                // The caller that owned the older generation observes its
                // failure. This flush still owes durable work a new attempt.
            }
        }
        return { ...EMPTY_ATTEMPT }
    }

    private rememberPersistenceFailure(key: string, failure: unknown): void {
        if (this.persistenceFailures.has(key)) return
        if (this.persistenceFailures.size >= this.config.storeMaxItems) {
            const oldest = this.persistenceFailures.keys().next()
            if (!oldest.done) this.persistenceFailures.delete(oldest.value)
        }
        this.persistenceFailures.set(key, failure)
    }

    private firstPersistenceFailure(): unknown | null {
        const failure = this.persistenceFailures.values().next()
        return failure.done ? null : failure.value
    }

    private async runAttempt(): Promise<AnimationRumV3AttemptResult> {
        const now = this.now()
        await this.store.prune(this.scope, { maxItems: this.config.storeMaxItems, maxAgeMs: this.config.storeMaxAgeMs }, now)
        const reports = await this.store.leaseReady(
            this.scope,
            this.ownerId,
            now,
            this.config.batchSize,
            this.config.leaseDurationMs,
            MAX_KEEPALIVE_BODY_BYTES
        )
        if (reports.length === 0) return { ...EMPTY_ATTEMPT }

        const result = await this.send(reports)

        if (result.kind === 'terminal') {
            return this.isolateTerminalBatch(reports, result.reason)
        }

        if (result.kind === 'settled' && validateSettledResult(result, reports)) {
            const applied = await this.store.settle(this.scope, this.ownerId, result.settlements, this.now())
            assertAppliedKeys(reports, applied)
            const terminal = result.settlements.filter(settlement => settlement.state === 'terminal').length
            return {
                attempted: reports.length,
                confirmed: reports.length - terminal,
                terminal,
                retried: 0,
            }
        }

        return this.retry(reports, result.kind === 'retry' ? result.retryAfterMs : undefined)
    }

    private async send(reports: readonly AnimationRumV3QueuedReport[]): Promise<AnimationRumV3SendResult> {
        try {
            return await this.sender.send(this.scope, reports)
        } catch {
            return { kind: 'retry' }
        }
    }

    private async isolateTerminalBatch(
        reports: readonly AnimationRumV3QueuedReport[],
        initialReason: Extract<AnimationRumV3Settlement['terminalReason'], `http-${number}`>
    ): Promise<AnimationRumV3AttemptResult> {
        const unresolved = new Map(reports.map(report => [report.key, report] as const))
        const outcome = { confirmed: 0, terminal: 0, retried: 0 }
        let lifecycleDeferred = false
        const complete = (completed: readonly AnimationRumV3QueuedReport[], result: AnimationRumV3AttemptResult): void => {
            for (const report of completed) unresolved.delete(report.key)
            outcome.confirmed += result.confirmed
            outcome.terminal += result.terminal
            outcome.retried += result.retried
        }
        const renewUnresolved = async (): Promise<void> => {
            const pending = [...unresolved.values()]
            const applied = await this.store.renewLeases(
                this.scope,
                this.ownerId,
                pending.map(report => report.key),
                this.now(),
                this.config.leaseDurationMs
            )
            assertAppliedKeys(pending, applied)
        }
        const deferUnresolvedIfInactive = async (): Promise<boolean> => {
            if (!this.stopped && !this.suspended) return false
            if (!lifecycleDeferred) {
                lifecycleDeferred = true
                const pending = [...unresolved.values()]
                if (pending.length > 0) complete(pending, await this.retry(pending, undefined))
            }
            return true
        }
        const resolve = async (subset: readonly AnimationRumV3QueuedReport[], result: AnimationRumV3SendResult): Promise<void> => {
            if (result.kind === 'terminal') {
                if (subset.length === 1) {
                    const applied = await this.store.settle(
                        this.scope,
                        this.ownerId,
                        terminalSettlements(subset, result.reason),
                        this.now()
                    )
                    assertAppliedKeys(subset, applied)
                    complete(subset, { attempted: 1, confirmed: 0, terminal: 1, retried: 0 })
                    return
                }

                const children =
                    result.reason === 'http-403'
                        ? subset.map(report => [report] as readonly AnimationRumV3QueuedReport[])
                        : [subset.slice(0, Math.ceil(subset.length / 2)), subset.slice(Math.ceil(subset.length / 2))]
                for (const child of children) {
                    if (await deferUnresolvedIfInactive()) return
                    await renewUnresolved()
                    if (await deferUnresolvedIfInactive()) return
                    await resolve(child, await this.send(child))
                    if (lifecycleDeferred) return
                }
                return
            }

            if (result.kind === 'settled' && validateSettledResult(result, subset)) {
                const applied = await this.store.settle(this.scope, this.ownerId, result.settlements, this.now())
                assertAppliedKeys(subset, applied)
                const terminal = result.settlements.filter(settlement => settlement.state === 'terminal').length
                complete(subset, {
                    attempted: subset.length,
                    confirmed: subset.length - terminal,
                    terminal,
                    retried: 0,
                })
                return
            }

            const retried = await this.retry(subset, result.kind === 'retry' ? result.retryAfterMs : undefined)
            complete(subset, retried)
        }

        await resolve(reports, { kind: 'terminal', reason: initialReason })
        if (unresolved.size !== 0 || outcome.confirmed + outcome.terminal + outcome.retried !== reports.length) {
            throw new Error('Animation RUM v3 soft navigation terminal batch isolation produced an incomplete outcome')
        }
        return { attempted: reports.length, ...outcome }
    }

    private async retry(reports: readonly AnimationRumV3QueuedReport[], retryAfterMs: number | undefined) {
        const now = this.now()
        const exhausted = reports.filter(report => report.attemptCount + 1 >= this.config.retryMaxAttempts)
        const retryable = reports.filter(report => report.attemptCount + 1 < this.config.retryMaxAttempts)

        if (exhausted.length > 0) {
            const applied = await this.store.settle(this.scope, this.ownerId, terminalSettlements(exhausted, 'retry-exhausted'), now)
            assertAppliedKeys(exhausted, applied)
        }
        if (retryable.length > 0) {
            const boundedRetryAfter =
                typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
                    ? Math.min(retryAfterMs, this.config.retryMaxDelayMs)
                    : 0
            const applied = await this.store.reschedule(
                this.scope,
                this.ownerId,
                retryable.map(report => {
                    const attemptCount = report.attemptCount + 1
                    const exponential = Math.min(
                        this.config.retryMaxDelayMs,
                        this.config.retryBaseDelayMs * Math.pow(this.config.retryBackoff, attemptCount - 1)
                    )
                    return {
                        key: report.key,
                        attemptCount,
                        nextAttemptAt: now + Math.max(exponential, boundedRetryAfter),
                    }
                }),
                now
            )
            assertAppliedKeys(retryable, applied)
        }
        return {
            attempted: reports.length,
            confirmed: 0,
            terminal: exhausted.length,
            retried: retryable.length,
        }
    }

    private runScheduled(): void {
        if (this.stopped || this.suspended) return
        void this.flush().catch(() => {
            if (this.config.debug) console.debug('[Animation RUM v3 soft navigation] delivery deferred')
        })
    }

    private now(): number {
        const now = this.clock.now()
        if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid Animation RUM v3 soft navigation clock value')
        return now
    }

    private clearPolling(): void {
        if (this.timer === null) return
        this.timers.clearInterval(this.timer)
        this.timer = null
    }

    private async finishSuspend(): Promise<void> {
        await this.persistenceQueue
        try {
            if (this.runningAttempt) await this.runningAttempt.promise
        } catch {
            // BFCache suspension is best-effort. Durable pending work remains
            // retryable after restore or from another tab.
        }
        try {
            await this.store.releaseLeases(this.scope, this.ownerId, this.now())
        } catch {
            if (this.config.debug) console.debug('[Animation RUM v3 soft navigation] lease release deferred during page suspension')
        }
        try {
            await this.store.close?.()
        } catch {
            if (this.config.debug) console.debug('[Animation RUM v3 soft navigation] storage close deferred during page suspension')
        }
    }

    private async finishStop(): Promise<void> {
        if (this.suspending) await this.suspending
        await this.persistenceQueue
        let failure: unknown = this.firstPersistenceFailure()
        try {
            if (this.runningAttempt) await this.runningAttempt.promise
        } catch (error) {
            failure ??= error
        } finally {
            try {
                await this.store.releaseLeases(this.scope, this.ownerId, this.now())
            } catch (error) {
                failure ??= error
            }
            try {
                await this.store.close?.()
            } catch (error) {
                failure ??= error
            }
        }
        if (failure !== null) throw failure
    }
}
