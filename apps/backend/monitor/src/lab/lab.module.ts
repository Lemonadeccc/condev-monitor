import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'

import { ApplicationModule } from '../application/application.module'
import { MailModule } from '../common/mail/mail.module'
import { LabAlertAcknowledgementEntity } from './entity/lab-alert-acknowledgement.entity'
import { LabAlertEventEntity } from './entity/lab-alert-event.entity'
import { LabAlertStateEntity } from './entity/lab-alert-state.entity'
import { LabArtifactEntity } from './entity/lab-artifact.entity'
import { LabBaselineBindingEntity } from './entity/lab-baseline-binding.entity'
import { LabNotificationDestinationEntity } from './entity/lab-notification-destination.entity'
import { LabNotificationOutboxEntity } from './entity/lab-notification-outbox.entity'
import { LabPolicyEvaluationEntity } from './entity/lab-policy-evaluation.entity'
import { LabPolicyEvaluationJobEntity } from './entity/lab-policy-evaluation-job.entity'
import { LabProjectPolicyEntity } from './entity/lab-project-policy.entity'
import { LabRunEntity } from './entity/lab-run.entity'
import { LabRunnerGrantEntity } from './entity/lab-runner-grant.entity'
import { LabController } from './lab.controller'
import { LabService } from './lab.service'
import {
    LAB_NOTIFICATION_ENDPOINT_REGISTRY,
    LAB_NOTIFICATION_TRANSPORT,
    LabNotificationService,
    PlatformLabNotificationTransport,
} from './lab-notification.service'
import { FileLabNotificationEndpointRegistry } from './lab-notification-endpoint-registry'
import { SafeLabNotificationHttpClient } from './lab-notification-safe-http'
import { LabNotificationWorkerService } from './lab-notification-worker.service'
import { LabPolicyController } from './lab-policy.controller'
import { LabPolicyService } from './lab-policy.service'
import { LabPolicyJobService } from './lab-policy-job.service'
import { LabPolicyWorkerService } from './lab-policy-worker.service'
import { LabRunnerController } from './lab-runner.controller'
import { LabStorageService } from './lab-storage.service'

@Module({
    imports: [
        ApplicationModule,
        MailModule,
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
            LabAlertAcknowledgementEntity,
            LabNotificationDestinationEntity,
            LabNotificationOutboxEntity,
        ]),
    ],
    controllers: [LabController, LabRunnerController, LabPolicyController],
    providers: [
        LabService,
        LabStorageService,
        LabPolicyService,
        LabPolicyJobService,
        LabPolicyWorkerService,
        LabNotificationService,
        LabNotificationWorkerService,
        SafeLabNotificationHttpClient,
        { provide: LAB_NOTIFICATION_ENDPOINT_REGISTRY, useClass: FileLabNotificationEndpointRegistry },
        { provide: LAB_NOTIFICATION_TRANSPORT, useClass: PlatformLabNotificationTransport },
    ],
})
export class LabModule {}
