import { Body, Controller, Get, Post, Query, Request, UseGuards } from '@nestjs/common'

import { AnimationRumV2JwtGuard } from './animation-rum-v2-jwt.guard'
import { AnimationRumV3SoftNavigationControlService } from './animation-rum-v3-control.service'
import { AnimationRumV2ApplicationDto } from './dto/animation-rum-v2-control.dto'
import { ConfigureAnimationRumV3SoftNavigationDto } from './dto/animation-rum-v3-control.dto'

@Controller('/animation/rum-v3/soft-navigation/control')
@UseGuards(AnimationRumV2JwtGuard)
export class AnimationRumV3SoftNavigationControlController {
    constructor(private readonly control: AnimationRumV3SoftNavigationControlService) {}

    @Get('/state')
    async state(@Query() query: AnimationRumV2ApplicationDto, @Request() request) {
        return { success: true, data: await this.control.state(request.user.id, query.appId) }
    }

    @Post('/configure')
    async configure(@Body() body: ConfigureAnimationRumV3SoftNavigationDto, @Request() request) {
        return { success: true, data: await this.control.configure(request.user.id, body) }
    }

    @Post('/disable')
    async disable(@Body() body: AnimationRumV2ApplicationDto, @Request() request) {
        return { success: true, data: await this.control.disable(request.user.id, body.appId) }
    }
}
