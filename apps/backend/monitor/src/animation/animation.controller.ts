import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'

import { ApplicationService } from '../application/application.service'
import { AnimationService } from './animation.service'

@Controller('/animation')
@UseGuards(AuthGuard('jwt'))
export class AnimationController {
    constructor(
        private readonly animationService: AnimationService,
        private readonly applicationService: ApplicationService
    ) {}

    @Get('/summary')
    async summary(
        @Query('appId') appId: string,
        @Request() req,
        @Query('from') from?: string,
        @Query('to') to?: string,
        @Query('release') release?: string,
        @Query('environment') environment?: string,
        @Query('routeKey') routeKey?: string
    ) {
        await this.applicationService.assertOwned(appId, req.user.id)
        return { success: true, data: await this.animationService.summary({ appId, from, to, release, environment, routeKey }) }
    }

    @Get('/captures')
    async captures(
        @Query('appId') appId: string,
        @Request() req,
        @Query('from') from?: string,
        @Query('to') to?: string,
        @Query('release') release?: string,
        @Query('environment') environment?: string,
        @Query('routeKey') routeKey?: string,
        @Query('captureId') captureId?: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string
    ) {
        await this.applicationService.assertOwned(appId, req.user.id)
        return {
            success: true,
            data: await this.animationService.captures({
                appId,
                from,
                to,
                release,
                environment,
                routeKey,
                captureId,
                limit: limit === undefined ? undefined : Number(limit),
                offset: offset === undefined ? undefined : Number(offset),
            }),
        }
    }
}
