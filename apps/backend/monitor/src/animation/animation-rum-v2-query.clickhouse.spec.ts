import { randomUUID } from 'node:crypto'

import { createClient } from '@clickhouse/client'

import { AnimationRumV2QueryService } from './animation-rum-v2-query.service'

const RUN_INTEGRATION = process.env.RUN_CLICKHOUSE_INTEGRATION === '1'
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip
const CLICKHOUSE_TABLES = ['animation_rum_provider_evidence_v2', 'animation_rum_metrics_v2', 'animation_rum_captures_v2'] as const
const GPU_STATUSES = ['measured', 'partial', 'not-observed', 'not-instrumented', 'unsupported', 'unknown'] as const

type GpuStatus = (typeof GPU_STATUSES)[number]

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
    projection_observed_metric_count: 1,
    projection_matching_metric_count: 1,
    projection_mismatched_metric_identity_count: 0,
    projection_observed_provider_evidence_count: 0,
    projection_matching_provider_evidence_count: 0,
    projection_mismatched_provider_identity_count: 0,
    projection_complete: 1,
})

function clickHouseTimestamp(date: Date): string {
    return date.toISOString().replace('T', ' ').replace('Z', '')
}

function gpuCapability(status: GpuStatus): 'supported' | 'disabled' | 'unsupported' | 'unknown' {
    if (status === 'measured' || status === 'partial' || status === 'not-observed') return 'supported'
    if (status === 'not-instrumented') return 'disabled'
    return status
}

function gpuCoverage(status: GpuStatus): { status: GpuStatus; evidenceLevel: 'runtime-observation' | 'unsupported-or-unknown' } {
    return {
        status,
        evidenceLevel:
            status === 'measured' || status === 'partial' || status === 'not-observed' ? 'runtime-observation' : 'unsupported-or-unknown',
    }
}

function gpuFixtureRows(appId: string, suffix: string, capturedAt: Date, receivedAt: Date) {
    const capturedTimestamp = clickHouseTimestamp(capturedAt)
    const receivedTimestamp = clickHouseTimestamp(receivedAt)
    const common = {
        app_id: appId,
        scope: 'page',
        captured_at: capturedTimestamp,
        received_at: receivedTimestamp,
        release: 'gpu-gate-1.0.0',
        dist: '1',
        environment: 'integration',
        sample_rate: 1,
        sampling_policy_version: 1,
        route_key: 'gpu-release-gate',
        target_key: '',
        runtime_framework: 'vanilla',
        runtime_renderer: 'canvas',
        runtime_backend: 'webgpu',
    }
    const captures: Record<string, unknown>[] = []
    const metrics: Record<string, unknown>[] = []
    const providers: Record<string, unknown>[] = []

    for (const [index, status] of GPU_STATUSES.entries()) {
        const eventId = `event_gpu_${index}_${suffix.slice(0, 16)}`
        const captureId = `capture_gpu_${index}_${suffix.slice(0, 16)}`
        const available = status === 'measured' || status === 'partial'
        const hasProvider = available
        const partial = status === 'partial'
        captures.push({
            event_id: eventId,
            capture_id: captureId,
            parent_capture_id: '',
            ...common,
            contract_version: 2,
            snapshot_schema_version: 1,
            sdk_version: '0.1.0',
            monitor_version: '0.1.0',
            visibility_state: 'visible',
            reduced_motion: 0,
            viewport_bucket: 'large',
            dpr_bucket: '2',
            refresh_hz: 60,
            refresh_budget_source: 'explicit',
            refresh_budget_confidence: 'explicit',
            window_duration_ms: 10_000,
            window_duration_capped: 0,
            capabilities_json: JSON.stringify({
                'renderer-adapter': 'supported',
                'gpu-timer-query': gpuCapability(status),
            }),
            coverage_json: JSON.stringify({ renderer: gpuCoverage(status) }),
            capture_sufficiency: 'sufficient',
            capture_integrity: partial ? 'partial' : 'complete',
            capture_quality_reasons: partial ? ['adapter-error'] : [],
            adapter_error_count: partial ? 1 : 0,
            provider_evidence_count: hasProvider ? 1 : 0,
            metric_count: 1,
        })
        metrics.push({
            event_id: eventId,
            capture_id: captureId,
            ...common,
            metric_id: 'renderer.gpu-frame.p95',
            family: 'renderer',
            name: 'gpuFrameMs',
            stat: 'p95',
            unit: 'ms',
            relation: 'adapter',
            owner: 'renderer-adapter',
            value: status === 'measured' ? 0 : status === 'partial' ? 12 : null,
            samples: available ? 8 : null,
            status,
        })
        if (hasProvider) {
            providers.push({
                event_id: eventId,
                capture_id: captureId,
                app_id: appId,
                scope: 'page',
                captured_at: capturedTimestamp,
                received_at: receivedTimestamp,
                release: common.release,
                environment: common.environment,
                route_key: common.route_key,
                target_key: '',
                owner: 'renderer-adapter',
                family: 'renderer',
                provider_version: '0.1.0',
                accepted: 8,
                retained: 8,
                evidence: 8,
                dropped: 0,
                rejected: 0,
                truncated: 0,
            })
        }
    }

    const mismatchEventId = `event_gpu_mismatch_${suffix.slice(0, 16)}`
    const mismatchCaptureId = `capture_gpu_mismatch_${suffix.slice(0, 16)}`
    captures.push({
        event_id: mismatchEventId,
        capture_id: mismatchCaptureId,
        parent_capture_id: '',
        ...common,
        contract_version: 2,
        snapshot_schema_version: 1,
        sdk_version: '0.1.0',
        monitor_version: '0.1.0',
        visibility_state: 'visible',
        reduced_motion: 0,
        viewport_bucket: 'large',
        dpr_bucket: '2',
        refresh_hz: 60,
        refresh_budget_source: 'explicit',
        refresh_budget_confidence: 'explicit',
        window_duration_ms: 10_000,
        window_duration_capped: 0,
        capabilities_json: JSON.stringify({ 'renderer-adapter': 'supported', 'gpu-timer-query': 'unsupported' }),
        coverage_json: JSON.stringify({ renderer: gpuCoverage('unsupported') }),
        capture_sufficiency: 'sufficient',
        capture_integrity: 'complete',
        capture_quality_reasons: [],
        adapter_error_count: 0,
        provider_evidence_count: 0,
        metric_count: 1,
    })
    metrics.push({
        event_id: `event_gpu_stale_${suffix.slice(0, 16)}`,
        capture_id: mismatchCaptureId,
        ...common,
        metric_id: 'renderer.gpu-frame.p95',
        family: 'renderer',
        name: 'gpuFrameMs',
        stat: 'p95',
        unit: 'ms',
        relation: 'adapter',
        owner: 'renderer-adapter',
        value: null,
        samples: null,
        status: 'unsupported',
    })

    return { captures, metrics, providers, mismatchCaptureId }
}

async function cleanupApp(client: ReturnType<typeof createClient>, database: string, appId: string): Promise<void> {
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

describeIntegration('Animation RUM v2 query ClickHouse syntax', () => {
    jest.setTimeout(60_000)

    const required = (name: string, allowEmpty = false): string => {
        const value = process.env[name]
        if (value === undefined || (!allowEmpty && value.trim() === '')) {
            throw new Error(`${name} is required for the ClickHouse integration suite`)
        }
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

    it('executes summary and empty-list SQL against the real v2 tables without writing data', async () => {
        const service = new AnimationRumV2QueryService(client, { get: () => database } as any, applications as any)

        await expect(service.summary(41, window)).resolves.toEqual(
            expect.objectContaining({ contractVersion: 2, aggregationSemantics: 'distribution-of-capture-aggregates' })
        )
        await expect(service.captures(41, window)).resolves.toEqual(
            expect.objectContaining({ contractVersion: 2, captures: expect.any(Array) })
        )
    })

    it('preserves GPU zero and six statuses in summary and trend while excluding incomplete projections', async () => {
        const suffix = randomUUID().replaceAll('-', '')
        const appId = `rumV2GpuGate${suffix.slice(0, 16)}`
        const receivedAt = new Date()
        const capturedAt = new Date(receivedAt.getTime() - 60_000)
        const rows = gpuFixtureRows(appId, suffix, capturedAt, receivedAt)
        const queryWindow = {
            appId,
            from: new Date(capturedAt.getTime() - 60_000).toISOString(),
            to: new Date(receivedAt.getTime() + 60_000).toISOString(),
        }
        const service = new AnimationRumV2QueryService(client, { get: () => database } as any, applications as any)

        try {
            await client.insert({
                table: `${database}.animation_rum_provider_evidence_v2`,
                values: rows.providers,
                format: 'JSONEachRow',
            })
            await client.insert({
                table: `${database}.animation_rum_metrics_v2`,
                values: rows.metrics,
                format: 'JSONEachRow',
            })
            await client.insert({
                table: `${database}.animation_rum_captures_v2`,
                values: rows.captures,
                format: 'JSONEachRow',
            })

            const summary = await service.summary(41, queryWindow)
            expect(summary.projectionIntegrity).toEqual({
                semantics: 'completion-marker-child-row-counts',
                status: 'mismatch',
                completionMarkers: 7,
                verified: 6,
                mismatched: 1,
                excludedFromAnalytics: 1,
                metricCountMismatches: 0,
                providerEvidenceCountMismatches: 0,
                childIdentityMismatches: 1,
            })
            expect(summary.captures).toEqual(expect.objectContaining({ observed: 6, page: 6, target: 0, adapterErrors: 1 }))

            const gpu = summary.metrics.find(metric => metric?.metricId === 'renderer.gpu-frame.p95')
            expect(gpu).toEqual(
                expect.objectContaining({
                    scope: 'page',
                    relation: 'adapter',
                    owner: 'renderer-adapter',
                    captureCount: 6,
                    statusCounts: {
                        measured: 1,
                        partial: 1,
                        notObserved: 1,
                        notInstrumented: 1,
                        unsupported: 1,
                        unknown: 1,
                    },
                    capturesWithValue: 2,
                    measuredCaptures: 1,
                    partialCaptures: 1,
                    excludedPartialCaptures: 1,
                    reportedSamples: 16,
                    measuredReportedSamples: 8,
                    partialReportedSamples: 8,
                    captureValue: {
                        aggregation: 'distribution-of-capture-aggregates',
                        measuredCaptures: 1,
                        partialCaptures: 1,
                        excludedPartialCaptures: 1,
                        average: 0,
                        p50: 0,
                        p75: 0,
                        p95: 0,
                        min: 0,
                        max: 0,
                    },
                    valuePerMinute: null,
                })
            )
            expect(summary.trend.points).toHaveLength(1)
            expect(summary.trend.points[0]).toEqual(
                expect.objectContaining({
                    observedCaptures: 6,
                    pageCaptures: 6,
                    targetCaptures: 0,
                    gpuFrameP95: {
                        page: {
                            statusCounts: {
                                measured: 1,
                                partial: 1,
                                notObserved: 1,
                                notInstrumented: 1,
                                unsupported: 1,
                                unknown: 1,
                            },
                            measuredCaptures: 1,
                            partialCaptures: 1,
                            excludedPartialCaptures: 1,
                            captureValue: { p50: 0, p75: 0, p95: 0 },
                        },
                        target: null,
                    },
                })
            )
            await expect(service.capture(41, appId, rows.mismatchCaptureId)).rejects.toMatchObject({
                status: 409,
                response: expect.objectContaining({ error: 'ANIMATION_RUM_V2_PROJECTION_INCOMPLETE' }),
            })
        } finally {
            await cleanupApp(client, database, appId)
        }
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
                const isCaptureMetricDetail =
                    options.query.includes('event_id = {eventId:String}') && options.query.includes('ORDER BY metric_id, relation, owner')
                if (isCaptureList || isCaptureDetail) return { json: async () => ({ data: [fixture] }) }
                if (isCaptureMetricDetail) {
                    return {
                        json: async () => ({
                            data: [
                                {
                                    scope,
                                    metric_id: 'frame.duration.p95',
                                    relation: scope === 'page' ? 'page-window' : 'target-temporal-overlap',
                                    owner: 'browser-core',
                                    value: 16,
                                    samples: 60,
                                    status: 'measured',
                                },
                            ],
                        }),
                    }
                }
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
