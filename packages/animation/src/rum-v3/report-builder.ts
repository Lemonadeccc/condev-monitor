import {
    ANIMATION_RUM_V3_CAPABILITY,
    ANIMATION_RUM_V3_CAPTURE_KIND,
    ANIMATION_RUM_V3_CONTRACT_VERSION,
    ANIMATION_RUM_V3_MAX_PAYLOAD_BYTES,
    ANIMATION_RUM_V3_MAX_WINDOW_DURATION_MS,
    ANIMATION_RUM_V3_METRIC_CATALOG,
    ANIMATION_RUM_V3_PROVIDER_OWNER,
    ANIMATION_RUM_V3_SNAPSHOT_SCHEMA_VERSION,
    validateNormalizedAnimationRumV3,
} from '@condev-monitor/animation-rum-contract'

import { AnimationOptionsError } from '../collector'
import { ANIMATION_MONITOR_VERSION } from '../integration'
import { round } from '../statistics'
import type {
    AnimationSoftNavigationCapabilityStatus,
    AnimationSoftNavigationFinalizedSegmentSnapshot,
    AnimationSoftNavigationWebVitalMeasurement,
} from '../types'
import type {
    AnimationRumV3Metric,
    AnimationRumV3MetricStatus,
    AnimationRumV3QualityReason,
    AnimationRumV3Report,
    AnimationRumV3SoftNavigationCapability,
    AnimationRumV3SoftNavigationProjectionOptions,
    AnimationRumV3VitalName,
} from './types'

const MAX_COUNT = 1_000_000_000
const VITAL_NAMES = ['CLS', 'INP', 'LCP'] as const

function projectionError(message: string): never {
    throw new AnimationOptionsError(`Animation RUM v3 soft-navigation projection: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeCount(name: string, value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_COUNT) {
        projectionError(`${name} must be an integer between 0 and ${MAX_COUNT}`)
    }
    return value as number
}

function safeTime(name: string, value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        projectionError(`${name} must be finite and non-negative`)
    }
    return value
}

function capturedAtIso(value: unknown): string {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 8_640_000_000_000_000) {
        projectionError('capturedAtEpochMs must be a valid non-negative epoch time')
    }
    return new Date(value).toISOString()
}

function validateSourceWindow(segment: AnimationSoftNavigationFinalizedSegmentSnapshot): void {
    if (!isRecord(segment) || segment.schemaVersion !== 1) projectionError('segment.schemaVersion must be 1')
    const segmentId = safeCount('segment.segmentId', segment.segmentId)
    if (segmentId < 1) projectionError('segment.segmentId must be positive')
    const startedAt = safeTime('segment.startedAt', segment.startedAt)
    const finalizedAt = safeTime('segment.finalizedAt', segment.finalizedAt)
    const elapsedMs = safeTime('segment.elapsedMs', segment.elapsedMs)
    if (finalizedAt < startedAt || Math.abs(elapsedMs - (finalizedAt - startedAt)) > 0.001) {
        projectionError('segment window timestamps and elapsedMs are inconsistent')
    }
    if (segment.reason !== 'next-soft-navigation' && segment.reason !== 'hidden' && segment.reason !== 'pagehide') {
        projectionError('segment.reason is unsupported')
    }
    safeCount('segment.observedUpdateCount', segment.observedUpdateCount)
    safeCount('segment.droppedEntryCount', segment.droppedEntryCount)
    safeCount('segment.rejectedUpdateCount', segment.rejectedUpdateCount)
    if (!isRecord(segment.capability) || !isRecord(segment.latest)) projectionError('segment evidence is malformed')
}

function validateCapability(name: AnimationRumV3VitalName, value: unknown): AnimationSoftNavigationCapabilityStatus {
    if (value !== 'supported' && value !== 'unsupported' && value !== 'unknown') {
        projectionError(`segment.capability.${name} is unsupported`)
    }
    return value
}

function validateMeasurement(
    segment: AnimationSoftNavigationFinalizedSegmentSnapshot,
    name: AnimationRumV3VitalName,
    measurement: AnimationSoftNavigationWebVitalMeasurement
): number {
    if (!isRecord(measurement)) projectionError(`segment.latest.${name} is malformed`)
    if (measurement.name !== name || measurement.navigationType !== 'soft-navigation') {
        projectionError(`segment.latest.${name} has an inconsistent metric identity`)
    }
    if (measurement.segmentId !== segment.segmentId || measurement.startedAt !== segment.startedAt) {
        projectionError(`segment.latest.${name} belongs to a different soft-navigation segment`)
    }
    const maximum = name === 'CLS' ? 100 : ANIMATION_RUM_V3_MAX_WINDOW_DURATION_MS
    if (
        typeof measurement.value !== 'number' ||
        !Number.isFinite(measurement.value) ||
        measurement.value < 0 ||
        measurement.value > maximum
    ) {
        projectionError(`segment.latest.${name}.value is outside the v3 contract bound`)
    }
    return round(measurement.value, 6)
}

function capabilitySummary(
    metrics: Readonly<Record<AnimationRumV3VitalName, AnimationSoftNavigationCapabilityStatus>>
): AnimationRumV3SoftNavigationCapability['status'] {
    const states = Object.values(metrics)
    if (states.includes('supported')) return 'supported'
    if (states.every(state => state === 'unsupported')) return 'unsupported'
    return 'unknown'
}

function unavailableStatus(capability: AnimationSoftNavigationCapabilityStatus): AnimationRumV3MetricStatus {
    if (capability === 'unsupported') return 'unsupported'
    if (capability === 'unknown') return 'unknown'
    return 'not-observed'
}

function coverageStatus(metrics: AnimationRumV3Report['metrics']): AnimationRumV3MetricStatus {
    const statuses = metrics.map(metric => metric.status)
    if (statuses.includes('partial')) return 'partial'
    if (statuses.includes('measured')) return 'measured'
    if (statuses.includes('not-observed')) return 'not-observed'
    if (statuses.includes('unknown')) return 'unknown'
    if (statuses.includes('unsupported')) return 'unsupported'
    return 'not-instrumented'
}

function contextFromOptions(
    segment: AnimationSoftNavigationFinalizedSegmentSnapshot,
    options: AnimationRumV3SoftNavigationProjectionOptions
): AnimationRumV3Report['context'] {
    const capped = segment.elapsedMs > ANIMATION_RUM_V3_MAX_WINDOW_DURATION_MS
    return {
        routeKey: options.routeKey,
        ...(options.visibilityState === undefined ? {} : { visibilityState: options.visibilityState }),
        ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }),
        ...(options.viewportBucket === undefined ? {} : { viewportBucket: options.viewportBucket }),
        ...(options.dprBucket === undefined ? {} : { dprBucket: options.dprBucket }),
        ...(options.refreshHz === undefined ? {} : { refreshHz: options.refreshHz }),
        ...(options.refreshBudgetSource === undefined ? {} : { refreshBudgetSource: options.refreshBudgetSource }),
        ...(options.refreshBudgetConfidence === undefined ? {} : { refreshBudgetConfidence: options.refreshBudgetConfidence }),
        windowDurationMs: capped ? ANIMATION_RUM_V3_MAX_WINDOW_DURATION_MS : round(segment.elapsedMs, 6),
        windowDurationCapped: capped,
        runtime: { ...options.runtime },
    }
}

/**
 * Pure closed projection for one finalized native soft-navigation segment.
 * Local segment identity, timestamps, finalization reason, attribution, URLs,
 * selectors, and raw observer entries are deliberately never serialized.
 */
export function toAnimationRumV3SoftNavigationReport(
    segment: AnimationSoftNavigationFinalizedSegmentSnapshot,
    options: AnimationRumV3SoftNavigationProjectionOptions
): AnimationRumV3Report {
    validateSourceWindow(segment)
    if (!isRecord(options)) projectionError('options are required')

    const capabilities = Object.fromEntries(VITAL_NAMES.map(name => [name, validateCapability(name, segment.capability[name])])) as Record<
        AnimationRumV3VitalName,
        AnimationSoftNavigationCapabilityStatus
    >
    const context = contextFromOptions(segment, options)
    const reasons = new Set<AnimationRumV3QualityReason>()
    if (segment.rejectedUpdateCount > 0) reasons.add('provider-rejected-samples')
    if (segment.droppedEntryCount > 0) reasons.add('provider-truncated')
    if (Object.values(capabilities).includes('unknown')) reasons.add('source-field-incomplete')
    if (context.windowDurationCapped) reasons.add('window-capped')
    const qualityReasons = [...reasons].sort() as AnimationRumV3QualityReason[]

    let availableMetricCount = 0
    const metrics = ANIMATION_RUM_V3_METRIC_CATALOG.map(definition => {
        const capability = capabilities[definition.vitalName]
        const measurement = segment.latest[definition.vitalName]
        if (capability !== 'supported' && measurement !== null) {
            projectionError(`segment.latest.${definition.vitalName} contradicts its capability`)
        }
        const value = measurement === null ? null : validateMeasurement(segment, definition.vitalName, measurement)
        if (value !== null) availableMetricCount += 1
        return {
            metricId: definition.metricId,
            relation: definition.relation,
            owner: definition.owner,
            value,
            samples: value === null ? null : 1,
            status: value === null ? unavailableStatus(capability) : qualityReasons.length > 0 ? 'partial' : 'measured',
        } satisfies AnimationRumV3Metric
    }) as AnimationRumV3Report['metrics']

    const capability = { status: capabilitySummary(capabilities), metrics: capabilities }
    const report: AnimationRumV3Report = {
        contractVersion: ANIMATION_RUM_V3_CONTRACT_VERSION,
        snapshotSchemaVersion: ANIMATION_RUM_V3_SNAPSHOT_SCHEMA_VERSION,
        captureKind: ANIMATION_RUM_V3_CAPTURE_KIND,
        eventId: options.eventId,
        captureId: options.captureId,
        scope: 'page',
        parentCaptureId: null,
        targetKey: null,
        capturedAt: capturedAtIso(options.capturedAtEpochMs),
        release: options.release ?? '',
        dist: options.dist ?? '',
        environment: options.environment ?? '',
        sdkVersion: options.sdkVersion ?? ANIMATION_MONITOR_VERSION,
        monitorVersion: ANIMATION_MONITOR_VERSION,
        sampleRate: options.sampleRate,
        samplingPolicyVersion: options.samplingPolicyVersion,
        context,
        capabilities: { [ANIMATION_RUM_V3_CAPABILITY]: capability },
        coverage: {
            userOutcome: {
                status: coverageStatus(metrics),
                evidenceLevel: Object.values(capabilities).includes('supported') ? 'runtime-observation' : 'unsupported-or-unknown',
            },
        },
        captureQuality: {
            sufficiency: availableMetricCount > 0 ? 'sufficient' : 'insufficient',
            integrity: qualityReasons.length > 0 ? 'partial' : 'complete',
            reasons: qualityReasons,
        },
        providerEvidence: {
            [ANIMATION_RUM_V3_PROVIDER_OWNER]: {
                userOutcome: {
                    version: ANIMATION_MONITOR_VERSION,
                    accepted: availableMetricCount,
                    retained: availableMetricCount,
                    evidence: availableMetricCount,
                    dropped: segment.droppedEntryCount,
                    rejected: segment.rejectedUpdateCount,
                    truncated: segment.droppedEntryCount > 0,
                },
            },
        },
        metrics,
    }

    const validation = validateNormalizedAnimationRumV3(report, { nowEpochMs: options.capturedAtEpochMs })
    if (!validation.ok) projectionError(`contract validation failed: ${validation.errors.join(', ')}`)
    const normalized = validation.value as AnimationRumV3Report
    const bytes = new TextEncoder().encode(JSON.stringify(normalized)).byteLength
    if (bytes > ANIMATION_RUM_V3_MAX_PAYLOAD_BYTES) projectionError(`report exceeds ${ANIMATION_RUM_V3_MAX_PAYLOAD_BYTES} bytes`)
    return normalized
}
