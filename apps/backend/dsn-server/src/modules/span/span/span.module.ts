import { Module } from '@nestjs/common'

import { SpanController } from './span.controller'
import { SpanService } from './span.service'

@Module({
    providers: [SpanService],
    controllers: [SpanController],
})
export class SpanModule {}
