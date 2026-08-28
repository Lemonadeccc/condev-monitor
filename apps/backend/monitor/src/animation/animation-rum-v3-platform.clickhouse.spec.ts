import { randomUUID } from 'node:crypto'

import { createClient } from '@clickhouse/client'

import { AnimationRumV3SoftNavigationPipelineService } from './animation-rum-v3-pipeline.service'
import { AnimationRumV3SoftNavigationQueryService } from './animation-rum-v3-query.service'

const describeIntegration = process.env.RUN_CLICKHOUSE_INTEGRATION === '1' ? describe : describe.skip
const TABLES = [
    'animation_rum_soft_navigation_provider_evidence_v3',
    'animation_rum_soft_navigation_metrics_v3',
    'animation_rum_soft_navigation_captures_v3',
] as const

function required(name: string, allowEmpty = false): string {
    const value = process.env[name]
    if (value === undefined || (!allowEmpty && value.trim() === ''))
        throw new Error(`${name} is required for the ClickHouse integration suite`)
    return value
}

function clickhouseTimestamp(date: Date): string {
    return date.toISOString().replace('T', ' ').replace('Z', '')
}

async function cleanup(client: ReturnType<typeof createClient>, database: string, appId: string): Promise<void> {
    const errors: unknown[] = []
    for (const table of TABLES) {
        try {
            await client.command({
                query: `ALTER TABLE ${database}.${table} DELETE WHERE app_id = {appId:String}`,
                query_params: { appId },
                clickhouse_settings: { mutations_sync: '2' },
            })
        } catch (error) {
            errors.push(error)
        }
    }
    if (errors.length > 0) throw new AggregateError(errors, `Failed to clean Animation RUM v3 rows for ${appId}`)
}

describeIntegration('Animation RUM v3 Monitor ClickHouse platform path', () => {
    jest.setTimeout(60_000)

    let client: ReturnType<typeof createClient>
    let database: string

    beforeAll(() => {
        database = required('TEST_CLICKHOUSE_DATABASE')
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(database)) throw new Error('TEST_CLICKHOUSE_DATABASE must be a simple identifier')
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

    it('executes query and pipeline projection SQL against complete child rows', async () => {
        const suffix = randomUUID().replaceAll('-', '').slice(0, 16)
        const appId = `rumV3Platform${suffix}`
        const routeKey = 'integration.soft-navigation'
        const captureId = `capture_${suffix}`
        const eventId = `event_${suffix}`
        const observedAt = new Date()
        const capturedAt = new Date(observedAt.getTime() - 5 * 60_000)
        const receivedAt = new Date(observedAt.getTime() - 4 * 60_000)
        const transitionAt = new Date(observedAt.getTime() - 3 * 60_000)
        const common = {
            event_id: eventId,
            capture_id: captureId,
            app_id: appId,
            capture_kind: 'soft-navigation',
            scope: 'page',
            captured_at: clickhouseTimestamp(capturedAt),
            received_at: clickhouseTimestamp(receivedAt),
            release: 'integration-1.0.0',
            dist: '1',
            environment: 'integration',
            route_key: routeKey,
            runtime_framework: 'vanilla',
            runtime_renderer: 'dom',
            runtime_backend: 'dom',
            window_duration_ms: 4_000,
            window_duration_capped: 0,
        }
        const captures = [
            {
                ...common,
                contract_version: 3,
                snapshot_schema_version: 1,
                sdk_version: '3.0.0',
                monitor_version: '3.0.0',
                sample_rate: 1,
                sampling_policy_version: 1,
                visibility_state: 'visible',
                reduced_motion: 0,
                viewport_bucket: 'large',
                dpr_bucket: '2',
                refresh_hz: 60,
                refresh_budget_source: 'observed',
                refresh_budget_confidence: 'high',
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
            },
        ]
        const metric = (metricId: string, vitalName: string, unit: string, value: number) => ({
            ...common,
            sample_rate: 1,
            sampling_policy_version: 1,
            metric_id: metricId,
            vital_name: vitalName,
            unit,
            evidence_window: 'soft-navigation-lifetime',
            relation: 'page-window',
            owner: 'web-vitals-runtime',
            value,
            samples: 1,
            status: 'measured',
        })
        const metrics = [
            metric('vital.soft-navigation.cls.latest', 'CLS', 'ratio', 0.01),
            metric('vital.soft-navigation.inp.latest', 'INP', 'ms', 120),
            metric('vital.soft-navigation.lcp.latest', 'LCP', 'ms', 900),
        ]
        const providers = [
            {
                ...common,
                owner: 'web-vitals-runtime',
                family: 'userOutcome',
                provider_version: '4.2.0',
                accepted: 3,
                retained: 3,
                evidence: 3,
                dropped: 0,
                rejected: 0,
                truncated: 0,
            },
        ]
        const applications = { assertOwned: jest.fn().mockResolvedValue(undefined) }
        const config = { get: (key: string) => (key === 'CLICKHOUSE_DATABASE' ? database : undefined) }

        try {
            await client.insert({ table: `${database}.${TABLES[0]}`, values: providers, format: 'JSONEachRow' })
            await client.insert({ table: `${database}.${TABLES[1]}`, values: metrics, format: 'JSONEachRow' })
            await client.insert({ table: `${database}.${TABLES[2]}`, values: captures, format: 'JSONEachRow' })

            const query = new AnimationRumV3SoftNavigationQueryService(client, config as any, applications as any)
            const window = {
                appId,
                from: new Date(capturedAt.getTime() - 60_000).toISOString(),
                to: new Date(receivedAt.getTime() + 60_000).toISOString(),
            }
            const summary = await query.summary(41, window)
            const list = await query.captures(41, { ...window, limit: 20, offset: 0 })
            const detail = await query.capture(41, appId, captureId)

            expect(summary).toEqual(
                expect.objectContaining({
                    captures: { total: 1, sufficient: 1, insufficient: 0, partial: 0 },
                    projectionIntegrity: expect.objectContaining({ verified: 1, excludedFromAnalytics: 0 }),
                })
            )
            expect(summary.groups).toHaveLength(3)
            expect(summary.groups.every(group => group.disclosure.status === 'insufficient-samples')).toBe(true)
            expect(list.captures).toHaveLength(1)
            expect(list.captures[0].metrics).toHaveLength(3)
            expect(detail.capture.providerEvidence).toEqual(expect.objectContaining({ owner: 'web-vitals-runtime', accepted: 3 }))

            const dataSource = {
                query: jest.fn(async (sql: string) => {
                    if (sql.includes('capture_receipt AS receipt')) {
                        return [
                            {
                                captureId,
                                eventId,
                                deliveryState: 'published',
                                updatedAt: transitionAt.toISOString(),
                                publishedAt: transitionAt.toISOString(),
                                persistedAt: null,
                                outboxState: null,
                                routeKey,
                                capturedAt: capturedAt.toISOString(),
                            },
                        ]
                    }
                    if (sql.includes("outbox.state = 'pending'")) {
                        return [{ count: '0', due: '0', retrying: '0', leased: '0', oldestPendingAt: null, maxAttemptCount: null }]
                    }
                    if (sql.includes("outbox.state = 'quarantined'")) return [{ count: '0' }]
                    throw new Error('Unexpected PostgreSQL integration fixture query')
                }),
            }
            const pipeline = new AnimationRumV3SoftNavigationPipelineService(
                dataSource as any,
                client,
                config as any,
                applications as any,
                () => new Date(observedAt)
            )
            await expect(pipeline.read(41, appId)).resolves.toEqual(
                expect.objectContaining({
                    status: 'healthy',
                    projection: expect.objectContaining({ availability: 'available', matched: 1, storageComplete: 1 }),
                })
            )
        } finally {
            await cleanup(client, database, appId)
        }
    })
})
