import { Module } from '@nestjs/common'

import { AiObservabilityModule } from '../ai-observability/ai-observability.module'
import { ClickhouseWriterModule } from '../clickhouse/clickhouse-writer.module'
import { DlqProducerService } from '../dlq/dlq-producer.service'
import { FingerprintModule } from '../fingerprint/fingerprint.module'
import { LlmModule } from '../llm/llm.module'
import { BatchBufferManager } from './batch-buffer-manager.service'
import { KafkaConsumerService } from './kafka-consumer.service'

@Module({
    imports: [AiObservabilityModule, ClickhouseWriterModule, FingerprintModule, LlmModule],
    providers: [KafkaConsumerService, DlqProducerService, BatchBufferManager],
})
export class KafkaConsumerModule {}
