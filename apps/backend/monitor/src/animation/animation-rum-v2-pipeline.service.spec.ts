import { ForbiddenException } from '@nestjs/common'

import { ANIMATION_RUM_V2_PIPELINE_LIMITS, AnimationRumV2PipelineService } from './animation-rum-v2-pipeline.service'

const NOW = new Date('2026-08-27T12:00:00.000Z')
const APP_ID = 'vanillaFixture1'

type ReceiptFixture = {
    captureId: string
    eventId: string
    deliveryState: 'pending' | 'published' | 'persisted' | 'quarantined'
    updatedAt: string
    publishedAt: string | null
    persistedAt: string | null
    outboxState: 'pending' | 'quarantined' | null
}

const pendingAggregate = (overrides: Record<string, unknown> = {}) => ({
    count: '0',
    due: '0',
    retrying: '0',
    leased: '0',
    oldestPendingAt: null,
    maxAttemptCount: null,
    ...overrides,
})

const publishedReceipt = (overrides: Partial<ReceiptFixture> = {}): ReceiptFixture => ({
    captureId: 'capture_12345678',
    eventId: 'event_12345678',
    deliveryState: 'published',
    updatedAt: '2026-08-27T11:55:00.000Z',
    publishedAt: '2026-08-27T11:55:00.000Z',
    persistedAt: null,
    outboxState: null,
    ...overrides,
})

const projectionResult = (data: Array<{ capture_id: string; event_id: string }>) => ({ json: async () => ({ data }) })

function createService(options: {
    receipts?: ReceiptFixture[]
    pending?: Record<string, unknown>
    quarantinedCount?: unknown
    projectionRows?: Array<{ capture_id: string; event_id: string }>
    projectionError?: unknown
    postgresError?: unknown
    ownershipError?: unknown
} = {}) {
    const receipts = options.receipts ?? [publishedReceipt()]
    const pending = options.pending ?? pendingAggregate()
    const quarantinedCount = options.quarantinedCount ?? '0'
    const dataSource = {
        query: jest.fn(async (sql: string, _params?: unknown[]) => {
            if (options.postgresError) throw options.postgresError
            if (sql.includes('animation_rum_v2_capture_receipt AS receipt')) return receipts
            if (sql.includes("outbox.state = 'pending'")) return [pending]
            if (sql.includes("outbox.state = 'quarantined'")) return [{ count: quarantinedCount }]
            throw new Error('Unexpected PostgreSQL pipeline diagnostic query')
        }),
    }
    const clickhouse = {
        query: jest.fn(async (_request: unknown) => {
            if (options.projectionError) throw options.projectionError
            return projectionResult(options.projectionRows ?? [{ capture_id: 'capture_12345678', event_id: 'event_12345678' }])
        }),
    }
    const applications = {
        assertOwned: options.ownershipError
            ? jest.fn().mockRejectedValue(options.ownershipError)
            : jest.fn().mockResolvedValue(undefined),
    }
    const service = new AnimationRumV2PipelineService(
        dataSource as any,
        clickhouse as any,
        { get: () => 'lemonade' } as any,
        applications as any,
        () => new Date(NOW.getTime())
    )
    return { service, dataSource, clickhouse, applications }
}

describe('AnimationRumV2PipelineService', () => {
    it('authorizes before bounded store reads and reports Kafka ACK separately from the ClickHouse completion marker', async () => {
        const { service, dataSource, clickhouse, applications } = createService()

        const response = await service.read(41, APP_ID)

        expect(response).toEqual(
            expect.objectContaining({
                diagnosticSchemaVersion: 1,
                rumContractVersion: 2,
                observedAt: NOW.toISOString(),
                status: 'healthy',
                receipts: expect.objectContaining({
                    recent: { count: 1, truncated: false },
                    byState: { pending: 0, published: 1, persisted: 0, quarantined: 0 },
                    statePairMismatch: 0,
                }),
                projection: {
                    availability: 'available',
                    eligible: { count: 1, truncated: false },
                    matched: 1,
                    missingAfterGrace: 0,
                    identityMismatch: 0,
                },
                semantics: {
                    publishedMeans: 'kafka-broker-ack-only',
                    projectedMeans: 'clickhouse-capture-completion-marker',
                    diagnosticMeans: 'bounded-inference-not-worker-health',
                },
            })
        )
        expect(applications.assertOwned).toHaveBeenCalledWith(APP_ID, 41)
        for (const call of dataSource.query.mock.invocationCallOrder) {
            expect(applications.assertOwned.mock.invocationCallOrder[0]).toBeLessThan(call)
        }
        expect(applications.assertOwned.mock.invocationCallOrder[0]).toBeLessThan(clickhouse.query.mock.invocationCallOrder[0])
        expect(dataSource.query).toHaveBeenCalledTimes(3)
        expect(dataSource.query.mock.calls.every(call => call[1]?.[0] === APP_ID && call[1]?.[1] === 41)).toBe(true)
        expect(dataSource.query.mock.calls.every(call => call[0].includes(`LIMIT ${ANIMATION_RUM_V2_PIPELINE_LIMITS.comparisonLimit + 1}`))).toBe(
            true
        )
        expect(dataSource.query.mock.calls.every(call => !call[0].includes('envelope_text'))).toBe(true)

        const query = clickhouse.query.mock.calls[0][0] as any
        expect(query.query).toContain('animation_rum_captures_v2 FINAL')
        expect(query.query).toContain(`LIMIT ${ANIMATION_RUM_V2_PIPELINE_LIMITS.comparisonLimit}`)
        expect(query.query_params).toEqual({ appId: APP_ID, captureIds: ['capture_12345678'] })
        expect(query.clickhouse_settings).toEqual(
            expect.objectContaining({ max_result_rows: '500', max_rows_to_read: '50000', max_memory_usage: '67108864', max_threads: 2 })
        )
        expect(JSON.stringify(response)).not.toContain('capture_12345678')
        expect(JSON.stringify(response)).not.toContain('event_12345678')
    })

    it('does not touch PostgreSQL or ClickHouse when ownership fails', async () => {
        const { service, dataSource, clickhouse } = createService({ ownershipError: new ForbiddenException('Application not found') })

        await expect(service.read(41, APP_ID)).rejects.toBeInstanceOf(ForbiddenException)
        expect(dataSource.query).not.toHaveBeenCalled()
        expect(clickhouse.query).not.toHaveBeenCalled()
    })

    it('distinguishes idle, fresh in-flight work, stale outbox work, quarantine, and state-pair corruption', async () => {
        const idle = createService({ receipts: [], projectionRows: [] })
        await expect(idle.service.read(41, APP_ID)).resolves.toEqual(
            expect.objectContaining({ status: 'idle', projection: expect.objectContaining({ availability: 'not-checked' }) })
        )
        expect(idle.clickhouse.query).not.toHaveBeenCalled()

        const freshPendingReceipt = publishedReceipt({
            deliveryState: 'pending',
            updatedAt: '2026-08-27T11:59:30.000Z',
            publishedAt: null,
            outboxState: 'pending',
        })
        const freshPending = createService({
            receipts: [freshPendingReceipt],
            pending: pendingAggregate({
                count: '1',
                due: '1',
                oldestPendingAt: '2026-08-27T11:59:30.000Z',
                maxAttemptCount: '0',
            }),
        })
        await expect(freshPending.service.read(41, APP_ID)).resolves.toEqual(expect.objectContaining({ status: 'in-flight' }))

        const stalePending = createService({
            receipts: [],
            pending: pendingAggregate({
                count: '1',
                due: '1',
                retrying: '1',
                oldestPendingAt: '2026-08-27T11:54:59.000Z',
                maxAttemptCount: '3',
            }),
        })
        await expect(stalePending.service.read(41, APP_ID)).resolves.toEqual(expect.objectContaining({ status: 'delayed' }))

        const quarantined = createService({
            receipts: [
                publishedReceipt({
                    deliveryState: 'quarantined',
                    updatedAt: '2026-08-27T11:58:00.000Z',
                    publishedAt: null,
                    outboxState: 'quarantined',
                }),
            ],
            quarantinedCount: '1',
        })
        await expect(quarantined.service.read(41, APP_ID)).resolves.toEqual(expect.objectContaining({ status: 'quarantined' }))

        const inconsistent = createService({ receipts: [publishedReceipt({ outboxState: 'pending' })] })
        await expect(inconsistent.service.read(41, APP_ID)).resolves.toEqual(
            expect.objectContaining({ status: 'inconsistent', receipts: expect.objectContaining({ statePairMismatch: 1 }) })
        )
    })

    it('reports a missing or wrong completion marker without exposing its identity', async () => {
        const missing = createService({ projectionRows: [] })
        const missingResponse = await missing.service.read(41, APP_ID)
        expect(missingResponse).toEqual(
            expect.objectContaining({
                status: 'delayed',
                projection: expect.objectContaining({ matched: 0, missingAfterGrace: 1, identityMismatch: 0 }),
            })
        )

        const wrongEvent = createService({ projectionRows: [{ capture_id: 'capture_12345678', event_id: 'event_wrong_1234' }] })
        const wrongEventResponse = await wrongEvent.service.read(41, APP_ID)
        expect(wrongEventResponse).toEqual(
            expect.objectContaining({
                status: 'inconsistent',
                projection: expect.objectContaining({ matched: 0, missingAfterGrace: 0, identityMismatch: 1 }),
            })
        )
        expect(JSON.stringify(wrongEventResponse)).not.toContain('capture_12345678')
        expect(JSON.stringify(wrongEventResponse)).not.toContain('event_wrong_1234')
    })

    it('degrades a ClickHouse failure to unknown without returning the raw error', async () => {
        const { service } = createService({ projectionError: new Error('password=private-hostname') })

        const response = await service.read(41, APP_ID)

        expect(response).toEqual(
            expect.objectContaining({
                status: 'unknown',
                projection: expect.objectContaining({
                    availability: 'unavailable',
                    matched: null,
                    missingAfterGrace: null,
                    identityMismatch: null,
                }),
            })
        )
        expect(JSON.stringify(response)).not.toContain('password')
        expect(JSON.stringify(response)).not.toContain('private-hostname')
    })

    it('keeps malformed store aggregates inside the closed response while marking them inconsistent', async () => {
        const malformedReceipt = { ...publishedReceipt(), deliveryState: 'corrupt-state' } as unknown as ReceiptFixture
        const { service } = createService({
            receipts: [malformedReceipt],
            pending: pendingAggregate({ count: '1', due: '2', oldestPendingAt: null, maxAttemptCount: null }),
            quarantinedCount: 'not-a-count',
        })

        const response = await service.read(41, APP_ID)

        expect(response).toEqual(
            expect.objectContaining({
                status: 'inconsistent',
                receipts: expect.objectContaining({
                    recent: { count: 1, truncated: false },
                    byState: { pending: 0, published: 0, persisted: 0, quarantined: 0 },
                    statePairMismatch: 2,
                }),
                outbox: expect.objectContaining({ pending: { count: 1, truncated: false }, due: 1 }),
            })
        )
        expect(JSON.stringify(response)).not.toContain(malformedReceipt.captureId)
        expect(JSON.stringify(response)).not.toContain(malformedReceipt.eventId)
    })

    it('does not convert a PostgreSQL failure into a fabricated diagnostic state', async () => {
        const failure = new Error('postgres unavailable')
        const { service, clickhouse } = createService({ postgresError: failure })

        await expect(service.read(41, APP_ID)).rejects.toBe(failure)
        expect(clickhouse.query).not.toHaveBeenCalled()
    })

    it('checks at most 500 identities and marks a larger recent window unknown', async () => {
        const receipts = Array.from({ length: 501 }, (_, index) => {
            const suffix = String(index).padStart(8, '0')
            return publishedReceipt({ captureId: `capture_${suffix}`, eventId: `event_${suffix}` })
        })
        const projectionRows = receipts.slice(0, 500).map(row => ({ capture_id: row.captureId, event_id: row.eventId }))
        const { service, clickhouse } = createService({ receipts, projectionRows })

        const response = await service.read(41, APP_ID)

        expect(response.status).toBe('unknown')
        expect(response.receipts.recent).toEqual({ count: 500, truncated: true })
        expect(response.projection.eligible).toEqual({ count: 500, truncated: true })
        expect((clickhouse.query.mock.calls[0][0] as any).query_params.captureIds).toHaveLength(500)
        expect(JSON.stringify(response)).not.toContain('capture_00000000')
        expect(JSON.stringify(response)).not.toContain('event_00000000')
    })
})
