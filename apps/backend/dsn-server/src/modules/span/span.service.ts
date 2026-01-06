import { ClickHouseClient } from '@clickhouse/client'
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { EmailService } from '../email/email.service'

type OverviewRange = '1h' | '3h' | '1d' | '7d' | '1m'

type OverviewBucket = {
    ts: string
    total: number
    errors: number
}

type MetricBucket = {
    ts: string
    webVitals: number
    longTask: number
    jank: number
    lowFps: number
}

type MetricVitalSummary = {
    name: string
    samples: number
    avg: number
    p50: number
    p75: number
    p95: number
}

type MetricPathSummary = {
    path: string
    total: number
    webVitals: number
    longTask: number
    jank: number
    lowFps: number
}

type LongTaskDurationSummary = {
    samples: number
    avg: number
    p50: number
    p75: number
    p95: number
    max: number
}

type LongTaskDurationByPath = LongTaskDurationSummary & { path: string }

type IssueTrendBucket = {
    ts: string
    count: number
}

type IssueItem = {
    id: string
    appId: string
    type: string
    message: string
    path: string
    events: number
    firstSeenAt: string
    lastSeenAt: string
    trend: IssueTrendBucket[]
}

type ReplayEvent = Record<string, unknown>

type ReplayItem = {
    appId: string
    replayId: string
    createdAt: string
    startedAt?: string
    endedAt?: string
    errorAt?: string
    path?: string
    url?: string
    userAgent?: string
    events: ReplayEvent[]
    snapshot?: string
}

function normalizeReplayEvents(rawEvents: unknown, maxEvents: number): unknown[] {
    const list = Array.isArray(rawEvents) ? rawEvents : []
    if (list.length <= maxEvents) return list

    // Prefer keeping a rrweb Meta + FullSnapshot header when trimming (Meta = 0, FullSnapshot = 2).
    const fullSnapshotIdx = list.findIndex(e => {
        if (!e || typeof e !== 'object') return false
        const t = (e as any).type
        return typeof t === 'number' && t === 2
    })

    if (fullSnapshotIdx === -1) {
        return list.slice(-maxEvents)
    }

    const metaIdx = (() => {
        for (let i = fullSnapshotIdx; i >= 0; i -= 1) {
            const e = list[i]
            if (!e || typeof e !== 'object') continue
            const t = (e as any).type
            if (typeof t === 'number' && t === 0) return i
        }
        return -1
    })()

    const headEvents: unknown[] = []
    if (metaIdx !== -1) headEvents.push(list[metaIdx])
    headEvents.push(list[fullSnapshotIdx])

    const tail = list.slice(fullSnapshotIdx + 1)
    const remaining = Math.max(0, maxEvents - headEvents.length)
    const trimmedTail = tail.length > remaining ? tail.slice(-remaining) : tail
    return [...headEvents, ...trimmedTail]
}

@Injectable()
export class SpanService {
    constructor(
        @Inject('CLICKHOUSE_CLIENT')
        private readonly clickhouseClient: ClickHouseClient,
        private readonly emailService: EmailService,
        private readonly configService: ConfigService
    ) {}

    private async getReplayEnabled(appId: string): Promise<boolean> {
        // 1. Try ClickHouse (fast path)
        try {
            const res = await this.clickhouseClient.query({
                query: `
                    SELECT replay_enabled
                    FROM lemonade.app_settings
                    WHERE app_id = {appId:String}
                    ORDER BY updated_at DESC
                    LIMIT 1
                `,
                query_params: { appId },
                format: 'JSON',
            })
            const json = await res.json()
            const row = (json.data ?? [])[0] as { replay_enabled?: number } | undefined

            // If row exists, trust it (even if 0/false)
            if (row) {
                return Boolean(row.replay_enabled)
            }
        } catch {
            // Ignore ClickHouse errors (e.g. table not exists) and proceed to fallback
        }

        // 2. Fallback: Query Monitor API (slow path, for legacy/unsynced apps)
        const monitorApiUrl = (this.configService.get<string>('MONITOR_API_URL') ?? 'http://localhost:8081').replace(/\/+$/, '')
        try {
            const url = new URL(`${monitorApiUrl}/api/application/public/config`)
            url.searchParams.set('appId', appId)
            const res = await fetch(url.toString(), { method: 'GET' })
            if (res.ok) {
                const json = (await res.json()) as { data?: { replayEnabled?: boolean } }
                return Boolean(json?.data?.replayEnabled)
            }
        } catch {
            // ignore
        }

        return false
    }

    async span() {
        const res = await this.clickhouseClient.query({
            query: `SELECT * FROM lemonade.base_monitor_view;`,
            format: 'JSON',
        })
        const data = await res.json()
        return data.data
    }

    async tracking(appId: string, body: Record<string, unknown>) {
        const { event_type, message, ...info } = body

        const normalizedMessage = typeof message === 'string' ? message : ''

        const values = {
            app_id: appId,
            event_type,
            message: normalizedMessage,
            info,
        }

        await this.clickhouseClient.insert({
            table: 'lemonade.base_monitor_storage',
            columns: ['app_id', 'event_type', 'message', 'info'],
            format: 'JSONEachRow',
            values: [values],
        })

        if (event_type === 'error') {
            void this.emailService
                .alert({
                    to: 'zwjhb12@163.com',
                    subject: 'Condev Monitor - Error Event',
                    params: {
                        ...body,
                        ...values,
                    },
                })
                .catch(err => {
                    Logger.error('Failed to send alert email', err instanceof Error ? err.stack : String(err))
                })
        }

        return { ok: true }
    }

    async bugs() {
        const res = await this.clickhouseClient.query({
            query: `SELECT * FROM lemonade.base_monitor_view WHERE event_type='error';`,
            format: 'JSON',
        })
        const data = await res.json()
        return data.data
    }

    async appConfig(params: { appId: string }) {
        const appId = (params.appId ?? '').trim()
        if (!appId) {
            throw new BadRequestException({ message: 'appId is required', error: 'APP_ID_REQUIRED' })
        }

        const replayEnabled = await this.getReplayEnabled(appId)
        return {
            success: true,
            data: { appId, replayEnabled },
        }
    }

    async overview(params: { appId: string; range: OverviewRange }) {
        const appId = (params.appId ?? '').trim()
        if (!appId) {
            throw new BadRequestException({ message: 'appId is required', error: 'APP_ID_REQUIRED' })
        }

        const range =
            params.range === '1h' || params.range === '3h' || params.range === '1d' || params.range === '7d' || params.range === '1m'
                ? params.range
                : '7d'
        const now = new Date()
        const { from, interval } = resolveRange(now, range)
        const fromSeconds = Math.floor(from.getTime() / 1000)
        const offsetSeconds = interval > 0 ? fromSeconds % interval : 0
        const toSeconds = Math.floor(now.getTime() / 1000)

        const res = await this.clickhouseClient.query({
            query: `
                SELECT
                    toUnixTimestamp(
                        toStartOfInterval(
                            created_at - toIntervalSecond({offsetSeconds:UInt32}),
                            toIntervalSecond({intervalSeconds:UInt32})
                        ) + toIntervalSecond({offsetSeconds:UInt32})
                    ) AS bucket_ts,
                    count() AS total,
                    countIf(event_type = 'error') AS errors
                FROM lemonade.base_monitor_view
                WHERE app_id = {appId:String}
                  AND toUnixTimestamp(created_at) >= {fromSeconds:UInt32}
                  AND toUnixTimestamp(created_at) < {toSeconds:UInt32}
                GROUP BY bucket_ts
                ORDER BY bucket_ts ASC
            `,
            query_params: {
                appId,
                fromSeconds,
                toSeconds,
                intervalSeconds: interval,
                offsetSeconds,
            },
            format: 'JSON',
        })

        const json = await res.json()
        const rows: Array<{ tsSeconds: number; total: number; errors: number }> = (json.data ?? []).map((row: any) => ({
            tsSeconds: Number(row.bucket_ts ?? 0),
            total: Number(row.total ?? 0),
            errors: Number(row.errors ?? 0),
        }))

        // Fill missing buckets with 0 so the chart always spans the full range.
        const byTs = new Map(rows.map(r => [r.tsSeconds, r]))
        const buckets: OverviewBucket[] = []
        for (let t = fromSeconds; t <= toSeconds; t += interval) {
            const row = byTs.get(t)
            buckets.push({
                ts: new Date(t * 1000).toISOString(),
                total: row?.total ?? 0,
                errors: row?.errors ?? 0,
            })
        }

        const totals = buckets.reduce(
            (acc, b) => {
                acc.total += b.total
                acc.errors += b.errors
                return acc
            },
            { total: 0, errors: 0 }
        )

        return {
            success: true,
            data: {
                appId,
                range,
                from: from.toISOString(),
                to: now.toISOString(),
                intervalSeconds: interval,
                totals,
                series: buckets,
            },
        }
    }

    async issues(params: { appId?: string; range: OverviewRange; limit: number }) {
        const range =
            params.range === '1h' || params.range === '3h' || params.range === '1d' || params.range === '7d' || params.range === '1m'
                ? params.range
                : '7d'
        const limit = Number.isFinite(params.limit) ? Math.max(1, Math.min(500, Math.floor(params.limit))) : 200

        const now = new Date()
        const { from, interval } = resolveRange(now, range)
        const fromSeconds = Math.floor(from.getTime() / 1000)
        const offsetSeconds = interval > 0 ? fromSeconds % interval : 0
        const toSeconds = Math.floor(now.getTime() / 1000)

        const appId = (params.appId ?? '').trim()
        const appFilter = appId ? 'AND app_id = {appId:String}' : ''

        const res = await this.clickhouseClient.query({
            query: `
                SELECT
                    app_id,
                    issue_type,
                    message,
                    path,
                    events,
                    first_seen,
                    last_seen,
                    arrayMap(t -> t.1, buckets) AS bucket_ts,
                    arrayMap(t -> t.2, buckets) AS bucket_counts
                FROM
                (
                    SELECT
                        app_id,
                        issue_type,
                        message,
                        path,
                        sum(cnt) AS events,
                        min(first_seen) AS first_seen,
                        max(last_seen) AS last_seen,
                        arraySort(groupArray((bucket_ts, cnt))) AS buckets
                    FROM
                    (
                        SELECT
                            app_id,
                            coalesce(JSONExtractString(toJSONString(info), 'type'), '') AS issue_type,
                            message,
                            coalesce(JSONExtractString(toJSONString(info), 'path'), '') AS path,
                            toUnixTimestamp(
                                toStartOfInterval(
                                    created_at - toIntervalSecond({offsetSeconds:UInt32}),
                                    toIntervalSecond({intervalSeconds:UInt32})
                                ) + toIntervalSecond({offsetSeconds:UInt32})
                            ) AS bucket_ts,
                            count() AS cnt,
                            min(created_at) AS first_seen,
                            max(created_at) AS last_seen
                        FROM lemonade.base_monitor_view
                        WHERE event_type = 'error'
                          ${appFilter}
                          AND toUnixTimestamp(created_at) >= {fromSeconds:UInt32}
                          AND toUnixTimestamp(created_at) < {toSeconds:UInt32}
                        GROUP BY app_id, issue_type, message, path, bucket_ts
                    )
                    GROUP BY app_id, issue_type, message, path
                )
                ORDER BY last_seen DESC
                LIMIT {limit:UInt32}
            `,
            query_params: {
                ...(appId ? { appId } : {}),
                fromSeconds,
                toSeconds,
                intervalSeconds: interval,
                offsetSeconds,
                limit,
            },
            format: 'JSON',
        })

        const json = await res.json()

        const items: IssueItem[] = (json.data ?? []).map((row: any) => {
            const rowAppId = String(row.app_id ?? '')
            const type = String(row.issue_type ?? '')
            const message = String(row.message ?? '')
            const path = String(row.path ?? '')
            const events = Number(row.events ?? 0)
            const firstSeenAt = new Date(String(row.first_seen ?? '')).toISOString()
            const lastSeenAt = new Date(String(row.last_seen ?? '')).toISOString()

            const bucketTs = (row.bucket_ts ?? []) as number[]
            const bucketCounts = (row.bucket_counts ?? []) as number[]
            const byTs = new Map<number, number>()
            for (let i = 0; i < bucketTs.length; i += 1) {
                byTs.set(Number(bucketTs[i] ?? 0), Number(bucketCounts[i] ?? 0))
            }

            const trend: IssueTrendBucket[] = []
            for (let t = fromSeconds; t <= toSeconds; t += interval) {
                trend.push({ ts: new Date(t * 1000).toISOString(), count: byTs.get(t) ?? 0 })
            }

            return {
                id: `${rowAppId}:${type}:${path}:${message}`,
                appId: rowAppId,
                type,
                message,
                path,
                events,
                firstSeenAt,
                lastSeenAt,
                trend,
            }
        })

        return {
            success: true,
            data: {
                appId: appId || null,
                range,
                from: from.toISOString(),
                to: now.toISOString(),
                intervalSeconds: interval,
                issues: items,
            },
        }
    }

    async metric(params: { appId: string; range: OverviewRange }) {
        const appId = (params.appId ?? '').trim()
        if (!appId) {
            throw new BadRequestException({ message: 'appId is required', error: 'APP_ID_REQUIRED' })
        }

        const range =
            params.range === '1h' || params.range === '3h' || params.range === '1d' || params.range === '7d' || params.range === '1m'
                ? params.range
                : '7d'

        const now = new Date()
        const { from, interval } = resolveRange(now, range)
        const fromSeconds = Math.floor(from.getTime() / 1000)
        const offsetSeconds = interval > 0 ? fromSeconds % interval : 0
        const toSeconds = Math.floor(now.getTime() / 1000)

        const seriesRes = await this.clickhouseClient.query({
            query: `
                SELECT
                    toUnixTimestamp(
                        toStartOfInterval(
                            created_at - toIntervalSecond({offsetSeconds:UInt32}),
                            toIntervalSecond({intervalSeconds:UInt32})
                        ) + toIntervalSecond({offsetSeconds:UInt32})
                    ) AS bucket_ts,
                    countIf(JSONExtractString(toJSONString(info), 'type') = 'webVital') AS web_vitals,
                    countIf(JSONExtractString(toJSONString(info), 'type') = 'longTask') AS long_task,
                    countIf(JSONExtractString(toJSONString(info), 'type') = 'jank') AS jank,
                    countIf(JSONExtractString(toJSONString(info), 'type') = 'lowFps') AS low_fps
                FROM lemonade.base_monitor_view
                WHERE app_id = {appId:String}
                  AND event_type = 'performance'
                  AND toUnixTimestamp(created_at) >= {fromSeconds:UInt32}
                  AND toUnixTimestamp(created_at) < {toSeconds:UInt32}
                GROUP BY bucket_ts
                ORDER BY bucket_ts ASC
            `,
            query_params: {
                appId,
                fromSeconds,
                toSeconds,
                intervalSeconds: interval,
                offsetSeconds,
            },
            format: 'JSON',
        })

        const seriesJson = await seriesRes.json()
        const seriesRows: Array<{
            tsSeconds: number
            webVitals: number
            longTask: number
            jank: number
            lowFps: number
        }> = (seriesJson.data ?? []).map((row: any) => ({
            tsSeconds: Number(row.bucket_ts ?? 0),
            webVitals: Number(row.web_vitals ?? 0),
            longTask: Number(row.long_task ?? 0),
            jank: Number(row.jank ?? 0),
            lowFps: Number(row.low_fps ?? 0),
        }))

        const byTs = new Map(seriesRows.map(r => [r.tsSeconds, r]))
        const series: MetricBucket[] = []
        for (let t = fromSeconds; t <= toSeconds; t += interval) {
            const row = byTs.get(t)
            series.push({
                ts: new Date(t * 1000).toISOString(),
                webVitals: row?.webVitals ?? 0,
                longTask: row?.longTask ?? 0,
                jank: row?.jank ?? 0,
                lowFps: row?.lowFps ?? 0,
            })
        }

        const totals = series.reduce(
            (acc, b) => {
                acc.webVitals += b.webVitals
                acc.longTask += b.longTask
                acc.jank += b.jank
                acc.lowFps += b.lowFps
                return acc
            },
            { webVitals: 0, longTask: 0, jank: 0, lowFps: 0 }
        )

        const vitalsRes = await this.clickhouseClient.query({
            query: `
                SELECT
                    coalesce(JSONExtractString(toJSONString(info), 'name'), '') AS name,
                    count() AS samples,
                    avg(JSONExtractFloat(toJSONString(info), 'value')) AS avg,
                    quantile(0.5)(JSONExtractFloat(toJSONString(info), 'value')) AS p50,
                    quantile(0.75)(JSONExtractFloat(toJSONString(info), 'value')) AS p75,
                    quantile(0.95)(JSONExtractFloat(toJSONString(info), 'value')) AS p95
                FROM lemonade.base_monitor_view
                WHERE app_id = {appId:String}
                  AND event_type = 'performance'
                  AND JSONExtractString(toJSONString(info), 'type') = 'webVital'
                  AND toUnixTimestamp(created_at) >= {fromSeconds:UInt32}
                  AND toUnixTimestamp(created_at) < {toSeconds:UInt32}
                GROUP BY name
                ORDER BY name ASC
            `,
            query_params: {
                appId,
                fromSeconds,
                toSeconds,
            },
            format: 'JSON',
        })

        const vitalsJson = await vitalsRes.json()
        const vitals: MetricVitalSummary[] = (vitalsJson.data ?? []).map((row: any) => ({
            name: String(row.name ?? ''),
            samples: Number(row.samples ?? 0),
            avg: Number(row.avg ?? 0),
            p50: Number(row.p50 ?? 0),
            p75: Number(row.p75 ?? 0),
            p95: Number(row.p95 ?? 0),
        }))

        const pathsRes = await this.clickhouseClient.query({
            query: `
                WITH
                    coalesce(JSONExtractString(toJSONString(info), 'path'), '') AS path,
                    coalesce(JSONExtractString(toJSONString(info), 'type'), '') AS metric_type
                SELECT
                    path,
                    count() AS total,
                    countIf(metric_type = 'webVital') AS web_vitals,
                    countIf(metric_type = 'longTask') AS long_task,
                    countIf(metric_type = 'jank') AS jank,
                    countIf(metric_type = 'lowFps') AS low_fps
                FROM lemonade.base_monitor_view
                WHERE app_id = {appId:String}
                  AND event_type = 'performance'
                  AND toUnixTimestamp(created_at) >= {fromSeconds:UInt32}
                  AND toUnixTimestamp(created_at) < {toSeconds:UInt32}
                GROUP BY path
                ORDER BY total DESC
                LIMIT 50
            `,
            query_params: {
                appId,
                fromSeconds,
                toSeconds,
            },
            format: 'JSON',
        })

        const pathsJson = await pathsRes.json()
        const paths: MetricPathSummary[] = (pathsJson.data ?? []).map((row: any) => ({
            path: String(row.path ?? ''),
            total: Number(row.total ?? 0),
            webVitals: Number(row.web_vitals ?? 0),
            longTask: Number(row.long_task ?? 0),
            jank: Number(row.jank ?? 0),
            lowFps: Number(row.low_fps ?? 0),
        }))

        const longTaskDurationRes = await this.clickhouseClient.query({
            query: `
                WITH
                    coalesce(JSONExtractString(toJSONString(info), 'type'), '') AS metric_type,
                    JSONExtractFloat(toJSONString(info), 'duration') AS duration
                SELECT
                    count() AS samples,
                    avg(duration) AS avg,
                    quantile(0.5)(duration) AS p50,
                    quantile(0.75)(duration) AS p75,
                    quantile(0.95)(duration) AS p95,
                    max(duration) AS max
                FROM lemonade.base_monitor_view
                WHERE app_id = {appId:String}
                  AND event_type = 'performance'
                  AND metric_type = 'longTask'
                  AND duration > 0
                  AND toUnixTimestamp(created_at) >= {fromSeconds:UInt32}
                  AND toUnixTimestamp(created_at) < {toSeconds:UInt32}
            `,
            query_params: {
                appId,
                fromSeconds,
                toSeconds,
            },
            format: 'JSON',
        })

        const longTaskDurationJson = await longTaskDurationRes.json()
        const longTaskDurationRow = (longTaskDurationJson.data ?? [])[0] as any
        const longTaskDuration: LongTaskDurationSummary = {
            samples: Number(longTaskDurationRow?.samples ?? 0),
            avg: Number(longTaskDurationRow?.avg ?? 0),
            p50: Number(longTaskDurationRow?.p50 ?? 0),
            p75: Number(longTaskDurationRow?.p75 ?? 0),
            p95: Number(longTaskDurationRow?.p95 ?? 0),
            max: Number(longTaskDurationRow?.max ?? 0),
        }

        const longTaskDurationByPathRes = await this.clickhouseClient.query({
            query: `
                WITH
                    coalesce(JSONExtractString(toJSONString(info), 'path'), '') AS path,
                    coalesce(JSONExtractString(toJSONString(info), 'type'), '') AS metric_type,
                    JSONExtractFloat(toJSONString(info), 'duration') AS duration
                SELECT
                    path,
                    count() AS samples,
                    avg(duration) AS avg,
                    quantile(0.5)(duration) AS p50,
                    quantile(0.75)(duration) AS p75,
                    quantile(0.95)(duration) AS p95,
                    max(duration) AS max
                FROM lemonade.base_monitor_view
                WHERE app_id = {appId:String}
                  AND event_type = 'performance'
                  AND metric_type = 'longTask'
                  AND duration > 0
                  AND toUnixTimestamp(created_at) >= {fromSeconds:UInt32}
                  AND toUnixTimestamp(created_at) < {toSeconds:UInt32}
                GROUP BY path
                ORDER BY samples DESC
                LIMIT 20
            `,
            query_params: {
                appId,
                fromSeconds,
                toSeconds,
            },
            format: 'JSON',
        })

        const longTaskDurationByPathJson = await longTaskDurationByPathRes.json()
        const longTaskDurationByPath: LongTaskDurationByPath[] = (longTaskDurationByPathJson.data ?? []).map((row: any) => ({
            path: String(row.path ?? ''),
            samples: Number(row.samples ?? 0),
            avg: Number(row.avg ?? 0),
            p50: Number(row.p50 ?? 0),
            p75: Number(row.p75 ?? 0),
            p95: Number(row.p95 ?? 0),
            max: Number(row.max ?? 0),
        }))

        return {
            success: true,
            data: {
                appId,
                range,
                from: from.toISOString(),
                to: now.toISOString(),
                intervalSeconds: interval,
                totals: {
                    total: totals.webVitals + totals.longTask + totals.jank + totals.lowFps,
                    ...totals,
                },
                series,
                vitals,
                paths,
                longTaskDuration,
                longTaskDurationByPath,
            },
        }
    }

    async replayUpload(params: { appId: string; body: Record<string, unknown> }) {
        const appId = (params.appId ?? '').trim()
        if (!appId) {
            throw new BadRequestException({ message: 'appId is required', error: 'APP_ID_REQUIRED' })
        }

        const replayEnabled = await this.getReplayEnabled(appId)
        if (!replayEnabled) {
            return { ok: true, skipped: true }
        }

        const replayId = String(params.body.replayId ?? '').trim()
        if (!replayId) {
            throw new BadRequestException({ message: 'replayId is required', error: 'REPLAY_ID_REQUIRED' })
        }

        const startedAt = typeof params.body.startedAt === 'string' ? params.body.startedAt : undefined
        const endedAt = typeof params.body.endedAt === 'string' ? params.body.endedAt : undefined
        const errorAt = typeof params.body.errorAt === 'string' ? params.body.errorAt : undefined
        const url = typeof params.body.url === 'string' ? params.body.url : undefined
        const path = typeof params.body.path === 'string' ? params.body.path : undefined
        const userAgent = typeof params.body.userAgent === 'string' ? params.body.userAgent : undefined

        const rawEvents = params.body.events
        const events = normalizeReplayEvents(rawEvents, 2000) as ReplayEvent[]
        const snapshot = typeof params.body.snapshot === 'string' ? params.body.snapshot.slice(0, 500_000) : undefined

        await this.clickhouseClient.insert({
            table: 'lemonade.base_monitor_storage',
            columns: ['app_id', 'event_type', 'message', 'info'],
            format: 'JSONEachRow',
            values: [
                {
                    app_id: appId,
                    event_type: 'replay',
                    message: '',
                    info: {
                        replayId,
                        startedAt,
                        endedAt,
                        errorAt,
                        url,
                        path,
                        userAgent,
                        events,
                        snapshot,
                    },
                },
            ],
        })

        return { ok: true }
    }

    async replayGet(params: { appId: string; replayId: string }) {
        const appId = (params.appId ?? '').trim()
        const replayId = (params.replayId ?? '').trim()
        if (!appId) {
            throw new BadRequestException({ message: 'appId is required', error: 'APP_ID_REQUIRED' })
        }
        if (!replayId) {
            throw new BadRequestException({ message: 'replayId is required', error: 'REPLAY_ID_REQUIRED' })
        }

        const replayEnabled = await this.getReplayEnabled(appId)
        if (!replayEnabled) {
            return { success: true, data: null }
        }

        const res = await this.clickhouseClient.query({
            query: `
                SELECT
                    app_id,
                    created_at,
                    JSONExtractString(toJSONString(info), 'replayId') AS replay_id,
                    JSONExtractString(toJSONString(info), 'startedAt') AS started_at,
                    JSONExtractString(toJSONString(info), 'endedAt') AS ended_at,
                    JSONExtractString(toJSONString(info), 'errorAt') AS error_at,
                    JSONExtractString(toJSONString(info), 'path') AS path,
                    JSONExtractString(toJSONString(info), 'url') AS url,
                    JSONExtractString(toJSONString(info), 'userAgent') AS user_agent,
                    JSONExtractString(toJSONString(info), 'snapshot') AS snapshot,
                    JSONExtractRaw(toJSONString(info), 'events') AS events
                FROM lemonade.base_monitor_view
                WHERE app_id = {appId:String}
                  AND event_type = 'replay'
                  AND JSONExtractString(toJSONString(info), 'replayId') = {replayId:String}
                ORDER BY created_at DESC
                LIMIT 1
            `,
            query_params: { appId, replayId },
            format: 'JSON',
        })

        const json = await res.json()
        const row = (json.data ?? [])[0] as any
        if (!row) {
            return { success: true, data: null }
        }

        let events: ReplayEvent[] = []
        try {
            const parsed = row.events ? JSON.parse(row.events) : []
            if (Array.isArray(parsed)) events = parsed as ReplayEvent[]
        } catch {
            events = []
        }

        const item: ReplayItem = {
            appId: String(row.app_id ?? appId),
            replayId: String(row.replay_id ?? replayId),
            createdAt: new Date(String(row.created_at ?? '')).toISOString(),
            startedAt: row.started_at ? String(row.started_at) : undefined,
            endedAt: row.ended_at ? String(row.ended_at) : undefined,
            errorAt: row.error_at ? String(row.error_at) : undefined,
            path: row.path ? String(row.path) : undefined,
            url: row.url ? String(row.url) : undefined,
            userAgent: row.user_agent ? String(row.user_agent) : undefined,
            snapshot: row.snapshot ? String(row.snapshot) : undefined,
            events,
        }

        return { success: true, data: item }
    }

    async replays(params: { appId: string; range: OverviewRange; limit: number }) {
        const appId = (params.appId ?? '').trim()
        if (!appId) {
            throw new BadRequestException({ message: 'appId is required', error: 'APP_ID_REQUIRED' })
        }

        const replayEnabled = await this.getReplayEnabled(appId)
        if (!replayEnabled) {
            return {
                success: true,
                data: {
                    appId,
                    range: params.range,
                    from: new Date().toISOString(),
                    to: new Date().toISOString(),
                    items: [],
                },
            }
        }

        const range =
            params.range === '1h' || params.range === '3h' || params.range === '1d' || params.range === '7d' || params.range === '1m'
                ? params.range
                : '7d'
        const limit = Number.isFinite(params.limit) ? Math.max(1, Math.min(200, Math.floor(params.limit))) : 50

        const now = new Date()
        const { from } = resolveRange(now, range)
        const fromSeconds = Math.floor(from.getTime() / 1000)
        const toSeconds = Math.floor(now.getTime() / 1000)

        const res = await this.clickhouseClient.query({
            query: `
                SELECT
                    app_id,
                    created_at,
                    JSONExtractString(toJSONString(info), 'replayId') AS replay_id,
                    JSONExtractString(toJSONString(info), 'errorAt') AS error_at,
                    JSONExtractString(toJSONString(info), 'path') AS path
                FROM lemonade.base_monitor_view
                WHERE app_id = {appId:String}
                  AND event_type = 'replay'
                  AND toUnixTimestamp(created_at) >= {fromSeconds:UInt32}
                  AND toUnixTimestamp(created_at) < {toSeconds:UInt32}
                ORDER BY created_at DESC
                LIMIT {limit:UInt32}
            `,
            query_params: { appId, fromSeconds, toSeconds, limit },
            format: 'JSON',
        })

        const json = await res.json()
        const items = (json.data ?? []).map((row: any) => ({
            appId: String(row.app_id ?? appId),
            replayId: String(row.replay_id ?? ''),
            createdAt: new Date(String(row.created_at ?? '')).toISOString(),
            errorAt: row.error_at ? String(row.error_at) : null,
            path: row.path ? String(row.path) : null,
        }))

        return {
            success: true,
            data: {
                appId,
                range,
                from: from.toISOString(),
                to: now.toISOString(),
                items,
            },
        }
    }
}

function resolveRange(now: Date, range: OverviewRange): { from: Date; interval: number } {
    const from = new Date(now)
    if (range === '1h') {
        from.setHours(from.getHours() - 1)
        return { from, interval: 5 * 60 } // 5 minutes
    }
    if (range === '3h') {
        from.setHours(from.getHours() - 3)
        return { from, interval: 15 * 60 } // 15 minutes
    }
    if (range === '1d') {
        from.setHours(from.getHours() - 24)
        return { from, interval: 60 * 60 } // 1 hour
    }
    if (range === '1m') {
        from.setDate(from.getDate() - 30)
        return { from, interval: 24 * 60 * 60 } // 1 day
    }

    // default 7d
    from.setDate(from.getDate() - 7)
    return { from, interval: 24 * 60 * 60 } // 1 day
}
