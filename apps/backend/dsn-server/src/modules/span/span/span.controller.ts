import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'

import { SpanService } from './span.service'

@Controller()
export class SpanController {
    constructor(private readonly spanService: SpanService) {}

    @Get('/span')
    span() {
        return this.spanService.span()
    }

    @Post('/tracing/:appId')
    tracing(@Body() body, @Query() Query, @Param() param) {
        const { appId } = param
        return this.spanService.tracing(appId, body)
    }

    @Get('/bugs')
    bugs() {
        return this.spanService.bugs()
    }
}
