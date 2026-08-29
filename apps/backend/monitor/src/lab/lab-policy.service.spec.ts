import { ConflictException } from '@nestjs/common'

import { LabAlertEventEntity } from './entity/lab-alert-event.entity'
import { LabAlertStateEntity } from './entity/lab-alert-state.entity'
import { LabBaselineBindingEntity } from './entity/lab-baseline-binding.entity'
import { LabPolicyEvaluationEntity } from './entity/lab-policy-evaluation.entity'
import { LabProjectPolicyEntity } from './entity/lab-project-policy.entity'
import { digestLabProjectPolicyDefinition, type LabProjectComparisonEvaluationV1 } from './lab-policy'
import { LabPolicyService } from './lab-policy.service'

function repository<T>() {
    return {
        create: jest.fn((value: T) => value),
        save: jest.fn(async (value: T) => value),
        findOne: jest.fn(),
        find: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
    }
}

function definition() {
    return {
        schemaVersion: 1 as const,
        metricCatalogVersion: 5 as const,
        absoluteRules: [],
        comparisonRules: [
            {
                ruleId: 'frame-regression',
                metricId: 'frame.duration.p95',
                scope: { level: 'run' as const },
                operand: 'percent-change' as const,
                comparator: '<=' as const,
                target: { value: 10, unit: 'percent' as const },
                minimumAttemptsPerSide: 3,
                minimumUnderlyingSamples: 120,
                severity: 'critical' as const,
            },
        ],
    }
}

function harness() {
    const policies = repository<LabProjectPolicyEntity>()
    const bindings = repository<LabBaselineBindingEntity>()
    const evaluations = repository<LabPolicyEvaluationEntity>()
    const jobs = repository<never>()
    const states = repository<LabAlertStateEntity>()
    const events = repository<LabAlertEventEntity>()
    const applications = { assertOwned: jest.fn().mockResolvedValue(undefined) }
    const labs = { getComparisonCandidateForPolicy: jest.fn(), compareRuns: jest.fn(), getRun: jest.fn() }
    const transactionManager = {
        query: jest.fn().mockResolvedValue([]),
        getRepository: jest.fn(entity => (entity === LabProjectPolicyEntity ? policies : repository<never>())),
    }
    const dataSource = { transaction: jest.fn(async callback => callback(transactionManager)) }
    const service = new LabPolicyService(
        policies as never,
        bindings as never,
        evaluations as never,
        jobs as never,
        states as never,
        events as never,
        dataSource as never,
        applications as never,
        labs as never
    )
    return { service, policies, bindings, evaluations, jobs, states, events, applications, labs, dataSource, transactionManager }
}

function comparisonResult(status: 'breach' | 'within-policy' | 'indeterminate'): LabProjectComparisonEvaluationV1 {
    return {
        schemaVersion: 1,
        kind: 'animation-lab-deterministic-policy-evaluation',
        policyRef: { policyKey: 'animation-release', version: 1, digest: 'a'.repeat(64) },
        beforeRunId: '11111111-1111-4111-8111-111111111111',
        afterRunId: '22222222-2222-4222-8222-222222222222',
        verdict: status === 'breach' ? 'breach' : status === 'within-policy' ? 'within-policy' : 'indeterminate',
        coverage: {
            totalRules: 1,
            evaluatedRules: status === 'indeterminate' ? 0 : 1,
            breachedRules: status === 'breach' ? 1 : 0,
            indeterminateRules: status === 'indeterminate' ? 1 : 0,
        },
        rules: [
            {
                ruleId: 'frame-regression',
                metricId: 'frame.duration.p95',
                severity: 'critical',
                status,
                reasonCodes: status === 'indeterminate' ? ['metric-missing-or-excluded'] : [],
                observed: {
                    scope: { level: 'run' },
                    beforeMedian: status === 'indeterminate' ? null : 20,
                    afterMedian: status === 'indeterminate' ? null : 24,
                    signedDelta: status === 'indeterminate' ? null : 4,
                    percentChange: status === 'indeterminate' ? null : 20,
                    attemptsBefore: status === 'indeterminate' ? 0 : 3,
                    attemptsAfter: status === 'indeterminate' ? 0 : 3,
                    minimumUnderlyingSamples: status === 'indeterminate' ? null : 180,
                },
                decision: { operand: 'percent-change', comparator: '<=', target: { value: 10, unit: 'percent' } },
            },
        ],
        caveats: [
            'project-policy-is-not-measurement-evidence',
            'attempt-distribution-is-descriptive',
            'no-statistical-significance-inference',
        ],
    }
}

describe('LabPolicyService', () => {
    it('creates immutable first policy versions and keeps ownership at the application boundary', async () => {
        const { service, policies, applications } = harness()
        policies.findOne.mockResolvedValue(null)

        const result = await service.createPolicy(7, {
            appId: 'app-123',
            policyKey: 'animation-release',
            name: 'Animation release gate',
            definition: definition(),
        })

        expect(applications.assertOwned).toHaveBeenCalledWith('app-123', 7)
        expect(policies.save).toHaveBeenCalledTimes(1)
        expect(result).toMatchObject({
            appId: 'app-123',
            policyKey: 'animation-release',
            version: 1,
            metricCatalogVersion: 5,
        })
        expect(result.digest).toMatch(/^[a-f0-9]{64}$/)
    })

    it('rejects an in-place policy replacement', async () => {
        const { service, policies } = harness()
        policies.findOne.mockResolvedValue({ id: 'policy-1' })

        await expect(
            service.createPolicy(7, {
                appId: 'app-123',
                policyKey: 'animation-release',
                name: 'Animation release gate',
                definition: definition(),
            })
        ).rejects.toBeInstanceOf(ConflictException)
        expect(policies.save).not.toHaveBeenCalled()
    })

    it('maps a concurrent immutable policy version insert to an explicit conflict', async () => {
        const { service, policies } = harness()
        policies.findOne.mockResolvedValue(null)
        policies.save.mockRejectedValue({
            driverError: { code: '23505', constraint: 'animation_lab_project_policy_app_key_version_unique' },
        })

        await expect(
            service.createPolicy(7, {
                appId: 'app-123',
                policyKey: 'animation-release',
                name: 'Animation release gate',
                definition: definition(),
            })
        ).rejects.toMatchObject({ status: 409 })
    })

    it('bounds stored project policy versions per application', async () => {
        const { service, policies, transactionManager } = harness()
        policies.findOne.mockResolvedValue(null)
        policies.count.mockResolvedValue(1_000)

        await expect(
            service.createPolicy(7, {
                appId: 'app-123',
                policyKey: 'animation-release',
                name: 'Animation release gate',
                definition: definition(),
            })
        ).rejects.toMatchObject({ status: 409 })
        expect(transactionManager.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
            'condev.animation-lab.policy:app-123',
        ])
        expect(transactionManager.query.mock.invocationCallOrder[0]).toBeLessThan(policies.count.mock.invocationCallOrder[0] ?? Infinity)
        expect(policies.save).not.toHaveBeenCalled()
    })

    it('pages baseline bindings and can restrict the result to active snapshots', async () => {
        const { service, bindings, applications } = harness()
        bindings.find.mockResolvedValue([])

        await expect(service.listBaselineBindings(7, 'app-123', { page: 2, pageSize: 25 }, true)).resolves.toEqual({
            bindings: [],
            page: 2,
            pageSize: 25,
        })
        expect(applications.assertOwned).toHaveBeenCalledWith('app-123', 7)
        expect(bindings.find).toHaveBeenCalledWith({
            where: { appId: 'app-123', active: true },
            order: { bindingKey: 'ASC', version: 'DESC' },
            skip: 25,
            take: 25,
        })
    })

    it('opens, preserves, and resolves alert state only from definite policy outcomes', async () => {
        const { service } = harness()
        let storedState: LabAlertStateEntity | null = null
        const savedEvents: LabAlertEventEntity[] = []
        const states = {
            create: jest.fn(value => value),
            findOne: jest.fn(async () => storedState),
            save: jest.fn(async value => {
                storedState = value
                return value
            }),
        }
        const events = {
            create: jest.fn(value => value),
            save: jest.fn(async value => {
                savedEvents.push(value)
                return value
            }),
        }
        const manager = {
            getRepository: jest.fn(entity => (entity === LabAlertStateEntity ? states : entity === LabAlertEventEntity ? events : null)),
        }
        const binding = {
            id: '33333333-3333-4333-8333-333333333333',
            appId: 'app-123',
            bindingKey: 'hero-baseline',
        } as LabBaselineBindingEntity
        const evaluation = {
            id: '44444444-4444-4444-8444-444444444444',
        } as LabPolicyEvaluationEntity
        const transitions = service as unknown as {
            applyAlertTransitions(
                manager: unknown,
                binding: LabBaselineBindingEntity,
                evaluation: LabPolicyEvaluationEntity,
                result: LabProjectComparisonEvaluationV1
            ): Promise<void>
        }

        await transitions.applyAlertTransitions(manager, binding, evaluation, comparisonResult('breach'))
        expect(storedState).toMatchObject({ status: 'open', severity: 'critical' })
        expect(savedEvents).toHaveLength(1)
        expect(savedEvents[0]).toMatchObject({ eventType: 'opened', fromState: 'unknown', toState: 'open' })

        await transitions.applyAlertTransitions(manager, binding, evaluation, comparisonResult('indeterminate'))
        expect(storedState).toMatchObject({ status: 'open' })
        expect(savedEvents).toHaveLength(1)

        await transitions.applyAlertTransitions(manager, binding, evaluation, comparisonResult('within-policy'))
        expect(storedState).toMatchObject({ status: 'healthy' })
        expect(savedEvents).toHaveLength(2)
        expect(savedEvents[1]).toMatchObject({ eventType: 'resolved', fromState: 'open', toState: 'healthy' })
    })

    it('keeps superseded alert state terminal even if a stale evaluation arrives', async () => {
        const { service } = harness()
        const state = { status: 'superseded', ruleId: 'frame-regression' } as LabAlertStateEntity
        const states = { findOne: jest.fn().mockResolvedValue(state), create: jest.fn(), save: jest.fn() }
        const events = { create: jest.fn(), save: jest.fn() }
        const manager = {
            getRepository: jest.fn(entity => (entity === LabAlertStateEntity ? states : entity === LabAlertEventEntity ? events : null)),
        }
        const transitions = service as unknown as {
            applyAlertTransitions(
                manager: unknown,
                binding: LabBaselineBindingEntity,
                evaluation: LabPolicyEvaluationEntity,
                result: LabProjectComparisonEvaluationV1
            ): Promise<void>
        }

        await transitions.applyAlertTransitions(
            manager,
            { id: '33333333-3333-4333-8333-333333333333', appId: 'app-123', bindingKey: 'hero' } as LabBaselineBindingEntity,
            { id: '44444444-4444-4444-8444-444444444444' } as LabPolicyEvaluationEntity,
            comparisonResult('breach')
        )

        expect(states.save).not.toHaveBeenCalled()
        expect(events.save).not.toHaveBeenCalled()
    })

    it('skips an inactive worker snapshot without resolving the current active binding key', async () => {
        const { service, bindings, policies, labs } = harness()
        bindings.findOne.mockResolvedValue({
            id: '33333333-3333-4333-8333-333333333333',
            appId: 'app-123',
            bindingKey: 'hero',
            policyId: '55555555-5555-4555-8555-555555555555',
            active: false,
        })

        await expect(
            service.createEvaluationForSnapshot(7, {
                appId: 'app-123',
                bindingId: '33333333-3333-4333-8333-333333333333',
                policyDigest: 'a'.repeat(64),
                afterRunId: '22222222-2222-4222-8222-222222222222',
            })
        ).resolves.toEqual({ skipped: true, reason: 'binding-inactive' })
        expect(bindings.findOne).toHaveBeenCalledWith({
            where: { id: '33333333-3333-4333-8333-333333333333', appId: 'app-123' },
        })
        expect(policies.findOne).not.toHaveBeenCalled()
        expect(labs.compareRuns).not.toHaveBeenCalled()
    })

    it('lists only bounded, ownership-checked job metadata with closed error codes', async () => {
        const { service, jobs, applications } = harness()
        jobs.find.mockResolvedValue([
            {
                id: 'job-1',
                runId: 'run-1',
                bindingKey: 'hero',
                state: 'quarantined',
                attemptCount: 5,
                lastErrorCode: 'EVALUATION_FAILED',
                createdAt: new Date('2026-08-29T00:00:00.000Z'),
                updatedAt: new Date('2026-08-29T00:01:00.000Z'),
            },
        ])

        await expect(service.listEvaluationJobs(7, 'app-123')).resolves.toEqual({
            jobs: [expect.objectContaining({ jobId: 'job-1', state: 'quarantined', lastErrorCode: 'EVALUATION_FAILED' })],
        })
        expect(applications.assertOwned).toHaveBeenCalledWith('app-123', 7)
        expect(jobs.find).toHaveBeenCalledWith({ where: { appId: 'app-123' }, order: { createdAt: 'DESC' }, take: 100 })
    })

    it('returns an existing evaluation before re-running comparison or creating duplicate events', async () => {
        const { service, bindings, policies, evaluations, labs } = harness()
        bindings.findOne.mockResolvedValue({
            id: '33333333-3333-4333-8333-333333333333',
            appId: 'app-123',
            bindingKey: 'hero-baseline',
            active: true,
            baselineRunId: '11111111-1111-4111-8111-111111111111',
            policyId: '55555555-5555-4555-8555-555555555555',
        })
        policies.findOne.mockResolvedValue({ id: '55555555-5555-4555-8555-555555555555', digest: 'a'.repeat(64) })
        evaluations.findOne.mockResolvedValue({
            id: '44444444-4444-4444-8444-444444444444',
            appId: 'app-123',
            bindingId: '33333333-3333-4333-8333-333333333333',
            policyId: '55555555-5555-4555-8555-555555555555',
            beforeRunId: '11111111-1111-4111-8111-111111111111',
            afterRunId: '22222222-2222-4222-8222-222222222222',
            policyDigest: 'a'.repeat(64),
            verdict: 'breach',
            result: JSON.stringify(comparisonResult('breach')),
            createdAt: new Date('2026-08-29T00:00:00.000Z'),
        })

        const result = await service.createEvaluation(7, {
            appId: 'app-123',
            bindingKey: 'hero-baseline',
            afterRunId: '22222222-2222-4222-8222-222222222222',
        })

        expect(result).toMatchObject({ evaluationId: '44444444-4444-4444-8444-444444444444', verdict: 'breach' })
        expect(labs.compareRuns).not.toHaveBeenCalled()
    })

    it('locks and revalidates the exact active binding before persisting an evaluation', async () => {
        const { service, bindings, policies, evaluations, labs, dataSource } = harness()
        const storedDefinition = definition()
        const policy = {
            id: '55555555-5555-4555-8555-555555555555',
            appId: 'app-123',
            policyKey: 'animation-release',
            version: 1,
            metricCatalogVersion: 5,
            digest: '',
            definition: '',
        } as LabProjectPolicyEntity
        policy.digest = digestLabProjectPolicyDefinition(storedDefinition)
        policy.definition = JSON.stringify(storedDefinition)
        const binding = {
            id: '33333333-3333-4333-8333-333333333333',
            appId: 'app-123',
            bindingKey: 'hero',
            active: true,
            baselineRunId: '11111111-1111-4111-8111-111111111111',
            policyId: policy.id,
            comparisonContextDigest: 'b'.repeat(64),
        } as LabBaselineBindingEntity
        bindings.findOne.mockResolvedValue(binding)
        policies.findOne.mockResolvedValue(policy)
        evaluations.findOne.mockResolvedValue(null)
        labs.compareRuns.mockResolvedValue({ comparable: false, reasons: [] })
        const transactionBindings = repository<LabBaselineBindingEntity>()
        transactionBindings.findOne.mockResolvedValue(binding)
        const transactionEvaluations = repository<LabPolicyEvaluationEntity>()
        transactionEvaluations.findOne.mockResolvedValue(null)
        const transactionStates = repository<LabAlertStateEntity>()
        transactionStates.findOne.mockResolvedValue(null)
        const transactionEvents = repository<LabAlertEventEntity>()
        dataSource.transaction.mockImplementation(async callback =>
            callback({
                getRepository: jest.fn(entity => {
                    if (entity === LabBaselineBindingEntity) return transactionBindings
                    if (entity === LabPolicyEvaluationEntity) return transactionEvaluations
                    if (entity === LabAlertStateEntity) return transactionStates
                    if (entity === LabAlertEventEntity) return transactionEvents
                    return repository<never>()
                }),
            })
        )

        await service.createEvaluation(7, {
            appId: 'app-123',
            bindingKey: 'hero',
            afterRunId: '22222222-2222-4222-8222-222222222222',
        })

        expect(transactionBindings.findOne).toHaveBeenCalledWith({
            where: { id: binding.id, appId: 'app-123' },
            lock: { mode: 'pessimistic_write' },
        })
        expect(transactionEvaluations.save).toHaveBeenCalledTimes(1)
    })
})
