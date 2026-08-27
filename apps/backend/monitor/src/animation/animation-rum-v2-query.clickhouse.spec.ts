import { createClient } from '@clickhouse/client'

import { AnimationRumV2QueryService } from './animation-rum-v2-query.service'

const RUN_INTEGRATION = process.env.RUN_CLICKHOUSE_INTEGRATION === '1'
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip

const captureRow = (scope: 'page' | 'target') => ({
    event_id: 'event_query_syntax_1',
    capture_id: scope === 'page' ? 'capture_query_page_1' : 'capture_query_target_1',
    parent_capture_id: scope === 'target' ? 'capture_query_page_1' : '',
    scope,
    contract_version: 2,
    snapshot_schema_version: 1,
    captured_at: '2026-08-27 00:00:00.000',
    received_at: '2026-08-27 00:00:01.000',
    release: '',
    dist: '',
    environment: '',
    sdk_version: '2.0.0',
    monitor_version: '2.0.0',
    sample_rate: 1,
    sampling_policy_version: 1,
    route_key: 'query.syntax',
    target_key: scope === 'target' ? 'query-target' : '',
    visibility_state: 'visible',
    reduced_motion: null,
    viewport_bucket: 'unknown',
    dpr_bucket: 'unknown',
    refresh_hz: null,
    refresh_budget_source: 'unknown',
    refresh_budget_confidence: 'unknown',
    window_duration_ms: 10_000,
    window_duration_capped: 0,
    runtime_framework: 'vanilla',
    runtime_renderer: 'dom',
    runtime_backend: 'dom',
    capabilities_json: '{}',
    coverage_json: '{}',
    capture_sufficiency: 'sufficient',
    capture_integrity: 'complete',
    capture_quality_reasons: [],
    adapter_error_count: 0,
    provider_evidence_count: 0,
    metric_count: 1,
})

describeIntegration('Animation RUM v2 query ClickHouse syntax', () => {
    const required = (name: string): string => {
        const value = process.env[name]
        if (!value) throw new Error(`${name} is required for the ClickHouse integration suite`)
        return value
    }

    let client: ReturnType<typeof createClient>
    let database: string
    const applications = { assertOwned: jest.fn().mockResolvedValue(undefined) }
    const window = {
        appId: 'rumV2QuerySyntaxFixture',
        from: '2026-08-26T00:00:00.000Z',
        to: '2026-08-27T00:00:00.000Z',
    }

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

    it('executes summary and empty-list SQL against the real v2 tables without writing data', async () => {
        const service = new AnimationRumV2QueryService(client, { get: () => database } as any, applications as any)

        await expect(service.summary(41, window)).resolves.toEqual(
            expect.objectContaining({ contractVersion: 2, aggregationSemantics: 'distribution-of-capture-aggregates' })
        )
        await expect(service.captures(41, window)).resolves.toEqual(
            expect.objectContaining({ contractVersion: 2, captures: expect.any(Array) })
        )
    })

    it.each(['page', 'target'] as const)('executes %s list enrichment and relationship SQL without writes', async scope => {
        const fixture = captureRow(scope)
        const queryProxy = {
            query: jest.fn(async (options: { query: string }) => {
                const result = await client.query(options as any)
                const json = (await result.json()) as { data?: Record<string, unknown>[] }
                const isCaptureList = options.query.includes('LIMIT {limit:UInt32} OFFSET {offset:UInt32}')
                const isCaptureDetail =
                    options.query.includes('capture_id = {captureId:String}') &&
                    options.query.includes('LIMIT 1') &&
                    !options.query.includes("scope = 'page'")
                if (isCaptureList || isCaptureDetail) return { json: async () => ({ data: [fixture] }) }
                return { json: async () => json }
            }),
        }
        const service = new AnimationRumV2QueryService(queryProxy as any, { get: () => database } as any, applications as any)

        await expect(service.captures(41, { ...window, scope, limit: 1 })).resolves.toEqual(
            expect.objectContaining({ captures: [expect.objectContaining({ scope })] })
        )
        await expect(service.capture(41, window.appId, fixture.capture_id)).resolves.toEqual(
            expect.objectContaining({ capture: expect.objectContaining({ scope }), relationships: expect.any(Object) })
        )
        expect(queryProxy.query).toHaveBeenCalledWith(expect.objectContaining({ format: 'JSON' }))
    })
})
