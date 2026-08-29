import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'

import { ApplicationModule } from '../application/application.module'
import { LabAlertEventEntity } from './entity/lab-alert-event.entity'
import { LabAlertStateEntity } from './entity/lab-alert-state.entity'
import { LabArtifactEntity } from './entity/lab-artifact.entity'
import { LabBaselineBindingEntity } from './entity/lab-baseline-binding.entity'
import { LabPolicyEvaluationEntity } from './entity/lab-policy-evaluation.entity'
import { LabPolicyEvaluationJobEntity } from './entity/lab-policy-evaluation-job.entity'
import { LabProjectPolicyEntity } from './entity/lab-project-policy.entity'
import { LabRunEntity } from './entity/lab-run.entity'
import { LabRunnerGrantEntity } from './entity/lab-runner-grant.entity'
import { LabController } from './lab.controller'
import { LabService } from './lab.service'
import { LabPolicyController } from './lab-policy.controller'
import { LabPolicyService } from './lab-policy.service'
import { LabPolicyJobService } from './lab-policy-job.service'
import { LabPolicyWorkerService } from './lab-policy-worker.service'
import { LabRunnerController } from './lab-runner.controller'
import { LabStorageService } from './lab-storage.service'

@Module({
    imports: [
        ApplicationModule,
        TypeOrmModule.forFeature([
            LabRunEntity,
            LabArtifactEntity,
            LabRunnerGrantEntity,
            LabProjectPolicyEntity,
            LabBaselineBindingEntity,
            LabPolicyEvaluationEntity,
            LabPolicyEvaluationJobEntity,
            LabAlertStateEntity,
            LabAlertEventEntity,
        ]),
    ],
    controllers: [LabController, LabRunnerController, LabPolicyController],
    providers: [LabService, LabStorageService, LabPolicyService, LabPolicyJobService, LabPolicyWorkerService],
})
export class LabModule {}
