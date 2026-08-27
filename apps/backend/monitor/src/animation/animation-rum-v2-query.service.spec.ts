import { ANIMATION_RUM_FAMILIES, ANIMATION_RUM_V2_CAPABILITIES } from '@condev-monitor/animation-rum-contract'
import { ForbiddenException, NotFoundException } from '@nestjs/common'

import { AnimationRumV2QueryService } from './animation-rum-v2-query.service'

const WINDOW = {
    from: '2026-08-26T00:00:00.000Z',
    to: '2026-08-27T00:00:00.000Z',
}

const captureRow = (overrides: Record<string, unknown> = {}) => ({
    event_id: 'event_12345678',
    capture_id: 'capture_12345678',
    parent_capture_id: 'capture_parent_1234',
    app_id: 'vanillaFixture1',
    scope: 'target',
    contract_version: 2,
    snapshot_schema_version: 1,
    captured_at: '2026-08-26 08:00:00.123',
    received_at: '2026-08-26 08:00:01.456',
    release: '2026.8.26',
    dist: 'web',
    environment: 'production',
    sdk_version: '2.0.0',
    monitor_version: '2.0.0',
    sample_rate: 0.25,
    sampling_policy_version: 2,
    route_key: 'catalog.detail',
    target_key: 'hero-canvas',
    visibility_state: 'visible',
    reduced_motion: 1,
    viewport_bucket: 'large',
    dpr_bucket: '2',
    refresh_hz: 120,
    refresh_budget_source: 'observed',
    refresh_budget_confidence: 'high',
    window_duration_ms: 10_000,
    window_duration_capped: 0,
    runtime_framework: 'react',
    runtime_renderer: 'canvas',
    runtime_backend: 'webgl2',
    capabilities_json: JSON.stringify({
        'long-animation-frame': 'supported',
        'gpu-timer-query': 'unsupported',
        url: 'https://private.invalid/path',
    }),
    coverage_json: JSON.stringify({
        frameCadence: { status: 'measured', evidenceLevel: 'runtime-observation', selector: '#private' },
        metadata: { email: 'private@example.invalid' },
    }),
    capture_sufficiency: 'sufficient',
    capture_integrity: 'partial',
    capture_quality_reasons: ['adapter-error', 'private-reason'],
    adapter_error_count: 1,
    provider_evidence_count: 1,
    metric_count: 1,
    ...overrides,
})

const result = (data: Record<string, unknown>[]) => ({ json: async () => ({ data }) })

describe('AnimationRumV2QueryService', () => {
    const createService = (clickhouse: { query: jest.Mock }, applications = { assertOwned: jest.fn().mockResolvedValue(undefined) }) => ({
        service: new AnimationRumV2QueryService(clickhouse as any, { get: () => 'lemonade' } as any, applications as any),
        applications,
    })

    it('authorizes first and summarizes only completed v2 captures with closed metric identities', async () => {
        const clickhouse = {
            query: jest
                .fn()
                .mockResolvedValueOnce(
                    result([
                        {
                            observed_capture_count: 2,
                            page_capture_count: 1,
                            target_capture_count: 1,
                            sufficient_capture_count: 2,
                            insufficient_capture_count: 0,
                            complete_capture_count: 1,
                            partial_capture_count: 1,
                            capped_capture_count: 0,
                            page_sufficient_capture_count: 1,
                            page_insufficient_capture_count: 0,
                            page_complete_capture_count: 1,
                            page_partial_capture_count: 0,
                            page_capped_capture_count: 0,
                            target_sufficient_capture_count: 1,
                            target_insufficient_capture_count: 0,
                            target_complete_capture_count: 0,
                            target_partial_capture_count: 1,
                            target_capped_capture_count: 0,
                            distinct_route_count: 1,
                            distinct_target_count: 1,
                            total_adapter_error_count: 1,
                            page_adapter_error_count: 0,
                            target_adapter_error_count: 1,
                            first_captured_at: '2026-08-26 08:00:00.123',
                            last_captured_at: '2026-08-26 09:00:00.123',
                        },
                    ])
                )
                .mockResolvedValueOnce(
                    result([
                        {
                            scope: 'target',
                            metric_id: 'frame.duration.p95',
                            relation: 'target-temporal-overlap',
                            owner: 'browser-core',
                            capture_count: 2,
                            measured_capture_count: 1,
                            partial_capture_count: 1,
                            not_observed_capture_count: 0,
                            not_instrumented_capture_count: 0,
                            unsupported_capture_count: 0,
                            unknown_capture_count: 0,
                            captures_with_value: 2,
                            measured_captures_with_value: 1,
                            partial_captures_with_value: 1,
                            reported_samples: 240,
                            measured_reported_samples: 120,
                            partial_reported_samples: 120,
                            capture_value_avg: 19,
                            capture_value_p50: 18,
                            capture_value_p75: 20,
                            capture_value_p95: 21,
                            capture_value_min: 17,
                            capture_value_max: 21,
                            normalized_captures_with_value: 0,
                        },
                        {
                            scope: 'target',
                            metric_id: 'main.long-task.count',
                            relation: 'target-temporal-overlap',
                            owner: 'browser-core',
                            capture_count: 2,
                            measured_capture_count: 1,
                            partial_capture_count: 1,
                            not_observed_capture_count: 0,
                            not_instrumented_capture_count: 0,
                            unsupported_capture_count: 0,
                            unknown_capture_count: 0,
                            captures_with_value: 2,
                            measured_captures_with_value: 1,
                            partial_captures_with_value: 1,
                            reported_samples: 240,
                            measured_reported_samples: 120,
                            partial_reported_samples: 120,
                            capture_value_avg: 99,
                            capture_value_p50: 99,
                            capture_value_p75: 99,
                            capture_value_p95: 99,
                            capture_value_min: 99,
                            capture_value_max: 99,
                            normalized_captures_with_value: 1,
                            value_per_minute_avg: 6,
                            value_per_minute_p50: 6,
                            value_per_minute_p75: 6,
                            value_per_minute_p95: 6,
                            value_per_minute_min: 6,
                            value_per_minute_max: 6,
                        },
                        {
                            scope: 'target',
                            metric_id: 'private.metric',
                            relation: 'target-direct',
                            owner: 'target-sidecar',
                            capture_count: 1,
                        },
                    ])
                )
                .mockResolvedValueOnce(
                    result([
                        { reason: 'adapter-error', capture_count: 1, page_capture_count: 0, target_capture_count: 1 },
                        { reason: 'private-reason', capture_count: 1, page_capture_count: 1, target_capture_count: 0 },
                    ])
                )
                .mockResolvedValueOnce(
                    result([
                        {
                            bucket: '2026-08-26 08:00:00.000',
                            observed_capture_count: 2,
                            page_capture_count: 1,
                            target_capture_count: 1,
                        },
                    ])
                )
                .mockResolvedValueOnce(
                    result([
                        {
                            bucket: '2026-08-26 08:00:00.000',
                            scope: 'target',
                            measured_captures_with_value: 1,
                            partial_captures_with_value: 1,
                            capture_value_p50: 18,
                            capture_value_p75: 19,
                            capture_value_p95: 20,
                        },
                    ])
                ),
        }
        const { service, applications } = createService(clickhouse)

        const response = await service.summary(41, {
            appId: 'vanillaFixture1',
            ...WINDOW,
            scope: 'target',
            release: '2026.8.26',
        })

        expect(applications.assertOwned).toHaveBeenCalledWith('vanillaFixture1', 41)
        expect(applications.assertOwned.mock.invocationCallOrder[0]).toBeLessThan(clickhouse.query.mock.invocationCallOrder[0])
        expect(response).toEqual(
            expect.objectContaining({
                contractVersion: 2,
                snapshotSchemaVersion: 1,
                catalogMetricCount: 69,
                aggregationSemantics: 'distribution-of-capture-aggregates',
                captures: expect.objectContaining({
                    observed: 2,
                    page: 1,
                    target: 1,
                    adapterErrors: 1,
                    byScope: {
                        page: { observed: 1, sufficient: 1, insufficient: 0, complete: 1, partial: 0, capped: 0, adapterErrors: 0 },
                        target: { observed: 1, sufficient: 1, insufficient: 0, complete: 0, partial: 1, capped: 0, adapterErrors: 1 },
                    },
                }),
                qualityReasons: [{ reason: 'adapter-error', captures: 1 }],
                qualityReasonsByScope: {
                    page: [],
                    target: [{ reason: 'adapter-error', captures: 1 }],
                },
                trend: expect.objectContaining({
                    bucket: expect.objectContaining({ kind: 'hour', maximumPoints: 49, timezone: 'UTC' }),
                    points: [
                        expect.objectContaining({
                            observedCaptures: 2,
                            frameP95: expect.objectContaining({
                                target: {
                                    measuredCaptures: 1,
                                    partialCaptures: 1,
                                    excludedPartialCaptures: 1,
                                    captureValue: { p50: 18, p75: 19, p95: 20 },
                                },
                            }),
                        }),
                    ],
                }),
            })
        )
        expect(response.metrics).toHaveLength(2)
        expect(response.metrics.find(metric => metric?.metricId === 'frame.duration.p95')).toEqual(
            expect.objectContaining({
                metricId: 'frame.duration.p95',
                family: 'frameCadence',
                scope: 'target',
                relation: 'target-temporal-overlap',
                owner: 'browser-core',
                statusCounts: expect.objectContaining({ measured: 1, partial: 1 }),
                measuredCaptures: 1,
                partialCaptures: 1,
                excludedPartialCaptures: 1,
                captureValue: expect.objectContaining({ p95: 21 }),
                valuePerMinute: null,
            })
        )
        expect(response.metrics.find(metric => metric?.metricId === 'main.long-task.count')).toEqual(
            expect.objectContaining({
                captureValue: {
                    aggregation: 'distribution-of-capture-aggregates',
                    measuredCaptures: 1,
                    partialCaptures: 1,
                    excludedPartialCaptures: 1,
                    average: null,
                    p50: null,
                    p75: null,
                    p95: null,
                    min: null,
                    max: null,
                },
                valuePerMinute: expect.objectContaining({ capturesWithValue: 1, p95: 6 }),
            })
        )

        const queries = clickhouse.query.mock.calls.map(call => call[0])
        expect(queries[0].query).toContain('animation_rum_captures_v2 FINAL')
        expect(queries[1].query).toContain('INNER JOIN completed_captures')
        expect(queries[1].query).toContain('metric.event_id = capture.event_id')
        expect(queries[1].query).toContain('GROUP BY scope, metric_id, relation, owner')
        expect(queries[1].query).toContain("status = 'measured' AND value IS NOT NULL")
        expect(queries[1].query).not.toContain('2026.8.26')
        expect(queries[1].query_params).toEqual(expect.objectContaining({ appId: 'vanillaFixture1', release: '2026.8.26' }))
        expect(queries[4].query).toContain("metric.status = 'measured' AND metric.value IS NOT NULL")
        expect(queries[4].query).toContain('owner = {frameP95Owner:String}')
        expect(queries[4].query_params).toEqual(
            expect.objectContaining({
                frameP95Owner: 'browser-core',
                frameP95PageRelation: 'page-window',
                frameP95TargetRelation: 'target-temporal-overlap',
            })
        )
        expect(queries.every(query => query.clickhouse_settings?.max_execution_time === 15)).toBe(true)
        expect(queries.every(query => query.clickhouse_settings?.result_overflow_mode === 'throw')).toBe(true)
    })

    it('never reaches ClickHouse when application ownership is rejected', async () => {
        const clickhouse = { query: jest.fn() }
        const applications = { assertOwned: jest.fn().mockRejectedValue(new ForbiddenException('Application not found')) }
        const { service } = createService(clickhouse, applications)

        await expect(service.summary(41, { appId: 'otherApp', ...WINDOW })).rejects.toBeInstanceOf(ForbiddenException)
        expect(clickhouse.query).not.toHaveBeenCalled()
    })

    it('excludes partial values from distributions, returns null without measured captures, and preserves large UInt64 values', () => {
        const { service } = createService({ query: jest.fn() })
        const view = (service as any).summaryMetricView({
            scope: 'target',
            metric_id: 'frame.duration.p95',
            relation: 'target-temporal-overlap',
            owner: 'browser-core',
            capture_count: '9007199254740993',
            measured_capture_count: 0,
            partial_capture_count: 1,
            not_observed_capture_count: 0,
            not_instrumented_capture_count: 0,
            unsupported_capture_count: 0,
            unknown_capture_count: 0,
            captures_with_value: 1,
            measured_captures_with_value: 0,
            partial_captures_with_value: 1,
            reported_samples: '9007199254740995',
            measured_reported_samples: 0,
            partial_reported_samples: '9007199254740995',
            capture_value_avg: 99,
            capture_value_p50: 99,
            capture_value_p75: 99,
            capture_value_p95: 99,
            capture_value_min: 99,
            capture_value_max: 99,
            normalized_captures_with_value: 0,
        })

        expect(view).toEqual(
            expect.objectContaining({
                captureCount: '9007199254740993',
                measuredCaptures: 0,
                partialCaptures: 1,
                excludedPartialCaptures: 1,
                reportedSamples: '9007199254740995',
                captureValue: expect.objectContaining({ average: null, p50: null, p75: null, p95: null, min: null, max: null }),
            })
        )
    })

    it('keeps every possible non-aligned trend bucket instead of slicing off time', () => {
        const { service } = createService({ query: jest.fn() })
        const query = {
            from: new Date('2026-08-25T00:30:00.000Z'),
            to: new Date('2026-08-27T00:30:00.000Z'),
        }
        const bucket = (service as any).trendBucket(query)
        const rows = Array.from({ length: 49 }, (_, index) => ({
            bucket: new Date(Date.UTC(2026, 7, 25, index)).toISOString(),
            observed_capture_count: 1,
            page_capture_count: 1,
            target_capture_count: 0,
        }))
        const trend = (service as any).trendView(bucket, rows, [])

        expect(bucket).toEqual({ kind: 'hour', durationMs: 3_600_000, maximumPoints: 49 })
        expect(trend.points).toHaveLength(49)
        expect(trend.points[0].at).toBe('2026-08-25T00:00:00.000Z')
        expect(trend.points[48].at).toBe('2026-08-27T00:00:00.000Z')
    })

    it('rejects non-canonical calendar timestamps before querying ClickHouse', async () => {
        const clickhouse = { query: jest.fn() }
        const { service, applications } = createService(clickhouse)

        await expect(
            service.summary(41, {
                appId: 'vanillaFixture1',
                from: '2026-02-30T00:00:00.000Z',
                to: '2026-03-01T00:00:00.000Z',
            })
        ).rejects.toMatchObject({ status: 400 })
        expect(applications.assertOwned).toHaveBeenCalledTimes(1)
        expect(clickhouse.query).not.toHaveBeenCalled()
    })

    it('clamps queries to the server retention floor before reading ClickHouse', async () => {
        const clickhouse = {
            query: jest
                .fn()
                .mockResolvedValueOnce(result([]))
                .mockResolvedValueOnce(result([]))
                .mockResolvedValueOnce(result([]))
                .mockResolvedValueOnce(result([]))
                .mockResolvedValueOnce(result([])),
        }
        const { service } = createService(clickhouse)

        const response = await service.summary(41, {
            appId: 'vanillaFixture1',
            from: '1970-01-01T00:00:00.000Z',
            to: new Date().toISOString(),
        })

        expect(response.window.retentionClamped).toBe(true)
        const effectiveFrom = new Date(response.window.from).getTime()
        expect(effectiveFrom).toBeGreaterThan(Date.now() - 90 * 24 * 60 * 60 * 1000 - 1_000)
        expect(clickhouse.query.mock.calls.every(call => call[0].query_params.from !== '1970-01-01 00:00:00.000')).toBe(true)
    })

    it('returns a paginated lightweight capture list with closed quality fields', async () => {
        const pageRow = captureRow({ parent_capture_id: '', scope: 'page', target_key: '' })
        const clickhouse = {
            query: jest
                .fn()
                .mockResolvedValueOnce(result([{ capture_count: 3 }]))
                .mockResolvedValueOnce(result([pageRow]))
                .mockResolvedValueOnce(result([{ parent_capture_id: 'capture_12345678', target_child_count: 2 }]))
                .mockResolvedValueOnce(
                    result([
                        {
                            capture_id: 'capture_12345678',
                            scope: 'page',
                            metric_id: 'frame.duration.p95',
                            relation: 'page-window',
                            owner: 'browser-core',
                            value: 18.5,
                            samples: 120,
                            status: 'measured',
                        },
                    ])
                ),
        }
        const { service } = createService(clickhouse)

        const response = await service.captures(41, {
            appId: 'vanillaFixture1',
            ...WINDOW,
            scope: 'page',
            limit: 1,
            offset: 1,
        })

        expect(response.pagination).toEqual({ total: 3, limit: 1, offset: 1, hasMore: true })
        expect(response.captures[0]).toEqual(
            expect.objectContaining({
                captureId: 'capture_12345678',
                parentCaptureId: null,
                scope: 'page',
                targetKey: null,
                quality: { sufficiency: 'sufficient', integrity: 'partial', reasons: ['adapter-error'], adapterErrorCount: 1 },
                targetChildCount: 2,
                frameP95: expect.objectContaining({ metricId: 'frame.duration.p95', value: 18.5 }),
            })
        )
        expect(response.captures[0]).not.toHaveProperty('capabilities')
        expect(response.captures[0]).not.toHaveProperty('coverage')
        expect(JSON.stringify(response)).not.toContain('private')
    })

    it('returns detail children only for the exact completion event and strips unknown JSON fields', async () => {
        const clickhouse = {
            query: jest
                .fn()
                .mockResolvedValueOnce(result([captureRow()]))
                .mockResolvedValueOnce(
                    result([
                        {
                            scope: 'target',
                            metric_id: 'frame.duration.p95',
                            relation: 'target-temporal-overlap',
                            owner: 'browser-core',
                            value: 18.5,
                            samples: 120,
                            status: 'measured',
                        },
                        {
                            scope: 'target',
                            metric_id: 'private.metric',
                            relation: 'target-direct',
                            owner: 'target-sidecar',
                            value: 1,
                            samples: 1,
                            status: 'measured',
                        },
                    ])
                )
                .mockResolvedValueOnce(
                    result([
                        {
                            scope: 'target',
                            owner: 'browser-core',
                            family: 'frameCadence',
                            provider_version: '2.0.0',
                            accepted: 120,
                            retained: 100,
                            evidence: 100,
                            dropped: 20,
                            rejected: 0,
                            truncated: 1,
                        },
                        {
                            scope: 'target',
                            owner: 'private-owner',
                            family: 'frameCadence',
                            provider_version: '2.0.0',
                            accepted: 1,
                            retained: 1,
                            evidence: 1,
                            dropped: 0,
                            rejected: 0,
                            truncated: 0,
                        },
                    ])
                )
                .mockResolvedValueOnce(
                    result([
                        captureRow({
                            event_id: 'event_parent_1234',
                            capture_id: 'capture_parent_1234',
                            parent_capture_id: '',
                            scope: 'page',
                            target_key: '',
                        }),
                    ])
                ),
        }
        const { service } = createService(clickhouse)

        const response = await service.capture(41, 'vanillaFixture1', 'capture_12345678')

        expect(response.capture).toEqual(
            expect.objectContaining({
                eventId: 'event_12345678',
                contractVersion: 2,
                snapshotSchemaVersion: 1,
                scope: 'target',
                parentCaptureId: 'capture_parent_1234',
                targetKey: 'hero-canvas',
            })
        )
        expect(Object.keys(response.capture.capabilities)).toEqual([...ANIMATION_RUM_V2_CAPABILITIES])
        expect(Object.keys(response.capture.coverage)).toEqual([...ANIMATION_RUM_FAMILIES])
        expect(response.capture.capabilities).not.toHaveProperty('url')
        expect(response.capture.coverage).not.toHaveProperty('metadata')
        expect(response.metrics).toEqual([
            expect.objectContaining({
                metricId: 'frame.duration.p95',
                relation: 'target-temporal-overlap',
                owner: 'browser-core',
                value: 18.5,
            }),
        ])
        expect(response.providerEvidence).toEqual([
            {
                owner: 'browser-core',
                family: 'frameCadence',
                providerVersion: '2.0.0',
                accepted: 120,
                retained: 100,
                evidence: 100,
                dropped: 20,
                rejected: 0,
                truncated: true,
            },
        ])
        expect(response.relationships).toEqual(
            expect.objectContaining({
                parent: expect.objectContaining({ captureId: 'capture_parent_1234', scope: 'page', targetKey: null }),
                targets: null,
            })
        )
        const childCalls = clickhouse.query.mock.calls.slice(1, 3).map(call => call[0])
        expect(childCalls).toHaveLength(2)
        expect(childCalls.every(call => call.query.includes('event_id = {eventId:String}'))).toBe(true)
        expect(childCalls.every(call => call.query_params.eventId === 'event_12345678')).toBe(true)
        expect(clickhouse.query.mock.calls[0][0].query).toContain('captured_at >= {retentionFloor')
        expect(clickhouse.query.mock.calls[0][0].query_params.retentionFloor).toBeDefined()
        expect(clickhouse.query.mock.calls[3][0].query).toContain('captured_at >= {retentionFloor')
        expect(JSON.stringify(response)).not.toContain('private.invalid')
        expect(JSON.stringify(response)).not.toContain('#private')
    })

    it('returns bounded target summaries with a page detail instead of requiring per-target reads', async () => {
        const page = captureRow({ parent_capture_id: '', scope: 'page', target_key: '' })
        const child = captureRow({
            event_id: 'event_child_1234',
            capture_id: 'capture_child_1234',
            parent_capture_id: 'capture_12345678',
        })
        const clickhouse = {
            query: jest
                .fn()
                .mockResolvedValueOnce(result([page]))
                .mockResolvedValueOnce(result([]))
                .mockResolvedValueOnce(result([]))
                .mockResolvedValueOnce(result([child])),
        }
        const { service } = createService(clickhouse)

        const response = await service.capture(41, 'vanillaFixture1', 'capture_12345678')

        expect(response.relationships).toEqual({
            parent: null,
            targets: {
                items: [expect.objectContaining({ captureId: 'capture_child_1234', parentCaptureId: 'capture_12345678' })],
                returned: 1,
                hasMore: false,
            },
        })
        const relationshipCall = clickhouse.query.mock.calls[3][0]
        expect(relationshipCall.query).toContain("scope = 'target'")
        expect(relationshipCall.query).toContain('parent_capture_id = {captureId:String}')
        expect(relationshipCall.query).toContain('LIMIT 101')
        expect(relationshipCall.query_params).toEqual(
            expect.objectContaining({ appId: 'vanillaFixture1', captureId: 'capture_12345678', retentionFloor: expect.any(String) })
        )
    })

    it('returns 404 without reading child tables when the owned capture does not exist', async () => {
        const clickhouse = { query: jest.fn().mockResolvedValueOnce(result([])) }
        const { service } = createService(clickhouse)

        await expect(service.capture(41, 'vanillaFixture1', 'capture_missing1')).rejects.toBeInstanceOf(NotFoundException)
        expect(clickhouse.query).toHaveBeenCalledTimes(1)
    })

    it('rejects invalid cross-scope filters after ownership but before querying ClickHouse', async () => {
        const clickhouse = { query: jest.fn() }
        const { service, applications } = createService(clickhouse)

        await expect(
            service.summary(41, { appId: 'vanillaFixture1', ...WINDOW, scope: 'page', targetKey: 'hero-canvas' })
        ).rejects.toMatchObject({ status: 400 })
        expect(applications.assertOwned).toHaveBeenCalledTimes(1)
        expect(clickhouse.query).not.toHaveBeenCalled()
    })
})
