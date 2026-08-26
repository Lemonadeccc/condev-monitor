import { randomUUID } from 'node:crypto'

import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { AnimationRumV1Report, isAnimationRumV1Candidate, validateAnimationRumV1 } from '../../shared/animation-rum-v1'
import { EventRow, KafkaEventEnvelope } from '../../shared/ingest-types'
import { AIClickhouseFallbackService } from './ai-clickhouse-fallback.service'
import { AnimationRumClickhouseService } from './animation-rum-clickhouse.service'
import { ClickhouseFallbackService } from './clickhouse-fallback.service'
import { KafkaProducerService } from './kafka-producer.service'

export type PersistResult = {
    persistedVia: 'clickhouse' | 'kafka' | 'clickhouse-fallback'
}

export type AnimationRumPersistResult = PersistResult & { receivedAt: string }

@Injectable()
export class IngestWriterService {
    private readonly logger = new Logger(IngestWriterService.name)
    private readonly ingestMode: string
    private readonly kafkaFallback: boolean
    private readonly eventsTopic: string
    private readonly replaysTopic: string
    private readonly aiEventsTopic: string
    private static readonly AI_EVENT_TYPES = new Set(['ai_span', 'ai_observation', 'ai_feedback', 'ai_ingestion_run', 'ai_evaluation'])

    constructor(
        private readonly kafkaProducer: KafkaProducerService,
        private readonly clickhouseFallback: ClickhouseFallbackService,
        private readonly aiClickhouseFallback: AIClickhouseFallbackService,
        private readonly animationRumClickhouse: AnimationRumClickhouseService,
        private readonly config: ConfigService
    ) {
        this.ingestMode = this.config.get<string>('INGEST_MODE') ?? 'direct'
        this.kafkaFallback = this.config.get<string>('KAFKA_FALLBACK_TO_CLICKHOUSE') !== 'false'
        this.eventsTopic = this.config.get<string>('KAFKA_EVENTS_TOPIC') ?? 'monitor.sdk.events.v1'
        this.replaysTopic = this.config.get<string>('KAFKA_REPLAYS_TOPIC') ?? 'monitor.sdk.replays.v1'
        this.aiEventsTopic = this.config.get<string>('KAFKA_AI_TOPIC') ?? 'condev.ai.events'
    }

    private classifyDomain(item: Record<string, unknown>): 'ai' | 'frontend' {
        return IngestWriterService.AI_EVENT_TYPES.has(item['event_type'] as string) ? 'ai' : 'frontend'
    }

    private async publishAiBatch(appId: string, items: Record<string, unknown>[]): Promise<void> {
        await this.kafkaProducer.publishBatch({
            topic: this.aiEventsTopic,
            messages: items.map(item => ({
                key: appId,
                value: JSON.stringify({ appId, ...item }),
            })),
        })
    }

    async writeTrackingBatch(appId: string, items: Record<string, unknown>[]): Promise<PersistResult> {
        const animationItems = items.filter(isAnimationRumV1Candidate)
        // Keep the negative branch typed as the generic legacy payload. Without
        // the explicit boolean return, TypeScript treats the complement of the
        // Record type guard as `never`, even though this branch deliberately
        // contains all non-protocol custom events.
        const nonAnimationItems = items.filter((item): boolean => !isAnimationRumV1Candidate(item))
        let animationResult: PersistResult | null = null
        if (animationItems.length > 0) {
            const reports = animationItems.map(item => {
                const parsed = validateAnimationRumV1(item, { trackingWrapper: true })
                if ('errors' in parsed) throw new Error(`Invalid animation RUM item: ${parsed.errors.join(',')}`)
                return parsed.value
            })
            animationResult = await this.writeAnimationRumBatch(appId, reports)
        }

        const aiItems = nonAnimationItems.filter(item => this.classifyDomain(item) === 'ai')
        const frontendItems = nonAnimationItems.filter(item => this.classifyDomain(item) === 'frontend')

        if (aiItems.length > 0) {
            if (this.ingestMode === 'direct') {
                await this.aiClickhouseFallback.insertBatch(appId, aiItems)
            } else {
                await this.publishAiBatch(appId, aiItems)
            }
        }

        if (frontendItems.length === 0) {
            if (aiItems.length === 0 && animationResult) return animationResult
            return { persistedVia: this.ingestMode === 'direct' ? 'clickhouse' : 'kafka' }
        }

        const rows: EventRow[] = frontendItems.map(item => {
            const info = { ...item }
            delete info.event_type
            delete info.message
            delete info.sdk_version
            delete info.environment
            delete info.release
            delete info._eventId
            delete info._clientCreatedAt

            const clientEventId = typeof item._eventId === 'string' && item._eventId.trim() ? item._eventId.trim() : null
            return {
                event_id: clientEventId ?? randomUUID(),
                app_id: appId,
                event_type: String(item.event_type ?? ''),
                fingerprint: '',
                message: typeof item.message === 'string' ? item.message : '',
                info,
                sdk_version: this.extractSdkVersion(item),
                environment: typeof item.environment === 'string' ? item.environment.trim() : '',
                release: typeof item.release === 'string' ? item.release.trim() : '',
            }
        })

        if (this.ingestMode === 'direct') {
            await this.clickhouseFallback.insertEvents(rows)
            return { persistedVia: 'clickhouse' }
        }

        const envelopes: KafkaEventEnvelope[] = rows.map(row => ({
            schemaVersion: 1,
            eventId: row.event_id,
            appId,
            eventType: row.event_type,
            message: row.message,
            info: row.info,
            sdkVersion: row.sdk_version,
            environment: row.environment,
            release: row.release,
            receivedAt: new Date().toISOString(),
            source: 'browser-sdk',
        }))

        try {
            await this.kafkaProducer.publishBatch({
                topic: this.eventsTopic,
                messages: envelopes.map(e => ({
                    key: appId,
                    value: JSON.stringify(e),
                })),
            })
            return { persistedVia: 'kafka' }
        } catch (err) {
            this.logger.warn(`Kafka publish failed, fallback=${this.kafkaFallback}: ${err instanceof Error ? err.message : String(err)}`)

            if (this.kafkaFallback) {
                await this.clickhouseFallback.insertEvents(rows)
                return { persistedVia: 'clickhouse-fallback' }
            }
            throw err
        }
    }

    async writeAnimationRum(appId: string, report: AnimationRumV1Report): Promise<AnimationRumPersistResult> {
        return this.writeAnimationRumBatch(appId, [report])
    }

    private async writeAnimationRumBatch(appId: string, reports: AnimationRumV1Report[]): Promise<AnimationRumPersistResult> {
        const receivedAt = new Date().toISOString()
        const inserts = reports.map(report => ({ appId, report, receivedAt }))

        if (this.ingestMode === 'direct') {
            await this.animationRumClickhouse.insertBatch(inserts)
            return { persistedVia: 'clickhouse', receivedAt }
        }

        const envelopes: KafkaEventEnvelope[] = reports.map(report => ({
            schemaVersion: 1,
            eventId: report.eventId,
            appId,
            eventType: 'animation_rum',
            message: '',
            info: { animationRum: report },
            sdkVersion: report.sdkVersion,
            environment: report.environment,
            release: report.release,
            receivedAt,
            source: 'animation-rum-v1',
        }))

        try {
            await this.kafkaProducer.publishBatch({
                topic: this.eventsTopic,
                messages: envelopes.map(envelope => ({ key: appId, value: JSON.stringify(envelope) })),
            })
            return { persistedVia: 'kafka', receivedAt }
        } catch (err) {
            this.logger.warn(
                `Kafka animation RUM publish failed, fallback=${this.kafkaFallback}: ${err instanceof Error ? err.message : String(err)}`
            )
            if (!this.kafkaFallback) throw err
            await this.animationRumClickhouse.insertBatch(inserts)
            return { persistedVia: 'clickhouse-fallback', receivedAt }
        }
    }

    async writeReplay(appId: string, row: EventRow): Promise<PersistResult> {
        const persistedRow: EventRow = {
            ...row,
            event_id: row.event_id.trim() || randomUUID(),
        }

        if (this.ingestMode === 'direct') {
            await this.clickhouseFallback.insertEvents([persistedRow])
            return { persistedVia: 'clickhouse' }
        }

        const envelope: KafkaEventEnvelope = {
            schemaVersion: 1,
            eventId: persistedRow.event_id,
            appId,
            eventType: 'replay',
            message: persistedRow.message,
            info: persistedRow.info,
            sdkVersion: persistedRow.sdk_version,
            environment: persistedRow.environment,
            release: persistedRow.release,
            receivedAt: new Date().toISOString(),
            source: 'browser-sdk',
        }

        try {
            await this.kafkaProducer.publishBatch({
                topic: this.replaysTopic,
                messages: [{ key: appId, value: JSON.stringify(envelope) }],
            })
            return { persistedVia: 'kafka' }
        } catch (err) {
            this.logger.warn(
                `Kafka replay publish failed, fallback=${this.kafkaFallback}: ${err instanceof Error ? err.message : String(err)}`
            )

            if (this.kafkaFallback) {
                await this.clickhouseFallback.insertEvents([persistedRow])
                return { persistedVia: 'clickhouse-fallback' }
            }
            throw err
        }
    }

    private extractSdkVersion(item: Record<string, unknown>): string {
        if (typeof item.sdk_version === 'string' && item.sdk_version.trim()) {
            return item.sdk_version.trim()
        }
        if (typeof item.sdkVersion === 'string' && item.sdkVersion.trim()) {
            return item.sdkVersion.trim()
        }
        const sdk = item.sdk
        if (sdk && typeof sdk === 'object' && !Array.isArray(sdk)) {
            const version = (sdk as Record<string, unknown>).version
            if (typeof version === 'string' && version.trim()) return version.trim()
        }
        return ''
    }
}
