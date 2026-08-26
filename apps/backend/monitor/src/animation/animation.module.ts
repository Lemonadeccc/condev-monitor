import { Module } from '@nestjs/common'

import { ApplicationModule } from '../application/application.module'
import { AnimationController } from './animation.controller'
import { AnimationService } from './animation.service'

@Module({
    imports: [ApplicationModule],
    controllers: [AnimationController],
    providers: [AnimationService],
})
export class AnimationModule {}
