import { randomUUID } from 'node:crypto'

import { createClient } from '@clickhouse/client'

import { AnimationRumV2PipelineService } from './animation-rum-v2-pipeline.service'

const describeClickhouse = process.env.RUN_CLICKHOUSE_INTEGRATION === '1' ? describe : describe.skip

describeClickhouse('AnimationRumV2PipelineService ClickHouse integration', () => {
    jest.setTimeout(30_000)

    const required = (name: string): string => {
        const value = process.env[name]
        if (!value) throw new Error(`${name} is required for the ClickHouse integration suite`)
        return value
    }

    let client: ReturnType<typeof createClient>
    let database: string

    beforeAll(() => {
        database = required('TEST_CLICKHOUSE_DATABASE')
        client = createClient({
            url: required('TEST_CLICKHOUSE_URL'),
            username: required('TEST_CLICKHOUSE_USERNAME'),
            password: required('TEST_CLICKHOUSE_PASSWORD'),
            database,
        })
    })

    afterAll(async () => {
        await client?.close()
    })

    it('executes the bounded completion-marker comparison without writing ClickHouse data', async () => {
        const suffix = randomUUID().replaceAll('-', '')
        const captureId = `capture_pipeline_${suffix}`
        const eventId = `event_pipeline_${suffix}`
        const dataSource = {
            query: jest.fn(async (sql: string) => {
                if (sql.includes('animation_rum_v2_capture_receipt AS receipt')) {
                    return [
                        {
                            captureId,
                            eventId,
                            deliveryState: 'published',
                            updatedAt: '2026-08-27T11:55:00.000Z',
                            publishedAt: '2026-08-27T11:55:00.000Z',
                            persistedAt: null,
                            outboxState: null,
                        },
                    ]
                }
                if (sql.includes("outbox.state = 'pending'")) {
                    return [{ count: '0', due: '0', retrying: '0', leased: '0', oldestPendingAt: null, maxAttemptCount: null }]
                }
                if (sql.includes("outbox.state = 'quarantined'")) return [{ count: '0' }]
                throw new Error('Unexpected PostgreSQL fixture query')
            }),
        }
        const applications = { assertOwned: jest.fn().mockResolvedValue(undefined) }
        const service = new AnimationRumV2PipelineService(
            dataSource as any,
            client,
            { get: () => database } as any,
            applications as any,
            () => new Date('2026-08-27T12:00:00.000Z')
        )

        await expect(service.read(41, 'pipelineClickhouseFixture')).resolves.toEqual(
            expect.objectContaining({
                status: 'delayed',
                projection: expect.objectContaining({ availability: 'available', matched: 0, missingAfterGrace: 1 }),
            })
        )
    })
})
