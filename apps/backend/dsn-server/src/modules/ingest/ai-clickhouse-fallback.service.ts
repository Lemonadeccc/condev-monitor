import { ClickHouseClient } from '@clickhouse/client'
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { resolveClickhouseDatabase } from '../../shared/clickhouse-utils'
import { parseDateTimeForCH } from '../../shared/datetime'
import { estimateTraceCost } from './ai-pricing'

type AiEventPayload = {
    appId?: string
    event_type: string
    traceId: string
    spanId?: string
    parentSpanId?: string
    spanKind?: string
    name?: string
    status?: string
    model?: string
    provider?: string
    source?: string
    framework?: string
    sessionId?: string
    userId?: string
    environment?: string
    release?: string
    tags?: string[]
    inputTokens?: number
    outputTokens?: number
    startedAt?: string
    endedAt?: string
    durationMs?: number
    input?: unknown
    output?: unknown
    errorMessage?: string
    metadata?: Record<string, unknown>
    attributes?: Record<string, unknown>
    value?: number
    comment?: string
    createdAt?: string
    runId?: string
    fileName?: string
    fileSize?: number
    chunkCount?: number
    tokenCount?: number
    evalId?: string
    evaluator?: string
    metric?: string
    score?: number
}

@Injectable()
export class AIClickhouseFallbackService implements OnModuleInit {
    private readonly logger = new Logger(AIClickhouseFallbackService.name)
    private readonly database: string
    private readonly pricingConfig: string | null

    constructor(
        @Inject('CLICKHOUSE_CLIENT')
        private readonly clickhouseClient: ClickHouseClient,
        private readonly config: ConfigService
    ) {
        this.database = resolveClickhouseDatabase(this.config)
        this.pricingConfig = this.config.get<string>('AI_MODEL_PRICING_JSON') ?? null
    }

    async onModuleInit(): Promise<void> {
        await this.ensureSchema()
    }

    async insertBatch(appId: string, items: Record<string, unknown>[]): Promise<void> {
        for (const item of items) {
            await this.insertEvent(appId, item as AiEventPayload)
        }
    }

    private async insertEvent(appId: string, payload: AiEventPayload): Promise<void> {
        switch (payload.event_type) {
            case 'ai_span':
            case 'ai_observation':
                await this.upsertSpan(appId, payload)
                if (payload.spanKind === 'entrypoint' || payload.parentSpanId === '' || !payload.parentSpanId) {
                    await this.upsertTrace(appId, payload)
                }
                break
            case 'ai_feedback':
                await this.insertFeedback(appId, payload)
                break
            case 'ai_ingestion_run':
                await this.insertIngestionRun(appId, payload)
                break
            case 'ai_evaluation':
                await this.insertEvaluation(appId, payload)
                break
            default:
                this.logger.warn(`Unknown AI event_type in direct mode: ${payload.event_type}`)
        }
    }

    private async upsertTrace(appId: string, span: AiEventPayload): Promise<void> {
        const costEstimate = estimateTraceCost({
            model: span.model,
            provider: span.provider,
            inputTokens: span.inputTokens,
            outputTokens: span.outputTokens,
            pricingConfig: this.pricingConfig,
        })
        const metadata = {
            ...(span.metadata ?? {}),
            ...(costEstimate
                ? {
                      costCurrency: costEstimate.currency,
                      costBreakdown: {
                          input: costEstimate.inputCost,
                          output: costEstimate.outputCost,
                          total: costEstimate.totalCost,
                      },
                  }
                : {}),
        }

        await this.clickhouseClient.insert({
            table: `${this.database}.ai_traces`,
            values: [
                {
                    trace_id: span.traceId,
                    app_id: appId,
                    session_id: span.sessionId ?? '',
                    user_id: span.userId ?? '',
                    name: span.name ?? '',
                    source: span.source ?? 'unknown',
                    framework: span.framework ?? 'manual',
                    status: span.status ?? 'ok',
                    model: span.model ?? '',
                    provider: span.provider ?? '',
                    environment: span.environment ?? '',
                    release: span.release ?? '',
                    tags: span.tags ?? [],
                    input_tokens: span.inputTokens ?? 0,
                    output_tokens: span.outputTokens ?? 0,
                    total_cost: costEstimate?.totalCost ?? 0,
                    started_at: parseDateTimeForCH(span.startedAt) ?? parseDateTimeForCH(new Date()),
                    ended_at: parseDateTimeForCH(span.endedAt),
                    duration_ms: span.durationMs ?? 0,
                    error_message: span.errorMessage ?? '',
                    metadata: JSON.stringify(metadata),
                },
            ],
            format: 'JSONEachRow',
        })
    }

    private async upsertSpan(appId: string, span: AiEventPayload): Promise<void> {
        await this.clickhouseClient.insert({
            table: `${this.database}.ai_spans`,
            values: [
                {
                    span_id: span.spanId ?? span.traceId,
                    trace_id: span.traceId,
                    parent_span_id: span.parentSpanId ?? '',
                    app_id: appId,
                    name: span.name ?? '',
                    span_kind: span.spanKind ?? 'span',
                    status: span.status ?? 'ok',
                    model: span.model ?? '',
                    provider: span.provider ?? '',
                    input_tokens: span.inputTokens ?? 0,
                    output_tokens: span.outputTokens ?? 0,
                    started_at: parseDateTimeForCH(span.startedAt) ?? parseDateTimeForCH(new Date()),
                    ended_at: parseDateTimeForCH(span.endedAt),
                    duration_ms: span.durationMs ?? 0,
                    input: JSON.stringify(span.input ?? null),
                    output: JSON.stringify(span.output ?? null),
                    error_message: span.errorMessage ?? '',
                    attributes: JSON.stringify(span.attributes ?? span.metadata ?? {}),
                },
            ],
            format: 'JSONEachRow',
        })
    }

    private async insertFeedback(appId: string, payload: AiEventPayload): Promise<void> {
        await this.clickhouseClient.insert({
            table: `${this.database}.ai_feedback`,
            values: [
                {
                    trace_id: payload.traceId,
                    span_id: payload.spanId ?? '',
                    app_id: appId,
                    name: payload.name ?? 'score',
                    value: payload.value ?? 0,
                    comment: payload.comment ?? '',
                    source: payload.source ?? 'sdk',
                    created_at: parseDateTimeForCH(payload.createdAt) ?? parseDateTimeForCH(new Date()),
                },
            ],
            format: 'JSONEachRow',
        })
    }

    private async insertIngestionRun(appId: string, payload: AiEventPayload): Promise<void> {
        await this.clickhouseClient.insert({
            table: `${this.database}.ai_ingestion_runs`,
            values: [
                {
                    run_id: payload.runId ?? payload.traceId,
                    app_id: appId,
                    trace_id: payload.traceId,
                    file_name: payload.fileName ?? '',
                    file_size: payload.fileSize ?? 0,
                    status: payload.status ?? 'ok',
                    chunk_count: payload.chunkCount ?? 0,
                    token_count: payload.tokenCount ?? 0,
                    duration_ms: payload.durationMs ?? 0,
                    error_msg: payload.errorMessage ?? '',
                    started_at: parseDateTimeForCH(payload.startedAt) ?? parseDateTimeForCH(new Date()),
                    ended_at: parseDateTimeForCH(payload.endedAt),
                },
            ],
            format: 'JSONEachRow',
        })
    }

    private async insertEvaluation(appId: string, payload: AiEventPayload): Promise<void> {
        await this.clickhouseClient.insert({
            table: `${this.database}.ai_evaluations`,
            values: [
                {
                    trace_id: payload.traceId,
                    app_id: appId,
                    evaluator: payload.evaluator ?? 'sdk',
                    metric: payload.metric ?? payload.name ?? '',
                    score: payload.score ?? payload.value ?? 0,
                    model: payload.model ?? '',
                    created_at: parseDateTimeForCH(payload.createdAt) ?? parseDateTimeForCH(new Date()),
                },
            ],
            format: 'JSONEachRow',
        })
    }

    private async ensureSchema(): Promise<void> {
        await this.clickhouseClient.command({
            query: `
                CREATE TABLE IF NOT EXISTS ${this.database}.ai_traces (
                    trace_id String,
                    app_id String,
                    session_id String DEFAULT '',
                    user_id String DEFAULT '',
                    name String DEFAULT '',
                    source LowCardinality(String) DEFAULT '',
                    framework LowCardinality(String) DEFAULT '',
                    status LowCardinality(String) DEFAULT 'ok',
                    model String DEFAULT '',
                    provider String DEFAULT '',
                    environment String DEFAULT '',
                    release String DEFAULT '',
                    tags Array(String) DEFAULT [],
                    input_tokens UInt32 DEFAULT 0,
                    output_tokens UInt32 DEFAULT 0,
                    total_cost Float64 DEFAULT 0,
                    started_at DateTime64(3, 'UTC'),
                    ended_at Nullable(DateTime64(3, 'UTC')),
                    duration_ms Float64 DEFAULT 0,
                    error_message String DEFAULT '',
                    metadata String DEFAULT '{}'
                ) ENGINE = ReplacingMergeTree(started_at)
                PARTITION BY toYYYYMM(started_at)
                ORDER BY (app_id, trace_id)
                TTL toDateTime(started_at) + INTERVAL 90 DAY
            `,
        })
        await this.clickhouseClient.command({
            query: `
                CREATE TABLE IF NOT EXISTS ${this.database}.ai_spans (
                    span_id String,
                    trace_id String,
                    parent_span_id String DEFAULT '',
                    app_id String,
                    name String,
                    span_kind LowCardinality(String) DEFAULT 'span',
                    status LowCardinality(String) DEFAULT 'ok',
                    model String DEFAULT '',
                    provider String DEFAULT '',
                    input_tokens UInt32 DEFAULT 0,
                    output_tokens UInt32 DEFAULT 0,
                    started_at DateTime64(3, 'UTC'),
                    ended_at Nullable(DateTime64(3, 'UTC')),
                    duration_ms Float64 DEFAULT 0,
                    input String DEFAULT '',
                    output String DEFAULT '',
                    error_message String DEFAULT '',
                    attributes String DEFAULT '{}'
                ) ENGINE = MergeTree()
                PARTITION BY toYYYYMM(started_at)
                ORDER BY (app_id, trace_id, span_id)
                TTL toDateTime(started_at) + INTERVAL 90 DAY
            `,
        })
        await this.clickhouseClient.command({
            query: `
                CREATE TABLE IF NOT EXISTS ${this.database}.ai_feedback (
                    id UUID DEFAULT generateUUIDv4(),
                    trace_id String,
                    span_id String DEFAULT '',
                    app_id String,
                    name String,
                    value Float64,
                    comment String DEFAULT '',
                    source LowCardinality(String) DEFAULT 'sdk',
                    created_at DateTime64(3, 'UTC') DEFAULT now64(3)
                ) ENGINE = MergeTree()
                PARTITION BY toYYYYMM(created_at)
                ORDER BY (app_id, trace_id, created_at)
                TTL toDateTime(created_at) + INTERVAL 180 DAY
            `,
        })
        await this.clickhouseClient.command({
            query: `
                CREATE TABLE IF NOT EXISTS ${this.database}.ai_ingestion_runs (
                    run_id String,
                    app_id String,
                    trace_id String DEFAULT '',
                    file_name String DEFAULT '',
                    file_size UInt64 DEFAULT 0,
                    status LowCardinality(String) DEFAULT 'ok',
                    chunk_count UInt32 DEFAULT 0,
                    token_count UInt32 DEFAULT 0,
                    duration_ms Float64 DEFAULT 0,
                    error_msg String DEFAULT '',
                    started_at DateTime64(3, 'UTC'),
                    ended_at Nullable(DateTime64(3, 'UTC'))
                ) ENGINE = MergeTree()
                PARTITION BY toYYYYMM(started_at)
                ORDER BY (app_id, run_id)
                TTL toDateTime(started_at) + INTERVAL 90 DAY
            `,
        })
        await this.clickhouseClient.command({
            query: `
                CREATE TABLE IF NOT EXISTS ${this.database}.ai_evaluations (
                    eval_id UUID DEFAULT generateUUIDv4(),
                    trace_id String,
                    app_id String,
                    evaluator String,
                    metric String,
                    score Float64,
                    model String DEFAULT '',
                    created_at DateTime64(3, 'UTC') DEFAULT now64(3)
                ) ENGINE = MergeTree()
                PARTITION BY toYYYYMM(created_at)
                ORDER BY (app_id, trace_id, metric)
                TTL toDateTime(created_at) + INTERVAL 180 DAY
            `,
        })
    }
}
