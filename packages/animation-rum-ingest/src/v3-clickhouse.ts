import {
    ANIMATION_RUM_V3_CAPABILITY,
    ANIMATION_RUM_V3_EVIDENCE_WINDOW,
    ANIMATION_RUM_V3_METRIC_CATALOG,
    ANIMATION_RUM_V3_PROVIDER_OWNER,
    type AnimationRumV3MetricStatus,
} from '@condev-monitor/animation-rum-contract'

import {
    type AnimationRumV3KafkaEnvelope,
    type AnimationRumV3KafkaEnvelopeValidationOptions,
    validateAnimationRumV3KafkaEnvelope,
} from './v3-envelope'
import { AnimationRumV3IngestValidationError } from './v3-errors'

interface AnimationRumV3ClickHouseDimensions {
    event_id: string
    capture_id: string
    app_id: string
    capture_kind: 'soft-navigation'
    scope: 'page'
    captured_at: string
    received_at: string
    release: string
    dist: string
    environment: string
    route_key: string
    runtime_framework: string
    runtime_renderer: string
    runtime_backend: string
    window_duration_ms: number
    window_duration_capped: 0 | 1
}

export interface AnimationRumV3ProviderEvidenceRow extends AnimationRumV3ClickHouseDimensions {
    owner: typeof ANIMATION_RUM_V3_PROVIDER_OWNER
    family: 'userOutcome'
    provider_version: string
    accepted: number
    retained: number
    evidence: number
    dropped: number
    rejected: number
    truncated: 0 | 1
}

export interface AnimationRumV3MetricRow extends AnimationRumV3ClickHouseDimensions {
    sample_rate: number
    sampling_policy_version: number
    metric_id: string
    vital_name: 'CLS' | 'INP' | 'LCP'
    unit: 'ratio' | 'ms'
    evidence_window: typeof ANIMATION_RUM_V3_EVIDENCE_WINDOW
    relation: 'page-window'
    owner: typeof ANIMATION_RUM_V3_PROVIDER_OWNER
    value: number | null
    samples: 1 | null
    status: AnimationRumV3MetricStatus
}

export interface AnimationRumV3CaptureRow extends AnimationRumV3ClickHouseDimensions {
    contract_version: 3
    snapshot_schema_version: 1
    sdk_version: string
    monitor_version: string
    sample_rate: number
    sampling_policy_version: number
    visibility_state: string
    reduced_motion: 0 | 1 | null
    viewport_bucket: string
    dpr_bucket: string
    refresh_hz: number | null
    refresh_budget_source: string
    refresh_budget_confidence: string
    capabilities_json: string
    coverage_json: string
    capture_sufficiency: string
    capture_integrity: string
    capture_quality_reasons: string[]
    provider_evidence_count: 1
    metric_count: 3
}

export interface AnimationRumV3Rows {
    providerRows: [AnimationRumV3ProviderEvidenceRow]
    metricRows: [AnimationRumV3MetricRow, AnimationRumV3MetricRow, AnimationRumV3MetricRow]
    captureRow: AnimationRumV3CaptureRow
}

export type AnimationRumV3ClickHouseInsertBatch =
    | {
          kind: 'provider-evidence'
          table: 'animation_rum_soft_navigation_provider_evidence_v3'
          rows: [AnimationRumV3ProviderEvidenceRow]
      }
    | {
          kind: 'metrics'
          table: 'animation_rum_soft_navigation_metrics_v3'
          rows: [AnimationRumV3MetricRow, AnimationRumV3MetricRow, AnimationRumV3MetricRow]
      }
    | {
          kind: 'capture-completion'
          table: 'animation_rum_soft_navigation_captures_v3'
          rows: [AnimationRumV3CaptureRow]
      }

function formatClickHouseDateTime(isoTimestamp: string): string {
    return new Date(Date.parse(isoTimestamp)).toISOString().replace('T', ' ').replace('Z', '')
}

function captureDimensions(envelope: AnimationRumV3KafkaEnvelope): AnimationRumV3ClickHouseDimensions {
    const report = envelope.info.animationSoftNavigationRum
    const runtime = report.context.runtime
    return {
        event_id: report.eventId,
        capture_id: report.captureId,
        app_id: envelope.appId,
        capture_kind: report.captureKind,
        scope: report.scope,
        captured_at: formatClickHouseDateTime(report.capturedAt),
        received_at: formatClickHouseDateTime(envelope.receivedAt),
        release: report.release,
        dist: report.dist,
        environment: report.environment,
        route_key: report.context.routeKey,
        runtime_framework: runtime.framework,
        runtime_renderer: runtime.renderer,
        runtime_backend: runtime.backend,
        window_duration_ms: report.context.windowDurationMs,
        window_duration_capped: report.context.windowDurationCapped ? 1 : 0,
    }
}

/** Projects only validated v3 fields and derives all metric identity from the registry. */
export function projectAnimationRumV3Rows(
    inboundEnvelope: AnimationRumV3KafkaEnvelope,
    options: Pick<AnimationRumV3KafkaEnvelopeValidationOptions, 'nowEpochMs'> = {}
): AnimationRumV3Rows {
    const validation = validateAnimationRumV3KafkaEnvelope(inboundEnvelope, options)
    if (!validation.ok) throw new AnimationRumV3IngestValidationError(validation.errors)
    const envelope = validation.value
    const report = envelope.info.animationSoftNavigationRum
    const dimensions = captureDimensions(envelope)
    const capability = report.capabilities[ANIMATION_RUM_V3_CAPABILITY]
    const provider = report.providerEvidence[ANIMATION_RUM_V3_PROVIDER_OWNER].userOutcome
    const capabilities = {
        [ANIMATION_RUM_V3_CAPABILITY]: {
            status: capability.status,
            metrics: { CLS: capability.metrics.CLS, INP: capability.metrics.INP, LCP: capability.metrics.LCP },
        },
    }
    const coverage = {
        userOutcome: {
            status: report.coverage.userOutcome.status,
            evidenceLevel: report.coverage.userOutcome.evidenceLevel,
        },
    }
    const providerRow: AnimationRumV3ProviderEvidenceRow = {
        ...dimensions,
        owner: ANIMATION_RUM_V3_PROVIDER_OWNER,
        family: 'userOutcome',
        provider_version: provider.version,
        accepted: provider.accepted,
        retained: provider.retained,
        evidence: provider.evidence,
        dropped: provider.dropped,
        rejected: provider.rejected,
        truncated: provider.truncated ? 1 : 0,
    }
    const metricRows = report.metrics.map(metric => {
        const definition = ANIMATION_RUM_V3_METRIC_CATALOG.find(candidate => candidate.metricId === metric.metricId)
        if (!definition) throw new Error('Validated Animation RUM v3 metric is missing from the canonical registry')
        return {
            ...dimensions,
            sample_rate: report.sampleRate,
            sampling_policy_version: report.samplingPolicyVersion,
            metric_id: definition.metricId,
            vital_name: definition.vitalName,
            unit: definition.unit,
            evidence_window: definition.evidenceWindow,
            relation: definition.relation,
            owner: definition.owner,
            value: metric.value,
            samples: metric.samples,
            status: metric.status,
        }
    }) as AnimationRumV3Rows['metricRows']
    if (metricRows.length !== ANIMATION_RUM_V3_METRIC_CATALOG.length) {
        throw new Error('Validated Animation RUM v3 report does not contain the canonical metric set')
    }

    return {
        providerRows: [providerRow],
        metricRows,
        captureRow: {
            ...dimensions,
            contract_version: report.contractVersion,
            snapshot_schema_version: report.snapshotSchemaVersion,
            sdk_version: report.sdkVersion,
            monitor_version: report.monitorVersion,
            sample_rate: report.sampleRate,
            sampling_policy_version: report.samplingPolicyVersion,
            visibility_state: report.context.visibilityState ?? 'unknown',
            reduced_motion:
                report.context.reducedMotion === null || report.context.reducedMotion === undefined
                    ? null
                    : report.context.reducedMotion
                      ? 1
                      : 0,
            viewport_bucket: report.context.viewportBucket ?? 'unknown',
            dpr_bucket: report.context.dprBucket ?? 'unknown',
            refresh_hz: report.context.refreshHz ?? null,
            refresh_budget_source: report.context.refreshBudgetSource ?? 'unknown',
            refresh_budget_confidence: report.context.refreshBudgetConfidence ?? 'unknown',
            capabilities_json: JSON.stringify(capabilities),
            coverage_json: JSON.stringify(coverage),
            capture_sufficiency: report.captureQuality.sufficiency,
            capture_integrity: report.captureQuality.integrity,
            capture_quality_reasons: [...report.captureQuality.reasons],
            provider_evidence_count: 1,
            metric_count: 3,
        },
    }
}

/** Child rows are safe to retry; the capture row is the completion marker and is always last. */
export function createAnimationRumV3ClickHouseInsertPlan(
    envelope: AnimationRumV3KafkaEnvelope,
    options: Pick<AnimationRumV3KafkaEnvelopeValidationOptions, 'nowEpochMs'> = {}
): AnimationRumV3ClickHouseInsertBatch[] {
    const rows = projectAnimationRumV3Rows(envelope, options)
    return [
        {
            kind: 'provider-evidence',
            table: 'animation_rum_soft_navigation_provider_evidence_v3',
            rows: rows.providerRows,
        },
        { kind: 'metrics', table: 'animation_rum_soft_navigation_metrics_v3', rows: rows.metricRows },
        {
            kind: 'capture-completion',
            table: 'animation_rum_soft_navigation_captures_v3',
            rows: [rows.captureRow],
        },
    ]
}
