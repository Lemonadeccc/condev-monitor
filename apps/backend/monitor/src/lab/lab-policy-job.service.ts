import { randomUUID } from 'node:crypto'

import { Injectable } from '@nestjs/common'
import { EntityManager } from 'typeorm'

import { LabBaselineBindingEntity } from './entity/lab-baseline-binding.entity'
import { LabProjectPolicyEntity } from './entity/lab-project-policy.entity'
import { LabRunEntity } from './entity/lab-run.entity'

@Injectable()
export class LabPolicyJobService {
    async enqueueForCompletedRun(manager: EntityManager, run: LabRunEntity): Promise<number> {
        const bindings = manager.getRepository(LabBaselineBindingEntity)
        const policies = manager.getRepository(LabProjectPolicyEntity)
        const active = await bindings.find({ where: { appId: run.appId, scenarioKey: run.scenarioKey, active: true } })
        let created = 0
        for (const binding of active) {
            if (binding.baselineRunId === run.id) continue
            const policy = await policies.findOne({ where: { id: binding.policyId, appId: run.appId } })
            if (!policy) continue
            const now = new Date()
            const inserted = (await manager.query(
                `INSERT INTO animation_lab_policy_evaluation_job
                    (id, "appId", "createdBy", "runId", "bindingId", "bindingKey", "policyDigest", state,
                     "attemptCount", "nextAttemptAt", "leaseOwner", "leaseUntil", "lastErrorCode", "createdAt", "updatedAt")
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 0, $8, NULL, NULL, NULL, $8, $8)
                 ON CONFLICT ("bindingId", "runId", "policyDigest") DO NOTHING
                 RETURNING id`,
                [randomUUID(), run.appId, binding.createdBy, run.id, binding.id, binding.bindingKey, policy.digest, now]
            )) as Array<{ id: string }>
            if (inserted.length === 1) created += 1
        }
        return created
    }
}
