import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { CompressionTypes, Kafka, Producer } from 'kafkajs'

@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(KafkaProducerService.name)
    private producer: Producer | null = null
    private connected = false
    private connecting: Promise<void> | null = null
    private enabled = false

    constructor(private readonly config: ConfigService) {}

    async onModuleInit() {
        this.enabled = this.config.get<string>('KAFKA_ENABLED') === 'true'
        if (!this.enabled) {
            this.logger.log('Kafka producer disabled (KAFKA_ENABLED != true)')
            return
        }

        const brokers = (this.config.get<string>('KAFKA_BROKERS') ?? 'localhost:9094').split(',')
        const clientId = this.config.get<string>('KAFKA_CLIENT_ID') ?? 'condev-monitor-dsn'

        const kafka = new Kafka({
            clientId,
            brokers,
            retry: {
                initialRetryTime: 300,
                retries: Number(this.config.get<string>('KAFKA_PRODUCER_RETRIES') ?? 5),
            },
        })

        this.producer = kafka.producer({
            allowAutoTopicCreation: false,
        })

        try {
            await this.ensureConnected()
            this.logger.log(`Kafka producer connected to ${brokers.join(',')}`)
        } catch (err) {
            this.logger.error('Failed to connect Kafka producer', err instanceof Error ? err.stack : String(err))
        }
    }

    async onModuleDestroy() {
        if (this.connecting) {
            try {
                await this.connecting
            } catch {
                // A failed startup connection does not need a disconnect.
            }
        }
        if (this.producer && this.connected) {
            await this.producer.disconnect()
            this.logger.log('Kafka producer disconnected')
        }
        this.connected = false
        this.connecting = null
    }

    isConnected(): boolean {
        return this.connected
    }

    async publishBatch(params: { topic: string; messages: Array<{ key: string; value: string }> }): Promise<void> {
        await this.ensureConnected()

        try {
            await this.producer!.send({
                topic: params.topic,
                compression: CompressionTypes.GZIP,
                acks: Number(this.config.get<string>('KAFKA_REQUIRED_ACKS') ?? -1),
                timeout: Number(this.config.get<string>('KAFKA_PRODUCER_TIMEOUT_MS') ?? 3000),
                messages: params.messages.map(m => ({
                    key: m.key,
                    value: m.value,
                })),
            })
        } catch (error) {
            this.connected = false
            throw error
        }
    }

    private async ensureConnected(): Promise<void> {
        if (!this.enabled) throw new Error('Kafka producer is disabled')
        if (!this.producer) throw new Error('Kafka producer is not initialized')
        if (this.connected) return
        if (!this.connecting) {
            const attempt = this.producer.connect().then(() => {
                this.connected = true
            })
            this.connecting = attempt
            const clearAttempt = () => {
                if (this.connecting === attempt) this.connecting = null
            }
            void attempt.then(clearAttempt, clearAttempt)
        }
        await this.connecting
    }
}
