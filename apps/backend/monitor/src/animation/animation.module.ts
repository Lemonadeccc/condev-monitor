import { Module } from '@nestjs/common'

import { ApplicationModule } from '../application/application.module'
import { AnimationController } from './animation.controller'
import { AnimationService } from './animation.service'
import { AnimationRumV2ControlController } from './animation-rum-v2-control.controller'
import { AnimationRumV2ControlService } from './animation-rum-v2-control.service'
import { AnimationRumV2JwtGuard } from './animation-rum-v2-jwt.guard'

@Module({
    imports: [ApplicationModule],
    controllers: [AnimationController, AnimationRumV2ControlController],
    providers: [AnimationService, AnimationRumV2ControlService, AnimationRumV2JwtGuard],
})
export class AnimationModule {}
