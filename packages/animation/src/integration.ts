// cspell:ignore gsap

import type { MonitorIntegration, Transport } from '@condev-monitor/monitor-sdk-core'

import { AnimationCollector, AnimationOptionsError, AnimationStateError } from './collector'
import type {
    AnimationFrameworkStatsSample,
    AnimationLifecycleStatsSample,
    AnimationMediaStatsSample,
    AnimationRenderStatsSample,
    AnimationWorkStatsSample,
} from './host-adapters'
import { createBrowserAnimationRuntime } from './runtime'
import { round } from './statistics'
import type {
    AnimationElementSelectionHandle,
    AnimationElementSelectionOptions,
    AnimationIntegrationOptions,
    AnimationInteractionHandle,
    AnimationInteractionKind,
    AnimationRumCapabilities,
    AnimationRumCoverage,
    AnimationRumEnvelope,
    AnimationRumMetric,
    AnimationRumMetricName,
    AnimationRumSummary,
    AnimationRuntime,
    AnimationRuntimeFamily,
    AnimationSnapshot,
    CapabilityEvidence,
} from './types'

export const ANIMATION_MONITOR_VERSION = '0.1.0'
export const ANIMATION_RUM_CONTRACT_VERSION = 1
export const ANIMATION_RUM_SAMPLING_POLICY_VERSION = 1
/** Privacy and payload-contract bound for a single production capture window (seven days). */
export const ANIMATION_RUM_MAX_WINDOW_DURATION_MS = 604_800_000

interface ResolvedRumConfig {
    enabled: boolean
    sampleRate: number
    sampleKey: string
    seed: string
    policyVersion: number
}

let eventSequence = 0
const PAGE_SAMPLE_KEY = Symbol.for('@condev-monitor/animation-rum/page-sample-key/v1')

function safeRandomPart(): string {
    const cryptoValue = typeof crypto === 'undefined' ? undefined : crypto
    if (cryptoValue?.randomUUID) return cryptoValue.randomUUID().replace(/-/g, '')
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
}

function stickyPageKey(): string {
    const root = globalThis as typeof globalThis & { [PAGE_SAMPLE_KEY]?: string }
    root[PAGE_SAMPLE_KEY] ??= `page-${safeRandomPart()}`
    return root[PAGE_SAMPLE_KEY]
}

function safeEventId(): string {
    eventSequence += 1
    return `animation_${safeRandomPart().slice(0, 48)}_${eventSequence.toString(36)}`
}

function validateVersion(name: string, value: string | undefined, fallback: string): string {
    const resolved = value ?? fallback
    if (resolved === '') return ''
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(resolved)) {
        throw new AnimationOptionsError(`${name} must be a safe version identifier`)
    }
    return resolved
}

function validateRouteKey(value: string | undefined): string | undefined {
    if (value === undefined) return undefined
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
        throw new AnimationOptionsError('context.routeKey must be an already-redacted route identifier, not a URL')
    }
    return value
}

function validateRuntimeFamily(value: AnimationRuntimeFamily | undefined): AnimationRuntimeFamily {
    const resolved = value ?? 'unknown'
    if (
        !['vanilla', 'react', 'vue', 'svelte', 'solid', 'angular', 'three', 'babylon', 'pixi', 'gsap', 'motion', 'unknown'].includes(
            resolved
        )
    ) {
        throw new AnimationOptionsError('context.runtimeFamily is unsupported')
    }
    return resolved
}

function validateSafeId(name: string, value: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/.test(value)) {
        throw new AnimationOptionsError(`${name} must be a safe identifier containing 8 to 80 characters`)
    }
    return value
}

function validateContextOptions(options: AnimationIntegrationOptions): void {
    validateRouteKey(options.context?.routeKey)
    validateVersion('context.release', options.context?.release, '')
    validateVersion('context.dist', options.context?.dist, '')
    validateVersion('context.environment', options.context?.environment, '')
    validateVersion('context.sdkVersion', options.context?.sdkVersion, ANIMATION_MONITOR_VERSION)
    validateRuntimeFamily(options.context?.runtimeFamily)
}

function resolveRumConfig(options: AnimationIntegrationOptions): ResolvedRumConfig {
    const sampleRate = options.rum?.sampleRate ?? 0
    if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
        throw new AnimationOptionsError('rum.sampleRate must be between 0 and 1')
    }
    const policyVersion = options.rum?.policyVersion ?? ANIMATION_RUM_SAMPLING_POLICY_VERSION
    if (!Number.isInteger(policyVersion) || policyVersion < 1 || policyVersion > 255) {
        throw new AnimationOptionsError('rum.policyVersion must be an integer between 1 and 255')
    }
    const enabled = options.rum?.enabled === true
    const sampleKey = options.rum?.sampleKey ?? (enabled && sampleRate > 0 ? stickyPageKey() : 'disabled')
    if (sampleKey.length === 0 || sampleKey.length > 256) {
        throw new AnimationOptionsError('rum.sampleKey must contain 1 to 256 characters')
    }
    const seed = options.rum?.seed ?? 'condev-animation-rum-v1'
    if (seed.length === 0 || seed.length > 128) {
        throw new AnimationOptionsError('rum.seed must contain 1 to 128 characters')
    }
    return {
        enabled,
        sampleRate,
        sampleKey,
        seed,
        policyVersion,
    }
}

/** Stable FNV-1a sampling; the key and hash are never added to the report. */
export function deterministicAnimationRumSample(sampleKey: string, sampleRate: number, seed = ''): boolean {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) return false
    if (sampleRate >= 1) return true
    let hash = 0x811c9dc5
    const input = `${seed}\u0000${sampleKey}`
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0) / 0x1_0000_0000 < sampleRate
}

function capabilityStatus(capability: CapabilityEvidence): AnimationRumMetric['status'] {
    if (capability.state === 'unsupported') return 'unsupported'
    if (capability.state === 'unknown') return 'unknown'
    return capability.observed ? 'measured' : 'not-observed'
}

function completedRumWindowAggregateStatus(capability: CapabilityEvidence): AnimationRumMetric['status'] {
    const status = capabilityStatus(capability)
    return status === 'not-observed' ? 'measured' : status
}

function metric(
    family: AnimationRumMetric['family'],
    name: AnimationRumMetricName,
    stat: AnimationRumMetric['stat'],
    unit: AnimationRumMetric['unit'],
    value: number | null,
    samples: number | null,
    status: AnimationRumMetric['status']
): AnimationRumMetric {
    const unavailable = status === 'not-observed' || status === 'not-instrumented' || status === 'unsupported' || status === 'unknown'
    return {
        family,
        name,
        stat,
        unit,
        value: unavailable || value === null ? null : round(Math.min(1e15, Math.max(0, value)), 6),
        samples: unavailable || samples === null ? null : Math.min(1_000_000_000, Math.max(0, Math.floor(samples))),
        status,
    }
}

function measuredOrNotObserved(samples: number): AnimationRumMetric['status'] {
    return samples > 0 ? 'measured' : 'not-observed'
}

function boundedMetricStatus(status: AnimationRumMetric['status'], droppedSamples: number | null): AnimationRumMetric['status'] {
    return status === 'measured' && (droppedSamples ?? 0) > 0 ? 'partial' : status
}

function statusForValue(status: AnimationRumMetric['status'], value: number | null | undefined): AnimationRumMetric['status'] {
    return value === null || value === undefined
        ? status === 'unsupported'
            ? 'unsupported'
            : status === 'unknown'
              ? 'unknown'
              : 'not-observed'
        : status
}

function partialWhenWindowCapped(status: AnimationRumMetric['status'], windowDurationCapped: boolean): AnimationRumMetric['status'] {
    return windowDurationCapped && status === 'measured' ? 'partial' : status
}

function projectMetrics(snapshot: AnimationSnapshot, windowDurationCapped: boolean): readonly AnimationRumMetric[] {
    const result: AnimationRumMetric[] = []
    const frameCount = snapshot.frames.retainedCount
    const boundedFrameStatus = boundedMetricStatus(measuredOrNotObserved(frameCount), snapshot.frames.droppedSampleCount)
    const frameStatus = frameCount > 0 && snapshot.captureSufficiency.status === 'insufficient' ? 'partial' : boundedFrameStatus
    const frameStats = snapshot.frames.duration
    const frameValues: Array<[AnimationRumMetricName, AnimationRumMetric['stat'], number | null]> = [
        ['frameDurationMs', 'p50', frameStats?.p50 ?? null],
        ['frameDurationMs', 'p75', frameStats?.p75 ?? null],
        ['frameDurationMs', 'p95', frameStats?.p95 ?? null],
        ['frameDurationMs', 'p99', frameStats?.p99 ?? null],
        ['frameDurationMs', 'max', frameStats?.max ?? null],
    ]
    for (const [name, stat, value] of frameValues) {
        result.push(metric('frameCadence', name, stat, 'ms', value, frameCount, frameStatus))
    }
    const refreshBudgetStatus =
        snapshot.frameBudget.source === 'inferred' && snapshot.captureSufficiency.status === 'insufficient' ? 'partial' : 'measured'
    result.push(
        metric('frameCadence', 'targetFrameMs', 'latest', 'ms', snapshot.frameBudget.frameBudgetMs, frameCount, refreshBudgetStatus),
        metric(
            'frameCadence',
            'inferredRefreshHz',
            'latest',
            'hz',
            snapshot.frameBudget.expectedRefreshHz,
            frameCount,
            refreshBudgetStatus
        ),
        metric('frameCadence', 'slowFrameRate', 'ratio', 'ratio', snapshot.frames.slowFrameRatio, frameCount, frameStatus),
        metric('frameCadence', 'jankBurstCount', 'count', 'count', snapshot.bursts.count, frameCount, frameStatus),
        metric('frameCadence', 'longestSlowFrameRun', 'max', 'frames', snapshot.bursts.longestFrameCount, frameCount, frameStatus),
        metric(
            'frameCadence',
            'missedFrameOpportunities',
            'sum',
            'frames',
            snapshot.frames.missedFrameOpportunities,
            frameCount,
            frameStatus
        )
    )

    const loafRetainedCount = snapshot.longAnimationFrames.retainedCount ?? 0
    const loafCount = snapshot.longAnimationFrames.totalObservedCount ?? 0
    const loafCapabilityStatus = capabilityStatus(snapshot.longAnimationFrames.capability)
    const loafAggregateStatus = completedRumWindowAggregateStatus(snapshot.longAnimationFrames.capability)
    const loafDistributionStatus = boundedMetricStatus(loafCapabilityStatus, snapshot.longAnimationFrames.droppedSampleCount)
    result.push(
        metric('mainThread', 'longAnimationFrameCount', 'count', 'count', loafCount, loafCount, loafAggregateStatus),
        metric(
            'mainThread',
            'longAnimationFrameDurationMs',
            'sum',
            'ms',
            snapshot.longAnimationFrames.totalDurationMs,
            loafCount,
            partialWhenWindowCapped(loafAggregateStatus, windowDurationCapped)
        ),
        metric(
            'mainThread',
            'longAnimationFrameDurationMs',
            'p95',
            'ms',
            snapshot.longAnimationFrames.duration?.p95 ?? null,
            loafRetainedCount,
            loafDistributionStatus
        ),
        metric(
            'mainThread',
            'longAnimationFrameBlockingMs',
            'p95',
            'ms',
            snapshot.longAnimationFrames.blockingDuration?.p95 ?? null,
            snapshot.longAnimationFrames.blockingDuration?.count ?? 0,
            statusForValue(loafDistributionStatus, snapshot.longAnimationFrames.blockingDuration?.p95)
        ),
        metric(
            'renderingPipeline',
            'longAnimationFrameStyleLayoutTailMs',
            'p95',
            'ms',
            snapshot.longAnimationFrames.styleAndLayoutTailDuration?.p95 ?? null,
            snapshot.longAnimationFrames.styleAndLayoutTailDuration?.count ?? 0,
            statusForValue(loafDistributionStatus, snapshot.longAnimationFrames.styleAndLayoutTailDuration?.p95)
        )
    )

    const longTaskRetainedCount = snapshot.longTasks.retainedCount ?? 0
    const longTaskCount = snapshot.longTasks.totalObservedCount ?? 0
    const longTaskCapabilityStatus = capabilityStatus(snapshot.longTasks.capability)
    const longTaskAggregateStatus = completedRumWindowAggregateStatus(snapshot.longTasks.capability)
    const longTaskDistributionStatus = boundedMetricStatus(longTaskCapabilityStatus, snapshot.longTasks.droppedSampleCount)
    result.push(
        metric('mainThread', 'longTaskCount', 'count', 'count', longTaskCount, longTaskCount, longTaskAggregateStatus),
        metric(
            'mainThread',
            'longTaskDurationMs',
            'sum',
            'ms',
            snapshot.longTasks.totalDurationMs,
            longTaskCount,
            partialWhenWindowCapped(longTaskAggregateStatus, windowDurationCapped)
        ),
        metric(
            'mainThread',
            'longTaskDurationMs',
            'p95',
            'ms',
            snapshot.longTasks.duration?.p95 ?? null,
            longTaskRetainedCount,
            longTaskDistributionStatus
        ),
        metric(
            'mainThread',
            'longTaskDurationMs',
            'max',
            'ms',
            snapshot.longTasks.duration?.max ?? null,
            longTaskRetainedCount,
            longTaskDistributionStatus
        )
    )

    const eventStatus = boundedMetricStatus(capabilityStatus(snapshot.eventTiming.capability), snapshot.eventTiming.droppedSampleCount)
    const presentationStatus = boundedMetricStatus(
        capabilityStatus(snapshot.eventTiming.presentationDelayCapability),
        snapshot.eventTiming.droppedSampleCount
    )
    result.push(
        metric(
            'userOutcome',
            'eventTimingDurationMs',
            'p95',
            'ms',
            snapshot.eventTiming.duration?.p95 ?? null,
            snapshot.eventTiming.duration?.count ?? 0,
            eventStatus
        ),
        metric(
            'userOutcome',
            'inputDelayMs',
            'p95',
            'ms',
            snapshot.eventTiming.inputDelay?.p95 ?? null,
            snapshot.eventTiming.inputDelay?.count ?? 0,
            statusForValue(eventStatus, snapshot.eventTiming.inputDelay?.p95)
        ),
        metric(
            'userOutcome',
            'processingDurationMs',
            'p95',
            'ms',
            snapshot.eventTiming.processingDuration?.p95 ?? null,
            snapshot.eventTiming.processingDuration?.count ?? 0,
            statusForValue(eventStatus, snapshot.eventTiming.processingDuration?.p95)
        ),
        metric(
            'renderingPipeline',
            'presentationDelayMs',
            'p95',
            'ms',
            snapshot.eventTiming.presentationDelay?.p95 ?? null,
            snapshot.eventTiming.presentationDelay?.count ?? 0,
            statusForValue(presentationStatus, snapshot.eventTiming.presentationDelay?.p95)
        )
    )

    const interactionCount = snapshot.interactions.totalObservedCount
    const interactionAggregateStatus = measuredOrNotObserved(interactionCount)
    const interactionDistributionStatus = boundedMetricStatus(interactionAggregateStatus, snapshot.interactions.droppedSampleCount)
    result.push(
        metric('userOutcome', 'interactionCount', 'count', 'count', interactionCount, interactionCount, interactionAggregateStatus),
        metric(
            'userOutcome',
            'interactionDurationMs',
            'p95',
            'ms',
            snapshot.interactions.duration?.p95 ?? null,
            snapshot.interactions.retainedCount,
            interactionDistributionStatus
        ),
        metric(
            'userOutcome',
            'completedInteractions',
            'count',
            'count',
            snapshot.interactions.completedCount,
            interactionCount,
            interactionAggregateStatus
        ),
        metric(
            'userOutcome',
            'cancelledInteractions',
            'count',
            'count',
            snapshot.interactions.cancelledCount,
            interactionCount,
            interactionAggregateStatus
        ),
        metric(
            'userOutcome',
            'abandonedInteractions',
            'count',
            'count',
            snapshot.interactions.abandonedCount,
            interactionCount,
            interactionAggregateStatus
        )
    )

    const overheadCount = snapshot.monitorOverhead.callbackCount
    const overheadAggregateStatus = measuredOrNotObserved(overheadCount)
    const callbackSelfTimeRatio = snapshot.elapsedMs > 0 ? snapshot.monitorOverhead.totalCallbackDurationMs / snapshot.elapsedMs : null
    const reportBuildStatus = boundedMetricStatus(
        measuredOrNotObserved(snapshot.monitorOverhead.reportBuildRetainedCount),
        snapshot.monitorOverhead.reportBuildDroppedSampleCount
    )
    result.push(
        metric('monitorOverhead', 'callbackCount', 'count', 'count', overheadCount, overheadCount, overheadAggregateStatus),
        metric(
            'monitorOverhead',
            'callbackSelfTimeRatio',
            'ratio',
            'ratio',
            callbackSelfTimeRatio,
            overheadCount,
            statusForValue(partialWhenWindowCapped(overheadAggregateStatus, windowDurationCapped), callbackSelfTimeRatio)
        ),
        metric(
            'monitorOverhead',
            'reportBuildSelfTimeMs',
            'p95',
            'ms',
            snapshot.monitorOverhead.reportBuildDuration?.p95 ?? null,
            snapshot.monitorOverhead.reportBuildRetainedCount,
            reportBuildStatus
        )
    )

    return result
}

export interface AnimationRumProjectionOptions {
    eventId?: string
    capturedAtEpochMs: number
    sampleRate: number
    samplingPolicyVersion: number
    routeKey?: string
    release?: string
    dist?: string
    environment?: string
    sdkVersion?: string
    runtimeFamily?: AnimationRuntimeFamily
}

function runtimeCoverage(
    status: AnimationRumCoverage['userOutcome']['status'],
    evidenceUnavailable = false
): AnimationRumCoverage['userOutcome'] {
    return {
        status,
        evidenceLevel:
            evidenceUnavailable || status === 'unsupported' || status === 'not-instrumented'
                ? 'unsupported-or-unknown'
                : 'runtime-observation',
    }
}

function projectedMetricStatus(
    metrics: readonly AnimationRumMetric[],
    family: AnimationRumMetric['family'],
    name: AnimationRumMetricName,
    stat: AnimationRumMetric['stat']
): AnimationRumMetric['status'] {
    return metrics.find(item => item.family === family && item.name === name && item.stat === stat)?.status ?? 'unknown'
}

function combinedWireStatus(statuses: readonly AnimationRumMetric['status'][]): AnimationRumCoverage['userOutcome']['status'] {
    if (statuses.includes('partial')) return 'partial'
    const measuredCount = statuses.filter(status => status === 'measured').length
    if (measuredCount > 0) return measuredCount === statuses.length ? 'measured' : 'partial'
    if (statuses.length > 0 && statuses.every(status => status === 'unsupported')) return 'unsupported'
    if (statuses.length > 0 && statuses.every(status => status === 'not-instrumented')) return 'not-instrumented'
    return 'not-observed'
}

function combinedWireCoverage(statuses: readonly AnimationRumMetric['status'][]): AnimationRumCoverage['userOutcome'] {
    const status = combinedWireStatus(statuses)
    const evidenceUnavailable =
        status === 'not-observed' && statuses.length > 0 && statuses.every(item => item === 'unsupported' || item === 'unknown')
    return runtimeCoverage(status, evidenceUnavailable)
}

/**
 * Derive production coverage only from values that survive the closed v1 wire
 * projection. Local snapshot coverage also includes Web Vitals, Resource
 * Timing, quality, host adapters, and Browser page evidence; copying those
 * states would claim evidence that downstream consumers never receive.
 */
function projectRumCoverage(metrics: readonly AnimationRumMetric[]): AnimationRumCoverage {
    const interactionCountStatus = projectedMetricStatus(metrics, 'userOutcome', 'interactionCount', 'count')
    const interactionDurationStatus = projectedMetricStatus(metrics, 'userOutcome', 'interactionDurationMs', 'p95')
    const hasInteractionEvidence = interactionCountStatus === 'measured' || interactionCountStatus === 'partial'
    const eventMetricNames: readonly AnimationRumMetricName[] = ['eventTimingDurationMs', 'inputDelayMs', 'processingDurationMs']
    const hasEventEvidence = eventMetricNames.some(name => {
        const status = projectedMetricStatus(metrics, 'userOutcome', name, 'p95')
        return status === 'measured' || status === 'partial'
    })
    const userOutcomeHasPartialMetric = metrics.some(item => item.family === 'userOutcome' && item.status === 'partial')
    const userOutcomeStatus = userOutcomeHasPartialMetric
        ? 'partial'
        : hasInteractionEvidence
          ? interactionDurationStatus === 'partial'
              ? 'partial'
              : 'measured'
          : hasEventEvidence
            ? 'partial'
            : 'not-observed'

    const frameCadenceStatus = projectedMetricStatus(metrics, 'frameCadence', 'frameDurationMs', 'p95')
    const mainThreadCountStatuses = [
        projectedMetricStatus(metrics, 'mainThread', 'longAnimationFrameCount', 'count'),
        projectedMetricStatus(metrics, 'mainThread', 'longTaskCount', 'count'),
    ]
    const mainThreadStatuses = metrics.filter(item => item.family === 'mainThread').map(item => item.status)
    const mainThreadStatus = mainThreadStatuses.includes('partial') ? 'partial' : combinedWireStatus(mainThreadCountStatuses)
    const renderingPipelineStatuses = [
        projectedMetricStatus(metrics, 'renderingPipeline', 'longAnimationFrameStyleLayoutTailMs', 'p95'),
        projectedMetricStatus(metrics, 'renderingPipeline', 'presentationDelayMs', 'p95'),
    ]
    const monitorOverheadStatuses = [
        projectedMetricStatus(metrics, 'monitorOverhead', 'callbackCount', 'count'),
        projectedMetricStatus(metrics, 'monitorOverhead', 'callbackSelfTimeRatio', 'ratio'),
        projectedMetricStatus(metrics, 'monitorOverhead', 'reportBuildSelfTimeMs', 'p95'),
    ]
    const monitorOverheadStatus = monitorOverheadStatuses.includes('partial')
        ? 'partial'
        : monitorOverheadStatuses.includes('measured')
          ? 'measured'
          : combinedWireStatus(monitorOverheadStatuses)
    const notInstrumented = runtimeCoverage('not-instrumented')

    return {
        userOutcome: runtimeCoverage(userOutcomeStatus),
        frameCadence: runtimeCoverage(
            frameCadenceStatus === 'measured' || frameCadenceStatus === 'partial' || frameCadenceStatus === 'unsupported'
                ? frameCadenceStatus
                : 'not-observed'
        ),
        mainThread: mainThreadStatus === 'partial' ? runtimeCoverage('partial') : combinedWireCoverage(mainThreadCountStatuses),
        renderingPipeline: combinedWireCoverage(renderingPipelineStatuses),
        renderer: { ...notInstrumented },
        scrollGesture: { ...notInstrumented },
        resourcesMedia: { ...notInstrumented },
        memoryLifecycle: { ...notInstrumented },
        workAvoidance: { ...notInstrumented },
        accessibility: { ...notInstrumented },
        motionQuality: { ...notInstrumented },
        monitorOverhead: runtimeCoverage(monitorOverheadStatus),
    }
}

function projectedCapability(evidence: unknown): boolean | null {
    if (!evidence || typeof evidence !== 'object') return null
    const state = (evidence as Partial<CapabilityEvidence>).state
    return state === 'supported' ? true : state === 'unsupported' ? false : null
}

function projectRumCapabilities(snapshot: AnimationSnapshot): AnimationRumCapabilities {
    const paintTiming = snapshot.longAnimationFrames.paintTiming
    const resourceTiming = snapshot.resourceTiming
    const webVitals = snapshot.webVitals
    return {
        'long-animation-frame': projectedCapability(snapshot.longAnimationFrames.capability),
        longtask: projectedCapability(snapshot.longTasks.capability),
        event: projectedCapability(snapshot.eventTiming.capability),
        resourceTiming: projectedCapability(resourceTiming?.capability),
        resourceTimingBufferEvents: projectedCapability(resourceTiming?.bufferEventCapability),
        webVitalsAttribution: webVitals?.capability.state === 'supported' && webVitals.capability.observed ? true : null,
        webVitalsSoftNavigation: null,
        webVitalsDisabled: typeof webVitals?.observedUpdateCount === 'number' ? false : null,
        reducedMotionPreference: typeof snapshot.visibility.reducedMotion === 'boolean' ? true : null,
        // Browser pageEvidence can inspect document animations locally, but it
        // is not part of AnimationSnapshot v1 and cannot attest this wire bit.
        documentAnimationsInspection: null,
        visibilityLifecycle: ['visible', 'hidden', 'prerender'].includes(snapshot.visibility.current) ? true : null,
        longAnimationFramePaintTime: projectedCapability(paintTiming?.paintTimeCapability),
        longAnimationFramePresentationTime: projectedCapability(paintTiming?.presentationTimeCapability),
    }
}

/** Closed, allow-listed wire projection. Local interaction labels and sample rings are intentionally unreachable here. */
export function toAnimationRumSummary(snapshot: AnimationSnapshot, options: AnimationRumProjectionOptions): AnimationRumSummary {
    if (!snapshot || typeof snapshot !== 'object') throw new AnimationOptionsError('snapshot must be an object')
    if (snapshot.schemaVersion !== 1) throw new AnimationOptionsError('snapshot.schemaVersion must be 1')
    if (
        !snapshot.visibility ||
        typeof snapshot.visibility !== 'object' ||
        !snapshot.frameBudget ||
        typeof snapshot.frameBudget !== 'object' ||
        !snapshot.capabilities ||
        typeof snapshot.capabilities !== 'object' ||
        !snapshot.coverage ||
        typeof snapshot.coverage !== 'object'
    ) {
        throw new AnimationOptionsError('snapshot is missing required closed report sections')
    }
    if (!Number.isFinite(options.sampleRate) || options.sampleRate <= 0 || options.sampleRate > 1) {
        throw new AnimationOptionsError('RUM projection sampleRate must be greater than 0 and no more than 1')
    }
    if (!Number.isInteger(options.samplingPolicyVersion) || options.samplingPolicyVersion < 1 || options.samplingPolicyVersion > 255) {
        throw new AnimationOptionsError('RUM projection samplingPolicyVersion must be an integer between 1 and 255')
    }
    if (!Number.isFinite(options.capturedAtEpochMs) || options.capturedAtEpochMs < 0 || options.capturedAtEpochMs > 8_640_000_000_000_000) {
        throw new AnimationOptionsError('RUM projection capturedAtEpochMs must be a valid non-negative epoch time')
    }
    const routeKey = validateRouteKey(options.routeKey)
    const eventId = validateSafeId('eventId', options.eventId ?? safeEventId())
    const captureId = validateSafeId('captureId', snapshot.captureId)
    if (!Number.isFinite(snapshot.elapsedMs) || snapshot.elapsedMs < 0) {
        throw new AnimationOptionsError('snapshot.elapsedMs must be a finite non-negative capture duration')
    }
    const windowDurationCapped = snapshot.elapsedMs > ANIMATION_RUM_MAX_WINDOW_DURATION_MS
    const windowDurationMs = round(Math.min(snapshot.elapsedMs, ANIMATION_RUM_MAX_WINDOW_DURATION_MS))
    const metrics = projectMetrics(snapshot, windowDurationCapped)
    return {
        contractVersion: ANIMATION_RUM_CONTRACT_VERSION,
        snapshotSchemaVersion: snapshot.schemaVersion,
        eventId,
        captureId,
        capturedAt: new Date(options.capturedAtEpochMs).toISOString(),
        release: validateVersion('context.release', options.release, ''),
        dist: validateVersion('context.dist', options.dist, ''),
        environment: validateVersion('context.environment', options.environment, ''),
        sdkVersion: validateVersion('context.sdkVersion', options.sdkVersion, ANIMATION_MONITOR_VERSION),
        monitorVersion: ANIMATION_MONITOR_VERSION,
        sampleRate: options.sampleRate,
        samplingPolicyVersion: options.samplingPolicyVersion,
        context: {
            ...(routeKey ? { routeKey } : {}),
            runtimeFamily: validateRuntimeFamily(options.runtimeFamily),
            windowDurationMs,
            windowDurationCapped,
            visibilityState: ['visible', 'hidden', 'prerender', 'unknown'].includes(snapshot.visibility.current)
                ? snapshot.visibility.current
                : 'unknown',
            reducedMotion:
                snapshot.visibility.reducedMotion === true || snapshot.visibility.reducedMotion === false
                    ? snapshot.visibility.reducedMotion
                    : null,
            refreshHz:
                Number.isFinite(snapshot.frameBudget.expectedRefreshHz) &&
                snapshot.frameBudget.expectedRefreshHz >= 20 &&
                snapshot.frameBudget.expectedRefreshHz <= 360
                    ? snapshot.frameBudget.expectedRefreshHz
                    : null,
            refreshBudgetSource:
                snapshot.frameBudget.source === 'explicit' || snapshot.frameBudget.source === 'inferred'
                    ? snapshot.frameBudget.source
                    : 'unknown',
            refreshBudgetConfidence:
                snapshot.frameBudget.source === 'explicit'
                    ? 'explicit'
                    : ['high', 'medium', 'low'].includes(snapshot.frameBudget.confidence)
                      ? snapshot.frameBudget.confidence
                      : 'unknown',
        },
        capabilities: projectRumCapabilities(snapshot),
        coverage: projectRumCoverage(metrics),
        metrics,
    }
}

export class AnimationIntegration implements MonitorIntegration {
    readonly name = 'animation'
    readonly collector: AnimationCollector
    readonly sampled: boolean

    private readonly options: AnimationIntegrationOptions
    private readonly rum: ResolvedRumConfig
    private readonly runtime: AnimationRuntime
    private transport: Transport | null = null
    private lifecycleCleanup: (() => void) | null = null
    private initialized = false
    private emitted = false
    private destroyed = false

    constructor(options: AnimationIntegrationOptions = {}) {
        validateContextOptions(options)
        this.options = options
        this.rum = resolveRumConfig(options)
        this.sampled = this.rum.enabled && deterministicAnimationRumSample(this.rum.sampleKey, this.rum.sampleRate, this.rum.seed)
        this.runtime = options.runtime ?? createBrowserAnimationRuntime()
        this.collector = new AnimationCollector({ ...options, runtime: this.runtime })
    }

    setup(transport: Transport): () => void {
        this.init(transport)
        return () => this.destroy()
    }

    /** @deprecated Core uses setup(); retained as a compatibility alias. */
    init(transport: Transport): void {
        if (this.destroyed) throw new AnimationStateError('cannot init a destroyed AnimationIntegration')
        if (this.initialized) return
        this.initialized = true
        this.transport = transport
        if ((this.options.autoStart ?? true) && this.collector.state === 'idle') this.start()
        this.lifecycleCleanup =
            this.runtime.onPageLifecycle?.(
                event => {
                    if (
                        (event.type === 'hidden' || event.type === 'pagehide') &&
                        this.collector.state === 'running' &&
                        this.rum.enabled &&
                        this.sampled
                    ) {
                        // Enqueue before the transport's lower-priority lifecycle flush.
                        // Do not stop: visible/pageshow (including BFCache) may resume local capture.
                        this.emitOnce(this.collector.snapshot())
                    }
                },
                { priority: 50 }
            ) ?? null
        if (this.collector.state === 'stopped') this.emitOnce(this.collector.snapshot())
    }

    start(): boolean {
        if (this.collector.state === 'running') return true
        if (this.collector.state !== 'idle') return false
        if (!this.collector.isBrowserRuntime || this.runtime.frameCapability === 'unsupported') return false
        this.collector.start()
        return true
    }

    snapshot(): AnimationSnapshot {
        return this.collector.snapshot()
    }

    beginInteraction(kind: AnimationInteractionKind, label?: string): AnimationInteractionHandle {
        return this.collector.beginInteraction(kind, label)
    }

    selectElement(element: Element, options: AnimationElementSelectionOptions = {}): AnimationElementSelectionHandle {
        return this.collector.selectElement(element, options)
    }

    recordFrameworkStats(sample: AnimationFrameworkStatsSample): boolean {
        return this.collector.recordFrameworkStats(sample)
    }

    recordRenderStats(sample: AnimationRenderStatsSample): boolean {
        return this.collector.recordRenderStats(sample)
    }

    recordLifecycleStats(sample: AnimationLifecycleStatsSample): boolean {
        return this.collector.recordLifecycleStats(sample)
    }

    recordWorkStats(sample: AnimationWorkStatsSample): boolean {
        return this.collector.recordWorkStats(sample)
    }

    recordMediaStats(sample: AnimationMediaStatsSample): boolean {
        return this.collector.recordMediaStats(sample)
    }

    stop(): AnimationSnapshot | null {
        if (this.collector.state === 'idle' || this.collector.state === 'destroyed') return null
        const snapshot = this.collector.state === 'stopped' ? this.collector.snapshot() : this.collector.stop()
        this.emitOnce(snapshot)
        return snapshot
    }

    flush(): void {
        // A generic transport flush must not prematurely lock the one-shot RUM
        // aggregate while interactions are still active. stop(), destroy(), or
        // the page lifecycle owns finalization; flush only drains a finalized snapshot.
        if (this.collector.state === 'stopped') this.emitOnce(this.collector.snapshot())
    }

    destroy(): void {
        if (this.destroyed) return
        if (this.collector.state === 'running') this.stop()
        else if (this.collector.state === 'stopped') this.emitOnce(this.collector.snapshot())
        this.lifecycleCleanup?.()
        this.lifecycleCleanup = null
        this.collector.destroy()
        this.transport = null
        this.destroyed = true
    }

    private emitOnce(snapshot: AnimationSnapshot): void {
        if (this.emitted || !this.transport || !this.rum.enabled || !this.sampled || this.rum.sampleRate <= 0) return
        const summary = toAnimationRumSummary(snapshot, {
            capturedAtEpochMs: this.collector.epochNow(),
            sampleRate: this.rum.sampleRate,
            samplingPolicyVersion: this.rum.policyVersion,
            routeKey: this.options.context?.routeKey,
            release: this.options.context?.release,
            dist: this.options.context?.dist,
            environment: this.options.context?.environment,
            sdkVersion: this.options.context?.sdkVersion,
            runtimeFamily: this.options.context?.runtimeFamily,
        })
        const envelope: AnimationRumEnvelope = {
            event_type: 'animation_rum',
            message: '',
            ...summary,
        }
        this.emitted = true
        this.transport.send(envelope)
    }
}
