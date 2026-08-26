import { ClickHouseClient } from '@clickhouse/client'
import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { resolveClickhouseDatabase } from '../shared/clickhouse-utils'

type AnimationQuery = {
    appId: string
    from?: string
    to?: string
    release?: string
    environment?: string
    routeKey?: string
    captureId?: string
    limit?: number
    offset?: number
}

type MetricItem = {
    family: string
    name: string
    stat: string
    unit: string
    status: string
    value: number | null
    samples: number | null
}

const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000
const MIN_NORMALIZED_WINDOW_MS = 5_000
const SAFE_DIMENSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,119}$/
const SAFE_ROUTE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/

function chTime(date: Date): string {
    return date.toISOString().replace('T', ' ').replace('Z', '')
}

function parseJsonObject(value: unknown): Record<string, unknown> {
    if (typeof value !== 'string' || value.length > 64 * 1024) return {}
    try {
        const parsed = JSON.parse(value) as unknown
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
        return {}
    }
}

function nullableNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null
    const number = Number(value)
    return Number.isFinite(number) ? number : null
}

function clickhouseUtcIso(value: unknown): string {
    const raw = String(value ?? '').trim()
    const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw
    const date = new Date(normalized)
    return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}

@Injectable()
export class AnimationService {
    private readonly database: string

    constructor(
        @Inject('CLICKHOUSE_CLIENT') private readonly clickhouse: ClickHouseClient,
        config: ConfigService
    ) {
        this.database = resolveClickhouseDatabase(config)
    }

    async summary(input: AnimationQuery) {
        const query = this.normalize(input)
        const filter = this.filterSql(query)
        const queryParams = this.queryParams(query)
        const [countResult, metricResult] = await Promise.all([
            this.clickhouse.query({
                query: `
                    SELECT count() AS capture_count
                    FROM (
                        SELECT capture_id
                        FROM ${this.database}.animation_rum_captures_v1
                        WHERE ${filter}
                        GROUP BY capture_id
                    )
                `,
                query_params: queryParams,
                format: 'JSON',
            }),
            this.clickhouse.query({
                query: `
                    SELECT
                        family, name, stat, unit,
                        multiIf(
                            count() = countIf(status = 'measured'), 'measured',
                            countIf(value IS NOT NULL) > 0, 'partial',
                            count() = countIf(status = 'unsupported'), 'unsupported',
                            count() = countIf(status = 'not-instrumented'), 'not-instrumented',
                            count() = countIf(status = 'not-observed'), 'not-observed',
                            'unknown'
                        ) AS status,
                        countIf(value IS NOT NULL) AS captures_with_value,
                        sum(ifNull(samples, 0)) AS reported_samples,
                        avgIf(assumeNotNull(value), value IS NOT NULL) AS value_avg,
                        quantileTDigestIf(0.50)(assumeNotNull(value), value IS NOT NULL) AS value_p50,
                        quantileTDigestIf(0.75)(assumeNotNull(value), value IS NOT NULL) AS value_p75,
                        quantileTDigestIf(0.95)(assumeNotNull(value), value IS NOT NULL) AS value_p95,
                        minIf(assumeNotNull(value), value IS NOT NULL) AS value_min,
                        maxIf(assumeNotNull(value), value IS NOT NULL) AS value_max,
                        countIf(value_per_minute IS NOT NULL) AS normalized_captures_with_value,
                        avgIf(assumeNotNull(value_per_minute), value_per_minute IS NOT NULL) AS value_per_minute_avg,
                        quantileTDigestIf(0.50)(assumeNotNull(value_per_minute), value_per_minute IS NOT NULL) AS value_per_minute_p50,
                        quantileTDigestIf(0.75)(assumeNotNull(value_per_minute), value_per_minute IS NOT NULL) AS value_per_minute_p75,
                        quantileTDigestIf(0.95)(assumeNotNull(value_per_minute), value_per_minute IS NOT NULL) AS value_per_minute_p95,
                        minIf(assumeNotNull(value_per_minute), value_per_minute IS NOT NULL) AS value_per_minute_min,
                        maxIf(assumeNotNull(value_per_minute), value_per_minute IS NOT NULL) AS value_per_minute_max
                    FROM (
                        SELECT
                            latest.capture_id,
                            latest.event_id,
                            latest.family,
                            latest.name,
                            latest.stat,
                            latest.unit,
                            latest.status,
                            latest.value,
                            latest.samples,
                            multiIf(
                                latest.value IS NULL,
                                CAST(NULL AS Nullable(Float64)),
                                latest.stat NOT IN ('count', 'sum'),
                                CAST(NULL AS Nullable(Float64)),
                                latest.status != 'measured',
                                CAST(NULL AS Nullable(Float64)),
                                capture.window_duration_ms < ${MIN_NORMALIZED_WINDOW_MS} OR capture.window_duration_capped,
                                CAST(NULL AS Nullable(Float64)),
                                assumeNotNull(latest.value) * 60000 /
                                    greatest(capture.window_duration_ms, ${MIN_NORMALIZED_WINDOW_MS})
                            ) AS value_per_minute
                        FROM (
                            SELECT
                                event_id,
                                capture_id,
                                family,
                                name,
                                stat,
                                tupleElement(latest_metric, 1) AS unit,
                                tupleElement(latest_metric, 2) AS status,
                                tupleElement(latest_metric, 3) AS value,
                                tupleElement(latest_metric, 4) AS samples
                            FROM (
                                SELECT
                                    event_id, capture_id, family, name, stat,
                                    argMax(tuple(unit, status, value, samples), received_at) AS latest_metric
                                FROM ${this.database}.animation_rum_metrics_v1
                                WHERE ${filter}
                                GROUP BY event_id, capture_id, family, name, stat
                            )
                        ) AS latest
                        INNER JOIN (
                            SELECT
                                capture_id,
                                tupleElement(latest_capture, 1) AS event_id,
                                JSONExtractFloat(tupleElement(latest_capture, 2), 'windowDurationMs') AS window_duration_ms,
                                JSONExtractBool(tupleElement(latest_capture, 2), 'windowDurationCapped') AS window_duration_capped
                            FROM (
                                SELECT
                                    capture_id,
                                    argMax(tuple(event_id, context_json), received_at) AS latest_capture
                                FROM ${this.database}.animation_rum_captures_v1
                                WHERE ${filter}
                                GROUP BY capture_id
                            )
                        ) AS capture
                            ON latest.capture_id = capture.capture_id
                           AND latest.event_id = capture.event_id
                    )
                    GROUP BY family, name, stat, unit
                    ORDER BY family, name, stat
                `,
                query_params: queryParams,
                format: 'JSON',
            }),
        ])

        const countJson = (await countResult.json()) as { data?: Array<{ capture_count?: number | string }> }
        const metricJson = (await metricResult.json()) as { data?: Record<string, unknown>[] }
        return {
            window: query.window,
            captureCount: Number(countJson.data?.[0]?.capture_count ?? 0),
            normalization: {
                kind: 'per-minute' as const,
                minimumWindowMs: MIN_NORMALIZED_WINDOW_MS,
                excludesCappedWindows: true,
                requiresMeasuredStatus: true,
            },
            metrics: (metricJson.data ?? []).map(row => {
                const capturesWithValue = Number(row.captures_with_value ?? 0)
                const normalizedCapturesWithValue = Number(row.normalized_captures_with_value ?? 0)
                const requiresExposureNormalization = row.stat === 'count' || row.stat === 'sum'
                return {
                    family: String(row.family ?? ''),
                    name: String(row.name ?? ''),
                    stat: String(row.stat ?? ''),
                    unit: String(row.unit ?? ''),
                    status: String(row.status ?? ''),
                    capturesWithValue,
                    reportedSamples: Number(row.reported_samples ?? 0),
                    valueAvg: !requiresExposureNormalization && capturesWithValue ? nullableNumber(row.value_avg) : null,
                    valueP50: !requiresExposureNormalization && capturesWithValue ? nullableNumber(row.value_p50) : null,
                    valueP75: !requiresExposureNormalization && capturesWithValue ? nullableNumber(row.value_p75) : null,
                    valueP95: !requiresExposureNormalization && capturesWithValue ? nullableNumber(row.value_p95) : null,
                    valueMin: !requiresExposureNormalization && capturesWithValue ? nullableNumber(row.value_min) : null,
                    valueMax: !requiresExposureNormalization && capturesWithValue ? nullableNumber(row.value_max) : null,
                    normalizedCapturesWithValue,
                    valuePerMinuteAvg: normalizedCapturesWithValue ? nullableNumber(row.value_per_minute_avg) : null,
                    valuePerMinuteP50: normalizedCapturesWithValue ? nullableNumber(row.value_per_minute_p50) : null,
                    valuePerMinuteP75: normalizedCapturesWithValue ? nullableNumber(row.value_per_minute_p75) : null,
                    valuePerMinuteP95: normalizedCapturesWithValue ? nullableNumber(row.value_per_minute_p95) : null,
                    valuePerMinuteMin: normalizedCapturesWithValue ? nullableNumber(row.value_per_minute_min) : null,
                    valuePerMinuteMax: normalizedCapturesWithValue ? nullableNumber(row.value_per_minute_max) : null,
                }
            }),
        }
    }

    async captures(input: AnimationQuery) {
        const query = this.normalize(input)
        const filter = this.filterSql(query)
        const queryParams = this.queryParams(query)
        const captureResult = await this.clickhouse.query({
            query: `
                SELECT
                    event_id, capture_id, captured_at, received_at, release, dist, environment,
                    sdk_version, monitor_version, sample_rate, sampling_policy_version,
                    route_key, runtime_family, context_json, capabilities_json, coverage_json
                FROM ${this.database}.animation_rum_captures_v1 FINAL
                WHERE ${filter}
                ORDER BY captured_at DESC, capture_id DESC
                LIMIT {limit:UInt32} OFFSET {offset:UInt32}
            `,
            query_params: queryParams,
            format: 'JSON',
        })
        const captureJson = (await captureResult.json()) as { data?: Record<string, unknown>[] }
        const rows = captureJson.data ?? []
        const captureIds = rows.map(row => String(row.capture_id ?? '')).filter(Boolean)
        const eventIds = rows.map(row => String(row.event_id ?? '')).filter(Boolean)
        const eventIdByCapture = new Map(rows.map(row => [String(row.capture_id ?? ''), String(row.event_id ?? '')]))
        let metricRows: Record<string, unknown>[] = []
        if (captureIds.length > 0 && eventIds.length > 0) {
            const metricResult = await this.clickhouse.query({
                query: `
                    SELECT event_id, capture_id, family, name, stat, unit, value, samples, status
                    FROM ${this.database}.animation_rum_metrics_v1 FINAL
                    WHERE app_id = {appId:String}
                      AND capture_id IN {captureIds:Array(String)}
                      AND event_id IN {eventIds:Array(String)}
                    ORDER BY capture_id, family, name, stat
                `,
                query_params: { appId: query.appId, captureIds, eventIds },
                format: 'JSON',
            })
            const metricJson = (await metricResult.json()) as { data?: Record<string, unknown>[] }
            metricRows = metricJson.data ?? []
        }
        const metricsByCapture = new Map<string, MetricItem[]>()
        for (const row of metricRows) {
            const captureId = String(row.capture_id ?? '')
            if (String(row.event_id ?? '') !== eventIdByCapture.get(captureId)) continue
            const metrics = metricsByCapture.get(captureId) ?? []
            metrics.push({
                family: String(row.family ?? ''),
                name: String(row.name ?? ''),
                stat: String(row.stat ?? ''),
                unit: String(row.unit ?? ''),
                value: nullableNumber(row.value),
                samples: nullableNumber(row.samples),
                status: String(row.status ?? ''),
            })
            metricsByCapture.set(captureId, metrics)
        }
        return {
            window: query.window,
            limit: query.limit,
            offset: query.offset,
            captures: rows.map(row => ({
                eventId: String(row.event_id ?? ''),
                captureId: String(row.capture_id ?? ''),
                capturedAt: clickhouseUtcIso(row.captured_at),
                receivedAt: clickhouseUtcIso(row.received_at),
                release: String(row.release ?? ''),
                dist: String(row.dist ?? ''),
                environment: String(row.environment ?? ''),
                sdkVersion: String(row.sdk_version ?? ''),
                monitorVersion: String(row.monitor_version ?? ''),
                sampleRate: Number(row.sample_rate ?? 0),
                samplingPolicyVersion: Number(row.sampling_policy_version ?? 0),
                routeKey: String(row.route_key ?? ''),
                runtimeFamily: String(row.runtime_family ?? 'unknown'),
                context: parseJsonObject(row.context_json),
                capabilities: parseJsonObject(row.capabilities_json),
                coverage: parseJsonObject(row.coverage_json),
                metrics: metricsByCapture.get(String(row.capture_id ?? '')) ?? [],
            })),
        }
    }

    private normalize(input: AnimationQuery) {
        const appId = String(input.appId ?? '').trim()
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(appId)) throw new BadRequestException('Invalid appId')
        const now = new Date()
        const to = input.to ? new Date(input.to) : now
        const from = input.from ? new Date(input.from) : new Date(to.getTime() - 24 * 60 * 60 * 1000)
        if (
            !Number.isFinite(from.getTime()) ||
            !Number.isFinite(to.getTime()) ||
            from >= to ||
            to.getTime() - from.getTime() > MAX_WINDOW_MS
        ) {
            throw new BadRequestException('Invalid animation query time window')
        }
        if (to.getTime() > now.getTime() + 5 * 60 * 1000) throw new BadRequestException('Animation query end is too far in the future')
        const release = this.dimension(input.release, 64, 'release')
        const environment = this.dimension(input.environment, 64, 'environment')
        const routeKey = this.dimension(input.routeKey, 128, 'routeKey', SAFE_ROUTE)
        const captureId = this.dimension(input.captureId, 80, 'captureId', SAFE_ID)
        if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200)) {
            throw new BadRequestException('limit must be an integer between 1 and 200')
        }
        if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > 100_000)) {
            throw new BadRequestException('offset must be an integer between 0 and 100000')
        }
        const limit = input.limit ?? 50
        const offset = input.offset ?? 0
        return {
            appId,
            release,
            environment,
            routeKey,
            captureId,
            limit,
            offset,
            window: { from: from.toISOString(), to: to.toISOString() },
        }
    }

    private dimension(value: string | undefined, max: number, name: string, pattern = SAFE_DIMENSION): string | undefined {
        if (value === undefined || value === '') return undefined
        if (value.length > max || !pattern.test(value)) throw new BadRequestException(`Invalid ${name}`)
        return value
    }

    private filterSql(query: ReturnType<AnimationService['normalize']>): string {
        const filters = [
            'app_id = {appId:String}',
            "captured_at >= {from:DateTime64(3, 'UTC')}",
            "captured_at <= {to:DateTime64(3, 'UTC')}",
        ]
        if (query.release !== undefined) filters.push('release = {release:String}')
        if (query.environment !== undefined) filters.push('environment = {environment:String}')
        if (query.routeKey !== undefined) filters.push('route_key = {routeKey:String}')
        if (query.captureId !== undefined) filters.push('capture_id = {captureId:String}')
        return filters.join(' AND ')
    }

    private queryParams(query: ReturnType<AnimationService['normalize']>): Record<string, unknown> {
        return {
            appId: query.appId,
            from: chTime(new Date(query.window.from)),
            to: chTime(new Date(query.window.to)),
            limit: query.limit,
            offset: query.offset,
            ...(query.release === undefined ? {} : { release: query.release }),
            ...(query.environment === undefined ? {} : { environment: query.environment }),
            ...(query.routeKey === undefined ? {} : { routeKey: query.routeKey }),
            ...(query.captureId === undefined ? {} : { captureId: query.captureId }),
        }
    }
}
