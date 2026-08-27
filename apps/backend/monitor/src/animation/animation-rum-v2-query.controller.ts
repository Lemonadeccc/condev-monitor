import { Controller, Get, Param, Query, Request, UseGuards } from '@nestjs/common'

import { AnimationRumV2JwtGuard } from './animation-rum-v2-jwt.guard'
import { AnimationRumV2PipelineService } from './animation-rum-v2-pipeline.service'
import { AnimationRumV2QueryService } from './animation-rum-v2-query.service'
import { AnimationRumV2ReadThrottleGuard } from './animation-rum-v2-read-throttle.guard'
import { AnimationRumV2ApplicationDto } from './dto/animation-rum-v2-control.dto'
import { AnimationRumV2CaptureParamsDto, AnimationRumV2CapturesQueryDto, AnimationRumV2QueryDto } from './dto/animation-rum-v2-query.dto'

@Controller('/animation/rum-v2')
@UseGuards(AnimationRumV2JwtGuard, AnimationRumV2ReadThrottleGuard)
export class AnimationRumV2QueryController {
    constructor(
        private readonly queries: AnimationRumV2QueryService,
        private readonly pipelineDiagnostics: AnimationRumV2PipelineService
    ) {}

    @Get('/pipeline')
    async pipeline(@Query() query: AnimationRumV2ApplicationDto, @Request() request) {
        return { success: true, data: await this.pipelineDiagnostics.read(request.user.id, query.appId) }
    }

    @Get('/summary')
    async summary(@Query() query: AnimationRumV2QueryDto, @Request() request) {
        return { success: true, data: await this.queries.summary(request.user.id, query) }
    }

    @Get('/captures')
    async captures(@Query() query: AnimationRumV2CapturesQueryDto, @Request() request) {
        return { success: true, data: await this.queries.captures(request.user.id, query) }
    }

    @Get('/captures/:captureId')
    async capture(@Param() params: AnimationRumV2CaptureParamsDto, @Query() query: AnimationRumV2ApplicationDto, @Request() request) {
        return { success: true, data: await this.queries.capture(request.user.id, query.appId, params.captureId) }
    }
}
