import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Kafka, Producer } from 'kafkajs'

@Injectable()
export class DlqProducerService {
    private readonly logger = new Logger(DlqProducerService.name)
    private producer: Producer | null = null
    private readonly dlqTopic: string

    constructor(private readonly config: ConfigService) {
        this.dlqTopic = this.config.get<string>('KAFKA_DLQ_TOPIC') ?? 'monitor.sdk.dlq.v1'
    }

    async connect(kafka: Kafka): Promise<void> {
        this.producer = kafka.producer({ allowAutoTopicCreation: false })
        await this.producer.connect()
        this.logger.log('DLQ producer connected')
    }

    async disconnect(): Promise<void> {
        if (this.producer) {
            await this.producer.disconnect()
        }
    }

    async publish(params: {
        originalTopic: string
        originalOffset: string
        key: string | null
        reason: string
        rawValue: string | null
    }): Promise<void> {
        if (!this.producer) {
            throw new Error('DLQ producer not connected')
        }

        try {
            await this.producer.send({
                topic: this.dlqTopic,
                messages: [
                    {
                        key: params.key,
                        value: JSON.stringify({
                            reason: params.reason,
                            originalTopic: params.originalTopic,
                            originalOffset: params.originalOffset,
                            rawValue: params.rawValue,
                            failedAt: new Date().toISOString(),
                        }),
                    },
                ],
            })
        } catch (err) {
            this.logger.error('Failed to publish to DLQ', err instanceof Error ? err.stack : String(err))
            throw err
        }
    }
}
