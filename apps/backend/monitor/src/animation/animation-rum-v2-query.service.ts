import { ClickHouseClient, QueryParams } from '@clickhouse/client'
import {
    ANIMATION_RUM_FAMILIES,
    ANIMATION_RUM_V2_CAPABILITIES,
    ANIMATION_RUM_V2_CONTRACT_VERSION,
    ANIMATION_RUM_V2_METRIC_CATALOG,
    ANIMATION_RUM_V2_PER_MINUTE_METRIC_IDS,
    ANIMATION_RUM_V2_PROVIDER_OWNERS,
    ANIMATION_RUM_V2_QUALITY_REASONS,
    ANIMATION_RUM_V2_SNAPSHOT_SCHEMA_VERSION,
    getAnimationRumV2MetricDefinition,
    isAnimationRumV2RouteKey,
    isAnimationRumV2TargetKey,
} from '@condev-monitor/animation-rum-contract'
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { ApplicationService } from '../application/application.service'
import { resolveClickhouseDatabase } from '../shared/clickhouse-utils'
import { createAnimationRumV2ProjectionSql } from './animation-rum-v2-projection-sql'
import { AnimationRumV2CapturesQueryDto, AnimationRumV2QueryDto } from './dto/animation-rum-v2-query.dto'

type QueryInput = AnimationRumV2QueryDto & { limit?: number; offset?: number }

type NormalizedQuery = {
    appId: string
    from: Date
    to: Date
    scope?: 'page' | 'target'
    release?: string
    dist?: string
    environment?: string
    routeKey?: string
    targetKey?: string
    runtimeFramework?: string
    runtimeRenderer?: string
    runtimeBackend?: string
    limit: number
    offset: number
    retentionClamped: boolean
}

type TrendBucket = {
    kind: 'hour' | 'six-hours' | 'day'
    durationMs: number
    maximumPoints: number
}

type JsonInteger = number | string | null

type TrendMetric = {
    statusCounts: {
        measured: JsonInteger
        partial: JsonInteger
        notObserved: JsonInteger
        notInstrumented: JsonInteger
        unsupported: JsonInteger
        unknown: JsonInteger
    }
    measuredCaptures: JsonInteger
    partialCaptures: JsonInteger
    excludedPartialCaptures: JsonInteger
    captureValue: { p50: number | null; p75: number | null; p95: number | null }
}

type TrendPoint = {
    at: string
    observedCaptures: JsonInteger
    pageCaptures: JsonInteger
    targetCaptures: JsonInteger
    frameP95: { page: TrendMetric | null; target: TrendMetric | null }
    gpuFrameP95: { page: TrendMetric | null; target: TrendMetric | null }
}

const RETENTION_DAYS = 90
const MAX_WINDOW_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
const MIN_NORMALIZED_WINDOW_MS = 5_000
const READ_QUERY_SETTINGS = Object.freeze({
    max_execution_time: 15,
    max_result_rows: '10000',
    result_overflow_mode: 'throw' as const,
    max_rows_to_read: '5000000',
    max_memory_usage: '536870912',
    max_threads: 4,
})

const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/
const CAPTURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/
const DEPLOYMENT_VALUE_PATTERN = /^(?:|[A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/
const VERSION_PATTERN = /^(?:|[A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/
const PROVIDER_VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z][a-z0-9.-]{0,23})?$/

const SCOPES = new Set(['page', 'target'])
const RELATIONS = new Set(['page-window', 'target-direct', 'target-temporal-overlap', 'adapter'])
const METRIC_STATUSES = new Set(['measured', 'partial', 'not-observed', 'not-instrumented', 'unsupported', 'unknown'])
const CAPABILITY_STATES = new Set(['supported', 'unsupported', 'unknown', 'disabled'])
const EVIDENCE_LEVELS = new Set(['runtime-observation', 'unsupported-or-unknown'])
const VISIBILITY_STATES = new Set(['visible', 'hidden', 'prerender', 'unknown'])
const VIEWPORT_BUCKETS = new Set(['tiny', 'small', 'medium', 'large', 'xlarge', 'unknown'])
const DPR_BUCKETS = new Set(['1', '1.5', '2', '3', '4+', 'unknown'])
const REFRESH_SOURCES = new Set(['explicit', 'inferred', 'observed', 'unknown'])
const REFRESH_CONFIDENCES = new Set(['explicit', 'high', 'medium', 'low', 'unknown'])
const FRAMEWORKS = new Set(['vanilla', 'react', 'preact', 'vue', 'angular', 'svelte', 'solid', 'qwik', 'lit', 'mixed', 'other', 'unknown'])
const RENDERERS = new Set(['dom', 'svg', 'canvas', 'mixed', 'other', 'unknown'])
const BACKENDS = new Set(['dom', 'canvas2d', 'webgl', 'webgl2', 'webgpu', 'mixed', 'other', 'unknown'])
const QUALITY_REASON_SET = new Set<string>(ANIMATION_RUM_V2_QUALITY_REASONS)
const FAMILY_SET = new Set<string>(ANIMATION_RUM_FAMILIES)
const PROVIDER_OWNER_SET = new Set<string>(ANIMATION_RUM_V2_PROVIDER_OWNERS)
const NORMALIZABLE_METRIC_IDS: string[] = [...ANIMATION_RUM_V2_PER_MINUTE_METRIC_IDS]

const CAPTURE_COLUMNS = `
    event_id, capture_id, parent_capture_id, scope, contract_version, snapshot_schema_version,
    captured_at, received_at, release, dist, environment, sdk_version, monitor_version,
    sample_rate, sampling_policy_version, route_key, target_key, visibility_state,
    reduced_motion, viewport_bucket, dpr_bucket, refresh_hz, refresh_budget_source,
    refresh_budget_confidence, window_duration_ms, window_duration_capped,
    runtime_framework, runtime_renderer, runtime_backend, capabilities_json, coverage_json,
    capture_sufficiency, capture_integrity, capture_quality_reasons, adapter_error_count,
    provider_evidence_count, metric_count
`

const PROJECTION_COUNT_COLUMNS = `
    projection_observed_metric_count, projection_matching_metric_count,
    projection_mismatched_metric_identity_count,
    projection_observed_provider_evidence_count, projection_matching_provider_evidence_count,
    projection_mismatched_provider_identity_count, projection_complete
`

function clickhouseTime(date: Date): string {
    return date.toISOString().replace('T', ' ').replace('Z', '')
}

function clickhouseUtcIso(value: unknown): string | null {
    const raw = String(value ?? '').trim()
    const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw
    const date = new Date(normalized)
    return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function recordFromJson(value: unknown): Record<string, unknown> {
    if (typeof value !== 'string' || value.length > 64 * 1024) return {}
    try {
        const parsed = JSON.parse(value) as unknown
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
        return {}
    }
}

function finiteNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null
    const number = Number(value)
    return Number.isFinite(number) ? number : null
}

function safeInteger(value: unknown): number | null {
    const number = finiteNumber(value)
    return number !== null && Number.isSafeInteger(number) && number >= 0 ? number : null
}

function jsonInteger(value: unknown): number | string | null {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
    const canonical = value.replace(/^0+(?=\d)/, '')
    const integer = BigInt(canonical)
    return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : canonical
}

function jsonIntegerOrZero(value: unknown): number | string | null {
    if (value === null || value === undefined || value === '') return 0
    return jsonInteger(value)
}

function integerIsPositive(value: number | string | null): boolean {
    if (typeof value === 'number') return value > 0
    return typeof value === 'string' && BigInt(value) > 0n
}

function jsonIntegerBigInt(value: JsonInteger): bigint | null {
    if (typeof value === 'number') return BigInt(value)
    return typeof value === 'string' ? BigInt(value) : null
}

function closedString(value: unknown, allowed: Set<string>, fallback: string): string {
    const candidate = typeof value === 'string' ? value : ''
    return allowed.has(candidate) ? candidate : fallback
}

function boundedString(value: unknown, maximum: number, pattern: RegExp, fallback = ''): string {
    const candidate = typeof value === 'string' ? value : ''
    return candidate.length <= maximum && pattern.test(candidate) ? candidate : fallback
}

function metricBindingIsValid(metricId: string, scope: string, relation: string, owner: string): boolean {
    const definition = getAnimationRumV2MetricDefinition(metricId)
    return Boolean(
        definition?.bindings.some(
            binding => binding.scope === scope && binding.relation === relation && binding.owners.some(candidate => candidate === owner)
        )
    )
}

@Injectable()
export class AnimationRumV2QueryService {
    private readonly database: string

    constructor(
        @Inject('CLICKHOUSE_CLIENT') private readonly clickhouse: ClickHouseClient,
        config: ConfigService,
        private readonly applications: ApplicationService
    ) {
        this.database = resolveClickhouseDatabase(config)
    }

    private readQuery(params: QueryParams) {
        return this.clickhouse.query({
            ...params,
            format: 'JSON' as const,
            clickhouse_settings: {
                ...params.clickhouse_settings,
                ...READ_QUERY_SETTINGS,
            },
        })
    }

    async summary(userId: number, input: AnimationRumV2QueryDto) {
        const query = await this.authorizedQuery(userId, input)
        const filter = this.captureFilterSql(query)
        const queryParams = this.queryParams(query)

        const trendBucket = this.trendBucket(query)
        const projectionSql = this.projectionSql(`
            SELECT app_id, ${CAPTURE_COLUMNS}
            FROM ${this.database}.animation_rum_captures_v2 FINAL
            WHERE ${filter}
        `)
        const verifiedProjectionSql = `${projectionSql},
            verified_captures AS (
                SELECT *
                FROM projection_checked_captures
                WHERE projection_complete = 1
            )`
        const [captureResult, metricResult, qualityReasonResult, captureTrendResult, metricTrendResult] = await Promise.all([
            this.readQuery({
                query: `
                    WITH ${projectionSql}
                    SELECT
                        countIf(projection_complete = 1) AS observed_capture_count,
                        countIf(projection_complete = 1 AND scope = 'page') AS page_capture_count,
                        countIf(projection_complete = 1 AND scope = 'target') AS target_capture_count,
                        countIf(projection_complete = 1 AND capture_sufficiency = 'sufficient') AS sufficient_capture_count,
                        countIf(projection_complete = 1 AND capture_sufficiency = 'insufficient') AS insufficient_capture_count,
                        countIf(projection_complete = 1 AND capture_integrity = 'complete') AS complete_capture_count,
                        countIf(projection_complete = 1 AND capture_integrity = 'partial') AS partial_capture_count,
                        countIf(projection_complete = 1 AND window_duration_capped = 1) AS capped_capture_count,
                        countIf(projection_complete = 1 AND scope = 'page' AND capture_sufficiency = 'sufficient')
                            AS page_sufficient_capture_count,
                        countIf(projection_complete = 1 AND scope = 'page' AND capture_sufficiency = 'insufficient')
                            AS page_insufficient_capture_count,
                        countIf(projection_complete = 1 AND scope = 'page' AND capture_integrity = 'complete')
                            AS page_complete_capture_count,
                        countIf(projection_complete = 1 AND scope = 'page' AND capture_integrity = 'partial')
                            AS page_partial_capture_count,
                        countIf(projection_complete = 1 AND scope = 'page' AND window_duration_capped = 1)
                            AS page_capped_capture_count,
                        countIf(projection_complete = 1 AND scope = 'target' AND capture_sufficiency = 'sufficient')
                            AS target_sufficient_capture_count,
                        countIf(projection_complete = 1 AND scope = 'target' AND capture_sufficiency = 'insufficient')
                            AS target_insufficient_capture_count,
                        countIf(projection_complete = 1 AND scope = 'target' AND capture_integrity = 'complete')
                            AS target_complete_capture_count,
                        countIf(projection_complete = 1 AND scope = 'target' AND capture_integrity = 'partial')
                            AS target_partial_capture_count,
                        countIf(projection_complete = 1 AND scope = 'target' AND window_duration_capped = 1)
                            AS target_capped_capture_count,
                        uniqExactIf(route_key, projection_complete = 1 AND route_key != '') AS distinct_route_count,
                        uniqExactIf(target_key, projection_complete = 1 AND target_key != '') AS distinct_target_count,
                        sumIf(adapter_error_count, projection_complete = 1) AS total_adapter_error_count,
                        sumIf(adapter_error_count, projection_complete = 1 AND scope = 'page') AS page_adapter_error_count,
                        sumIf(adapter_error_count, projection_complete = 1 AND scope = 'target') AS target_adapter_error_count,
                        minOrNullIf(captured_at, projection_complete = 1) AS first_captured_at,
                        maxOrNullIf(captured_at, projection_complete = 1) AS last_captured_at,
                        count() AS projection_completion_marker_count,
                        countIf(projection_complete = 1) AS projection_verified_count,
                        countIf(projection_complete = 0) AS projection_mismatched_count,
                        countIf(projection_complete = 0) AS projection_excluded_from_analytics_count,
                        countIf(projection_observed_metric_count != toUInt64(metric_count))
                            AS projection_metric_count_mismatch_count,
                        countIf(projection_observed_provider_evidence_count != toUInt64(provider_evidence_count))
                            AS projection_provider_count_mismatch_count,
                        countIf(
                            projection_mismatched_metric_identity_count > 0 OR
                            projection_mismatched_provider_identity_count > 0
                        ) AS projection_child_identity_mismatch_count
                    FROM projection_checked_captures
                `,
                query_params: queryParams,
                format: 'JSON',
            }),
            this.readQuery({
                query: `
                    WITH ${verifiedProjectionSql},
                    completed_captures AS (
                        SELECT app_id, event_id, capture_id, scope, window_duration_ms, window_duration_capped
                        FROM verified_captures
                    )
                    SELECT
                        scope, metric_id, relation, owner,
                        count() AS capture_count,
                        countIf(status = 'measured') AS measured_capture_count,
                        countIf(status = 'partial') AS partial_capture_count,
                        countIf(status = 'not-observed') AS not_observed_capture_count,
                        countIf(status = 'not-instrumented') AS not_instrumented_capture_count,
                        countIf(status = 'unsupported') AS unsupported_capture_count,
                        countIf(status = 'unknown') AS unknown_capture_count,
                        countIf(value IS NOT NULL) AS captures_with_value,
                        countIf(status = 'measured' AND value IS NOT NULL) AS measured_captures_with_value,
                        countIf(status = 'partial' AND value IS NOT NULL) AS partial_captures_with_value,
                        sum(ifNull(samples, 0)) AS reported_samples,
                        sumIf(ifNull(samples, 0), status = 'measured') AS measured_reported_samples,
                        sumIf(ifNull(samples, 0), status = 'partial') AS partial_reported_samples,
                        avgIf(assumeNotNull(value), status = 'measured' AND value IS NOT NULL) AS capture_value_avg,
                        quantileTDigestIf(0.50)(assumeNotNull(value), status = 'measured' AND value IS NOT NULL) AS capture_value_p50,
                        quantileTDigestIf(0.75)(assumeNotNull(value), status = 'measured' AND value IS NOT NULL) AS capture_value_p75,
                        quantileTDigestIf(0.95)(assumeNotNull(value), status = 'measured' AND value IS NOT NULL) AS capture_value_p95,
                        minIf(assumeNotNull(value), status = 'measured' AND value IS NOT NULL) AS capture_value_min,
                        maxIf(assumeNotNull(value), status = 'measured' AND value IS NOT NULL) AS capture_value_max,
                        countIf(value_per_minute IS NOT NULL) AS normalized_captures_with_value,
                        avgIf(assumeNotNull(value_per_minute), value_per_minute IS NOT NULL) AS value_per_minute_avg,
                        quantileTDigestIf(0.50)(assumeNotNull(value_per_minute), value_per_minute IS NOT NULL) AS value_per_minute_p50,
                        quantileTDigestIf(0.75)(assumeNotNull(value_per_minute), value_per_minute IS NOT NULL) AS value_per_minute_p75,
                        quantileTDigestIf(0.95)(assumeNotNull(value_per_minute), value_per_minute IS NOT NULL) AS value_per_minute_p95,
                        minIf(assumeNotNull(value_per_minute), value_per_minute IS NOT NULL) AS value_per_minute_min,
                        maxIf(assumeNotNull(value_per_minute), value_per_minute IS NOT NULL) AS value_per_minute_max
                    FROM (
                        SELECT
                            metric.scope, metric.metric_id, metric.relation, metric.owner,
                            metric.value, metric.samples, metric.status,
                            multiIf(
                                metric.value IS NULL,
                                CAST(NULL AS Nullable(Float64)),
                                metric.metric_id NOT IN {normalizableMetricIds:Array(String)},
                                CAST(NULL AS Nullable(Float64)),
                                metric.status != 'measured',
                                CAST(NULL AS Nullable(Float64)),
                                capture.window_duration_ms < ${MIN_NORMALIZED_WINDOW_MS} OR capture.window_duration_capped = 1,
                                CAST(NULL AS Nullable(Float64)),
                                assumeNotNull(metric.value) * 60000 /
                                    greatest(capture.window_duration_ms, ${MIN_NORMALIZED_WINDOW_MS})
                            ) AS value_per_minute
                        FROM (
                            SELECT event_id, capture_id, scope, metric_id, relation, owner, value, samples, status
                            FROM ${this.database}.animation_rum_metrics_v2 FINAL
                            WHERE (app_id, capture_id) IN (
                                SELECT app_id, capture_id
                                FROM completed_captures
                            )
                        ) AS metric
                        INNER JOIN completed_captures AS capture
                            ON metric.capture_id = capture.capture_id
                           AND metric.event_id = capture.event_id
                           AND metric.scope = capture.scope
                    )
                    GROUP BY scope, metric_id, relation, owner
                    ORDER BY metric_id, scope, relation, owner
                `,
                query_params: { ...queryParams, normalizableMetricIds: NORMALIZABLE_METRIC_IDS },
                format: 'JSON',
            }),
            this.readQuery({
                query: `
                    WITH ${verifiedProjectionSql}
                    SELECT
                        reason,
                        count() AS capture_count,
                        countIf(scope = 'page') AS page_capture_count,
                        countIf(scope = 'target') AS target_capture_count
                    FROM (
                        SELECT scope, arrayJoin(capture_quality_reasons) AS reason
                        FROM verified_captures
                    )
                    WHERE reason IN {qualityReasons:Array(String)}
                    GROUP BY reason
                    ORDER BY reason
                `,
                query_params: { ...queryParams, qualityReasons: [...ANIMATION_RUM_V2_QUALITY_REASONS] },
                format: 'JSON',
            }),
            this.readQuery({
                query: `
                    WITH ${verifiedProjectionSql}
                    SELECT
                        ${this.trendBucketSql('captured_at', trendBucket.kind)} AS bucket,
                        count() AS observed_capture_count,
                        countIf(scope = 'page') AS page_capture_count,
                        countIf(scope = 'target') AS target_capture_count
                    FROM verified_captures
                    GROUP BY bucket
                    ORDER BY bucket
                `,
                query_params: queryParams,
                format: 'JSON',
            }),
            this.readQuery({
                query: `
                    WITH ${verifiedProjectionSql},
                    completed_captures AS (
                        SELECT app_id, event_id, capture_id, scope, captured_at
                        FROM verified_captures
                    )
                    SELECT
                        ${this.trendBucketSql('capture.captured_at', trendBucket.kind)} AS bucket,
                        metric.metric_id,
                        metric.scope,
                        countIf(metric.status = 'measured') AS measured_capture_count,
                        countIf(metric.status = 'partial') AS partial_capture_count,
                        countIf(metric.status = 'not-observed') AS not_observed_capture_count,
                        countIf(metric.status = 'not-instrumented') AS not_instrumented_capture_count,
                        countIf(metric.status = 'unsupported') AS unsupported_capture_count,
                        countIf(metric.status = 'unknown') AS unknown_capture_count,
                        countIf(metric.status = 'measured' AND metric.value IS NOT NULL) AS measured_captures_with_value,
                        countIf(metric.status = 'partial' AND metric.value IS NOT NULL) AS partial_captures_with_value,
                        quantileTDigestIf(0.50)(
                            assumeNotNull(metric.value), metric.status = 'measured' AND metric.value IS NOT NULL
                        ) AS capture_value_p50,
                        quantileTDigestIf(0.75)(
                            assumeNotNull(metric.value), metric.status = 'measured' AND metric.value IS NOT NULL
                        ) AS capture_value_p75,
                        quantileTDigestIf(0.95)(
                            assumeNotNull(metric.value), metric.status = 'measured' AND metric.value IS NOT NULL
                        ) AS capture_value_p95
                    FROM (
                        SELECT event_id, capture_id, metric_id, scope, relation, owner, value, status
                        FROM ${this.database}.animation_rum_metrics_v2 FINAL
                        WHERE (app_id, capture_id) IN (
                            SELECT app_id, capture_id
                            FROM completed_captures
                        )
                          AND (
                              (
                                  metric_id = {frameP95MetricId:String}
                                  AND owner = {frameP95Owner:String}
                                  AND (
                                      (scope = 'page' AND relation = {frameP95PageRelation:String}) OR
                                      (scope = 'target' AND relation = {frameP95TargetRelation:String})
                                  )
                              ) OR (
                                  metric_id = {gpuFrameP95MetricId:String}
                                  AND owner = {gpuFrameP95Owner:String}
                                  AND relation = {gpuFrameP95Relation:String}
                                  AND scope IN ('page', 'target')
                              )
                          )
                    ) AS metric
                    INNER JOIN completed_captures AS capture
                        ON metric.capture_id = capture.capture_id
                       AND metric.event_id = capture.event_id
                       AND metric.scope = capture.scope
                    GROUP BY bucket, metric.metric_id, metric.scope
                    ORDER BY bucket, metric.metric_id, metric.scope
                `,
                query_params: {
                    ...queryParams,
                    frameP95MetricId: 'frame.duration.p95',
                    frameP95Owner: 'browser-core',
                    frameP95PageRelation: 'page-window',
                    frameP95TargetRelation: 'target-temporal-overlap',
                    gpuFrameP95MetricId: 'renderer.gpu-frame.p95',
                    gpuFrameP95Owner: 'renderer-adapter',
                    gpuFrameP95Relation: 'adapter',
                },
                format: 'JSON',
            }),
        ])

        const captureJson = (await captureResult.json()) as { data?: Record<string, unknown>[] }
        const metricJson = (await metricResult.json()) as { data?: Record<string, unknown>[] }
        const qualityReasonJson = (await qualityReasonResult.json()) as { data?: Record<string, unknown>[] }
        const captureTrendJson = (await captureTrendResult.json()) as { data?: Record<string, unknown>[] }
        const metricTrendJson = (await metricTrendResult.json()) as { data?: Record<string, unknown>[] }
        const counts = captureJson.data?.[0] ?? {}
        const qualityReasonRows = (qualityReasonJson.data ?? []).filter(row => QUALITY_REASON_SET.has(String(row.reason ?? '')))

        return {
            contractVersion: ANIMATION_RUM_V2_CONTRACT_VERSION,
            snapshotSchemaVersion: ANIMATION_RUM_V2_SNAPSHOT_SCHEMA_VERSION,
            catalogMetricCount: ANIMATION_RUM_V2_METRIC_CATALOG.length,
            retentionDays: RETENTION_DAYS,
            aggregationSemantics: 'distribution-of-capture-aggregates' as const,
            window: this.windowView(query),
            filters: this.filtersView(query),
            projectionIntegrity: this.summaryProjectionIntegrityView(counts),
            captures: {
                observed: jsonIntegerOrZero(counts.observed_capture_count),
                page: jsonIntegerOrZero(counts.page_capture_count),
                target: jsonIntegerOrZero(counts.target_capture_count),
                sufficient: jsonIntegerOrZero(counts.sufficient_capture_count),
                insufficient: jsonIntegerOrZero(counts.insufficient_capture_count),
                complete: jsonIntegerOrZero(counts.complete_capture_count),
                partial: jsonIntegerOrZero(counts.partial_capture_count),
                capped: jsonIntegerOrZero(counts.capped_capture_count),
                byScope: {
                    page: {
                        observed: jsonIntegerOrZero(counts.page_capture_count),
                        sufficient: jsonIntegerOrZero(counts.page_sufficient_capture_count),
                        insufficient: jsonIntegerOrZero(counts.page_insufficient_capture_count),
                        complete: jsonIntegerOrZero(counts.page_complete_capture_count),
                        partial: jsonIntegerOrZero(counts.page_partial_capture_count),
                        capped: jsonIntegerOrZero(counts.page_capped_capture_count),
                        adapterErrors: jsonIntegerOrZero(counts.page_adapter_error_count),
                    },
                    target: {
                        observed: jsonIntegerOrZero(counts.target_capture_count),
                        sufficient: jsonIntegerOrZero(counts.target_sufficient_capture_count),
                        insufficient: jsonIntegerOrZero(counts.target_insufficient_capture_count),
                        complete: jsonIntegerOrZero(counts.target_complete_capture_count),
                        partial: jsonIntegerOrZero(counts.target_partial_capture_count),
                        capped: jsonIntegerOrZero(counts.target_capped_capture_count),
                        adapterErrors: jsonIntegerOrZero(counts.target_adapter_error_count),
                    },
                },
                distinctRoutes: jsonIntegerOrZero(counts.distinct_route_count),
                distinctTargets: jsonIntegerOrZero(counts.distinct_target_count),
                adapterErrors: jsonIntegerOrZero(counts.total_adapter_error_count),
                firstCapturedAt: clickhouseUtcIso(counts.first_captured_at),
                lastCapturedAt: clickhouseUtcIso(counts.last_captured_at),
            },
            qualityReasons: qualityReasonRows.map(row => ({
                reason: String(row.reason),
                captures: jsonIntegerOrZero(row.capture_count),
            })),
            qualityReasonsByScope: {
                page: qualityReasonRows
                    .map(row => ({ reason: String(row.reason), captures: jsonIntegerOrZero(row.page_capture_count) }))
                    .filter(row => row.captures === null || integerIsPositive(row.captures)),
                target: qualityReasonRows
                    .map(row => ({ reason: String(row.reason), captures: jsonIntegerOrZero(row.target_capture_count) }))
                    .filter(row => row.captures === null || integerIsPositive(row.captures)),
            },
            normalization: {
                kind: 'per-minute' as const,
                minimumWindowMs: MIN_NORMALIZED_WINDOW_MS,
                excludesCappedWindows: true,
                requiresMeasuredStatus: true,
                appliesTo: 'closed event-flow count and sum metrics' as const,
            },
            trend: this.trendView(trendBucket, captureTrendJson.data ?? [], metricTrendJson.data ?? []),
            metrics: (metricJson.data ?? []).map(row => this.summaryMetricView(row)).filter(row => row !== null),
        }
    }

    async captures(userId: number, input: AnimationRumV2CapturesQueryDto) {
        const query = await this.authorizedQuery(userId, input)
        const filter = this.captureFilterSql(query)
        const queryParams = this.queryParams(query)
        const projectionSql = this.projectionSql(`
            SELECT app_id, ${CAPTURE_COLUMNS}
            FROM ${this.database}.animation_rum_captures_v2 FINAL
            WHERE ${filter}
        `)
        const [countResult, captureResult] = await Promise.all([
            this.readQuery({
                query: `
                    WITH ${projectionSql}
                    SELECT count() AS capture_count
                    FROM projection_checked_captures
                    WHERE projection_complete = 1
                `,
                query_params: queryParams,
                format: 'JSON',
            }),
            this.readQuery({
                query: `
                    WITH ${projectionSql}
                    SELECT ${CAPTURE_COLUMNS}, ${PROJECTION_COUNT_COLUMNS}
                    FROM projection_checked_captures
                    WHERE projection_complete = 1
                    ORDER BY captured_at DESC, capture_id DESC
                    LIMIT {limit:UInt32} OFFSET {offset:UInt32}
                `,
                query_params: queryParams,
                format: 'JSON',
            }),
        ])

        const countJson = (await countResult.json()) as { data?: Array<{ capture_count?: unknown }> }
        const captureJson = (await captureResult.json()) as { data?: Record<string, unknown>[] }
        const total = jsonIntegerOrZero(countJson.data?.[0]?.capture_count)
        const rows = captureJson.data ?? []
        const captureIds = rows.map(row => boundedString(row.capture_id, 80, CAPTURE_ID_PATTERN)).filter(Boolean)
        const targetCountByParent = new Map<string, JsonInteger>()
        const frameP95ByCapture = new Map<string, NonNullable<ReturnType<AnimationRumV2QueryService['metricView']>>>()
        if (captureIds.length > 0) {
            const [targetCountResult, frameP95Result] = await Promise.all([
                this.readQuery({
                    query: `
                        WITH ${this.projectionSql(`
                            SELECT app_id, ${CAPTURE_COLUMNS}
                            FROM ${this.database}.animation_rum_captures_v2 FINAL
                            WHERE app_id = {appId:String}
                              AND scope = 'target'
                              AND parent_capture_id IN {captureIds:Array(String)}
                        `)}
                        SELECT parent_capture_id, count() AS target_child_count
                        FROM projection_checked_captures
                        WHERE projection_complete = 1
                        GROUP BY parent_capture_id
                    `,
                    query_params: { appId: query.appId, captureIds },
                    format: 'JSON',
                }),
                this.readQuery({
                    query: `
                        WITH ${this.projectionSql(`
                            SELECT app_id, ${CAPTURE_COLUMNS}
                            FROM ${this.database}.animation_rum_captures_v2 FINAL
                            WHERE app_id = {appId:String}
                              AND capture_id IN {captureIds:Array(String)}
                        `)},
                        selected_captures AS (
                            SELECT app_id, event_id, capture_id, scope
                            FROM projection_checked_captures
                            WHERE projection_complete = 1
                        )
                        SELECT metric.capture_id, metric.scope, metric.metric_id, metric.relation,
                               metric.owner, metric.value, metric.samples, metric.status
                        FROM (
                            SELECT event_id, capture_id, scope, metric_id, relation, owner, value, samples, status
                            FROM ${this.database}.animation_rum_metrics_v2 FINAL
                            WHERE (app_id, capture_id) IN (
                                SELECT app_id, capture_id
                                FROM selected_captures
                            )
                              AND metric_id = {frameP95MetricId:String}
                        ) AS metric
                        INNER JOIN selected_captures AS capture
                            ON metric.capture_id = capture.capture_id
                           AND metric.event_id = capture.event_id
                           AND metric.scope = capture.scope
                        ORDER BY metric.capture_id
                    `,
                    query_params: { appId: query.appId, captureIds, frameP95MetricId: 'frame.duration.p95' },
                    format: 'JSON',
                }),
            ])
            const targetCountJson = (await targetCountResult.json()) as { data?: Record<string, unknown>[] }
            const frameP95Json = (await frameP95Result.json()) as { data?: Record<string, unknown>[] }
            for (const targetCount of targetCountJson.data ?? []) {
                const parentCaptureId = boundedString(targetCount.parent_capture_id, 80, CAPTURE_ID_PATTERN)
                const count = jsonInteger(targetCount.target_child_count)
                if (parentCaptureId && count !== null) targetCountByParent.set(parentCaptureId, count)
            }
            for (const frame of frameP95Json.data ?? []) {
                const captureId = boundedString(frame.capture_id, 80, CAPTURE_ID_PATTERN)
                const metric = this.metricView(frame)
                if (captureId && metric?.metricId === 'frame.duration.p95') frameP95ByCapture.set(captureId, metric)
            }
        }
        const captures = rows.map(row => {
            const capture = this.captureListView(row)
            return {
                ...capture,
                targetChildCount: capture.scope === 'page' ? (targetCountByParent.get(capture.captureId) ?? 0) : null,
                frameP95: frameP95ByCapture.get(capture.captureId) ?? null,
            }
        })
        const consumed = BigInt(query.offset + captures.length)
        const hasMore = typeof total === 'number' ? consumed < BigInt(total) : typeof total === 'string' ? consumed < BigInt(total) : null
        return {
            contractVersion: ANIMATION_RUM_V2_CONTRACT_VERSION,
            snapshotSchemaVersion: ANIMATION_RUM_V2_SNAPSHOT_SCHEMA_VERSION,
            window: this.windowView(query),
            filters: this.filtersView(query),
            pagination: {
                total,
                limit: query.limit,
                offset: query.offset,
                hasMore,
            },
            captures,
        }
    }

    async capture(userId: number, appIdInput: string, captureIdInput: string) {
        const appId = this.appId(appIdInput)
        await this.applications.assertOwned(appId, userId)
        const captureId = this.captureId(captureIdInput)
        const retentionFloor = clickhouseTime(this.retentionFloor())
        const captureResult = await this.readQuery({
            query: `
                WITH ${this.projectionSql(`
                    SELECT app_id, ${CAPTURE_COLUMNS}
                    FROM ${this.database}.animation_rum_captures_v2 FINAL
                    WHERE app_id = {appId:String}
                      AND capture_id = {captureId:String}
                      AND captured_at >= {retentionFloor:DateTime64(3, 'UTC')}
                `)}
                SELECT ${CAPTURE_COLUMNS}, ${PROJECTION_COUNT_COLUMNS}
                FROM projection_checked_captures
                LIMIT 1
            `,
            query_params: { appId, captureId, retentionFloor },
            format: 'JSON',
        })
        const captureJson = (await captureResult.json()) as { data?: Record<string, unknown>[] }
        const row = captureJson.data?.[0]
        if (!row) {
            throw new NotFoundException({ message: 'Animation capture not found', error: 'NOT_FOUND' })
        }
        if (!this.projectionIsComplete(row)) this.throwProjectionIncomplete()

        const eventId = boundedString(row.event_id, 80, CAPTURE_ID_PATTERN)
        if (!eventId) {
            throw new NotFoundException({ message: 'Animation capture not found', error: 'NOT_FOUND' })
        }
        const scope = closedString(row.scope, SCOPES, '')
        if (!scope) {
            throw new NotFoundException({ message: 'Animation capture not found', error: 'NOT_FOUND' })
        }
        const childParams = { appId, captureId, eventId, scope }
        const [metricResult, providerResult, relationships] = await Promise.all([
            this.readQuery({
                query: `
                    SELECT scope, metric_id, relation, owner, value, samples, status
                    FROM ${this.database}.animation_rum_metrics_v2 FINAL
                    WHERE app_id = {appId:String}
                      AND capture_id = {captureId:String}
                      AND event_id = {eventId:String}
                      AND scope = {scope:String}
                    ORDER BY metric_id, relation, owner
                `,
                query_params: childParams,
                format: 'JSON',
            }),
            this.readQuery({
                query: `
                    SELECT scope, owner, family, provider_version, accepted, retained,
                           evidence, dropped, rejected, truncated
                    FROM ${this.database}.animation_rum_provider_evidence_v2 FINAL
                    WHERE app_id = {appId:String}
                      AND capture_id = {captureId:String}
                      AND event_id = {eventId:String}
                      AND scope = {scope:String}
                    ORDER BY owner, family
                `,
                query_params: childParams,
                format: 'JSON',
            }),
            this.captureRelationships(appId, captureId, row, retentionFloor),
        ])
        const metricJson = (await metricResult.json()) as { data?: Record<string, unknown>[] }
        const providerJson = (await providerResult.json()) as { data?: Record<string, unknown>[] }
        const metrics = (metricJson.data ?? []).map(metric => this.metricView(metric)).filter(metric => metric !== null)
        const providerEvidence = (providerJson.data ?? [])
            .map(provider => this.providerEvidenceView(provider))
            .filter(provider => provider !== null)
        const projectionIntegrity = this.captureProjectionIntegrityView(row)
        if (
            (metricJson.data ?? []).length !== projectionIntegrity.expected.metrics ||
            metrics.length !== projectionIntegrity.expected.metrics ||
            (providerJson.data ?? []).length !== projectionIntegrity.expected.providerEvidence ||
            providerEvidence.length !== projectionIntegrity.expected.providerEvidence
        ) {
            this.throwProjectionIncomplete()
        }

        return {
            contractVersion: ANIMATION_RUM_V2_CONTRACT_VERSION,
            snapshotSchemaVersion: ANIMATION_RUM_V2_SNAPSHOT_SCHEMA_VERSION,
            capture: this.captureDetailView(row),
            metrics,
            providerEvidence,
            relationships,
        }
    }

    private async captureRelationships(appId: string, captureId: string, row: Record<string, unknown>, retentionFloor: string) {
        if (row.scope === 'page') {
            const result = await this.readQuery({
                query: `
                    WITH ${this.projectionSql(`
                        SELECT app_id, ${CAPTURE_COLUMNS}
                        FROM ${this.database}.animation_rum_captures_v2 FINAL
                        WHERE app_id = {appId:String}
                          AND scope = 'target'
                          AND parent_capture_id = {captureId:String}
                          AND captured_at >= {retentionFloor:DateTime64(3, 'UTC')}
                    `)}
                    SELECT ${CAPTURE_COLUMNS}, ${PROJECTION_COUNT_COLUMNS}
                    FROM projection_checked_captures
                    WHERE projection_complete = 1
                    ORDER BY captured_at DESC, capture_id DESC
                    LIMIT 101
                `,
                query_params: { appId, captureId, retentionFloor },
                format: 'JSON',
            })
            const json = (await result.json()) as { data?: Record<string, unknown>[] }
            const rows = json.data ?? []
            return {
                parent: null,
                targets: {
                    items: rows.slice(0, 100).map(child => this.captureListView(child)),
                    returned: Math.min(rows.length, 100),
                    hasMore: rows.length > 100,
                },
            }
        }

        const parentCaptureId = boundedString(row.parent_capture_id, 80, CAPTURE_ID_PATTERN)
        if (!parentCaptureId) return { parent: null, targets: null }
        const result = await this.readQuery({
            query: `
                WITH ${this.projectionSql(`
                    SELECT app_id, ${CAPTURE_COLUMNS}
                    FROM ${this.database}.animation_rum_captures_v2 FINAL
                    WHERE app_id = {appId:String}
                      AND scope = 'page'
                      AND capture_id = {parentCaptureId:String}
                      AND captured_at >= {retentionFloor:DateTime64(3, 'UTC')}
                `)}
                SELECT ${CAPTURE_COLUMNS}, ${PROJECTION_COUNT_COLUMNS}
                FROM projection_checked_captures
                WHERE projection_complete = 1
                LIMIT 1
            `,
            query_params: { appId, parentCaptureId, retentionFloor },
            format: 'JSON',
        })
        const json = (await result.json()) as { data?: Record<string, unknown>[] }
        return { parent: json.data?.[0] ? this.captureListView(json.data[0]) : null, targets: null }
    }

    private projectionSql(selectedCaptureMarkersSql: string): string {
        return createAnimationRumV2ProjectionSql({ database: this.database, selectedCaptureMarkersSql })
    }

    private summaryProjectionIntegrityView(row: Record<string, unknown>) {
        const completionMarkers = jsonInteger(row.projection_completion_marker_count)
        const verified = jsonInteger(row.projection_verified_count)
        const mismatched = jsonInteger(row.projection_mismatched_count)
        const excludedFromAnalytics = jsonInteger(row.projection_excluded_from_analytics_count)
        const metricCountMismatches = jsonInteger(row.projection_metric_count_mismatch_count)
        const providerEvidenceCountMismatches = jsonInteger(row.projection_provider_count_mismatch_count)
        const childIdentityMismatches = jsonInteger(row.projection_child_identity_mismatch_count)
        const markerCount = jsonIntegerBigInt(completionMarkers)
        const verifiedCount = jsonIntegerBigInt(verified)
        const mismatchCount = jsonIntegerBigInt(mismatched)
        const excludedCount = jsonIntegerBigInt(excludedFromAnalytics)
        const diagnosticCounts = [metricCountMismatches, providerEvidenceCountMismatches, childIdentityMismatches].map(jsonIntegerBigInt)
        const partitionIsValid =
            markerCount !== null &&
            verifiedCount !== null &&
            mismatchCount !== null &&
            excludedCount !== null &&
            markerCount === verifiedCount + mismatchCount &&
            mismatchCount === excludedCount &&
            diagnosticCounts.every(count => count !== null && count <= mismatchCount)
        const status =
            partitionIsValid && markerCount === 0n
                ? ('not-observed' as const)
                : partitionIsValid && mismatchCount === 0n
                  ? ('verified' as const)
                  : ('mismatch' as const)

        return {
            semantics: 'completion-marker-child-row-counts' as const,
            status,
            completionMarkers,
            verified,
            mismatched,
            excludedFromAnalytics,
            metricCountMismatches,
            providerEvidenceCountMismatches,
            childIdentityMismatches,
        }
    }

    private projectionIsComplete(row: Record<string, unknown>): boolean {
        const expectedMetrics = safeInteger(row.metric_count)
        const expectedProviderEvidence = safeInteger(row.provider_evidence_count)
        const observedMetrics = jsonIntegerBigInt(jsonInteger(row.projection_observed_metric_count))
        const matchingMetrics = jsonIntegerBigInt(jsonInteger(row.projection_matching_metric_count))
        const mismatchedMetricIdentities = jsonIntegerBigInt(jsonInteger(row.projection_mismatched_metric_identity_count))
        const observedProviderEvidence = jsonIntegerBigInt(jsonInteger(row.projection_observed_provider_evidence_count))
        const matchingProviderEvidence = jsonIntegerBigInt(jsonInteger(row.projection_matching_provider_evidence_count))
        const mismatchedProviderIdentities = jsonIntegerBigInt(jsonInteger(row.projection_mismatched_provider_identity_count))
        if (
            Number(row.projection_complete) !== 1 ||
            expectedMetrics === null ||
            expectedProviderEvidence === null ||
            observedMetrics === null ||
            matchingMetrics === null ||
            mismatchedMetricIdentities === null ||
            observedProviderEvidence === null ||
            matchingProviderEvidence === null ||
            mismatchedProviderIdentities === null
        ) {
            return false
        }
        return (
            observedMetrics === BigInt(expectedMetrics) &&
            matchingMetrics === BigInt(expectedMetrics) &&
            mismatchedMetricIdentities === 0n &&
            observedProviderEvidence === BigInt(expectedProviderEvidence) &&
            matchingProviderEvidence === BigInt(expectedProviderEvidence) &&
            mismatchedProviderIdentities === 0n
        )
    }

    private captureProjectionIntegrityView(row: Record<string, unknown>) {
        if (!this.projectionIsComplete(row)) this.throwProjectionIncomplete()
        const expectedMetrics = safeInteger(row.metric_count)
        const expectedProviderEvidence = safeInteger(row.provider_evidence_count)
        const observedMetrics = jsonInteger(row.projection_observed_metric_count)
        const observedProviderEvidence = jsonInteger(row.projection_observed_provider_evidence_count)
        if (
            expectedMetrics === null ||
            expectedProviderEvidence === null ||
            observedMetrics === null ||
            observedProviderEvidence === null
        ) {
            this.throwProjectionIncomplete()
        }
        return {
            semantics: 'completion-marker-child-row-counts' as const,
            status: 'verified' as const,
            expected: { metrics: expectedMetrics, providerEvidence: expectedProviderEvidence },
            observed: { metrics: observedMetrics, providerEvidence: observedProviderEvidence },
        }
    }

    private throwProjectionIncomplete(): never {
        throw new ConflictException({
            message: 'Animation capture projection is incomplete',
            error: 'ANIMATION_RUM_V2_PROJECTION_INCOMPLETE',
        })
    }

    private async authorizedQuery(userId: number, input: QueryInput): Promise<NormalizedQuery> {
        const appId = this.appId(input.appId)
        await this.applications.assertOwned(appId, userId)
        return this.normalizeQuery({ ...input, appId })
    }

    private appId(value: unknown): string {
        if (typeof value !== 'string' || !APP_ID_PATTERN.test(value)) throw new BadRequestException('Invalid appId')
        return value
    }

    private captureId(value: unknown): string {
        if (typeof value !== 'string' || !CAPTURE_ID_PATTERN.test(value)) throw new BadRequestException('Invalid captureId')
        return value
    }

    private normalizeQuery(input: QueryInput): NormalizedQuery {
        const now = new Date()
        const to = input.to === undefined ? now : this.queryDate(input.to, 'to')
        const requestedFrom = input.from === undefined ? new Date(to.getTime() - 24 * 60 * 60 * 1000) : this.queryDate(input.from, 'from')
        const retentionFloor = this.retentionFloor(now)
        const retentionClamped = requestedFrom < retentionFloor
        const from = retentionClamped ? retentionFloor : requestedFrom
        if (from >= to || to.getTime() - from.getTime() > MAX_WINDOW_MS) {
            throw new BadRequestException('Invalid animation query time window')
        }
        if (to.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) {
            throw new BadRequestException('Animation query end is too far in the future')
        }

        const scope = input.scope === undefined ? undefined : this.closedFilter<'page' | 'target'>(input.scope, SCOPES, 'scope')
        const release = this.deploymentFilter(input.release, 'release')
        const dist = this.deploymentFilter(input.dist, 'dist')
        const environment = this.deploymentFilter(input.environment, 'environment')
        const routeKey = this.semanticFilter(input.routeKey, isAnimationRumV2RouteKey, 'routeKey')
        const targetKey = this.semanticFilter(input.targetKey, isAnimationRumV2TargetKey, 'targetKey')
        if (scope === 'page' && targetKey !== undefined) throw new BadRequestException('targetKey requires target scope')
        const runtimeFramework = this.closedOptionalFilter(input.runtimeFramework, FRAMEWORKS, 'runtimeFramework')
        const runtimeRenderer = this.closedOptionalFilter(input.runtimeRenderer, RENDERERS, 'runtimeRenderer')
        const runtimeBackend = this.closedOptionalFilter(input.runtimeBackend, BACKENDS, 'runtimeBackend')

        const limit = input.limit ?? 50
        const offset = input.offset ?? 0
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new BadRequestException('limit must be an integer between 1 and 100')
        }
        if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) {
            throw new BadRequestException('offset must be an integer between 0 and 100000')
        }

        return {
            appId: input.appId,
            from,
            to,
            scope,
            release,
            dist,
            environment,
            routeKey,
            targetKey,
            runtimeFramework,
            runtimeRenderer,
            runtimeBackend,
            limit,
            offset,
            retentionClamped,
        }
    }

    private queryDate(value: unknown, name: string): Date {
        if (typeof value !== 'string') throw new BadRequestException(`Invalid ${name}`)
        const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value)
        if (!match) {
            throw new BadRequestException(`Invalid ${name}`)
        }
        const date = new Date(value)
        const canonical = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`
        if (!Number.isFinite(date.getTime()) || date.toISOString() !== canonical) throw new BadRequestException(`Invalid ${name}`)
        return date
    }

    private deploymentFilter(value: unknown, name: string): string | undefined {
        if (value === undefined) return undefined
        if (typeof value !== 'string' || value.length > 64 || !DEPLOYMENT_VALUE_PATTERN.test(value)) {
            throw new BadRequestException(`Invalid ${name}`)
        }
        return value
    }

    private semanticFilter(value: unknown, validator: (candidate: unknown) => candidate is string, name: string): string | undefined {
        if (value === undefined) return undefined
        if (!validator(value)) throw new BadRequestException(`Invalid ${name}`)
        return value
    }

    private closedFilter<T extends string>(value: unknown, allowed: ReadonlySet<string>, name: string): T {
        if (typeof value !== 'string' || !allowed.has(value)) throw new BadRequestException(`Invalid ${name}`)
        return value as T
    }

    private closedOptionalFilter(value: unknown, allowed: Set<string>, name: string): string | undefined {
        return value === undefined ? undefined : this.closedFilter(value, allowed, name)
    }

    private captureFilterSql(query: NormalizedQuery): string {
        const filters = ['app_id = {appId:String}', "captured_at >= {from:DateTime64(3, 'UTC')}", "captured_at < {to:DateTime64(3, 'UTC')}"]
        if (query.scope !== undefined) filters.push('scope = {scope:String}')
        if (query.release !== undefined) filters.push('release = {release:String}')
        if (query.dist !== undefined) filters.push('dist = {dist:String}')
        if (query.environment !== undefined) filters.push('environment = {environment:String}')
        if (query.routeKey !== undefined) filters.push('route_key = {routeKey:String}')
        if (query.targetKey !== undefined) filters.push('target_key = {targetKey:String}')
        if (query.runtimeFramework !== undefined) filters.push('runtime_framework = {runtimeFramework:String}')
        if (query.runtimeRenderer !== undefined) filters.push('runtime_renderer = {runtimeRenderer:String}')
        if (query.runtimeBackend !== undefined) filters.push('runtime_backend = {runtimeBackend:String}')
        return filters.join(' AND ')
    }

    private queryParams(query: NormalizedQuery): Record<string, unknown> {
        return {
            appId: query.appId,
            from: clickhouseTime(query.from),
            to: clickhouseTime(query.to),
            limit: query.limit,
            offset: query.offset,
            ...(query.scope === undefined ? {} : { scope: query.scope }),
            ...(query.release === undefined ? {} : { release: query.release }),
            ...(query.dist === undefined ? {} : { dist: query.dist }),
            ...(query.environment === undefined ? {} : { environment: query.environment }),
            ...(query.routeKey === undefined ? {} : { routeKey: query.routeKey }),
            ...(query.targetKey === undefined ? {} : { targetKey: query.targetKey }),
            ...(query.runtimeFramework === undefined ? {} : { runtimeFramework: query.runtimeFramework }),
            ...(query.runtimeRenderer === undefined ? {} : { runtimeRenderer: query.runtimeRenderer }),
            ...(query.runtimeBackend === undefined ? {} : { runtimeBackend: query.runtimeBackend }),
        }
    }

    private windowView(query: NormalizedQuery) {
        return { from: query.from.toISOString(), to: query.to.toISOString(), retentionClamped: query.retentionClamped }
    }

    private retentionFloor(now = new Date()): Date {
        return new Date(now.getTime() - MAX_WINDOW_MS)
    }

    private filtersView(query: NormalizedQuery) {
        return {
            scope: query.scope ?? null,
            release: query.release ?? null,
            dist: query.dist ?? null,
            environment: query.environment ?? null,
            routeKey: query.routeKey ?? null,
            targetKey: query.targetKey ?? null,
            runtimeFramework: query.runtimeFramework ?? null,
            runtimeRenderer: query.runtimeRenderer ?? null,
            runtimeBackend: query.runtimeBackend ?? null,
        }
    }

    private trendBucket(query: NormalizedQuery): TrendBucket {
        const durationMs = query.to.getTime() - query.from.getTime()
        if (durationMs <= 2 * 24 * 60 * 60 * 1000) {
            return { kind: 'hour', durationMs: 60 * 60 * 1000, maximumPoints: 49 }
        }
        if (durationMs <= 14 * 24 * 60 * 60 * 1000) {
            return { kind: 'six-hours', durationMs: 6 * 60 * 60 * 1000, maximumPoints: 57 }
        }
        return { kind: 'day', durationMs: 24 * 60 * 60 * 1000, maximumPoints: RETENTION_DAYS + 1 }
    }

    private trendBucketSql(column: string, kind: TrendBucket['kind']): string {
        if (kind === 'hour') return `toStartOfHour(${column})`
        if (kind === 'six-hours') return `toStartOfInterval(${column}, INTERVAL 6 HOUR)`
        return `toStartOfDay(${column})`
    }

    private trendView(bucket: TrendBucket, captureRows: Record<string, unknown>[], metricRows: Record<string, unknown>[]) {
        const points = new Map<string, TrendPoint>()
        for (const row of captureRows) {
            const at = clickhouseUtcIso(row.bucket)
            if (!at) continue
            points.set(at, {
                at,
                observedCaptures: jsonIntegerOrZero(row.observed_capture_count),
                pageCaptures: jsonIntegerOrZero(row.page_capture_count),
                targetCaptures: jsonIntegerOrZero(row.target_capture_count),
                frameP95: { page: null, target: null },
                gpuFrameP95: { page: null, target: null },
            })
        }
        for (const row of metricRows) {
            const at = clickhouseUtcIso(row.bucket)
            const scope = closedString(row.scope, SCOPES, '')
            const metricId = String(row.metric_id ?? '')
            const point = at ? points.get(at) : undefined
            if (
                !point ||
                (scope !== 'page' && scope !== 'target') ||
                (metricId !== 'frame.duration.p95' && metricId !== 'renderer.gpu-frame.p95')
            )
                continue
            const measuredCaptures = jsonIntegerOrZero(row.measured_captures_with_value)
            const partialCaptures = jsonIntegerOrZero(row.partial_captures_with_value)
            const trendMetric: TrendMetric = {
                statusCounts: {
                    measured: jsonIntegerOrZero(row.measured_capture_count),
                    partial: jsonIntegerOrZero(row.partial_capture_count),
                    notObserved: jsonIntegerOrZero(row.not_observed_capture_count),
                    notInstrumented: jsonIntegerOrZero(row.not_instrumented_capture_count),
                    unsupported: jsonIntegerOrZero(row.unsupported_capture_count),
                    unknown: jsonIntegerOrZero(row.unknown_capture_count),
                },
                measuredCaptures,
                partialCaptures,
                excludedPartialCaptures: partialCaptures,
                captureValue: {
                    p50: integerIsPositive(measuredCaptures) ? finiteNumber(row.capture_value_p50) : null,
                    p75: integerIsPositive(measuredCaptures) ? finiteNumber(row.capture_value_p75) : null,
                    p95: integerIsPositive(measuredCaptures) ? finiteNumber(row.capture_value_p95) : null,
                },
            }
            if (metricId === 'frame.duration.p95') point.frameP95[scope] = trendMetric
            else point.gpuFrameP95[scope] = trendMetric
        }
        const orderedPoints = [...points.values()].sort((left, right) => left.at.localeCompare(right.at))
        return {
            bucket: { ...bucket, timezone: 'UTC' as const },
            metric: {
                metricId: 'frame.duration.p95' as const,
                aggregationSemantics: 'distribution-of-capture-aggregates' as const,
            },
            gpuMetric: {
                metricId: 'renderer.gpu-frame.p95' as const,
                aggregationSemantics: 'distribution-of-capture-aggregates' as const,
            },
            points: orderedPoints,
        }
    }

    private summaryMetricView(row: Record<string, unknown>) {
        const metricId = typeof row.metric_id === 'string' ? row.metric_id : ''
        const scope = closedString(row.scope, SCOPES, '')
        const relation = closedString(row.relation, RELATIONS, '')
        const owner = closedString(row.owner, PROVIDER_OWNER_SET, '')
        const definition = getAnimationRumV2MetricDefinition(metricId)
        if (!definition || !scope || !relation || !owner || !metricBindingIsValid(metricId, scope, relation, owner)) return null

        const capturesWithValue = jsonIntegerOrZero(row.captures_with_value)
        const measuredCaptures = jsonIntegerOrZero(row.measured_captures_with_value)
        const partialCaptures = jsonIntegerOrZero(row.partial_captures_with_value)
        const normalizedCapturesWithValue = jsonIntegerOrZero(row.normalized_captures_with_value)
        const normalizable = NORMALIZABLE_METRIC_IDS.includes(metricId)
        const exposeRawCaptureValue = !normalizable && integerIsPositive(measuredCaptures)
        return {
            metricId,
            family: definition.family,
            name: definition.name,
            stat: definition.stat,
            unit: definition.unit,
            evidenceWindow: definition.evidenceWindow,
            scope,
            relation,
            owner,
            captureCount: jsonIntegerOrZero(row.capture_count),
            statusCounts: {
                measured: jsonIntegerOrZero(row.measured_capture_count),
                partial: jsonIntegerOrZero(row.partial_capture_count),
                notObserved: jsonIntegerOrZero(row.not_observed_capture_count),
                notInstrumented: jsonIntegerOrZero(row.not_instrumented_capture_count),
                unsupported: jsonIntegerOrZero(row.unsupported_capture_count),
                unknown: jsonIntegerOrZero(row.unknown_capture_count),
            },
            capturesWithValue,
            measuredCaptures,
            partialCaptures,
            excludedPartialCaptures: partialCaptures,
            reportedSamples: jsonInteger(row.reported_samples),
            measuredReportedSamples: jsonInteger(row.measured_reported_samples),
            partialReportedSamples: jsonInteger(row.partial_reported_samples),
            captureValue: {
                aggregation: 'distribution-of-capture-aggregates' as const,
                measuredCaptures,
                partialCaptures,
                excludedPartialCaptures: partialCaptures,
                average: exposeRawCaptureValue ? finiteNumber(row.capture_value_avg) : null,
                p50: exposeRawCaptureValue ? finiteNumber(row.capture_value_p50) : null,
                p75: exposeRawCaptureValue ? finiteNumber(row.capture_value_p75) : null,
                p95: exposeRawCaptureValue ? finiteNumber(row.capture_value_p95) : null,
                min: exposeRawCaptureValue ? finiteNumber(row.capture_value_min) : null,
                max: exposeRawCaptureValue ? finiteNumber(row.capture_value_max) : null,
            },
            valuePerMinute: normalizable
                ? {
                      capturesWithValue: normalizedCapturesWithValue,
                      average: integerIsPositive(normalizedCapturesWithValue) ? finiteNumber(row.value_per_minute_avg) : null,
                      p50: integerIsPositive(normalizedCapturesWithValue) ? finiteNumber(row.value_per_minute_p50) : null,
                      p75: integerIsPositive(normalizedCapturesWithValue) ? finiteNumber(row.value_per_minute_p75) : null,
                      p95: integerIsPositive(normalizedCapturesWithValue) ? finiteNumber(row.value_per_minute_p95) : null,
                      min: integerIsPositive(normalizedCapturesWithValue) ? finiteNumber(row.value_per_minute_min) : null,
                      max: integerIsPositive(normalizedCapturesWithValue) ? finiteNumber(row.value_per_minute_max) : null,
                  }
                : null,
        }
    }

    private captureListView(row: Record<string, unknown>) {
        const scope = closedString(row.scope, SCOPES, 'page')
        const parentCaptureId = scope === 'target' ? boundedString(row.parent_capture_id, 80, CAPTURE_ID_PATTERN) || null : null
        const targetKey = scope === 'target' && isAnimationRumV2TargetKey(row.target_key) ? row.target_key : null
        const routeKey = isAnimationRumV2RouteKey(row.route_key) ? row.route_key : null
        const reasons = Array.isArray(row.capture_quality_reasons)
            ? [
                  ...new Set(row.capture_quality_reasons.filter(reason => typeof reason === 'string' && QUALITY_REASON_SET.has(reason))),
              ].sort()
            : []
        const reducedMotion = Number(row.reduced_motion)
        return {
            captureId: boundedString(row.capture_id, 80, CAPTURE_ID_PATTERN),
            parentCaptureId,
            scope,
            targetKey,
            capturedAt: clickhouseUtcIso(row.captured_at),
            receivedAt: clickhouseUtcIso(row.received_at),
            release: boundedString(row.release, 64, DEPLOYMENT_VALUE_PATTERN),
            dist: boundedString(row.dist, 64, DEPLOYMENT_VALUE_PATTERN),
            environment: boundedString(row.environment, 64, DEPLOYMENT_VALUE_PATTERN),
            sdkVersion: boundedString(row.sdk_version, 64, VERSION_PATTERN),
            monitorVersion: boundedString(row.monitor_version, 64, VERSION_PATTERN),
            sampleRate: this.boundedNumber(row.sample_rate, 0, 1),
            samplingPolicyVersion: safeInteger(row.sampling_policy_version),
            context: {
                routeKey,
                visibilityState: closedString(row.visibility_state, VISIBILITY_STATES, 'unknown'),
                reducedMotion:
                    row.reduced_motion === null || row.reduced_motion === undefined || (reducedMotion !== 0 && reducedMotion !== 1)
                        ? null
                        : reducedMotion === 1,
                viewportBucket: closedString(row.viewport_bucket, VIEWPORT_BUCKETS, 'unknown'),
                dprBucket: closedString(row.dpr_bucket, DPR_BUCKETS, 'unknown'),
                refreshHz: this.boundedNumber(row.refresh_hz, 1, 1_000),
                refreshBudgetSource: closedString(row.refresh_budget_source, REFRESH_SOURCES, 'unknown'),
                refreshBudgetConfidence: closedString(row.refresh_budget_confidence, REFRESH_CONFIDENCES, 'unknown'),
                windowDurationMs: this.boundedNumber(row.window_duration_ms, 0, 604_800_000),
                windowDurationCapped: Number(row.window_duration_capped) === 1,
                runtime: {
                    framework: closedString(row.runtime_framework, FRAMEWORKS, 'unknown'),
                    renderer: closedString(row.runtime_renderer, RENDERERS, 'unknown'),
                    backend: closedString(row.runtime_backend, BACKENDS, 'unknown'),
                },
            },
            quality: {
                sufficiency: row.capture_sufficiency === 'sufficient' ? 'sufficient' : 'insufficient',
                integrity: row.capture_integrity === 'complete' ? 'complete' : 'partial',
                reasons,
                adapterErrorCount: safeInteger(row.adapter_error_count),
            },
            projectionIntegrity: this.captureProjectionIntegrityView(row),
            providerEvidenceCount: safeInteger(row.provider_evidence_count),
            metricCount: safeInteger(row.metric_count),
        }
    }

    private captureDetailView(row: Record<string, unknown>) {
        return {
            ...this.captureListView(row),
            eventId: boundedString(row.event_id, 80, CAPTURE_ID_PATTERN),
            contractVersion: Number(row.contract_version) === ANIMATION_RUM_V2_CONTRACT_VERSION ? ANIMATION_RUM_V2_CONTRACT_VERSION : null,
            snapshotSchemaVersion:
                Number(row.snapshot_schema_version) === ANIMATION_RUM_V2_SNAPSHOT_SCHEMA_VERSION
                    ? ANIMATION_RUM_V2_SNAPSHOT_SCHEMA_VERSION
                    : null,
            capabilities: this.capabilitiesView(row.capabilities_json),
            coverage: this.coverageView(row.coverage_json),
        }
    }

    private capabilitiesView(value: unknown): Record<string, string> {
        const source = recordFromJson(value)
        return Object.fromEntries(
            ANIMATION_RUM_V2_CAPABILITIES.map(capability => [capability, closedString(source[capability], CAPABILITY_STATES, 'unknown')])
        )
    }

    private coverageView(value: unknown): Record<string, { status: string; evidenceLevel: string }> {
        const source = recordFromJson(value)
        return Object.fromEntries(
            ANIMATION_RUM_FAMILIES.map(family => {
                const raw = source[family]
                const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
                return [
                    family,
                    {
                        status: closedString(record.status, METRIC_STATUSES, 'unknown'),
                        evidenceLevel: closedString(record.evidenceLevel, EVIDENCE_LEVELS, 'unsupported-or-unknown'),
                    },
                ]
            })
        )
    }

    private metricView(row: Record<string, unknown>) {
        const metricId = typeof row.metric_id === 'string' ? row.metric_id : ''
        const scope = closedString(row.scope, SCOPES, '')
        const relation = closedString(row.relation, RELATIONS, '')
        const owner = closedString(row.owner, PROVIDER_OWNER_SET, '')
        const status = closedString(row.status, METRIC_STATUSES, '')
        const definition = getAnimationRumV2MetricDefinition(metricId)
        if (!definition || !scope || !relation || !owner || !status || !metricBindingIsValid(metricId, scope, relation, owner)) return null
        const available = status === 'measured' || status === 'partial'
        const value = finiteNumber(row.value)
        const samples = safeInteger(row.samples)
        if (available !== (value !== null && samples !== null)) return null
        return {
            metricId,
            family: definition.family,
            name: definition.name,
            stat: definition.stat,
            unit: definition.unit,
            evidenceWindow: definition.evidenceWindow,
            relation,
            owner,
            value: available ? value : null,
            samples: available ? samples : null,
            status,
        }
    }

    private providerEvidenceView(row: Record<string, unknown>) {
        const scope = closedString(row.scope, SCOPES, '')
        const owner = closedString(row.owner, PROVIDER_OWNER_SET, '')
        const family = closedString(row.family, FAMILY_SET, '')
        const providerVersion = boundedString(row.provider_version, 32, PROVIDER_VERSION_PATTERN)
        const accepted = safeInteger(row.accepted)
        const retained = safeInteger(row.retained)
        const evidence = safeInteger(row.evidence)
        const dropped = safeInteger(row.dropped)
        const rejected = safeInteger(row.rejected)
        const truncated = Number(row.truncated) === 1
        if (
            !scope ||
            !owner ||
            !family ||
            !providerVersion ||
            accepted === null ||
            retained === null ||
            evidence === null ||
            dropped === null ||
            rejected === null ||
            retained > accepted ||
            evidence > retained ||
            dropped !== accepted - retained ||
            truncated !== dropped > 0
        ) {
            return null
        }
        return { owner, family, providerVersion, accepted, retained, evidence, dropped, rejected, truncated }
    }

    private boundedNumber(value: unknown, minimum: number, maximum: number): number | null {
        const number = finiteNumber(value)
        return number !== null && number >= minimum && number <= maximum ? number : null
    }
}
