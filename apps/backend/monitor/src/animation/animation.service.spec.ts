import { AnimationService } from './animation.service'

describe('AnimationService', () => {
    it('treats ClickHouse DateTime64 values as UTC and returns capture metrics', async () => {
        const clickhouse = {
            query: jest
                .fn()
                .mockResolvedValueOnce({
                    json: async () => ({
                        data: [
                            {
                                event_id: 'event_12345678',
                                capture_id: 'capture_12345678',
                                captured_at: '2026-08-23 08:00:00.123',
                                received_at: '2026-08-23 08:00:01.456',
                                release: '',
                                dist: '',
                                environment: '',
                                sdk_version: '',
                                monitor_version: '1.0.0',
                                sample_rate: 1,
                                sampling_policy_version: 1,
                                route_key: '',
                                runtime_family: 'react',
                                context_json: '{}',
                                capabilities_json: '{}',
                                coverage_json: '{}',
                            },
                        ],
                    }),
                })
                .mockResolvedValueOnce({
                    json: async () => ({
                        data: [
                            {
                                event_id: 'event_12345678',
                                capture_id: 'capture_12345678',
                                family: 'frameCadence',
                                name: 'frameDurationMs',
                                stat: 'p95',
                                unit: 'ms',
                                value: 17,
                                samples: 100,
                                status: 'measured',
                            },
                            {
                                event_id: 'event_stale_12345678',
                                capture_id: 'capture_12345678',
                                family: 'mainThread',
                                name: 'longTaskCount',
                                stat: 'count',
                                unit: 'count',
                                value: 99,
                                samples: 99,
                                status: 'measured',
                            },
                        ],
                    }),
                }),
        }
        const service = new AnimationService(clickhouse as any, { get: () => 'lemonade' } as any)
        const result = await service.captures({
            appId: 'app-12345678',
            from: '2026-08-23T00:00:00.000Z',
            to: '2026-08-23T12:00:00.000Z',
        })

        expect(result.captures[0]).toEqual(
            expect.objectContaining({
                capturedAt: '2026-08-23T08:00:00.123Z',
                receivedAt: '2026-08-23T08:00:01.456Z',
                metrics: [expect.objectContaining({ name: 'frameDurationMs', value: 17 })],
            })
        )
        expect(result.captures[0]?.metrics).toHaveLength(1)
    })

    it('groups summary rows by metric identity, not raw per-capture status', async () => {
        const queries: string[] = []
        const clickhouse = {
            query: jest.fn().mockImplementation(async ({ query }: { query: string }) => {
                queries.push(query)
                return {
                    json: async () => ({
                        data: query.includes('capture_count')
                            ? [{ capture_count: 2 }]
                            : [
                                  {
                                      family: 'mainThread',
                                      name: 'longTaskCount',
                                      stat: 'count',
                                      unit: 'count',
                                      status: 'measured',
                                      captures_with_value: 2,
                                      reported_samples: 7,
                                      value_avg: 3.5,
                                      value_p50: 3,
                                      value_p75: 4,
                                      value_p95: 4,
                                      value_min: 3,
                                      value_max: 4,
                                      normalized_captures_with_value: 1,
                                      value_per_minute_avg: 2,
                                      value_per_minute_p50: 2,
                                      value_per_minute_p75: 2,
                                      value_per_minute_p95: 2,
                                      value_per_minute_min: 2,
                                      value_per_minute_max: 2,
                                  },
                              ],
                    }),
                }
            }),
        }
        const service = new AnimationService(clickhouse as any, { get: () => 'lemonade' } as any)
        const result = await service.summary({
            appId: 'app-12345678',
            from: '2026-08-23T00:00:00.000Z',
            to: '2026-08-23T12:00:00.000Z',
        })

        const metricQuery = queries.find(query => query.includes('quantileTDigestIf')) ?? ''
        expect(metricQuery).toContain('GROUP BY family, name, stat, unit')
        expect(metricQuery).not.toContain('GROUP BY family, name, stat, unit, status')
        expect(metricQuery).toContain('argMax(tuple(unit, status, value, samples), received_at) AS latest_metric')
        expect(metricQuery).toContain('GROUP BY event_id, capture_id, family, name, stat')
        expect(metricQuery).not.toContain('GROUP BY event_id, capture_id, family, name, stat, unit')
        expect(metricQuery).not.toContain('argMax(value, received_at)')
        expect(metricQuery).toContain("count() = countIf(status = 'measured')")
        expect(metricQuery).toContain('FROM lemonade.animation_rum_captures_v1')
        expect(metricQuery).toContain('INNER JOIN')
        expect(metricQuery).toContain('latest.event_id = capture.event_id')
        expect(metricQuery).toContain('argMax(tuple(event_id, context_json), received_at) AS latest_capture')
        expect(metricQuery).toContain("JSONExtractFloat(tupleElement(latest_capture, 2), 'windowDurationMs')")
        expect(metricQuery).toContain("latest.status != 'measured'")
        expect(metricQuery).toContain('capture.window_duration_ms < 5000 OR capture.window_duration_capped')
        expect(metricQuery).toContain('greatest(capture.window_duration_ms, 5000)')
        expect(result.normalization).toEqual({
            kind: 'per-minute',
            minimumWindowMs: 5000,
            excludesCappedWindows: true,
            requiresMeasuredStatus: true,
        })
        expect(result.metrics[0]).toEqual(
            expect.objectContaining({
                normalizedCapturesWithValue: 1,
                valuePerMinuteP75: 2,
                valueAvg: null,
                valueP50: null,
                valueP75: null,
                valueP95: null,
                valueMin: null,
                valueMax: null,
            })
        )
    })
})
