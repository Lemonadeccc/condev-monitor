import {
    AnimationRumV3IngestValidationError,
    buildAnimationRumV3KafkaEnvelope,
    buildAnimationRumV3KafkaMessage,
    prepareAnimationRumV3TrackingPayload,
    type PreparedAnimationRumV3Payload,
} from '@condev-monitor/animation-rum-ingest'
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Pool, PoolClient } from 'pg'

const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u
const TOPIC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u
const MAX_REPORTS_PER_REQUEST = 64
const DEFAULT_TOPIC = 'monitor.sdk.animation-rum.soft-navigation.v3'

type DeliveryState = 'pending' | 'published' | 'persisted' | 'quarantined'

type PolicyRow = {
    enabled: boolean
    nextOutboxSequence: string
    receiptRetentionDays: number
}

type ReceiptRow = {
    captureId: string
    eventId: string
    payloadSha256: string
    payloadHashVersion: number
    routeKey: string
    release: string
    dist: string
    environment: string
    deliveryState: DeliveryState
    initialReceivedAt: Date | string
    outboxState: 'pending' | 'quarantined' | null
}

type StoredReceiptRow = Omit<ReceiptRow, 'outboxState'>

export type AnimationRumV3AdmissionReceipt = {
    eventId: string
    captureId: string
    receivedAt: string
    deliveryState: DeliveryState
    duplicate: boolean
}

export type AnimationRumV3AdmissionBatchResult = {
    accepted: number
    queued: number
    duplicates: number
    receipts: AnimationRumV3AdmissionReceipt[]
}

function timestamp(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value)
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid Animation RUM v3 receipt timestamp')
    return date.toISOString()
}

@Injectable()
export class AnimationRumV3AdmissionService {
    private readonly eventsTopic: string
    private schemaReady = false

    constructor(
        @Inject('PG_POOL') private readonly pool: Pool,
        config: ConfigService
    ) {
        this.eventsTopic = config.get<string>('KAFKA_ANIMATION_RUM_V3_TOPIC') ?? DEFAULT_TOPIC
        if (!TOPIC_RE.test(this.eventsTopic)) throw new Error('Invalid Animation RUM v3 Kafka topic configuration')
    }

    async admitBatch(
        appId: string,
        rawItems: readonly unknown[],
        options: { nowEpochMs?: number } = {}
    ): Promise<AnimationRumV3AdmissionBatchResult> {
        if (!APP_ID_RE.test(appId)) throw new BadRequestException({ message: 'Invalid app id', error: 'INVALID_APP_ID' })
        if (rawItems.length === 0) return { accepted: 0, queued: 0, duplicates: 0, receipts: [] }
        if (rawItems.length > MAX_REPORTS_PER_REQUEST) {
            throw new BadRequestException({ message: 'Too many Animation RUM v3 reports', error: 'RUM_V3_BATCH_TOO_LARGE' })
        }

        const nowEpochMs = this.resolveNow(options.nowEpochMs)
        const receivedAt = new Date(nowEpochMs).toISOString()
        const prepared = rawItems.map(item => this.prepare(item, nowEpochMs))
        this.assertUniqueBatchIdentities(prepared)

        let client: PoolClient
        try {
            client = await this.pool.connect()
        } catch (error) {
            throw this.unavailable(error)
        }

        let transactionOpen = false
        let clientDestroyed = false
        try {
            await client.query('BEGIN')
            transactionOpen = true
            await this.ensureSchemaReady(client)

            const applicationResult = await client.query<{ id: number }>(
                `SELECT id FROM public.application WHERE "appId" = $1 AND "isDelete" = false FOR UPDATE`,
                [appId]
            )
            const applicationId = Number(applicationResult.rows[0]?.id)
            if (applicationResult.rows.length !== 1 || !Number.isInteger(applicationId) || applicationId <= 0) {
                throw this.notEnabled()
            }

            const policyResult = await client.query<PolicyRow>(
                `
                    SELECT enabled,
                           next_outbox_sequence AS "nextOutboxSequence",
                           receipt_retention_days AS "receiptRetentionDays"
                    FROM public.animation_rum_v3_soft_navigation_policy
                    WHERE application_id = $1
                    FOR UPDATE
                `,
                [applicationId]
            )
            const policy = policyResult.rows[0]
            if (policyResult.rows.length !== 1 || !policy) throw this.notEnabled()
            const retentionDays = Number(policy.receiptRetentionDays)
            if (!Number.isSafeInteger(retentionDays) || retentionDays < 120 || retentionDays > 365) {
                throw new Error('Invalid Animation RUM v3 policy retention')
            }

            const existing = await this.loadExisting(client, applicationId, prepared)
            const byCapture = new Map(existing.map(row => [row.captureId, row]))
            const byEvent = new Map(existing.map(row => [row.eventId, row]))
            let nextSequence = this.parseSequence(policy.nextOutboxSequence)
            let queued = 0
            const receipts: AnimationRumV3AdmissionReceipt[] = []

            for (const item of prepared) {
                const report = item.report
                const captureMatch = byCapture.get(report.captureId)
                const eventMatch = byEvent.get(report.eventId)
                if (captureMatch || eventMatch) {
                    const duplicate = this.resolveExisting(captureMatch, eventMatch, item)
                    receipts.push({
                        eventId: duplicate.eventId,
                        captureId: duplicate.captureId,
                        receivedAt: timestamp(duplicate.initialReceivedAt),
                        deliveryState: duplicate.deliveryState,
                        duplicate: true,
                    })
                    continue
                }
                if (!policy.enabled) throw this.notEnabled()
                await this.requireEnabledRegistries(client, applicationId, item)

                const envelope = buildAnimationRumV3KafkaEnvelope({ appId, report, receivedAt, nowEpochMs })
                const message = buildAnimationRumV3KafkaMessage(envelope, { nowEpochMs })
                const sequence = nextSequence
                nextSequence += 1n

                await client.query(
                    `
                        INSERT INTO public.animation_rum_v3_soft_navigation_capture_receipt (
                            application_id, capture_id, event_id, payload_sha256, payload_hash_version,
                            contract_version, snapshot_schema_version, capture_kind, scope, route_key,
                            release, dist, environment, captured_at, delivery_state,
                            initial_received_at, updated_at, expires_at
                        ) VALUES (
                            $1, $2, $3, $4, $5,
                            3, 1, 'soft-navigation', 'page', $6,
                            $7, $8, $9, $10::timestamptz, 'pending',
                            $11::timestamptz, $11::timestamptz,
                            $11::timestamptz + ($12::text || ' days')::interval
                        )
                    `,
                    [
                        applicationId,
                        report.captureId,
                        report.eventId,
                        item.payloadHash,
                        item.payloadHashVersion,
                        report.context.routeKey,
                        report.release,
                        report.dist,
                        report.environment,
                        report.capturedAt,
                        receivedAt,
                        retentionDays,
                    ]
                )
                await client.query(
                    `
                        INSERT INTO public.animation_rum_v3_soft_navigation_outbox (
                            application_id, capture_id, app_sequence, topic, message_key,
                            envelope_text, state, next_attempt_at, created_at, updated_at
                        ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7::timestamptz, $7::timestamptz, $7::timestamptz)
                    `,
                    [applicationId, report.captureId, sequence.toString(), this.eventsTopic, message.key, message.value, receivedAt]
                )
                const inserted: ReceiptRow = {
                    captureId: report.captureId,
                    eventId: report.eventId,
                    payloadSha256: item.payloadHash,
                    payloadHashVersion: item.payloadHashVersion,
                    routeKey: report.context.routeKey,
                    release: report.release,
                    dist: report.dist,
                    environment: report.environment,
                    deliveryState: 'pending',
                    initialReceivedAt: receivedAt,
                    outboxState: 'pending',
                }
                byCapture.set(report.captureId, inserted)
                byEvent.set(report.eventId, inserted)
                queued += 1
                receipts.push({
                    eventId: report.eventId,
                    captureId: report.captureId,
                    receivedAt,
                    deliveryState: 'pending',
                    duplicate: false,
                })
            }

            if (queued > 0) {
                await client.query(
                    `UPDATE public.animation_rum_v3_soft_navigation_policy
                     SET next_outbox_sequence = $2, updated_at = $3::timestamptz
                     WHERE application_id = $1`,
                    [applicationId, nextSequence.toString(), receivedAt]
                )
            }
            await client.query('COMMIT')
            transactionOpen = false
            return { accepted: prepared.length, queued, duplicates: prepared.length - queued, receipts }
        } catch (error) {
            if (transactionOpen) {
                try {
                    await client.query('ROLLBACK')
                } catch {
                    client.release(true)
                    clientDestroyed = true
                    throw this.unavailable(error)
                }
            }
            throw error
        } finally {
            if (!clientDestroyed) client.release()
        }
    }

    private prepare(raw: unknown, nowEpochMs: number): PreparedAnimationRumV3Payload {
        try {
            return prepareAnimationRumV3TrackingPayload(raw, { nowEpochMs })
        } catch (error) {
            if (!(error instanceof AnimationRumV3IngestValidationError)) throw error
            throw new BadRequestException({
                message: 'Invalid Animation RUM v3 soft-navigation payload',
                error: 'INVALID_ANIMATION_RUM_V3',
                reasons: error.codes,
            })
        }
    }

    private assertUniqueBatchIdentities(items: PreparedAnimationRumV3Payload[]): void {
        const captures = new Set<string>()
        const events = new Set<string>()
        for (const { report } of items) {
            if (captures.has(report.captureId) || events.has(report.eventId)) {
                throw new ConflictException({ message: 'Duplicate identity in batch', error: 'RUM_V3_BATCH_IDENTITY_CONFLICT' })
            }
            captures.add(report.captureId)
            events.add(report.eventId)
        }
    }

    private async loadExisting(client: PoolClient, applicationId: number, items: PreparedAnimationRumV3Payload[]): Promise<ReceiptRow[]> {
        const captures = items.map(item => item.report.captureId)
        const events = items.map(item => item.report.eventId)
        const receiptResult = await client.query<StoredReceiptRow>(
            `
                SELECT capture_id AS "captureId", event_id AS "eventId",
                       payload_sha256 AS "payloadSha256", payload_hash_version AS "payloadHashVersion",
                       route_key AS "routeKey", release, dist, environment,
                       delivery_state AS "deliveryState", initial_received_at AS "initialReceivedAt"
                FROM public.animation_rum_v3_soft_navigation_capture_receipt
                WHERE application_id = $1
                  AND (capture_id = ANY($2::varchar[]) OR event_id = ANY($3::varchar[]))
                FOR UPDATE
            `,
            [applicationId, captures, events]
        )
        if (receiptResult.rows.length === 0) return []
        const outbox = await client.query<{ captureId: string; outboxState: 'pending' | 'quarantined' }>(
            `SELECT capture_id AS "captureId", state AS "outboxState"
             FROM public.animation_rum_v3_soft_navigation_outbox
             WHERE application_id = $1 AND capture_id = ANY($2::varchar[])`,
            [applicationId, receiptResult.rows.map(row => row.captureId)]
        )
        const state = new Map(outbox.rows.map(row => [row.captureId, row.outboxState]))
        return receiptResult.rows.map(row => ({ ...row, outboxState: state.get(row.captureId) ?? null }))
    }

    private resolveExisting(
        captureMatch: ReceiptRow | undefined,
        eventMatch: ReceiptRow | undefined,
        incoming: PreparedAnimationRumV3Payload
    ): ReceiptRow {
        if (!captureMatch || !eventMatch || captureMatch.captureId !== eventMatch.captureId) {
            throw new ConflictException({ message: 'Animation RUM v3 identity conflict', error: 'RUM_V3_IDENTITY_CONFLICT' })
        }
        const report = incoming.report
        if (
            captureMatch.eventId !== report.eventId ||
            captureMatch.payloadSha256 !== incoming.payloadHash ||
            captureMatch.payloadHashVersion !== incoming.payloadHashVersion ||
            captureMatch.routeKey !== report.context.routeKey ||
            captureMatch.release !== report.release ||
            captureMatch.dist !== report.dist ||
            captureMatch.environment !== report.environment
        ) {
            throw new ConflictException({ message: 'Animation RUM v3 identity conflict', error: 'RUM_V3_IDENTITY_CONFLICT' })
        }
        if (captureMatch.deliveryState === 'pending' && captureMatch.outboxState !== 'pending') {
            throw new ServiceUnavailableException({
                message: 'Animation RUM v3 receipt requires repair',
                error: 'RUM_V3_RECEIPT_REPAIR_REQUIRED',
            })
        }
        return captureMatch
    }

    private async requireEnabledRegistries(client: PoolClient, applicationId: number, item: PreparedAnimationRumV3Payload): Promise<void> {
        const report = item.report
        const result = await client.query<{ routeEnabled: boolean; deploymentEnabled: boolean }>(
            `
                SELECT EXISTS (
                    SELECT 1 FROM public.animation_rum_v3_soft_navigation_route_registry
                    WHERE application_id = $1 AND route_key = $2 AND enabled
                ) AS "routeEnabled",
                EXISTS (
                    SELECT 1 FROM public.animation_rum_v3_soft_navigation_deployment_registry
                    WHERE application_id = $1 AND release = $3 AND dist = $4 AND environment = $5 AND enabled
                ) AS "deploymentEnabled"
            `,
            [applicationId, report.context.routeKey, report.release, report.dist, report.environment]
        )
        const row = result.rows[0]
        if (!row?.routeEnabled)
            throw new ForbiddenException({ message: 'Animation RUM v3 route is not enabled', error: 'RUM_V3_ROUTE_NOT_ENABLED' })
        if (!row.deploymentEnabled) {
            throw new ForbiddenException({ message: 'Animation RUM v3 deployment is not enabled', error: 'RUM_V3_DEPLOYMENT_NOT_ENABLED' })
        }
    }

    private async ensureSchemaReady(client: PoolClient): Promise<void> {
        if (this.schemaReady) return
        const result = await client.query<{ ready: boolean }>(
            `SELECT to_regclass('public.animation_rum_v3_soft_navigation_policy') IS NOT NULL
                    AND to_regclass('public.animation_rum_v3_soft_navigation_capture_receipt') IS NOT NULL
                    AND to_regclass('public.animation_rum_v3_soft_navigation_outbox') IS NOT NULL AS ready`
        )
        if (!result.rows[0]?.ready) {
            throw new ServiceUnavailableException({ message: 'Animation RUM v3 schema is unavailable', error: 'RUM_V3_SCHEMA_UNAVAILABLE' })
        }
        this.schemaReady = true
    }

    private parseSequence(value: string): bigint {
        try {
            const parsed = BigInt(value)
            if (parsed < 1n) throw new Error()
            return parsed
        } catch {
            throw new Error('Invalid Animation RUM v3 outbox sequence')
        }
    }

    private resolveNow(value: number | undefined): number {
        const resolved = value ?? Date.now()
        if (!Number.isFinite(resolved) || resolved < 0) throw new Error('Invalid Animation RUM v3 admission clock')
        return resolved
    }

    private notEnabled(): ForbiddenException {
        return new ForbiddenException({ message: 'Animation RUM v3 soft navigation is not enabled', error: 'RUM_V3_NOT_ENABLED' })
    }

    private unavailable(error: unknown): ServiceUnavailableException {
        return new ServiceUnavailableException({
            message: 'Animation RUM v3 admission is unavailable',
            error: error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.message) ? error.message : 'RUM_V3_ADMISSION_UNAVAILABLE',
        })
    }
}
