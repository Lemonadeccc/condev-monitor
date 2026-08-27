import { randomUUID } from 'node:crypto'

import { DataSource, EntityManager } from 'typeorm'

import { AnimationRumV2ControlService } from './animation-rum-v2-control.service'

const describePostgres = process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const WRITE_SENTINEL = 'condev-animation-rum-v2-integration'

describePostgres('AnimationRumV2ControlService PostgreSQL integration', () => {
    jest.setTimeout(30_000)

    let dataSource: DataSource
    let service: AnimationRumV2ControlService
    let adminId: number
    let applicationId: number
    let appId: string

    const overlappingService = () => {
        let arrivals = 0
        let release!: () => void
        const gate = new Promise<void>(resolve => {
            release = resolve
        })
        const transaction = <T>(
            isolation: 'READ COMMITTED' | 'REPEATABLE READ',
            callback: (manager: EntityManager) => Promise<T>
        ): Promise<T> =>
            dataSource.transaction(isolation, async manager => {
                arrivals += 1
                if (arrivals === 2) release()
                await gate
                return callback(manager)
            })
        return new AnimationRumV2ControlService({ transaction } as unknown as DataSource)
    }

    beforeAll(async () => {
        const url = process.env.TEST_POSTGRES_URL
        if (!url) throw new Error('TEST_POSTGRES_URL is required for Animation RUM v2 PostgreSQL integration tests')
        if (process.env.TEST_POSTGRES_WRITE_SENTINEL !== WRITE_SENTINEL) {
            throw new Error(`TEST_POSTGRES_WRITE_SENTINEL must equal ${WRITE_SENTINEL}`)
        }
        dataSource = new DataSource({
            type: 'postgres',
            url,
            synchronize: false,
        })
        await dataSource.initialize()
        const preflight = await dataSource.query<Array<{ ready: boolean }>>(
            `
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
            `
        )
        if (preflight.length !== 1 || preflight[0]?.ready !== true) {
            throw new Error('Animation RUM v2 PostgreSQL migrations 003 and 004 are required before integration writes')
        }
        service = new AnimationRumV2ControlService(dataSource)
    })

    beforeEach(async () => {
        adminId = 0
        applicationId = 0
        appId = ''
        const suffix = randomUUID().replaceAll('-', '')
        const admins = await dataSource.query<Array<{ id: number }>>(
            `
                INSERT INTO public.admin (password, email, role, "isVerified")
                VALUES ($1, $2, 'admin', true)
                RETURNING id
            `,
            ['fixture', `animation-rum-v2-${suffix}@example.invalid`]
        )
        adminId = Number(admins[0].id)
        appId = `vanilla${suffix.slice(0, 12)}`
        const applications = await dataSource.query<Array<{ id: number }>>(
            `
                INSERT INTO public.application ("appId", type, name, "userId", "isDelete")
                VALUES ($1, 'vanilla', $2, $3, false)
                RETURNING id
            `,
            [appId, `Animation RUM v2 ${suffix}`, adminId]
        )
        applicationId = Number(applications[0].id)
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
                    await dataSource.query(`DELETE FROM public.${table} WHERE application_id = $1`, [applicationId])
                } catch (error) {
                    cleanupErrors.push(error)
                }
            }
            try {
                await dataSource.query('DELETE FROM public.application WHERE id = $1', [applicationId])
            } catch (error) {
                cleanupErrors.push(error)
            }
        }
        if (adminId > 0) {
            try {
                await dataSource.query('DELETE FROM public.admin WHERE id = $1', [adminId])
            } catch (error) {
                cleanupErrors.push(error)
            }
        }
        if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Animation RUM v2 integration cleanup failed')
    })

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy()
    })

    it('configures, registers, tombstones, re-enables, and reports bounded state', async () => {
        await expect(service.state(adminId, { appId })).resolves.toEqual({
            appId,
            policy: null,
            counts: {
                routes: { total: 0, enabled: 0, effectiveEnabled: 0 },
                targets: { total: 0, enabled: 0, effectiveEnabled: 0 },
                deployments: { total: 0, enabled: 0, effectiveEnabled: 0 },
            },
            routes: [],
            targets: [],
            deployments: [],
        })

        const configured = await service.configurePolicy(adminId, {
            appId,
            maxRoutes: 2,
            maxTargets: 2,
            maxDeployments: 2,
        })
        expect(configured.enabled).toBe(false)

        await expect(
            service.registerTarget(adminId, { appId, routeKey: 'catalog.missing', targetKey: 'hero-canvas' })
        ).rejects.toMatchObject({ status: 409, response: { error: 'TARGET_ROUTE_NOT_REGISTERED' } })

        const emptyDeployment = await service.registerDeployment(adminId, { appId, release: '', dist: '', environment: '' })
        expect(emptyDeployment).toEqual(
            expect.objectContaining({
                created: true,
                deployment: expect.objectContaining({ release: '', dist: '', environment: '' }),
            })
        )
        await service.registerRoute(adminId, { appId, routeKey: 'catalog.detail' })
        await service.registerTarget(adminId, { appId, routeKey: 'catalog.detail', targetKey: 'hero-canvas' })
        const stagedState = await service.state(adminId, { appId })
        expect(stagedState.counts).toEqual({
            routes: { total: 1, enabled: 1, effectiveEnabled: 0 },
            targets: { total: 1, enabled: 1, effectiveEnabled: 0 },
            deployments: { total: 1, enabled: 1, effectiveEnabled: 0 },
        })
        await service.setPolicyEnabled(adminId, { appId }, true)

        const disabled = await service.disableRoute(adminId, { appId, routeKey: 'catalog.detail' })
        const repeated = await service.disableRoute(adminId, { appId, routeKey: 'catalog.detail' })
        const disabledState = await service.state(adminId, { appId })
        expect(disabledState.counts.routes).toEqual({ total: 1, enabled: 0, effectiveEnabled: 0 })
        expect(disabledState.counts.targets).toEqual({ total: 1, enabled: 1, effectiveEnabled: 0 })
        expect(disabledState.routes[0]).toEqual(expect.objectContaining({ enabled: false, effectiveEnabled: false }))
        expect(disabledState.targets[0]).toEqual(expect.objectContaining({ enabled: true, effectiveEnabled: false }))
        const reenabled = await service.registerRoute(adminId, { appId, routeKey: 'catalog.detail' })
        expect(disabled.changed).toBe(true)
        expect(repeated.changed).toBe(false)
        expect(reenabled).toEqual(expect.objectContaining({ created: false, reenabled: true }))
        expect(reenabled.route.createdAt).toBe(disabled.route.createdAt)

        await service.disableTarget(adminId, { appId, routeKey: 'catalog.detail', targetKey: 'hero-canvas' })
        await service.disableDeployment(adminId, { appId, release: '', dist: '', environment: '' })
        const childDisabledState = await service.state(adminId, { appId })
        expect(childDisabledState.counts.targets).toEqual({ total: 1, enabled: 0, effectiveEnabled: 0 })
        expect(childDisabledState.counts.deployments).toEqual({ total: 1, enabled: 0, effectiveEnabled: 0 })
        await service.registerTarget(adminId, { appId, routeKey: 'catalog.detail', targetKey: 'hero-canvas' })
        await service.registerDeployment(adminId, { appId, release: '', dist: '', environment: '' })

        const state = await service.state(adminId, { appId })
        expect(state).toEqual(
            expect.objectContaining({
                appId,
                policy: expect.objectContaining({ enabled: true, maxRoutes: 2 }),
                counts: {
                    routes: { total: 1, enabled: 1, effectiveEnabled: 1 },
                    targets: { total: 1, enabled: 1, effectiveEnabled: 1 },
                    deployments: { total: 1, enabled: 1, effectiveEnabled: 1 },
                },
            })
        )
        expect(state.deployments[0]).toEqual(expect.objectContaining({ release: '', dist: '', environment: '', effectiveEnabled: true }))
        expect(JSON.stringify(state)).not.toContain('nextOutboxSequence')

        const policyDisabled = await service.setPolicyEnabled(adminId, { appId }, false)
        const policyRepeated = await service.setPolicyEnabled(adminId, { appId }, false)
        expect(policyDisabled.enabled).toBe(false)
        expect(policyRepeated).toEqual(policyDisabled)
        const policyDisabledState = await service.state(adminId, { appId })
        expect(policyDisabledState.counts).toEqual({
            routes: { total: 1, enabled: 1, effectiveEnabled: 0 },
            targets: { total: 1, enabled: 1, effectiveEnabled: 0 },
            deployments: { total: 1, enabled: 1, effectiveEnabled: 0 },
        })
        await expect(service.setPolicyEnabled(adminId, { appId }, true)).resolves.toEqual(expect.objectContaining({ enabled: true }))

        await expect(service.registerRoute(adminId, { appId, routeKey: 'orders.12345' })).rejects.toMatchObject({
            status: 400,
            response: { error: 'INVALID_ROUTE_KEY' },
        })
        await expect(
            service.registerTarget(adminId, {
                appId,
                routeKey: 'catalog.detail',
                targetKey: 'item.abcdef0123456789',
            })
        ).rejects.toMatchObject({ status: 400, response: { error: 'INVALID_TARGET_KEY' } })
    })

    it('serializes concurrent registration against the historical quota', async () => {
        await service.configurePolicy(adminId, { appId, maxRoutes: 1, maxTargets: 1, maxDeployments: 1 })

        const concurrentRoutes = overlappingService()
        const results = await Promise.allSettled([
            concurrentRoutes.registerRoute(adminId, { appId, routeKey: 'catalog.alpha' }),
            concurrentRoutes.registerRoute(adminId, { appId, routeKey: 'catalog.beta' }),
        ])

        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
        expect(rejected.reason).toMatchObject({ status: 409, response: { error: 'ROUTE_QUOTA_EXCEEDED' } })
        const state = await service.state(adminId, { appId })
        expect(state.counts.routes).toEqual({ total: 1, enabled: 1, effectiveEnabled: 0 })

        const routeKey = state.routes[0]!.routeKey
        const concurrentTargets = overlappingService()
        const targetResults = await Promise.allSettled([
            concurrentTargets.registerTarget(adminId, { appId, routeKey, targetKey: 'hero-alpha' }),
            concurrentTargets.registerTarget(adminId, { appId, routeKey, targetKey: 'hero-beta' }),
        ])
        expect(targetResults.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        expect((targetResults.find(result => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
            status: 409,
            response: { error: 'TARGET_QUOTA_EXCEEDED' },
        })

        const concurrentDeployments = overlappingService()
        const deploymentResults = await Promise.allSettled([
            concurrentDeployments.registerDeployment(adminId, { appId, release: 'r1', dist: '', environment: '' }),
            concurrentDeployments.registerDeployment(adminId, { appId, release: 'r2', dist: '', environment: '' }),
        ])
        expect(deploymentResults.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        expect((deploymentResults.find(result => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
            status: 409,
            response: { error: 'DEPLOYMENT_QUOTA_EXCEEDED' },
        })
    })

    it('registers one historical row for concurrent requests with the same identity', async () => {
        await service.configurePolicy(adminId, { appId, maxRoutes: 1, maxTargets: 1, maxDeployments: 1 })
        const concurrent = overlappingService()

        const results = await Promise.all([
            concurrent.registerRoute(adminId, { appId, routeKey: 'catalog.alpha' }),
            concurrent.registerRoute(adminId, { appId, routeKey: 'catalog.alpha' }),
        ])

        expect(results.filter(result => result.created)).toHaveLength(1)
        expect(results.filter(result => !result.created && !result.reenabled)).toHaveLength(1)
        const state = await service.state(adminId, { appId })
        expect(state.counts.routes).toEqual({ total: 1, enabled: 1, effectiveEnabled: 0 })
    })

    it('keeps disabled identities in historical quotas and re-enables only the same identity', async () => {
        await service.configurePolicy(adminId, { appId, maxRoutes: 1, maxTargets: 1, maxDeployments: 1 })
        await service.registerRoute(adminId, { appId, routeKey: 'catalog.alpha' })
        await service.registerTarget(adminId, { appId, routeKey: 'catalog.alpha', targetKey: 'hero-alpha' })
        await service.registerDeployment(adminId, { appId, release: '', dist: '', environment: '' })

        await service.disableRoute(adminId, { appId, routeKey: 'catalog.alpha' })
        const targetDisabled = await service.disableTarget(adminId, {
            appId,
            routeKey: 'catalog.alpha',
            targetKey: 'hero-alpha',
        })
        const targetRepeated = await service.disableTarget(adminId, {
            appId,
            routeKey: 'catalog.alpha',
            targetKey: 'hero-alpha',
        })
        const deploymentDisabled = await service.disableDeployment(adminId, { appId, release: '', dist: '', environment: '' })
        const deploymentRepeated = await service.disableDeployment(adminId, { appId, release: '', dist: '', environment: '' })
        expect(targetDisabled.changed).toBe(true)
        expect(targetRepeated.changed).toBe(false)
        expect(deploymentDisabled.changed).toBe(true)
        expect(deploymentRepeated.changed).toBe(false)
        const disabled = await service.state(adminId, { appId })
        expect(disabled.counts).toEqual({
            routes: { total: 1, enabled: 0, effectiveEnabled: 0 },
            targets: { total: 1, enabled: 0, effectiveEnabled: 0 },
            deployments: { total: 1, enabled: 0, effectiveEnabled: 0 },
        })

        await expect(service.registerRoute(adminId, { appId, routeKey: 'catalog.beta' })).rejects.toMatchObject({
            response: { error: 'ROUTE_QUOTA_EXCEEDED' },
        })
        await expect(service.registerTarget(adminId, { appId, routeKey: 'catalog.alpha', targetKey: 'hero-beta' })).rejects.toMatchObject({
            response: { error: 'TARGET_QUOTA_EXCEEDED' },
        })
        await expect(service.registerDeployment(adminId, { appId, release: 'r2', dist: '', environment: '' })).rejects.toMatchObject({
            response: { error: 'DEPLOYMENT_QUOTA_EXCEEDED' },
        })

        await expect(service.registerRoute(adminId, { appId, routeKey: 'catalog.alpha' })).resolves.toEqual(
            expect.objectContaining({ created: false, reenabled: true })
        )
        await expect(service.registerTarget(adminId, { appId, routeKey: 'catalog.alpha', targetKey: 'hero-alpha' })).resolves.toEqual(
            expect.objectContaining({ created: false, reenabled: true })
        )
        await expect(service.registerDeployment(adminId, { appId, release: '', dist: '', environment: '' })).resolves.toEqual(
            expect.objectContaining({ created: false, reenabled: true })
        )
    })

    it('does not lower a quota below disabled registration history', async () => {
        await service.configurePolicy(adminId, { appId, maxRoutes: 2, maxTargets: 2, maxDeployments: 2 })
        await service.registerRoute(adminId, { appId, routeKey: 'catalog.alpha' })
        await service.registerRoute(adminId, { appId, routeKey: 'catalog.beta' })
        await service.registerTarget(adminId, { appId, routeKey: 'catalog.alpha', targetKey: 'hero-alpha' })
        await service.registerTarget(adminId, { appId, routeKey: 'catalog.beta', targetKey: 'hero-beta' })
        await service.registerDeployment(adminId, { appId, release: 'r1', dist: '', environment: '' })
        await service.registerDeployment(adminId, { appId, release: 'r2', dist: '', environment: '' })
        await service.disableRoute(adminId, { appId, routeKey: 'catalog.beta' })
        await service.disableTarget(adminId, { appId, routeKey: 'catalog.beta', targetKey: 'hero-beta' })
        await service.disableDeployment(adminId, { appId, release: 'r2', dist: '', environment: '' })

        await expect(service.configurePolicy(adminId, { appId, maxRoutes: 1, maxTargets: 2, maxDeployments: 2 })).rejects.toMatchObject({
            status: 409,
            response: { error: 'ROUTE_QUOTA_BELOW_HISTORY' },
        })
        await expect(service.configurePolicy(adminId, { appId, maxRoutes: 2, maxTargets: 1, maxDeployments: 2 })).rejects.toMatchObject({
            status: 409,
            response: { error: 'TARGET_QUOTA_BELOW_HISTORY' },
        })
        await expect(service.configurePolicy(adminId, { appId, maxRoutes: 2, maxTargets: 2, maxDeployments: 1 })).rejects.toMatchObject({
            status: 409,
            response: { error: 'DEPLOYMENT_QUOTA_BELOW_HISTORY' },
        })
        await expect(service.state(adminId, { appId })).resolves.toEqual(
            expect.objectContaining({
                policy: expect.objectContaining({ maxRoutes: 2, maxTargets: 2, maxDeployments: 2 }),
            })
        )
    })

    it('applies the target quota globally across registered routes', async () => {
        await service.configurePolicy(adminId, { appId, maxRoutes: 2, maxTargets: 1, maxDeployments: 1 })
        await service.registerRoute(adminId, { appId, routeKey: 'catalog.alpha' })
        await service.registerRoute(adminId, { appId, routeKey: 'catalog.beta' })
        await service.registerTarget(adminId, { appId, routeKey: 'catalog.alpha', targetKey: 'hero-alpha' })

        await expect(service.registerTarget(adminId, { appId, routeKey: 'catalog.beta', targetKey: 'hero-beta' })).rejects.toMatchObject({
            status: 409,
            response: { error: 'TARGET_QUOTA_EXCEEDED' },
        })
    })

    it('rejects a non-owner and a soft-deleted application before policy writes', async () => {
        await expect(service.configurePolicy(adminId + 1, { appId, maxRoutes: 1, maxTargets: 1, maxDeployments: 1 })).rejects.toMatchObject(
            { status: 403 }
        )

        await dataSource.query('UPDATE public.application SET "isDelete" = true WHERE id = $1', [applicationId])
        await expect(service.configurePolicy(adminId, { appId, maxRoutes: 1, maxTargets: 1, maxDeployments: 1 })).rejects.toMatchObject({
            status: 403,
        })
        const policyRows = await dataSource.query<Array<{ count: string }>>(
            'SELECT count(*)::text AS count FROM public.animation_rum_v2_policy WHERE application_id = $1',
            [applicationId]
        )
        expect(policyRows[0]?.count).toBe('0')
    })
})
