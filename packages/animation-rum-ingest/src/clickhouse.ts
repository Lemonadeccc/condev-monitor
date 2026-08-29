import {
    ANIMATION_RUM_FAMILIES,
    ANIMATION_RUM_V2_CAPABILITIES,
    ANIMATION_RUM_V2_PROVIDER_OWNERS,
    ANIMATION_RUM_V2_SCHEMA_2_CAPABILITIES,
    ANIMATION_RUM_V2_SCHEMA_2_PROVIDER_OWNERS,
    type AnimationRumFamily,
    type AnimationRumV2MetricStatus,
    type AnimationRumV2ProviderOwner,
    type AnimationRumV2Relation,
    type AnimationRumV2Report,
    getAnimationRumV2MetricCatalog,
    getAnimationRumV2MetricDefinition,
} from '@condev-monitor/animation-rum-contract'

import {
    type AnimationRumV2KafkaEnvelope,
    type AnimationRumV2KafkaEnvelopeValidationOptions,
    validateAnimationRumV2KafkaEnvelope,
} from './envelope'
import { AnimationRumV2IngestValidationError } from './errors'

interface AnimationRumV2ClickHouseDimensions {
    event_id: string
    capture_id: string
    app_id: string
    scope: AnimationRumV2Report['scope']
    captured_at: string
    received_at: string
    release: string
    environment: string
    route_key: string
    target_key: string
}

export interface AnimationRumV2ProviderEvidenceRow extends AnimationRumV2ClickHouseDimensions {
    owner: AnimationRumV2ProviderOwner
    family: AnimationRumFamily
    provider_version: string
    accepted: number
    retained: number
    evidence: number
    dropped: number
    rejected: number
    truncated: 0 | 1
}

export interface AnimationRumV2MetricRow extends AnimationRumV2ClickHouseDimensions {
    dist: string
    sample_rate: number
    sampling_policy_version: number
    runtime_framework: string
    runtime_renderer: string
    runtime_backend: string
    metric_id: string
    family: string
    name: string
    stat: string
    unit: string
    relation: AnimationRumV2Relation
    owner: AnimationRumV2ProviderOwner
    value: number | null
    samples: number | null
    status: AnimationRumV2MetricStatus
}

export interface AnimationRumV2CaptureRow extends AnimationRumV2ClickHouseDimensions {
    parent_capture_id: string
    contract_version: 2
    snapshot_schema_version: 1 | 2
    dist: string
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
    window_duration_ms: number
    window_duration_capped: 0 | 1
    runtime_framework: string
    runtime_renderer: string
    runtime_backend: string
    capabilities_json: string
    coverage_json: string
    capture_sufficiency: string
    capture_integrity: string
    capture_quality_reasons: string[]
    adapter_error_count: number
    provider_evidence_count: number
    metric_count: number
}

export interface AnimationRumV2Rows {
    providerRows: AnimationRumV2ProviderEvidenceRow[]
    metricRows: AnimationRumV2MetricRow[]
    captureRow: AnimationRumV2CaptureRow
}

export type AnimationRumV2ClickHouseInsertBatch =
    | {
          kind: 'provider-evidence'
          table: 'animation_rum_provider_evidence_v2'
          rows: AnimationRumV2ProviderEvidenceRow[]
      }
    | { kind: 'metrics'; table: 'animation_rum_metrics_v2'; rows: AnimationRumV2MetricRow[] }
    | { kind: 'capture-completion'; table: 'animation_rum_captures_v2'; rows: [AnimationRumV2CaptureRow] }

function formatClickHouseDateTime(isoTimestamp: string): string {
    return new Date(Date.parse(isoTimestamp)).toISOString().replace('T', ' ').replace('Z', '')
}

function captureDimensions(envelope: AnimationRumV2KafkaEnvelope): AnimationRumV2ClickHouseDimensions {
    const report = envelope.info.animationRum
    return {
        event_id: report.eventId,
        capture_id: report.captureId,
        app_id: envelope.appId,
        scope: report.scope,
        captured_at: formatClickHouseDateTime(report.capturedAt),
        received_at: formatClickHouseDateTime(envelope.receivedAt),
        release: report.release,
        environment: report.environment,
        route_key: report.context.routeKey ?? '',
        target_key: report.targetKey ?? '',
    }
}

/**
 * Projects only closed fields and derives metric identity from the registry.
 * Recency is a transport concern; all other report invariants are revalidated.
 */
export function projectAnimationRumV2Rows(
    inboundEnvelope: AnimationRumV2KafkaEnvelope,
    options: Pick<AnimationRumV2KafkaEnvelopeValidationOptions, 'nowEpochMs'> = {}
): AnimationRumV2Rows {
    const validation = validateAnimationRumV2KafkaEnvelope(inboundEnvelope, options)
    if (!validation.ok) throw new AnimationRumV2IngestValidationError(validation.errors)
    const envelope = validation.value
    const report = envelope.info.animationRum
    const dimensions = captureDimensions(envelope)
    const runtime = report.context.runtime
    const capabilityNames = report.snapshotSchemaVersion === 2 ? ANIMATION_RUM_V2_SCHEMA_2_CAPABILITIES : ANIMATION_RUM_V2_CAPABILITIES
    const capabilities = Object.fromEntries(capabilityNames.map(name => [name, report.capabilities[name]]))
    const coverage = Object.fromEntries(
        ANIMATION_RUM_FAMILIES.map(family => [
            family,
            { status: report.coverage[family].status, evidenceLevel: report.coverage[family].evidenceLevel },
        ])
    )
    const metricCatalog = getAnimationRumV2MetricCatalog(report.snapshotSchemaVersion)
    const metricOrder = new Map(metricCatalog.map((definition, index) => [definition.metricId, index]))
    const providerRows: AnimationRumV2ProviderEvidenceRow[] = []

    const providerOwners = report.snapshotSchemaVersion === 2 ? ANIMATION_RUM_V2_SCHEMA_2_PROVIDER_OWNERS : ANIMATION_RUM_V2_PROVIDER_OWNERS
    for (const owner of providerOwners) {
        const familyEvidence = report.providerEvidence[owner]
        if (!familyEvidence) continue
        for (const family of ANIMATION_RUM_FAMILIES) {
            const provider = familyEvidence[family]
            if (!provider) continue
            providerRows.push({
                ...dimensions,
                owner,
                family,
                provider_version: provider.version,
                accepted: provider.accepted,
                retained: provider.retained,
                evidence: provider.evidence,
                dropped: provider.dropped,
                rejected: provider.rejected,
                truncated: provider.truncated ? 1 : 0,
            })
        }
    }

    const metricRows = [...report.metrics]
        .sort((left, right) => {
            const catalogOrder =
                (metricOrder.get(left.metricId) ?? Number.MAX_SAFE_INTEGER) - (metricOrder.get(right.metricId) ?? Number.MAX_SAFE_INTEGER)
            if (catalogOrder !== 0) return catalogOrder
            if (left.relation !== right.relation) return left.relation < right.relation ? -1 : 1
            if (left.owner !== right.owner) return left.owner < right.owner ? -1 : 1
            return 0
        })
        .map(metric => {
            const definition = getAnimationRumV2MetricDefinition(metric.metricId, report.snapshotSchemaVersion)
            if (!definition) throw new Error('Validated Animation RUM v2 metric is missing from the canonical registry')
            return {
                ...dimensions,
                dist: report.dist,
                sample_rate: report.sampleRate,
                sampling_policy_version: report.samplingPolicyVersion,
                runtime_framework: runtime.framework,
                runtime_renderer: runtime.renderer,
                runtime_backend: runtime.backend,
                metric_id: definition.metricId,
                family: definition.family,
                name: definition.name,
                stat: definition.stat,
                unit: definition.unit,
                relation: metric.relation,
                owner: metric.owner,
                value: metric.value,
                samples: metric.samples,
                status: metric.status,
            }
        })
    if (metricRows.length === 0) throw new Error('Validated Animation RUM v2 report has no metric rows')

    return {
        providerRows,
        metricRows,
        captureRow: {
            ...dimensions,
            parent_capture_id: report.parentCaptureId ?? '',
            contract_version: report.contractVersion,
            snapshot_schema_version: report.snapshotSchemaVersion,
            dist: report.dist,
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
            window_duration_ms: report.context.windowDurationMs,
            window_duration_capped: report.context.windowDurationCapped ? 1 : 0,
            runtime_framework: runtime.framework,
            runtime_renderer: runtime.renderer,
            runtime_backend: runtime.backend,
            capabilities_json: JSON.stringify(capabilities),
            coverage_json: JSON.stringify(coverage),
            capture_sufficiency: report.captureQuality.sufficiency,
            capture_integrity: report.captureQuality.integrity,
            capture_quality_reasons: [...report.captureQuality.reasons],
            adapter_error_count: report.captureQuality.adapterErrorCount,
            provider_evidence_count: providerRows.length,
            metric_count: metricRows.length,
        },
    }
}

/** Child rows are safe to retry; the capture row is the completion marker and last. */
export function createAnimationRumV2ClickHouseInsertPlan(
    envelope: AnimationRumV2KafkaEnvelope,
    options: Pick<AnimationRumV2KafkaEnvelopeValidationOptions, 'nowEpochMs'> = {}
): AnimationRumV2ClickHouseInsertBatch[] {
    const rows = projectAnimationRumV2Rows(envelope, options)
    return [
        ...(rows.providerRows.length > 0
            ? ([{ kind: 'provider-evidence', table: 'animation_rum_provider_evidence_v2', rows: rows.providerRows }] as const)
            : []),
        { kind: 'metrics', table: 'animation_rum_metrics_v2', rows: rows.metricRows },
        { kind: 'capture-completion', table: 'animation_rum_captures_v2', rows: [rows.captureRow] },
    ]
}
