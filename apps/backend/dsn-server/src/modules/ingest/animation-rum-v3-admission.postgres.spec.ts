import { randomUUID } from 'node:crypto'

import { createAnimationRumV3GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { Pool } from 'pg'

import { AnimationRumV3AdmissionService } from './animation-rum-v3-admission.service'

// cspell:ignore rumv

const describePostgres = process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const WRITE_SENTINEL = 'condev-animation-rum-v3-admission'

describePostgres('AnimationRumV3AdmissionService PostgreSQL integration', () => {
    jest.setTimeout(30_000)
    let pool: Pool
    let applicationId = 0
    let adminId = 0
    let appId = ''
    let service: AnimationRumV3AdmissionService

    beforeAll(async () => {
        if (!process.env.TEST_POSTGRES_URL) throw new Error('TEST_POSTGRES_URL is required')
        if (process.env.TEST_POSTGRES_WRITE_SENTINEL !== WRITE_SENTINEL) {
            throw new Error(`TEST_POSTGRES_WRITE_SENTINEL must equal ${WRITE_SENTINEL}`)
        }
        pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URL, max: 4 })
        const schema = await pool.query<{ ready: boolean }>(`
            SELECT to_regclass('public.animation_rum_v3_soft_navigation_policy') IS NOT NULL
               AND to_regclass('public.animation_rum_v3_soft_navigation_route_registry') IS NOT NULL
               AND to_regclass('public.animation_rum_v3_soft_navigation_deployment_registry') IS NOT NULL
               AND to_regclass('public.animation_rum_v3_soft_navigation_capture_receipt') IS NOT NULL
               AND to_regclass('public.animation_rum_v3_soft_navigation_outbox') IS NOT NULL AS ready
        `)
        if (!schema.rows[0]?.ready) throw new Error('Animation RUM v3 PostgreSQL migration 007 is required')
        service = new AnimationRumV3AdmissionService(pool, { get: () => undefined } as never)
    })

    beforeEach(async () => {
        const suffix = randomUUID().replaceAll('-', '')
        const admin = await pool.query<{ id: number }>(
            `INSERT INTO public.admin (password, email, role, "isVerified") VALUES ('fixture', $1, 'admin', true) RETURNING id`,
            [`animation-rum-v3-${suffix}@example.invalid`]
        )
        adminId = Number(admin.rows[0]!.id)
        appId = `rumv3${suffix.slice(0, 20)}`
        const application = await pool.query<{ id: number }>(
            `INSERT INTO public.application ("appId", type, name, "userId", "isDelete") VALUES ($1, 'vanilla', $2, $3, false) RETURNING id`,
            [appId, `Animation RUM v3 ${suffix}`, adminId]
        )
        applicationId = Number(application.rows[0]!.id)
        await pool.query(
            `INSERT INTO public.animation_rum_v3_soft_navigation_policy
                (application_id, enabled, created_by, updated_by, disabled_at)
             VALUES ($1, true, $2, $2, NULL)`,
            [applicationId, adminId]
        )
        await pool.query(
            `INSERT INTO public.animation_rum_v3_soft_navigation_route_registry
                (application_id, route_key, enabled, created_by, updated_by, disabled_at)
             VALUES ($1, 'catalog.product-detail', true, $2, $2, NULL)`,
            [applicationId, adminId]
        )
        await pool.query(
            `INSERT INTO public.animation_rum_v3_soft_navigation_deployment_registry
                (application_id, release, dist, environment, enabled, created_by, updated_by, disabled_at)
             VALUES ($1, 'web-1.0.0', '42', 'production', true, $2, $2, NULL)`,
            [applicationId, adminId]
        )
    })

    afterEach(async () => {
        if (applicationId > 0) {
            for (const table of [
                'animation_rum_v3_soft_navigation_outbox',
                'animation_rum_v3_soft_navigation_capture_receipt',
                'animation_rum_v3_soft_navigation_route_registry',
                'animation_rum_v3_soft_navigation_deployment_registry',
                'animation_rum_v3_soft_navigation_policy',
            ]) {
                await pool.query(`DELETE FROM public.${table} WHERE application_id = $1`, [applicationId])
            }
            await pool.query('DELETE FROM public.application WHERE id = $1', [applicationId])
        }
        if (adminId > 0) await pool.query('DELETE FROM public.admin WHERE id = $1', [adminId])
        applicationId = 0
        adminId = 0
    })

    afterAll(async () => pool?.end())

    it('serializes concurrent exact retries into one receipt and one independent outbox row', async () => {
        const report = createAnimationRumV3GoldenReport()
        const now = Date.now()
        report.capturedAt = new Date(now - 1_000).toISOString()
        const wrapped = {
            ...report,
            event_type: 'animation_soft_navigation_rum',
            message: '',
            _eventId: report.eventId,
            _clientCreatedAt: now,
        }

        const results = await Promise.all([
            service.admitBatch(appId, [wrapped], { nowEpochMs: now }),
            service.admitBatch(appId, [wrapped], { nowEpochMs: now }),
        ])

        expect(results.map(result => result.queued).sort()).toEqual([0, 1])
        const state = await pool.query<{ receipts: string; outbox: string; nextSequence: string; topic: string }>(
            `SELECT
                (SELECT count(*)::text FROM public.animation_rum_v3_soft_navigation_capture_receipt WHERE application_id = $1) AS receipts,
                (SELECT count(*)::text FROM public.animation_rum_v3_soft_navigation_outbox WHERE application_id = $1) AS outbox,
                (SELECT next_outbox_sequence::text FROM public.animation_rum_v3_soft_navigation_policy WHERE application_id = $1) AS "nextSequence",
                (SELECT topic FROM public.animation_rum_v3_soft_navigation_outbox WHERE application_id = $1) AS topic`,
            [applicationId]
        )
        expect(state.rows[0]).toEqual({
            receipts: '1',
            outbox: '1',
            nextSequence: '2',
            topic: 'monitor.sdk.animation-rum.soft-navigation.v3',
        })
    })
})
