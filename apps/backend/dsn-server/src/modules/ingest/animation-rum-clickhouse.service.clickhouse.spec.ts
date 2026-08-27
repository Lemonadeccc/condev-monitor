import { randomUUID } from 'node:crypto'

import { type ClickHouseClient, createClient } from '@clickhouse/client'
import { createAnimationRumV2GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { buildAnimationRumV2KafkaEnvelope } from '@condev-monitor/animation-rum-ingest'

import { AnimationRumClickhouseService } from './animation-rum-clickhouse.service'

const describeClickhouse = process.env.RUN_CLICKHOUSE_INTEGRATION === '1' ? describe : describe.skip
const CLICKHOUSE_TABLES = ['animation_rum_provider_evidence_v2', 'animation_rum_metrics_v2', 'animation_rum_captures_v2'] as const

type ProviderRow = {
    event_id: string
    capture_id: string
    app_id: string
    scope: string
    owner: string
    family: string
    provider_version: string
    accepted: number | string
    retained: number | string
    evidence: number | string
    dropped: number | string
    rejected: number | string
    truncated: number | string
}

type MetricRow = {
    event_id: string
    capture_id: string
    app_id: string
    scope: string
    metric_id: string
    family: string
    name: string
    stat: string
    unit: string
    relation: string
    owner: string
    value: number | string | null
    samples: number | string | null
    status: string
}

type CaptureRow = {
    event_id: string
    capture_id: string
    app_id: string
    scope: string
    contract_version: number | string
    snapshot_schema_version: number | string
    route_key: string
    runtime_framework: string
    runtime_renderer: string
    runtime_backend: string
    capture_sufficiency: string
    capture_integrity: string
    provider_evidence_count: number | string
    metric_count: number | string
}

function required(name: string, allowEmpty = false): string {
    const value = process.env[name]
    if (value === undefined || (!allowEmpty && value.trim() === '')) {
        throw new Error(`${name} is required for the ClickHouse integration suite`)
    }
    return value
}

async function rowsForApp<T>(client: ClickHouseClient, database: string, table: (typeof CLICKHOUSE_TABLES)[number], appId: string) {
    const result = await client.query({
        query: `SELECT * FROM ${database}.${table} FINAL WHERE app_id = {appId:String}`,
        query_params: { appId },
        format: 'JSON',
    })
    return (await result.json<T>()).data
}

async function cleanupApp(client: ClickHouseClient, database: string, appId: string): Promise<void> {
    const errors: unknown[] = []
    for (const table of CLICKHOUSE_TABLES) {
        try {
            await client.command({
                query: `ALTER TABLE ${database}.${table} DELETE WHERE app_id = {appId:String}`,
                query_params: { appId },
                clickhouse_settings: { mutations_sync: '2' },
            })
            const result = await client.query({
                query: `SELECT count() AS count FROM ${database}.${table} FINAL WHERE app_id = {appId:String}`,
                query_params: { appId },
                format: 'JSON',
            })
            const body = await result.json<{ count: number | string }>()
            if (Number(body.data[0]?.count ?? Number.NaN) !== 0) throw new Error(`ClickHouse cleanup left rows in ${table}`)
        } catch (error) {
            errors.push(error)
        }
    }
    if (errors.length > 0) throw new AggregateError(errors, `Failed to clean Animation RUM v2 rows for ${appId}`)
}

describeClickhouse('AnimationRumClickhouseService ClickHouse integration', () => {
    jest.setTimeout(30_000)

    let client: ClickHouseClient | undefined
    let database = ''

    beforeAll(() => {
        database = required('TEST_CLICKHOUSE_DATABASE')
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(database)) {
            throw new Error('TEST_CLICKHOUSE_DATABASE must be a simple ClickHouse identifier')
        }
        client = createClient({
            url: required('TEST_CLICKHOUSE_URL'),
            username: required('TEST_CLICKHOUSE_USERNAME'),
            password: required('TEST_CLICKHOUSE_PASSWORD', true),
            database,
        })
    })

    afterAll(async () => {
        await client?.close()
    })

    it('persists provider evidence and metrics before the capture completion marker', async () => {
        if (!client) throw new Error('ClickHouse integration client was not initialized')

        const suffix = randomUUID().replaceAll('-', '')
        const appId = `dsnchservice${suffix.slice(0, 24)}`
        const report = createAnimationRumV2GoldenReport()
        const receivedAt = new Date()
        report.eventId = `event_dsn_ch_${suffix.slice(0, 24)}`
        report.captureId = `capture_dsn_ch_${suffix.slice(0, 24)}`
        report.capturedAt = new Date(receivedAt.getTime() - 1_000).toISOString()
        const envelope = buildAnimationRumV2KafkaEnvelope({
            appId,
            report,
            receivedAt: receivedAt.toISOString(),
        })
        const insertOrder: string[] = []
        const recordingClient = {
            insert: async (options: Parameters<ClickHouseClient['insert']>[0]) => {
                insertOrder.push(options.table)
                return client!.insert(options)
            },
        }
        const service = new AnimationRumClickhouseService(
            recordingClient as unknown as ClickHouseClient,
            { get: (key: string) => (key === 'CLICKHOUSE_DATABASE' ? database : undefined) } as never
        )

        try {
            await service.insertV2(envelope)

            expect(insertOrder).toEqual(CLICKHOUSE_TABLES.map(table => `${database}.${table}`))

            const [providers, metrics, captures] = await Promise.all([
                rowsForApp<ProviderRow>(client, database, 'animation_rum_provider_evidence_v2', appId),
                rowsForApp<MetricRow>(client, database, 'animation_rum_metrics_v2', appId),
                rowsForApp<CaptureRow>(client, database, 'animation_rum_captures_v2', appId),
            ])

            expect(providers).toHaveLength(1)
            expect(metrics).toHaveLength(1)
            expect(captures).toHaveLength(1)

            expect(providers[0]).toEqual(
                expect.objectContaining({
                    event_id: report.eventId,
                    capture_id: report.captureId,
                    app_id: appId,
                    scope: 'page',
                    owner: 'browser-core',
                    family: 'frameCadence',
                    provider_version: '0.1.0',
                })
            )
            expect(Number(providers[0]?.accepted)).toBe(120)
            expect(Number(providers[0]?.retained)).toBe(120)
            expect(Number(providers[0]?.evidence)).toBe(120)
            expect(Number(providers[0]?.dropped)).toBe(0)
            expect(Number(providers[0]?.rejected)).toBe(0)
            expect(Number(providers[0]?.truncated)).toBe(0)

            expect(metrics[0]).toEqual(
                expect.objectContaining({
                    event_id: report.eventId,
                    capture_id: report.captureId,
                    app_id: appId,
                    scope: 'page',
                    metric_id: 'frame.duration.p95',
                    family: 'frameCadence',
                    name: 'frameDurationMs',
                    stat: 'p95',
                    unit: 'ms',
                    relation: 'page-window',
                    owner: 'browser-core',
                    status: 'measured',
                })
            )
            expect(Number(metrics[0]?.value)).toBe(18.5)
            expect(Number(metrics[0]?.samples)).toBe(120)

            expect(captures[0]).toEqual(
                expect.objectContaining({
                    event_id: report.eventId,
                    capture_id: report.captureId,
                    app_id: appId,
                    scope: 'page',
                    route_key: 'product-detail',
                    runtime_framework: 'react',
                    runtime_renderer: 'dom',
                    runtime_backend: 'dom',
                    capture_sufficiency: 'sufficient',
                    capture_integrity: 'complete',
                })
            )
            expect(Number(captures[0]?.contract_version)).toBe(2)
            expect(Number(captures[0]?.snapshot_schema_version)).toBe(1)
            expect(Number(captures[0]?.provider_evidence_count)).toBe(providers.length)
            expect(Number(captures[0]?.metric_count)).toBe(metrics.length)
        } finally {
            await cleanupApp(client, database, appId)
        }
    })
})
