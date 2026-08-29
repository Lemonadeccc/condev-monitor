import { randomUUID } from 'node:crypto'

import { ClickHouseClient, createClient } from '@clickhouse/client'
import type { AnimationRumV2Report } from '@condev-monitor/animation-rum-contract'
import { createAnimationRumV2GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { Pool } from 'pg'

// cspell:ignore pipelinee regclass conrelid conname convalidated constraintdef

// This test writes to every durable pipeline store. It is intentionally more
// restrictive than the PostgreSQL-only integration suites.
const RUN_PIPELINE_E2E = process.env.RUN_ANIMATION_RUM_V2_E2E === '1'
const describePipeline = RUN_PIPELINE_E2E ? describe : describe.skip
const WRITE_SENTINEL = 'condev-animation-rum-v2-pipeline-e2e'
const APP_ID_PREFIX = 'pipelinee2e'
const ROUTE_KEY = 'product-detail'
const TARGET_KEY = 'hero-canvas'
const CLICKHOUSE_TABLES = ['animation_rum_provider_evidence_v2', 'animation_rum_metrics_v2', 'animation_rum_captures_v2'] as const

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
    animationRumV2: {
        accepted: number
        queued: number
        duplicates: number
        receipts: TrackingReceipt[]
    }
}

type ReceiptRow = {
    captureId: string
    eventId: string
    scope: 'page' | 'target'
    parentCaptureId: string | null
    deliveryState: string
    deliveryVia: string | null
    publishedAt: Date | string | null
    persistedAt: Date | string | null
}

type PostgresPipelineState = {
    receipts: ReceiptRow[]
    outboxCount: number
}

type CaptureRow = {
    event_id: string
    capture_id: string
    parent_capture_id: string
    app_id: string
    scope: string
    contract_version: number
    snapshot_schema_version: number
    captured_at: string
    received_at: string
    release: string
    dist: string
    environment: string
    route_key: string
    target_key: string
    runtime_framework: string
    runtime_renderer: string
    runtime_backend: string
    capabilities_json: string
    coverage_json: string
    provider_evidence_count: number
    metric_count: number
}

type MetricRow = {
    event_id: string
    capture_id: string
    app_id: string
    scope: string
    metric_id: string
    family: string
    name: string
    stat: string
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
    scope: string
    owner: string
    family: string
    provider_version: string
    accepted: number
    retained: number
    evidence: number
    dropped: number
    rejected: number
    truncated: number
}

type ClickHousePipelineState = {
    captures: CaptureRow[]
    metrics: MetricRow[]
    providers: ProviderRow[]
}

function requireEnvironment(name: string, allowEmpty = false): string {
    const value = process.env[name]
    if (value === undefined || (!allowEmpty && value.trim() === '')) {
        throw new Error(`${name} is required for the Animation RUM v2 pipeline E2E test`)
    }
    return value
}

function parseDsnBaseUrl(value: string): URL {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('TEST_DSN_BASE_URL must use http or https')
    }
    return url
}

function trackingPayload(report: AnimationRumV2Report) {
    return {
        ...report,
        event_type: 'animation_rum',
        message: '',
        _eventId: report.eventId,
        _clientCreatedAt: Date.parse(report.capturedAt),
    }
}

function timestamp(value: Date | string | null): number {
    if (value === null) throw new Error('Expected a published timestamp')
    const milliseconds = new Date(value).getTime()
    if (!Number.isFinite(milliseconds)) throw new Error('Received an invalid published timestamp')
    return milliseconds
}

function clickHouseTimestamp(isoTimestamp: string): string {
    return new Date(Date.parse(isoTimestamp)).toISOString().replace('T', ' ').replace('Z', '')
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, milliseconds)
        timer.unref()
    })
}

async function pollUntil<T>(read: () => Promise<T>, ready: (value: T) => boolean, description: string, timeoutMs = 60_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    let lastValue: T | undefined
    while (Date.now() < deadline) {
        lastValue = await read()
        if (ready(lastValue)) return lastValue
        await delay(300)
    }
    throw new Error(`Timed out waiting for ${description}; last state: ${JSON.stringify(lastValue)}`)
}

async function clickHouseRows<T>(
    client: ClickHouseClient,
    database: string,
    table: (typeof CLICKHOUSE_TABLES)[number],
    appId: string,
    columns: string
): Promise<T[]> {
    const result = await client.query({
        query: `SELECT ${columns} FROM ${database}.${table} FINAL WHERE app_id = {appId:String} ORDER BY capture_id`,
        query_params: { appId },
        format: 'JSON',
    })
    const body = await result.json<T>()
    return body.data
}

function rowForCapture<T extends { capture_id: string }>(rows: T[], captureId: string): T {
    const row = rows.find(candidate => candidate.capture_id === captureId)
    if (!row) throw new Error(`Missing ClickHouse projection for capture ${captureId}`)
    return row
}

function rowForMetric(rows: MetricRow[], captureId: string, metricId: string): MetricRow {
    const row = rows.find(candidate => candidate.capture_id === captureId && candidate.metric_id === metricId)
    if (!row) throw new Error(`Missing ClickHouse metric ${metricId} for capture ${captureId}`)
    return row
}

function rowForProvider(rows: ProviderRow[], captureId: string, owner: string, family: string): ProviderRow {
    const row = rows.find(candidate => candidate.capture_id === captureId && candidate.owner === owner && candidate.family === family)
    if (!row) throw new Error(`Missing ClickHouse provider ${owner}/${family} for capture ${captureId}`)
    return row
}

function addMeasuredGpuFrame(report: AnimationRumV2Report): void {
    report.context.runtime = { framework: 'react', renderer: 'canvas', backend: 'webgpu' }
    report.capabilities['renderer-adapter'] = 'supported'
    report.capabilities['gpu-timer-query'] = 'supported'
    report.coverage.renderer = { status: 'measured', evidenceLevel: 'runtime-observation' }
    report.providerEvidence['renderer-adapter'] = {
        renderer: {
            version: '0.1.0',
            accepted: 8,
            retained: 8,
            evidence: 8,
            dropped: 0,
            rejected: 0,
            truncated: false,
        },
    }
    report.metrics.push({
        metricId: 'renderer.gpu-frame.p95',
        relation: 'adapter',
        owner: 'renderer-adapter',
        value: 0,
        samples: 8,
        status: 'measured',
    })
}

function addUnsupportedGpuFrame(report: AnimationRumV2Report): void {
    report.context.runtime = { framework: 'react', renderer: 'canvas', backend: 'webgpu' }
    report.capabilities['renderer-adapter'] = 'supported'
    report.capabilities['gpu-timer-query'] = 'unsupported'
    report.coverage.renderer = { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' }
    report.metrics.push({
        metricId: 'renderer.gpu-frame.p95',
        relation: 'adapter',
        owner: 'renderer-adapter',
        value: null,
        samples: null,
        status: 'unsupported',
    })
}

function useMediaStageSchema(report: AnimationRumV2Report, withCallerAttestedStage = false): void {
    report.snapshotSchemaVersion = 2
    report.capabilities = {
        ...report.capabilities,
        'media-stage-attestation': withCallerAttestedStage ? 'supported' : 'unknown',
    }
    if (!withCallerAttestedStage) return

    report.coverage.resourcesMedia = { status: 'measured', evidenceLevel: 'runtime-observation' }
    report.providerEvidence['media-stage-adapter'] = {
        resourcesMedia: {
            version: '0.1.0',
            accepted: 1,
            retained: 1,
            evidence: 1,
            dropped: 0,
            rejected: 0,
            truncated: false,
        },
    }
    report.metrics.push({
        metricId: 'media.stage.video.begin-to-first-visible.p95',
        relation: 'adapter',
        owner: 'media-stage-adapter',
        value: 24,
        samples: 1,
        status: 'measured',
    })
}

describePipeline('Animation RUM v2 real DSN-to-ClickHouse pipeline', () => {
    jest.setTimeout(120_000)

    let pool: Pool | undefined
    let clickhouse: ClickHouseClient | undefined
    let clickhouseDatabase = ''
    let dsnBaseUrl: URL | undefined
    let adminId = 0
    let applicationId = 0
    let appId = ''
    let expectedDeliveryState: 'published' | 'persisted' = 'published'
    let expectedDeliveryVia: 'kafka' | 'clickhouse' = 'kafka'

    beforeAll(async () => {
        if (process.env.TEST_ANIMATION_RUM_V2_PIPELINE_WRITE_SENTINEL !== WRITE_SENTINEL) {
            throw new Error(`TEST_ANIMATION_RUM_V2_PIPELINE_WRITE_SENTINEL must equal ${WRITE_SENTINEL}`)
        }

        const postgresUrl = requireEnvironment('TEST_POSTGRES_URL')
        const clickhouseUrl = requireEnvironment('TEST_CLICKHOUSE_URL')
        const clickhouseUsername = requireEnvironment('TEST_CLICKHOUSE_USERNAME')
        const clickhousePassword = requireEnvironment('TEST_CLICKHOUSE_PASSWORD', true)
        clickhouseDatabase = requireEnvironment('TEST_CLICKHOUSE_DATABASE')
        dsnBaseUrl = parseDsnBaseUrl(requireEnvironment('TEST_DSN_BASE_URL'))
        const expectedTransport = process.env.TEST_ANIMATION_RUM_V2_EXPECTED_TRANSPORT ?? 'kafka'
        if (expectedTransport !== 'kafka' && expectedTransport !== 'clickhouse') {
            throw new Error('TEST_ANIMATION_RUM_V2_EXPECTED_TRANSPORT must be kafka or clickhouse')
        }
        expectedDeliveryState = expectedTransport === 'kafka' ? 'published' : 'persisted'
        expectedDeliveryVia = expectedTransport
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(clickhouseDatabase)) {
            throw new Error('TEST_CLICKHOUSE_DATABASE must be a simple ClickHouse identifier')
        }

        pool = new Pool({ connectionString: postgresUrl, max: 6 })
        clickhouse = createClient({
            url: clickhouseUrl,
            username: clickhouseUsername,
            password: clickhousePassword,
            database: clickhouseDatabase,
        })

        const postgresPreflight = await pool.query<{ ready: boolean }>(`
            SELECT
                to_regclass('public.admin') IS NOT NULL
                AND to_regclass('public.application') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_policy') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_route_registry') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_target_registry') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_deployment_registry') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_capture_receipt') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_outbox') IS NOT NULL
                AND EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'animation_rum_v2_capture_receipt'
                      AND column_name = 'payload_hash_version'
                )
                AND EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conrelid = 'public.animation_rum_v2_capture_receipt'::regclass
                      AND conname = 'animation_rum_v2_receipt_version_check'
                      AND convalidated
                      AND position('contract_version = 2' IN pg_get_constraintdef(oid)) > 0
                      AND position('ARRAY[1, 2]' IN pg_get_constraintdef(oid)) > 0
                ) AS ready
        `)
        if (postgresPreflight.rows.length !== 1 || postgresPreflight.rows[0]?.ready !== true) {
            throw new Error('Animation RUM v2 PostgreSQL migrations 003, 004, and 008 are required before pipeline writes')
        }

        const clickhousePreflightResult = await clickhouse.query({
            query: `
                SELECT name
                FROM system.tables
                WHERE database = {database:String}
                  AND name IN (
                    'animation_rum_captures_v2',
                    'animation_rum_metrics_v2',
                    'animation_rum_provider_evidence_v2'
                  )
                ORDER BY name
            `,
            query_params: { database: clickhouseDatabase },
            format: 'JSON',
        })
        const clickhousePreflight = await clickhousePreflightResult.json<{ name: string }>()
        expect(clickhousePreflight.data.map(row => row.name)).toEqual([...CLICKHOUSE_TABLES].sort())

        const healthResponse = await fetch(new URL('/dsn-api/healthz', dsnBaseUrl), {
            signal: AbortSignal.timeout(10_000),
        })
        if (!healthResponse.ok) throw new Error(`DSN health check failed with HTTP ${healthResponse.status}`)
        await expect(healthResponse.json()).resolves.toEqual(expect.objectContaining({ ok: true }))

        const suffix = randomUUID().replaceAll('-', '')
        appId = `${APP_ID_PREFIX}${suffix.slice(0, 16)}`
        const client = await pool.connect()
        try {
            await client.query('BEGIN')
            const admin = await client.query<{ id: number }>(
                `
                    INSERT INTO public.admin (password, email, role, "isVerified")
                    VALUES ($1, $2, 'admin', true)
                    RETURNING id
                `,
                ['fixture', `animation-rum-v2-pipeline-${suffix}@example.invalid`]
            )
            adminId = Number(admin.rows[0]!.id)
            const application = await client.query<{ id: number }>(
                `
                    INSERT INTO public.application ("appId", type, name, "userId", "isDelete")
                    VALUES ($1, 'vanilla', $2, $3, false)
                    RETURNING id
                `,
                [appId, `Animation RUM v2 pipeline ${suffix}`, adminId]
            )
            applicationId = Number(application.rows[0]!.id)
            await client.query(
                `
                    INSERT INTO public.animation_rum_v2_policy (
                        application_id, enabled, created_by, updated_by, disabled_at
                    ) VALUES ($1, true, $2, $2, NULL)
                `,
                [applicationId, adminId]
            )
            await client.query(
                `
                    INSERT INTO public.animation_rum_v2_route_registry (
                        application_id, route_key, enabled, created_by, updated_by, disabled_at
                    ) VALUES ($1, $2, true, $3, $3, NULL)
                `,
                [applicationId, ROUTE_KEY, adminId]
            )
            await client.query(
                `
                    INSERT INTO public.animation_rum_v2_target_registry (
                        application_id, route_key, target_key, enabled, created_by, updated_by, disabled_at
                    ) VALUES ($1, $2, $3, true, $4, $4, NULL)
                `,
                [applicationId, ROUTE_KEY, TARGET_KEY, adminId]
            )
            await client.query(
                `
                    INSERT INTO public.animation_rum_v2_deployment_registry (
                        application_id, release, dist, environment, enabled, created_by, updated_by, disabled_at
                    ) VALUES ($1, 'web-1.0.0', '42', 'production', true, $2, $2, NULL)
                `,
                [applicationId, adminId]
            )
            await client.query('COMMIT')
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        } finally {
            client.release()
        }
    })

    afterAll(async () => {
        const cleanupErrors: unknown[] = []
        const safeAppId = appId.startsWith(APP_ID_PREFIX) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(appId)

        if (clickhouse && clickhouseDatabase && safeAppId) {
            for (const table of CLICKHOUSE_TABLES) {
                try {
                    await clickhouse.command({
                        query: `ALTER TABLE ${clickhouseDatabase}.${table} DELETE WHERE app_id = {appId:String}`,
                        query_params: { appId },
                        clickhouse_settings: { mutations_sync: '2' },
                    })
                    const verification = await clickhouse.query({
                        query: `SELECT count() AS count FROM ${clickhouseDatabase}.${table} FINAL WHERE app_id = {appId:String}`,
                        query_params: { appId },
                        format: 'JSON',
                    })
                    const body = await verification.json<{ count: string | number }>()
                    if (Number(body.data[0]?.count ?? Number.NaN) !== 0) {
                        throw new Error(`ClickHouse cleanup left rows in ${table}`)
                    }
                } catch (error) {
                    cleanupErrors.push(error)
                }
            }
        }

        if (pool && safeAppId) {
            let cleanupApplicationId = 0
            try {
                const application = await pool.query<{ id: number }>('SELECT id FROM public.application WHERE "appId" = $1', [appId])
                cleanupApplicationId = Number(application.rows[0]?.id ?? 0)
            } catch (error) {
                cleanupErrors.push(error)
            }
            if (cleanupApplicationId > 0) {
                for (const table of [
                    'animation_rum_v2_outbox',
                    'animation_rum_v2_capture_receipt',
                    'animation_rum_v2_target_registry',
                    'animation_rum_v2_route_registry',
                    'animation_rum_v2_deployment_registry',
                    'animation_rum_v2_policy',
                ]) {
                    try {
                        await pool.query(`DELETE FROM public.${table} WHERE application_id = $1`, [cleanupApplicationId])
                    } catch (error) {
                        cleanupErrors.push(error)
                    }
                }
                try {
                    await pool.query('DELETE FROM public.application WHERE id = $1 AND "appId" = $2', [cleanupApplicationId, appId])
                } catch (error) {
                    cleanupErrors.push(error)
                }
            }
        }
        if (pool && adminId > 0 && safeAppId) {
            try {
                await pool.query('DELETE FROM public.admin WHERE id = $1', [adminId])
            } catch (error) {
                cleanupErrors.push(error)
            }
        }

        try {
            await clickhouse?.close()
        } catch (error) {
            cleanupErrors.push(error)
        }
        try {
            await pool?.end()
        } catch (error) {
            cleanupErrors.push(error)
        }

        if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Animation RUM v2 pipeline cleanup failed')
    })

    it('delivers schema 2 page before target and projects caller-attested media stages into every v2 ClickHouse table', async () => {
        if (!pool || !clickhouse || !dsnBaseUrl) throw new Error('Pipeline E2E clients were not initialized')

        const suffix = randomUUID().replaceAll('-', '')
        const page = createAnimationRumV2GoldenReport()
        page.eventId = `event_page_${suffix.slice(0, 24)}`
        page.captureId = `capture_page_${suffix.slice(0, 24)}`
        page.capturedAt = new Date(Date.now() - 2_000).toISOString()
        addMeasuredGpuFrame(page)
        useMediaStageSchema(page, true)

        const target = createAnimationRumV2GoldenReport()
        target.eventId = `event_target_${suffix.slice(0, 24)}`
        target.captureId = `capture_target_${suffix.slice(0, 24)}`
        target.scope = 'target'
        target.parentCaptureId = page.captureId
        target.targetKey = TARGET_KEY
        target.capturedAt = new Date(Date.now() - 1_000).toISOString()
        target.metrics[0]!.relation = 'target-temporal-overlap'
        addUnsupportedGpuFrame(target)
        useMediaStageSchema(target)

        const response = await fetch(new URL(`/dsn-api/tracking/${appId}`, dsnBaseUrl), {
            method: 'POST',
            headers: { 'content-type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify([trackingPayload(target), trackingPayload(page)]),
            signal: AbortSignal.timeout(20_000),
        })
        const responseBody = (await response.json()) as TrackingResponse
        if (response.status !== 201) {
            throw new Error(`DSN rejected the pipeline fixture with HTTP ${response.status}: ${JSON.stringify(responseBody)}`)
        }
        expect(response.status).toBe(201)
        expect(responseBody).toEqual(
            expect.objectContaining({
                ok: true,
                persistedVia: 'postgres-outbox',
                animationRumV2: expect.objectContaining({
                    accepted: 2,
                    queued: 2,
                    duplicates: 0,
                    receipts: [
                        expect.objectContaining({
                            eventId: target.eventId,
                            captureId: target.captureId,
                            deliveryState: 'pending',
                            duplicate: false,
                        }),
                        expect.objectContaining({
                            eventId: page.eventId,
                            captureId: page.captureId,
                            deliveryState: 'pending',
                            duplicate: false,
                        }),
                    ],
                }),
            })
        )
        for (const receipt of responseBody.animationRumV2.receipts) {
            expect(Number.isFinite(Date.parse(receipt.receivedAt))).toBe(true)
        }

        const postgresState = await pollUntil<PostgresPipelineState>(
            async () => {
                const receipts = await pool!.query<ReceiptRow>(
                    `
                        SELECT capture_id AS "captureId",
                               event_id AS "eventId",
                               scope,
                               parent_capture_id AS "parentCaptureId",
                               delivery_state AS "deliveryState",
                               delivery_via AS "deliveryVia",
                               published_at AS "publishedAt",
                               persisted_at AS "persistedAt"
                        FROM public.animation_rum_v2_capture_receipt
                        WHERE application_id = $1
                        ORDER BY captured_at, capture_id
                    `,
                    [applicationId]
                )
                const outbox = await pool!.query<{ count: string }>(
                    'SELECT count(*)::text AS count FROM public.animation_rum_v2_outbox WHERE application_id = $1',
                    [applicationId]
                )
                if (receipts.rows.some(receipt => receipt.deliveryState === 'quarantined')) {
                    throw new Error('Animation RUM v2 outbox dispatcher quarantined a pipeline fixture')
                }
                return { receipts: receipts.rows, outboxCount: Number(outbox.rows[0]?.count ?? Number.NaN) }
            },
            state =>
                state.receipts.length === 2 &&
                state.receipts.every(
                    receipt => receipt.deliveryState === expectedDeliveryState && receipt.deliveryVia === expectedDeliveryVia
                ) &&
                state.outboxCount === 0,
            `both PostgreSQL receipts to be ${expectedDeliveryState} through ${expectedDeliveryVia} and the outbox to drain`
        )

        const pageReceipt = postgresState.receipts.find(receipt => receipt.captureId === page.captureId)
        const targetReceipt = postgresState.receipts.find(receipt => receipt.captureId === target.captureId)
        expect(pageReceipt).toEqual(
            expect.objectContaining({
                eventId: page.eventId,
                scope: 'page',
                parentCaptureId: null,
                deliveryState: expectedDeliveryState,
                deliveryVia: expectedDeliveryVia,
            })
        )
        expect(targetReceipt).toEqual(
            expect.objectContaining({
                eventId: target.eventId,
                scope: 'target',
                parentCaptureId: page.captureId,
                deliveryState: expectedDeliveryState,
                deliveryVia: expectedDeliveryVia,
            })
        )
        const pageDeliveredAt = expectedDeliveryState === 'published' ? pageReceipt?.publishedAt : pageReceipt?.persistedAt
        const targetDeliveredAt = expectedDeliveryState === 'published' ? targetReceipt?.publishedAt : targetReceipt?.persistedAt
        expect(timestamp(pageDeliveredAt ?? null)).toBeLessThanOrEqual(timestamp(targetDeliveredAt ?? null))

        const clickhouseState = await pollUntil<ClickHousePipelineState>(
            async () => {
                const [captures, metrics, providers] = await Promise.all([
                    clickHouseRows<CaptureRow>(
                        clickhouse!,
                        clickhouseDatabase,
                        'animation_rum_captures_v2',
                        appId,
                        `event_id, capture_id, parent_capture_id, app_id, scope,
                         contract_version, snapshot_schema_version, captured_at, received_at,
                         release, dist, environment, route_key, target_key,
                         runtime_framework, runtime_renderer, runtime_backend,
                         capabilities_json, coverage_json,
                         provider_evidence_count, metric_count`
                    ),
                    clickHouseRows<MetricRow>(
                        clickhouse!,
                        clickhouseDatabase,
                        'animation_rum_metrics_v2',
                        appId,
                        `event_id, capture_id, app_id, scope, metric_id, family,
                         name, stat, unit, relation, owner, value, samples, status`
                    ),
                    clickHouseRows<ProviderRow>(
                        clickhouse!,
                        clickhouseDatabase,
                        'animation_rum_provider_evidence_v2',
                        appId,
                        `event_id, capture_id, app_id, scope, owner, family,
                         provider_version, accepted, retained, evidence, dropped,
                         rejected, truncated`
                    ),
                ])
                const captureIds = new Set(captures.map(row => row.capture_id))
                if (captureIds.has(target.captureId) && !captureIds.has(page.captureId)) {
                    throw new Error('ClickHouse exposed the target completion marker before its parent page capture')
                }
                return { captures, metrics, providers }
            },
            state => {
                const expectedCaptureIds = new Set([page.captureId, target.captureId])
                return (
                    state.captures.length === 2 &&
                    state.metrics.length === 5 &&
                    state.providers.length === 4 &&
                    state.captures.every(row => expectedCaptureIds.has(row.capture_id)) &&
                    state.metrics.every(row => expectedCaptureIds.has(row.capture_id)) &&
                    state.providers.every(row => expectedCaptureIds.has(row.capture_id))
                )
            },
            'both page and target projections in all Animation RUM v2 ClickHouse tables'
        )

        const pageCapture = rowForCapture(clickhouseState.captures, page.captureId)
        const targetCapture = rowForCapture(clickhouseState.captures, target.captureId)
        expect(pageCapture).toEqual(
            expect.objectContaining({
                event_id: page.eventId,
                app_id: appId,
                scope: 'page',
                parent_capture_id: '',
                release: page.release,
                dist: page.dist,
                environment: page.environment,
                route_key: ROUTE_KEY,
                target_key: '',
                runtime_framework: 'react',
                runtime_renderer: 'canvas',
                runtime_backend: 'webgpu',
            })
        )
        expect(Number(pageCapture.contract_version)).toBe(2)
        expect(Number(pageCapture.snapshot_schema_version)).toBe(2)
        expect(pageCapture.captured_at).toBe(clickHouseTimestamp(page.capturedAt))
        expect(Number(pageCapture.provider_evidence_count)).toBe(3)
        expect(Number(pageCapture.metric_count)).toBe(3)
        expect(JSON.parse(pageCapture.capabilities_json)).toMatchObject({
            'renderer-adapter': 'supported',
            'gpu-timer-query': 'supported',
            'media-stage-attestation': 'supported',
        })
        expect(JSON.parse(pageCapture.coverage_json)).toMatchObject({
            renderer: { status: 'measured', evidenceLevel: 'runtime-observation' },
            resourcesMedia: { status: 'measured', evidenceLevel: 'runtime-observation' },
        })
        expect(targetCapture).toEqual(
            expect.objectContaining({
                event_id: target.eventId,
                app_id: appId,
                scope: 'target',
                parent_capture_id: page.captureId,
                release: target.release,
                dist: target.dist,
                environment: target.environment,
                route_key: ROUTE_KEY,
                target_key: TARGET_KEY,
                runtime_framework: 'react',
                runtime_renderer: 'canvas',
                runtime_backend: 'webgpu',
            })
        )
        expect(Number(targetCapture.snapshot_schema_version)).toBe(2)
        expect(targetCapture.captured_at).toBe(clickHouseTimestamp(target.capturedAt))
        expect(Number(targetCapture.provider_evidence_count)).toBe(1)
        expect(Number(targetCapture.metric_count)).toBe(2)
        expect(JSON.parse(targetCapture.capabilities_json)).toMatchObject({
            'renderer-adapter': 'supported',
            'gpu-timer-query': 'unsupported',
            'media-stage-attestation': 'unknown',
        })
        expect(JSON.parse(targetCapture.coverage_json)).toMatchObject({
            renderer: { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' },
        })

        const pageMetric = rowForMetric(clickhouseState.metrics, page.captureId, 'frame.duration.p95')
        const targetMetric = rowForMetric(clickhouseState.metrics, target.captureId, 'frame.duration.p95')
        expect(pageMetric).toEqual(
            expect.objectContaining({
                event_id: page.eventId,
                app_id: appId,
                scope: 'page',
                metric_id: 'frame.duration.p95',
                family: 'frameCadence',
                name: 'frameDurationMs',
                stat: 'p95',
                unit: 'ms',
                relation: 'page-window',
                owner: 'browser-core',
                status: 'measured',
            })
        )
        expect(Number(pageMetric.value)).toBe(18.5)
        expect(Number(pageMetric.samples)).toBe(120)
        expect(targetMetric).toEqual(
            expect.objectContaining({
                event_id: target.eventId,
                app_id: appId,
                scope: 'target',
                metric_id: 'frame.duration.p95',
                family: 'frameCadence',
                name: 'frameDurationMs',
                stat: 'p95',
                unit: 'ms',
                relation: 'target-temporal-overlap',
                owner: 'browser-core',
                status: 'measured',
            })
        )
        expect(Number(targetMetric.value)).toBe(18.5)
        expect(Number(targetMetric.samples)).toBe(120)

        const pageGpuMetric = rowForMetric(clickhouseState.metrics, page.captureId, 'renderer.gpu-frame.p95')
        expect(pageGpuMetric).toEqual(
            expect.objectContaining({
                event_id: page.eventId,
                app_id: appId,
                scope: 'page',
                family: 'renderer',
                name: 'gpuFrameMs',
                stat: 'p95',
                unit: 'ms',
                relation: 'adapter',
                owner: 'renderer-adapter',
                status: 'measured',
                value: 0,
            })
        )
        expect(Number(pageGpuMetric.samples)).toBe(8)
        const targetGpuMetric = rowForMetric(clickhouseState.metrics, target.captureId, 'renderer.gpu-frame.p95')
        expect(targetGpuMetric).toEqual(
            expect.objectContaining({
                event_id: target.eventId,
                app_id: appId,
                scope: 'target',
                family: 'renderer',
                name: 'gpuFrameMs',
                stat: 'p95',
                unit: 'ms',
                relation: 'adapter',
                owner: 'renderer-adapter',
                status: 'unsupported',
                value: null,
                samples: null,
            })
        )

        const pageMediaStageMetric = rowForMetric(clickhouseState.metrics, page.captureId, 'media.stage.video.begin-to-first-visible.p95')
        expect(pageMediaStageMetric).toEqual(
            expect.objectContaining({
                event_id: page.eventId,
                app_id: appId,
                scope: 'page',
                family: 'resourcesMedia',
                name: 'declaredVideoBeginToFirstVisibleMs',
                stat: 'p95',
                unit: 'ms',
                relation: 'adapter',
                owner: 'media-stage-adapter',
                status: 'measured',
                value: 24,
                samples: 1,
            })
        )

        for (const [captureId, eventId, scope] of [
            [page.captureId, page.eventId, 'page'],
            [target.captureId, target.eventId, 'target'],
        ] as const) {
            const provider = rowForProvider(clickhouseState.providers, captureId, 'browser-core', 'frameCadence')
            expect(provider).toEqual(
                expect.objectContaining({
                    event_id: eventId,
                    app_id: appId,
                    scope,
                    owner: 'browser-core',
                    family: 'frameCadence',
                    provider_version: '0.1.0',
                })
            )
            expect(Number(provider.accepted)).toBe(120)
            expect(Number(provider.retained)).toBe(120)
            expect(Number(provider.evidence)).toBe(120)
            expect(Number(provider.dropped)).toBe(0)
            expect(Number(provider.rejected)).toBe(0)
            expect(Number(provider.truncated)).toBe(0)
        }

        const rendererProvider = rowForProvider(clickhouseState.providers, page.captureId, 'renderer-adapter', 'renderer')
        expect(rendererProvider).toEqual(
            expect.objectContaining({
                event_id: page.eventId,
                app_id: appId,
                scope: 'page',
                provider_version: '0.1.0',
            })
        )
        expect(Number(rendererProvider.accepted)).toBe(8)
        expect(Number(rendererProvider.retained)).toBe(8)
        expect(Number(rendererProvider.evidence)).toBe(8)
        expect(Number(rendererProvider.dropped)).toBe(0)
        expect(Number(rendererProvider.rejected)).toBe(0)
        expect(Number(rendererProvider.truncated)).toBe(0)

        const mediaStageProvider = rowForProvider(clickhouseState.providers, page.captureId, 'media-stage-adapter', 'resourcesMedia')
        expect(mediaStageProvider).toEqual(
            expect.objectContaining({
                event_id: page.eventId,
                app_id: appId,
                scope: 'page',
                provider_version: '0.1.0',
            })
        )
        expect(Number(mediaStageProvider.accepted)).toBe(1)
        expect(Number(mediaStageProvider.retained)).toBe(1)
        expect(Number(mediaStageProvider.evidence)).toBe(1)
        expect(Number(mediaStageProvider.dropped)).toBe(0)
        expect(Number(mediaStageProvider.rejected)).toBe(0)
        expect(Number(mediaStageProvider.truncated)).toBe(0)
    })
})
