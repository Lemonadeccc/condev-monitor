import { Controller, Get, Param, Query, Request, UseGuards } from '@nestjs/common'

import { AnimationRumV2JwtGuard } from './animation-rum-v2-jwt.guard'
import { AnimationRumV2ReadThrottleGuard } from './animation-rum-v2-read-throttle.guard'
import { AnimationRumV3SoftNavigationPipelineService } from './animation-rum-v3-pipeline.service'
import { AnimationRumV3SoftNavigationQueryService } from './animation-rum-v3-query.service'
import { AnimationRumV2ApplicationDto } from './dto/animation-rum-v2-control.dto'
import {
    AnimationRumV3SoftNavigationCaptureParamsDto,
    AnimationRumV3SoftNavigationCapturesQueryDto,
    AnimationRumV3SoftNavigationQueryDto,
} from './dto/animation-rum-v3-query.dto'

@Controller('/animation/rum-v3/soft-navigation')
@UseGuards(AnimationRumV2JwtGuard, AnimationRumV2ReadThrottleGuard)
export class AnimationRumV3SoftNavigationQueryController {
    constructor(
        private readonly queries: AnimationRumV3SoftNavigationQueryService,
        private readonly pipelineDiagnostics: AnimationRumV3SoftNavigationPipelineService
    ) {}

    @Get('/pipeline')
    async pipeline(@Query() query: AnimationRumV2ApplicationDto, @Request() request) {
        return { success: true, data: await this.pipelineDiagnostics.read(request.user.id, query.appId) }
    }

    @Get('/summary')
    async summary(@Query() query: AnimationRumV3SoftNavigationQueryDto, @Request() request) {
        return { success: true, data: await this.queries.summary(request.user.id, query) }
    }

    @Get('/captures')
    async captures(@Query() query: AnimationRumV3SoftNavigationCapturesQueryDto, @Request() request) {
        return { success: true, data: await this.queries.captures(request.user.id, query) }
    }

    @Get('/captures/:captureId')
    async capture(
        @Param() params: AnimationRumV3SoftNavigationCaptureParamsDto,
        @Query() query: AnimationRumV2ApplicationDto,
        @Request() request
    ) {
        return { success: true, data: await this.queries.capture(request.user.id, query.appId, params.captureId) }
    }
}
