import { randomUUID } from 'node:crypto'

import type { AnimationRumV2Report } from '@condev-monitor/animation-rum-contract'
import { ANIMATION_RUM_V2_GOLDEN_NOW, createAnimationRumV2GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { Pool } from 'pg'

import { AnimationRumV2AdmissionService } from './animation-rum-v2-admission.service'

// cspell:ignore regclass

const describePostgres = process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const WRITE_SENTINEL = 'condev-animation-rum-v2-admission'

function trackingPayload(report: AnimationRumV2Report) {
    return {
        ...report,
        event_type: 'animation_rum',
        message: '',
        _eventId: report.eventId,
        _clientCreatedAt: ANIMATION_RUM_V2_GOLDEN_NOW - 1_000,
    }
}

describePostgres('AnimationRumV2AdmissionService PostgreSQL integration', () => {
    jest.setTimeout(30_000)

    let pool: Pool
    let service: AnimationRumV2AdmissionService
    let adminId = 0
    let applicationId = 0
    let appId = ''

    beforeAll(async () => {
        const url = process.env.TEST_POSTGRES_URL
        if (!url) throw new Error('TEST_POSTGRES_URL is required for Animation RUM v2 admission integration tests')
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
                AND EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'animation_rum_v2_capture_receipt'
                      AND column_name = 'payload_hash_version'
                ) AS ready
        `)
        if (preflight.rows.length !== 1 || preflight.rows[0]?.ready !== true) {
            throw new Error('Animation RUM v2 PostgreSQL migrations 003 and 004 are required before integration writes')
        }
        service = new AnimationRumV2AdmissionService(pool, { get: () => undefined } as never)
    })

    beforeEach(async () => {
        const suffix = randomUUID().replaceAll('-', '')
        const admin = await pool.query<{ id: number }>(
            `
                INSERT INTO public.admin (password, email, role, "isVerified")
                VALUES ($1, $2, 'admin', true)
                RETURNING id
            `,
            ['fixture', `animation-rum-v2-admission-${suffix}@example.invalid`]
        )
        adminId = Number(admin.rows[0]!.id)
        appId = `admission${suffix.slice(0, 12)}`
        const application = await pool.query<{ id: number }>(
            `
                INSERT INTO public.application ("appId", type, name, "userId", "isDelete")
                VALUES ($1, 'vanilla', $2, $3, false)
                RETURNING id
            `,
            [appId, `Animation RUM v2 admission ${suffix}`, adminId]
        )
        applicationId = Number(application.rows[0]!.id)
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
                INSERT INTO public.animation_rum_v2_deployment_registry (
                    application_id, release, dist, environment, enabled, created_by, updated_by, disabled_at
                ) VALUES ($1, 'web-1.0.0', '42', 'production', true, $2, $2, NULL)
            `,
            [applicationId, adminId]
        )
    })

    afterEach(async () => {
        const cleanupErrors: unknown[] = []
        if (applicationId > 0) {
            for (const table of [
                'animation_rum_v2_outbox',
                'animation_rum_v2_capture_receipt',
                'animation_rum_v2_target_registry',
                'animation_rum_v2_route_registry',
                'animation_rum_v2_deployment_registry',
                'animation_rum_v2_policy',
            ]) {
                try {
                    await pool.query(`DELETE FROM public.${table} WHERE application_id = $1`, [applicationId])
                } catch (error) {
                    cleanupErrors.push(error)
                }
            }
            try {
                await pool.query('DELETE FROM public.application WHERE id = $1', [applicationId])
            } catch (error) {
                cleanupErrors.push(error)
            }
        }
        if (adminId > 0) {
            try {
                await pool.query('DELETE FROM public.admin WHERE id = $1', [adminId])
            } catch (error) {
                cleanupErrors.push(error)
            }
        }
        adminId = 0
        applicationId = 0
        appId = ''
        if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Animation RUM v2 admission cleanup failed')
    })

    afterAll(async () => {
        await pool?.end()
    })

    it('serializes exact concurrent retries and rejects a changed identity payload', async () => {
        const report = createAnimationRumV2GoldenReport()
        const wrapped = trackingPayload(report)

        const concurrent = await Promise.all([
            service.admitBatch(appId, [wrapped], { nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW }),
            service.admitBatch(appId, [wrapped], { nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW }),
        ])

        expect(concurrent.map(result => result.queued).sort()).toEqual([0, 1])
        expect(concurrent.map(result => result.duplicates).sort()).toEqual([0, 1])
        const state = await pool.query<{ receipts: string; outbox: string; nextSequence: string }>(
            `
                SELECT
                    (SELECT count(*)::text FROM public.animation_rum_v2_capture_receipt WHERE application_id = $1) AS receipts,
                    (SELECT count(*)::text FROM public.animation_rum_v2_outbox WHERE application_id = $1) AS outbox,
                    (SELECT next_outbox_sequence::text FROM public.animation_rum_v2_policy WHERE application_id = $1) AS "nextSequence"
            `,
            [applicationId]
        )
        expect(state.rows[0]).toEqual({ receipts: '1', outbox: '1', nextSequence: '2' })

        await pool.query(
            `
                UPDATE public.animation_rum_v2_policy
                SET enabled = false, disabled_at = CURRENT_TIMESTAMP
                WHERE application_id = $1
            `,
            [applicationId]
        )
        const staleRetry = await service.admitBatch(appId, [wrapped], {
            nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW + 91 * 24 * 60 * 60 * 1_000,
        })
        expect(staleRetry).toEqual(expect.objectContaining({ queued: 0, duplicates: 1 }))

        const changed = createAnimationRumV2GoldenReport()
        changed.metrics[0]!.value = 19.5
        await expect(
            service.admitBatch(appId, [trackingPayload(changed)], { nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW })
        ).rejects.toMatchObject({
            response: expect.objectContaining({ error: 'RUM_V2_IDENTITY_CONFLICT' }),
            status: 409,
        })
    })

    it('topologically inserts a target-first batch while preserving response order', async () => {
        await pool.query(
            `
                INSERT INTO public.animation_rum_v2_target_registry (
                    application_id, route_key, target_key, enabled, created_by, updated_by, disabled_at
                ) VALUES ($1, 'product-detail', 'hero-canvas', true, $2, $2, NULL)
            `,
            [applicationId, adminId]
        )
        const page = createAnimationRumV2GoldenReport()
        const target = createAnimationRumV2GoldenReport()
        target.eventId = 'event_target_1234'
        target.captureId = 'capture_target_1234'
        target.scope = 'target'
        target.parentCaptureId = page.captureId
        target.targetKey = 'hero-canvas'
        target.metrics[0]!.relation = 'target-temporal-overlap'

        const result = await service.admitBatch(appId, [trackingPayload(target), trackingPayload(page)], {
            nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW,
        })

        expect(result).toEqual(expect.objectContaining({ accepted: 2, queued: 2, duplicates: 0 }))
        expect(result.receipts.map(receipt => receipt.captureId)).toEqual([target.captureId, page.captureId])
        const rows = await pool.query<{ captureId: string; sequence: string; parentCaptureId: string | null }>(
            `
                SELECT capture_id AS "captureId",
                       app_sequence::text AS sequence,
                       depends_on_capture_id AS "parentCaptureId"
                FROM public.animation_rum_v2_outbox
                WHERE application_id = $1
                ORDER BY app_sequence
            `,
            [applicationId]
        )
        expect(rows.rows).toEqual([
            { captureId: page.captureId, sequence: '1', parentCaptureId: null },
            { captureId: target.captureId, sequence: '2', parentCaptureId: page.captureId },
        ])
    })

    it('rolls back a target with a missing parent without consuming a sequence', async () => {
        await pool.query(
            `
                INSERT INTO public.animation_rum_v2_target_registry (
                    application_id, route_key, target_key, enabled, created_by, updated_by, disabled_at
                ) VALUES ($1, 'product-detail', 'hero-canvas', true, $2, $2, NULL)
            `,
            [applicationId, adminId]
        )
        const target = createAnimationRumV2GoldenReport()
        target.eventId = 'event_target_1234'
        target.captureId = 'capture_target_1234'
        target.scope = 'target'
        target.parentCaptureId = 'capture_missing_1234'
        target.targetKey = 'hero-canvas'
        target.metrics[0]!.relation = 'target-temporal-overlap'

        await expect(
            service.admitBatch(appId, [trackingPayload(target)], { nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW })
        ).rejects.toMatchObject({
            response: expect.objectContaining({ error: 'RUM_V2_PARENT_NOT_READY' }),
            status: 503,
        })
        const state = await pool.query<{ receipts: string; outbox: string; nextSequence: string }>(
            `
                SELECT
                    (SELECT count(*)::text FROM public.animation_rum_v2_capture_receipt WHERE application_id = $1) AS receipts,
                    (SELECT count(*)::text FROM public.animation_rum_v2_outbox WHERE application_id = $1) AS outbox,
                    (SELECT next_outbox_sequence::text FROM public.animation_rum_v2_policy WHERE application_id = $1) AS "nextSequence"
            `,
            [applicationId]
        )
        expect(state.rows[0]).toEqual({ receipts: '0', outbox: '0', nextSequence: '1' })
    })
})
