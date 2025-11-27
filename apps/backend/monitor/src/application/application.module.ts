import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'

import { ApplicationController } from './application.controller'
import { ApplicationService } from './application.service'
import { ApplicationEntity } from './entity/application.entity'

@Module({
    controllers: [ApplicationController],
    providers: [ApplicationService],
    imports: [TypeOrmModule.forFeature([ApplicationEntity])],
})
export class ApplicationModule {}
