import { randomUUID } from 'node:crypto'

import { DataSource } from 'typeorm'

import { AnimationRumV2PipelineService } from './animation-rum-v2-pipeline.service'

const describePostgres = process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const WRITE_SENTINEL = 'condev-animation-rum-v2-integration'

describePostgres('AnimationRumV2PipelineService PostgreSQL integration', () => {
    jest.setTimeout(30_000)

    let dataSource: DataSource
    let adminId = 0
    let applicationId = 0
    let appId = ''
    const clickhouse = { query: jest.fn() }
    const applications = { assertOwned: jest.fn().mockResolvedValue(undefined) }

    beforeAll(async () => {
        const url = process.env.TEST_POSTGRES_URL
        if (!url) throw new Error('TEST_POSTGRES_URL is required for Animation RUM v2 PostgreSQL integration tests')
        if (process.env.TEST_POSTGRES_WRITE_SENTINEL !== WRITE_SENTINEL) {
            throw new Error(`TEST_POSTGRES_WRITE_SENTINEL must equal ${WRITE_SENTINEL}`)
        }
        dataSource = new DataSource({ type: 'postgres', url, synchronize: false })
        await dataSource.initialize()
        const preflight = await dataSource.query<Array<{ ready: boolean }>>(
            `
                SELECT to_regclass('public.animation_rum_v2_capture_receipt') IS NOT NULL
                    AND to_regclass('public.animation_rum_v2_outbox') IS NOT NULL
                    AND to_regclass('public.animation_rum_v2_receipt_app_updated_idx') IS NOT NULL
                    AND to_regclass('public.animation_rum_v2_outbox_app_state_updated_idx') IS NOT NULL AS ready
            `
        )
        if (preflight.length !== 1 || preflight[0]?.ready !== true) {
            throw new Error('Animation RUM v2 PostgreSQL pipeline diagnostic migration 005 is required before integration reads')
        }
    })

    beforeEach(async () => {
        adminId = 0
        applicationId = 0
        appId = ''
        clickhouse.query.mockReset()
        applications.assertOwned.mockReset().mockResolvedValue(undefined)
        const suffix = randomUUID().replaceAll('-', '')
        const admins = await dataSource.query<Array<{ id: number }>>(
            `
                INSERT INTO public.admin (password, email, role, "isVerified")
                VALUES ($1, $2, 'admin', true)
                RETURNING id
            `,
            ['fixture', `animation-rum-v2-pipeline-${suffix}@example.invalid`]
        )
        adminId = Number(admins[0]?.id)
        appId = `pipeline${suffix.slice(0, 12)}`
        const applicationsRows = await dataSource.query<Array<{ id: number }>>(
            `
                INSERT INTO public.application ("appId", type, name, "userId", "isDelete")
                VALUES ($1, 'vanilla', $2, $3, false)
                RETURNING id
            `,
            [appId, `Animation RUM v2 pipeline ${suffix}`, adminId]
        )
        applicationId = Number(applicationsRows[0]?.id)
    })

    afterEach(async () => {
        if (applicationId > 0) await dataSource.query('DELETE FROM public.application WHERE id = $1', [applicationId])
        if (adminId > 0) await dataSource.query('DELETE FROM public.admin WHERE id = $1', [adminId])
    })

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy()
    })

    it('executes every bounded PostgreSQL diagnostic query for an owned application with no traffic', async () => {
        const service = new AnimationRumV2PipelineService(
            dataSource,
            clickhouse as any,
            { get: () => 'lemonade' } as any,
            applications as any,
            () => new Date('2026-08-27T12:00:00.000Z')
        )

        await expect(service.read(adminId, appId)).resolves.toEqual(
            expect.objectContaining({
                status: 'idle',
                receipts: expect.objectContaining({ recent: { count: 0, truncated: false } }),
                outbox: expect.objectContaining({ pending: { count: 0, truncated: false } }),
                projection: expect.objectContaining({ availability: 'not-checked' }),
            })
        )
        expect(applications.assertOwned).toHaveBeenCalledWith(appId, adminId)
        expect(clickhouse.query).not.toHaveBeenCalled()
    })
})
