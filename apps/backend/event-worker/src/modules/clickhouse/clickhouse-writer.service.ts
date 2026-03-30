import { ClickHouseClient, createClient } from '@clickhouse/client'
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { resolveClickhouseDatabase } from '../../shared/clickhouse-utils'
import { EventRow } from '../../shared/ingest-types'
import { formatDateTimeForCH } from '../../utils/datetime'

export type IssueRow = {
    issue_id: string
    app_id: string
    fingerprint_hash: string
    title: string
    status: string
    issue_type: string
    message: string
    stack_signature: string
    occurrence_count: number
    first_seen_at: string
    last_seen_at: string
    merged_into: string | null
    updated_at: string
}

export type IssueEmbeddingRow = {
    app_id: string
    issue_id: string
    fingerprint_hash: string
    embedding_source: string
    vector: number[]
    created_at: string
}

@Injectable()
export class ClickhouseWriterService implements OnModuleDestroy {
    private static readonly CRON_LOCK_GUARD_MS = 200
    private readonly logger = new Logger(ClickhouseWriterService.name)
    private readonly client: ClickHouseClient
    private readonly database: string

    constructor(private readonly config: ConfigService) {
        this.database = resolveClickhouseDatabase(this.config)
        this.client = createClient({
            url: this.config.get<string>('CLICKHOUSE_URL') ?? 'http://localhost:8123',
            username: this.config.get<string>('CLICKHOUSE_USERNAME') ?? 'lemonade',
            password: this.config.get<string>('CLICKHOUSE_PASSWORD') ?? '',
        })
    }

    async onModuleDestroy() {
        await this.client.close()
    }

    async insertRows(rows: EventRow[]): Promise<void> {
        if (rows.length === 0) return

        await this.client.insert({
            table: `${this.database}.events`,
            columns: ['event_id', 'app_id', 'event_type', 'fingerprint', 'message', 'info', 'sdk_version', 'environment', 'release'],
            format: 'JSONEachRow',
            values: rows,
        })

        this.logger.debug(`Inserted ${rows.length} rows into ClickHouse`)
    }

    async queryJson<T>(query: string, query_params?: Record<string, unknown>): Promise<T[]> {
        const result = await this.client.query({ query, format: 'JSON', query_params })
        const json = (await result.json()) as { data?: T[] }
        return json.data ?? []
    }

    async upsertIssues(rows: IssueRow[]): Promise<void> {
        if (rows.length === 0) return
        await this.client.insert({
            table: `${this.database}.issues`,
            columns: [
                'issue_id',
                'app_id',
                'fingerprint_hash',
                'title',
                'status',
                'issue_type',
                'message',
                'stack_signature',
                'occurrence_count',
                'first_seen_at',
                'last_seen_at',
                'merged_into',
                'updated_at',
            ],
            format: 'JSONEachRow',
            values: rows,
        })
    }

    async insertIssueEmbeddings(rows: IssueEmbeddingRow[]): Promise<void> {
        if (rows.length === 0) return
        await this.client.insert({
            table: `${this.database}.issue_embeddings`,
            columns: ['app_id', 'issue_id', 'fingerprint_hash', 'embedding_source', 'vector', 'created_at'],
            format: 'JSONEachRow',
            values: rows,
        })
    }

    /**
     * Attempt to acquire a distributed cron lock.
     * Returns true if this holder now owns the lock, false if another holder holds it.
     */
    async tryAcquireCronLock(lockName: string, holderId: string, ttlSeconds: number): Promise<boolean> {
        const activeLock = await this.getActiveCronLock(lockName)
        if (activeLock && activeLock.holder_id !== holderId) {
            return false
        }
        if (activeLock?.holder_id === holderId) {
            return true
        }

        const leaseStartAt = formatDateTimeForCH(new Date(Date.now() + ClickhouseWriterService.CRON_LOCK_GUARD_MS))
        await this.client.insert({
            table: `${this.database}.cron_locks`,
            columns: ['lock_name', 'holder_id', 'ttl_seconds', 'acquired_at', 'updated_at'],
            format: 'JSONEachRow',
            values: [
                {
                    lock_name: lockName,
                    holder_id: holderId,
                    ttl_seconds: ttlSeconds,
                    acquired_at: leaseStartAt,
                    updated_at: leaseStartAt,
                },
            ],
        })

        await this.sleep(ClickhouseWriterService.CRON_LOCK_GUARD_MS)

        const confirmedLock = await this.getActiveCronLock(lockName)
        return confirmedLock?.holder_id === holderId && confirmedLock.acquired_at === leaseStartAt
    }

    /**
     * Release a cron lock by inserting a row with TTL=0 so it is cleaned up immediately.
     */
    async releaseCronLock(lockName: string, holderId: string): Promise<void> {
        const activeLock = await this.getActiveCronLock(lockName)
        if (!activeLock || activeLock.holder_id !== holderId) {
            this.logger.warn(`Skip releasing cron lock ${lockName}: holder mismatch`)
            return
        }

        await this.client.insert({
            table: `${this.database}.cron_locks`,
            columns: ['lock_name', 'holder_id', 'ttl_seconds', 'acquired_at', 'updated_at'],
            format: 'JSONEachRow',
            values: [
                {
                    lock_name: lockName,
                    holder_id: holderId,
                    ttl_seconds: 0,
                    acquired_at: formatDateTimeForCH(new Date()),
                    updated_at: formatDateTimeForCH(new Date()),
                },
            ],
        })
    }

    private async getActiveCronLock(lockName: string): Promise<{ holder_id: string; acquired_at: string; ttl_seconds: number } | null> {
        const [activeLock] = await this.queryJson<{ holder_id: string; acquired_at: string; ttl_seconds: number }>(
            `SELECT holder_id, acquired_at, ttl_seconds
             FROM ${this.database}.cron_locks
             WHERE lock_name = {lockName:String}
               AND acquired_at + toIntervalSecond(ttl_seconds) > now64(3, 'Asia/Shanghai')
             ORDER BY acquired_at DESC, updated_at DESC, holder_id DESC
             LIMIT 1`,
            { lockName }
        )

        return activeLock ?? null
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}
