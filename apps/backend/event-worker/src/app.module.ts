import { existsSync } from 'node:fs'
import * as path from 'node:path'

import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { ScheduleModule } from '@nestjs/schedule'

import { ClickhouseWriterModule } from './modules/clickhouse/clickhouse-writer.module'
import { KafkaConsumerModule } from './modules/kafka/kafka-consumer.module'

const envFilePaths = [
    path.resolve(process.cwd(), 'apps/backend/event-worker/.env'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '../../../.env'),
].filter(p => existsSync(p))

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            ...(envFilePaths.length ? { envFilePath: envFilePaths } : {}),
        }),
        ScheduleModule.forRoot(),
        ClickhouseWriterModule,
        KafkaConsumerModule,
    ],
})
export class AppModule {}
