import { Body, Controller, Get, Param, Post } from '@nestjs/common'

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
}
