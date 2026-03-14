import { Module } from '@nestjs/common'

import { ClickhouseWriterModule } from '../clickhouse/clickhouse-writer.module'
import { FingerprintModule } from '../fingerprint/fingerprint.module'
import { IssueMergeJobService } from './issue-merge-job.service'
import { LlmClientService } from './llm-client.service'

@Module({
    imports: [ClickhouseWriterModule, FingerprintModule],
    providers: [LlmClientService, IssueMergeJobService],
    exports: [LlmClientService],
})
export class LlmModule {}
