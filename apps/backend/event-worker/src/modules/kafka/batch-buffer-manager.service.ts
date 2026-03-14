import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { EventRow } from '../../shared/ingest-types'
import { BatchLane } from './batch-lane'

export type LaneName = 'critical' | 'normal' | 'bulk'

@Injectable()
export class BatchBufferManager {
    private static readonly CRITICAL_TYPES = new Set(['error', 'whitescreen'])
    private static readonly BULK_TYPES = new Set(['replay'])

    private readonly logger = new Logger(BatchBufferManager.name)

    private criticalLane!: BatchLane
    private normalLane!: BatchLane
    private bulkLane!: BatchLane
    private configured = false

    private readonly criticalBatchSize: number
    private readonly criticalMaxWaitMs: number
    private readonly criticalMaxBufferSize: number
    private readonly normalBatchSize: number
    private readonly normalMaxWaitMs: number
    private readonly normalMaxBufferSize: number
    private readonly bulkBatchSize: number
    private readonly bulkMaxWaitMs: number
    private readonly bulkMaxBufferSize: number

    constructor(private readonly config: ConfigService) {
        this.criticalBatchSize = Number(this.config.get('CRITICAL_BATCH_SIZE') ?? 10)
        this.criticalMaxWaitMs = Number(this.config.get('CRITICAL_BATCH_MAX_WAIT_MS') ?? 100)
        this.criticalMaxBufferSize = Number(this.config.get('CRITICAL_MAX_BUFFER_SIZE') ?? 10000)
        this.normalBatchSize = Number(this.config.get('NORMAL_BATCH_SIZE') ?? 500)
        this.normalMaxWaitMs = Number(this.config.get('NORMAL_BATCH_MAX_WAIT_MS') ?? 1000)
        this.normalMaxBufferSize = Number(this.config.get('NORMAL_MAX_BUFFER_SIZE') ?? 10000)
        this.bulkBatchSize = Number(this.config.get('BULK_BATCH_SIZE') ?? 50)
        this.bulkMaxWaitMs = Number(this.config.get('BULK_BATCH_MAX_WAIT_MS') ?? 2000)
        this.bulkMaxBufferSize = Number(this.config.get('BULK_MAX_BUFFER_SIZE') ?? 10000)
    }

    configure(flushFns: Record<LaneName, (rows: EventRow[]) => Promise<void>>): void {
        const onDrop = (dropped: EventRow[], lane: string): void => {
            // Emit a structured log that can be scraped as a metric.
            // TODO: wire DLQ producer here when DlqProducerService is injected into this manager.
            this.logger.error(
                `[METRIC:lane_overflow] lane=${lane} dropped=${dropped.length} ` +
                    `sample_app=${dropped[0]?.app_id ?? 'unknown'} sample_type=${dropped[0]?.event_type ?? 'unknown'}`
            )
        }

        this.criticalLane = new BatchLane({
            name: 'critical',
            maxBatchSize: this.criticalBatchSize,
            maxWaitMs: this.criticalMaxWaitMs,
            maxBufferSize: this.criticalMaxBufferSize,
            flushFn: flushFns.critical,
            onDrop,
        })

        this.normalLane = new BatchLane({
            name: 'normal',
            maxBatchSize: this.normalBatchSize,
            maxWaitMs: this.normalMaxWaitMs,
            maxBufferSize: this.normalMaxBufferSize,
            flushFn: flushFns.normal,
            onDrop,
        })

        this.bulkLane = new BatchLane({
            name: 'bulk',
            maxBatchSize: this.bulkBatchSize,
            maxWaitMs: this.bulkMaxWaitMs,
            maxBufferSize: this.bulkMaxBufferSize,
            flushFn: flushFns.bulk,
            onDrop,
        })

        this.configured = true
        this.logger.log(
            `Lanes configured — critical: ${this.criticalBatchSize}/${this.criticalMaxWaitMs}ms, ` +
                `normal: ${this.normalBatchSize}/${this.normalMaxWaitMs}ms, ` +
                `bulk: ${this.bulkBatchSize}/${this.bulkMaxWaitMs}ms`
        )
    }

    hasPendingNonCritical(): boolean {
        this.ensureConfigured()
        return this.normalLane.pending || this.bulkLane.pending
    }

    async route(row: EventRow): Promise<void> {
        this.ensureConfigured()
        const lane = this.classify(row.event_type)
        switch (lane) {
            case 'critical':
                await this.criticalLane.add(row)
                break
            case 'bulk':
                await this.bulkLane.add(row)
                break
            default:
                await this.normalLane.add(row)
        }
    }

    async flushCritical(): Promise<void> {
        this.ensureConfigured()
        if (this.criticalLane.pending) {
            await this.criticalLane.flush()
        }
    }

    async flushReadyNonCritical(): Promise<void> {
        this.ensureConfigured()
        if (this.normalLane.size >= this.normalBatchSize) {
            await this.normalLane.flush()
        }
        if (this.bulkLane.size >= this.bulkBatchSize) {
            await this.bulkLane.flush()
        }
    }

    async flushPendingNonCritical(): Promise<void> {
        this.ensureConfigured()
        await this.normalLane.flush()
        await this.bulkLane.flush()
    }

    async flushAll(): Promise<void> {
        this.ensureConfigured()
        await this.criticalLane.flush()
        await this.normalLane.flush()
        await this.bulkLane.flush()
    }

    async destroy(): Promise<void> {
        if (!this.configured) return
        await this.criticalLane.destroy()
        await this.normalLane.destroy()
        await this.bulkLane.destroy()
    }

    private classify(eventType: string): LaneName {
        if (BatchBufferManager.CRITICAL_TYPES.has(eventType)) return 'critical'
        if (BatchBufferManager.BULK_TYPES.has(eventType)) return 'bulk'
        return 'normal'
    }

    private ensureConfigured(): void {
        if (!this.configured) {
            throw new Error('BatchBufferManager used before configure()')
        }
    }
}
