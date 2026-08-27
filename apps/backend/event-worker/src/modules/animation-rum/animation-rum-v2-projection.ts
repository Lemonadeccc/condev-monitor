import {
    ANIMATION_RUM_FAMILIES,
    ANIMATION_RUM_V2_CAPABILITIES,
    ANIMATION_RUM_V2_METRIC_CATALOG,
    ANIMATION_RUM_V2_PROVIDER_OWNERS,
    AnimationRumV2Report,
    getAnimationRumV2MetricDefinition,
} from '@condev-monitor/animation-rum-contract'

export type AnimationRumV2Rows = {
    providerRows: Record<string, unknown>[]
    metricRows: Record<string, unknown>[]
    captureRow: Record<string, unknown>
}

function captureDimensions(appId: string, report: AnimationRumV2Report, capturedAt: string, receivedAt: string) {
    return {
        event_id: report.eventId,
        capture_id: report.captureId,
        app_id: appId,
        scope: report.scope,
        captured_at: capturedAt,
        received_at: receivedAt,
        release: report.release,
        environment: report.environment,
        route_key: report.context.routeKey ?? '',
        target_key: report.targetKey ?? '',
    }
}

/**
 * Projects only a report that already passed the canonical v2 validator.
 * Metric identity fields are looked up from the closed registry and never
 * copied from an inbound transport object.
 */
export function projectAnimationRumV2Rows(
    appId: string,
    report: AnimationRumV2Report,
    capturedAt: string,
    receivedAt: string
): AnimationRumV2Rows {
    const dimensions = captureDimensions(appId, report, capturedAt, receivedAt)
    const runtime = report.context.runtime
    const capabilities = Object.fromEntries(ANIMATION_RUM_V2_CAPABILITIES.map(name => [name, report.capabilities[name]]))
    const coverage = Object.fromEntries(
        ANIMATION_RUM_FAMILIES.map(family => [
            family,
            { status: report.coverage[family].status, evidenceLevel: report.coverage[family].evidenceLevel },
        ])
    )
    const metricOrder = new Map(ANIMATION_RUM_V2_METRIC_CATALOG.map((definition, index) => [definition.metricId, index]))
    const providerRows: Record<string, unknown>[] = []

    for (const owner of ANIMATION_RUM_V2_PROVIDER_OWNERS) {
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
            const definition = getAnimationRumV2MetricDefinition(metric.metricId)
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
