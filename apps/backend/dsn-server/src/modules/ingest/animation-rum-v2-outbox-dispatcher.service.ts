import { randomUUID } from 'node:crypto'

import { validateAnimationRumV2KafkaMessage } from '@condev-monitor/animation-rum-ingest'
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Pool, PoolClient } from 'pg'

import { KafkaProducerService } from './kafka-producer.service'

const ADVISORY_LOCK_NAMESPACE = 1_129_140_822

type CandidateRow = {
    id: string
    applicationId: number
}

type OutboxRow = {
    id: string
    applicationId: number
    captureId: string
    appSequence: string
    dependsOnCaptureId: string | null
    topic: string
    messageKey: string
    envelopeText: string
    attemptCount: number
    due: boolean
    leaseAvailable: boolean
}

type ReceiptRow = {
    captureId: string
    deliveryState: 'pending' | 'published' | 'persisted' | 'quarantined'
}

type ClaimedOutbox = OutboxRow & {
    leaseOwner: string
}

type DispatchOutcome = 'published' | 'retried' | 'quarantined' | 'repaired' | 'skipped' | 'failed'

type ClaimResult = { kind: 'claimed'; item: ClaimedOutbox } | { kind: Exclude<DispatchOutcome, 'published' | 'retried' | 'failed'> }

export type AnimationRumV2DispatchStats = {
    scanned: number
    published: number
    retried: number
    quarantined: number
    repaired: number
    skipped: number
    failed: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedInteger(config: ConfigService, key: string, fallback: number, minimum: number, maximum: number): number {
    const raw = config.get<string>(key)
    if (raw === undefined) return fallback
    const value = Number(raw)
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback
}

function emptyStats(): AnimationRumV2DispatchStats {
    return { scanned: 0, published: 0, retried: 0, quarantined: 0, repaired: 0, skipped: 0, failed: 0 }
}

@Injectable()
export class AnimationRumV2OutboxDispatcherService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(AnimationRumV2OutboxDispatcherService.name)
    private readonly enabled: boolean
    private readonly pollMs: number
    private readonly concurrency: number
    private readonly leaseMs: number
    private readonly retryBaseMs: number
    private readonly retryMaxMs: number
    private readonly maxAttempts: number
    private timer: NodeJS.Timeout | null = null
    private activeDispatch: Promise<AnimationRumV2DispatchStats> | null = null
    private stopping = false

    constructor(
        @Inject('PG_POOL') private readonly pool: Pool,
        private readonly kafka: KafkaProducerService,
        config: ConfigService
    ) {
        const kafkaEnabled = config.get<string>('KAFKA_ENABLED') === 'true'
        const configured = config.get<string>('ANIMATION_RUM_V2_OUTBOX_ENABLED')
        this.enabled = kafkaEnabled && configured !== 'false'
        this.pollMs = boundedInteger(config, 'ANIMATION_RUM_V2_OUTBOX_POLL_MS', 1_000, 100, 60_000)
        this.concurrency = boundedInteger(config, 'ANIMATION_RUM_V2_OUTBOX_CONCURRENCY', 2, 1, 4)
        this.leaseMs = boundedInteger(config, 'ANIMATION_RUM_V2_OUTBOX_LEASE_MS', 60_000, 10_000, 300_000)
        this.retryBaseMs = boundedInteger(config, 'ANIMATION_RUM_V2_OUTBOX_RETRY_BASE_MS', 1_000, 250, 60_000)
        this.retryMaxMs = Math.max(
            this.retryBaseMs,
            boundedInteger(config, 'ANIMATION_RUM_V2_OUTBOX_RETRY_MAX_MS', 300_000, 250, 3_600_000)
        )
        this.maxAttempts = boundedInteger(config, 'ANIMATION_RUM_V2_OUTBOX_MAX_ATTEMPTS', 288, 1, 1_000)
    }

    onApplicationBootstrap(): void {
        if (!this.enabled) {
            this.logger.log('Animation RUM v2 outbox dispatcher disabled')
            return
        }
        this.timer = setInterval(() => {
            void this.dispatchOnce().catch(error => {
                this.logger.error(`Animation RUM v2 outbox cycle failed (${this.safeErrorCode(error, 'DISPATCH_CYCLE_FAILED')})`)
            })
        }, this.pollMs)
        this.timer.unref()
        void this.dispatchOnce().catch(error => {
            this.logger.error(`Animation RUM v2 initial outbox cycle failed (${this.safeErrorCode(error, 'DISPATCH_CYCLE_FAILED')})`)
        })
    }

    async onModuleDestroy(): Promise<void> {
        this.stopping = true
        if (this.timer) clearInterval(this.timer)
        this.timer = null
        if (this.activeDispatch) {
            try {
                await this.activeDispatch
            } catch {
                // The scheduled caller records the bounded failure code.
            }
        }
    }

    async dispatchOnce(): Promise<AnimationRumV2DispatchStats> {
        if (!this.enabled || this.stopping) return emptyStats()
        if (this.activeDispatch) return this.activeDispatch
        const cycle = this.runCycle()
        this.activeDispatch = cycle
        try {
            return await cycle
        } finally {
            if (this.activeDispatch === cycle) this.activeDispatch = null
        }
    }

    private async runCycle(): Promise<AnimationRumV2DispatchStats> {
        const candidates = await this.discoverCandidates()
        const stats = emptyStats()
        stats.scanned = candidates.length
        let cursor = 0
        const workers = Array.from({ length: Math.min(this.concurrency, candidates.length) }, async () => {
            while (!this.stopping) {
                const index = cursor
                cursor += 1
                const candidate = candidates[index]
                if (!candidate) return
                let outcome: DispatchOutcome
                try {
                    outcome = await this.dispatchCandidate(candidate)
                } catch (error) {
                    outcome = 'failed'
                    this.logger.error(
                        `Animation RUM v2 outbox candidate failed (${this.safeErrorCode(error, 'DISPATCH_CANDIDATE_FAILED')})`
                    )
                }
                stats[outcome] += 1
            }
        })
        await Promise.all(workers)
        return stats
    }

    private async discoverCandidates(): Promise<CandidateRow[]> {
        const result = await this.pool.query<CandidateRow>(
            `
                WITH oldest AS MATERIALIZED (
                    SELECT DISTINCT ON (application_id)
                           id,
                           application_id,
                           next_attempt_at,
                           lease_until
                    FROM public.animation_rum_v2_outbox
                    WHERE state = 'pending'
                    ORDER BY application_id, app_sequence
                )
                SELECT id::text AS id,
                       application_id AS "applicationId"
                FROM oldest
                WHERE next_attempt_at <= CURRENT_TIMESTAMP
                  AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP)
                ORDER BY next_attempt_at, application_id
                LIMIT $1
            `,
            [this.concurrency * 4]
        )
        return result.rows.filter(
            row => /^\d+$/u.test(String(row.id)) && Number.isInteger(Number(row.applicationId)) && Number(row.applicationId) > 0
        )
    }

    private async dispatchCandidate(candidate: CandidateRow): Promise<DispatchOutcome> {
        let client: PoolClient
        try {
            client = await this.pool.connect()
        } catch (error) {
            this.logger.error(
                `Animation RUM v2 dispatcher cannot reserve a database session (${this.safeErrorCode(error, 'PG_CONNECT_FAILED')})`
            )
            return 'failed'
        }

        let advisoryLocked = false
        let destroyClient = false
        try {
            const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked', [
                ADVISORY_LOCK_NAMESPACE,
                candidate.applicationId,
            ])
            advisoryLocked = lock.rows.length === 1 && lock.rows[0]?.locked === true
            if (!advisoryLocked) return 'skipped'

            const claim = await this.claimCandidate(client, candidate)
            if (claim.kind !== 'claimed') return claim.kind
            const item = claim.item
            if (!this.validStoredEnvelope(item)) {
                return await this.recordFailure(client, item, 'INVALID_STORED_ENVELOPE', true)
            }

            try {
                await this.kafka.publishBatch({
                    topic: item.topic,
                    messages: [{ key: item.messageKey, value: item.envelopeText }],
                })
            } catch (error) {
                return await this.recordFailure(client, item, this.kafkaErrorCode(error), false)
            }

            try {
                await this.acknowledge(client, item)
                return 'published'
            } catch (error) {
                this.logger.error(`Animation RUM v2 Kafka ACK could not be recorded (${this.safeErrorCode(error, 'PG_ACK_FAILED')})`)
                return 'failed'
            }
        } finally {
            if (advisoryLocked) {
                try {
                    const unlock = await client.query<{ unlocked: boolean }>(
                        'SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked',
                        [ADVISORY_LOCK_NAMESPACE, candidate.applicationId]
                    )
                    if (unlock.rows.length !== 1 || unlock.rows[0]?.unlocked !== true) destroyClient = true
                } catch {
                    destroyClient = true
                }
            }
            client.release(destroyClient)
        }
    }

    private async claimCandidate(client: PoolClient, candidate: CandidateRow): Promise<ClaimResult> {
        return this.transaction(client, async () => {
            const application = await client.query('SELECT id FROM public.application WHERE id = $1 FOR UPDATE', [candidate.applicationId])
            if (application.rowCount !== 1) throw new Error('Animation RUM v2 outbox application is missing')

            const outbox = await client.query<OutboxRow>(
                `
                    SELECT id::text AS id,
                           application_id AS "applicationId",
                           capture_id AS "captureId",
                           app_sequence::text AS "appSequence",
                           depends_on_capture_id AS "dependsOnCaptureId",
                           topic,
                           message_key AS "messageKey",
                           envelope_text AS "envelopeText",
                           attempt_count AS "attemptCount",
                           next_attempt_at <= CURRENT_TIMESTAMP AS due,
                           (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP) AS "leaseAvailable"
                    FROM public.animation_rum_v2_outbox
                    WHERE application_id = $1
                      AND state = 'pending'
                    ORDER BY app_sequence
                    LIMIT 1
                    FOR UPDATE
                `,
                [candidate.applicationId]
            )
            const row = outbox.rows[0]
            if (!row || String(row.id) !== String(candidate.id) || !row.due || !row.leaseAvailable) return { kind: 'skipped' as const }

            const receiptIds = row.dependsOnCaptureId ? [row.captureId, row.dependsOnCaptureId].sort() : [row.captureId]
            const receipts = await client.query<ReceiptRow>(
                `
                    SELECT capture_id AS "captureId", delivery_state AS "deliveryState"
                    FROM public.animation_rum_v2_capture_receipt
                    WHERE application_id = $1
                      AND capture_id = ANY($2::varchar[])
                    ORDER BY capture_id
                    FOR UPDATE
                `,
                [candidate.applicationId, receiptIds]
            )
            const byCapture = new Map<string, ReceiptRow>(receipts.rows.map(receipt => [receipt.captureId, receipt] as const))
            const receipt = byCapture.get(row.captureId)
            if (!receipt) throw new Error('Animation RUM v2 outbox receipt is missing')
            if (receipt.deliveryState === 'published' || receipt.deliveryState === 'persisted') {
                const removed = await client.query('DELETE FROM public.animation_rum_v2_outbox WHERE id = $1 AND state = $2', [
                    row.id,
                    'pending',
                ])
                if (removed.rowCount !== 1) throw new Error('Animation RUM v2 outbox repair did not remove one row')
                return { kind: 'repaired' as const }
            }
            if (receipt.deliveryState === 'quarantined') {
                await this.quarantineOutboxOnly(client, row.id, 'RECEIPT_QUARANTINED')
                return { kind: 'quarantined' as const }
            }

            if (row.dependsOnCaptureId) {
                const parent = byCapture.get(row.dependsOnCaptureId)
                const parentError = !parent
                    ? 'PARENT_RECEIPT_MISSING'
                    : parent.deliveryState === 'quarantined'
                      ? 'PARENT_QUARANTINED'
                      : parent.deliveryState === 'pending'
                        ? 'PARENT_NOT_DELIVERABLE'
                        : null
                if (parentError) {
                    await this.quarantineReceiptAndOutbox(client, row.applicationId, row.captureId, row.id, parentError)
                    return { kind: 'quarantined' as const }
                }
            }

            const leaseOwner = randomUUID()
            const claimed = await client.query(
                `
                    UPDATE public.animation_rum_v2_outbox
                    SET lease_owner = $2,
                        lease_until = CURRENT_TIMESTAMP + ($3::integer * interval '1 millisecond'),
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND state = 'pending'
                      AND next_attempt_at <= CURRENT_TIMESTAMP
                      AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP)
                `,
                [row.id, leaseOwner, this.leaseMs]
            )
            if (claimed.rowCount !== 1) throw new Error('Animation RUM v2 outbox claim did not affect one row')
            return { kind: 'claimed' as const, item: { ...row, leaseOwner } }
        })
    }

    private validStoredEnvelope(item: ClaimedOutbox): boolean {
        let envelope: unknown
        try {
            envelope = JSON.parse(item.envelopeText)
        } catch {
            return false
        }
        return validateAnimationRumV2KafkaMessage({ key: item.messageKey, envelope }).ok
    }

    private async acknowledge(client: PoolClient, item: ClaimedOutbox): Promise<void> {
        await this.transaction(client, async () => {
            await this.lockApplication(client, item.applicationId)
            const receipt = await client.query(
                `
                    SELECT capture_id
                    FROM public.animation_rum_v2_capture_receipt
                    WHERE application_id = $1 AND capture_id = $2 AND delivery_state = 'pending'
                    FOR UPDATE
                `,
                [item.applicationId, item.captureId]
            )
            if (receipt.rowCount !== 1) throw new Error('Animation RUM v2 pending receipt is unavailable during ACK')
            const outbox = await client.query(
                `
                    SELECT id
                    FROM public.animation_rum_v2_outbox
                    WHERE id = $1 AND application_id = $2 AND capture_id = $3
                      AND state = 'pending' AND lease_owner = $4
                    FOR UPDATE
                `,
                [item.id, item.applicationId, item.captureId, item.leaseOwner]
            )
            if (outbox.rowCount !== 1) throw new Error('Animation RUM v2 outbox lease is stale during ACK')

            const published = await client.query(
                `
                    UPDATE public.animation_rum_v2_capture_receipt
                    SET delivery_state = 'published',
                        delivery_via = 'kafka',
                        published_at = CURRENT_TIMESTAMP,
                        persisted_at = NULL,
                        quarantined_at = NULL,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE application_id = $1 AND capture_id = $2 AND delivery_state = 'pending'
                `,
                [item.applicationId, item.captureId]
            )
            if (published.rowCount !== 1) throw new Error('Animation RUM v2 receipt ACK did not affect one row')
            const removed = await client.query(
                `
                    DELETE FROM public.animation_rum_v2_outbox
                    WHERE id = $1 AND application_id = $2 AND capture_id = $3
                      AND state = 'pending' AND lease_owner = $4
                `,
                [item.id, item.applicationId, item.captureId, item.leaseOwner]
            )
            if (removed.rowCount !== 1) throw new Error('Animation RUM v2 outbox ACK did not affect one row')
        })
    }

    private async recordFailure(
        client: PoolClient,
        item: ClaimedOutbox,
        errorCode: string,
        permanent: boolean
    ): Promise<'retried' | 'quarantined' | 'skipped'> {
        return this.transaction(client, async () => {
            await this.lockApplication(client, item.applicationId)
            const receipt = await client.query(
                `
                    SELECT capture_id
                    FROM public.animation_rum_v2_capture_receipt
                    WHERE application_id = $1 AND capture_id = $2 AND delivery_state = 'pending'
                    FOR UPDATE
                `,
                [item.applicationId, item.captureId]
            )
            if (receipt.rowCount !== 1) return 'skipped' as const
            const outbox = await client.query<{ attemptCount: number }>(
                `
                    SELECT attempt_count AS "attemptCount"
                    FROM public.animation_rum_v2_outbox
                    WHERE id = $1 AND application_id = $2 AND capture_id = $3
                      AND state = 'pending' AND lease_owner = $4
                    FOR UPDATE
                `,
                [item.id, item.applicationId, item.captureId, item.leaseOwner]
            )
            const stored = outbox.rows[0]
            if (outbox.rows.length !== 1 || !stored) return 'skipped' as const
            const nextAttempt = Number(stored.attemptCount) + 1
            if (permanent || nextAttempt >= this.maxAttempts) {
                await this.quarantineReceiptAndOutbox(client, item.applicationId, item.captureId, item.id, errorCode, item.leaseOwner)
                return 'quarantined' as const
            }

            const retry = await client.query(
                `
                    UPDATE public.animation_rum_v2_outbox
                    SET attempt_count = attempt_count + 1,
                        next_attempt_at = CURRENT_TIMESTAMP + ($2::integer * interval '1 millisecond'),
                        lease_owner = NULL,
                        lease_until = NULL,
                        last_error_code = $3,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1 AND state = 'pending' AND lease_owner = $4
                `,
                [item.id, this.retryDelayMs(nextAttempt), errorCode, item.leaseOwner]
            )
            if (retry.rowCount !== 1) throw new Error('Animation RUM v2 outbox retry did not affect one row')
            return 'retried' as const
        })
    }

    private async quarantineReceiptAndOutbox(
        client: PoolClient,
        applicationId: number,
        captureId: string,
        outboxId: string,
        errorCode: string,
        leaseOwner?: string
    ): Promise<void> {
        const receipt = await client.query(
            `
                UPDATE public.animation_rum_v2_capture_receipt
                SET delivery_state = 'quarantined',
                    delivery_via = NULL,
                    published_at = NULL,
                    persisted_at = NULL,
                    quarantined_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE application_id = $1 AND capture_id = $2 AND delivery_state = 'pending'
            `,
            [applicationId, captureId]
        )
        if (receipt.rowCount !== 1) throw new Error('Animation RUM v2 receipt quarantine did not affect one row')
        const outbox = await client.query(
            `
                UPDATE public.animation_rum_v2_outbox
                SET state = 'quarantined',
                    attempt_count = attempt_count + 1,
                    lease_owner = NULL,
                    lease_until = NULL,
                    last_error_code = $2,
                    quarantined_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1 AND state = 'pending'
                  AND ($3::varchar IS NULL OR lease_owner = $3)
            `,
            [outboxId, errorCode, leaseOwner ?? null]
        )
        if (outbox.rowCount !== 1) throw new Error('Animation RUM v2 outbox quarantine did not affect one row')
    }

    private async quarantineOutboxOnly(client: PoolClient, outboxId: string, errorCode: string): Promise<void> {
        const outbox = await client.query(
            `
                UPDATE public.animation_rum_v2_outbox
                SET state = 'quarantined',
                    attempt_count = attempt_count + 1,
                    lease_owner = NULL,
                    lease_until = NULL,
                    last_error_code = $2,
                    quarantined_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1 AND state = 'pending'
            `,
            [outboxId, errorCode]
        )
        if (outbox.rowCount !== 1) throw new Error('Animation RUM v2 outbox repair did not affect one row')
    }

    private async lockApplication(client: PoolClient, applicationId: number): Promise<void> {
        const application = await client.query('SELECT id FROM public.application WHERE id = $1 FOR UPDATE', [applicationId])
        if (application.rowCount !== 1) throw new Error('Animation RUM v2 outbox application is unavailable')
    }

    private async transaction<T>(client: PoolClient, callback: () => Promise<T>): Promise<T> {
        await client.query('BEGIN')
        let open = true
        try {
            const result = await callback()
            await client.query('COMMIT')
            open = false
            return result
        } catch (error) {
            if (open) {
                try {
                    await client.query('ROLLBACK')
                } catch {
                    // Unlock will fail and force-destroy a broken session.
                }
            }
            throw error
        }
    }

    private retryDelayMs(attempt: number): number {
        const exponent = Math.min(30, Math.max(0, attempt - 1))
        const base = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** exponent)
        const jitter = 0.8 + Math.random() * 0.4
        return Math.max(1, Math.min(this.retryMaxMs, Math.round(base * jitter)))
    }

    private kafkaErrorCode(error: unknown): string {
        const name = error instanceof Error ? error.name.toUpperCase() : ''
        const code = isRecord(error) && typeof error.code === 'string' ? error.code.toUpperCase() : ''
        if (name.includes('TIMEOUT') || code.includes('TIMEOUT')) return 'KAFKA_TIMEOUT'
        return this.kafka.isConnected() ? 'KAFKA_PUBLISH_FAILED' : 'KAFKA_CONNECT_FAILED'
    }

    private safeErrorCode(error: unknown, fallback: string): string {
        const code = isRecord(error) && typeof error.code === 'string' ? error.code.toUpperCase() : ''
        if (/^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) return code
        // PostgreSQL SQLSTATE values can begin with a digit (for example,
        // 42P01). Prefix the bounded five-character code so operational logs
        // remain useful without exposing messages, SQL, or connection data.
        if (/^[0-9A-Z]{5}$/u.test(code)) return `PG_${code}`
        return fallback
    }
}
