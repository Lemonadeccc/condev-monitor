import { Module } from '@nestjs/common'

import { ClickhouseFallbackService } from './clickhouse-fallback.service'
import { InboundFilterService } from './inbound-filter.service'
import { IngestWriterService } from './ingest-writer.service'
import { KafkaProducerService } from './kafka-producer.service'
import { RateLimiterService } from './rate-limiter.service'

@Module({
    providers: [KafkaProducerService, ClickhouseFallbackService, IngestWriterService, InboundFilterService, RateLimiterService],
    exports: [IngestWriterService, InboundFilterService, RateLimiterService],
})
export class IngestModule {}
