import { randomUUID } from 'node:crypto'

import { type ClickHouseClient, createClient } from '@clickhouse/client'
import { createAnimationRumV3GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { Pool } from 'pg'

// cspell:ignore rumv

const describePipeline = process.env.RUN_ANIMATION_RUM_V3_E2E === '1' ? describe : describe.skip
const WRITE_SENTINEL = 'condev-animation-rum-v3-pipeline-e2e'
const TABLES = [
    'animation_rum_soft_navigation_provider_evidence_v3',
    'animation_rum_soft_navigation_metrics_v3',
    'animation_rum_soft_navigation_captures_v3',
] as const

type TrackingReceipt = {
    eventId: string
    captureId: string
    receivedAt: string
    deliveryState: string
    duplicate: boolean
}

type TrackingResponse = {
    ok: boolean
    persistedVia: string
    animationRumV3SoftNavigation: {
        accepted: number
        queued: number
        duplicates: number
        receipts: TrackingReceipt[]
    }
}

type MonitorRegistrationResponse = {
    success: boolean
    data: { id: number }
}

type MonitorLoginResponse = {
    success: boolean
    data: { access_token: string }
}

type MonitorApplicationResponse = {
    success: boolean
    data: { id: number; appId: string }
}

type MonitorSummaryResponse = {
    success: boolean
    data: {
        captures: { total: number; sufficient: number; insufficient: number; partial: number }
        projectionIntegrity: {
            completionMarkers: number
            verified: number
            excludedFromAnalytics: number
            metricCountMismatches: number
            providerEvidenceCountMismatches: number
            childIdentityMismatches: number
        }
    }
}

type MonitorCaptureView = {
    captureId: string
    eventId: string
    metrics: unknown[]
}

type MonitorCapturesResponse = {
    success: boolean
    data: {
        pagination: { total: number; limit: number; offset: number; hasMore: boolean }
        captures: MonitorCaptureView[]
    }
}

type MonitorDetailResponse = {
    success: boolean
    data: {
        capture: MonitorCaptureView & { providerEvidence: { owner: string; family: string } }
    }
}

type MonitorPipelineResponse = {
    success: boolean
    data: {
        status: string
        receipts: { byState: Record<string, number>; statePairMismatch: number }
        outbox: { pending: { count: number; truncated: boolean } }
        projection: { availability: string; eligible: { count: number; truncated: boolean } }
    }
}

type ReceiptRow = {
    eventId: string
    captureId: string
    deliveryState: string
    deliveryVia: string | null
    publishedAt: Date | string | null
    persistedAt: Date | string | null
}

type CaptureRow = {
    event_id: string
    capture_id: string
    app_id: string
    contract_version: number
    snapshot_schema_version: number
    route_key: string
    runtime_framework: string
    runtime_renderer: string
    runtime_backend: string
    provider_evidence_count: number
    metric_count: number
}

type MetricRow = {
    event_id: string
    capture_id: string
    app_id: string
    metric_id: string
    vital_name: string
    unit: string
    relation: string
    owner: string
    value: number | null
    samples: number | null
    status: string
}

type ProviderRow = {
    event_id: string
    capture_id: string
    app_id: string
    owner: string
    family: string
    accepted: number
    retained: number
    evidence: number
    dropped: number
    rejected: number
    truncated: number
}

function required(name: string, allowEmpty = false): string {
    const value = process.env[name]
    if (value === undefined || (!allowEmpty && value.trim() === '')) throw new Error(`${name} is required for v3 pipeline E2E`)
    return value
}

function httpBaseUrl(value: string, name: string): URL {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must use http or https`)
    return url
}

async function jsonResponse<T>(response: Response, description: string, expectedStatus = 200): Promise<T> {
    const body = (await response.json()) as T
    if (response.status !== expectedStatus) {
        throw new Error(`${description} failed with HTTP ${response.status}: ${JSON.stringify(body)}`)
    }
    return body
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms)
        timer.unref()
    })
}

async function pollUntil<T>(read: () => Promise<T>, ready: (value: T) => boolean, description: string): Promise<T> {
    const deadline = Date.now() + 60_000
    let last: T | undefined
    while (Date.now() < deadline) {
        last = await read()
        if (ready(last)) return last
        await delay(300)
    }
    throw new Error(`Timed out waiting for ${description}; last state ${JSON.stringify(last)}`)
}

describePipeline('Animation RUM v3 soft-navigation DSN pipeline E2E', () => {
    jest.setTimeout(90_000)
    let pg: Pool
    let clickhouse: ClickHouseClient
    let clickhouseDatabase = ''
    let dsnUrl: URL
    let monitorUrl: URL
    let adminId = 0
    let applicationId = 0
    let appId = ''
    let expectedDeliveryState: 'published' | 'persisted' = 'published'
    let expectedDeliveryVia: 'kafka' | 'clickhouse-fallback' = 'kafka'

    beforeAll(async () => {
        if (process.env.TEST_POSTGRES_WRITE_SENTINEL !== WRITE_SENTINEL) {
            throw new Error(`TEST_POSTGRES_WRITE_SENTINEL must equal ${WRITE_SENTINEL}`)
        }
        pg = new Pool({ connectionString: required('TEST_POSTGRES_URL'), max: 4 })
        clickhouseDatabase = required('TEST_CLICKHOUSE_DATABASE')
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(clickhouseDatabase)) throw new Error('Invalid TEST_CLICKHOUSE_DATABASE')
        clickhouse = createClient({
            url: required('TEST_CLICKHOUSE_URL'),
            username: required('TEST_CLICKHOUSE_USERNAME'),
            password: required('TEST_CLICKHOUSE_PASSWORD', true),
            database: clickhouseDatabase,
        })
        dsnUrl = httpBaseUrl(required('TEST_DSN_BASE_URL'), 'TEST_DSN_BASE_URL')
        monitorUrl = httpBaseUrl(required('TEST_MONITOR_BASE_URL'), 'TEST_MONITOR_BASE_URL')
        const expectedTransport = process.env.TEST_ANIMATION_RUM_V3_EXPECTED_TRANSPORT ?? 'kafka'
        if (expectedTransport !== 'kafka' && expectedTransport !== 'clickhouse') {
            throw new Error('TEST_ANIMATION_RUM_V3_EXPECTED_TRANSPORT must be kafka or clickhouse')
        }
        expectedDeliveryState = expectedTransport === 'kafka' ? 'published' : 'persisted'
        expectedDeliveryVia = expectedTransport === 'kafka' ? 'kafka' : 'clickhouse-fallback'

        const health = await fetch(new URL('/dsn-api/healthz', dsnUrl), { signal: AbortSignal.timeout(10_000) })
        if (!health.ok) throw new Error(`DSN health check failed with HTTP ${health.status}`)
        await expect(health.json()).resolves.toEqual(expect.objectContaining({ ok: true }))
        const monitorHealth = await fetch(new URL('/api/healthz', monitorUrl), { signal: AbortSignal.timeout(10_000) })
        if (!monitorHealth.ok) throw new Error(`Monitor health check failed with HTTP ${monitorHealth.status}`)
        await expect(monitorHealth.json()).resolves.toEqual(expect.objectContaining({ ok: true }))

        const tables = await clickhouse.query({
            query: `SELECT name FROM system.tables WHERE database = {database:String} AND name IN ({tables:Array(String)}) ORDER BY name`,
            query_params: { database: clickhouseDatabase, tables: [...TABLES] },
            format: 'JSON',
        })
        const tableRows = await tables.json<{ name: string }>()
        expect(tableRows.data.map(row => row.name)).toEqual([...TABLES].sort())
    })

    afterAll(async () => {
        await pg?.end()
        await clickhouse?.close()
    })

    afterEach(async () => {
        if (appId) {
            for (const table of [...TABLES, 'app_settings']) {
                await clickhouse.command({
                    query: `DELETE FROM ${clickhouseDatabase}.${table} WHERE app_id = {appId:String} SETTINGS lightweight_deletes_sync = 2`,
                    query_params: { appId },
                })
            }
        }
        if (applicationId > 0) {
            for (const table of [
                'animation_rum_v3_soft_navigation_outbox',
                'animation_rum_v3_soft_navigation_capture_receipt',
                'animation_rum_v3_soft_navigation_route_registry',
                'animation_rum_v3_soft_navigation_deployment_registry',
                'animation_rum_v3_soft_navigation_policy',
            ]) {
                await pg.query(`DELETE FROM public.${table} WHERE application_id = $1`, [applicationId])
            }
            await pg.query('DELETE FROM public.application WHERE id = $1', [applicationId])
        }
        if (adminId > 0) await pg.query('DELETE FROM public.admin WHERE id = $1', [adminId])
        adminId = 0
        applicationId = 0
        appId = ''
    })

    it('travels through HTTP, the durable outbox, the selected transport, and every v3 ClickHouse table', async () => {
        const suffix = randomUUID().replaceAll('-', '')
        const email = `rum-v3-pipeline-${suffix}@example.invalid`
        const password = `Condev${suffix.slice(0, 8)}Aa1`
        const registration = await jsonResponse<MonitorRegistrationResponse>(
            await fetch(new URL('/api/admin/register', monitorUrl), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ email, password }),
                signal: AbortSignal.timeout(20_000),
            }),
            'Monitor registration',
            201
        )
        expect(registration.success).toBe(true)
        adminId = Number(registration.data.id)
        expect(Number.isSafeInteger(adminId) && adminId > 0).toBe(true)
        await pg.query('UPDATE public.admin SET "isVerified" = true WHERE id = $1', [adminId])

        const login = await jsonResponse<MonitorLoginResponse>(
            await fetch(new URL('/api/auth/login', monitorUrl), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ email, password }),
                signal: AbortSignal.timeout(20_000),
            }),
            'Monitor login',
            201
        )
        expect(login.success).toBe(true)
        const authorization = `Bearer ${login.data.access_token}`

        const application = await jsonResponse<MonitorApplicationResponse>(
            await fetch(new URL('/api/application', monitorUrl), {
                method: 'POST',
                headers: { authorization, 'content-type': 'application/json' },
                body: JSON.stringify({ type: 'vanilla', name: `Animation RUM v3 E2E ${suffix}` }),
                signal: AbortSignal.timeout(20_000),
            }),
            'Monitor application creation',
            201
        )
        expect(application.success).toBe(true)
        applicationId = Number(application.data.id)
        appId = application.data.appId
        expect(Number.isSafeInteger(applicationId) && applicationId > 0).toBe(true)
        expect(appId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u)
        await pg.query(
            `INSERT INTO public.animation_rum_v3_soft_navigation_policy
                (application_id, enabled, created_by, updated_by, disabled_at) VALUES ($1, true, $2, $2, NULL)`,
            [applicationId, adminId]
        )
        await pg.query(
            `INSERT INTO public.animation_rum_v3_soft_navigation_route_registry
                (application_id, route_key, enabled, created_by, updated_by, disabled_at)
             VALUES ($1, 'catalog.product-detail', true, $2, $2, NULL)`,
            [applicationId, adminId]
        )
        await pg.query(
            `INSERT INTO public.animation_rum_v3_soft_navigation_deployment_registry
                (application_id, release, dist, environment, enabled, created_by, updated_by, disabled_at)
             VALUES ($1, 'web-1.0.0', '42', 'production', true, $2, $2, NULL)`,
            [applicationId, adminId]
        )

        const report = createAnimationRumV3GoldenReport()
        const now = Date.now()
        report.eventId = `event_v3_e2e_${suffix.slice(0, 24)}`
        report.captureId = `capture_v3_e2e_${suffix.slice(0, 24)}`
        report.capturedAt = new Date(now - 1_000).toISOString()
        const payload = {
            ...report,
            event_type: 'animation_soft_navigation_rum',
            message: '',
            _eventId: report.eventId,
            _clientCreatedAt: now,
        }

        const response = await fetch(new URL(`/dsn-api/tracking-v3/${appId}`, dsnUrl), {
            method: 'POST',
            headers: { 'content-type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(20_000),
        })
        const responseBody = (await response.json()) as TrackingResponse
        if (response.status !== 201) {
            throw new Error(`DSN rejected the v3 pipeline fixture with HTTP ${response.status}: ${JSON.stringify(responseBody)}`)
        }
        expect(responseBody).toEqual({
            ok: true,
            persistedVia: 'postgres-outbox',
            animationRumV3SoftNavigation: {
                accepted: 1,
                queued: 1,
                duplicates: 0,
                receipts: [
                    expect.objectContaining({
                        eventId: report.eventId,
                        captureId: report.captureId,
                        deliveryState: 'pending',
                        duplicate: false,
                    }),
                ],
            },
        })
        expect(Number.isFinite(Date.parse(responseBody.animationRumV3SoftNavigation.receipts[0]!.receivedAt))).toBe(true)

        const receipt = await pollUntil(
            async () => {
                const receiptState = await pg.query<ReceiptRow>(
                    `SELECT event_id AS "eventId", capture_id AS "captureId",
                            delivery_state AS "deliveryState", delivery_via AS "deliveryVia",
                            published_at AS "publishedAt", persisted_at AS "persistedAt"
                     FROM public.animation_rum_v3_soft_navigation_capture_receipt
                     WHERE application_id = $1 AND capture_id = $2`,
                    [applicationId, report.captureId]
                )
                const outbox = await pg.query<{ count: string; errorCode: string | null }>(
                    `SELECT count(*)::text AS count, max(last_error_code) AS "errorCode"
                     FROM public.animation_rum_v3_soft_navigation_outbox
                     WHERE application_id = $1`,
                    [applicationId]
                )
                const row = receiptState.rows[0]
                if (row?.deliveryState === 'quarantined') {
                    throw new Error(`Animation RUM v3 outbox quarantined the fixture (${outbox.rows[0]?.errorCode ?? 'unknown'})`)
                }
                return { row, outboxCount: Number(outbox.rows[0]?.count ?? Number.NaN) }
            },
            state =>
                state.row?.deliveryState === expectedDeliveryState &&
                state.row.deliveryVia === expectedDeliveryVia &&
                state.outboxCount === 0,
            `v3 receipt to be ${expectedDeliveryState} through ${expectedDeliveryVia} and the outbox to drain`
        )
        expect(receipt.row).toEqual(
            expect.objectContaining({
                eventId: report.eventId,
                captureId: report.captureId,
                deliveryState: expectedDeliveryState,
                deliveryVia: expectedDeliveryVia,
            })
        )
        expect(expectedDeliveryState === 'published' ? receipt.row?.publishedAt : receipt.row?.persistedAt).not.toBeNull()

        const projection = await pollUntil(
            async () => {
                const rows = await Promise.all(
                    TABLES.map(async table => {
                        const result = await clickhouse.query({
                            query: `SELECT * FROM ${clickhouseDatabase}.${table} FINAL WHERE app_id = {appId:String} ORDER BY capture_id`,
                            query_params: { appId },
                            format: 'JSON',
                        })
                        return (await result.json<Record<string, unknown>>()).data
                    })
                )
                if (rows[2]!.length > 0 && (rows[0]!.length !== 1 || rows[1]!.length !== 3)) {
                    throw new Error('ClickHouse exposed the v3 capture completion marker before all child rows')
                }
                return rows
            },
            rows => rows[0]?.length === 1 && rows[1]?.length === 3 && rows[2]?.length === 1,
            'v3 ClickHouse projection'
        )
        const providers = projection[0] as unknown as ProviderRow[]
        const metrics = projection[1] as unknown as MetricRow[]
        const captures = projection[2] as unknown as CaptureRow[]
        expect(captures[0]).toEqual(
            expect.objectContaining({
                event_id: report.eventId,
                capture_id: report.captureId,
                app_id: appId,
                route_key: report.context.routeKey,
                runtime_framework: 'react',
                runtime_renderer: 'dom',
                runtime_backend: 'dom',
            })
        )
        expect(Number(captures[0]!.contract_version)).toBe(3)
        expect(Number(captures[0]!.snapshot_schema_version)).toBe(1)
        expect(Number(captures[0]!.provider_evidence_count)).toBe(1)
        expect(Number(captures[0]!.metric_count)).toBe(3)
        expect(metrics.map(metric => metric.metric_id).sort()).toEqual(report.metrics.map(metric => metric.metricId).sort())
        expect(metrics).toEqual(
            expect.arrayContaining(
                report.metrics.map(metric =>
                    expect.objectContaining({
                        event_id: report.eventId,
                        capture_id: report.captureId,
                        app_id: appId,
                        relation: metric.relation,
                        owner: metric.owner,
                        value: metric.value,
                        samples: metric.samples,
                        status: metric.status,
                    })
                )
            )
        )
        expect(providers[0]).toEqual(
            expect.objectContaining({
                event_id: report.eventId,
                capture_id: report.captureId,
                app_id: appId,
                owner: 'web-vitals-runtime',
                family: 'userOutcome',
                accepted: 3,
                retained: 3,
                evidence: 3,
                dropped: 0,
                rejected: 0,
                truncated: 0,
            })
        )

        const query = new URLSearchParams({
            appId,
            from: new Date(now - 60_000).toISOString(),
            to: new Date(now + 60_000).toISOString(),
        })
        const summary = await jsonResponse<MonitorSummaryResponse>(
            await fetch(new URL(`/api/animation/rum-v3/soft-navigation/summary?${query}`, monitorUrl), {
                headers: { authorization },
                signal: AbortSignal.timeout(20_000),
            }),
            'Monitor v3 summary'
        )
        expect(summary.success).toBe(true)
        expect(summary.data.captures).toEqual({ total: 1, sufficient: 1, insufficient: 0, partial: 0 })
        expect(summary.data.projectionIntegrity).toEqual(
            expect.objectContaining({
                completionMarkers: 1,
                verified: 1,
                excludedFromAnalytics: 0,
                metricCountMismatches: 0,
                providerEvidenceCountMismatches: 0,
                childIdentityMismatches: 0,
            })
        )

        const capturesResponse = await jsonResponse<MonitorCapturesResponse>(
            await fetch(new URL(`/api/animation/rum-v3/soft-navigation/captures?${query}&limit=20&offset=0`, monitorUrl), {
                headers: { authorization },
                signal: AbortSignal.timeout(20_000),
            }),
            'Monitor v3 capture list'
        )
        expect(capturesResponse.success).toBe(true)
        expect(capturesResponse.data.pagination).toEqual({ total: 1, limit: 20, offset: 0, hasMore: false })
        expect(capturesResponse.data.captures).toHaveLength(1)
        expect(capturesResponse.data.captures[0]).toEqual(expect.objectContaining({ captureId: report.captureId, eventId: report.eventId }))
        expect(capturesResponse.data.captures[0]!.metrics).toHaveLength(3)

        const detail = await jsonResponse<MonitorDetailResponse>(
            await fetch(
                new URL(
                    `/api/animation/rum-v3/soft-navigation/captures/${encodeURIComponent(report.captureId)}?appId=${encodeURIComponent(appId)}`,
                    monitorUrl
                ),
                { headers: { authorization }, signal: AbortSignal.timeout(20_000) }
            ),
            'Monitor v3 capture detail'
        )
        expect(detail.success).toBe(true)
        expect(detail.data.capture.captureId).toBe(report.captureId)
        expect(detail.data.capture.eventId).toBe(report.eventId)
        expect(detail.data.capture.metrics).toHaveLength(3)
        expect(detail.data.capture.providerEvidence.owner).toBe('web-vitals-runtime')
        expect(detail.data.capture.providerEvidence.family).toBe('userOutcome')

        const pipeline = await jsonResponse<MonitorPipelineResponse>(
            await fetch(new URL(`/api/animation/rum-v3/soft-navigation/pipeline?appId=${encodeURIComponent(appId)}`, monitorUrl), {
                headers: { authorization },
                signal: AbortSignal.timeout(20_000),
            }),
            'Monitor v3 pipeline diagnostic'
        )
        expect(pipeline.success).toBe(true)
        expect(pipeline.data.status).toBe('in-flight')
        expect(pipeline.data.receipts.byState[expectedDeliveryState]).toBe(1)
        expect(pipeline.data.receipts.byState.quarantined).toBe(0)
        expect(pipeline.data.receipts.statePairMismatch).toBe(0)
        expect(pipeline.data.outbox.pending).toEqual({ count: 0, truncated: false })
        expect(pipeline.data.projection.availability).toBe('not-checked')
        expect(pipeline.data.projection.eligible).toEqual({ count: 0, truncated: false })

        const duplicateResponse = await fetch(new URL(`/dsn-api/tracking-v3/${appId}`, dsnUrl), {
            method: 'POST',
            headers: { 'content-type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(20_000),
        })
        const duplicateBody = (await duplicateResponse.json()) as TrackingResponse
        expect(duplicateResponse.status).toBe(201)
        expect(duplicateBody.animationRumV3SoftNavigation).toEqual({
            accepted: 1,
            queued: 0,
            duplicates: 1,
            receipts: [
                expect.objectContaining({
                    eventId: report.eventId,
                    captureId: report.captureId,
                    receivedAt: responseBody.animationRumV3SoftNavigation.receipts[0]!.receivedAt,
                    deliveryState: expectedDeliveryState,
                    duplicate: true,
                }),
            ],
        })
        const duplicateCounts = await Promise.all(
            TABLES.map(async table => {
                const result = await clickhouse.query({
                    query: `SELECT count() AS count FROM ${clickhouseDatabase}.${table} FINAL WHERE app_id = {appId:String}`,
                    query_params: { appId },
                    format: 'JSON',
                })
                const body = await result.json<{ count: number | string }>()
                return Number(body.data[0]?.count)
            })
        )
        expect(duplicateCounts).toEqual([1, 3, 1])
    })
})
