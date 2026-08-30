import type { LabPolicyEvaluationJobEntity } from './entity/lab-policy-evaluation-job.entity'
import { LabPolicyWorkerService } from './lab-policy-worker.service'

function job(overrides: Partial<LabPolicyEvaluationJobEntity> = {}): LabPolicyEvaluationJobEntity {
    const now = new Date('2026-08-29T00:00:00.000Z')
    return {
        id: '11111111-1111-4111-8111-111111111111',
        appId: 'app-123',
        createdBy: 7,
        runId: '22222222-2222-4222-8222-222222222222',
        bindingId: '33333333-3333-4333-8333-333333333333',
        bindingKey: 'hero-baseline',
        policyDigest: 'a'.repeat(64),
        state: 'pending',
        attemptCount: 0,
        nextAttemptAt: now,
        leaseOwner: null,
        leaseUntil: null,
        lastErrorCode: null,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    }
}

function harness(evaluation: jest.Mock) {
    const set = jest.fn()
    const execute = jest.fn().mockResolvedValue({ affected: 1 })
    const builder = {
        update: jest.fn().mockReturnThis(),
        set: set.mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute,
    }
    const jobs = { findOne: jest.fn().mockResolvedValue(job()), createQueryBuilder: jest.fn(() => builder) }
    const service = new LabPolicyWorkerService(jobs as never, { createEvaluationForSnapshot: evaluation } as never)
    return { service, jobs, builder, set, execute }
}

describe('LabPolicyWorkerService', () => {
    it('claims a due job, evaluates it, and marks it completed under the same lease', async () => {
        const createEvaluation = jest.fn().mockResolvedValue({ evaluationId: 'evaluation-1' })
        const { service, set } = harness(createEvaluation)

        await service.tick()

        expect(createEvaluation).toHaveBeenCalledWith(7, {
            appId: 'app-123',
            bindingId: '33333333-3333-4333-8333-333333333333',
            policyDigest: 'a'.repeat(64),
            afterRunId: '22222222-2222-4222-8222-222222222222',
        })
        expect(set).toHaveBeenLastCalledWith(
            expect.objectContaining({ state: 'completed', leaseOwner: null, leaseUntil: null, lastErrorCode: null })
        )
    })

    it('retries transient failures and quarantines after the bounded fifth attempt', async () => {
        const createEvaluation = jest.fn().mockRejectedValue(new Error('temporary'))
        const first = harness(createEvaluation)
        await first.service.tick()
        expect(first.set).toHaveBeenLastCalledWith(
            expect.objectContaining({ state: 'pending', attemptCount: 1, lastErrorCode: 'EVALUATION_FAILED', leaseOwner: null })
        )

        const fifth = harness(createEvaluation)
        fifth.jobs.findOne.mockResolvedValue(job({ attemptCount: 4 }))
        await fifth.service.tick()
        expect(fifth.set).toHaveBeenLastCalledWith(
            expect.objectContaining({ state: 'quarantined', attemptCount: 5, lastErrorCode: 'EVALUATION_FAILED', leaseOwner: null })
        )
    })

    it('completes stale snapshots with an observable closed reason code', async () => {
        const createEvaluation = jest.fn().mockResolvedValue({ skipped: true, reason: 'binding-inactive' })
        const { service, set } = harness(createEvaluation)

        await service.tick()

        expect(set).toHaveBeenLastCalledWith(
            expect.objectContaining({ state: 'completed', lastErrorCode: 'BINDING_INACTIVE', leaseOwner: null })
        )
    })

    it('does not run overlapping ticks or evaluate when no job is due', async () => {
        let release!: () => void
        const createEvaluation = jest.fn().mockImplementation(() => new Promise<void>(resolve => (release = resolve)))
        const { service } = harness(createEvaluation)
        const first = service.tick()
        await new Promise(resolve => setImmediate(resolve))
        await service.tick()
        release()
        await first
        expect(createEvaluation).toHaveBeenCalledTimes(1)

        const empty = harness(jest.fn())
        empty.jobs.findOne.mockResolvedValue(null)
        await empty.service.tick()
        expect(empty.set).not.toHaveBeenCalled()
    })

    it.each([
        ['complete', jest.fn().mockResolvedValue({ evaluationId: 'evaluation-1' }), 'LEASE_LOST_BEFORE_COMPLETE'],
        ['retry', jest.fn().mockRejectedValue(new Error('temporary')), 'LEASE_LOST_BEFORE_RETRY'],
    ] as const)('reports a lost lease before %s without claiming a successful finalization', async (_phase, createEvaluation, code) => {
        const { service, execute } = harness(createEvaluation)
        execute.mockResolvedValueOnce({ affected: 1 }).mockResolvedValueOnce({ affected: 0 })
        const logger = jest.spyOn((service as never as { logger: { error(value: unknown): void } }).logger, 'error').mockImplementation()

        await service.tick()

        expect(logger).toHaveBeenCalledWith({
            event: 'animation_lab_policy_job_lease_failed',
            code,
            jobId: '11111111-1111-4111-8111-111111111111',
            appId: 'app-123',
            bindingId: '33333333-3333-4333-8333-333333333333',
            runId: '22222222-2222-4222-8222-222222222222',
        })
        logger.mockRestore()
    })
})
