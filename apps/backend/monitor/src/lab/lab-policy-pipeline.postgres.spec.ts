import { randomUUID } from 'node:crypto'

import { DataSource } from 'typeorm'

import { LabAlertAcknowledgementEntity } from './entity/lab-alert-acknowledgement.entity'
import { LabAlertEventEntity } from './entity/lab-alert-event.entity'
import { LabAlertStateEntity } from './entity/lab-alert-state.entity'
import { LabBaselineBindingEntity } from './entity/lab-baseline-binding.entity'
import { LabNotificationDestinationEntity } from './entity/lab-notification-destination.entity'
import { LabNotificationOutboxEntity } from './entity/lab-notification-outbox.entity'
import { LabPolicyEvaluationEntity } from './entity/lab-policy-evaluation.entity'
import { LabPolicyEvaluationJobEntity } from './entity/lab-policy-evaluation-job.entity'
import { LabProjectPolicyEntity } from './entity/lab-project-policy.entity'
import { LabRunEntity } from './entity/lab-run.entity'
import type { ComparableAnimationLabResult, LabMetricComparison } from './lab-comparison'
import { LabNotificationService, type LabNotificationTransport } from './lab-notification.service'
import { digestLabProjectPolicyDefinition, type LabProjectPolicyDefinitionV1 } from './lab-policy'
import { LabPolicyService } from './lab-policy.service'
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
    contextDigest: string
}>

describePostgres('Animation Lab policy-to-notification PostgreSQL pipeline', () => {
    jest.setTimeout(30_000)

    let dataSource: DataSource
    let fixture: Fixture | null = null

    beforeAll(async () => {
        const url = assertAnimationLabPostgresWriteAccess({
            suiteName: 'Animation Lab policy pipeline PostgreSQL integration tests',
            url: process.env.TEST_POSTGRES_URL,
            writeSentinel: process.env.TEST_POSTGRES_WRITE_SENTINEL,
            allowRemote: process.env.TEST_POSTGRES_ALLOW_REMOTE,
        })
        dataSource = new DataSource({
            type: 'postgres',
            url,
            synchronize: false,
            entities: [
                LabRunEntity,
                LabProjectPolicyEntity,
                LabBaselineBindingEntity,
                LabPolicyEvaluationEntity,
                LabPolicyEvaluationJobEntity,
                LabAlertStateEntity,
                LabAlertEventEntity,
                LabNotificationDestinationEntity,
                LabNotificationOutboxEntity,
                LabAlertAcknowledgementEntity,
            ],
        })
        await dataSource.initialize()
        const preflight = await dataSource.query<Array<{ ready: boolean }>>(
            `SELECT to_regclass('public.animation_lab_policy_evaluation_job') IS NOT NULL
                AND to_regclass('public.animation_lab_policy_evaluation') IS NOT NULL
                AND to_regclass('public.animation_lab_alert_state') IS NOT NULL
                AND to_regclass('public.animation_lab_alert_event') IS NOT NULL
                AND to_regclass('public.animation_lab_notification_destination') IS NOT NULL
                AND to_regclass('public.animation_lab_notification_outbox') IS NOT NULL AS ready`
        )
        if (preflight.length !== 1 || preflight[0]?.ready !== true) {
            throw new Error('Animation Lab PostgreSQL migrations 009 through 012 are required before pipeline integration writes')
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
        if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Animation Lab policy pipeline cleanup failed')
    })

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy()
    })

    it('persists one evaluation, alert transition, outbox row, and delivery from a completed run job', async () => {
        const current = requiredFixture()
        const applicationService = { assertOwned: jest.fn().mockResolvedValue(undefined) }
        const transport: LabNotificationTransport = {
            deliver: jest.fn().mockResolvedValue({ outcome: 'delivered', code: 'LOCAL_RECORDED' }),
        }
        const notificationService = new LabNotificationService(
            dataSource.getRepository(LabNotificationDestinationEntity),
            dataSource.getRepository(LabNotificationOutboxEntity),
            dataSource.getRepository(LabAlertAcknowledgementEntity),
            dataSource.getRepository(LabAlertEventEntity),
            dataSource,
            applicationService as never,
            transport
        )
        const labService = {
            compareRuns: jest.fn().mockResolvedValue(comparison(current)),
            getComparisonCandidateForPolicy: jest.fn().mockResolvedValue({ contextDigest: current.contextDigest }),
        }
        const policyService = new LabPolicyService(
            dataSource.getRepository(LabProjectPolicyEntity),
            dataSource.getRepository(LabBaselineBindingEntity),
            dataSource.getRepository(LabPolicyEvaluationEntity),
            dataSource.getRepository(LabPolicyEvaluationJobEntity),
            dataSource.getRepository(LabAlertStateEntity),
            dataSource.getRepository(LabAlertEventEntity),
            dataSource,
            applicationService as never,
            labService as never,
            notificationService
        )
        const run = await dataSource.getRepository(LabRunEntity).findOneByOrFail({ id: current.afterRunId, appId: current.appId })
        await expect(dataSource.transaction(manager => new LabPolicyJobService().enqueueForCompletedRun(manager, run))).resolves.toBe(1)

        const worker = new LabPolicyWorkerService(dataSource.getRepository(LabPolicyEvaluationJobEntity), policyService)
        await worker.tick()

        const [jobs, evaluations, states, events, deliveries] = await Promise.all([
            dataSource.getRepository(LabPolicyEvaluationJobEntity).find({ where: { appId: current.appId } }),
            dataSource.getRepository(LabPolicyEvaluationEntity).find({ where: { appId: current.appId } }),
            dataSource.getRepository(LabAlertStateEntity).find({ where: { appId: current.appId } }),
            dataSource.getRepository(LabAlertEventEntity).find({ where: { appId: current.appId } }),
            dataSource.getRepository(LabNotificationOutboxEntity).find({ where: { appId: current.appId } }),
        ])
        expect(jobs).toEqual([expect.objectContaining({ state: 'completed', attemptCount: 0, lastErrorCode: null })])
        expect(evaluations).toEqual([expect.objectContaining({ verdict: 'breach', policyDigest: current.policyDigest })])
        expect(states).toEqual([expect.objectContaining({ status: 'open', severity: 'critical', ruleId: 'frame-regression' })])
        expect(events).toEqual([
            expect.objectContaining({ eventType: 'opened', fromState: 'unknown', toState: 'open', ruleId: 'frame-regression' }),
        ])
        expect(deliveries).toEqual([expect.objectContaining({ state: 'pending', attemptCount: 0, lastResultCode: null })])
        expect(transport.deliver).not.toHaveBeenCalled()

        await expect(notificationService.processPendingForApp(current.appId, 1)).resolves.toEqual({ processed: 1 })
        const delivered = await dataSource.getRepository(LabNotificationOutboxEntity).findOneByOrFail({ appId: current.appId })
        expect(delivered).toMatchObject({ state: 'delivered', attemptCount: 1, lastResultCode: 'LOCAL_RECORDED' })
        expect(transport.deliver).toHaveBeenCalledTimes(1)
        expect(applicationService.assertOwned).toHaveBeenCalledWith(current.appId, current.adminId)
        expect(labService.compareRuns).toHaveBeenCalledTimes(1)
    })

    async function createFixture(): Promise<Fixture> {
        const suffix = randomUUID().replaceAll('-', '')
        const ids = {
            baselineRunId: randomUUID(),
            afterRunId: randomUUID(),
            policyId: randomUUID(),
            bindingId: randomUUID(),
            destinationId: randomUUID(),
        }
        const definition = policyDefinition()
        const policyDigest = digestLabProjectPolicyDefinition(definition)
        const contextDigest = 'c'.repeat(64)
        return dataSource.transaction(async manager => {
            const admins = await manager.query<Array<{ id: number }>>(
                `INSERT INTO public.admin (password, email, role, "isVerified")
                 VALUES ('fixture', $1, 'admin', true)
                 RETURNING id`,
                [`animation-lab-policy-pipeline-${suffix}@example.invalid`]
            )
            const adminId = Number(admins[0]?.id)
            const appId = `pipeline${suffix.slice(0, 12)}`
            const applications = await manager.query<Array<{ id: number }>>(
                `INSERT INTO public.application ("appId", type, name, "userId", "isDelete")
                 VALUES ($1, 'vanilla', $2, $3, false)
                 RETURNING id`,
                [appId, `Animation Lab policy pipeline ${suffix}`, adminId]
            )
            const applicationId = Number(applications[0]?.id)
            await manager.query(
                `INSERT INTO public.animation_lab_run
                    (id, "appId", "createdBy", name, "scenarioKey", status, phase, progress, config, summary)
                 VALUES
                    ($1, $3, $4, 'Baseline', 'policy-pipeline-scenario', 'completed', 'done', 100, '{}', '{}'),
                    ($2, $3, $4, 'After', 'policy-pipeline-scenario', 'completed', 'done', 100, '{}', '{}')`,
                [ids.baselineRunId, ids.afterRunId, appId, adminId]
            )
            await manager.query(
                `INSERT INTO public.animation_lab_project_policy
                    (id, "appId", "createdBy", "policyKey", version, name, "metricCatalogVersion", digest, definition)
                 VALUES ($1, $2, $3, 'policy-pipeline', 1, 'Policy pipeline', 5, $4, $5)`,
                [ids.policyId, appId, adminId, policyDigest, JSON.stringify(definition)]
            )
            await manager.query(
                `INSERT INTO public.animation_lab_baseline_binding
                    (id, "appId", "createdBy", "bindingKey", version, "scenarioKey", "routeKey", "baselineRunId", "policyId",
                     "comparisonContextDigest", active)
                 VALUES ($1, $2, $3, 'policy-pipeline-binding', 1, 'policy-pipeline-scenario', '/', $4, $5, $6, true)`,
                [ids.bindingId, appId, adminId, ids.baselineRunId, ids.policyId, contextDigest]
            )
            await manager.query(
                `INSERT INTO public.animation_lab_notification_destination
                    (id, "appId", "createdBy", "destinationKey", kind, enabled, "cooldownSeconds", "maxAttempts", "registryRevision")
                 VALUES ($1, $2, $3, 'local-primary', 'local', true, 900, 3, NULL)`,
                [ids.destinationId, appId, adminId]
            )
            return { adminId, applicationId, appId, policyDigest, contextDigest, ...ids }
        })
    }

    function policyDefinition(): LabProjectPolicyDefinitionV1 {
        return {
            schemaVersion: 1,
            metricCatalogVersion: 5,
            absoluteRules: [],
            comparisonRules: [
                {
                    ruleId: 'frame-regression',
                    metricId: 'frame.duration.p95',
                    scope: { level: 'run' },
                    operand: 'percent-change',
                    comparator: '<=',
                    target: { value: 10, unit: 'percent' },
                    minimumAttemptsPerSide: 3,
                    minimumUnderlyingSamples: 120,
                    severity: 'critical',
                },
            ],
        }
    }

    function comparison(current: Fixture): ComparableAnimationLabResult {
        const distribution = (median: number) => ({
            n: 3,
            min: median - 1,
            median,
            p75: median + 0.5,
            p95: median + 1,
            max: median + 1,
            underlyingSamples: { knownAttempts: 3, total: 540, min: 180, max: 180 },
        })
        const metric: LabMetricComparison = {
            metricId: 'frame.duration.p95',
            family: 'frameCadence',
            name: 'frameDurationMs',
            stat: 'p95',
            unit: 'ms',
            scope: { level: 'run' },
            sourceAggregation: { population: 'frames', method: 'nearest-rank' },
            comparisonAggregation: { population: 'measured-attempts', method: 'median' },
            budgetRefs: [],
            evidenceRefs: ['page-probe'],
            evidenceLevel: 'controlled-lab-measurement',
            evidenceStatus: 'measured',
            before: distribution(20),
            after: distribution(24),
            delta: 4,
            percentChange: 20,
            direction: 'increase',
        }
        return {
            schemaVersion: 1,
            kind: 'animation-lab-before-after',
            comparable: true,
            trust: 'caller-attested',
            beforeRunId: current.baselineRunId,
            afterRunId: current.afterRunId,
            scenarioKey: 'policy-pipeline-scenario',
            routeKey: '/',
            conditions: {} as never,
            caveats: ['attempt-distribution-is-descriptive', 'no-statistical-significance-inference'],
            coverage: {
                beforeAttempts: 3,
                afterAttempts: 3,
                candidateMetricTuples: 1,
                comparedMetrics: 1,
                excludedMetrics: 0,
                retainedExcludedMetrics: 0,
                droppedExcludedMetrics: 0,
            },
            metrics: [metric],
            excluded: [],
        }
    }

    function requiredFixture(): Fixture {
        if (!fixture) throw new Error('Policy pipeline integration fixture is not initialized')
        return fixture
    }

    function cleanupStatements(current: Fixture): ReadonlyArray<readonly [string, unknown[]]> {
        return [
            ['UPDATE public.animation_lab_alert_state SET "transitionEventId" = NULL WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_alert_acknowledgement WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_notification_outbox WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_notification_destination WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_alert_event WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_alert_state WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_policy_evaluation_job WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_policy_evaluation WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_baseline_binding WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_project_policy WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_run WHERE "appId" = $1', [current.appId]],
            [
                'DELETE FROM public.application WHERE id = $1 AND "appId" = $2 AND "userId" = $3',
                [current.applicationId, current.appId, current.adminId],
            ],
            [
                'DELETE FROM public.admin WHERE id = $1 AND email LIKE $2',
                [current.adminId, 'animation-lab-policy-pipeline-%@example.invalid'],
            ],
        ]
    }
})
