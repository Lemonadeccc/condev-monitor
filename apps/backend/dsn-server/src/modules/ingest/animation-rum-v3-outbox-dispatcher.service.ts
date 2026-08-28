import { randomUUID } from 'node:crypto'

import { type AnimationRumV3KafkaEnvelope, validateAnimationRumV3KafkaMessage } from '@condev-monitor/animation-rum-ingest'
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Pool, PoolClient } from 'pg'

import { AnimationRumClickhouseService } from './animation-rum-clickhouse.service'
import { KafkaProducerService } from './kafka-producer.service'

const ADVISORY_LOCK_NAMESPACE = 1_129_140_823
const DEFAULT_TOPIC = 'monitor.sdk.animation-rum.soft-navigation.v3'
const TOPIC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u

type OutboxRow = {
    id: string
    applicationId: number
    captureId: string
    topic: string
    messageKey: string
    envelopeText: string
    attemptCount: number
}

type ClaimedOutbox = OutboxRow & { leaseOwner: string }
type DeliveryTransport = 'kafka' | 'clickhouse-fallback'
type Outcome = 'published' | 'persisted' | 'retried' | 'quarantined' | 'skipped' | 'failed'

export type AnimationRumV3DispatchStats = {
    scanned: number
    published: number
    persisted: number
    retried: number
    quarantined: number
    skipped: number
    failed: number
}

function boundedInteger(config: ConfigService, key: string, fallback: number, minimum: number, maximum: number): number {
    const raw = config.get<string>(key)
    if (raw === undefined) return fallback
    const value = Number(raw)
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback
}

function emptyStats(): AnimationRumV3DispatchStats {
    return { scanned: 0, published: 0, persisted: 0, retried: 0, quarantined: 0, skipped: 0, failed: 0 }
}

@Injectable()
export class AnimationRumV3OutboxDispatcherService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(AnimationRumV3OutboxDispatcherService.name)
    private readonly enabled: boolean
    private readonly transport: DeliveryTransport
    private readonly eventsTopic: string
    private readonly pollMs: number
    private readonly concurrency: number
    private readonly leaseMs: number
    private readonly retryBaseMs: number
    private readonly retryMaxMs: number
    private readonly maxAttempts: number
    private timer: NodeJS.Timeout | null = null
    private activeDispatch: Promise<AnimationRumV3DispatchStats> | null = null
    private stopping = false

    constructor(
        @Inject('PG_POOL') private readonly pool: Pool,
        private readonly kafka: KafkaProducerService,
        private readonly animationRumClickhouse: AnimationRumClickhouseService,
        config: ConfigService
    ) {
        const ingestMode = config.get<string>('INGEST_MODE') ?? 'direct'
        if (ingestMode !== 'direct' && ingestMode !== 'kafka') throw new Error('INGEST_MODE must be either direct or kafka')
        this.enabled = config.get<string>('ANIMATION_RUM_V3_OUTBOX_ENABLED') !== 'false'
        this.transport = ingestMode === 'kafka' && config.get<string>('KAFKA_ENABLED') === 'true' ? 'kafka' : 'clickhouse-fallback'
        this.eventsTopic = config.get<string>('KAFKA_ANIMATION_RUM_V3_TOPIC') ?? DEFAULT_TOPIC
        if (!TOPIC_RE.test(this.eventsTopic)) throw new Error('Invalid Animation RUM v3 Kafka topic configuration')
        this.pollMs = boundedInteger(config, 'ANIMATION_RUM_V3_OUTBOX_POLL_MS', 1_000, 100, 60_000)
        this.concurrency = boundedInteger(config, 'ANIMATION_RUM_V3_OUTBOX_CONCURRENCY', 2, 1, 4)
        this.leaseMs = boundedInteger(config, 'ANIMATION_RUM_V3_OUTBOX_LEASE_MS', 60_000, 10_000, 300_000)
        this.retryBaseMs = boundedInteger(config, 'ANIMATION_RUM_V3_OUTBOX_RETRY_BASE_MS', 1_000, 250, 60_000)
        this.retryMaxMs = Math.max(
            this.retryBaseMs,
            boundedInteger(config, 'ANIMATION_RUM_V3_OUTBOX_RETRY_MAX_MS', 300_000, 250, 3_600_000)
        )
        this.maxAttempts = boundedInteger(config, 'ANIMATION_RUM_V3_OUTBOX_MAX_ATTEMPTS', 288, 1, 1_000)
    }

    onApplicationBootstrap(): void {
        if (!this.enabled) return
        this.timer = setInterval(() => {
            void this.dispatchOnce().catch(error => this.logger.error(`Animation RUM v3 dispatch failed (${this.safeCode(error)})`))
        }, this.pollMs)
        this.timer.unref()
        void this.dispatchOnce().catch(error => this.logger.error(`Animation RUM v3 initial dispatch failed (${this.safeCode(error)})`))
    }

    async onModuleDestroy(): Promise<void> {
        this.stopping = true
        if (this.timer) clearInterval(this.timer)
        this.timer = null
        try {
            await this.activeDispatch
        } catch {
            // Scheduled caller records the bounded error code.
        }
    }

    async dispatchOnce(): Promise<AnimationRumV3DispatchStats> {
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

    private async runCycle(): Promise<AnimationRumV3DispatchStats> {
        const stats = emptyStats()
        const candidates = await this.pool.query<{ applicationId: number }>(
            `
                SELECT application_id AS "applicationId"
                FROM public.animation_rum_v3_soft_navigation_outbox
                WHERE state = 'pending' AND next_attempt_at <= now()
                  AND (lease_until IS NULL OR lease_until <= now())
                GROUP BY application_id
                ORDER BY min(app_sequence)
                LIMIT $1
            `,
            [this.concurrency]
        )
        stats.scanned = candidates.rows.length
        const outcomes = await Promise.all(candidates.rows.map(row => this.dispatchApplication(row.applicationId)))
        for (const outcome of outcomes) stats[outcome] += 1
        return stats
    }

    private async dispatchApplication(applicationId: number): Promise<Outcome> {
        let client: PoolClient
        try {
            client = await this.pool.connect()
        } catch {
            return 'failed'
        }
        let locked = false
        let clientDestroyed = false
        try {
            const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS locked', [
                ADVISORY_LOCK_NAMESPACE,
                applicationId,
            ])
            locked = lock.rows[0]?.locked === true
            if (!locked) return 'skipped'
            const claimed = await this.claimOldest(client, applicationId)
            if (!claimed) return 'skipped'
            return await this.deliver(client, claimed)
        } catch (error) {
            this.logger.error(`Animation RUM v3 item failed (${this.safeCode(error)})`)
            return 'failed'
        } finally {
            if (locked) {
                try {
                    await client.query('SELECT pg_advisory_unlock($1, $2)', [ADVISORY_LOCK_NAMESPACE, applicationId])
                } catch {
                    client.release(true)
                    clientDestroyed = true
                }
            }
            if (!clientDestroyed) client.release()
        }
    }

    private async claimOldest(client: PoolClient, applicationId: number): Promise<ClaimedOutbox | null> {
        const leaseOwner = randomUUID()
        await client.query('BEGIN')
        try {
            await client.query('SELECT id FROM public.application WHERE id = $1 FOR UPDATE', [applicationId])
            const result = await client.query<OutboxRow>(
                `
                    SELECT id::text AS id, application_id AS "applicationId", capture_id AS "captureId",
                           topic, message_key AS "messageKey", envelope_text AS "envelopeText",
                           attempt_count AS "attemptCount"
                    FROM public.animation_rum_v3_soft_navigation_outbox
                    WHERE application_id = $1 AND state = 'pending'
                    ORDER BY app_sequence
                    LIMIT 1
                    FOR UPDATE
                `,
                [applicationId]
            )
            const row = result.rows[0]
            if (!row) {
                await client.query('COMMIT')
                return null
            }
            const claimed = await client.query(
                `
                    UPDATE public.animation_rum_v3_soft_navigation_outbox
                    SET lease_owner = $2, lease_until = now() + ($3::text || ' milliseconds')::interval, updated_at = now()
                    WHERE id = $1 AND state = 'pending' AND next_attempt_at <= now()
                      AND (lease_until IS NULL OR lease_until <= now())
                `,
                [row.id, leaseOwner, this.leaseMs]
            )
            if (claimed.rowCount !== 1) {
                await client.query('COMMIT')
                return null
            }
            await client.query('COMMIT')
            return { ...row, leaseOwner }
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        }
    }

    private async deliver(client: PoolClient, item: ClaimedOutbox): Promise<Outcome> {
        const parsed = this.parseEnvelope(item.envelopeText)
        if (item.topic !== this.eventsTopic) return this.quarantine(client, item, 'V3_TOPIC_MISMATCH')
        const validation = validateAnimationRumV3KafkaMessage({ key: item.messageKey, envelope: parsed })
        if (!validation.ok) return this.quarantine(client, item, 'INVALID_V3_ENVELOPE')
        const envelope = validation.value
        if (envelope.info.animationSoftNavigationRum.captureId !== item.captureId) {
            return this.quarantine(client, item, 'V3_CAPTURE_ID_MISMATCH')
        }

        try {
            if (this.transport === 'kafka') {
                await this.kafka.publishDurableBatch({ topic: item.topic, messages: [{ key: item.messageKey, value: item.envelopeText }] })
                return await this.complete(client, item, 'published', 'kafka')
            }
            await this.animationRumClickhouse.insertV3SoftNavigation(envelope as AnimationRumV3KafkaEnvelope)
            return await this.complete(client, item, 'persisted', 'clickhouse-fallback')
        } catch (error) {
            const attempts = item.attemptCount + 1
            if (attempts >= this.maxAttempts) return this.quarantine(client, item, this.safeCode(error, 'DELIVERY_EXHAUSTED'))
            return this.retry(client, item, attempts, this.safeCode(error, 'DELIVERY_FAILED'))
        }
    }

    private async complete(
        client: PoolClient,
        item: ClaimedOutbox,
        state: 'published' | 'persisted',
        via: 'kafka' | 'clickhouse-fallback'
    ): Promise<'published' | 'persisted' | 'skipped'> {
        await client.query('BEGIN')
        try {
            const removed = await client.query(
                `DELETE FROM public.animation_rum_v3_soft_navigation_outbox WHERE id = $1 AND lease_owner = $2 RETURNING capture_id`,
                [item.id, item.leaseOwner]
            )
            if (removed.rowCount !== 1) {
                await client.query('ROLLBACK')
                return 'skipped'
            }
            const transitioned = await client.query(
                `
                    UPDATE public.animation_rum_v3_soft_navigation_capture_receipt
                    SET delivery_state = $3, delivery_via = $4, updated_at = now(),
                        published_at = CASE WHEN $3::varchar = 'published' THEN now() ELSE NULL END,
                        persisted_at = CASE WHEN $3::varchar = 'persisted' THEN now() ELSE NULL END
                    WHERE application_id = $1 AND capture_id = $2 AND delivery_state = 'pending'
                `,
                [item.applicationId, item.captureId, state, via]
            )
            if (transitioned.rowCount !== 1) throw new Error('RECEIPT_TRANSITION_CONFLICT')
            await client.query('COMMIT')
            return state
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        }
    }

    private async retry(client: PoolClient, item: ClaimedOutbox, attempts: number, code: string): Promise<'retried' | 'skipped'> {
        const delayMs = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(attempts - 1, 20))
        const result = await client.query(
            `
                UPDATE public.animation_rum_v3_soft_navigation_outbox
                SET attempt_count = $3, next_attempt_at = now() + ($4::text || ' milliseconds')::interval,
                    lease_owner = NULL, lease_until = NULL, last_error_code = $5, updated_at = now()
                WHERE id = $1 AND lease_owner = $2 AND state = 'pending'
            `,
            [item.id, item.leaseOwner, attempts, delayMs, code]
        )
        return result.rowCount === 1 ? 'retried' : 'skipped'
    }

    private async quarantine(client: PoolClient, item: ClaimedOutbox, code: string): Promise<'quarantined' | 'skipped'> {
        await client.query('BEGIN')
        try {
            const outbox = await client.query(
                `
                    UPDATE public.animation_rum_v3_soft_navigation_outbox
                    SET state = 'quarantined', attempt_count = attempt_count + 1,
                        lease_owner = NULL, lease_until = NULL, last_error_code = $3,
                        quarantined_at = now(), updated_at = now()
                    WHERE id = $1 AND lease_owner = $2 AND state = 'pending'
                `,
                [item.id, item.leaseOwner, code]
            )
            if (outbox.rowCount !== 1) {
                await client.query('ROLLBACK')
                return 'skipped'
            }
            const receipt = await client.query(
                `
                    UPDATE public.animation_rum_v3_soft_navigation_capture_receipt
                    SET delivery_state = 'quarantined', delivery_via = NULL,
                        quarantined_at = now(), updated_at = now()
                    WHERE application_id = $1 AND capture_id = $2 AND delivery_state = 'pending'
                `,
                [item.applicationId, item.captureId]
            )
            if (receipt.rowCount !== 1) throw new Error('RECEIPT_TRANSITION_CONFLICT')
            await client.query('COMMIT')
            return 'quarantined'
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        }
    }

    private parseEnvelope(text: string): unknown {
        try {
            return JSON.parse(text)
        } catch {
            return null
        }
    }

    private safeCode(error: unknown, fallback = 'DISPATCH_FAILED'): string {
        const candidate = error instanceof Error ? error.message : ''
        if (/^[A-Z][A-Z0-9_]{0,63}$/u.test(candidate)) return candidate
        if (error !== null && typeof error === 'object' && 'code' in error) {
            const rawCode = String(error.code)
            if (/^[A-Za-z0-9_]{1,55}$/u.test(rawCode)) return `DELIVERY_${rawCode.toUpperCase()}`
        }
        return fallback
    }
}
