import { ClickHouseClient } from '@clickhouse/client'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { DataSource } from 'typeorm'

import { ApplicationService } from '../application/application.service'
import { resolveClickhouseDatabase } from '../shared/clickhouse-utils'
import { createAnimationRumV2ProjectionSql } from './animation-rum-v2-projection-sql'

const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/
const CAPTURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/
const EVENT_ID_PATTERN = CAPTURE_ID_PATTERN
const DELIVERY_STATES = ['pending', 'published', 'persisted', 'quarantined'] as const
const OUTBOX_STATES = ['pending', 'quarantined'] as const

type DeliveryState = (typeof DELIVERY_STATES)[number]
type OutboxState = (typeof OUTBOX_STATES)[number]
type PipelineStatus = 'idle' | 'in-flight' | 'healthy' | 'delayed' | 'quarantined' | 'inconsistent' | 'unknown'
type ProjectionAvailability = 'not-checked' | 'available' | 'unavailable'

type ReceiptActivityRow = {
    captureId: unknown
    eventId: unknown
    deliveryState: unknown
    updatedAt: unknown
    publishedAt: unknown
    persistedAt: unknown
    outboxState: unknown
}

type OutboxAggregateRow = {
    count: unknown
    due: unknown
    retrying: unknown
    leased: unknown
    oldestPendingAt: unknown
    maxAttemptCount: unknown
}

type CountAggregateRow = { count: unknown }
type ProjectionRow = {
    capture_id?: unknown
    event_id?: unknown
    scope?: unknown
    metric_count?: unknown
    provider_evidence_count?: unknown
    projection_observed_metric_count?: unknown
    projection_matching_metric_count?: unknown
    projection_mismatched_metric_identity_count?: unknown
    projection_observed_provider_evidence_count?: unknown
    projection_matching_provider_evidence_count?: unknown
    projection_mismatched_provider_identity_count?: unknown
}
type ProjectionCandidate = { captureId: string; eventId: string }

type BoundedCount = { count: number; truncated: boolean }
type OutboxAggregate = {
    pending: BoundedCount
    due: number
    retrying: number
    leased: number
    oldestPendingAt: string | null
    maxAttemptCount: number | null
    valid: boolean
}

type ProjectionView = {
    availability: ProjectionAvailability
    matched: number | null
    storageComplete: number | null
    missingAfterGrace: number | null
    identityMismatch: number | null
    childCountMismatch: number | null
    childIdentityMismatch: number | null
}

export const ANIMATION_RUM_V2_PIPELINE_CLOCK = Symbol('ANIMATION_RUM_V2_PIPELINE_CLOCK')

export const ANIMATION_RUM_V2_PIPELINE_LIMITS = Object.freeze({
    lookbackSeconds: 3_600,
    outboxDelaySeconds: 300,
    projectionGraceSeconds: 120,
    comparisonLimit: 500,
})

const DATABASE_ROW_LIMIT = ANIMATION_RUM_V2_PIPELINE_LIMITS.comparisonLimit + 1
const CLICKHOUSE_CAPTURE_CHILD_LIMITS = Object.freeze({ metrics: 128, providerEvidence: 96 })
const CLICKHOUSE_EXPECTED_ROWS_TO_READ =
    ANIMATION_RUM_V2_PIPELINE_LIMITS.comparisonLimit *
    (1 + CLICKHOUSE_CAPTURE_CHILD_LIMITS.metrics + CLICKHOUSE_CAPTURE_CHILD_LIMITS.providerEvidence)
// FINAL reads physical replacement versions and whole marks before collapsing
// them, so the cap needs bounded read-amplification room above logical maxima.
const CLICKHOUSE_READ_AMPLIFICATION_FACTOR = 2
const CLICKHOUSE_MAX_ROWS_TO_READ = CLICKHOUSE_EXPECTED_ROWS_TO_READ * CLICKHOUSE_READ_AMPLIFICATION_FACTOR
const CLICKHOUSE_READ_SETTINGS = Object.freeze({
    max_execution_time: 5,
    max_result_rows: String(ANIMATION_RUM_V2_PIPELINE_LIMITS.comparisonLimit),
    result_overflow_mode: 'throw' as const,
    max_rows_to_read: String(CLICKHOUSE_MAX_ROWS_TO_READ),
    max_memory_usage: '67108864',
    max_threads: 2,
})

function closedValue<T extends string>(value: unknown, values: readonly T[]): T | null {
    return typeof value === 'string' && values.some(candidate => candidate === value) ? (value as T) : null
}

function safeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null
}

function isoTimestamp(value: unknown): string | null {
    if (!(value instanceof Date) && typeof value !== 'string') return null
    const date = value instanceof Date ? value : new Date(value)
    return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function boundedCount(value: unknown): BoundedCount & { valid: boolean } {
    const parsed = safeInteger(value, DATABASE_ROW_LIMIT)
    if (parsed === null) return { count: 0, truncated: false, valid: false }
    return {
        count: Math.min(parsed, ANIMATION_RUM_V2_PIPELINE_LIMITS.comparisonLimit),
        truncated: parsed > ANIMATION_RUM_V2_PIPELINE_LIMITS.comparisonLimit,
        valid: true,
    }
}

function expectedOutboxState(deliveryState: DeliveryState): OutboxState | null {
    if (deliveryState === 'pending') return 'pending'
    if (deliveryState === 'quarantined') return 'quarantined'
    return null
}

@Injectable()
export class AnimationRumV2PipelineService {
    private readonly database: string
    private readonly readClock: () => Date

    constructor(
        private readonly dataSource: DataSource,
        @Inject('CLICKHOUSE_CLIENT') private readonly clickhouse: ClickHouseClient,
        config: ConfigService,
        private readonly applications: ApplicationService,
        @Optional()
        @Inject(ANIMATION_RUM_V2_PIPELINE_CLOCK)
        readClock?: () => Date
    ) {
        this.database = resolveClickhouseDatabase(config)
        this.readClock = readClock ?? (() => new Date())
    }

    async read(userId: number, appId: string) {
        if (typeof appId !== 'string' || !APP_ID_PATTERN.test(appId)) throw new TypeError('Invalid appId')

        // Authorization must finish before either durable pipeline store is read.
        await this.applications.assertOwned(appId, userId)

        const observedAtDate = this.readClock()
        if (!(observedAtDate instanceof Date) || !Number.isFinite(observedAtDate.getTime())) {
            throw new Error('Animation RUM v2 pipeline clock returned an invalid date')
        }
        const observedAt = observedAtDate.toISOString()
        const from = new Date(observedAtDate.getTime() - ANIMATION_RUM_V2_PIPELINE_LIMITS.lookbackSeconds * 1_000).toISOString()
        const projectionCutoff = new Date(
            observedAtDate.getTime() - ANIMATION_RUM_V2_PIPELINE_LIMITS.projectionGraceSeconds * 1_000
        ).getTime()

        const [receiptRows, pendingRows, quarantinedRows] = await Promise.all([
            this.readRecentReceipts(appId, userId, from),
            this.readPendingOutbox(appId, userId, observedAt),
            this.readRecentQuarantinedOutbox(appId, userId, from),
        ])

        const receiptTruncated = receiptRows.length > ANIMATION_RUM_V2_PIPELINE_LIMITS.comparisonLimit
        const retainedReceipts = receiptRows.slice(0, ANIMATION_RUM_V2_PIPELINE_LIMITS.comparisonLimit)
        const byState: Record<DeliveryState, number> = { pending: 0, published: 0, persisted: 0, quarantined: 0 }
        let latestTransitionAt: string | null = null
        let statePairMismatch = 0
        const candidates: ProjectionCandidate[] = []

        for (const row of retainedReceipts) {
            const deliveryState = closedValue(row.deliveryState, DELIVERY_STATES)
            const outboxState = row.outboxState === null ? null : closedValue(row.outboxState, OUTBOX_STATES)
            const updatedAt = isoTimestamp(row.updatedAt)
            if (!deliveryState || (row.outboxState !== null && !outboxState) || !updatedAt) {
                statePairMismatch += 1
                continue
            }

            byState[deliveryState] += 1
            if (!latestTransitionAt || updatedAt > latestTransitionAt) latestTransitionAt = updatedAt
            if (outboxState !== expectedOutboxState(deliveryState)) statePairMismatch += 1

            if (deliveryState !== 'published' && deliveryState !== 'persisted') continue
            const transitionedAt = isoTimestamp(deliveryState === 'published' ? row.publishedAt : row.persistedAt)
            const captureId = typeof row.captureId === 'string' && CAPTURE_ID_PATTERN.test(row.captureId) ? row.captureId : null
            const eventId = typeof row.eventId === 'string' && EVENT_ID_PATTERN.test(row.eventId) ? row.eventId : null
            if (!transitionedAt || !captureId || !eventId) {
                statePairMismatch += 1
                continue
            }
            if (Date.parse(transitionedAt) <= projectionCutoff) candidates.push({ captureId, eventId })
        }

        const pending = this.outboxAggregate(pendingRows[0])
        const recentQuarantined = boundedCount(quarantinedRows[0]?.count)
        if (!pending.valid || !recentQuarantined.valid) statePairMismatch += 1
        const boundedStatePairMismatch = Math.min(statePairMismatch, ANIMATION_RUM_V2_PIPELINE_LIMITS.comparisonLimit)

        const projection = await this.readProjection(appId, candidates)
        const comparisonTruncated = receiptTruncated
        const status = this.status({
            observedAt: observedAtDate.getTime(),
            recentReceiptCount: retainedReceipts.length,
            receiptTruncated,
            statePairMismatch: boundedStatePairMismatch,
            recentReceiptQuarantined: byState.quarantined,
            recentOutboxQuarantined: recentQuarantined.count,
            pending,
            eligibleCount: candidates.length,
            projection,
        })

        return {
            diagnosticSchemaVersion: 1 as const,
            rumContractVersion: 2 as const,
            observedAt,
            status,
            window: { ...ANIMATION_RUM_V2_PIPELINE_LIMITS },
            receipts: {
                recent: { count: retainedReceipts.length, truncated: receiptTruncated },
                byState,
                latestTransitionAt,
                statePairMismatch: boundedStatePairMismatch,
            },
            outbox: {
                pending: pending.pending,
                due: pending.due,
                retrying: pending.retrying,
                leased: pending.leased,
                oldestPendingAt: pending.oldestPendingAt,
                maxAttemptCount: pending.maxAttemptCount,
                recentQuarantined: { count: recentQuarantined.count, truncated: recentQuarantined.truncated },
            },
            projection: {
                availability: projection.availability,
                eligible: { count: candidates.length, truncated: comparisonTruncated },
                matched: projection.matched,
                storageComplete: projection.storageComplete,
                missingAfterGrace: projection.missingAfterGrace,
                identityMismatch: projection.identityMismatch,
                childCountMismatch: projection.childCountMismatch,
                childIdentityMismatch: projection.childIdentityMismatch,
            },
            semantics: {
                publishedMeans: 'kafka-broker-ack-only' as const,
                projectedMeans: 'clickhouse-capture-completion-marker' as const,
                diagnosticMeans: 'bounded-inference-not-worker-health' as const,
            },
        }
    }

    private readRecentReceipts(appId: string, userId: number, from: string): Promise<ReceiptActivityRow[]> {
        return this.dataSource.query<ReceiptActivityRow[]>(
            `
                SELECT receipt.capture_id AS "captureId",
                       receipt.event_id AS "eventId",
                       receipt.delivery_state AS "deliveryState",
                       receipt.updated_at AS "updatedAt",
                       receipt.published_at AS "publishedAt",
                       receipt.persisted_at AS "persistedAt",
                       outbox.state AS "outboxState"
                FROM public.animation_rum_v2_capture_receipt AS receipt
                INNER JOIN public.application AS application
                    ON application.id = receipt.application_id
                LEFT JOIN public.animation_rum_v2_outbox AS outbox
                    ON outbox.application_id = receipt.application_id
                   AND outbox.capture_id = receipt.capture_id
                WHERE application."appId" = $1
                  AND application."userId" = $2
                  AND application."isDelete" = false
                  AND receipt.updated_at >= $3::timestamptz
                ORDER BY receipt.updated_at DESC, receipt.capture_id
                LIMIT ${DATABASE_ROW_LIMIT}
            `,
            [appId, userId, from]
        )
    }

    private readPendingOutbox(appId: string, userId: number, observedAt: string): Promise<OutboxAggregateRow[]> {
        return this.dataSource.query<OutboxAggregateRow[]>(
            `
                WITH bounded AS MATERIALIZED (
                    SELECT outbox.created_at,
                           outbox.attempt_count,
                           outbox.next_attempt_at,
                           outbox.lease_until
                    FROM public.animation_rum_v2_outbox AS outbox
                    INNER JOIN public.application AS application
                        ON application.id = outbox.application_id
                    WHERE application."appId" = $1
                      AND application."userId" = $2
                      AND application."isDelete" = false
                      AND outbox.state = 'pending'
                    ORDER BY outbox.app_sequence
                    LIMIT ${DATABASE_ROW_LIMIT}
                )
                SELECT count(*)::text AS count,
                       count(*) FILTER (
                           WHERE next_attempt_at <= $3::timestamptz
                             AND (lease_until IS NULL OR lease_until <= $3::timestamptz)
                       )::text AS due,
                       count(*) FILTER (WHERE attempt_count > 0)::text AS retrying,
                       count(*) FILTER (WHERE lease_until > $3::timestamptz)::text AS leased,
                       min(created_at) AS "oldestPendingAt",
                       max(attempt_count)::text AS "maxAttemptCount"
                FROM bounded
            `,
            [appId, userId, observedAt]
        )
    }

    private readRecentQuarantinedOutbox(appId: string, userId: number, from: string): Promise<CountAggregateRow[]> {
        return this.dataSource.query<CountAggregateRow[]>(
            `
                WITH bounded AS MATERIALIZED (
                    SELECT outbox.id
                    FROM public.animation_rum_v2_outbox AS outbox
                    INNER JOIN public.application AS application
                        ON application.id = outbox.application_id
                    WHERE application."appId" = $1
                      AND application."userId" = $2
                      AND application."isDelete" = false
                      AND outbox.state = 'quarantined'
                      AND outbox.updated_at >= $3::timestamptz
                    ORDER BY outbox.updated_at DESC, outbox.app_sequence
                    LIMIT ${DATABASE_ROW_LIMIT}
                )
                SELECT count(*)::text AS count
                FROM bounded
            `,
            [appId, userId, from]
        )
    }

    private outboxAggregate(row: OutboxAggregateRow | undefined): OutboxAggregate {
        const count = boundedCount(row?.count)
        const due = safeInteger(row?.due, DATABASE_ROW_LIMIT)
        const retrying = safeInteger(row?.retrying, DATABASE_ROW_LIMIT)
        const leased = safeInteger(row?.leased, DATABASE_ROW_LIMIT)
        const maxAttemptCount = row?.maxAttemptCount === null ? null : safeInteger(row?.maxAttemptCount, 32_767)
        const oldestPendingAt = row?.oldestPendingAt === null ? null : isoTimestamp(row?.oldestPendingAt)
        const boundedDue = Math.min(due ?? 0, ANIMATION_RUM_V2_PIPELINE_LIMITS.comparisonLimit)
        const boundedRetrying = Math.min(retrying ?? 0, ANIMATION_RUM_V2_PIPELINE_LIMITS.comparisonLimit)
        const boundedLeased = Math.min(leased ?? 0, ANIMATION_RUM_V2_PIPELINE_LIMITS.comparisonLimit)
        const valid =
            count.valid &&
            due !== null &&
            retrying !== null &&
            leased !== null &&
            boundedDue <= count.count &&
            boundedRetrying <= count.count &&
            boundedLeased <= count.count &&
            (count.count === 0
                ? maxAttemptCount === null && oldestPendingAt === null
                : maxAttemptCount !== null && oldestPendingAt !== null)

        return {
            pending: { count: count.count, truncated: count.truncated },
            due: Math.min(boundedDue, count.count),
            retrying: Math.min(boundedRetrying, count.count),
            leased: Math.min(boundedLeased, count.count),
            oldestPendingAt,
            maxAttemptCount,
            valid,
        }
    }

    private async readProjection(appId: string, candidates: ProjectionCandidate[]): Promise<ProjectionView> {
        if (candidates.length === 0) {
            return {
                availability: 'not-checked',
                matched: null,
                storageComplete: null,
                missingAfterGrace: null,
                identityMismatch: null,
                childCountMismatch: null,
                childIdentityMismatch: null,
            }
        }

        const expected = new Map(candidates.map(candidate => [candidate.captureId, candidate.eventId] as const))
        try {
            const result = await this.clickhouse.query({
                query: `
                    WITH ${createAnimationRumV2ProjectionSql({
                        database: this.database,
                        selectedCaptureMarkersSql: `
                            SELECT app_id,
                                   capture_id,
                                   event_id,
                                   scope,
                                   metric_count,
                                   provider_evidence_count
                            FROM ${this.database}.animation_rum_captures_v2 FINAL
                            WHERE app_id = {appId:String}
                              AND capture_id IN {captureIds:Array(String)}
                        `,
                    })}
                    SELECT capture_id AS capture_id,
                           event_id AS event_id,
                           scope AS scope,
                           metric_count AS metric_count,
                           provider_evidence_count AS provider_evidence_count,
                           projection_observed_metric_count AS projection_observed_metric_count,
                           projection_matching_metric_count AS projection_matching_metric_count,
                           projection_mismatched_metric_identity_count AS projection_mismatched_metric_identity_count,
                           projection_observed_provider_evidence_count AS projection_observed_provider_evidence_count,
                           projection_matching_provider_evidence_count AS projection_matching_provider_evidence_count,
                           projection_mismatched_provider_identity_count AS projection_mismatched_provider_identity_count
                    FROM projection_checked_captures
                    ORDER BY capture_id
                    LIMIT ${ANIMATION_RUM_V2_PIPELINE_LIMITS.comparisonLimit}
                `,
                query_params: { appId, captureIds: candidates.map(candidate => candidate.captureId) },
                format: 'JSON',
                clickhouse_settings: CLICKHOUSE_READ_SETTINGS,
            })
            const json = (await result.json()) as { data?: ProjectionRow[] }
            if (!Array.isArray(json.data)) throw new Error('Invalid ClickHouse pipeline diagnostic response')

            const seen = new Set<string>()
            let matched = 0
            let storageComplete = 0
            let identityMismatch = 0
            let childCountMismatch = 0
            let childIdentityMismatch = 0
            for (const row of json.data) {
                const captureId = typeof row.capture_id === 'string' ? row.capture_id : null
                const eventId = typeof row.event_id === 'string' ? row.event_id : null
                if (!captureId || !expected.has(captureId) || seen.has(captureId)) {
                    throw new Error('Invalid ClickHouse pipeline projection identity set')
                }
                seen.add(captureId)
                if (!eventId || expected.get(captureId) !== eventId) {
                    identityMismatch += 1
                    continue
                }

                matched += 1
                const scope = row.scope === 'page' || row.scope === 'target' ? row.scope : null
                const expectedMetricCount = safeInteger(row.metric_count, CLICKHOUSE_CAPTURE_CHILD_LIMITS.metrics)
                const expectedProviderEvidenceCount = safeInteger(
                    row.provider_evidence_count,
                    CLICKHOUSE_CAPTURE_CHILD_LIMITS.providerEvidence
                )
                const observedMetricCount = safeInteger(row.projection_observed_metric_count, CLICKHOUSE_MAX_ROWS_TO_READ)
                const matchingMetricCount = safeInteger(row.projection_matching_metric_count, CLICKHOUSE_MAX_ROWS_TO_READ)
                const mismatchedMetricIdentityCount = safeInteger(
                    row.projection_mismatched_metric_identity_count,
                    CLICKHOUSE_MAX_ROWS_TO_READ
                )
                const observedProviderEvidenceCount = safeInteger(
                    row.projection_observed_provider_evidence_count,
                    CLICKHOUSE_MAX_ROWS_TO_READ
                )
                const matchingProviderEvidenceCount = safeInteger(
                    row.projection_matching_provider_evidence_count,
                    CLICKHOUSE_MAX_ROWS_TO_READ
                )
                const mismatchedProviderIdentityCount = safeInteger(
                    row.projection_mismatched_provider_identity_count,
                    CLICKHOUSE_MAX_ROWS_TO_READ
                )

                const childCounts = {
                    expectedMetricCount,
                    expectedProviderEvidenceCount,
                    observedMetricCount,
                    matchingMetricCount,
                    mismatchedMetricIdentityCount,
                    observedProviderEvidenceCount,
                    matchingProviderEvidenceCount,
                    mismatchedProviderIdentityCount,
                }
                const hasInvalidCount = Object.values(childCounts).some(value => value === null)
                const hasChildIdentityMismatch =
                    scope === null ||
                    hasInvalidCount ||
                    mismatchedMetricIdentityCount !== 0 ||
                    mismatchedProviderIdentityCount !== 0 ||
                    observedMetricCount !== Number(matchingMetricCount) + Number(mismatchedMetricIdentityCount) ||
                    observedProviderEvidenceCount !== Number(matchingProviderEvidenceCount) + Number(mismatchedProviderIdentityCount)
                if (hasChildIdentityMismatch) {
                    childIdentityMismatch += 1
                    continue
                }

                if (matchingMetricCount !== expectedMetricCount || matchingProviderEvidenceCount !== expectedProviderEvidenceCount) {
                    childCountMismatch += 1
                    continue
                }
                storageComplete += 1
            }

            return {
                availability: 'available',
                matched,
                storageComplete,
                missingAfterGrace: expected.size - seen.size,
                identityMismatch,
                childCountMismatch,
                childIdentityMismatch,
            }
        } catch {
            // Never expose connection details, SQL, ClickHouse errors, or raw
            // rows through this authenticated diagnostic response.
            return {
                availability: 'unavailable',
                matched: null,
                storageComplete: null,
                missingAfterGrace: null,
                identityMismatch: null,
                childCountMismatch: null,
                childIdentityMismatch: null,
            }
        }
    }

    private status(input: {
        observedAt: number
        recentReceiptCount: number
        receiptTruncated: boolean
        statePairMismatch: number
        recentReceiptQuarantined: number
        recentOutboxQuarantined: number
        pending: OutboxAggregate
        eligibleCount: number
        projection: ProjectionView
    }): PipelineStatus {
        if (
            input.statePairMismatch > 0 ||
            (input.projection.identityMismatch ?? 0) > 0 ||
            (input.projection.childCountMismatch ?? 0) > 0 ||
            (input.projection.childIdentityMismatch ?? 0) > 0 ||
            (input.projection.availability === 'available' && input.projection.storageComplete !== input.projection.matched)
        )
            return 'inconsistent'
        if (input.recentReceiptQuarantined > 0 || input.recentOutboxQuarantined > 0) return 'quarantined'

        const oldestPendingAt = input.pending.oldestPendingAt ? Date.parse(input.pending.oldestPendingAt) : Number.NaN
        const stalePending =
            input.pending.pending.count > 0 &&
            Number.isFinite(oldestPendingAt) &&
            input.observedAt - oldestPendingAt > ANIMATION_RUM_V2_PIPELINE_LIMITS.outboxDelaySeconds * 1_000
        if (stalePending || (input.projection.missingAfterGrace ?? 0) > 0) return 'delayed'

        if (input.receiptTruncated || (input.eligibleCount > 0 && input.projection.availability === 'unavailable')) return 'unknown'
        if (input.recentReceiptCount === 0 && input.pending.pending.count === 0) return 'idle'
        if (input.eligibleCount === 0) return 'in-flight'
        return 'healthy'
    }
}
