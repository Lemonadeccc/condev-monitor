import { Module } from '@nestjs/common'

import { EmailModule } from '../email/email.module'
import { IngestModule } from '../ingest/ingest.module'
import { SpanController } from './span.controller'
import { SpanService } from './span.service'
@Module({
    imports: [EmailModule, IngestModule],
    providers: [SpanService],
    controllers: [SpanController],
})
export class SpanModule {}
