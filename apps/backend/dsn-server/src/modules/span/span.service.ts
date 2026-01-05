import { ClickHouseClient } from '@clickhouse/client'
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common'

import { EmailService } from '../email/email.service'

type OverviewRange = '1h' | '3h' | '1d' | '7d' | '1m'

type OverviewBucket = {
    ts: string
    total: number
    errors: number
}

@Injectable()
export class SpanService {
    constructor(
        @Inject('CLICKHOUSE_CLIENT')
        private readonly clickhouseClient: ClickHouseClient,
        private readonly emailService: EmailService
    ) {}

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

        const values = {
            app_id: appId,
            event_type,
            message,
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
                  AND created_at >= {from:DateTime}
                  AND created_at < {to:DateTime}
                GROUP BY bucket_ts
                ORDER BY bucket_ts ASC
            `,
            query_params: {
                appId,
                from: toClickhouseDateTime(from),
                to: toClickhouseDateTime(now),
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

function toClickhouseDateTime(date: Date) {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
        date.getSeconds()
    )}`
}
