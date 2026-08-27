import { Module } from '@nestjs/common'

import { ApplicationModule } from '../application/application.module'
import { AnimationController } from './animation.controller'
import { AnimationService } from './animation.service'
import { AnimationRumV2ControlController } from './animation-rum-v2-control.controller'
import { AnimationRumV2ControlService } from './animation-rum-v2-control.service'
import { AnimationRumV2JwtGuard } from './animation-rum-v2-jwt.guard'
import { AnimationRumV2PipelineService } from './animation-rum-v2-pipeline.service'
import { AnimationRumV2QueryController } from './animation-rum-v2-query.controller'
import { AnimationRumV2QueryService } from './animation-rum-v2-query.service'
import { AnimationRumV2ReadThrottleGuard } from './animation-rum-v2-read-throttle.guard'
import { AnimationRumV2ReadThrottleService } from './animation-rum-v2-read-throttle.service'

@Module({
    imports: [ApplicationModule],
    controllers: [AnimationController, AnimationRumV2ControlController, AnimationRumV2QueryController],
    providers: [
        AnimationService,
        AnimationRumV2ControlService,
        AnimationRumV2PipelineService,
        AnimationRumV2QueryService,
        AnimationRumV2JwtGuard,
        AnimationRumV2ReadThrottleGuard,
        AnimationRumV2ReadThrottleService,
    ],
})
export class AnimationModule {}
