import { ClickHouseClient } from '@clickhouse/client'
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'

import { AIDatasetEntity } from './entity/ai-dataset.entity'
import { AIDatasetItemEntity } from './entity/ai-dataset-item.entity'
import { AIExperimentEntity } from './entity/ai-experiment.entity'
import { AIExperimentRunEntity } from './entity/ai-experiment-run.entity'
import { AIPromptEntity } from './entity/ai-prompt.entity'
import { AIPromptVersionEntity } from './entity/ai-prompt-version.entity'
import { estimateTraceCost } from './pricing'

export interface TraceListQuery {
    appId: string
    from?: string
    to?: string
    status?: string
    limit?: number
    offset?: number
}

type JsonMap = Record<string, unknown>

function formatDateTimeForCH(date: Date): string {
    const pad = (n: number, width = 2) => String(n).padStart(width, '0')
    return (
        `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
        `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`
    )
}

function statusRank(status: unknown) {
    switch (String(status ?? '')) {
        case 'cancelled':
            return 2
        case 'error':
            return 1
        default:
            return 0
    }
}

function dedupeSpans(rows: Record<string, unknown>[]) {
    const bySpanId = new Map<string, Record<string, unknown>>()

    for (const row of rows) {
        const spanId = String(row.span_id ?? '')
        if (!spanId) continue

        const previous = bySpanId.get(spanId)
        if (!previous) {
            bySpanId.set(spanId, row)
            continue
        }

        const previousRank = statusRank(previous.status)
        const nextRank = statusRank(row.status)
        const previousEndedAt = String(previous.ended_at ?? '')
        const nextEndedAt = String(row.ended_at ?? '')

        if (
            nextRank > previousRank ||
            (nextRank === previousRank && nextEndedAt > previousEndedAt) ||
            (nextRank === previousRank &&
                nextEndedAt === previousEndedAt &&
                String(row.model ?? '').length > String(previous.model ?? '').length)
        ) {
            bySpanId.set(spanId, row)
        }
    }

    return [...bySpanId.values()].sort((a, b) => String(a.started_at ?? '').localeCompare(String(b.started_at ?? '')))
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
    if (typeof raw !== 'string' || !raw.trim()) return {}
    try {
        const parsed = JSON.parse(raw) as unknown
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
        return {}
    }
}

function stringifyJsonObject(value: Record<string, unknown> | undefined): string {
    return value && Object.keys(value).length > 0 ? JSON.stringify(value) : '{}'
}

@Injectable()
export class AiService {
    private readonly database: string
    private readonly pricingConfig: string | null

    constructor(
        @Inject('CLICKHOUSE_CLIENT')
        private readonly ch: ClickHouseClient,
        private readonly config: ConfigService,
        @InjectRepository(AIPromptEntity)
        private readonly promptRepository: Repository<AIPromptEntity>,
        @InjectRepository(AIPromptVersionEntity)
        private readonly promptVersionRepository: Repository<AIPromptVersionEntity>,
        @InjectRepository(AIDatasetEntity)
        private readonly datasetRepository: Repository<AIDatasetEntity>,
        @InjectRepository(AIDatasetItemEntity)
        private readonly datasetItemRepository: Repository<AIDatasetItemEntity>,
        @InjectRepository(AIExperimentEntity)
        private readonly experimentRepository: Repository<AIExperimentEntity>,
        @InjectRepository(AIExperimentRunEntity)
        private readonly experimentRunRepository: Repository<AIExperimentRunEntity>
    ) {
        this.database = config.get<string>('CLICKHOUSE_DATABASE') ?? 'lemonade'
        this.pricingConfig = config.get<string>('AI_MODEL_PRICING_JSON') ?? null
    }

    private resolveCost(params: {
        model?: unknown
        provider?: unknown
        inputTokens?: unknown
        outputTokens?: unknown
        totalCost?: unknown
        costCurrency?: unknown
    }) {
        const existingCost = Number(params.totalCost ?? 0)
        const existingCurrency = String(params.costCurrency ?? '').trim()
        const estimate = estimateTraceCost({
            model: String(params.model ?? ''),
            provider: String(params.provider ?? ''),
            inputTokens: Number(params.inputTokens ?? 0),
            outputTokens: Number(params.outputTokens ?? 0),
            pricingConfig: this.pricingConfig,
        })

        if (existingCost > 0) {
            return {
                totalCost: existingCost,
                costCurrency: existingCurrency || estimate?.currency || '',
                costAvailable: !!(existingCurrency || estimate?.currency),
                estimate,
                costSource: 'final' as const,
            }
        }

        if (!estimate) {
            return {
                totalCost: 0,
                costCurrency: existingCurrency,
                costAvailable: false,
                estimate: null,
                costSource: 'unknown' as const,
            }
        }

        return {
            totalCost: estimate.totalCost,
            costCurrency: existingCurrency || estimate.currency,
            costAvailable: true,
            estimate,
            costSource: 'estimated' as const,
        }
    }

    async listTraces(query: TraceListQuery) {
        const { appId, from, to, limit = 50, offset = 0 } = query
        const status = this.normalizeTraceStatus(query.status)
        const fromDt = from ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
        const toDt = to ?? new Date().toISOString()

        const result = await this.ch.query({
            query: `
                SELECT
                    t.trace_id,
                    t.name,
                    t.session_id,
                    t.user_id,
                    multiIf(
                        ifNull(spans.status_rank, 0) = 2,
                        'cancelled',
                        ifNull(spans.status_rank, 0) = 1,
                        'error',
                        t.status
                    ) AS status,
                    t.model,
                    t.provider,
                    t.environment,
                    t.release,
                    if(
                        t.input_tokens + t.output_tokens > 0,
                        t.input_tokens,
                        ifNull(spans.best_input_tokens, 0)
                    ) AS input_tokens,
                    if(
                        t.input_tokens + t.output_tokens > 0,
                        t.output_tokens,
                        ifNull(spans.best_output_tokens, 0)
                    ) AS output_tokens,
                    t.total_cost,
                    JSONExtractString(t.metadata, 'costCurrency') AS cost_currency,
                    t.duration_ms,
                    t.started_at,
                    ifNull(spans.span_count, 0) AS span_count
                FROM ${this.database}.ai_traces AS t FINAL
                LEFT JOIN (
                    SELECT
                        app_id,
                        trace_id,
                        count(DISTINCT span_id) AS span_count,
                        argMax(input_tokens, input_tokens + output_tokens) AS best_input_tokens,
                        argMax(output_tokens, input_tokens + output_tokens) AS best_output_tokens,
                        max(
                            multiIf(
                                status = 'cancelled',
                                2,
                                status = 'error',
                                1,
                                0
                            )
                        ) AS status_rank
                    FROM ${this.database}.ai_spans
                    GROUP BY app_id, trace_id
                ) AS spans
                    ON spans.app_id = t.app_id AND spans.trace_id = t.trace_id
                WHERE t.app_id = {appId:String}
                  AND t.started_at >= parseDateTime64BestEffort({from:String})
                  AND t.started_at <= parseDateTime64BestEffort({to:String})
                  AND (
                        {status:String} = 'all'
                        OR multiIf(
                            ifNull(spans.status_rank, 0) = 2,
                            'cancelled',
                            ifNull(spans.status_rank, 0) = 1,
                            'error',
                            t.status
                        ) = {status:String}
                  )
                ORDER BY t.started_at DESC
                LIMIT {limit:UInt32} OFFSET {offset:UInt32}
            `,
            query_params: { appId, from: fromDt, to: toDt, status, limit, offset },
            format: 'JSONEachRow',
        })
        const rows = (await result.json()) as Record<string, unknown>[]
        return rows.map(row => {
            const cost = this.resolveCost({
                model: row.model,
                provider: row.provider,
                inputTokens: row.input_tokens,
                outputTokens: row.output_tokens,
                totalCost: row.total_cost,
                costCurrency: row.cost_currency,
            })

            return {
                ...row,
                total_cost: cost.totalCost,
                cost_currency: cost.costCurrency,
                cost_source: cost.costSource,
            }
        })
    }

    async getTraceDetail(traceId: string, appId: string) {
        const [traceResult, spansResult, feedbacksResult, evaluationsResult] = await Promise.all([
            this.ch.query({
                query: `SELECT * FROM ${this.database}.ai_traces FINAL
                        WHERE trace_id = {traceId:String} AND app_id = {appId:String}
                        LIMIT 1`,
                query_params: { traceId, appId },
                format: 'JSONEachRow',
            }),
            this.ch.query({
                query: `SELECT * FROM ${this.database}.ai_spans
                        WHERE trace_id = {traceId:String} AND app_id = {appId:String}
                        ORDER BY started_at ASC`,
                query_params: { traceId, appId },
                format: 'JSONEachRow',
            }),
            this.ch.query({
                query: `SELECT * FROM ${this.database}.ai_feedback
                        WHERE trace_id = {traceId:String} AND app_id = {appId:String}
                        ORDER BY created_at DESC`,
                query_params: { traceId, appId },
                format: 'JSONEachRow',
            }),
            this.ch.query({
                query: `SELECT * FROM ${this.database}.ai_evaluations
                        WHERE trace_id = {traceId:String} AND app_id = {appId:String}
                        ORDER BY created_at DESC`,
                query_params: { traceId, appId },
                format: 'JSONEachRow',
            }),
        ])

        const [traces, spans, feedbacks, evaluations] = await Promise.all([
            traceResult.json(),
            spansResult.json(),
            feedbacksResult.json(),
            evaluationsResult.json(),
        ])
        const trace = Array.isArray(traces) ? ((traces[0] as Record<string, unknown> | undefined) ?? null) : null
        const spanRows = dedupeSpans(Array.isArray(spans) ? (spans as Record<string, unknown>[]) : [])
        const rootSpan =
            spanRows.find(row => String(row.parent_span_id ?? '') === '' || String(row.span_kind ?? '') === 'entrypoint') ??
            spanRows[0] ??
            null
        const effectiveStatus = spanRows.some(row => String(row.status ?? '') === 'cancelled')
            ? 'cancelled'
            : spanRows.some(row => String(row.status ?? '') === 'error')
              ? 'error'
              : String(trace?.status ?? 'ok')
        const lifecycleSpan =
            spanRows.find(row => String(row.status ?? '') === 'cancelled') ??
            spanRows.find(row => String(row.status ?? '') === 'error') ??
            rootSpan
        const bestTokenSpan =
            spanRows.reduce<Record<string, unknown> | null>((best, row) => {
                const bestTokens = Number(best?.input_tokens ?? 0) + Number(best?.output_tokens ?? 0)
                const nextTokens = Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0)
                return nextTokens > bestTokens ? row : best
            }, null) ?? rootSpan
        const traceMetadata = parseJsonObject(trace?.metadata)
        const lifecycleAttributes = parseJsonObject(lifecycleSpan?.attributes)
        const effectiveInput = String(lifecycleSpan?.input ?? '') || String(rootSpan?.input ?? '')
        const effectiveOutput = String(rootSpan?.output ?? '') || String(lifecycleSpan?.output ?? '')
        const effectiveMetadata =
            effectiveStatus === 'cancelled' && Object.keys(lifecycleAttributes).length > 0 ? lifecycleAttributes : traceMetadata
        const effectiveInputTokens =
            Number(trace?.input_tokens ?? 0) + Number(trace?.output_tokens ?? 0) > 0
                ? Number(trace?.input_tokens ?? 0)
                : Number(bestTokenSpan?.input_tokens ?? 0)
        const effectiveOutputTokens =
            Number(trace?.input_tokens ?? 0) + Number(trace?.output_tokens ?? 0) > 0
                ? Number(trace?.output_tokens ?? 0)
                : Number(bestTokenSpan?.output_tokens ?? 0)
        const resolvedCost = this.resolveCost({
            model: String(trace?.model ?? '') || String(bestTokenSpan?.model ?? '') || String(lifecycleSpan?.model ?? ''),
            provider: String(trace?.provider ?? '') || String(bestTokenSpan?.provider ?? '') || String(lifecycleSpan?.provider ?? ''),
            inputTokens: effectiveInputTokens,
            outputTokens: effectiveOutputTokens,
            totalCost: trace?.total_cost,
            costCurrency: traceMetadata.costCurrency,
        })

        if (resolvedCost.estimate && !effectiveMetadata.costCurrency) {
            effectiveMetadata.costCurrency = resolvedCost.costCurrency
            effectiveMetadata.costBreakdown = {
                input: resolvedCost.estimate.inputCost,
                output: resolvedCost.estimate.outputCost,
                total: resolvedCost.estimate.totalCost,
            }
        }
        if (resolvedCost.costSource !== 'unknown') {
            effectiveMetadata.costSource = resolvedCost.costSource
        }

        return {
            trace: trace
                ? {
                      ...trace,
                      status: effectiveStatus,
                      model: String(trace.model ?? '') || String(bestTokenSpan?.model ?? '') || String(lifecycleSpan?.model ?? ''),
                      provider:
                          String(trace.provider ?? '') || String(bestTokenSpan?.provider ?? '') || String(lifecycleSpan?.provider ?? ''),
                      input_tokens: effectiveInputTokens,
                      output_tokens: effectiveOutputTokens,
                      total_cost: resolvedCost.totalCost,
                      cost_source: resolvedCost.costSource,
                      input: effectiveInput,
                      output: effectiveOutput,
                      error_message:
                          String(trace.error_message ?? '') ||
                          String(lifecycleSpan?.error_message ?? '') ||
                          String(rootSpan?.error_message ?? ''),
                      metadata: stringifyJsonObject(effectiveMetadata),
                  }
                : null,
            spans: spanRows,
            scores: this.mergeScores(
                Array.isArray(feedbacks) ? (feedbacks as Record<string, unknown>[]) : [],
                Array.isArray(evaluations) ? (evaluations as Record<string, unknown>[]) : []
            ),
        }
    }

    async listSessions(appId: string, limit = 50, offset = 0) {
        const result = await this.ch.query({
            query: `
                SELECT
                    session_id,
                    count() AS trace_count,
                    sum(input_tokens + output_tokens) AS total_tokens,
                    min(started_at) AS first_seen,
                    max(started_at) AS last_seen
                FROM ${this.database}.ai_traces FINAL
                WHERE app_id = {appId:String} AND session_id != ''
                GROUP BY session_id
                ORDER BY last_seen DESC
                LIMIT {limit:UInt32} OFFSET {offset:UInt32}
            `,
            query_params: { appId, limit, offset },
            format: 'JSONEachRow',
        })
        return result.json()
    }

    async getCostAggregation(appId: string, from?: string, to?: string) {
        const fromDt = from ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        const toDt = to ?? new Date().toISOString()

        const result = await this.ch.query({
            query: `
                SELECT
                    model,
                    provider,
                    JSONExtractString(metadata, 'costCurrency') AS cost_currency,
                    count() AS trace_count,
                    sum(input_tokens) AS total_input_tokens,
                    sum(output_tokens) AS total_output_tokens,
                    sum(total_cost) AS total_cost
                FROM ${this.database}.ai_traces FINAL
                WHERE app_id = {appId:String}
                  AND started_at >= parseDateTime64BestEffort({from:String})
                  AND started_at <= parseDateTime64BestEffort({to:String})
                GROUP BY model, provider, cost_currency
                ORDER BY cost_currency ASC, total_cost DESC
            `,
            query_params: { appId, from: fromDt, to: toDt },
            format: 'JSONEachRow',
        })
        const rows = (await result.json()) as Array<Record<string, unknown>>
        return Array.isArray(rows)
            ? rows.map(row => {
                  const cost = this.resolveCost({
                      model: row.model,
                      provider: row.provider,
                      inputTokens: row.total_input_tokens,
                      outputTokens: row.total_output_tokens,
                      totalCost: row.total_cost,
                      costCurrency: row.cost_currency,
                  })

                  return {
                      ...row,
                      total_cost: cost.totalCost,
                      cost_currency: cost.costCurrency,
                      cost_available: cost.costAvailable,
                      cost_source: cost.costSource,
                  }
              })
            : []
    }

    async listEvaluations(appId: string, limit = 50, offset = 0) {
        const [feedbackResult, evaluationsResult] = await Promise.all([
            this.ch.query({
                query: `
                    SELECT
                        toString(id) AS evaluation_id,
                        trace_id,
                        name,
                        value,
                        if(value >= 0.5, 'positive', 'negative') AS label,
                        comment,
                        source,
                        created_at
                    FROM ${this.database}.ai_feedback
                    WHERE app_id = {appId:String}
                    ORDER BY created_at DESC
                    LIMIT {limit:UInt32} OFFSET {offset:UInt32}
                `,
                query_params: { appId, limit, offset },
                format: 'JSONEachRow',
            }),
            this.ch.query({
                query: `
                    SELECT
                        toString(eval_id) AS evaluation_id,
                        trace_id,
                        metric AS name,
                        score AS value,
                        evaluator AS label,
                        '' AS comment,
                        evaluator AS source,
                        created_at
                    FROM ${this.database}.ai_evaluations
                    WHERE app_id = {appId:String}
                    ORDER BY created_at DESC
                    LIMIT {limit:UInt32} OFFSET {offset:UInt32}
                `,
                query_params: { appId, limit, offset },
                format: 'JSONEachRow',
            }),
        ])

        const [feedbacks, evaluations] = await Promise.all([feedbackResult.json(), evaluationsResult.json()])
        const traceNamesResult = await this.ch.query({
            query: `
                SELECT trace_id, name
                FROM ${this.database}.ai_traces FINAL
                WHERE app_id = {appId:String}
            `,
            query_params: { appId },
            format: 'JSONEachRow',
        })
        const traceNames = new Map<string, string>()
        for (const row of ((await traceNamesResult.json()) as Record<string, unknown>[]) ?? []) {
            traceNames.set(String(row.trace_id ?? ''), String(row.name ?? ''))
        }

        return [...((feedbacks as Record<string, unknown>[]) ?? []), ...((evaluations as Record<string, unknown>[]) ?? [])]
            .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
            .slice(0, limit)
            .map(item => ({
                ...item,
                trace_name: traceNames.get(String(item.trace_id ?? '')) ?? '',
            }))
    }

    async addScore(traceId: string, appId: string, body: { name: string; value: number; comment?: string }) {
        await this.ch.insert({
            table: `${this.database}.ai_feedback`,
            values: [
                {
                    trace_id: traceId,
                    span_id: '',
                    app_id: appId,
                    name: body.name,
                    value: body.value,
                    comment: body.comment ?? '',
                    source: 'ui',
                    created_at: formatDateTimeForCH(new Date()),
                },
            ],
            format: 'JSONEachRow',
        })
        return { success: true }
    }

    async listUsers(appId: string, limit = 50, offset = 0) {
        const result = await this.ch.query({
            query: `
                SELECT
                    user_id,
                    count() AS trace_count,
                    uniqExact(session_id) AS session_count,
                    sum(input_tokens + output_tokens) AS total_tokens,
                    min(started_at) AS first_seen,
                    max(started_at) AS last_seen
                FROM ${this.database}.ai_traces FINAL
                WHERE app_id = {appId:String} AND user_id != ''
                GROUP BY user_id
                ORDER BY last_seen DESC
                LIMIT {limit:UInt32} OFFSET {offset:UInt32}
            `,
            query_params: { appId, limit, offset },
            format: 'JSONEachRow',
        })
        return result.json()
    }

    async getDiagnostics(traceId: string, appId: string) {
        const detail = await this.getTraceDetail(traceId, appId)
        const trace = detail.trace as Record<string, unknown> | null
        const traceStartedAt = trace?.started_at ? new Date(String(trace.started_at)) : new Date()
        const from = new Date(traceStartedAt.getTime() - 5 * 60 * 1000).toISOString()
        const to = new Date(traceStartedAt.getTime() + 15 * 60 * 1000).toISOString()

        const [streamingNetworkResult, streamingSemanticResult] = await Promise.all([
            this.ch.query({
                query: `
                    SELECT
                        JSONExtractString(toJSONString(info), 'traceId') AS trace_id,
                        JSONExtractString(toJSONString(info), 'url') AS url,
                        JSONExtractString(toJSONString(info), 'method') AS method,
                        JSONExtractInt(toJSONString(info), 'status') AS status,
                        JSONExtractFloat(toJSONString(info), 'sseTtfb') AS sse_ttfb,
                        JSONExtractFloat(toJSONString(info), 'sseTtlb') AS sse_ttlb,
                        JSONExtractInt(toJSONString(info), 'stallCount') AS stall_count,
                        JSONExtractInt(toJSONString(info), 'chunkCount') AS chunk_count,
                        JSONExtractBool(toJSONString(info), 'aborted') AS aborted,
                        JSONExtractString(toJSONString(info), 'failureStage') AS failure_stage,
                        JSONExtractString(toJSONString(info), 'completionReason') AS completion_reason,
                        JSONExtractString(toJSONString(info), 'errorMessage') AS error_message,
                        JSONExtractString(toJSONString(info), 'path') AS path,
                        JSONExtractString(toJSONString(info), 'replayId') AS replay_id,
                        created_at
                    FROM ${this.database}.base_monitor_view
                    WHERE app_id = {appId:String}
                      AND event_type = 'ai_streaming'
                      AND JSONExtractString(toJSONString(info), 'layer') = 'network'
                      AND JSONExtractString(toJSONString(info), 'traceId') = {traceId:String}
                    ORDER BY created_at DESC
                    LIMIT 1
                `,
                query_params: { appId, traceId },
                format: 'JSONEachRow',
            }),
            this.ch.query({
                query: `
                    SELECT
                        JSONExtractString(toJSONString(info), 'traceId') AS trace_id,
                        JSONExtractString(toJSONString(info), 'ai', 'model') AS model,
                        JSONExtractString(toJSONString(info), 'ai', 'provider') AS provider,
                        JSONExtractInt(toJSONString(info), 'ai', 'usage', 'inputTokens') AS input_tokens,
                        JSONExtractInt(toJSONString(info), 'ai', 'usage', 'outputTokens') AS output_tokens,
                        JSONExtractFloat(toJSONString(info), 'durationMs') AS duration_ms
                    FROM ${this.database}.base_monitor_view
                    WHERE app_id = {appId:String}
                      AND event_type = 'ai_streaming'
                      AND JSONExtractString(toJSONString(info), 'layer') = 'semantic'
                      AND JSONExtractString(toJSONString(info), 'traceId') = {traceId:String}
                    ORDER BY created_at DESC
                    LIMIT 1
                `,
                query_params: { appId, traceId },
                format: 'JSONEachRow',
            }),
        ])

        const streamingNetwork = ((await streamingNetworkResult.json()) as Record<string, unknown>[])[0] ?? null
        const streamingSemantic = ((await streamingSemanticResult.json()) as Record<string, unknown>[])[0] ?? null
        const path = String(streamingNetwork?.path ?? '')
        const replayId = String(streamingNetwork?.replay_id ?? '')

        const [errorsResult, replayResult, performanceResult] = await Promise.all([
            this.ch.query({
                query: `
                    SELECT
                        message,
                        toJSONString(info) AS info_json,
                        created_at
                    FROM ${this.database}.base_monitor_storage
                    WHERE app_id = {appId:String}
                      AND event_type = 'error'
                      AND (
                        ({replayId:String} != '' AND JSONExtractString(toJSONString(info), 'replayId') = {replayId:String})
                        OR ({path:String} != '' AND JSONExtractString(toJSONString(info), 'path') = {path:String}
                            AND created_at >= parseDateTime64BestEffort({from:String})
                            AND created_at <= parseDateTime64BestEffort({to:String}))
                      )
                    ORDER BY created_at DESC
                    LIMIT 10
                `,
                query_params: { appId, replayId, path, from, to },
                format: 'JSONEachRow',
            }),
            replayId
                ? this.ch.query({
                      query: `
                        SELECT
                            JSONExtractString(toJSONString(info), 'replayId') AS replay_id,
                            JSONExtractString(toJSONString(info), 'path') AS path,
                            JSONExtractString(toJSONString(info), 'url') AS url,
                            created_at
                        FROM ${this.database}.base_monitor_view
                        WHERE app_id = {appId:String}
                          AND event_type = 'replay'
                          AND JSONExtractString(toJSONString(info), 'replayId') = {replayId:String}
                        ORDER BY created_at DESC
                        LIMIT 1
                    `,
                      query_params: { appId, replayId },
                      format: 'JSONEachRow',
                  })
                : Promise.resolve({
                      json: async () => [],
                  } as { json: () => Promise<Record<string, unknown>[]> }),
            this.ch.query({
                query: `
                    SELECT
                        event_type,
                        count() AS count
                    FROM ${this.database}.base_monitor_storage
                    WHERE app_id = {appId:String}
                      AND event_type IN ('performance', 'webvital')
                      AND ({path:String} = '' OR JSONExtractString(toJSONString(info), 'path') = {path:String})
                      AND created_at >= parseDateTime64BestEffort({from:String})
                      AND created_at <= parseDateTime64BestEffort({to:String})
                    GROUP BY event_type
                `,
                query_params: { appId, path, from, to },
                format: 'JSONEachRow',
            }),
        ])

        const errorRows = ((await errorsResult.json()) as Record<string, unknown>[]) ?? []
        const replayRows = ((await replayResult.json()) as Record<string, unknown>[]) ?? []
        const performanceRows = ((await performanceResult.json()) as Record<string, unknown>[]) ?? []

        return {
            trace: detail.trace,
            streaming: streamingNetwork
                ? {
                      traceId,
                      url: String(streamingNetwork.url ?? ''),
                      method: String(streamingNetwork.method ?? ''),
                      status: Number(streamingNetwork.status ?? 0),
                      sseTtfb: Number(streamingNetwork.sse_ttfb ?? 0),
                      sseTtlb: Number(streamingNetwork.sse_ttlb ?? 0),
                      stallCount: Number(streamingNetwork.stall_count ?? 0),
                      chunkCount: Number(streamingNetwork.chunk_count ?? 0),
                      aborted: Boolean(streamingNetwork.aborted ?? false),
                      failureStage: String(streamingNetwork.failure_stage ?? '') || null,
                      completionReason: String(streamingNetwork.completion_reason ?? '') || null,
                      errorMessage: String(streamingNetwork.error_message ?? '') || null,
                      path,
                      replayId: replayId || null,
                      createdAt: streamingNetwork.created_at ? new Date(String(streamingNetwork.created_at)).toISOString() : null,
                      model: streamingSemantic ? String(streamingSemantic.model ?? '') || null : null,
                      provider: streamingSemantic ? String(streamingSemantic.provider ?? '') || null : null,
                      inputTokens: streamingSemantic ? Number(streamingSemantic.input_tokens ?? 0) : null,
                      outputTokens: streamingSemantic ? Number(streamingSemantic.output_tokens ?? 0) : null,
                      durationMs: streamingSemantic ? Number(streamingSemantic.duration_ms ?? 0) : null,
                  }
                : null,
            errors: errorRows.map(row => ({
                message: String(row.message ?? ''),
                createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null,
                info: this.parseJsonString(row.info_json),
            })),
            replay: replayRows[0]
                ? {
                      replayId: String(replayRows[0].replay_id ?? ''),
                      path: String(replayRows[0].path ?? '') || null,
                      url: String(replayRows[0].url ?? '') || null,
                      createdAt: replayRows[0].created_at ? new Date(String(replayRows[0].created_at)).toISOString() : null,
                  }
                : null,
            performance: performanceRows.reduce(
                (acc, row) => ({
                    ...acc,
                    [String(row.event_type ?? 'unknown')]: Number(row.count ?? 0),
                }),
                {} as Record<string, number>
            ),
        }
    }

    async listPrompts(appId: string) {
        const [prompts, versions] = await Promise.all([
            this.promptRepository.find({ where: { appId }, order: { updatedAt: 'DESC', createdAt: 'DESC' } }),
            this.promptVersionRepository.find({ where: { appId }, order: { createdAt: 'DESC' } }),
        ])
        const versionsByPrompt = new Map<number, AIPromptVersionEntity[]>()
        for (const version of versions) {
            const items = versionsByPrompt.get(version.promptId) ?? []
            items.push(version)
            versionsByPrompt.set(version.promptId, items)
        }
        return prompts.map(prompt => ({
            ...prompt,
            labels: this.parseJsonString(prompt.labels),
            versionCount: versionsByPrompt.get(prompt.id)?.length ?? 0,
            latestVersion: versionsByPrompt.get(prompt.id)?.[0] ?? null,
        }))
    }

    async createPrompt(
        appId: string,
        body: {
            name: string
            description?: string
            labels?: string[]
            template?: string
            metadata?: JsonMap
            modelConfig?: JsonMap
        }
    ) {
        const prompt = await this.promptRepository.save(
            this.promptRepository.create({
                appId,
                name: body.name.trim(),
                description: body.description?.trim() || null,
                labels: JSON.stringify(body.labels ?? []),
                updatedAt: new Date(),
            })
        )

        if (body.template?.trim()) {
            const version = await this.createPromptVersion(appId, prompt.id, {
                template: body.template,
                metadata: body.metadata,
                modelConfig: body.modelConfig,
                setActive: true,
            })
            prompt.activeVersionId = version.id
            await this.promptRepository.save(prompt)
        }

        return {
            ...prompt,
            labels: this.parseJsonString(prompt.labels),
        }
    }

    async listPromptVersions(appId: string, promptId: number) {
        const prompt = await this.ensurePrompt(appId, promptId)
        const versions = await this.promptVersionRepository.find({
            where: { appId, promptId },
            order: { createdAt: 'DESC' },
        })
        return versions.map(version => ({
            ...version,
            isActive: prompt.activeVersionId === version.id,
            metadata: this.parseJsonString(version.metadata),
            modelConfig: this.parseJsonString(version.modelConfig),
        }))
    }

    async createPromptVersion(
        appId: string,
        promptId: number,
        body: {
            version?: string
            template: string
            metadata?: JsonMap
            modelConfig?: JsonMap
            setActive?: boolean
        }
    ) {
        const prompt = await this.ensurePrompt(appId, promptId)
        const requestedVersion = body.version?.trim() || ''
        if (requestedVersion) {
            const existingVersion = await this.promptVersionRepository.findOne({
                where: { appId, promptId, version: requestedVersion },
            })
            if (existingVersion) {
                throw new ConflictException(`Prompt version "${requestedVersion}" already exists. Create a new revision instead.`)
            }
        }

        const existingCount = await this.promptVersionRepository.count({ where: { appId, promptId } })
        let resolvedVersion = requestedVersion
        if (!resolvedVersion) {
            let candidate = existingCount + 1
            while (
                await this.promptVersionRepository.findOne({
                    where: { appId, promptId, version: `v${candidate}` },
                })
            ) {
                candidate += 1
            }
            resolvedVersion = `v${candidate}`
        }

        const version = await this.promptVersionRepository.save(
            this.promptVersionRepository.create({
                appId,
                promptId,
                version: resolvedVersion,
                template: body.template.trim(),
                metadata: JSON.stringify(body.metadata ?? {}),
                modelConfig: JSON.stringify(body.modelConfig ?? {}),
            })
        )

        if (body.setActive || prompt.activeVersionId == null) {
            prompt.activeVersionId = version.id
        }
        prompt.updatedAt = new Date()
        await this.promptRepository.save(prompt)

        return {
            ...version,
            metadata: this.parseJsonString(version.metadata),
            modelConfig: this.parseJsonString(version.modelConfig),
        }
    }

    async activatePromptVersion(appId: string, promptId: number, versionId: number) {
        const prompt = await this.ensurePrompt(appId, promptId)
        const version = await this.promptVersionRepository.findOne({ where: { id: versionId, appId, promptId } })
        if (!version) throw new NotFoundException('Prompt version not found')

        prompt.activeVersionId = version.id
        prompt.updatedAt = new Date()
        await this.promptRepository.save(prompt)

        return {
            ...version,
            isActive: true,
            metadata: this.parseJsonString(version.metadata),
            modelConfig: this.parseJsonString(version.modelConfig),
        }
    }

    async rejectPromptVersionMutation() {
        throw new ConflictException('Prompt versions are immutable. Create a new version instead of editing or deleting history.')
    }

    async listDatasets(appId: string) {
        const [datasets, itemCounts] = await Promise.all([
            this.datasetRepository.find({ where: { appId }, order: { updatedAt: 'DESC', createdAt: 'DESC' } }),
            this.datasetItemRepository
                .createQueryBuilder('item')
                .select('item.datasetId', 'datasetId')
                .addSelect('COUNT(*)', 'count')
                .where('item.appId = :appId', { appId })
                .groupBy('item.datasetId')
                .getRawMany<{ datasetId: string; count: string }>(),
        ])
        const countMap = new Map(itemCounts.map(item => [Number(item.datasetId), Number(item.count)]))
        return datasets.map(dataset => ({
            ...dataset,
            itemCount: countMap.get(dataset.id) ?? 0,
        }))
    }

    async createDataset(appId: string, body: { name: string; description?: string }) {
        return this.datasetRepository.save(
            this.datasetRepository.create({
                appId,
                name: body.name.trim(),
                description: body.description?.trim() || null,
                updatedAt: new Date(),
            })
        )
    }

    async listDatasetItems(appId: string, datasetId: number) {
        await this.ensureDataset(appId, datasetId)
        const items = await this.datasetItemRepository.find({
            where: { appId, datasetId },
            order: { createdAt: 'DESC' },
        })
        return items.map(item => ({
            ...item,
            metadata: this.parseJsonString(item.metadata),
        }))
    }

    async createDatasetItem(
        appId: string,
        datasetId: number,
        body: { name?: string; input: string; expectedOutput?: string; metadata?: JsonMap }
    ) {
        await this.ensureDataset(appId, datasetId)
        return {
            ...(await this.datasetItemRepository.save(
                this.datasetItemRepository.create({
                    appId,
                    datasetId,
                    name: body.name?.trim() || null,
                    input: body.input,
                    expectedOutput: body.expectedOutput ?? null,
                    metadata: JSON.stringify(body.metadata ?? {}),
                })
            )),
            metadata: body.metadata ?? {},
        }
    }

    async listExperiments(appId: string) {
        return this.experimentRepository.find({
            where: { appId },
            order: { updatedAt: 'DESC', createdAt: 'DESC' },
        })
    }

    async createExperiment(
        appId: string,
        body: { name: string; description?: string; promptId?: number; promptVersionId?: number; datasetId?: number; evaluator?: string }
    ) {
        if (body.promptId) await this.ensurePrompt(appId, body.promptId)
        if (body.datasetId) await this.ensureDataset(appId, body.datasetId)
        return this.experimentRepository.save(
            this.experimentRepository.create({
                appId,
                name: body.name.trim(),
                description: body.description?.trim() || null,
                promptId: body.promptId ?? null,
                promptVersionId: body.promptVersionId ?? null,
                datasetId: body.datasetId ?? null,
                evaluator: body.evaluator?.trim() || 'manual',
                updatedAt: new Date(),
            })
        )
    }

    async listExperimentRuns(appId: string, experimentId: number) {
        await this.ensureExperiment(appId, experimentId)
        const runs = await this.experimentRunRepository.find({
            where: { appId, experimentId },
            order: { createdAt: 'DESC' },
        })
        return runs.map(run => ({
            ...run,
            summary: this.parseJsonString(run.summary),
        }))
    }

    async createExperimentRun(
        appId: string,
        experimentId: number,
        body: { status?: string; traceId?: string; summary?: JsonMap; completedAt?: string }
    ) {
        await this.ensureExperiment(appId, experimentId)
        const completedAt = body.completedAt ? new Date(body.completedAt) : body.status === 'completed' ? new Date() : null
        return {
            ...(await this.experimentRunRepository.save(
                this.experimentRunRepository.create({
                    appId,
                    experimentId,
                    status: body.status?.trim() || 'draft',
                    traceId: body.traceId?.trim() || null,
                    summary: JSON.stringify(body.summary ?? {}),
                    completedAt,
                })
            )),
            summary: body.summary ?? {},
        }
    }

    private normalizeTraceStatus(status?: string) {
        if (!status || status === 'all') return 'all'
        return status === 'success' ? 'ok' : status
    }

    private mergeScores(feedbacks: Record<string, unknown>[], evaluations: Record<string, unknown>[]) {
        return [
            ...feedbacks.map(item => ({
                score_id: String(item.id ?? ''),
                name: String(item.name ?? ''),
                value: Number(item.value ?? 0),
                comment: String(item.comment ?? ''),
                created_at: String(item.created_at ?? ''),
                source: String(item.source ?? 'sdk'),
            })),
            ...evaluations.map(item => ({
                score_id: String(item.eval_id ?? ''),
                name: String(item.metric ?? item.evaluator ?? ''),
                value: Number(item.score ?? 0),
                comment: '',
                created_at: String(item.created_at ?? ''),
                source: String(item.evaluator ?? 'sdk'),
            })),
        ].sort((a, b) => b.created_at.localeCompare(a.created_at))
    }

    private parseJsonString(value: unknown) {
        if (typeof value !== 'string' || !value.trim()) return {}
        try {
            return JSON.parse(value) as JsonMap
        } catch {
            return {}
        }
    }

    private async ensurePrompt(appId: string, promptId: number) {
        const prompt = await this.promptRepository.findOne({ where: { id: promptId, appId } })
        if (!prompt) throw new NotFoundException('Prompt not found')
        return prompt
    }

    private async ensureDataset(appId: string, datasetId: number) {
        const dataset = await this.datasetRepository.findOne({ where: { id: datasetId, appId } })
        if (!dataset) throw new NotFoundException('Dataset not found')
        return dataset
    }

    private async ensureExperiment(appId: string, experimentId: number) {
        const experiment = await this.experimentRepository.findOne({ where: { id: experimentId, appId } })
        if (!experiment) throw new NotFoundException('Experiment not found')
        return experiment
    }
}
