import { getMetadataArgsStorage } from 'typeorm'

import { LabBaselineBindingEntity } from './entity/lab-baseline-binding.entity'
import { LabPolicyEvaluationJobEntity } from './entity/lab-policy-evaluation-job.entity'
import { LabProjectPolicyEntity } from './entity/lab-project-policy.entity'
import { LabPolicyJobService } from './lab-policy-job.service'

function repository<T>() {
    return {
        create: jest.fn((value: T) => value),
        save: jest.fn(async (value: T) => value),
        findOne: jest.fn(),
        find: jest.fn(),
    }
}

describe('LabPolicyJobService', () => {
    it('keeps migration-owned partial index predicates in TypeORM metadata', () => {
        const indices = getMetadataArgsStorage().indices
        const activeBinding = indices.find(
            index => index.target === LabBaselineBindingEntity && index.name === 'animation_lab_baseline_binding_app_key_active_unique'
        )
        const dueJob = indices.find(
            index => index.target === LabPolicyEvaluationJobEntity && index.name === 'animation_lab_policy_evaluation_job_due_idx'
        )

        expect(activeBinding).toMatchObject({ unique: true, where: '"active" = true' })
        expect(dueJob).toMatchObject({ where: '"state" = \'pending\'' })
    })

    it('enqueues one idempotent policy evaluation job per matching active binding', async () => {
        const bindings = repository<LabBaselineBindingEntity>()
        const policies = repository<LabProjectPolicyEntity>()
        const jobs = repository<LabPolicyEvaluationJobEntity>()
        bindings.find.mockResolvedValue([
            {
                id: '11111111-1111-4111-8111-111111111111',
                appId: 'app-123',
                createdBy: 7,
                bindingKey: 'hero-baseline',
                baselineRunId: '22222222-2222-4222-8222-222222222222',
                policyId: '33333333-3333-4333-8333-333333333333',
            },
            {
                id: '44444444-4444-4444-8444-444444444444',
                appId: 'app-123',
                createdBy: 7,
                bindingKey: 'self-baseline',
                baselineRunId: '55555555-5555-4555-8555-555555555555',
                policyId: '33333333-3333-4333-8333-333333333333',
            },
        ])
        policies.findOne.mockResolvedValue({ id: '33333333-3333-4333-8333-333333333333', digest: 'a'.repeat(64) })
        jobs.findOne.mockResolvedValue(null)
        const repositories = new Map<unknown, unknown>([
            [LabBaselineBindingEntity, bindings],
            [LabProjectPolicyEntity, policies],
            [LabPolicyEvaluationJobEntity, jobs],
        ])
        const manager = { getRepository: jest.fn(entity => repositories.get(entity)) }
        const service = new LabPolicyJobService()

        const created = await service.enqueueForCompletedRun(
            manager as never,
            {
                id: '55555555-5555-4555-8555-555555555555',
                appId: 'app-123',
                scenarioKey: 'hero.hover',
            } as never
        )

        expect(created).toBe(1)
        expect(bindings.find).toHaveBeenCalledWith({ where: { appId: 'app-123', scenarioKey: 'hero.hover', active: true } })
        expect(jobs.save).toHaveBeenCalledWith(
            expect.objectContaining({
                appId: 'app-123',
                bindingKey: 'hero-baseline',
                runId: '55555555-5555-4555-8555-555555555555',
                state: 'pending',
                attemptCount: 0,
            })
        )
    })

    it('does not enqueue an already persisted binding/run/policy identity', async () => {
        const bindings = repository<LabBaselineBindingEntity>()
        const policies = repository<LabProjectPolicyEntity>()
        const jobs = repository<LabPolicyEvaluationJobEntity>()
        bindings.find.mockResolvedValue([
            {
                id: '11111111-1111-4111-8111-111111111111',
                appId: 'app-123',
                createdBy: 7,
                bindingKey: 'hero-baseline',
                baselineRunId: '22222222-2222-4222-8222-222222222222',
                policyId: '33333333-3333-4333-8333-333333333333',
            },
        ])
        policies.findOne.mockResolvedValue({ id: '33333333-3333-4333-8333-333333333333', digest: 'a'.repeat(64) })
        jobs.findOne.mockResolvedValue({ id: 'existing-job' })
        const repositories = new Map<unknown, unknown>([
            [LabBaselineBindingEntity, bindings],
            [LabProjectPolicyEntity, policies],
            [LabPolicyEvaluationJobEntity, jobs],
        ])
        const service = new LabPolicyJobService()

        await expect(
            service.enqueueForCompletedRun(
                { getRepository: jest.fn(entity => repositories.get(entity)) } as never,
                { id: '55555555-5555-4555-8555-555555555555', appId: 'app-123', scenarioKey: 'hero.hover' } as never
            )
        ).resolves.toBe(0)
        expect(jobs.save).not.toHaveBeenCalled()
    })

    it('treats a concurrent job identity insert as idempotent', async () => {
        const bindings = repository<LabBaselineBindingEntity>()
        const policies = repository<LabProjectPolicyEntity>()
        const jobs = repository<LabPolicyEvaluationJobEntity>()
        bindings.find.mockResolvedValue([
            {
                id: '11111111-1111-4111-8111-111111111111',
                appId: 'app-123',
                createdBy: 7,
                bindingKey: 'hero-baseline',
                baselineRunId: '22222222-2222-4222-8222-222222222222',
                policyId: '33333333-3333-4333-8333-333333333333',
            },
        ])
        policies.findOne.mockResolvedValue({ id: '33333333-3333-4333-8333-333333333333', digest: 'a'.repeat(64) })
        jobs.findOne.mockResolvedValue(null)
        jobs.save.mockRejectedValue({
            driverError: { code: '23505', constraint: 'animation_lab_policy_evaluation_job_identity_unique' },
        })
        const repositories = new Map<unknown, unknown>([
            [LabBaselineBindingEntity, bindings],
            [LabProjectPolicyEntity, policies],
            [LabPolicyEvaluationJobEntity, jobs],
        ])

        await expect(
            new LabPolicyJobService().enqueueForCompletedRun(
                { getRepository: jest.fn(entity => repositories.get(entity)) } as never,
                { id: '55555555-5555-4555-8555-555555555555', appId: 'app-123', scenarioKey: 'hero.hover' } as never
            )
        ).resolves.toBe(0)
    })
})
