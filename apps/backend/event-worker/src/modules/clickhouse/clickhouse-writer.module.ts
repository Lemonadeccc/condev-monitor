import { Module } from '@nestjs/common'

import { ClickhouseWriterService } from './clickhouse-writer.service'

@Module({
    providers: [ClickhouseWriterService],
    exports: [ClickhouseWriterService],
})
export class ClickhouseWriterModule {}
