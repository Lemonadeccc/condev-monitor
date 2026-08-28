import { ClickHouseClient } from '@clickhouse/client'
import {
    type AnimationRumV2KafkaEnvelope,
    type AnimationRumV3KafkaEnvelope,
    createAnimationRumV2ClickHouseInsertPlan,
    createAnimationRumV3ClickHouseInsertPlan,
} from '@condev-monitor/animation-rum-ingest'
import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { AnimationRumV1Report } from '../../shared/animation-rum-v1'
import { resolveClickhouseDatabase } from '../../shared/clickhouse-utils'
import { formatDateTimeForCH } from '../../shared/datetime'

export type AnimationRumInsert = {
    appId: string
    report: AnimationRumV1Report
    receivedAt: string
}

function json(value: unknown): string {
    return JSON.stringify(value)
}

function capturedAtForStorage(report: AnimationRumV1Report, receivedAt: string): string {
    const parsed = new Date(report.capturedAt)
    return formatDateTimeForCH(Number.isFinite(parsed.getTime()) ? parsed : new Date(receivedAt))
}

@Injectable()
export class AnimationRumClickhouseService {
    private readonly database: string

    constructor(
        @Inject('CLICKHOUSE_CLIENT') private readonly clickhouseClient: ClickHouseClient,
        config: ConfigService
    ) {
        this.database = resolveClickhouseDatabase(config)
    }

    async insertBatch(items: AnimationRumInsert[]): Promise<void> {
        if (items.length === 0) return

        const metricRows = items.flatMap(({ appId, report, receivedAt }) => {
            const capturedAt = capturedAtForStorage(report, receivedAt)
            const received = formatDateTimeForCH(new Date(receivedAt))
            return report.metrics.map(metric => ({
                event_id: report.eventId,
                capture_id: report.captureId,
                app_id: appId,
                captured_at: capturedAt,
                received_at: received,
                release: report.release,
                dist: report.dist,
                environment: report.environment,
                sample_rate: report.sampleRate,
                sampling_policy_version: report.samplingPolicyVersion,
                route_key: report.context.routeKey ?? '',
                runtime_family: report.context.runtimeFamily ?? 'unknown',
                family: metric.family,
                name: metric.name,
                stat: metric.stat,
                unit: metric.unit,
                value: metric.value,
                samples: metric.samples,
                status: metric.status,
            }))
        })

        // Insert children first. A capture row is the completion marker; retries
        // are safe because both tables use deterministic ReplacingMergeTree keys.
        await this.clickhouseClient.insert({
            table: `${this.database}.animation_rum_metrics_v1`,
            format: 'JSONEachRow',
            values: metricRows,
        })

        await this.clickhouseClient.insert({
            table: `${this.database}.animation_rum_captures_v1`,
            format: 'JSONEachRow',
            values: items.map(({ appId, report, receivedAt }) => ({
                event_id: report.eventId,
                capture_id: report.captureId,
                app_id: appId,
                contract_version: report.contractVersion,
                snapshot_schema_version: report.snapshotSchemaVersion,
                captured_at: capturedAtForStorage(report, receivedAt),
                received_at: formatDateTimeForCH(new Date(receivedAt)),
                release: report.release,
                dist: report.dist,
                environment: report.environment,
                sdk_version: report.sdkVersion,
                monitor_version: report.monitorVersion,
                sample_rate: report.sampleRate,
                sampling_policy_version: report.samplingPolicyVersion,
                route_key: report.context.routeKey ?? '',
                runtime_family: report.context.runtimeFamily ?? 'unknown',
                context_json: json(report.context),
                capabilities_json: json(report.capabilities),
                coverage_json: json(report.coverage),
                metric_count: report.metrics.length,
            })),
        })
    }

    async insertV2(envelope: AnimationRumV2KafkaEnvelope): Promise<void> {
        const plan = createAnimationRumV2ClickHouseInsertPlan(envelope)

        // The shared plan validates the full closed payload before the first
        // write. Keep inserts sequential so the capture completion marker is
        // written only after every child row succeeds.
        for (const step of plan) {
            await this.clickhouseClient.insert<unknown>({
                table: `${this.database}.${step.table}`,
                format: 'JSONEachRow',
                values: step.rows,
            })
        }
    }

    async insertV3SoftNavigation(envelope: AnimationRumV3KafkaEnvelope): Promise<void> {
        const plan = createAnimationRumV3ClickHouseInsertPlan(envelope)

        // The v3 projector validates the whole closed report before the first
        // write. Child rows precede the capture completion marker, making an
        // interrupted fallback safe to replay through ReplacingMergeTree.
        for (const step of plan) {
            await this.clickhouseClient.insert<unknown>({
                table: `${this.database}.${step.table}`,
                format: 'JSONEachRow',
                values: step.rows,
            })
        }
    }
}
