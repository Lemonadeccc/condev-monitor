import { randomUUID } from 'node:crypto'

import { type ClickHouseClient, createClient } from '@clickhouse/client'
import { createAnimationRumV3GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { buildAnimationRumV3KafkaEnvelope } from '@condev-monitor/animation-rum-ingest'

import { AnimationRumClickhouseService } from './animation-rum-clickhouse.service'

// cspell:ignore rumv

const describeClickhouse = process.env.RUN_CLICKHOUSE_INTEGRATION === '1' ? describe : describe.skip
const TABLES = [
    'animation_rum_soft_navigation_provider_evidence_v3',
    'animation_rum_soft_navigation_metrics_v3',
    'animation_rum_soft_navigation_captures_v3',
] as const

function required(name: string, allowEmpty = false): string {
    const value = process.env[name]
    if (value === undefined || (!allowEmpty && value.trim() === '')) throw new Error(`${name} is required`)
    return value
}

describeClickhouse('AnimationRumClickhouseService v3 ClickHouse integration', () => {
    jest.setTimeout(30_000)
    let client: ClickHouseClient
    let database = ''

    beforeAll(() => {
        database = required('TEST_CLICKHOUSE_DATABASE')
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(database)) throw new Error('Invalid TEST_CLICKHOUSE_DATABASE')
        client = createClient({
            url: required('TEST_CLICKHOUSE_URL'),
            username: required('TEST_CLICKHOUSE_USERNAME'),
            password: required('TEST_CLICKHOUSE_PASSWORD', true),
            database,
        })
    })

    afterAll(async () => client?.close())

    it('persists exactly three vital rows before the capture completion marker', async () => {
        const suffix = randomUUID().replaceAll('-', '')
        const appId = `rumv3ch${suffix.slice(0, 20)}`
        const report = createAnimationRumV3GoldenReport()
        const now = new Date()
        report.eventId = `event_v3_${suffix.slice(0, 24)}`
        report.captureId = `capture_v3_${suffix.slice(0, 24)}`
        report.capturedAt = new Date(now.getTime() - 1_000).toISOString()
        const envelope = buildAnimationRumV3KafkaEnvelope({
            appId,
            report,
            receivedAt: now.toISOString(),
            nowEpochMs: now.getTime(),
        })
        const order: string[] = []
        const recordingClient = {
            insert: async (options: Parameters<ClickHouseClient['insert']>[0]) => {
                order.push(options.table)
                return client.insert(options)
            },
        }
        const service = new AnimationRumClickhouseService(
            recordingClient as ClickHouseClient,
            { get: (key: string) => (key === 'CLICKHOUSE_DATABASE' ? database : undefined) } as never
        )

        try {
            await service.insertV3SoftNavigation(envelope)
            expect(order).toEqual(TABLES.map(table => `${database}.${table}`))
            const counts = await Promise.all(
                TABLES.map(async table => {
                    const result = await client.query({
                        query: `SELECT count() AS count FROM ${database}.${table} FINAL WHERE app_id = {appId:String}`,
                        query_params: { appId },
                        format: 'JSON',
                    })
                    const body = await result.json<{ count: number | string }>()
                    return Number(body.data[0]?.count)
                })
            )
            expect(counts).toEqual([1, 3, 1])
        } finally {
            for (const table of TABLES) {
                await client.command({
                    query: `ALTER TABLE ${database}.${table} DELETE WHERE app_id = {appId:String}`,
                    query_params: { appId },
                    clickhouse_settings: { mutations_sync: '2' },
                })
            }
        }
    })
})
