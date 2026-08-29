import { randomUUID } from 'node:crypto'

import { Injectable } from '@nestjs/common'
import { EntityManager } from 'typeorm'

import { LabBaselineBindingEntity } from './entity/lab-baseline-binding.entity'
import { LabPolicyEvaluationJobEntity } from './entity/lab-policy-evaluation-job.entity'
import { LabProjectPolicyEntity } from './entity/lab-project-policy.entity'
import { LabRunEntity } from './entity/lab-run.entity'

@Injectable()
export class LabPolicyJobService {
    async enqueueForCompletedRun(manager: EntityManager, run: LabRunEntity): Promise<number> {
        const bindings = manager.getRepository(LabBaselineBindingEntity)
        const policies = manager.getRepository(LabProjectPolicyEntity)
        const jobs = manager.getRepository(LabPolicyEvaluationJobEntity)
        const active = await bindings.find({ where: { appId: run.appId, scenarioKey: run.scenarioKey, active: true } })
        let created = 0
        for (const binding of active) {
            if (binding.baselineRunId === run.id) continue
            const policy = await policies.findOne({ where: { id: binding.policyId, appId: run.appId } })
            if (!policy) continue
            const existing = await jobs.findOne({
                where: { bindingId: binding.id, runId: run.id, policyDigest: policy.digest },
            })
            if (existing) continue
            const now = new Date()
            try {
                await jobs.save(
                    jobs.create({
                        id: randomUUID(),
                        appId: run.appId,
                        createdBy: binding.createdBy,
                        runId: run.id,
                        bindingId: binding.id,
                        bindingKey: binding.bindingKey,
                        policyDigest: policy.digest,
                        state: 'pending',
                        attemptCount: 0,
                        nextAttemptAt: now,
                        leaseOwner: null,
                        leaseUntil: null,
                        lastErrorCode: null,
                        createdAt: now,
                        updatedAt: now,
                    })
                )
                created += 1
            } catch (error) {
                if (!this.isIdentityConflict(error)) throw error
            }
        }
        return created
    }

    private isIdentityConflict(error: unknown): boolean {
        if (!error || typeof error !== 'object') return false
        const nested = 'driverError' in error ? error.driverError : undefined
        return [error, nested].some(candidate => {
            if (!candidate || typeof candidate !== 'object') return false
            const detail = candidate as { code?: unknown; constraint?: unknown }
            return detail.code === '23505' && detail.constraint === 'animation_lab_policy_evaluation_job_identity_unique'
        })
    }
}
