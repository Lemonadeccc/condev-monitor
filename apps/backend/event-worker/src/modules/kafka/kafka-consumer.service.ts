import { createHash } from 'node:crypto'

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Consumer, EachBatchPayload, Kafka } from 'kafkajs'

import { resolveClickhouseDatabase } from '../../shared/clickhouse-utils'
import { EventRow, KafkaEventEnvelope } from '../../shared/ingest-types'
import { formatDateTimeForCH } from '../../utils/datetime'
import { AiEventPayload, AiProjectorService } from '../ai-observability/ai-projector.service'
import { ClickhouseWriterService, IssueRow } from '../clickhouse/clickhouse-writer.service'
import { DlqProducerService } from '../dlq/dlq-producer.service'
import { EmbeddingService } from '../fingerprint/embedding.service'
import { FingerprintService } from '../fingerprint/fingerprint.service'
import { TfIdfService } from '../fingerprint/tfidf.service'
import { BatchBufferManager, LaneName } from './batch-buffer-manager.service'

type LaneRetryPolicy = {
    maxRetries: number
    maxBackoffMs: number
}

@Injectable()
export class KafkaConsumerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(KafkaConsumerService.name)
    private consumer: Consumer | null = null
    private kafka: Kafka | null = null

    private readonly eventsTopic: string
    private readonly replaysTopic: string
    private readonly aiEventsTopic: string
    private readonly lanePolicies: Record<LaneName, LaneRetryPolicy>
    private readonly clickhouseDatabase: string

    private readonly embHighThreshold: number
    private readonly embLowThreshold: number
    private readonly tfidfThreshold: number

    constructor(
        private readonly config: ConfigService,
        private readonly clickhouseWriter: ClickhouseWriterService,
        private readonly dlqProducer: DlqProducerService,
        private readonly fingerprintService: FingerprintService,
        private readonly embeddingService: EmbeddingService,
        private readonly tfidfService: TfIdfService,
        private readonly bufferManager: BatchBufferManager,
        private readonly aiProjector: AiProjectorService
    ) {
        this.eventsTopic = this.config.get<string>('KAFKA_EVENTS_TOPIC') ?? 'monitor.sdk.events.v1'
        this.replaysTopic = this.config.get<string>('KAFKA_REPLAYS_TOPIC') ?? 'monitor.sdk.replays.v1'
        this.aiEventsTopic = this.config.get<string>('KAFKA_AI_TOPIC') ?? 'condev.ai.events'
        this.clickhouseDatabase = resolveClickhouseDatabase(this.config)

        this.lanePolicies = {
            critical: {
                maxRetries: Number(this.config.get('CRITICAL_MAX_RETRIES') ?? 8),
                maxBackoffMs: Number(this.config.get('CRITICAL_BACKOFF_CAP_MS') ?? 5000),
            },
            normal: {
                maxRetries: Number(this.config.get('NORMAL_MAX_RETRIES') ?? 5),
                maxBackoffMs: Number(this.config.get('NORMAL_BACKOFF_CAP_MS') ?? 10000),
            },
            bulk: {
                maxRetries: Number(this.config.get('BULK_MAX_RETRIES') ?? 5),
                maxBackoffMs: Number(this.config.get('BULK_BACKOFF_CAP_MS') ?? 10000),
            },
        }

        this.embHighThreshold = Number(this.config.get('ISSUE_EMBEDDING_HIGH_THRESHOLD') ?? 0.92)
        this.embLowThreshold = Number(this.config.get('ISSUE_EMBEDDING_LOW_THRESHOLD') ?? 0.85)
        this.tfidfThreshold = Number(this.config.get('ISSUE_TFIDF_THRESHOLD') ?? 0.8)
    }

    async onModuleInit() {
        const brokers = (this.config.get<string>('KAFKA_BROKERS') ?? 'localhost:9094').split(',')
        const clientId = this.config.get<string>('KAFKA_CLIENT_ID') ?? 'condev-monitor-worker'
        const groupId = this.config.get<string>('KAFKA_CONSUMER_GROUP') ?? 'monitor-clickhouse-writer-v1'

        this.kafka = new Kafka({
            clientId,
            brokers,
            retry: { initialRetryTime: 300, retries: 8 },
        })

        await this.dlqProducer.connect(this.kafka)

        this.consumer = this.kafka.consumer({
            groupId,
            sessionTimeout: Number(this.config.get<string>('KAFKA_SESSION_TIMEOUT_MS') ?? 30000),
            heartbeatInterval: Number(this.config.get<string>('KAFKA_HEARTBEAT_INTERVAL_MS') ?? 3000),
        })

        await this.consumer.connect()
        this.logger.log(`Kafka consumer connected to ${brokers.join(',')} (group: ${groupId})`)

        await this.consumer.subscribe({ topic: this.eventsTopic, fromBeginning: false })
        await this.consumer.subscribe({ topic: this.replaysTopic, fromBeginning: false })
        await this.consumer.subscribe({ topic: this.aiEventsTopic, fromBeginning: false })

        this.bufferManager.configure({
            critical: rows => this.insertWithRetry(rows, 'critical'),
            normal: rows => this.insertWithRetry(rows, 'normal'),
            bulk: rows => this.insertWithRetry(rows, 'bulk'),
        })

        await this.consumer.run({
            autoCommit: false,
            eachBatchAutoResolve: false,
            eachBatch: async (payload: EachBatchPayload) => this.handleBatch(payload),
        })

        this.logger.log(`Subscribed to topics: ${this.eventsTopic}, ${this.replaysTopic}, ${this.aiEventsTopic}`)
    }

    async onModuleDestroy() {
        try {
            await this.bufferManager.flushAll()
            await this.bufferManager.destroy()
        } catch (err) {
            this.logger.error('Failed to flush lanes on shutdown', err instanceof Error ? err.stack : String(err))
        }

        if (this.consumer) {
            await this.consumer.disconnect()
            this.logger.log('Kafka consumer disconnected')
        }
        await this.dlqProducer.disconnect()
    }

    private safeParseEnvelope(value: Buffer | null): { ok: true; value: KafkaEventEnvelope } | { ok: false } {
        if (!value) return { ok: false }
        try {
            const parsed = JSON.parse(value.toString()) as KafkaEventEnvelope
            if (!parsed.appId || !parsed.eventType) return { ok: false }
            return {
                ok: true,
                value: {
                    ...parsed,
                    message: typeof parsed.message === 'string' ? parsed.message : '',
                    info: parsed.info && typeof parsed.info === 'object' && !Array.isArray(parsed.info) ? parsed.info : {},
                    sdkVersion: typeof parsed.sdkVersion === 'string' ? parsed.sdkVersion : '',
                    environment: typeof parsed.environment === 'string' ? parsed.environment : '',
                    release: typeof parsed.release === 'string' ? parsed.release : '',
                },
            }
        } catch {
            return { ok: false }
        }
    }

    private async handleAiBatch(payload: EachBatchPayload): Promise<void> {
        const { batch, resolveOffset, heartbeat, commitOffsetsIfNecessary, isRunning, isStale } = payload
        let processedSinceHeartbeat = 0

        for (const message of batch.messages) {
            if (!isRunning() || isStale()) break
            if (!message.value) {
                resolveOffset(message.offset)
                continue
            }
            try {
                const aiPayload = JSON.parse(message.value.toString()) as AiEventPayload
                await this.aiProjector.handleMessage(aiPayload)
                resolveOffset(message.offset)
            } catch (err) {
                this.logger.warn(
                    `AI event processing failed at offset=${message.offset}: ${err instanceof Error ? err.message : String(err)}`
                )
                try {
                    await this.dlqProducer.publish({
                        originalTopic: batch.topic,
                        originalOffset: message.offset,
                        key: message.key?.toString() ?? null,
                        reason: 'AI_PROCESSING_FAILED',
                        rawValue: message.value.toString(),
                    })
                    resolveOffset(message.offset)
                } catch (dlqErr) {
                    this.logger.error(
                        `DLQ publish failed for AI event at offset=${message.offset}, stopping batch`,
                        dlqErr instanceof Error ? dlqErr.stack : String(dlqErr)
                    )
                    break
                }
            }
            processedSinceHeartbeat += 1
            if (processedSinceHeartbeat >= 100) {
                await heartbeat()
                processedSinceHeartbeat = 0
            }
        }

        await commitOffsetsIfNecessary()
        await heartbeat()
    }

    private async handleBatch(payload: EachBatchPayload) {
        if (payload.batch.topic === this.aiEventsTopic) {
            return this.handleAiBatch(payload)
        }

        const { batch, resolveOffset, heartbeat, commitOffsetsIfNecessary, isRunning, isStale } = payload

        let processedSinceHeartbeat = 0

        for (const message of batch.messages) {
            if (!isRunning() || isStale()) break

            const parsed = this.safeParseEnvelope(message.value)

            if (!parsed.ok) {
                try {
                    await this.dlqProducer.publish({
                        originalTopic: batch.topic,
                        originalOffset: message.offset,
                        key: message.key?.toString() ?? null,
                        reason: 'INVALID_JSON',
                        rawValue: message.value?.toString() ?? null,
                    })
                    resolveOffset(message.offset)
                } catch (dlqErr) {
                    this.logger.error(
                        `DLQ publish failed, stopping batch to let Kafka redeliver offset=${message.offset}`,
                        dlqErr instanceof Error ? dlqErr.stack : String(dlqErr)
                    )
                    break
                }
                continue
            }

            const fingerprint = this.fingerprintService.compute({
                eventType: parsed.value.eventType,
                message: parsed.value.message,
                info: parsed.value.info,
            })

            const row: EventRow = {
                event_id: parsed.value.eventId,
                app_id: parsed.value.appId,
                event_type: parsed.value.eventType,
                fingerprint,
                message: parsed.value.message,
                info: parsed.value.info,
                sdk_version: parsed.value.sdkVersion ?? '',
                environment: parsed.value.environment ?? '',
                release: parsed.value.release ?? '',
            }

            if (row.event_type === 'error' || row.event_type === 'whitescreen') {
                await this.processIssueEvent(parsed.value, row, batch.topic, message.offset)
            }

            await this.bufferManager.route(row)
            resolveOffset(message.offset)

            processedSinceHeartbeat += 1
            if (processedSinceHeartbeat >= 100) {
                await heartbeat()
                processedSinceHeartbeat = 0
            }
        }

        // Critical lane: always flush immediately
        await this.bufferManager.flushCritical()
        await heartbeat()

        // Commit only after every resolved row has been durably flushed.
        await this.bufferManager.flushPendingNonCritical()
        await heartbeat()

        await commitOffsetsIfNecessary()
        await heartbeat()
    }

    private async processIssueEvent(
        envelope: KafkaEventEnvelope,
        row: EventRow,
        originalTopic: string,
        originalOffset: string
    ): Promise<void> {
        try {
            const issueType = this.extractIssueType(envelope.info)
            const stackSignature = this.fingerprintService.buildStackSignature(envelope.info, envelope.message)
            const now = formatDateTimeForCH(new Date())

            // Layer 1: Check if fingerprint already matches an existing issue
            const candidates = await this.clickhouseWriter.queryJson<IssueRow & { vector?: number[] }>(
                `SELECT
                    i.issue_id, i.app_id, i.fingerprint_hash, i.title, i.status,
                    i.issue_type, i.message, i.stack_signature,
                    i.occurrence_count, i.first_seen_at, i.last_seen_at,
                    i.merged_into, i.updated_at,
                    e.vector
                FROM (SELECT * FROM ${this.clickhouseDatabase}.issues FINAL) AS i
                LEFT JOIN (
                    SELECT issue_id, argMax(vector, created_at) AS vector
                    FROM ${this.clickhouseDatabase}.issue_embeddings GROUP BY issue_id
                ) AS e ON e.issue_id = i.issue_id
                WHERE i.app_id = {appId:String} AND i.status = 'open'
                ORDER BY i.last_seen_at DESC LIMIT 20`,
                { appId: envelope.appId }
            )

            let chosen = candidates.find(c => c.fingerprint_hash === row.fingerprint) ?? null
            let embeddingVector: Float32Array | null = null

            // Layer 2: Embedding semantic search
            if (!chosen && candidates.length > 0) {
                const inputText = this.fingerprintService.buildEmbeddingInput({
                    message: envelope.message,
                    info: envelope.info,
                })
                embeddingVector = await this.embeddingService.embed(inputText)

                let bestCandidate: (IssueRow & { vector?: number[] }) | null = null
                let bestScore = 0

                for (const candidate of candidates) {
                    if (!candidate.vector || candidate.vector.length === 0) continue
                    const score = this.embeddingService.cosineSimilarity(embeddingVector, new Float32Array(candidate.vector))
                    if (score > bestScore) {
                        bestScore = score
                        bestCandidate = candidate
                    }
                }

                if (bestCandidate && bestScore >= this.embHighThreshold) {
                    chosen = bestCandidate
                } else if (bestCandidate && bestScore >= this.embLowThreshold) {
                    // Gray zone: TF-IDF second opinion
                    const tfidfScore = this.tfidfService.computeSimilarity(
                        stackSignature.split('\n').filter(Boolean),
                        bestCandidate.stack_signature.split('\n').filter(Boolean),
                        envelope.appId
                    )
                    if (tfidfScore >= this.tfidfThreshold) {
                        chosen = bestCandidate
                    }
                }
            }

            if (!chosen) {
                // New issue — use a deterministic ID so concurrent consumers arriving at the same
                // fingerprint cannot create duplicate issue rows (REPLACING MergeTree will deduplicate).
                const issueId = this.buildIssueId(envelope.appId, row.fingerprint)
                const vector =
                    embeddingVector ??
                    (await this.embeddingService.embed(
                        this.fingerprintService.buildEmbeddingInput({ message: envelope.message, info: envelope.info })
                    ))
                await this.clickhouseWriter.upsertIssues([
                    {
                        issue_id: issueId,
                        app_id: envelope.appId,
                        fingerprint_hash: row.fingerprint,
                        title: '',
                        status: 'open',
                        issue_type: issueType,
                        message: envelope.message,
                        stack_signature: stackSignature,
                        occurrence_count: 1,
                        first_seen_at: now,
                        last_seen_at: now,
                        merged_into: null,
                        updated_at: now,
                    },
                ])
                await this.clickhouseWriter.insertIssueEmbeddings([
                    {
                        app_id: envelope.appId,
                        issue_id: issueId,
                        fingerprint_hash: row.fingerprint,
                        embedding_source: 'all-MiniLM-L6-v2',
                        vector: Array.from(vector),
                        created_at: now,
                    },
                ])
            } else {
                // Existing issue — update timestamps only.
                // occurrence_count is derived at query time via count() GROUP BY fingerprint.
                await this.clickhouseWriter.upsertIssues([
                    {
                        ...chosen,
                        last_seen_at: now,
                        updated_at: now,
                    },
                ])
            }
        } catch (err) {
            const rawValue = JSON.stringify({
                envelope,
                row,
                fingerprint: row.fingerprint,
            })

            try {
                await this.dlqProducer.publish({
                    originalTopic,
                    originalOffset,
                    key: envelope.appId,
                    reason: 'ISSUE_PROCESSING_FAILED',
                    rawValue,
                })
                this.logger.warn(`Issue processing failed and was routed to DLQ: ${err instanceof Error ? err.message : String(err)}`)
            } catch (dlqErr) {
                this.logger.error(
                    `Issue processing failed and DLQ publish also failed at offset=${originalOffset}`,
                    dlqErr instanceof Error ? dlqErr.stack : String(dlqErr)
                )
                throw dlqErr
            }
        }
    }

    private extractIssueType(info: Record<string, unknown>): string {
        if (typeof info.type === 'string') return info.type
        if (typeof info.name === 'string') return info.name
        return 'error'
    }

    /**
     * Builds a deterministic UUID v5-style issue ID from appId + fingerprintHash.
     * Two consumers processing the same fingerprint concurrently will produce the
     * same ID, so REPLACING MergeTree deduplication handles the race safely.
     */
    private buildIssueId(appId: string, fingerprintHash: string): string {
        const hex = createHash('sha256').update(`${appId}\x00${fingerprintHash}`).digest('hex')
        const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')
        return [hex.slice(0, 8), hex.slice(8, 12), '5' + hex.slice(13, 16), variant + hex.slice(18, 20), hex.slice(20, 32)].join('-')
    }

    private async insertWithRetry(rows: EventRow[], lane: LaneName, attempt = 1): Promise<void> {
        const policy = this.lanePolicies[lane]
        try {
            await this.clickhouseWriter.insertRows(rows)
        } catch (err) {
            if (attempt >= policy.maxRetries) {
                this.logger.error(
                    `ClickHouse insert failed for lane=${lane} after ${policy.maxRetries} attempts, ${rows.length} rows lost`,
                    err instanceof Error ? err.stack : String(err)
                )
                throw err
            }
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), policy.maxBackoffMs)
            this.logger.warn(`ClickHouse insert failed lane=${lane} (attempt ${attempt}/${policy.maxRetries}), retrying in ${delay}ms`)
            await new Promise(r => setTimeout(r, delay))
            return this.insertWithRetry(rows, lane, attempt + 1)
        }
    }
}
