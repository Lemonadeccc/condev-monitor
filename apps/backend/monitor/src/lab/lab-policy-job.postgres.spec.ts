import { createHash, randomUUID } from 'node:crypto'

import { DataSource } from 'typeorm'

import { LabBaselineBindingEntity } from './entity/lab-baseline-binding.entity'
import { LabPolicyEvaluationJobEntity } from './entity/lab-policy-evaluation-job.entity'
import { LabProjectPolicyEntity } from './entity/lab-project-policy.entity'
import { LabRunEntity } from './entity/lab-run.entity'
import { LabPolicyJobService } from './lab-policy-job.service'
import { LabPolicyWorkerService } from './lab-policy-worker.service'
import { assertAnimationLabPostgresWriteAccess } from './lab-postgres-test-guard'

const describePostgres = process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

type Fixture = Readonly<{
    adminId: number
    applicationId: number
    appId: string
    baselineRunId: string
    afterRunId: string
    policyId: string
    policyDigest: string
    bindingId: string
}>

describePostgres('Animation Lab policy job PostgreSQL integration', () => {
    jest.setTimeout(30_000)

    let dataSource: DataSource
    let fixture: Fixture | null = null

    beforeAll(async () => {
        const url = assertAnimationLabPostgresWriteAccess({
            suiteName: 'Animation Lab policy job PostgreSQL integration tests',
            url: process.env.TEST_POSTGRES_URL,
            writeSentinel: process.env.TEST_POSTGRES_WRITE_SENTINEL,
            allowRemote: process.env.TEST_POSTGRES_ALLOW_REMOTE,
        })
        dataSource = new DataSource({
            type: 'postgres',
            url,
            synchronize: false,
            entities: [LabRunEntity, LabProjectPolicyEntity, LabBaselineBindingEntity, LabPolicyEvaluationJobEntity],
        })
        await dataSource.initialize()
        const preflight = await dataSource.query<Array<{ ready: boolean }>>(
            `SELECT to_regclass('public.animation_lab_policy_evaluation_job') IS NOT NULL
                AND to_regclass('public.animation_lab_policy_evaluation_job_identity_unique') IS NOT NULL
                AND to_regclass('public.animation_lab_policy_evaluation_job_due_idx') IS NOT NULL AS ready`
        )
        if (preflight.length !== 1 || preflight[0]?.ready !== true) {
            throw new Error('Animation Lab PostgreSQL migrations 009 and 010 are required before policy job integration writes')
        }
    })

    beforeEach(async () => {
        fixture = await createFixture()
    })

    afterEach(async () => {
        if (!fixture) return
        const cleanupErrors: unknown[] = []
        for (const [sql, parameters] of cleanupStatements(fixture)) {
            try {
                await dataSource.query(sql, parameters)
            } catch (error) {
                cleanupErrors.push(error)
            }
        }
        fixture = null
        if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Animation Lab policy job integration cleanup failed')
    })

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy()
    })

    it('enqueues one identity under concurrency and lets only one worker evaluate it', async () => {
        const current = requiredFixture()
        const run = await afterRun(current)
        const jobService = new LabPolicyJobService()

        const created = await Promise.all(
            Array.from({ length: 4 }, () =>
                dataSource.transaction(async manager => {
                    const count = await jobService.enqueueForCompletedRun(manager, run)
                    await manager.query('SELECT 1')
                    return count
                })
            )
        )
        expect(created.reduce((total, count) => total + count, 0)).toBe(1)
        expect(await jobsForApp(current.appId)).toHaveLength(1)

        const createEvaluation = jest.fn().mockResolvedValue({ evaluationId: randomUUID() })
        const workerA = createWorker(createEvaluation)
        const workerB = createWorker(createEvaluation)
        await Promise.all([workerA.tick(), workerB.tick()])

        expect(createEvaluation).toHaveBeenCalledTimes(1)
        expect(await onlyJob(current.appId)).toMatchObject({
            state: 'completed',
            attemptCount: 0,
            leaseOwner: null,
            leaseUntil: null,
        })
    })

    it('does not steal a live lease and recovers it after expiry', async () => {
        const current = requiredFixture()
        await enqueue(current)
        const originalOwner = randomUUID()
        await dataSource.query(
            `UPDATE public.animation_lab_policy_evaluation_job
             SET "leaseOwner" = $1, "leaseUntil" = now() + interval '1 minute'
             WHERE "appId" = $2`,
            [originalOwner, current.appId]
        )
        const createEvaluation = jest.fn().mockResolvedValue({ evaluationId: randomUUID() })
        const worker = createWorker(createEvaluation)

        await worker.tick()
        expect(createEvaluation).not.toHaveBeenCalled()
        expect(await onlyJob(current.appId)).toMatchObject({ state: 'pending', leaseOwner: originalOwner })

        await dataSource.query(
            `UPDATE public.animation_lab_policy_evaluation_job
             SET "leaseUntil" = now() - interval '1 minute'
             WHERE "appId" = $1`,
            [current.appId]
        )
        await worker.tick()
        expect(createEvaluation).toHaveBeenCalledTimes(1)
        expect(await onlyJob(current.appId)).toMatchObject({ state: 'completed', leaseOwner: null, leaseUntil: null })
    })

    it('renews a short lease while a slow evaluation is running so another worker cannot reclaim it', async () => {
        const current = requiredFixture()
        await enqueue(current)
        let markEvaluationStarted!: () => void
        let finishEvaluation!: (value: { evaluationId: string }) => void
        const evaluationStarted = new Promise<void>(resolve => (markEvaluationStarted = resolve))
        const evaluationResult = new Promise<{ evaluationId: string }>(resolve => (finishEvaluation = resolve))
        const slowEvaluation = jest.fn().mockImplementation(async () => {
            markEvaluationStarted()
            return evaluationResult
        })
        const competingEvaluation = jest.fn().mockResolvedValue({ evaluationId: randomUUID() })
        const leaseOptions = { leaseMs: 120, leaseHeartbeatMs: 30 }
        const workerA = createWorker(slowEvaluation, leaseOptions)
        const workerB = createWorker(competingEvaluation, leaseOptions)

        const firstTick = workerA.tick()
        await evaluationStarted
        await new Promise(resolve => setTimeout(resolve, 220))
        const activeLease = await onlyJob(current.appId)
        expect(activeLease.leaseOwner).not.toBeNull()
        expect(activeLease.leaseUntil?.getTime()).toBeGreaterThan(Date.now())

        await workerB.tick()
        expect(competingEvaluation).not.toHaveBeenCalled()
        finishEvaluation({ evaluationId: randomUUID() })
        await firstTick

        expect(slowEvaluation).toHaveBeenCalledTimes(1)
        expect(await onlyJob(current.appId)).toMatchObject({ state: 'completed', leaseOwner: null, leaseUntil: null })
    })

    it('quarantines the bounded fifth evaluation failure', async () => {
        const current = requiredFixture()
        await enqueue(current)
        await dataSource.query(
            `UPDATE public.animation_lab_policy_evaluation_job
             SET "attemptCount" = 4
             WHERE "appId" = $1`,
            [current.appId]
        )
        const worker = createWorker(jest.fn().mockRejectedValue(new Error('bounded failure')))

        await worker.tick()

        expect(await onlyJob(current.appId)).toMatchObject({
            state: 'quarantined',
            attemptCount: 5,
            leaseOwner: null,
            leaseUntil: null,
            lastErrorCode: 'EVALUATION_FAILED',
        })
    })

    it('does not let a stale evaluator overwrite a lease acquired by another worker', async () => {
        const current = requiredFixture()
        await enqueue(current)
        let markEvaluationStarted!: () => void
        let finishEvaluation!: (value: { evaluationId: string }) => void
        const evaluationStarted = new Promise<void>(resolve => (markEvaluationStarted = resolve))
        const evaluationResult = new Promise<{ evaluationId: string }>(resolve => (finishEvaluation = resolve))
        const createEvaluation = jest.fn().mockImplementation(async () => {
            markEvaluationStarted()
            return evaluationResult
        })
        const worker = createWorker(createEvaluation)
        const logger = jest.spyOn((worker as never as { logger: { error(value: unknown): void } }).logger, 'error').mockImplementation()

        const tick = worker.tick()
        await evaluationStarted
        const replacementOwner = randomUUID()
        await dataSource.query(
            `UPDATE public.animation_lab_policy_evaluation_job
             SET "leaseOwner" = $1, "leaseUntil" = now() + interval '1 minute'
             WHERE "appId" = $2`,
            [replacementOwner, current.appId]
        )
        finishEvaluation({ evaluationId: randomUUID() })
        await tick

        expect(await onlyJob(current.appId)).toMatchObject({
            state: 'pending',
            attemptCount: 0,
            leaseOwner: replacementOwner,
            lastErrorCode: null,
        })
        expect(logger).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'animation_lab_policy_job_lease_failed',
                code: 'LEASE_LOST_BEFORE_COMPLETE',
            })
        )
        logger.mockRestore()
    })

    it('rolls back every partial fixture row when setup fails', async () => {
        const suffix = randomUUID().replaceAll('-', '')
        const email = `animation-lab-policy-job-${suffix}@example.invalid`
        const appId = `policy${suffix.slice(0, 12)}`

        await expect(createFixture({ suffix, failAfterApplication: true })).rejects.toThrow('intentional fixture setup failure')

        const [admins, applications] = await Promise.all([
            dataSource.query<Array<{ count: string }>>('SELECT count(*)::text AS count FROM public.admin WHERE email = $1', [email]),
            dataSource.query<Array<{ count: string }>>('SELECT count(*)::text AS count FROM public.application WHERE "appId" = $1', [
                appId,
            ]),
        ])
        expect(admins[0]?.count).toBe('0')
        expect(applications[0]?.count).toBe('0')
    })

    function createWorker(
        createEvaluationForSnapshot: jest.Mock,
        options: Readonly<{ leaseMs?: number; leaseHeartbeatMs?: number }> = {}
    ): LabPolicyWorkerService {
        return new LabPolicyWorkerService(
            dataSource.getRepository(LabPolicyEvaluationJobEntity),
            {
                createEvaluationForSnapshot,
            } as never,
            options
        )
    }

    async function enqueue(current: Fixture): Promise<void> {
        const run = await afterRun(current)
        await dataSource.transaction(async manager => {
            await new LabPolicyJobService().enqueueForCompletedRun(manager, run)
        })
    }

    async function afterRun(current: Fixture): Promise<LabRunEntity> {
        return dataSource.getRepository(LabRunEntity).findOneByOrFail({ id: current.afterRunId, appId: current.appId })
    }

    async function jobsForApp(appId: string): Promise<LabPolicyEvaluationJobEntity[]> {
        return dataSource.getRepository(LabPolicyEvaluationJobEntity).find({ where: { appId } })
    }

    async function onlyJob(appId: string): Promise<LabPolicyEvaluationJobEntity> {
        const jobs = await jobsForApp(appId)
        expect(jobs).toHaveLength(1)
        return jobs[0]
    }

    async function createFixture(options: Readonly<{ suffix?: string; failAfterApplication?: boolean }> = {}): Promise<Fixture> {
        const suffix = options.suffix ?? randomUUID().replaceAll('-', '')
        const ids = {
            baselineRunId: randomUUID(),
            afterRunId: randomUUID(),
            policyId: randomUUID(),
            bindingId: randomUUID(),
        }
        return dataSource.transaction(async manager => {
            const admins = await manager.query<Array<{ id: number }>>(
                `INSERT INTO public.admin (password, email, role, "isVerified")
             VALUES ('fixture', $1, 'admin', true)
             RETURNING id`,
                [`animation-lab-policy-job-${suffix}@example.invalid`]
            )
            const adminId = Number(admins[0]?.id)
            const appId = `policy${suffix.slice(0, 12)}`
            const applications = await manager.query<Array<{ id: number }>>(
                `INSERT INTO public.application ("appId", type, name, "userId", "isDelete")
             VALUES ($1, 'vanilla', $2, $3, false)
             RETURNING id`,
                [appId, `Animation Lab policy job ${suffix}`, adminId]
            )
            const applicationId = Number(applications[0]?.id)
            if (options.failAfterApplication) throw new Error('intentional fixture setup failure')
            await manager.query(
                `INSERT INTO public.animation_lab_run
                (id, "appId", "createdBy", name, "scenarioKey", status, phase, progress, config, summary)
             VALUES
                ($1, $3, $4, 'Baseline', 'policy-job-scenario', 'completed', 'done', 100, '{}', '{}'),
                ($2, $3, $4, 'After', 'policy-job-scenario', 'completed', 'done', 100, '{}', '{}')`,
                [ids.baselineRunId, ids.afterRunId, appId, adminId]
            )
            const policyDigest = digestHex(`policy:${suffix}`)
            await manager.query(
                `INSERT INTO public.animation_lab_project_policy
                (id, "appId", "createdBy", "policyKey", version, name, "metricCatalogVersion", digest, definition)
             VALUES ($1, $2, $3, 'policy-job', 1, 'Policy job', 1, $4, '{}')`,
                [ids.policyId, appId, adminId, policyDigest]
            )
            await manager.query(
                `INSERT INTO public.animation_lab_baseline_binding
                (id, "appId", "createdBy", "bindingKey", version, "scenarioKey", "routeKey", "baselineRunId", "policyId",
                 "comparisonContextDigest", active)
             VALUES ($1, $2, $3, 'policy-job-binding', 1, 'policy-job-scenario', '/', $4, $5, $6, true)`,
                [ids.bindingId, appId, adminId, ids.baselineRunId, ids.policyId, digestHex(`context:${suffix}`)]
            )
            return { adminId, applicationId, appId, policyDigest, ...ids }
        })
    }

    function requiredFixture(): Fixture {
        if (!fixture) throw new Error('Policy job integration fixture is not initialized')
        return fixture
    }

    function digestHex(value: string): string {
        return createHash('sha256').update(value).digest('hex')
    }

    function cleanupStatements(current: Fixture): ReadonlyArray<readonly [string, unknown[]]> {
        return [
            ['DELETE FROM public.animation_lab_policy_evaluation_job WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_baseline_binding WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_project_policy WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_run WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.application WHERE id = $1', [current.applicationId]],
            ['DELETE FROM public.admin WHERE id = $1', [current.adminId]],
        ]
    }
})
