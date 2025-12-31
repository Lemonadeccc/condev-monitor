import { Module } from '@nestjs/common'

import { EmailModule } from '../email/email.module'
import { SpanController } from './span.controller'
import { SpanService } from './span.service'
@Module({
    imports: [EmailModule],
    providers: [SpanService],
    controllers: [SpanController],
})
export class SpanModule {}
