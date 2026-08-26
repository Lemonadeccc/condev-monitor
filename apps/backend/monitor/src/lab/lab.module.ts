import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'

import { ApplicationModule } from '../application/application.module'
import { LabArtifactEntity } from './entity/lab-artifact.entity'
import { LabRunEntity } from './entity/lab-run.entity'
import { LabRunnerGrantEntity } from './entity/lab-runner-grant.entity'
import { LabController } from './lab.controller'
import { LabService } from './lab.service'
import { LabRunnerController } from './lab-runner.controller'
import { LabStorageService } from './lab-storage.service'

@Module({
    imports: [ApplicationModule, TypeOrmModule.forFeature([LabRunEntity, LabArtifactEntity, LabRunnerGrantEntity])],
    controllers: [LabController, LabRunnerController],
    providers: [LabService, LabStorageService],
})
export class LabModule {}
