import { BadRequestException, NotFoundException } from '@nestjs/common'

import { AnimationRumV3SoftNavigationQueryService } from './animation-rum-v3-query.service'

const WINDOW = {
    from: '2026-08-26T00:00:00Z',
    to: '2026-08-27T00:00:00.000Z',
}

const captureRow = (overrides: Record<string, unknown> = {}) => ({
    event_id: 'event_12345678',
    capture_id: 'capture_12345678',
    contract_version: 3,
    snapshot_schema_version: 1,
    capture_kind: 'soft-navigation',
    scope: 'page',
    captured_at: '2026-08-26 08:00:00.123',
    received_at: '2026-08-26 08:00:01.456',
    release: '2026.8.26',
    dist: 'web',
    environment: 'production',
    sdk_version: '3.0.0',
    monitor_version: '3.0.0',
    sample_rate: 0.25,
    sampling_policy_version: 3,
    route_key: 'catalog.detail',
    visibility_state: 'visible',
    reduced_motion: 0,
    viewport_bucket: 'large',
    dpr_bucket: '2',
    refresh_hz: 120,
    refresh_budget_source: 'observed',
    refresh_budget_confidence: 'high',
    window_duration_ms: 4_000,
    window_duration_capped: 0,
    runtime_framework: 'react',
    runtime_renderer: 'dom',
    runtime_backend: 'dom',
    capabilities_json: JSON.stringify({
        'web-vitals-soft-navigation': {
            status: 'supported',
            metrics: { CLS: 'supported', INP: 'supported', LCP: 'supported' },
        },
    }),
    coverage_json: JSON.stringify({ userOutcome: { status: 'measured', evidenceLevel: 'runtime-observation' } }),
    capture_sufficiency: 'sufficient',
    capture_integrity: 'complete',
    capture_quality_reasons: [],
    provider_evidence_count: 1,
    metric_count: 3,
    ...overrides,
})

const result = (data: Record<string, unknown>[]) => ({ json: async () => ({ data }) })

describe('AnimationRumV3SoftNavigationQueryService', () => {
    const createService = (clickhouse: { query: jest.Mock }, applications = { assertOwned: jest.fn().mockResolvedValue(undefined) }) => ({
        service: new AnimationRumV3SoftNavigationQueryService(clickhouse as any, { get: () => 'lemonade' } as any, applications as any),
        applications,
    })

    it('authorizes first, binds filters, and hides percentiles until 30 measured captures exist', async () => {
        const clickhouse = {
            query: jest
                .fn()
                .mockResolvedValueOnce(
                    result([
                        {
                            completion_marker_count: '64',
                            capture_count: '61',
                            sufficient_capture_count: '60',
                            insufficient_capture_count: '1',
                            partial_capture_count: '2',
                            excluded_capture_count: '3',
                            metric_count_mismatch_count: '1',
                            provider_count_mismatch_count: '1',
                            child_identity_mismatch_count: '1',
                        },
                    ])
                )
                .mockResolvedValueOnce(
                    result([
                        {
                            route_key: 'catalog.detail',
                            release: '2026.8.26',
                            environment: 'production',
                            runtime_framework: 'react',
                            runtime_renderer: 'dom',
                            runtime_backend: 'dom',
                            metric_id: 'vital.soft-navigation.cls.latest',
                            vital_name: 'CLS',
                            unit: 'ratio',
                            capture_count: '31',
                            measured_count: '29',
                            partial_count: '1',
                            not_observed_count: '1',
                            not_instrumented_count: '0',
                            unsupported_count: '0',
                            unknown_count: '0',
                            insufficient_evidence_count: '1',
                            reported_samples: '30',
                            value_p50: 0.01,
                            value_p75: 0.02,
                            value_p95: 0.03,
                        },
                        {
                            route_key: 'catalog.detail',
                            release: '2026.8.26',
                            environment: 'production',
                            runtime_framework: 'react',
                            runtime_renderer: 'dom',
                            runtime_backend: 'dom',
                            metric_id: 'vital.soft-navigation.inp.latest',
                            vital_name: 'INP',
                            unit: 'ms',
                            capture_count: '30',
                            measured_count: '30',
                            partial_count: '0',
                            not_observed_count: '0',
                            not_instrumented_count: '0',
                            unsupported_count: '0',
                            unknown_count: '0',
                            insufficient_evidence_count: '0',
                            reported_samples: '30',
                            value_p50: 80,
                            value_p75: 120,
                            value_p95: 180,
                        },
                    ])
                ),
        }
        const { service, applications } = createService(clickhouse)

        const response = await service.summary(41, {
            appId: 'vanillaFixture1',
            ...WINDOW,
            routeKey: 'catalog.detail',
            release: '2026.8.26',
            environment: 'production',
            runtimeFramework: 'react',
        })

        expect(applications.assertOwned).toHaveBeenCalledWith('vanillaFixture1', 41)
        expect(applications.assertOwned.mock.invocationCallOrder[0]).toBeLessThan(clickhouse.query.mock.invocationCallOrder[0])
        expect(response.window).toEqual(expect.objectContaining({ from: '2026-08-26T00:00:00.000Z', retentionClamped: false }))
        expect(response.captures).toEqual({ total: 61, sufficient: 60, insufficient: 1, partial: 2 })
        expect(response.projectionIntegrity).toEqual({
            semantics: 'completion-marker-child-row-counts',
            completionMarkers: 64,
            verified: 61,
            excludedFromAnalytics: 3,
            metricCountMismatches: 1,
            providerEvidenceCountMismatches: 1,
            childIdentityMismatches: 1,
        })
        expect(response.groups[0]).toEqual(
            expect.objectContaining({
                measuredCount: 29,
                partialCount: 1,
                notObservedCount: 1,
                disclosure: { minimumSampleThreshold: 30, status: 'insufficient-samples' },
                captureValue: { p50: null, p75: null, p95: null },
            })
        )
        expect(response.groups[1]).toEqual(
            expect.objectContaining({
                measuredCount: 30,
                disclosure: { minimumSampleThreshold: 30, status: 'available' },
                captureValue: { p50: 80, p75: 120, p95: 180 },
            })
        )
        for (const call of clickhouse.query.mock.calls) {
            expect(call[0].query).not.toContain('catalog.detail')
            expect(call[0].query_params).toEqual(
                expect.objectContaining({
                    appId: 'vanillaFixture1',
                    routeKey: 'catalog.detail',
                    release: '2026.8.26',
                    environment: 'production',
                    runtimeFramework: 'react',
                })
            )
        }
        expect(clickhouse.query.mock.calls[0][0].query).toContain('projection_complete')
        expect(clickhouse.query.mock.calls[1][0].query).toContain('WHERE projection_complete')
        expect(clickhouse.query.mock.calls[1][0].query).toContain('animation_rum_soft_navigation_metrics_v3 FINAL')
        expect(clickhouse.query.mock.calls[1][0].query).toContain('animation_rum_soft_navigation_provider_evidence_v3 FINAL')
    })

    it('attaches only metrics whose event and capture identities both match', async () => {
        const clickhouse = {
            query: jest
                .fn()
                .mockResolvedValueOnce(result([{ capture_count: '1' }]))
                .mockResolvedValueOnce(result([captureRow()]))
                .mockResolvedValueOnce(
                    result([
                        {
                            event_id: 'event_12345678',
                            capture_id: 'capture_12345678',
                            route_key: 'catalog.detail',
                            captured_at: '2026-08-26 08:00:00.123',
                            metric_id: 'vital.soft-navigation.inp.latest',
                            vital_name: 'INP',
                            unit: 'ms',
                            value: 140,
                            samples: 1,
                            status: 'measured',
                        },
                        {
                            event_id: 'event_mismatch1',
                            capture_id: 'capture_12345678',
                            route_key: 'catalog.detail',
                            captured_at: '2026-08-26 08:00:00.123',
                            metric_id: 'vital.soft-navigation.lcp.latest',
                            vital_name: 'LCP',
                            unit: 'ms',
                            value: 900,
                            samples: 1,
                            status: 'measured',
                        },
                    ])
                ),
        }
        const { service } = createService(clickhouse)

        const response = await service.captures(41, { appId: 'vanillaFixture1', ...WINDOW, limit: 20 })

        expect(response.pagination).toEqual({ total: 1, limit: 20, offset: 0, hasMore: false })
        expect(response.captures[0].metrics).toEqual([
            expect.objectContaining({ metricId: 'vital.soft-navigation.inp.latest', value: 140, samples: 1, status: 'measured' }),
        ])
        expect(clickhouse.query.mock.calls[1][0].query).toContain('WHERE projection_complete')
        expect(clickhouse.query.mock.calls[2][0].query).toContain('route_key IN {routeKeys:Array(String)}')
        expect(clickhouse.query.mock.calls[2][0].query_params).toEqual({
            appId: 'vanillaFixture1',
            routeKeys: ['catalog.detail'],
            capturedFrom: '2026-08-26 08:00:00.123',
            capturedTo: '2026-08-26 08:00:00.123',
            captureIds: ['capture_12345678'],
        })
    })

    it('returns a closed capture detail with matching provider evidence', async () => {
        const clickhouse = {
            query: jest
                .fn()
                .mockResolvedValueOnce(result([captureRow()]))
                .mockResolvedValueOnce(
                    result([
                        {
                            event_id: 'event_12345678',
                            capture_id: 'capture_12345678',
                            route_key: 'catalog.detail',
                            captured_at: '2026-08-26 08:00:00.123',
                            metric_id: 'vital.soft-navigation.cls.latest',
                            vital_name: 'CLS',
                            unit: 'ratio',
                            value: null,
                            samples: null,
                            status: 'not-observed',
                        },
                    ])
                )
                .mockResolvedValueOnce(
                    result([
                        {
                            owner: 'web-vitals-runtime',
                            family: 'userOutcome',
                            provider_version: '4.2.0',
                            accepted: 2,
                            retained: 2,
                            evidence: 2,
                            dropped: 0,
                            rejected: 0,
                            truncated: 0,
                        },
                    ])
                ),
        }
        const { service } = createService(clickhouse)

        const response = await service.capture(41, 'vanillaFixture1', 'capture_12345678')

        expect(response.capture.metrics).toEqual([
            expect.objectContaining({ metricId: 'vital.soft-navigation.cls.latest', value: null, samples: null, status: 'not-observed' }),
        ])
        expect(response.capture.providerEvidence).toEqual(
            expect.objectContaining({ owner: 'web-vitals-runtime', version: '4.2.0', accepted: 2, truncated: false })
        )
        expect(response.capture.capabilities).toEqual({
            'web-vitals-soft-navigation': {
                status: 'supported',
                metrics: { CLS: 'supported', INP: 'supported', LCP: 'supported' },
            },
        })
        expect(response.capture.coverage).toEqual({ userOutcome: { status: 'measured', evidenceLevel: 'runtime-observation' } })
        expect(clickhouse.query.mock.calls[1][0].query_params).toEqual({
            appId: 'vanillaFixture1',
            routeKeys: ['catalog.detail'],
            capturedFrom: '2026-08-26 08:00:00.123',
            capturedTo: '2026-08-26 08:00:00.123',
            captureIds: ['capture_12345678'],
        })
        expect(clickhouse.query.mock.calls[2][0].query_params).toEqual({
            appId: 'vanillaFixture1',
            routeKey: 'catalog.detail',
            captureId: 'capture_12345678',
            eventId: 'event_12345678',
            capturedAt: '2026-08-26 08:00:00.123',
        })
        expect(JSON.stringify(response)).not.toContain('selector')
    })

    it('rejects invalid filters before querying ClickHouse and reports missing captures', async () => {
        const clickhouse = { query: jest.fn().mockResolvedValue(result([])) }
        const { service, applications } = createService(clickhouse)

        await expect(service.summary(41, { appId: 'vanillaFixture1', ...WINDOW, routeKey: 'Private Path' })).rejects.toBeInstanceOf(
            BadRequestException
        )
        expect(applications.assertOwned).toHaveBeenCalledWith('vanillaFixture1', 41)
        expect(clickhouse.query).not.toHaveBeenCalled()

        await expect(service.capture(41, 'vanillaFixture1', 'capture_missing1')).rejects.toBeInstanceOf(NotFoundException)
    })
})
