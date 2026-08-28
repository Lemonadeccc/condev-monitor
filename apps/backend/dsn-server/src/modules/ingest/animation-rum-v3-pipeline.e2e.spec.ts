import { randomUUID } from 'node:crypto'

import { type ClickHouseClient, createClient } from '@clickhouse/client'
import { createAnimationRumV3GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { Pool } from 'pg'

import { AnimationRumClickhouseService } from './animation-rum-clickhouse.service'
import { AnimationRumV3AdmissionService } from './animation-rum-v3-admission.service'
import { AnimationRumV3OutboxDispatcherService } from './animation-rum-v3-outbox-dispatcher.service'

// cspell:ignore rumv

const describePipeline = process.env.RUN_ANIMATION_RUM_V3_E2E === '1' ? describe : describe.skip
const WRITE_SENTINEL = 'condev-animation-rum-v3-pipeline-e2e'
const TABLES = [
    'animation_rum_soft_navigation_provider_evidence_v3',
    'animation_rum_soft_navigation_metrics_v3',
    'animation_rum_soft_navigation_captures_v3',
] as const

function required(name: string, allowEmpty = false): string {
    const value = process.env[name]
    if (value === undefined || (!allowEmpty && value.trim() === '')) throw new Error(`${name} is required for v3 pipeline E2E`)
    return value
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
    let adminId = 0
    let applicationId = 0
    let appId = ''
    let captureId = ''

    beforeAll(() => {
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
    })

    afterAll(async () => {
        await pg?.end()
        await clickhouse?.close()
    })

    afterEach(async () => {
        if (appId) {
            for (const table of TABLES) {
                await clickhouse.command({
                    query: `ALTER TABLE ${clickhouseDatabase}.${table} DELETE WHERE app_id = {appId:String}`,
                    query_params: { appId },
                    clickhouse_settings: { mutations_sync: '2' },
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
        captureId = ''
    })

    it('admits into the independent outbox and reaches the v3 ClickHouse completion marker', async () => {
        const suffix = randomUUID().replaceAll('-', '')
        const admin = await pg.query<{ id: number }>(
            `INSERT INTO public.admin (password, email, role, "isVerified") VALUES ('fixture', $1, 'admin', true) RETURNING id`,
            [`rum-v3-pipeline-${suffix}@example.invalid`]
        )
        adminId = Number(admin.rows[0]!.id)
        appId = `rumv3e2e${suffix.slice(0, 18)}`
        const application = await pg.query<{ id: number }>(
            `INSERT INTO public.application ("appId", type, name, "userId", "isDelete") VALUES ($1, 'vanilla', $2, $3, false) RETURNING id`,
            [appId, `Animation RUM v3 E2E ${suffix}`, adminId]
        )
        applicationId = Number(application.rows[0]!.id)
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
        captureId = report.captureId
        const payload = {
            ...report,
            event_type: 'animation_soft_navigation_rum',
            message: '',
            _eventId: report.eventId,
            _clientCreatedAt: now,
        }
        const configValues: Record<string, string> = {
            INGEST_MODE: 'direct',
            ANIMATION_RUM_V3_OUTBOX_CONCURRENCY: '1',
            CLICKHOUSE_DATABASE: clickhouseDatabase,
        }
        const config = { get: (key: string) => configValues[key] }
        const admission = new AnimationRumV3AdmissionService(pg, config as never)
        const clickhouseWriter = new AnimationRumClickhouseService(clickhouse, config as never)
        const dispatcher = new AnimationRumV3OutboxDispatcherService(
            pg,
            { publishDurableBatch: jest.fn() } as never,
            clickhouseWriter,
            config as never
        )
        await expect(admission.admitBatch(appId, [payload], { nowEpochMs: now })).resolves.toMatchObject({
            accepted: 1,
            queued: 1,
            duplicates: 0,
        })
        const dispatch = await dispatcher.dispatchOnce()
        const retryDiagnostic =
            dispatch.retried === 0
                ? null
                : await pg.query<{ code: string }>(
                      `SELECT last_error_code AS code FROM public.animation_rum_v3_soft_navigation_outbox
                       WHERE application_id = $1 AND capture_id = $2`,
                      [applicationId, captureId]
                  )
        expect({ dispatch, retryCode: retryDiagnostic?.rows[0]?.code ?? null }).toEqual({
            retryCode: null,
            dispatch: {
                scanned: 1,
                published: 0,
                persisted: 1,
                retried: 0,
                quarantined: 0,
                skipped: 0,
                failed: 0,
            },
        })

        await pollUntil(
            async () => {
                const receipt = await pg.query<{ state: string }>(
                    `SELECT delivery_state AS state FROM public.animation_rum_v3_soft_navigation_capture_receipt
                     WHERE application_id = $1 AND capture_id = $2`,
                    [applicationId, captureId]
                )
                return receipt.rows[0]?.state ?? 'missing'
            },
            state => state === 'published' || state === 'persisted',
            'terminal v3 receipt'
        )
        const counts = await pollUntil(
            async () =>
                Promise.all(
                    TABLES.map(async table => {
                        const result = await clickhouse.query({
                            query: `SELECT count() AS count FROM ${clickhouseDatabase}.${table} FINAL WHERE app_id = {appId:String}`,
                            query_params: { appId },
                            format: 'JSON',
                        })
                        const body = await result.json<{ count: number | string }>()
                        return Number(body.data[0]?.count)
                    })
                ),
            value => value[0] === 1 && value[1] === 3 && value[2] === 1,
            'v3 ClickHouse projection'
        )
        expect(counts).toEqual([1, 3, 1])
    })
})
