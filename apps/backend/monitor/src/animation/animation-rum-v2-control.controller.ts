import { Body, Controller, Get, Post, Query, Request, UseGuards } from '@nestjs/common'

import { AnimationRumV2ControlService } from './animation-rum-v2-control.service'
import { AnimationRumV2JwtGuard } from './animation-rum-v2-jwt.guard'
import {
    AnimationRumV2ApplicationDto,
    AnimationRumV2DeploymentDto,
    AnimationRumV2RouteDto,
    AnimationRumV2TargetDto,
    ConfigureAnimationRumV2PolicyDto,
} from './dto/animation-rum-v2-control.dto'

@Controller('/animation/rum-v2')
@UseGuards(AnimationRumV2JwtGuard)
export class AnimationRumV2ControlController {
    constructor(private readonly control: AnimationRumV2ControlService) {}

    @Get('/state')
    async state(@Query() query: AnimationRumV2ApplicationDto, @Request() request) {
        return { success: true, data: await this.control.state(request.user.id, query) }
    }

    @Post('/policy')
    async configurePolicy(@Body() body: ConfigureAnimationRumV2PolicyDto, @Request() request) {
        return { success: true, data: await this.control.configurePolicy(request.user.id, body) }
    }

    @Post('/policy/enable')
    async enablePolicy(@Body() body: AnimationRumV2ApplicationDto, @Request() request) {
        return { success: true, data: await this.control.setPolicyEnabled(request.user.id, body, true) }
    }

    @Post('/policy/disable')
    async disablePolicy(@Body() body: AnimationRumV2ApplicationDto, @Request() request) {
        return { success: true, data: await this.control.setPolicyEnabled(request.user.id, body, false) }
    }

    @Post('/routes')
    async registerRoute(@Body() body: AnimationRumV2RouteDto, @Request() request) {
        return { success: true, data: await this.control.registerRoute(request.user.id, body) }
    }

    @Post('/routes/disable')
    async disableRoute(@Body() body: AnimationRumV2RouteDto, @Request() request) {
        return { success: true, data: await this.control.disableRoute(request.user.id, body) }
    }

    @Post('/targets')
    async registerTarget(@Body() body: AnimationRumV2TargetDto, @Request() request) {
        return { success: true, data: await this.control.registerTarget(request.user.id, body) }
    }

    @Post('/targets/disable')
    async disableTarget(@Body() body: AnimationRumV2TargetDto, @Request() request) {
        return { success: true, data: await this.control.disableTarget(request.user.id, body) }
    }

    @Post('/deployments')
    async registerDeployment(@Body() body: AnimationRumV2DeploymentDto, @Request() request) {
        return { success: true, data: await this.control.registerDeployment(request.user.id, body) }
    }

    @Post('/deployments/disable')
    async disableDeployment(@Body() body: AnimationRumV2DeploymentDto, @Request() request) {
        return { success: true, data: await this.control.disableDeployment(request.user.id, body) }
    }
}
