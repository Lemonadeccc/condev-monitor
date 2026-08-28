import { ClickHouseClient, QueryParams } from '@clickhouse/client'
import {
    ANIMATION_RUM_V3_CONTRACT_VERSION,
    ANIMATION_RUM_V3_METRIC_CATALOG,
    ANIMATION_RUM_V3_PROVIDER_OWNER,
    ANIMATION_RUM_V3_SNAPSHOT_SCHEMA_VERSION,
    isAnimationRumV2RouteKey,
} from '@condev-monitor/animation-rum-contract'
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { ApplicationService } from '../application/application.service'
import { resolveClickhouseDatabase } from '../shared/clickhouse-utils'
import { createAnimationRumV3ProjectionSql } from './animation-rum-v3-projection-sql'
import { AnimationRumV3SoftNavigationCapturesQueryDto, AnimationRumV3SoftNavigationQueryDto } from './dto/animation-rum-v3-query.dto'

type QueryInput = AnimationRumV3SoftNavigationQueryDto & { limit?: number; offset?: number }
type CaptureIdentity = { eventId: string; captureId: string; routeKey: string; capturedAt: string }

type NormalizedQuery = {
    appId: string
    from: Date
    to: Date
    release?: string
    environment?: string
    routeKey?: string
    runtimeFramework?: string
    runtimeRenderer?: string
    runtimeBackend?: string
    limit: number
    offset: number
    retentionClamped: boolean
}

const RETENTION_DAYS = 90
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1_000
const FUTURE_SKEW_MS = 5 * 60 * 1_000
const MINIMUM_SAMPLE_THRESHOLD = 30
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/
const CAPTURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/
const DEPLOYMENT_VALUE_PATTERN = /^(?:|[A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/
const VERSION_PATTERN = /^(?:|[A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/
const FRAMEWORKS = new Set(['vanilla', 'react', 'preact', 'vue', 'angular', 'svelte', 'solid', 'qwik', 'lit', 'mixed', 'other', 'unknown'])
const RENDERERS = new Set(['dom', 'svg', 'canvas', 'mixed', 'other', 'unknown'])
const BACKENDS = new Set(['dom', 'canvas2d', 'webgl', 'webgl2', 'webgpu', 'mixed', 'other', 'unknown'])
const METRIC_STATUSES = new Set(['measured', 'partial', 'not-observed', 'not-instrumented', 'unsupported', 'unknown'])
const CAPABILITY_STATES = new Set(['supported', 'unsupported', 'unknown', 'disabled'])
const VISIBILITY_STATES = new Set(['visible', 'hidden', 'prerender', 'unknown'])
const VIEWPORT_BUCKETS = new Set(['tiny', 'small', 'medium', 'large', 'xlarge', 'unknown'])
const DPR_BUCKETS = new Set(['1', '1.5', '2', '3', '4+', 'unknown'])
const REFRESH_SOURCES = new Set(['explicit', 'inferred', 'observed', 'unknown'])
const REFRESH_CONFIDENCES = new Set(['explicit', 'high', 'medium', 'low', 'unknown'])
const QUALITY_REASONS = new Set(['provider-rejected-samples', 'provider-truncated', 'source-field-incomplete', 'window-capped'])
const READ_SETTINGS = Object.freeze({
    max_execution_time: 15,
    max_result_rows: '10000',
    result_overflow_mode: 'throw' as const,
    max_rows_to_read: '5000000',
    max_memory_usage: '536870912',
    max_threads: 4,
})

const CAPTURE_COLUMNS = `
    event_id, capture_id, contract_version, snapshot_schema_version, capture_kind, scope,
    captured_at, received_at, release, dist, environment, sdk_version, monitor_version,
    sample_rate, sampling_policy_version, route_key, visibility_state, reduced_motion,
    viewport_bucket, dpr_bucket, refresh_hz, refresh_budget_source, refresh_budget_confidence,
    window_duration_ms, window_duration_capped, runtime_framework, runtime_renderer,
    runtime_backend, capabilities_json, coverage_json, capture_sufficiency, capture_integrity,
    capture_quality_reasons, provider_evidence_count, metric_count
`

function clickhouseTime(value: Date | string): string {
    const timestamp = value instanceof Date ? value.toISOString() : value
    return timestamp.replace('T', ' ').replace('Z', '')
}

function isoTimestamp(value: unknown): string | null {
    const raw = String(value ?? '').trim()
    const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw
    const date = new Date(normalized)
    return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function finiteNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

function safeInteger(value: unknown): number | null {
    const parsed = finiteNumber(value)
    return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function countValue(value: unknown): number | string | null {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
    const normalized = value.replace(/^0+(?=\d)/, '')
    const parsed = BigInt(normalized)
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : normalized
}

function countOrZero(value: unknown): number | string {
    return countValue(value) ?? 0
}

function countAtLeast(value: number | string, minimum: number): boolean {
    return typeof value === 'number' ? value >= minimum : BigInt(value) >= BigInt(minimum)
}

function boundedString(value: unknown, maximum: number, pattern: RegExp, fallback = ''): string {
    return typeof value === 'string' && value.length <= maximum && pattern.test(value) ? value : fallback
}

function closedString(value: unknown, allowed: Set<string>, fallback: string): string {
    return typeof value === 'string' && allowed.has(value) ? value : fallback
}

function jsonRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== 'string' || value.length > 64 * 1024) return {}
    try {
        const parsed = JSON.parse(value) as unknown
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
        return {}
    }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const observed = Object.keys(value).sort()
    const expected = [...keys].sort()
    return observed.length === expected.length && observed.every((key, index) => key === expected[index])
}

function recordValue(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function capabilityState(value: unknown): string | null {
    return typeof value === 'string' && CAPABILITY_STATES.has(value) ? value : null
}

function capabilitiesView(value: unknown) {
    const root = jsonRecord(value)
    if (!exactKeys(root, ['web-vitals-soft-navigation'])) return null
    const capability = recordValue(root['web-vitals-soft-navigation'])
    if (!capability || !exactKeys(capability, ['status', 'metrics'])) return null
    const metrics = recordValue(capability.metrics)
    if (!metrics || !exactKeys(metrics, ['CLS', 'INP', 'LCP'])) return null
    const status = capabilityState(capability.status)
    const cls = capabilityState(metrics.CLS)
    const inp = capabilityState(metrics.INP)
    const lcp = capabilityState(metrics.LCP)
    if (!status || !cls || !inp || !lcp) return null
    return { 'web-vitals-soft-navigation': { status, metrics: { CLS: cls, INP: inp, LCP: lcp } } }
}

function coverageView(value: unknown) {
    const root = jsonRecord(value)
    if (!exactKeys(root, ['userOutcome'])) return null
    const outcome = recordValue(root.userOutcome)
    if (!outcome || !exactKeys(outcome, ['status', 'evidenceLevel'])) return null
    const status = closedString(outcome.status, METRIC_STATUSES, '')
    const evidenceLevel =
        outcome.evidenceLevel === 'runtime-observation' || outcome.evidenceLevel === 'unsupported-or-unknown' ? outcome.evidenceLevel : null
    return status && evidenceLevel ? { userOutcome: { status, evidenceLevel } } : null
}

@Injectable()
export class AnimationRumV3SoftNavigationQueryService {
    private readonly database: string

    constructor(
        @Inject('CLICKHOUSE_CLIENT') private readonly clickhouse: ClickHouseClient,
        config: ConfigService,
        private readonly applications: ApplicationService
    ) {
        this.database = resolveClickhouseDatabase(config)
    }

    async summary(userId: number, input: AnimationRumV3SoftNavigationQueryDto) {
        const query = await this.authorizedQuery(userId, input)
        const filter = this.captureFilter(query)
        const params = this.queryParams(query)
        const projection = this.projectionSql(filter)
        const [captureResult, groupResult] = await Promise.all([
            this.read({
                query: `
                    WITH ${projection}
                    SELECT
                        count() AS completion_marker_count,
                        countIf(projection_complete) AS capture_count,
                        countIf(projection_complete AND capture_sufficiency = 'sufficient') AS sufficient_capture_count,
                        countIf(projection_complete AND capture_sufficiency = 'insufficient') AS insufficient_capture_count,
                        countIf(projection_complete AND capture_integrity = 'partial') AS partial_capture_count,
                        countIf(NOT projection_complete) AS excluded_capture_count,
                        countIf(projection_mismatched_metric_identity_count > 0
                             OR projection_mismatched_provider_identity_count > 0) AS child_identity_mismatch_count,
                        countIf(projection_mismatched_metric_identity_count = 0
                             AND projection_matching_metric_count != toUInt64(metric_count)) AS metric_count_mismatch_count,
                        countIf(projection_mismatched_provider_identity_count = 0
                             AND projection_matching_provider_evidence_count != toUInt64(provider_evidence_count))
                            AS provider_count_mismatch_count
                    FROM projection_checked_captures
                `,
                query_params: params,
            }),
            this.read({
                query: `
                    WITH ${projection},
                    selected_captures AS (
                        SELECT app_id, event_id, capture_id, route_key, release, environment,
                               runtime_framework, runtime_renderer, runtime_backend, capture_sufficiency
                        FROM projection_checked_captures
                        WHERE projection_complete
                    )
                    SELECT
                        capture.route_key, capture.release, capture.environment,
                        capture.runtime_framework, capture.runtime_renderer, capture.runtime_backend,
                        metric.metric_id, metric.vital_name, metric.unit,
                        count() AS capture_count,
                        countIf(metric.status = 'measured') AS measured_count,
                        countIf(metric.status = 'partial') AS partial_count,
                        countIf(metric.status = 'not-observed') AS not_observed_count,
                        countIf(metric.status = 'not-instrumented') AS not_instrumented_count,
                        countIf(metric.status = 'unsupported') AS unsupported_count,
                        countIf(metric.status = 'unknown') AS unknown_count,
                        countIf(capture.capture_sufficiency = 'insufficient') AS insufficient_evidence_count,
                        sumIf(ifNull(metric.samples, 0), metric.status IN ('measured', 'partial')) AS reported_samples,
                        quantileExactIf(0.50)(metric.value, metric.status = 'measured' AND metric.value IS NOT NULL) AS value_p50,
                        quantileExactIf(0.75)(metric.value, metric.status = 'measured' AND metric.value IS NOT NULL) AS value_p75,
                        quantileExactIf(0.95)(metric.value, metric.status = 'measured' AND metric.value IS NOT NULL) AS value_p95
                    FROM ${this.database}.animation_rum_soft_navigation_metrics_v3 AS metric FINAL
                    INNER JOIN selected_captures AS capture
                        ON metric.app_id = capture.app_id
                       AND metric.event_id = capture.event_id
                       AND metric.capture_id = capture.capture_id
                    GROUP BY capture.route_key, capture.release, capture.environment,
                             capture.runtime_framework, capture.runtime_renderer, capture.runtime_backend,
                             metric.metric_id, metric.vital_name, metric.unit
                    ORDER BY capture.route_key, capture.release, capture.environment,
                             capture.runtime_framework, capture.runtime_renderer, capture.runtime_backend, metric.metric_id
                `,
                query_params: params,
            }),
        ])
        const captureRows = (await captureResult.json()) as { data?: Record<string, unknown>[] }
        const groupRows = (await groupResult.json()) as { data?: Record<string, unknown>[] }
        const capture = captureRows.data?.[0] ?? {}
        return {
            contractVersion: ANIMATION_RUM_V3_CONTRACT_VERSION,
            snapshotSchemaVersion: ANIMATION_RUM_V3_SNAPSHOT_SCHEMA_VERSION,
            captureKind: 'soft-navigation' as const,
            minimumSampleThreshold: MINIMUM_SAMPLE_THRESHOLD,
            window: this.windowView(query),
            filters: this.filtersView(query),
            captures: {
                total: countOrZero(capture.capture_count),
                sufficient: countOrZero(capture.sufficient_capture_count),
                insufficient: countOrZero(capture.insufficient_capture_count),
                partial: countOrZero(capture.partial_capture_count),
            },
            projectionIntegrity: {
                semantics: 'completion-marker-child-row-counts' as const,
                completionMarkers: countOrZero(capture.completion_marker_count),
                verified: countOrZero(capture.capture_count),
                excludedFromAnalytics: countOrZero(capture.excluded_capture_count),
                metricCountMismatches: countOrZero(capture.metric_count_mismatch_count),
                providerEvidenceCountMismatches: countOrZero(capture.provider_count_mismatch_count),
                childIdentityMismatches: countOrZero(capture.child_identity_mismatch_count),
            },
            groups: (groupRows.data ?? []).map(row => this.groupView(row)).filter(value => value !== null),
        }
    }

    async captures(userId: number, input: AnimationRumV3SoftNavigationCapturesQueryDto) {
        const query = await this.authorizedQuery(userId, input)
        const filter = this.captureFilter(query)
        const params = this.queryParams(query)
        const projection = this.projectionSql(filter)
        const [countResult, captureResult] = await Promise.all([
            this.read({
                query: `WITH ${projection} SELECT countIf(projection_complete) AS capture_count FROM projection_checked_captures`,
                query_params: params,
            }),
            this.read({
                query: `
                    WITH ${projection}
                    SELECT ${CAPTURE_COLUMNS}
                    FROM projection_checked_captures
                    WHERE projection_complete
                    ORDER BY captured_at DESC, capture_id DESC
                    LIMIT {limit:UInt32} OFFSET {offset:UInt32}
                `,
                query_params: params,
            }),
        ])
        const countRows = (await countResult.json()) as { data?: Record<string, unknown>[] }
        const captureRows = (await captureResult.json()) as { data?: Record<string, unknown>[] }
        const rows = captureRows.data ?? []
        const identities = rows
            .map(row => ({
                eventId: boundedString(row.event_id, 80, CAPTURE_ID_PATTERN),
                captureId: boundedString(row.capture_id, 80, CAPTURE_ID_PATTERN),
                routeKey: isAnimationRumV2RouteKey(row.route_key) ? row.route_key : '',
                capturedAt: isoTimestamp(row.captured_at) ?? '',
            }))
            .filter((identity): identity is CaptureIdentity =>
                Boolean(identity.eventId && identity.captureId && identity.routeKey && identity.capturedAt)
            )
        const metricsByCapture = await this.metricsForCaptures(query.appId, identities)
        const captures = rows.map(row => {
            const view = this.captureView(row)
            return { ...view, metrics: metricsByCapture.get(view.captureId) ?? [] }
        })
        const total = countOrZero(countRows.data?.[0]?.capture_count)
        const consumed = BigInt(query.offset + captures.length)
        const totalBigInt = BigInt(total)
        return {
            contractVersion: ANIMATION_RUM_V3_CONTRACT_VERSION,
            snapshotSchemaVersion: ANIMATION_RUM_V3_SNAPSHOT_SCHEMA_VERSION,
            captureKind: 'soft-navigation' as const,
            minimumSampleThreshold: MINIMUM_SAMPLE_THRESHOLD,
            window: this.windowView(query),
            filters: this.filtersView(query),
            pagination: { total, limit: query.limit, offset: query.offset, hasMore: consumed < totalBigInt },
            captures,
        }
    }

    async capture(userId: number, appIdInput: string, captureIdInput: string) {
        const appId = this.appId(appIdInput)
        await this.applications.assertOwned(appId, userId)
        const captureId = this.captureId(captureIdInput)
        const retentionFloor = clickhouseTime(new Date(Date.now() - RETENTION_MS))
        const identityFilter = `app_id = {appId:String}
                  AND capture_id = {captureId:String}
                  AND captured_at >= {retentionFloor:DateTime64(3, 'UTC')}`
        const captureResult = await this.read({
            query: `
                WITH ${this.projectionSql(identityFilter)}
                SELECT ${CAPTURE_COLUMNS}
                FROM projection_checked_captures
                WHERE projection_complete
                LIMIT 1
            `,
            query_params: { appId, captureId, retentionFloor },
        })
        const captureRows = (await captureResult.json()) as { data?: Record<string, unknown>[] }
        const row = captureRows.data?.[0]
        if (!row) throw new NotFoundException({ message: 'Soft navigation capture not found', error: 'NOT_FOUND' })
        const eventId = boundedString(row.event_id, 80, CAPTURE_ID_PATTERN)
        const routeKey = isAnimationRumV2RouteKey(row.route_key) ? row.route_key : null
        const capturedAt = isoTimestamp(row.captured_at)
        if (!eventId || !routeKey || !capturedAt) {
            throw new NotFoundException({ message: 'Soft navigation capture not found', error: 'NOT_FOUND' })
        }
        const capturedAtQuery = clickhouseTime(capturedAt)
        const [metrics, provider] = await Promise.all([
            this.metricsForCaptures(appId, [{ eventId, captureId, routeKey, capturedAt }]),
            this.read({
                query: `
                    SELECT owner, family, provider_version, accepted, retained, evidence, dropped, rejected, truncated
                    FROM ${this.database}.animation_rum_soft_navigation_provider_evidence_v3 FINAL
                    WHERE app_id = {appId:String}
                      AND route_key = {routeKey:String}
                      AND capture_id = {captureId:String}
                      AND event_id = {eventId:String}
                      AND captured_at = {capturedAt:DateTime64(3, 'UTC')}
                    LIMIT 1
                `,
                query_params: { appId, routeKey, captureId, eventId, capturedAt: capturedAtQuery },
            }),
        ])
        const providerRows = (await provider.json()) as { data?: Record<string, unknown>[] }
        return {
            contractVersion: ANIMATION_RUM_V3_CONTRACT_VERSION,
            snapshotSchemaVersion: ANIMATION_RUM_V3_SNAPSHOT_SCHEMA_VERSION,
            capture: {
                ...this.captureView(row),
                capabilities: capabilitiesView(row.capabilities_json),
                coverage: coverageView(row.coverage_json),
                metrics: metrics.get(captureId) ?? [],
                providerEvidence: this.providerView(providerRows.data?.[0]),
            },
        }
    }

    private async metricsForCaptures(appId: string, identities: CaptureIdentity[]) {
        const result = new Map<string, Array<ReturnType<AnimationRumV3SoftNavigationQueryService['metricView']>>>()
        if (identities.length === 0) return result
        const captureIds = identities.map(identity => identity.captureId)
        const routeKeys = [...new Set(identities.map(identity => identity.routeKey))]
        const capturedAt = identities.map(identity => identity.capturedAt).sort()
        const capturedFrom = clickhouseTime(capturedAt[0]!)
        const capturedTo = clickhouseTime(capturedAt[capturedAt.length - 1]!)
        const rowsByCapture = new Map(identities.map(identity => [identity.captureId, identity] as const))
        const metricResult = await this.read({
            query: `
                SELECT event_id, capture_id, route_key, captured_at, metric_id, vital_name, unit, value, samples, status
                FROM ${this.database}.animation_rum_soft_navigation_metrics_v3 FINAL
                WHERE app_id = {appId:String}
                  AND route_key IN {routeKeys:Array(String)}
                  AND captured_at >= {capturedFrom:DateTime64(3, 'UTC')}
                  AND captured_at <= {capturedTo:DateTime64(3, 'UTC')}
                  AND capture_id IN {captureIds:Array(String)}
                ORDER BY route_key, capture_id, metric_id
            `,
            query_params: { appId, routeKeys, capturedFrom, capturedTo, captureIds },
        })
        const metricRows = (await metricResult.json()) as { data?: Record<string, unknown>[] }
        for (const row of metricRows.data ?? []) {
            const captureId = boundedString(row.capture_id, 80, CAPTURE_ID_PATTERN)
            const eventId = boundedString(row.event_id, 80, CAPTURE_ID_PATTERN)
            const routeKey = isAnimationRumV2RouteKey(row.route_key) ? row.route_key : null
            const capturedAt = isoTimestamp(row.captured_at)
            const expected = captureId ? rowsByCapture.get(captureId) : undefined
            if (!expected || expected.eventId !== eventId || expected.routeKey !== routeKey || expected.capturedAt !== capturedAt) continue
            const metric = this.metricView(row)
            if (!metric) continue
            const values = result.get(captureId) ?? []
            values.push(metric)
            result.set(captureId, values)
        }
        return result
    }

    private groupView(row: Record<string, unknown>) {
        const metricId = typeof row.metric_id === 'string' ? row.metric_id : ''
        const definition = ANIMATION_RUM_V3_METRIC_CATALOG.find(value => value.metricId === metricId)
        if (!definition || row.vital_name !== definition.vitalName || row.unit !== definition.unit) return null
        const measured = countOrZero(row.measured_count)
        const thresholdMet = countAtLeast(measured, MINIMUM_SAMPLE_THRESHOLD)
        return {
            dimensions: {
                routeKey: isAnimationRumV2RouteKey(row.route_key) ? row.route_key : null,
                release: boundedString(row.release, 64, DEPLOYMENT_VALUE_PATTERN),
                environment: boundedString(row.environment, 64, DEPLOYMENT_VALUE_PATTERN),
                runtime: {
                    framework: closedString(row.runtime_framework, FRAMEWORKS, 'unknown'),
                    renderer: closedString(row.runtime_renderer, RENDERERS, 'unknown'),
                    backend: closedString(row.runtime_backend, BACKENDS, 'unknown'),
                },
            },
            metric: { metricId, vitalName: definition.vitalName, unit: definition.unit },
            captureCount: countOrZero(row.capture_count),
            measuredCount: measured,
            partialCount: countOrZero(row.partial_count),
            notObservedCount: countOrZero(row.not_observed_count),
            notInstrumentedCount: countOrZero(row.not_instrumented_count),
            unsupportedCount: countOrZero(row.unsupported_count),
            unknownCount: countOrZero(row.unknown_count),
            insufficientEvidenceCount: countOrZero(row.insufficient_evidence_count),
            reportedSamples: countOrZero(row.reported_samples),
            disclosure: {
                minimumSampleThreshold: MINIMUM_SAMPLE_THRESHOLD,
                status: thresholdMet ? ('available' as const) : ('insufficient-samples' as const),
            },
            captureValue: {
                p50: thresholdMet ? finiteNumber(row.value_p50) : null,
                p75: thresholdMet ? finiteNumber(row.value_p75) : null,
                p95: thresholdMet ? finiteNumber(row.value_p95) : null,
            },
        }
    }

    private captureView(row: Record<string, unknown>) {
        const rawReasons = Array.isArray(row.capture_quality_reasons) ? row.capture_quality_reasons : []
        const reasons = rawReasons.every(value => typeof value === 'string' && QUALITY_REASONS.has(value))
            ? [...new Set(rawReasons as string[])].sort()
            : []
        const reducedMotion = Number(row.reduced_motion)
        return {
            eventId: boundedString(row.event_id, 80, CAPTURE_ID_PATTERN),
            captureId: boundedString(row.capture_id, 80, CAPTURE_ID_PATTERN),
            captureKind: row.capture_kind === 'soft-navigation' ? 'soft-navigation' : null,
            scope: row.scope === 'page' ? 'page' : null,
            capturedAt: isoTimestamp(row.captured_at),
            receivedAt: isoTimestamp(row.received_at),
            release: boundedString(row.release, 64, DEPLOYMENT_VALUE_PATTERN),
            dist: boundedString(row.dist, 64, DEPLOYMENT_VALUE_PATTERN),
            environment: boundedString(row.environment, 64, DEPLOYMENT_VALUE_PATTERN),
            sdkVersion: boundedString(row.sdk_version, 64, VERSION_PATTERN),
            monitorVersion: boundedString(row.monitor_version, 64, VERSION_PATTERN),
            sampleRate: finiteNumber(row.sample_rate),
            samplingPolicyVersion: safeInteger(row.sampling_policy_version),
            context: {
                routeKey: isAnimationRumV2RouteKey(row.route_key) ? row.route_key : null,
                visibilityState: closedString(row.visibility_state, VISIBILITY_STATES, 'unknown'),
                reducedMotion:
                    row.reduced_motion === null || row.reduced_motion === undefined || (reducedMotion !== 0 && reducedMotion !== 1)
                        ? null
                        : reducedMotion === 1,
                viewportBucket: closedString(row.viewport_bucket, VIEWPORT_BUCKETS, 'unknown'),
                dprBucket: closedString(row.dpr_bucket, DPR_BUCKETS, 'unknown'),
                refreshHz: finiteNumber(row.refresh_hz),
                refreshBudgetSource: closedString(row.refresh_budget_source, REFRESH_SOURCES, 'unknown'),
                refreshBudgetConfidence: closedString(row.refresh_budget_confidence, REFRESH_CONFIDENCES, 'unknown'),
                windowDurationMs: finiteNumber(row.window_duration_ms),
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
            },
            providerEvidenceCount: safeInteger(row.provider_evidence_count),
            metricCount: safeInteger(row.metric_count),
        }
    }

    private metricView(row: Record<string, unknown>) {
        const metricId = typeof row.metric_id === 'string' ? row.metric_id : ''
        const definition = ANIMATION_RUM_V3_METRIC_CATALOG.find(value => value.metricId === metricId)
        const status = closedString(row.status, METRIC_STATUSES, '')
        if (!definition || row.vital_name !== definition.vitalName || row.unit !== definition.unit || !status) return null
        const available = status === 'measured' || status === 'partial'
        const value = finiteNumber(row.value)
        const samples = safeInteger(row.samples)
        if (available !== (value !== null && samples === 1)) return null
        return {
            metricId,
            vitalName: definition.vitalName,
            unit: definition.unit,
            relation: definition.relation,
            owner: definition.owner,
            value: available ? value : null,
            samples: available ? 1 : null,
            status,
        }
    }

    private providerView(row: Record<string, unknown> | undefined) {
        if (!row || row.owner !== ANIMATION_RUM_V3_PROVIDER_OWNER || row.family !== 'userOutcome') return null
        return {
            owner: ANIMATION_RUM_V3_PROVIDER_OWNER,
            family: 'userOutcome' as const,
            version: boundedString(row.provider_version, 64, VERSION_PATTERN),
            accepted: safeInteger(row.accepted),
            retained: safeInteger(row.retained),
            evidence: safeInteger(row.evidence),
            dropped: safeInteger(row.dropped),
            rejected: safeInteger(row.rejected),
            truncated: Number(row.truncated) === 1,
        }
    }

    private async authorizedQuery(userId: number, input: QueryInput): Promise<NormalizedQuery> {
        const appId = this.appId(input.appId)
        await this.applications.assertOwned(appId, userId)
        const now = new Date()
        const to = input.to ? this.queryDate(input.to, 'to') : now
        const requestedFrom = input.from ? this.queryDate(input.from, 'from') : new Date(to.getTime() - 24 * 60 * 60 * 1_000)
        const retentionFloor = new Date(now.getTime() - RETENTION_MS)
        const retentionClamped = requestedFrom < retentionFloor
        const from = retentionClamped ? retentionFloor : requestedFrom
        if (from >= to || to.getTime() - from.getTime() > RETENTION_MS) throw new BadRequestException('Invalid animation query time window')
        if (to.getTime() > now.getTime() + FUTURE_SKEW_MS) throw new BadRequestException('Animation query end is too far in the future')
        const release = this.deployment(input.release, 'release')
        const environment = this.deployment(input.environment, 'environment')
        const routeKey =
            input.routeKey === undefined ? undefined : isAnimationRumV2RouteKey(input.routeKey) ? input.routeKey : this.invalid('routeKey')
        const runtimeFramework = this.closedFilter(input.runtimeFramework, FRAMEWORKS, 'runtimeFramework')
        const runtimeRenderer = this.closedFilter(input.runtimeRenderer, RENDERERS, 'runtimeRenderer')
        const runtimeBackend = this.closedFilter(input.runtimeBackend, BACKENDS, 'runtimeBackend')
        const limit = input.limit ?? 50
        const offset = input.offset ?? 0
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
            throw new BadRequestException('limit must be an integer between 1 and 100')
        if (!Number.isInteger(offset) || offset < 0 || offset > 100_000)
            throw new BadRequestException('offset must be an integer between 0 and 100000')
        return {
            appId,
            from,
            to,
            release,
            environment,
            routeKey,
            runtimeFramework,
            runtimeRenderer,
            runtimeBackend,
            limit,
            offset,
            retentionClamped,
        }
    }

    private captureFilter(query: NormalizedQuery): string {
        const filters = [`app_id = {appId:String}`, `captured_at >= {from:DateTime64(3, 'UTC')}`, `captured_at < {to:DateTime64(3, 'UTC')}`]
        if (query.release !== undefined) filters.push(`release = {release:String}`)
        if (query.environment !== undefined) filters.push(`environment = {environment:String}`)
        if (query.routeKey !== undefined) filters.push(`route_key = {routeKey:String}`)
        if (query.runtimeFramework !== undefined) filters.push(`runtime_framework = {runtimeFramework:String}`)
        if (query.runtimeRenderer !== undefined) filters.push(`runtime_renderer = {runtimeRenderer:String}`)
        if (query.runtimeBackend !== undefined) filters.push(`runtime_backend = {runtimeBackend:String}`)
        return filters.join(' AND ')
    }

    private projectionSql(filter: string): string {
        return createAnimationRumV3ProjectionSql({
            database: this.database,
            selectedCaptureMarkersSql: `
                SELECT *
                FROM ${this.database}.animation_rum_soft_navigation_captures_v3 FINAL
                WHERE ${filter}
            `,
        })
    }

    private queryParams(query: NormalizedQuery) {
        return {
            appId: query.appId,
            from: clickhouseTime(query.from),
            to: clickhouseTime(query.to),
            release: query.release ?? '',
            environment: query.environment ?? '',
            routeKey: query.routeKey ?? '',
            runtimeFramework: query.runtimeFramework ?? '',
            runtimeRenderer: query.runtimeRenderer ?? '',
            runtimeBackend: query.runtimeBackend ?? '',
            limit: query.limit,
            offset: query.offset,
        }
    }

    private filtersView(query: NormalizedQuery) {
        return {
            release: query.release ?? null,
            environment: query.environment ?? null,
            routeKey: query.routeKey ?? null,
            runtimeFramework: query.runtimeFramework ?? null,
            runtimeRenderer: query.runtimeRenderer ?? null,
            runtimeBackend: query.runtimeBackend ?? null,
        }
    }

    private windowView(query: NormalizedQuery) {
        return {
            from: query.from.toISOString(),
            to: query.to.toISOString(),
            retentionDays: RETENTION_DAYS,
            retentionClamped: query.retentionClamped,
        }
    }

    private async read(params: QueryParams) {
        return this.clickhouse.query({
            ...params,
            format: 'JSON',
            clickhouse_settings: { ...params.clickhouse_settings, ...READ_SETTINGS },
        })
    }

    private appId(value: unknown): string {
        if (typeof value !== 'string' || !APP_ID_PATTERN.test(value)) throw new BadRequestException('Invalid appId')
        return value
    }

    private captureId(value: unknown): string {
        if (typeof value !== 'string' || !CAPTURE_ID_PATTERN.test(value)) throw new BadRequestException('Invalid captureId')
        return value
    }

    private queryDate(value: string, name: string): Date {
        const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value)
        if (!match) throw new BadRequestException(`Invalid ${name}`)
        const normalized = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`
        const date = new Date(value)
        if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) throw new BadRequestException(`Invalid ${name}`)
        return date
    }

    private deployment(value: unknown, name: string): string | undefined {
        if (value === undefined) return undefined
        if (typeof value !== 'string' || !DEPLOYMENT_VALUE_PATTERN.test(value)) return this.invalid(name)
        return value
    }

    private closedFilter(value: unknown, allowed: Set<string>, name: string): string | undefined {
        if (value === undefined) return undefined
        if (typeof value !== 'string' || !allowed.has(value)) return this.invalid(name)
        return value
    }

    private invalid(name: string): never {
        throw new BadRequestException(`Invalid ${name}`)
    }
}
