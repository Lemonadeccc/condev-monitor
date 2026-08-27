import { randomUUID } from 'node:crypto'

import type { AnimationRumV2Report } from '@condev-monitor/animation-rum-contract'
import { createAnimationRumV2GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { Pool } from 'pg'

import { AnimationRumV2AdmissionService } from './animation-rum-v2-admission.service'
import { AnimationRumV2RetentionService, type AnimationRumV2RetentionStats } from './animation-rum-v2-retention.service'

// cspell:ignore regclass

const describePostgres = process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const WRITE_SENTINEL = 'condev-animation-rum-v2-retention'

type Fixture = {
    adminId: number
    applicationId: number
    appId: string
}

type RetainedCaptureRow = {
    captureId: string
    deliveryState: string
    expired: boolean
    outboxState: string | null
}

function compactSql(value: unknown): string {
    return String(value).replace(/\s+/gu, ' ').trim()
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

function pageReport(label: string, nowEpochMs: number): AnimationRumV2Report {
    const report = createAnimationRumV2GoldenReport()
    report.eventId = `event_${label}`
    report.captureId = `capture_${label}`
    report.capturedAt = new Date(nowEpochMs - 1_000).toISOString()
    return report
}

function targetReport(label: string, parent: AnimationRumV2Report, nowEpochMs: number): AnimationRumV2Report {
    const report = pageReport(label, nowEpochMs)
    report.scope = 'target'
    report.parentCaptureId = parent.captureId
    report.targetKey = 'hero-canvas'
    report.metrics[0]!.relation = 'target-temporal-overlap'
    return report
}

function retentionConfig() {
    const values: Record<string, string> = {
        ANIMATION_RUM_V2_RETENTION_ENABLED: 'true',
        ANIMATION_RUM_V2_QUARANTINE_ENVELOPE_RETENTION_DAYS: '7',
        ANIMATION_RUM_V2_RETENTION_APP_LIMIT: '25',
        ANIMATION_RUM_V2_RETENTION_BATCH_SIZE: '100',
        ANIMATION_RUM_V2_RETENTION_MAX_ROWS_PER_CYCLE: '1000',
        ANIMATION_RUM_V2_RETENTION_MAX_CYCLE_MS: '10000',
    }
    return { get: (key: string) => values[key] }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        timer.unref()
    })
    try {
        return await Promise.race([promise, timeout])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

function createCoordinatedRetentionPool(pool: Pool) {
    let observeCompetitor!: () => void
    const competitorObserved = new Promise<void>(resolve => {
        observeCompetitor = resolve
    })
    const receiptDeleteScopes: string[] = []

    return {
        receiptDeleteScopes,
        pool: {
            connect: async () => {
                const client = await pool.connect()
                return {
                    query: async (text: string, values?: readonly unknown[]) => {
                        const result = await client.query(text, values as unknown[] | undefined)
                        const sql = compactSql(text)
                        if (sql.startsWith('SELECT pg_try_advisory_lock')) {
                            if (result.rows[0]?.locked === true) {
                                await withTimeout(
                                    competitorObserved,
                                    5_000,
                                    'The competing retention service did not attempt the advisory lock'
                                )
                            } else {
                                observeCompetitor()
                            }
                        }
                        if (sql.includes('DELETE FROM public.animation_rum_v2_capture_receipt AS receipt')) {
                            receiptDeleteScopes.push(String(values?.[1]))
                        }
                        return result
                    },
                    release: (destroy?: boolean | Error) => client.release(destroy),
                }
            },
        },
    }
}

async function createFixture(pool: Pool, fixture: Partial<Fixture>): Promise<Fixture> {
    const suffix = randomUUID().replaceAll('-', '')
    const admin = await pool.query<{ id: number }>(
        `
            INSERT INTO public.admin (password, email, role, "isVerified")
            VALUES ($1, $2, 'admin', true)
            RETURNING id
        `,
        ['fixture', `animation-rum-v2-retention-${suffix}@example.invalid`]
    )
    const adminId = Number(admin.rows[0]!.id)
    fixture.adminId = adminId
    const appId = `retention${suffix.slice(0, 12)}`
    fixture.appId = appId
    const application = await pool.query<{ id: number }>(
        `
            INSERT INTO public.application ("appId", type, name, "userId", "isDelete")
            VALUES ($1, 'vanilla', $2, $3, false)
            RETURNING id
        `,
        [appId, `Animation RUM v2 retention ${suffix}`, adminId]
    )
    const applicationId = Number(application.rows[0]!.id)
    fixture.applicationId = applicationId
    await pool.query(
        `
            INSERT INTO public.animation_rum_v2_policy (
                application_id, enabled, created_by, updated_by, disabled_at
            ) VALUES ($1, true, $2, $2, NULL)
        `,
        [applicationId, adminId]
    )
    await pool.query(
        `
            INSERT INTO public.animation_rum_v2_route_registry (
                application_id, route_key, enabled, created_by, updated_by, disabled_at
            ) VALUES ($1, 'product-detail', true, $2, $2, NULL)
        `,
        [applicationId, adminId]
    )
    await pool.query(
        `
            INSERT INTO public.animation_rum_v2_target_registry (
                application_id, route_key, target_key, enabled, created_by, updated_by, disabled_at
            ) VALUES ($1, 'product-detail', 'hero-canvas', true, $2, $2, NULL)
        `,
        [applicationId, adminId]
    )
    await pool.query(
        `
            INSERT INTO public.animation_rum_v2_deployment_registry (
                application_id, release, dist, environment, enabled, created_by, updated_by, disabled_at
            ) VALUES ($1, 'web-1.0.0', '42', 'production', true, $2, $2, NULL)
        `,
        [applicationId, adminId]
    )
    return { adminId, applicationId, appId }
}

async function cleanupFixture(pool: Pool, fixture: Partial<Fixture>): Promise<void> {
    const errors: unknown[] = []
    if (fixture.applicationId) {
        for (const statement of [
            'DELETE FROM public.animation_rum_v2_outbox WHERE application_id = $1',
            "DELETE FROM public.animation_rum_v2_capture_receipt WHERE application_id = $1 AND scope = 'target'",
            "DELETE FROM public.animation_rum_v2_capture_receipt WHERE application_id = $1 AND scope = 'page'",
            'DELETE FROM public.animation_rum_v2_target_registry WHERE application_id = $1',
            'DELETE FROM public.animation_rum_v2_route_registry WHERE application_id = $1',
            'DELETE FROM public.animation_rum_v2_deployment_registry WHERE application_id = $1',
            'DELETE FROM public.animation_rum_v2_policy WHERE application_id = $1',
            'DELETE FROM public.application WHERE id = $1',
        ]) {
            try {
                await pool.query(statement, [fixture.applicationId])
            } catch (error) {
                errors.push(error)
            }
        }
    }
    if (fixture.adminId) {
        try {
            await pool.query('DELETE FROM public.admin WHERE id = $1', [fixture.adminId])
        } catch (error) {
            errors.push(error)
        }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Animation RUM v2 retention fixture cleanup failed')
}

describePostgres('AnimationRumV2RetentionService PostgreSQL integration', () => {
    jest.setTimeout(45_000)

    let pool: Pool

    beforeAll(async () => {
        const url = process.env.TEST_POSTGRES_URL
        if (!url) throw new Error('TEST_POSTGRES_URL is required for Animation RUM v2 retention integration tests')
        if (process.env.TEST_POSTGRES_WRITE_SENTINEL !== WRITE_SENTINEL) {
            throw new Error(`TEST_POSTGRES_WRITE_SENTINEL must equal ${WRITE_SENTINEL}`)
        }
        pool = new Pool({ connectionString: url, max: 8 })
        const preflight = await pool.query<{ ready: boolean }>(`
            SELECT
                to_regclass('public.admin') IS NOT NULL
                AND to_regclass('public.application') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_policy') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_route_registry') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_target_registry') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_deployment_registry') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_capture_receipt') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_outbox') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_outbox_quarantine_retention_idx') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_outbox_dependency_idx') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_receipt_terminal_expiry_idx') IS NOT NULL
                AND EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'animation_rum_v2_capture_receipt'
                      AND column_name = 'payload_hash_version'
                ) AS ready
        `)
        if (preflight.rows.length !== 1 || preflight.rows[0]?.ready !== true) {
            throw new Error('Animation RUM v2 PostgreSQL migrations 003, 004, and 006 are required before retention integration writes')
        }
    })

    afterAll(async () => {
        await pool?.end()
    })

    it('removes only retention-safe rows while preserving quarantine identity and electing one cleanup leader', async () => {
        const fixture: Partial<Fixture> = {}
        try {
            const { adminId, applicationId, appId } = await createFixture(pool, fixture)
            expect(adminId).toBeGreaterThan(0)

            const nowEpochMs = Date.now()
            const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
            const oldQuarantine = pageReport(`ret_old_${suffix}`, nowEpochMs)
            const recentQuarantine = pageReport(`ret_recent_${suffix}`, nowEpochMs)
            const pending = pageReport(`ret_pending_${suffix}`, nowEpochMs)
            const terminalPage = pageReport(`ret_parent_${suffix}`, nowEpochMs)
            const terminalTarget = targetReport(`ret_target_${suffix}`, terminalPage, nowEpochMs)
            const oldQuarantinePayload = trackingPayload(oldQuarantine)
            const admission = new AnimationRumV2AdmissionService(pool, { get: () => undefined } as never)

            await expect(
                admission.admitBatch(
                    appId,
                    [
                        oldQuarantinePayload,
                        trackingPayload(recentQuarantine),
                        trackingPayload(pending),
                        trackingPayload(terminalTarget),
                        trackingPayload(terminalPage),
                    ],
                    { nowEpochMs }
                )
            ).resolves.toEqual(expect.objectContaining({ accepted: 5, queued: 5, duplicates: 0 }))

            await pool.query(
                `
                    UPDATE public.animation_rum_v2_capture_receipt
                    SET delivery_state = 'quarantined',
                        delivery_via = NULL,
                        published_at = NULL,
                        persisted_at = NULL,
                        quarantined_at = CASE capture_id
                            WHEN $2 THEN CURRENT_TIMESTAMP - interval '8 days'
                            WHEN $3 THEN CURRENT_TIMESTAMP - interval '6 days'
                        END,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE application_id = $1 AND capture_id IN ($2, $3)
                `,
                [applicationId, oldQuarantine.captureId, recentQuarantine.captureId]
            )
            await pool.query(
                `
                    UPDATE public.animation_rum_v2_outbox
                    SET state = 'quarantined',
                        lease_owner = NULL,
                        lease_until = NULL,
                        last_error_code = 'INTEGRATION_RETENTION',
                        quarantined_at = CASE capture_id
                            WHEN $2 THEN CURRENT_TIMESTAMP - interval '8 days'
                            WHEN $3 THEN CURRENT_TIMESTAMP - interval '6 days'
                        END,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE application_id = $1 AND capture_id IN ($2, $3)
                `,
                [applicationId, oldQuarantine.captureId, recentQuarantine.captureId]
            )
            await pool.query(
                `
                    DELETE FROM public.animation_rum_v2_outbox
                    WHERE application_id = $1 AND capture_id IN ($2, $3)
                `,
                [applicationId, terminalPage.captureId, terminalTarget.captureId]
            )
            await pool.query(
                `
                    UPDATE public.animation_rum_v2_capture_receipt
                    SET delivery_state = 'persisted',
                        delivery_via = 'clickhouse',
                        published_at = NULL,
                        persisted_at = CURRENT_TIMESTAMP - interval '1 day',
                        quarantined_at = NULL,
                        initial_received_at = CURRENT_TIMESTAMP - interval '181 days',
                        expires_at = CURRENT_TIMESTAMP - interval '1 day',
                        updated_at = CURRENT_TIMESTAMP
                    WHERE application_id = $1 AND capture_id IN ($2, $3)
                `,
                [applicationId, terminalPage.captureId, terminalTarget.captureId]
            )
            await pool.query(
                `
                    UPDATE public.animation_rum_v2_capture_receipt
                    SET initial_received_at = CURRENT_TIMESTAMP - interval '181 days',
                        expires_at = CURRENT_TIMESTAMP - interval '1 day',
                        updated_at = CURRENT_TIMESTAMP
                    WHERE application_id = $1 AND capture_id = $2
                `,
                [applicationId, pending.captureId]
            )

            const coordinated = createCoordinatedRetentionPool(pool)
            const first = new AnimationRumV2RetentionService(coordinated.pool as never, retentionConfig() as never)
            const second = new AnimationRumV2RetentionService(coordinated.pool as never, retentionConfig() as never)
            const results = await withTimeout(
                Promise.all([first.cleanupOnce(), second.cleanupOnce()]),
                15_000,
                'The competing retention services did not finish their cleanup cycles'
            )
            const leaders = results.filter(result => result.lockAcquired)
            const followers = results.filter(result => result.lockSkipped)
            expect(leaders).toHaveLength(1)
            expect(followers).toHaveLength(1)
            expect(leaders[0]).toEqual(
                expect.objectContaining<Partial<AnimationRumV2RetentionStats>>({
                    scannedApplications: 1,
                    quarantinedOutboxDeleted: 1,
                    receiptsDeleted: 2,
                    failedApplications: 0,
                })
            )
            expect(coordinated.receiptDeleteScopes).toEqual(['target', 'page'])

            const retained = await pool.query<RetainedCaptureRow>(
                `
                    SELECT receipt.capture_id AS "captureId",
                           receipt.delivery_state AS "deliveryState",
                           receipt.expires_at < CURRENT_TIMESTAMP AS expired,
                           outbox.state AS "outboxState"
                    FROM public.animation_rum_v2_capture_receipt AS receipt
                    LEFT JOIN public.animation_rum_v2_outbox AS outbox
                      ON outbox.application_id = receipt.application_id
                     AND outbox.capture_id = receipt.capture_id
                    WHERE receipt.application_id = $1
                    ORDER BY receipt.capture_id
                `,
                [applicationId]
            )
            expect(retained.rows).toEqual(
                [
                    {
                        captureId: oldQuarantine.captureId,
                        deliveryState: 'quarantined',
                        expired: false,
                        outboxState: null,
                    },
                    {
                        captureId: pending.captureId,
                        deliveryState: 'pending',
                        expired: true,
                        outboxState: 'pending',
                    },
                    {
                        captureId: recentQuarantine.captureId,
                        deliveryState: 'quarantined',
                        expired: false,
                        outboxState: 'quarantined',
                    },
                ].sort((left, right) => left.captureId.localeCompare(right.captureId))
            )

            await expect(admission.admitBatch(appId, [oldQuarantinePayload], { nowEpochMs })).rejects.toMatchObject({
                response: expect.objectContaining({ error: 'RUM_V2_CAPTURE_QUARANTINED' }),
                status: 409,
            })
            const terminalCount = await pool.query<{ count: string }>(
                `
                    SELECT count(*)::text AS count
                    FROM public.animation_rum_v2_capture_receipt
                    WHERE application_id = $1 AND capture_id IN ($2, $3)
                `,
                [applicationId, terminalPage.captureId, terminalTarget.captureId]
            )
            expect(terminalCount.rows[0]?.count).toBe('0')
        } finally {
            await cleanupFixture(pool, fixture)
        }
    })
})
