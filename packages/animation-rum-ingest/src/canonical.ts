import { createHash } from 'node:crypto'

import {
    ANIMATION_RUM_FAMILIES,
    ANIMATION_RUM_V2_CAPABILITIES,
    ANIMATION_RUM_V2_MAX_PAYLOAD_BYTES,
    ANIMATION_RUM_V2_PROVIDER_OWNERS,
    type AnimationRumFamily,
    type AnimationRumV2ProviderEvidence,
    type AnimationRumV2Report,
    validateNormalizedAnimationRumV2,
} from '@condev-monitor/animation-rum-contract'

import { AnimationRumV2IngestValidationError } from './errors'

export const ANIMATION_RUM_V2_PAYLOAD_HASH_VERSION = 1 as const
export const ANIMATION_RUM_V2_PAYLOAD_HASH_DOMAIN = 'condev-animation-rum-v2/canonical-v1\0' as const

export interface PreparedAnimationRumV2Payload {
    report: AnimationRumV2Report
    canonicalText: string
    payloadHash: string
    payloadHashVersion: typeof ANIMATION_RUM_V2_PAYLOAD_HASH_VERSION
}

export interface PrepareAnimationRumV2PayloadOptions {
    nowEpochMs?: number
}

const compareText = (left: string, right: string): number => (left === right ? 0 : left < right ? -1 : 1)

function canonicalizeValidatedReport(report: AnimationRumV2Report): AnimationRumV2Report {
    const context: AnimationRumV2Report['context'] = {
        ...(report.context.routeKey === undefined ? {} : { routeKey: report.context.routeKey }),
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
    const capabilities = Object.fromEntries(
        ANIMATION_RUM_V2_CAPABILITIES.map(name => [name, report.capabilities[name]])
    ) as AnimationRumV2Report['capabilities']
    const coverage = Object.fromEntries(
        ANIMATION_RUM_FAMILIES.map(family => [
            family,
            {
                status: report.coverage[family].status,
                evidenceLevel: report.coverage[family].evidenceLevel,
            },
        ])
    ) as AnimationRumV2Report['coverage']
    const providerEvidence: AnimationRumV2Report['providerEvidence'] = {}
    for (const owner of ANIMATION_RUM_V2_PROVIDER_OWNERS) {
        const inboundFamilies = report.providerEvidence[owner]
        if (!inboundFamilies) continue
        const families: Partial<Record<AnimationRumFamily, AnimationRumV2ProviderEvidence>> = {}
        for (const family of ANIMATION_RUM_FAMILIES) {
            const evidence = inboundFamilies[family]
            if (!evidence) continue
            families[family] = {
                version: evidence.version,
                accepted: evidence.accepted,
                retained: evidence.retained,
                evidence: evidence.evidence,
                dropped: evidence.dropped,
                rejected: evidence.rejected,
                truncated: evidence.truncated,
            }
        }
        if (Object.keys(families).length > 0) providerEvidence[owner] = families
    }
    const metrics = report.metrics
        .map(metric => ({
            metricId: metric.metricId,
            relation: metric.relation,
            owner: metric.owner,
            value: metric.value,
            samples: metric.samples,
            status: metric.status,
        }))
        .sort(
            (left, right) =>
                compareText(left.metricId, right.metricId) ||
                compareText(left.relation, right.relation) ||
                compareText(left.owner, right.owner)
        )

    return {
        contractVersion: report.contractVersion,
        snapshotSchemaVersion: report.snapshotSchemaVersion,
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
        capabilities,
        coverage,
        captureQuality: {
            sufficiency: report.captureQuality.sufficiency,
            integrity: report.captureQuality.integrity,
            reasons: [...report.captureQuality.reasons].sort(compareText),
            adapterErrorCount: report.captureQuality.adapterErrorCount,
        },
        providerEvidence,
        metrics,
    }
}

/**
 * Strictly validates an untrusted report before rebuilding its closed fields,
 * serializing it deterministically, and calculating the versioned receipt hash.
 */
export function prepareAnimationRumV2Payload(
    raw: unknown,
    options: PrepareAnimationRumV2PayloadOptions = {}
): PreparedAnimationRumV2Payload {
    const validation = validateNormalizedAnimationRumV2(raw, options)
    if (!validation.ok) throw new AnimationRumV2IngestValidationError(validation.errors)

    const report = canonicalizeValidatedReport(validation.value)
    const canonicalValidation = validateNormalizedAnimationRumV2(report, options)
    if (!canonicalValidation.ok) throw new AnimationRumV2IngestValidationError(canonicalValidation.errors)

    const canonicalText = JSON.stringify(report)
    if (Buffer.byteLength(canonicalText, 'utf8') > ANIMATION_RUM_V2_MAX_PAYLOAD_BYTES) {
        throw new AnimationRumV2IngestValidationError(['payload_too_large'])
    }
    const payloadHash = createHash('sha256')
        .update(ANIMATION_RUM_V2_PAYLOAD_HASH_DOMAIN, 'utf8')
        .update(canonicalText, 'utf8')
        .digest('hex')

    return {
        report,
        canonicalText,
        payloadHash,
        payloadHashVersion: ANIMATION_RUM_V2_PAYLOAD_HASH_VERSION,
    }
}
