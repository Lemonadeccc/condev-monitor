import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'

import { SpanService } from './span.service'

@Controller()
export class SpanController {
    constructor(private readonly spanService: SpanService) {}

    @Get('/span')
    span() {
        return this.spanService.span()
    }

    @Post('/tracking/:app_id')
    tracking(@Param('app_id') appId: string, @Body() params: { event_type: string; message: string }) {
        return this.spanService.tracking(appId, params)
    }

    @Get('/bugs')
    bugs() {
        return this.spanService.bugs()
    }

    @Get('/issues')
    issues(@Query('appId') appId?: string, @Query('range') range: '1h' | '3h' | '1d' | '7d' | '1m' = '7d', @Query('limit') limit = '200') {
        return this.spanService.issues({
            appId,
            range,
            limit: Number(limit) || 200,
        })
    }

    @Get('/metric')
    metric(@Query('appId') appId: string, @Query('range') range: '1h' | '3h' | '1d' | '7d' | '1m' = '1h') {
        return this.spanService.metric({ appId, range })
    }

    @Get('/overview')
    overview(@Query('appId') appId: string, @Query('range') range: '1h' | '3h' | '1d' | '7d' | '1m' = '1h') {
        return this.spanService.overview({ appId, range })
    }
}
