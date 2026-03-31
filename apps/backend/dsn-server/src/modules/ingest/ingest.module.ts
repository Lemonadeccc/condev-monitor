import { Module } from '@nestjs/common'

import { AIClickhouseFallbackService } from './ai-clickhouse-fallback.service'
import { ClickhouseFallbackService } from './clickhouse-fallback.service'
import { InboundFilterService } from './inbound-filter.service'
import { IngestWriterService } from './ingest-writer.service'
import { KafkaProducerService } from './kafka-producer.service'
import { RateLimiterService } from './rate-limiter.service'

@Module({
    providers: [
        KafkaProducerService,
        ClickhouseFallbackService,
        AIClickhouseFallbackService,
        IngestWriterService,
        InboundFilterService,
        RateLimiterService,
    ],
    exports: [IngestWriterService, InboundFilterService, RateLimiterService],
})
export class IngestModule {}
