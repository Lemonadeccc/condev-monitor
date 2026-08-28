import { createHash } from 'node:crypto'

import {
    ANIMATION_RUM_V3_CAPABILITY,
    ANIMATION_RUM_V3_MAX_PAYLOAD_BYTES,
    ANIMATION_RUM_V3_METRIC_CATALOG,
    ANIMATION_RUM_V3_PROVIDER_OWNER,
    type AnimationRumV3Report,
    validateNormalizedAnimationRumV3,
} from '@condev-monitor/animation-rum-contract'

import { AnimationRumV3IngestValidationError } from './v3-errors'

export const ANIMATION_RUM_V3_PAYLOAD_HASH_VERSION = 1 as const
export const ANIMATION_RUM_V3_PAYLOAD_HASH_DOMAIN = 'condev-animation-rum-v3-soft-navigation/canonical-v1\0' as const

export interface PreparedAnimationRumV3Payload {
    report: AnimationRumV3Report
    canonicalText: string
    payloadHash: string
    payloadHashVersion: typeof ANIMATION_RUM_V3_PAYLOAD_HASH_VERSION
}

export interface PrepareAnimationRumV3PayloadOptions {
    nowEpochMs?: number
}

const compareText = (left: string, right: string): number => (left === right ? 0 : left < right ? -1 : 1)

function canonicalizeValidatedReport(report: AnimationRumV3Report): AnimationRumV3Report {
    const context: AnimationRumV3Report['context'] = {
        routeKey: report.context.routeKey,
        ...(report.context.visibilityState === undefined ? {} : { visibilityState: report.context.visibilityState }),
        ...(report.context.reducedMotion === undefined ? {} : { reducedMotion: report.context.reducedMotion }),
        ...(report.context.viewportBucket === undefined ? {} : { viewportBucket: report.context.viewportBucket }),
        ...(report.context.dprBucket === undefined ? {} : { dprBucket: report.context.dprBucket }),
        ...(report.context.refreshHz === undefined ? {} : { refreshHz: report.context.refreshHz }),
        ...(report.context.refreshBudgetSource === undefined ? {} : { refreshBudgetSource: report.context.refreshBudgetSource }),
        ...(report.context.refreshBudgetConfidence === undefined
            ? {}
            : { refreshBudgetConfidence: report.context.refreshBudgetConfidence }),
        windowDurationMs: report.context.windowDurationMs,
        windowDurationCapped: report.context.windowDurationCapped,
        runtime: {
            framework: report.context.runtime.framework,
            renderer: report.context.runtime.renderer,
            backend: report.context.runtime.backend,
        },
    }
    const capability = report.capabilities[ANIMATION_RUM_V3_CAPABILITY]
    const provider = report.providerEvidence[ANIMATION_RUM_V3_PROVIDER_OWNER].userOutcome
    const metricById = new Map(report.metrics.map(metric => [metric.metricId, metric]))
    const metrics = ANIMATION_RUM_V3_METRIC_CATALOG.map(definition => {
        const inbound = metricById.get(definition.metricId)
        if (!inbound) throw new Error('Validated Animation RUM v3 metric is missing from the canonical registry')
        return {
            metricId: definition.metricId,
            relation: definition.relation,
            owner: definition.owner,
            value: inbound.value,
            samples: inbound.samples,
            status: inbound.status,
        }
    }) as AnimationRumV3Report['metrics']

    return {
        contractVersion: report.contractVersion,
        snapshotSchemaVersion: report.snapshotSchemaVersion,
        captureKind: report.captureKind,
        eventId: report.eventId,
        captureId: report.captureId,
        scope: report.scope,
        parentCaptureId: report.parentCaptureId,
        targetKey: report.targetKey,
        capturedAt: new Date(Date.parse(report.capturedAt)).toISOString(),
        release: report.release,
        dist: report.dist,
        environment: report.environment,
        sdkVersion: report.sdkVersion,
        monitorVersion: report.monitorVersion,
        sampleRate: report.sampleRate,
        samplingPolicyVersion: report.samplingPolicyVersion,
        context,
        capabilities: {
            [ANIMATION_RUM_V3_CAPABILITY]: {
                status: capability.status,
                metrics: {
                    CLS: capability.metrics.CLS,
                    INP: capability.metrics.INP,
                    LCP: capability.metrics.LCP,
                },
            },
        },
        coverage: {
            userOutcome: {
                status: report.coverage.userOutcome.status,
                evidenceLevel: report.coverage.userOutcome.evidenceLevel,
            },
        },
        captureQuality: {
            sufficiency: report.captureQuality.sufficiency,
            integrity: report.captureQuality.integrity,
            reasons: [...report.captureQuality.reasons].sort(compareText),
        },
        providerEvidence: {
            [ANIMATION_RUM_V3_PROVIDER_OWNER]: {
                userOutcome: {
                    version: provider.version,
                    accepted: provider.accepted,
                    retained: provider.retained,
                    evidence: provider.evidence,
                    dropped: provider.dropped,
                    rejected: provider.rejected,
                    truncated: provider.truncated,
                },
            },
        },
        metrics,
    }
}

/** Validates and deterministically rebuilds the closed soft-navigation v3 report. */
export function prepareAnimationRumV3Payload(
    raw: unknown,
    options: PrepareAnimationRumV3PayloadOptions = {}
): PreparedAnimationRumV3Payload {
    const validation = validateNormalizedAnimationRumV3(raw, options)
    if (!validation.ok) throw new AnimationRumV3IngestValidationError(validation.errors)

    const report = canonicalizeValidatedReport(validation.value)
    const canonicalValidation = validateNormalizedAnimationRumV3(report, options)
    if (!canonicalValidation.ok) throw new AnimationRumV3IngestValidationError(canonicalValidation.errors)

    const canonicalText = JSON.stringify(report)
    if (Buffer.byteLength(canonicalText, 'utf8') > ANIMATION_RUM_V3_MAX_PAYLOAD_BYTES) {
        throw new AnimationRumV3IngestValidationError(['payload_too_large'])
    }
    const payloadHash = createHash('sha256')
        .update(ANIMATION_RUM_V3_PAYLOAD_HASH_DOMAIN, 'utf8')
        .update(canonicalText, 'utf8')
        .digest('hex')

    return {
        report,
        canonicalText,
        payloadHash,
        payloadHashVersion: ANIMATION_RUM_V3_PAYLOAD_HASH_VERSION,
    }
}
