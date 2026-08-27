import { Module } from '@nestjs/common'

import { AIClickhouseFallbackService } from './ai-clickhouse-fallback.service'
import { AnimationRumClickhouseService } from './animation-rum-clickhouse.service'
import { AnimationRumV2AdmissionService } from './animation-rum-v2-admission.service'
import { AnimationRumV2OutboxDispatcherService } from './animation-rum-v2-outbox-dispatcher.service'
import { AnimationRumV2RetentionService } from './animation-rum-v2-retention.service'
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
        AnimationRumClickhouseService,
        AnimationRumV2AdmissionService,
        AnimationRumV2OutboxDispatcherService,
        AnimationRumV2RetentionService,
        IngestWriterService,
        InboundFilterService,
        RateLimiterService,
    ],
    exports: [AnimationRumV2AdmissionService, IngestWriterService, InboundFilterService, RateLimiterService],
})
export class IngestModule {}
