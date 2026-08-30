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
        const repositories = new Map<unknown, unknown>([
            [LabBaselineBindingEntity, bindings],
            [LabProjectPolicyEntity, policies],
        ])
        const manager = {
            getRepository: jest.fn(entity => repositories.get(entity)),
            query: jest.fn().mockResolvedValue([{ id: '66666666-6666-4666-8666-666666666666' }]),
        }
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
        expect(manager.query).toHaveBeenCalledWith(
            expect.stringContaining('ON CONFLICT ("bindingId", "runId", "policyDigest") DO NOTHING'),
            expect.arrayContaining([
                'app-123',
                7,
                '55555555-5555-4555-8555-555555555555',
                '11111111-1111-4111-8111-111111111111',
                'hero-baseline',
                'a'.repeat(64),
                expect.any(Date),
            ])
        )
    })

    it('treats an existing binding/run/policy identity as an idempotent no-op', async () => {
        const bindings = repository<LabBaselineBindingEntity>()
        const policies = repository<LabProjectPolicyEntity>()
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
        const repositories = new Map<unknown, unknown>([
            [LabBaselineBindingEntity, bindings],
            [LabProjectPolicyEntity, policies],
        ])
        const service = new LabPolicyJobService()
        const query = jest.fn().mockResolvedValue([])

        await expect(
            service.enqueueForCompletedRun(
                { getRepository: jest.fn(entity => repositories.get(entity)), query } as never,
                { id: '55555555-5555-4555-8555-555555555555', appId: 'app-123', scenarioKey: 'hero.hover' } as never
            )
        ).resolves.toBe(0)
        expect(query).toHaveBeenCalledTimes(1)
    })

    it('propagates database failures other than an idempotent conflict', async () => {
        const bindings = repository<LabBaselineBindingEntity>()
        const policies = repository<LabProjectPolicyEntity>()
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
        const repositories = new Map<unknown, unknown>([
            [LabBaselineBindingEntity, bindings],
            [LabProjectPolicyEntity, policies],
        ])
        const failure = new Error('database unavailable')

        await expect(
            new LabPolicyJobService().enqueueForCompletedRun(
                { getRepository: jest.fn(entity => repositories.get(entity)), query: jest.fn().mockRejectedValue(failure) } as never,
                { id: '55555555-5555-4555-8555-555555555555', appId: 'app-123', scenarioKey: 'hero.hover' } as never
            )
        ).rejects.toBe(failure)
    })
})
