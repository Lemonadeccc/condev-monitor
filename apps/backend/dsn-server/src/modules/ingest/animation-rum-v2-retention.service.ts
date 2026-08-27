import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Pool, PoolClient } from 'pg'

const ADVISORY_LOCK_NAMESPACE = 1_129_140_823
const ADVISORY_LOCK_KEY = 1

type CandidateApplicationRow = {
    applicationId: number
}

type ApplicationCleanup = {
    skipped: boolean
    quarantinedOutboxDeleted: number
    receiptsDeleted: number
}

type AdvisoryLockState = 'unknown' | 'not-acquired' | 'acquired' | 'released'

class RetentionSessionUncertainError extends Error {
    readonly code = 'RETENTION_SESSION_UNCERTAIN'

    constructor() {
        super('Animation RUM v2 retention PostgreSQL session state is uncertain')
        this.name = 'RetentionSessionUncertainError'
    }
}

class RetentionCycleDeadlineError extends Error {
    readonly code = 'RETENTION_CYCLE_DEADLINE'

    constructor() {
        super('Animation RUM v2 retention cycle deadline was reached')
        this.name = 'RetentionCycleDeadlineError'
    }
}

export type AnimationRumV2RetentionStats = {
    lockAcquired: boolean
    lockSkipped: boolean
    scannedApplications: number
    skippedApplications: number
    quarantinedOutboxDeleted: number
    receiptsDeleted: number
    failedApplications: number
    budgetExhausted: boolean
    durationMs: number
}

function boundedInteger(config: ConfigService, key: string, fallback: number, minimum: number, maximum: number): number {
    const raw = config.get<string>(key)
    if (raw === undefined) return fallback
    const value = Number(raw)
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback
}

function emptyStats(): AnimationRumV2RetentionStats {
    return {
        lockAcquired: false,
        lockSkipped: false,
        scannedApplications: 0,
        skippedApplications: 0,
        quarantinedOutboxDeleted: 0,
        receiptsDeleted: 0,
        failedApplications: 0,
        budgetExhausted: false,
        durationMs: 0,
    }
}

function rowCount(value: number | null): number {
    return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

@Injectable()
export class AnimationRumV2RetentionService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(AnimationRumV2RetentionService.name)
    private readonly enabled: boolean
    private readonly pollMs: number
    private readonly quarantineRetentionDays: number
    private readonly applicationLimit: number
    private readonly batchSize: number
    private readonly maxRowsPerCycle: number
    private readonly maxCycleMs: number
    private timer: NodeJS.Timeout | null = null
    private activeCleanup: Promise<AnimationRumV2RetentionStats> | null = null
    private stopping = false

    constructor(
        @Inject('PG_POOL') private readonly pool: Pool,
        config: ConfigService
    ) {
        this.enabled = config.get<string>('ANIMATION_RUM_V2_RETENTION_ENABLED') !== 'false'
        this.pollMs = boundedInteger(config, 'ANIMATION_RUM_V2_RETENTION_INTERVAL_MS', 3_600_000, 60_000, 86_400_000)
        this.quarantineRetentionDays = boundedInteger(config, 'ANIMATION_RUM_V2_QUARANTINE_ENVELOPE_RETENTION_DAYS', 7, 1, 30)
        this.applicationLimit = boundedInteger(config, 'ANIMATION_RUM_V2_RETENTION_APP_LIMIT', 25, 1, 100)
        this.batchSize = boundedInteger(config, 'ANIMATION_RUM_V2_RETENTION_BATCH_SIZE', 100, 10, 500)
        this.maxRowsPerCycle = boundedInteger(config, 'ANIMATION_RUM_V2_RETENTION_MAX_ROWS_PER_CYCLE', 1_000, 100, 5_000)
        this.maxCycleMs = boundedInteger(config, 'ANIMATION_RUM_V2_RETENTION_MAX_CYCLE_MS', 10_000, 1_000, 60_000)
    }

    onApplicationBootstrap(): void {
        if (!this.enabled) {
            this.logger.log('Animation RUM v2 retention cleanup disabled')
            return
        }
        this.timer = setInterval(() => {
            void this.cleanupOnce().catch(error => {
                this.logger.error(`Animation RUM v2 retention cycle failed (${this.safeErrorCode(error, 'RETENTION_CYCLE_FAILED')})`)
            })
        }, this.pollMs)
        this.timer.unref()
        void this.cleanupOnce().catch(error => {
            this.logger.error(`Animation RUM v2 initial retention cycle failed (${this.safeErrorCode(error, 'RETENTION_CYCLE_FAILED')})`)
        })
    }

    async onModuleDestroy(): Promise<void> {
        this.stopping = true
        if (this.timer) clearInterval(this.timer)
        this.timer = null
        if (this.activeCleanup) {
            try {
                await this.activeCleanup
            } catch {
                // The scheduled caller records only a bounded failure code.
            }
        }
    }

    async cleanupOnce(): Promise<AnimationRumV2RetentionStats> {
        if (!this.enabled || this.stopping) return emptyStats()
        if (this.activeCleanup) return this.activeCleanup
        const cleanup = this.runCycle()
        this.activeCleanup = cleanup
        try {
            const stats = await cleanup
            this.logStats(stats)
            return stats
        } finally {
            if (this.activeCleanup === cleanup) this.activeCleanup = null
        }
    }

    private async runCycle(): Promise<AnimationRumV2RetentionStats> {
        const stats = emptyStats()
        const startedAt = Date.now()
        const deadline = startedAt + this.maxCycleMs
        const client = await this.pool.connect()
        let lockState: AdvisoryLockState = 'unknown'
        let sessionUncertain = false
        try {
            const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked', [
                ADVISORY_LOCK_NAMESPACE,
                ADVISORY_LOCK_KEY,
            ])
            const locked = lock.rows.length === 1 ? lock.rows[0]?.locked : undefined
            if (typeof locked !== 'boolean') throw new RetentionSessionUncertainError()
            lockState = locked ? 'acquired' : 'not-acquired'
            if (!locked) {
                stats.lockSkipped = true
                return stats
            }
            stats.lockAcquired = true

            let applications: number[]
            try {
                applications = await this.discoverApplications(client, deadline)
            } catch (error) {
                if (this.isCycleDeadline(error)) {
                    stats.budgetExhausted = true
                    return stats
                }
                throw error
            }
            stats.scannedApplications = applications.length
            let rowsRemaining = this.maxRowsPerCycle
            for (const applicationId of applications) {
                if (this.stopping || rowsRemaining === 0 || Date.now() >= deadline) {
                    stats.budgetExhausted = true
                    break
                }
                try {
                    const result = await this.cleanupApplication(client, applicationId, Math.min(this.batchSize, rowsRemaining), deadline)
                    if (result.skipped) stats.skippedApplications += 1
                    stats.quarantinedOutboxDeleted += result.quarantinedOutboxDeleted
                    stats.receiptsDeleted += result.receiptsDeleted
                    rowsRemaining -= result.quarantinedOutboxDeleted + result.receiptsDeleted
                } catch (error) {
                    if (this.isCycleDeadline(error)) {
                        stats.budgetExhausted = true
                        break
                    }
                    stats.failedApplications += 1
                    this.logger.error(
                        `Animation RUM v2 retention application failed (${this.safeErrorCode(error, 'RETENTION_APPLICATION_FAILED')})`
                    )
                    if (error instanceof RetentionSessionUncertainError) {
                        sessionUncertain = true
                        break
                    }
                }
            }
            if (rowsRemaining === 0) stats.budgetExhausted = true
            return stats
        } catch (error) {
            if (error instanceof RetentionSessionUncertainError) sessionUncertain = true
            throw error
        } finally {
            if (lockState === 'acquired' && !sessionUncertain) {
                try {
                    const unlock = await client.query<{ unlocked: boolean }>(
                        'SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked',
                        [ADVISORY_LOCK_NAMESPACE, ADVISORY_LOCK_KEY]
                    )
                    if (unlock.rows.length === 1 && unlock.rows[0]?.unlocked === true) lockState = 'released'
                    else sessionUncertain = true
                } catch {
                    sessionUncertain = true
                }
            }
            const reusable = !sessionUncertain && (lockState === 'not-acquired' || lockState === 'released')
            client.release(!reusable)
            stats.durationMs = Math.max(0, Date.now() - startedAt)
        }
    }

    private async discoverApplications(client: PoolClient, deadline: number): Promise<number[]> {
        await this.beginTransaction(client, true)
        let transactionOpen = true
        try {
            await this.setTransactionDeadline(client, deadline)
            const result = await client.query<CandidateApplicationRow>(
                `
                    WITH retention_candidates AS MATERIALIZED (
                        SELECT application_id, quarantined_at AS due_at
                        FROM public.animation_rum_v2_outbox
                        WHERE state = 'quarantined'
                          AND quarantined_at <= CURRENT_TIMESTAMP - ($1::integer * interval '1 day')
                        UNION ALL
                        SELECT receipt.application_id, receipt.expires_at AS due_at
                        FROM public.animation_rum_v2_capture_receipt AS receipt
                        WHERE receipt.delivery_state IN ('published', 'persisted', 'quarantined')
                          AND receipt.expires_at <= CURRENT_TIMESTAMP
                          AND NOT EXISTS (
                              SELECT 1
                              FROM public.animation_rum_v2_outbox AS own_outbox
                              WHERE own_outbox.application_id = receipt.application_id
                                AND own_outbox.capture_id = receipt.capture_id
                          )
                          AND NOT EXISTS (
                              SELECT 1
                              FROM public.animation_rum_v2_outbox AS dependency_outbox
                              WHERE dependency_outbox.application_id = receipt.application_id
                                AND dependency_outbox.depends_on_capture_id = receipt.capture_id
                          )
                          AND NOT EXISTS (
                              SELECT 1
                              FROM public.animation_rum_v2_capture_receipt AS child
                              WHERE child.application_id = receipt.application_id
                                AND child.parent_capture_id = receipt.capture_id
                          )
                    )
                    SELECT application_id AS "applicationId"
                    FROM retention_candidates
                    GROUP BY application_id
                    ORDER BY min(due_at), application_id
                    LIMIT $2
                `,
                [this.quarantineRetentionDays, this.applicationLimit]
            )
            await client.query('COMMIT')
            transactionOpen = false
            return result.rows
                .map(row => Number(row.applicationId))
                .filter(applicationId => Number.isSafeInteger(applicationId) && applicationId > 0)
        } catch (error) {
            if (transactionOpen) await this.rollbackOrMarkUncertain(client)
            throw error
        }
    }

    private async cleanupApplication(
        client: PoolClient,
        applicationId: number,
        rowLimit: number,
        deadline: number
    ): Promise<ApplicationCleanup> {
        await this.beginTransaction(client, false)
        let transactionOpen = true
        try {
            await this.setTransactionDeadline(client, deadline)
            const application = await client.query(
                `
                    SELECT id
                    FROM public.application
                    WHERE id = $1
                    FOR UPDATE SKIP LOCKED
                `,
                [applicationId]
            )
            if (application.rowCount !== 1) {
                await client.query('COMMIT')
                transactionOpen = false
                return { skipped: true, quarantinedOutboxDeleted: 0, receiptsDeleted: 0 }
            }

            await this.setTransactionDeadline(client, deadline)
            const quarantinedOutboxDeleted = await this.deleteExpiredQuarantinedOutbox(client, applicationId, rowLimit)
            const receiptLimit = rowLimit - quarantinedOutboxDeleted
            let receiptsDeleted = 0
            if (receiptLimit > 0) {
                await this.setTransactionDeadline(client, deadline)
                const targetDeleted = await this.deleteExpiredReceipts(client, applicationId, 'target', receiptLimit)
                receiptsDeleted += targetDeleted
                const remaining = receiptLimit - targetDeleted
                if (remaining > 0) {
                    await this.setTransactionDeadline(client, deadline)
                    receiptsDeleted += await this.deleteExpiredReceipts(client, applicationId, 'page', remaining)
                }
            }

            await client.query('COMMIT')
            transactionOpen = false
            return { skipped: false, quarantinedOutboxDeleted, receiptsDeleted }
        } catch (error) {
            if (transactionOpen) await this.rollbackOrMarkUncertain(client)
            throw error
        }
    }

    private async deleteExpiredQuarantinedOutbox(client: PoolClient, applicationId: number, limit: number): Promise<number> {
        const result = await client.query(
            `
                WITH candidates AS MATERIALIZED (
                    SELECT id
                    FROM public.animation_rum_v2_outbox
                    WHERE application_id = $1
                      AND state = 'quarantined'
                      AND quarantined_at <= CURRENT_TIMESTAMP - ($2::integer * interval '1 day')
                    ORDER BY quarantined_at, id
                    LIMIT $3
                    FOR UPDATE SKIP LOCKED
                )
                DELETE FROM public.animation_rum_v2_outbox AS outbox
                USING candidates
                WHERE outbox.id = candidates.id
            `,
            [applicationId, this.quarantineRetentionDays, limit]
        )
        return rowCount(result.rowCount)
    }

    private async deleteExpiredReceipts(
        client: PoolClient,
        applicationId: number,
        scope: 'page' | 'target',
        limit: number
    ): Promise<number> {
        const result = await client.query(
            `
                WITH candidates AS MATERIALIZED (
                    SELECT receipt.application_id, receipt.capture_id
                    FROM public.animation_rum_v2_capture_receipt AS receipt
                    WHERE receipt.application_id = $1
                      AND receipt.scope = $2
                      AND receipt.delivery_state IN ('published', 'persisted', 'quarantined')
                      AND receipt.expires_at <= CURRENT_TIMESTAMP
                      AND NOT EXISTS (
                          SELECT 1
                          FROM public.animation_rum_v2_outbox AS outbox
                          WHERE outbox.application_id = receipt.application_id
                            AND outbox.capture_id = receipt.capture_id
                      )
                      AND NOT EXISTS (
                          SELECT 1
                          FROM public.animation_rum_v2_outbox AS dependency
                          WHERE dependency.application_id = receipt.application_id
                            AND dependency.depends_on_capture_id = receipt.capture_id
                      )
                      AND NOT EXISTS (
                          SELECT 1
                          FROM public.animation_rum_v2_capture_receipt AS child
                          WHERE child.application_id = receipt.application_id
                            AND child.parent_capture_id = receipt.capture_id
                      )
                    ORDER BY receipt.expires_at, receipt.capture_id
                    LIMIT $3
                    FOR UPDATE OF receipt SKIP LOCKED
                )
                DELETE FROM public.animation_rum_v2_capture_receipt AS receipt
                USING candidates
                WHERE receipt.application_id = candidates.application_id
                  AND receipt.capture_id = candidates.capture_id
            `,
            [applicationId, scope, limit]
        )
        return rowCount(result.rowCount)
    }

    private async setTransactionDeadline(client: PoolClient, deadline: number): Promise<void> {
        const remainingMs = Math.floor(deadline - Date.now())
        if (remainingMs < 1) throw new RetentionCycleDeadlineError()
        const timeout = `${remainingMs}ms`
        await client.query(
            `
                SELECT set_config('statement_timeout', $1, true),
                       set_config('lock_timeout', $1, true)
            `,
            [timeout]
        )
    }

    private async beginTransaction(client: PoolClient, readOnly: boolean): Promise<void> {
        try {
            await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN')
        } catch {
            throw new RetentionSessionUncertainError()
        }
    }

    private async rollbackOrMarkUncertain(client: PoolClient): Promise<void> {
        try {
            await client.query('ROLLBACK')
        } catch {
            throw new RetentionSessionUncertainError()
        }
    }

    private safeErrorCode(error: unknown, fallback: string): string {
        if (error === null || typeof error !== 'object' || Array.isArray(error)) return fallback
        const code = 'code' in error && typeof error.code === 'string' ? error.code.toUpperCase() : ''
        if (/^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) return code
        if (/^[0-9A-Z]{5}$/u.test(code)) return `PG_${code}`
        return fallback
    }

    private isCycleDeadline(error: unknown): boolean {
        return (
            error instanceof RetentionCycleDeadlineError ||
            (error !== null && typeof error === 'object' && !Array.isArray(error) && 'code' in error && error.code === '57014')
        )
    }

    private logStats(stats: AnimationRumV2RetentionStats): void {
        const summary =
            `Animation RUM v2 retention lockAcquired=${stats.lockAcquired} lockSkipped=${stats.lockSkipped}` +
            ` candidateApps=${stats.scannedApplications} skippedApps=${stats.skippedApplications}` +
            ` quarantineOutboxDeleted=${stats.quarantinedOutboxDeleted} receiptsDeleted=${stats.receiptsDeleted}` +
            ` failedApps=${stats.failedApplications} budgetExhausted=${stats.budgetExhausted} durationMs=${stats.durationMs}`
        if (stats.failedApplications > 0 || stats.budgetExhausted) this.logger.warn(summary)
        else if (stats.quarantinedOutboxDeleted > 0 || stats.receiptsDeleted > 0) this.logger.log(summary)
        else this.logger.debug(summary)
    }
}
