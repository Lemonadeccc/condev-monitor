import {
    ANIMATION_RUM_FAMILIES,
    ANIMATION_RUM_V2_CAPABILITIES,
    ANIMATION_RUM_V2_MAX_PAYLOAD_BYTES,
    ANIMATION_RUM_V2_METRIC_CATALOG,
    isAnimationRumV2RouteKey,
    isAnimationRumV2TargetKey,
    validateNormalizedAnimationRumV2,
} from '@condev-monitor/animation-rum-contract'

import { AnimationOptionsError } from '../collector'
import { isTargetGpuTimingSourceCompatible } from '../gpu-timing-compatibility'
import { ANIMATION_MONITOR_VERSION, ANIMATION_RUM_MAX_WINDOW_DURATION_MS } from '../integration'
import { round } from '../statistics'
import type {
    AnimationElementSelectionSnapshot,
    AnimationRumFamily,
    AnimationSnapshot,
    CapabilityEvidence,
    DurationStatistics,
    InteractionFrameWindowSummary,
    InteractionPerformanceSummary,
    InteractionQualitySummary,
    InteractionSignalWindowSummary,
} from '../types'
import type {
    AnimationRumV2CapabilityName,
    AnimationRumV2CapabilityState,
    AnimationRumV2LoafDiagnosticAggregate,
    AnimationRumV2Metric,
    AnimationRumV2MetricStatus,
    AnimationRumV2PageEvidenceSource,
    AnimationRumV2PageSnapshot,
    AnimationRumV2ProjectionOptions,
    AnimationRumV2ProviderEvidence,
    AnimationRumV2ProviderOwner,
    AnimationRumV2QualityReason,
    AnimationRumV2Report,
    AnimationRumV2RuntimeBackend,
    AnimationRumV2RuntimeContext,
    AnimationRumV2RuntimeFramework,
    AnimationRumV2RuntimeRenderer,
    AnimationRumV2TargetProjectionOptions,
    AnimationRumV2TargetSnapshot,
} from './types'

// cspell:ignore rvfc

const MAX_COUNT = 1_000_000_000
const MAX_VALUE = 1_000_000_000_000_000
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/u
const SAFE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u
const RUNTIME_FRAMEWORKS = new Set<AnimationRumV2RuntimeFramework>([
    'vanilla',
    'react',
    'preact',
    'vue',
    'angular',
    'svelte',
    'solid',
    'qwik',
    'lit',
    'mixed',
    'other',
    'unknown',
])
const RUNTIME_RENDERERS = new Set<AnimationRumV2RuntimeRenderer>(['dom', 'svg', 'canvas', 'mixed', 'other', 'unknown'])
const RUNTIME_BACKENDS = new Set<AnimationRumV2RuntimeBackend>([
    'dom',
    'canvas2d',
    'webgl',
    'webgl2',
    'webgpu',
    'mixed',
    'other',
    'unknown',
])
const VIEWPORT_BUCKETS = new Set(['tiny', 'small', 'medium', 'large', 'xlarge', 'unknown'])
const DPR_BUCKETS = new Set(['1', '1.5', '2', '3', '4+', 'unknown'])

type Scope = AnimationRumV2Report['scope']
type MetricDefinition = (typeof ANIMATION_RUM_V2_METRIC_CATALOG)[number]

interface TargetProjectionWindow {
    startedAt: number
    endedAt: number
    durationMs: number
}

interface MetricCandidate {
    value: number | null
    samples: number | null
    status: AnimationRumV2MetricStatus
}

interface ProviderAccumulator {
    accepted: number
    retained: number
    evidence: number
    rejected: number
    hadLoss: boolean
}

interface ProjectionState {
    scope: Scope
    capabilities: AnimationRumV2Report['capabilities']
    candidates: Map<string, MetricCandidate>
    providers: Map<string, ProviderAccumulator>
    reasons: Set<AnimationRumV2QualityReason>
    adapterErrorCount: number
}

function safeCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT ? value : null
}

function performanceObserverDropQuality(value: unknown): { valid: boolean; partial: boolean } {
    if (value === undefined || value === null) return { valid: true, partial: false }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return { valid: false, partial: false }
    return { valid: true, partial: value > 0 }
}

function safeNumber(value: unknown, maximum = MAX_VALUE): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? round(value, 6) : null
}

function statisticsMatchRetainedCount(statistics: DurationStatistics | null | undefined, retained: number): boolean {
    if (retained === 0) return statistics === null || statistics === undefined
    return statistics !== null && statistics !== undefined && safeCount(statistics.count) === retained
}

function statisticsCountWithin(statistics: DurationStatistics | null | undefined, maximum: number): boolean {
    if (statistics === null || statistics === undefined) return true
    const count = safeCount(statistics.count)
    return count !== null && count > 0 && count <= maximum
}

function sumCounts(...values: unknown[]): number | null {
    let total = 0
    for (const value of values) {
        const count = safeCount(value)
        if (count === null || total > MAX_COUNT - count) return null
        total += count
    }
    return total
}

function safeVersion(name: string, value: string | undefined, fallback: string): string {
    const resolved = value ?? fallback
    if (resolved !== '' && !SAFE_VERSION_RE.test(resolved)) throw new AnimationOptionsError(`${name} must be a safe version identifier`)
    return resolved
}

function safeId(name: string, value: string): string {
    if (!SAFE_ID_RE.test(value)) throw new AnimationOptionsError(`${name} must be a safe identifier containing 8 to 80 characters`)
    return value
}

function capabilityState(evidence: CapabilityEvidence | null | undefined, absent: AnimationRumV2CapabilityState = 'unknown') {
    if (!evidence) return absent
    if (evidence.state === 'supported') return 'supported'
    if (evidence.state === 'unsupported') return 'unsupported'
    return 'unknown'
}

function emptyCapabilities(): AnimationRumV2Report['capabilities'] {
    return Object.fromEntries(ANIMATION_RUM_V2_CAPABILITIES.map(name => [name, 'unknown'])) as AnimationRumV2Report['capabilities']
}

function createState(scope: Scope): ProjectionState {
    return {
        scope,
        capabilities: emptyCapabilities(),
        candidates: new Map(),
        providers: new Map(),
        reasons: new Set(),
        adapterErrorCount: 0,
    }
}

function providerKey(owner: AnimationRumV2ProviderOwner, family: AnimationRumFamily): string {
    return `${owner}\0${family}`
}

function registerProviderExact(
    state: ProjectionState,
    owner: AnimationRumV2ProviderOwner,
    family: AnimationRumFamily,
    acceptedObserved: unknown,
    retainedObserved: unknown,
    evidenceObserved: unknown,
    rejectedObserved: unknown = 0
): boolean {
    const acceptedInput = safeCount(acceptedObserved)
    const retainedInput = safeCount(retainedObserved)
    const evidenceInput = safeCount(evidenceObserved)
    const rejectedInput = safeCount(rejectedObserved)
    if (
        acceptedInput === null ||
        retainedInput === null ||
        evidenceInput === null ||
        rejectedInput === null ||
        retainedInput > acceptedInput ||
        evidenceInput > retainedInput
    ) {
        state.reasons.add('source-field-incomplete')
        return false
    }
    const key = providerKey(owner, family)
    const current = state.providers.get(key)
    if (!current) {
        state.providers.set(key, {
            accepted: acceptedInput,
            retained: retainedInput,
            evidence: evidenceInput,
            rejected: rejectedInput,
            hadLoss: retainedInput < acceptedInput,
        })
        return true
    }
    const rawAccepted = current.accepted + acceptedInput
    const rawRetained = current.retained + retainedInput
    const rawEvidence = current.evidence + evidenceInput
    const rawRejected = current.rejected + rejectedInput
    const hadLoss = current.hadLoss || retainedInput < acceptedInput || rawAccepted > MAX_COUNT
    const accepted = Math.min(MAX_COUNT, rawAccepted)
    let retained = Math.min(accepted, rawRetained)
    if (hadLoss && retained === accepted && accepted > 0) retained -= 1
    state.providers.set(key, {
        accepted,
        retained,
        evidence: Math.min(retained, rawEvidence),
        rejected: Math.min(MAX_COUNT, rawRejected),
        hadLoss,
    })
    return true
}

/**
 * A source with no retained duration sample gets one completed-window marker.
 * The marker is provider evidence, not a duration sample: it lets a supported
 * observer report an exact zero count while every non-zero source keeps its
 * original accepted/retained/evidence counts.
 */
function registerProviderWindow(
    state: ProjectionState,
    owner: AnimationRumV2ProviderOwner,
    family: AnimationRumFamily,
    totalObserved: unknown,
    retainedObserved: unknown,
    evidenceObserved: unknown = retainedObserved,
    rejectedObserved: unknown = 0,
    forcePartial = false
): boolean {
    const total = safeCount(totalObserved)
    const retainedObservedCount = safeCount(retainedObserved)
    const evidence = safeCount(evidenceObserved)
    const rejected = safeCount(rejectedObserved)
    if (
        total === null ||
        retainedObservedCount === null ||
        evidence === null ||
        rejected === null ||
        retainedObservedCount > total ||
        evidence > retainedObservedCount
    ) {
        state.reasons.add('source-field-incomplete')
        return false
    }
    // Some sources can prove incompleteness without knowing the missed count.
    // Keep exact provider totals and carry that uncertainty as source quality;
    // never invent an accepted/dropped sample merely to force `partial`.
    if (forcePartial) state.reasons.add('source-field-incomplete')
    const needsWindowMarker = evidence === 0
    const windowFits = total < MAX_COUNT && retainedObservedCount < MAX_COUNT
    const acceptedWithWindow = needsWindowMarker && windowFits ? total + 1 : total
    const retainedWithWindow = needsWindowMarker && windowFits ? retainedObservedCount + 1 : retainedObservedCount
    const evidenceWithWindow = needsWindowMarker && windowFits ? 1 : evidence
    if (evidenceWithWindow === 0) {
        state.reasons.add('source-field-incomplete')
        return false
    }
    return registerProviderExact(state, owner, family, acceptedWithWindow, retainedWithWindow, evidenceWithWindow, rejected)
}

function providerTable(state: ProjectionState): AnimationRumV2Report['providerEvidence'] {
    const table: AnimationRumV2Report['providerEvidence'] = {}
    for (const [key, value] of state.providers) {
        const [owner, family] = key.split('\0') as [AnimationRumV2ProviderOwner, AnimationRumFamily]
        const dropped = value.accepted - value.retained
        const provider: AnimationRumV2ProviderEvidence = {
            version: ANIMATION_MONITOR_VERSION,
            accepted: value.accepted,
            retained: value.retained,
            evidence: value.evidence,
            dropped,
            rejected: value.rejected,
            truncated: dropped > 0,
        }
        const families = table[owner] ?? {}
        families[family] = provider
        table[owner] = families
    }
    return table
}

function putMetric(
    state: ProjectionState,
    metricId: string,
    value: number | null,
    samples: number | null,
    status: AnimationRumV2MetricStatus
): void {
    state.candidates.set(metricId, { value, samples, status })
}

function unavailableStatus(evidence: CapabilityEvidence | null | undefined): AnimationRumV2MetricStatus {
    if (!evidence || evidence.state === 'unknown') return 'unknown'
    if (evidence.state === 'unsupported') return 'unsupported'
    return 'not-observed'
}

function pageEvidenceStatus(status: string): AnimationRumV2MetricStatus {
    if (status === 'measured' || status === 'partial' || status === 'unsupported' || status === 'unknown') return status
    return 'not-observed'
}

function putDistribution(
    state: ProjectionState,
    metricId: string,
    statistics: DurationStatistics | null | undefined,
    stat: 'p95' | 'max',
    baseStatus: AnimationRumV2MetricStatus,
    fallbackUnavailable: AnimationRumV2MetricStatus = 'not-observed'
): void {
    const value = safeNumber(statistics?.[stat])
    const samples = safeCount(statistics?.count)
    putMetric(state, metricId, value, samples, value !== null && samples !== null && samples > 0 ? baseStatus : fallbackUnavailable)
}

function projectFrames(state: ProjectionState, snapshot: AnimationSnapshot): void {
    const retained = safeCount(snapshot.frames.retainedCount)
    const total = safeCount(snapshot.frames.totalObservedCount)
    const dropped = safeCount(snapshot.frames.droppedSampleCount)
    const slowFrameCount = safeCount(snapshot.frames.slowFrameCount)
    const slowFrameRatio = safeNumber(snapshot.frames.slowFrameRatio, 1)
    const burstCount = safeCount(snapshot.bursts.count)
    const longestSlowRun = safeCount(snapshot.bursts.longestFrameCount)
    const missedFrameOpportunities = safeCount(snapshot.frames.missedFrameOpportunities)
    if (
        retained === null ||
        total === null ||
        dropped === null ||
        slowFrameCount === null ||
        burstCount === null ||
        longestSlowRun === null ||
        missedFrameOpportunities === null ||
        retained + dropped !== total ||
        slowFrameCount > retained ||
        burstCount > slowFrameCount ||
        longestSlowRun > retained ||
        (retained === 0 ? slowFrameRatio !== null : slowFrameRatio === null || slowFrameRatio !== round(slowFrameCount / retained, 6)) ||
        !statisticsMatchRetainedCount(snapshot.frames.duration, retained) ||
        !registerProviderWindow(state, 'browser-core', 'frameCadence', total, retained)
    ) {
        state.reasons.add('source-field-incomplete')
        for (const id of [
            'frame.duration.p50',
            'frame.duration.p75',
            'frame.duration.p95',
            'frame.duration.p99',
            'frame.duration.max',
            'frame.target.latest',
            'frame.refresh.latest',
            'frame.slow-rate.ratio',
            'frame.jank-burst.count',
            'frame.longest-slow-run.max',
            'frame.missed-opportunities.sum',
        ]) {
            putMetric(state, id, null, null, 'unknown')
        }
        return
    }
    const hasFrames = retained > 0
    const frameStatus: AnimationRumV2MetricStatus = hasFrames ? 'measured' : 'not-observed'
    const statistics = snapshot.frames.duration
    for (const [id, stat] of [
        ['frame.duration.p50', 'p50'],
        ['frame.duration.p75', 'p75'],
        ['frame.duration.p95', 'p95'],
        ['frame.duration.p99', 'p99'],
        ['frame.duration.max', 'max'],
    ] as const) {
        const value = safeNumber(statistics?.[stat])
        putMetric(state, id, value, retained, hasFrames && value !== null ? 'measured' : 'not-observed')
    }
    putMetric(state, 'frame.target.latest', safeNumber(snapshot.frameBudget.frameBudgetMs), retained, frameStatus)
    putMetric(state, 'frame.refresh.latest', safeNumber(snapshot.frameBudget.expectedRefreshHz, 1_000), retained, frameStatus)
    putMetric(state, 'frame.slow-rate.ratio', slowFrameRatio, retained, frameStatus)
    putMetric(state, 'frame.jank-burst.count', burstCount, retained, frameStatus)
    putMetric(state, 'frame.longest-slow-run.max', longestSlowRun, retained, frameStatus)
    putMetric(state, 'frame.missed-opportunities.sum', missedFrameOpportunities, retained, frameStatus)
}

function projectBoundedSignal(
    state: ProjectionState,
    input: {
        capability: CapabilityEvidence
        retainedCount: number | null
        totalObservedCount: number | null
        droppedSampleCount: number | null
        performanceObserverDroppedEntryCount?: number | null
        totalDurationMs: number | null
        duration: DurationStatistics | null
    },
    owner: AnimationRumV2ProviderOwner,
    family: AnimationRumFamily,
    ids: { count: string; sum: string; p95: string; max?: string }
): void {
    const capability = capabilityState(input.capability)
    if (capability !== 'supported') {
        const status: AnimationRumV2MetricStatus = capability === 'unsupported' ? 'unsupported' : 'unknown'
        for (const id of [ids.count, ids.sum, ids.p95, ids.max].filter((value): value is string => Boolean(value))) {
            putMetric(state, id, null, null, status)
        }
        return
    }
    const total = safeCount(input.totalObservedCount)
    const retained = safeCount(input.retainedCount)
    const dropped = safeCount(input.droppedSampleCount)
    const observerDrops = performanceObserverDropQuality(input.performanceObserverDroppedEntryCount)
    const totalDuration = safeNumber(input.totalDurationMs)
    if (
        total === null ||
        retained === null ||
        dropped === null ||
        !observerDrops.valid ||
        totalDuration === null ||
        retained + dropped !== total ||
        (total === 0 && totalDuration !== 0) ||
        !statisticsMatchRetainedCount(input.duration, retained)
    ) {
        state.reasons.add('source-field-incomplete')
        for (const id of [ids.count, ids.sum, ids.p95, ids.max].filter((value): value is string => Boolean(value))) {
            putMetric(state, id, null, null, 'unknown')
        }
        return
    }
    registerProviderWindow(state, owner, family, total, retained, retained, 0, observerDrops.partial)
    const status: AnimationRumV2MetricStatus = observerDrops.partial ? 'partial' : 'measured'
    putMetric(state, ids.count, total, total, status)
    putMetric(state, ids.sum, totalDuration, total, status)
    putDistribution(state, ids.p95, input.duration, 'p95', status)
    if (ids.max) putDistribution(state, ids.max, input.duration, 'max', status)
}

function projectLongAnimationFrames(state: ProjectionState, snapshot: AnimationSnapshot): void {
    const loaf = snapshot.longAnimationFrames
    state.capabilities['long-animation-frame'] = capabilityState(loaf.capability)
    projectBoundedSignal(state, loaf, 'browser-core', 'mainThread', {
        count: 'main.loaf.count',
        sum: 'main.loaf-duration.sum',
        p95: 'main.loaf-duration.p95',
    })

    const loafTotal = safeCount(loaf.totalObservedCount)
    const loafRetained = safeCount(loaf.retainedCount)
    const loafDropped = safeCount(loaf.droppedSampleCount)
    const observerDrops = performanceObserverDropQuality(loaf.performanceObserverDroppedEntryCount)
    const loafSourceValid =
        loaf.capability.state === 'supported' &&
        loafTotal !== null &&
        loafRetained !== null &&
        loafDropped !== null &&
        observerDrops.valid &&
        loafRetained + loafDropped === loafTotal &&
        statisticsMatchRetainedCount(loaf.duration, loafRetained) &&
        statisticsCountWithin(loaf.blockingDuration, loafRetained) &&
        statisticsCountWithin(loaf.styleAndLayoutTailDuration, loafRetained)
    if (loaf.capability.state === 'supported' && !loafSourceValid) state.reasons.add('source-field-incomplete')
    const baseStatus: AnimationRumV2MetricStatus =
        loaf.capability.state === 'supported'
            ? loafSourceValid
                ? observerDrops.partial
                    ? 'partial'
                    : 'measured'
                : 'unknown'
            : unavailableStatus(loaf.capability)
    putDistribution(
        state,
        'main.loaf-blocking.p95',
        loafSourceValid ? loaf.blockingDuration : null,
        'p95',
        baseStatus,
        loafSourceValid ? 'not-observed' : baseStatus
    )
    putDistribution(
        state,
        'pipeline.loaf-style-layout-tail.p95',
        loafSourceValid ? loaf.styleAndLayoutTailDuration : null,
        'p95',
        baseStatus,
        loafSourceValid ? 'not-observed' : baseStatus
    )
    if (loafSourceValid) {
        registerProviderWindow(state, 'browser-core', 'renderingPipeline', loafTotal, loafRetained, loafRetained, 0, observerDrops.partial)
    }

    const paint = loaf.paintTiming
    state.capabilities['loaf-paint-time'] = capabilityState(paint?.paintTimeCapability)
    state.capabilities['loaf-presentation-time'] = capabilityState(paint?.presentationTimeCapability)
    projectPaintDistribution(
        state,
        paint?.paintTimeCapability,
        paint?.renderStartToPaintTotalObservedCount,
        paint?.renderStartToPaintDuration,
        'pipeline.loaf-render-start-to-paint.count',
        'pipeline.loaf-render-start-to-paint.p95',
        loaf.capability.state !== 'supported' || loafSourceValid
    )
    projectPaintDistribution(
        state,
        paint?.presentationTimeCapability,
        paint?.paintToPresentationTotalObservedCount,
        paint?.paintToPresentationDuration,
        'pipeline.loaf-paint-to-presentation.count',
        'pipeline.loaf-paint-to-presentation.p95',
        loaf.capability.state !== 'supported' || loafSourceValid
    )
}

function projectPaintDistribution(
    state: ProjectionState,
    capability: CapabilityEvidence | undefined,
    totalObserved: number | null | undefined,
    duration: DurationStatistics | null | undefined,
    countId: string,
    p95Id: string,
    parentSourceValid: boolean
): void {
    if (!parentSourceValid) {
        putMetric(state, countId, null, null, 'unknown')
        putMetric(state, p95Id, null, null, 'unknown')
        return
    }
    const cap = capabilityState(capability)
    if (cap !== 'supported') {
        const status = cap === 'unsupported' ? 'unsupported' : 'unknown'
        putMetric(state, countId, null, null, status)
        putMetric(state, p95Id, null, null, status)
        return
    }
    const total = safeCount(totalObserved)
    if (total === null || !statisticsCountWithin(duration, total)) {
        state.reasons.add('source-field-incomplete')
        putMetric(state, countId, null, null, 'unknown')
        putMetric(state, p95Id, null, null, 'unknown')
        return
    }
    putMetric(state, countId, total, total, 'measured')
    putDistribution(state, p95Id, duration, 'p95', 'measured')
}

function projectLoafSupplemental(
    state: ProjectionState,
    source: AnimationRumV2LoafDiagnosticAggregate | undefined,
    family: AnimationRumFamily,
    countId: string,
    p95Id: string
): void {
    if (!source) {
        putMetric(state, countId, null, null, 'not-instrumented')
        putMetric(state, p95Id, null, null, 'not-instrumented')
        return
    }
    if (source.capability !== 'supported') {
        const status: AnimationRumV2MetricStatus = source.capability === 'unsupported' ? 'unsupported' : 'unknown'
        putMetric(state, countId, null, null, status)
        putMetric(state, p95Id, null, null, status)
        return
    }
    state.capabilities['long-animation-frame'] = 'supported'
    const count = safeCount(source.count)
    const accepted = safeCount(source.accepted)
    const retained = safeCount(source.retained)
    const dropped = safeCount(source.dropped)
    const rejected = safeCount(source.rejected)
    const p95 = safeNumber(source.p95Ms)
    const statusShapeValid =
        (source.status === 'not-observed' && accepted === 0 && retained === 0 && dropped === 0 && rejected === 0 && p95 === null) ||
        (source.status === 'measured' && accepted !== null && accepted > 0 && rejected === 0 && dropped === 0 && p95 !== null) ||
        (source.status === 'partial' &&
            accepted !== null &&
            (accepted > 0 || (rejected ?? 0) > 0) &&
            ((retained ?? 0) === 0 ? p95 === null : p95 !== null))
    if (
        count === null ||
        accepted === null ||
        retained === null ||
        dropped === null ||
        rejected === null ||
        count !== accepted ||
        retained + dropped !== accepted ||
        source.truncated !== dropped > 0 ||
        !statusShapeValid
    ) {
        state.reasons.add('source-field-incomplete')
        putMetric(state, countId, null, null, 'unknown')
        putMetric(state, p95Id, null, null, 'unknown')
        return
    }
    if (rejected > 0) registerProviderExact(state, 'browser-core', family, accepted, retained, retained, rejected)
    else registerProviderWindow(state, 'browser-core', family, accepted, retained, retained, rejected)
    if (accepted === 0 && rejected > 0) {
        putMetric(state, countId, null, null, 'unknown')
        putMetric(state, p95Id, null, null, 'unknown')
        return
    }
    const status: AnimationRumV2MetricStatus = source.status === 'partial' ? 'partial' : 'measured'
    putMetric(state, countId, count, count, status)
    putMetric(state, p95Id, p95, retained, p95 === null || retained === 0 ? 'not-observed' : status)
}

function projectEventTiming(state: ProjectionState, snapshot: AnimationSnapshot): void {
    const event = snapshot.eventTiming
    state.capabilities['event-timing'] = capabilityState(event.capability)
    const capStatus = unavailableStatus(event.capability)
    const total = safeCount(event.totalObservedCount)
    const retained = safeCount(event.retainedCount)
    const dropped = safeCount(event.droppedSampleCount)
    const observerDrops = performanceObserverDropQuality(event.performanceObserverDroppedEntryCount)
    const sourceValid =
        event.capability.state === 'supported' &&
        total !== null &&
        retained !== null &&
        dropped !== null &&
        observerDrops.valid &&
        retained + dropped === total &&
        statisticsMatchRetainedCount(event.duration, retained) &&
        statisticsCountWithin(event.inputDelay, retained) &&
        statisticsCountWithin(event.processingDuration, retained) &&
        statisticsCountWithin(event.presentationDelay, retained)
    if (sourceValid) {
        registerProviderWindow(state, 'browser-core', 'userOutcome', total, retained, retained, 0, observerDrops.partial)
        registerProviderWindow(state, 'browser-core', 'renderingPipeline', total, retained, retained, 0, observerDrops.partial)
    } else if (event.capability.state === 'supported') state.reasons.add('source-field-incomplete')
    const measuredStatus: AnimationRumV2MetricStatus =
        event.capability.state === 'supported' ? (sourceValid ? (observerDrops.partial ? 'partial' : 'measured') : 'unknown') : capStatus
    const fallbackStatus = sourceValid ? capStatus : measuredStatus
    putDistribution(state, 'outcome.event-duration.p95', sourceValid ? event.duration : null, 'p95', measuredStatus, fallbackStatus)
    putDistribution(state, 'outcome.input-delay.p95', sourceValid ? event.inputDelay : null, 'p95', measuredStatus, fallbackStatus)
    putDistribution(
        state,
        'outcome.processing-duration.p95',
        sourceValid ? event.processingDuration : null,
        'p95',
        measuredStatus,
        fallbackStatus
    )
    const presentationCapability = event.presentationDelayCapability
    putDistribution(
        state,
        'pipeline.presentation-delay.p95',
        sourceValid ? event.presentationDelay : null,
        'p95',
        sourceValid ? (presentationCapability.state === 'supported' ? 'measured' : unavailableStatus(presentationCapability)) : 'unknown',
        sourceValid ? unavailableStatus(presentationCapability) : 'unknown'
    )
}

function projectInteractions(state: ProjectionState, snapshot: AnimationSnapshot): void {
    const interactions = snapshot.interactions
    const total = safeCount(interactions.totalObservedCount)
    const retained = safeCount(interactions.retainedCount)
    const dropped = safeCount(interactions.droppedSampleCount)
    const completed = safeCount(interactions.completedCount)
    const cancelled = safeCount(interactions.cancelledCount)
    const abandoned = safeCount(interactions.abandonedCount)
    if (
        total === null ||
        retained === null ||
        dropped === null ||
        completed === null ||
        cancelled === null ||
        abandoned === null ||
        retained + dropped !== total ||
        sumCounts(completed, cancelled, abandoned) !== total ||
        !statisticsMatchRetainedCount(interactions.duration, retained)
    ) {
        for (const id of [
            'outcome.interaction.count',
            'outcome.interaction-duration.p95',
            'outcome.interaction-completed.count',
            'outcome.interaction-cancelled.count',
            'outcome.interaction-abandoned.count',
        ]) {
            putMetric(state, id, null, null, 'unknown')
        }
        state.reasons.add('source-field-incomplete')
        return
    }
    registerProviderWindow(state, 'browser-core', 'userOutcome', total, retained)
    putMetric(state, 'outcome.interaction.count', total, total, 'measured')
    putDistribution(state, 'outcome.interaction-duration.p95', interactions.duration, 'p95', 'measured')
    putMetric(state, 'outcome.interaction-completed.count', completed, total, 'measured')
    putMetric(state, 'outcome.interaction-cancelled.count', cancelled, total, 'measured')
    putMetric(state, 'outcome.interaction-abandoned.count', abandoned, total, 'measured')
}

function projectMonitorOverhead(state: ProjectionState, snapshot: AnimationSnapshot): void {
    const overhead = snapshot.monitorOverhead
    const callbackCount = safeCount(overhead.callbackCount)
    const callbackRetained = safeCount(overhead.retainedCount)
    const reportCount = safeCount(overhead.reportBuildRetainedCount)
    const callbackDropped = safeCount(overhead.droppedSampleCount)
    const reportDropped = safeCount(overhead.reportBuildDroppedSampleCount)
    const reportTotal = sumCounts(reportCount, reportDropped)
    const total = sumCounts(callbackCount, reportTotal)
    const retained = sumCounts(callbackRetained, reportCount)
    if (
        total !== null &&
        retained !== null &&
        callbackCount !== null &&
        callbackRetained !== null &&
        callbackDropped !== null &&
        callbackRetained + callbackDropped === callbackCount &&
        retained <= total
    ) {
        registerProviderWindow(state, 'browser-core', 'monitorOverhead', total, retained)
    } else state.reasons.add('source-field-incomplete')
    const countStatus: AnimationRumV2MetricStatus = callbackCount === null ? 'unknown' : 'measured'
    putMetric(state, 'monitor.callback.count', callbackCount, callbackCount, countStatus)
    const ratio =
        snapshot.elapsedMs > 0 && Number.isFinite(snapshot.elapsedMs)
            ? safeNumber(overhead.totalCallbackDurationMs / snapshot.elapsedMs, 1)
            : null
    putMetric(state, 'monitor.callback-self-time.ratio', ratio, callbackCount, ratio === null ? 'not-observed' : countStatus)
    putDistribution(state, 'monitor.report-build.p95', overhead.reportBuildDuration, 'p95', 'measured')
}

function projectInputScheduling(
    state: ProjectionState,
    input: AnimationSnapshot['inputFrameScheduling'] | NonNullable<AnimationElementSelectionSnapshot['correlated']>['inputFrameScheduling']
): void {
    if (!input || input.status === 'not-instrumented') {
        state.capabilities['input-frame-scheduling'] = 'disabled'
        putMetric(state, 'main.input-capture-to-next-raf.count', null, null, 'not-instrumented')
        putMetric(state, 'main.input-capture-to-next-raf.p95', null, null, 'not-instrumented')
        return
    }
    state.capabilities['input-frame-scheduling'] = 'supported'
    const total = safeCount(input.totalObservedCount)
    const retained = safeCount(input.retainedCount)
    const dropped = safeCount(input.droppedSampleCount)
    const cancelled = safeCount(input.cancelledSampleCount)
    const pending = safeCount(input.pendingCount)
    if (
        total === null ||
        retained === null ||
        dropped === null ||
        cancelled === null ||
        pending === null ||
        retained > total ||
        dropped < total - retained
    ) {
        state.reasons.add('source-field-incomplete')
        putMetric(state, 'main.input-capture-to-next-raf.count', null, null, 'unknown')
        putMetric(state, 'main.input-capture-to-next-raf.p95', null, null, 'unknown')
        return
    }
    // droppedSampleCount contains both ring evictions (accepted but no longer
    // retained) and capture/queue overflow (never accepted). Recover the latter
    // so provider accepted/retained/rejected counts keep their meanings.
    const rejected = sumCounts(cancelled, pending, dropped - (total - retained))
    if (rejected === null) {
        state.reasons.add('source-field-incomplete')
        putMetric(state, 'main.input-capture-to-next-raf.count', null, null, 'unknown')
        putMetric(state, 'main.input-capture-to-next-raf.p95', null, null, 'unknown')
        return
    }
    if (rejected > 0) registerProviderExact(state, 'input-scheduling', 'mainThread', total, retained, retained, rejected)
    else registerProviderWindow(state, 'input-scheduling', 'mainThread', total, retained, retained, rejected)
    const status: AnimationRumV2MetricStatus = input.status === 'partial' ? 'partial' : 'measured'
    putMetric(state, 'main.input-capture-to-next-raf.count', total, total, status)
    putDistribution(state, 'main.input-capture-to-next-raf.p95', input.duration, 'p95', status)
}

function projectWebVitals(state: ProjectionState, snapshot: AnimationSnapshot): void {
    const webVitals = snapshot.webVitals
    const capability = capabilityState(webVitals.capability)
    state.capabilities['web-vitals'] = capability
    state.capabilities['web-vitals-attribution'] =
        capability === 'supported' && webVitals.capability.observed ? 'supported' : capability === 'unsupported' ? 'unsupported' : 'unknown'
    state.capabilities['web-vitals-soft-navigation'] = 'unknown'
    const latest = [webVitals.latest.CLS, webVitals.latest.INP, webVitals.latest.LCP].filter(value => value !== null)
    if (latest.length > 0) registerProviderWindow(state, 'web-vitals-runtime', 'userOutcome', latest.length, latest.length)
    for (const [name, id] of [
        ['CLS', 'vital.cls.latest'],
        ['INP', 'vital.inp.latest'],
        ['LCP', 'vital.lcp.latest'],
    ] as const) {
        const measurement = webVitals.latest[name]
        const value = safeNumber(measurement?.value)
        putMetric(
            state,
            id,
            value,
            value === null ? null : 1,
            value !== null
                ? 'measured'
                : capability === 'unsupported'
                  ? 'unsupported'
                  : capability === 'unknown'
                    ? 'unknown'
                    : 'not-observed'
        )
    }
}

function projectResources(state: ProjectionState, snapshot: AnimationSnapshot): void {
    const resources = snapshot.resourceTiming
    state.capabilities['resource-timing'] = capabilityState(resources.capability)
    state.capabilities['resource-timing-buffer-events'] = capabilityState(resources.bufferEventCapability)
    const capStatus = unavailableStatus(resources.capability)
    const total = safeCount(resources.totalObservedCount)
    const retained = safeCount(resources.retainedCount)
    const dropped = safeCount(resources.droppedSampleCount)
    const observerDrops = performanceObserverDropQuality(resources.performanceObserverDroppedEntryCount)
    const rejected = safeCount(resources.rejectedEntryCount)
    const totalDuration = safeNumber(resources.totalDurationMs)
    const sourceValid =
        resources.capability.state === 'supported' &&
        total !== null &&
        retained !== null &&
        dropped !== null &&
        observerDrops.valid &&
        rejected !== null &&
        totalDuration !== null &&
        retained + dropped === total &&
        (total !== 0 || totalDuration === 0) &&
        statisticsMatchRetainedCount(resources.duration, retained)
    if (sourceValid) {
        registerProviderWindow(state, 'resource-timing', 'resourcesMedia', total, retained, retained, rejected, observerDrops.partial)
    } else if (resources.capability.state === 'supported') state.reasons.add('source-field-incomplete')
    const status: AnimationRumV2MetricStatus =
        resources.capability.state === 'supported'
            ? sourceValid
                ? observerDrops.partial
                    ? 'partial'
                    : 'measured'
                : 'unknown'
            : capStatus
    putMetric(state, 'resource.count', sourceValid ? total : null, sourceValid ? total : null, status)
    putDistribution(
        state,
        'resource.duration.p95',
        sourceValid ? resources.duration : null,
        'p95',
        status,
        sourceValid ? capStatus : status
    )
    for (const [id, value] of [
        ['resource.transfer-size.sum', resources.transferSizeBytes],
        ['resource.encoded-size.sum', resources.encodedBodySizeBytes],
        ['resource.decoded-size.sum', resources.decodedBodySizeBytes],
    ] as const) {
        const safeValue = safeNumber(value)
        if (resources.capability.state === 'supported' && safeValue === null) state.reasons.add('source-field-incomplete')
        putMetric(
            state,
            id,
            sourceValid ? safeValue : null,
            sourceValid && safeValue !== null ? total : null,
            !sourceValid ? status : safeValue === null ? 'unknown' : status
        )
    }
}

function projectPageEvidence(state: ProjectionState, pageEvidence: AnimationRumV2PageEvidenceSource | undefined): void {
    if (!pageEvidence || pageEvidence.enabled !== true) {
        state.capabilities['page-evidence'] = 'disabled'
        state.capabilities['document-animations-inspection'] = 'disabled'
        state.capabilities['canvas-context-registry'] = 'disabled'
        for (const id of [
            'animation.running.count',
            'animation.infinite.count',
            'accessibility.reduced-motion-active-candidate.count',
            'surface.canvas.count',
            'surface.svg.count',
            'surface.canvas2d.count',
            'surface.webgl.count',
            'surface.webgpu.count',
            'media.video-element.count',
        ]) {
            putMetric(state, id, null, null, 'not-instrumented')
        }
        return
    }
    state.capabilities['page-evidence'] = capabilityState(pageEvidence.documentScopes?.capability, 'supported')
    const scopePartial = pageEvidence.documentScopes?.truncated === true
    const animations = pageEvidence.animations
    state.capabilities['document-animations-inspection'] = capabilityState(animations.capability)
    const animationSamples = safeCount(animations.sampleCount)
    const animationTotal = safeCount(animations.current.total)
    const animationInspected = safeCount(animations.current.inspected)
    const animationDropped = safeCount(animations.current.dropped)
    const animationStatus = pageEvidenceStatus(animations.status)
    if (
        animations.capability.state === 'supported' &&
        animationSamples !== null &&
        animationSamples > 0 &&
        animationTotal !== null &&
        animationInspected !== null &&
        animationDropped !== null &&
        animationInspected + animationDropped === animationTotal
    ) {
        registerProviderWindow(
            state,
            'browser-page-evidence',
            'motionQuality',
            animationTotal,
            animationInspected,
            animationInspected,
            0,
            animationStatus === 'partial' || scopePartial
        )
    } else if (animations.capability.state === 'supported' && animationStatus !== 'not-observed') {
        state.reasons.add('source-field-incomplete')
    }
    putMetric(state, 'animation.running.count', safeCount(animations.current.running), animationInspected, animationStatus)
    putMetric(state, 'animation.infinite.count', safeCount(animations.current.infinite), animationInspected, animationStatus)

    const surfaces = pageEvidence.rendererSurfaces
    state.capabilities['canvas-context-registry'] = capabilityState(surfaces.contextObservationCapability)
    const surfaceSamples = safeCount(surfaces.sampleCount)
    const surfaceTotal = safeCount(surfaces.current.total)
    const surfaceRetained = safeCount(surfaces.current.retained)
    const surfaceDropped = safeCount(surfaces.current.dropped)
    const unknownCanvasCount = safeCount(surfaces.current.canvasUnknown)
    const surfaceStatus = pageEvidenceStatus(surfaces.status)
    if (
        surfaces.discoveryCapability.state === 'supported' &&
        surfaceSamples !== null &&
        surfaceSamples > 0 &&
        surfaceTotal !== null &&
        surfaceRetained !== null &&
        surfaceDropped !== null &&
        surfaceRetained + surfaceDropped === surfaceTotal
    ) {
        registerProviderWindow(
            state,
            'browser-page-evidence',
            'renderer',
            surfaceTotal,
            surfaceRetained,
            surfaceRetained,
            0,
            surfaceStatus === 'partial' || scopePartial || (unknownCanvasCount ?? 0) > 0
        )
    } else if (surfaces.discoveryCapability.state === 'supported' && surfaceStatus !== 'not-observed') {
        state.reasons.add('source-field-incomplete')
    }
    const canvasCount = sumCounts(
        surfaces.current.canvasUnknown,
        surfaces.current.canvas2d,
        surfaces.current.webgl,
        surfaces.current.webgl2,
        surfaces.current.webgpu
    )
    putMetric(state, 'surface.canvas.count', canvasCount, surfaceRetained, surfaceStatus)
    putMetric(state, 'surface.svg.count', safeCount(surfaces.current.svg), surfaceRetained, surfaceStatus)
    const contextStatus =
        surfaces.contextObservationCapability.state === 'supported'
            ? surfaceStatus === 'measured' && (unknownCanvasCount ?? 0) > 0
                ? 'partial'
                : surfaceStatus
            : unavailableStatus(surfaces.contextObservationCapability)
    putMetric(state, 'surface.canvas2d.count', safeCount(surfaces.current.canvas2d), surfaceRetained, contextStatus)
    putMetric(state, 'surface.webgl.count', sumCounts(surfaces.current.webgl, surfaces.current.webgl2), surfaceRetained, contextStatus)
    putMetric(state, 'surface.webgpu.count', safeCount(surfaces.current.webgpu), surfaceRetained, contextStatus)

    const media = pageEvidence.media
    const mediaSamples = safeCount(pageEvidence.sampleCount)
    const videoTotal = safeCount(media.currentVideoCount)
    const videoRetained = safeCount(media.retainedVideoCount)
    const videoDropped = safeCount(media.droppedVideoCount)
    const mediaStatus = pageEvidenceStatus(media.status)
    if (
        media.capability.state === 'supported' &&
        mediaSamples !== null &&
        mediaSamples > 0 &&
        videoTotal !== null &&
        videoRetained !== null &&
        videoDropped !== null &&
        videoRetained + videoDropped === videoTotal
    ) {
        registerProviderWindow(
            state,
            'browser-page-evidence',
            'resourcesMedia',
            videoTotal,
            videoRetained,
            videoRetained,
            0,
            mediaStatus === 'partial' || scopePartial
        )
    } else if (media.capability.state === 'supported' && mediaStatus !== 'not-observed') {
        state.reasons.add('source-field-incomplete')
    }
    const mediaCountStatus: AnimationRumV2MetricStatus =
        media.capability.state === 'supported' && mediaSamples !== null && mediaSamples > 0
            ? mediaStatus === 'partial' || scopePartial
                ? 'partial'
                : 'measured'
            : mediaStatus
    putMetric(state, 'media.video-element.count', videoTotal, videoTotal, mediaCountStatus)
    state.capabilities['video-frame-callback'] =
        safeCount(media.rvfcSupportedVideoCount) !== null && media.rvfcSupportedVideoCount > 0
            ? 'supported'
            : safeCount(media.rvfcUnsupportedVideoCount) !== null && media.rvfcUnsupportedVideoCount > 0
              ? 'unsupported'
              : 'unknown'

    const reducedMotion = pageEvidence.reducedMotion
    state.capabilities['reduced-motion-preference'] = capabilityState(reducedMotion.capability)
    const reducedSamples = safeCount(reducedMotion.reducedMotionSampleCount)
    if (reducedMotion.capability.state === 'supported' && reducedMotion.preference === true && reducedSamples !== null) {
        registerProviderWindow(
            state,
            'browser-page-evidence',
            'accessibility',
            reducedSamples,
            reducedSamples,
            reducedSamples,
            0,
            pageEvidenceStatus(reducedMotion.status) === 'partial' || scopePartial
        )
    }
    const reducedStatus =
        reducedMotion.preference === true
            ? pageEvidenceStatus(reducedMotion.status) === 'measured' && scopePartial
                ? 'partial'
                : pageEvidenceStatus(reducedMotion.status)
            : 'not-observed'
    putMetric(
        state,
        'accessibility.reduced-motion-active-candidate.count',
        reducedMotion.preference === true ? safeCount(reducedMotion.current.runningAnimationCandidates) : null,
        reducedMotion.preference === true ? reducedSamples : null,
        reducedStatus
    )
}

function registerHostProvider(
    state: ProjectionState,
    owner: AnimationRumV2ProviderOwner,
    family: AnimationRumFamily,
    source: {
        acceptedSampleCount: number
        retainedSampleCount: number
        droppedSampleCount: number
        evidenceSampleCount: number
        retainedEvidenceSampleCount: number
        rejectedSampleCount: number
        truncated: boolean
    }
): { valid: boolean; accepted: number; retained: number; rejected: number; partial: boolean } {
    const accepted = safeCount(source.acceptedSampleCount)
    const retained = safeCount(source.retainedSampleCount)
    const dropped = safeCount(source.droppedSampleCount)
    const evidence = safeCount(source.evidenceSampleCount)
    const retainedEvidence = safeCount(source.retainedEvidenceSampleCount)
    const rejected = safeCount(source.rejectedSampleCount)
    if (
        accepted === null ||
        retained === null ||
        dropped === null ||
        evidence === null ||
        retainedEvidence === null ||
        rejected === null ||
        retained + dropped !== accepted ||
        source.truncated !== dropped > 0 ||
        evidence > accepted ||
        retainedEvidence > retained ||
        retainedEvidence > evidence
    ) {
        state.reasons.add('source-field-incomplete')
        return { valid: false, accepted: 0, retained: 0, rejected: 0, partial: false }
    }
    if (accepted > 0 || rejected > 0) {
        registerProviderExact(state, owner, family, accepted, retained, retainedEvidence, rejected)
    }
    return { valid: true, accepted, retained, rejected, partial: dropped > 0 || rejected > 0 }
}

function projectHostEvidence(state: ProjectionState, snapshot: AnimationSnapshot): void {
    const host = snapshot.hostEvidence
    const frameworkActive =
        (safeCount(host.framework.acceptedSampleCount) ?? 0) > 0 || (safeCount(host.framework.rejectedSampleCount) ?? 0) > 0
    state.capabilities['framework-adapter'] = frameworkActive ? 'supported' : 'disabled'

    const renderer = host.renderer
    const rendererActive = (safeCount(renderer.acceptedSampleCount) ?? 0) > 0 || (safeCount(renderer.rejectedSampleCount) ?? 0) > 0
    state.capabilities['renderer-adapter'] = rendererActive ? 'supported' : 'disabled'
    const rendererProvider = registerHostProvider(state, 'renderer-adapter', 'renderer', renderer)
    const rendererStatus: AnimationRumV2MetricStatus = !rendererProvider.valid
        ? 'unknown'
        : rendererProvider.partial
          ? 'partial'
          : 'measured'
    const rendererFallback: AnimationRumV2MetricStatus = !rendererProvider.valid
        ? 'unknown'
        : rendererActive
          ? 'not-observed'
          : 'not-instrumented'
    const drawCallsValid = rendererProvider.valid && statisticsCountWithin(renderer.drawCalls, rendererProvider.retained)
    const trianglesValid = rendererProvider.valid && statisticsCountWithin(renderer.triangles, rendererProvider.retained)
    if (!drawCallsValid || !trianglesValid) state.reasons.add('source-field-incomplete')
    putDistribution(
        state,
        'renderer.draw-calls.p95',
        drawCallsValid ? renderer.drawCalls : null,
        'p95',
        rendererStatus,
        drawCallsValid ? rendererFallback : 'unknown'
    )
    putDistribution(
        state,
        'renderer.triangles.p95',
        trianglesValid ? renderer.triangles : null,
        'p95',
        rendererStatus,
        trianglesValid ? rendererFallback : 'unknown'
    )
    const gpuMeasured = safeCount(renderer.gpuMeasuredSampleCount)
    const gpuRejected = safeCount(renderer.gpuRejectedSampleCount)
    const gpuCountsValid =
        rendererProvider.valid &&
        gpuMeasured !== null &&
        gpuRejected !== null &&
        gpuMeasured + gpuRejected <= rendererProvider.retained &&
        ((gpuMeasured === 0 && renderer.gpuFrameMs === null) ||
            (gpuMeasured > 0 && statisticsMatchRetainedCount(renderer.gpuFrameMs, gpuMeasured)))
    if (!gpuCountsValid) state.reasons.add('source-field-incomplete')
    const gpuRejectedEvidence = gpuCountsValid && (gpuRejected > 0 || rendererProvider.rejected > 0)
    const gpuCapability: AnimationRumV2CapabilityState = !rendererActive
        ? 'disabled'
        : !gpuCountsValid
          ? 'unknown'
          : gpuMeasured > 0
            ? 'supported'
            : gpuRejectedEvidence
              ? 'unknown'
              : 'disabled'
    state.capabilities['gpu-timer-query'] = gpuCapability
    putDistribution(
        state,
        'renderer.gpu-frame.p95',
        gpuCountsValid ? renderer.gpuFrameMs : null,
        'p95',
        rendererStatus,
        gpuCountsValid && gpuCapability !== 'unknown' ? rendererFallback : 'unknown'
    )

    const media = host.media
    const mediaActive = (safeCount(media.acceptedSampleCount) ?? 0) > 0 || (safeCount(media.rejectedSampleCount) ?? 0) > 0
    state.capabilities['media-adapter'] = mediaActive ? 'supported' : 'disabled'
    const mediaProvider = registerHostProvider(state, 'media-adapter', 'resourcesMedia', media)
    const playbackSamples = safeCount(media.playbackQualityMeasuredSampleCount)
    // The status breakdown was added without changing the local snapshot schema.
    // Its complete absence is a legacy snapshot; a half-present breakdown is corrupt.
    const unsupportedCountPresent = media.playbackQualityUnsupportedSampleCount !== undefined
    const errorCountPresent = media.playbackQualityErrorSampleCount !== undefined
    const statusBreakdownPresent = unsupportedCountPresent || errorCountPresent
    const statusBreakdownComplete = unsupportedCountPresent && errorCountPresent
    const playbackUnsupported = unsupportedCountPresent ? safeCount(media.playbackQualityUnsupportedSampleCount) : null
    const playbackErrors = errorCountPresent ? safeCount(media.playbackQualityErrorSampleCount) : null
    const playbackStatusTotal =
        statusBreakdownComplete && playbackSamples !== null && playbackUnsupported !== null && playbackErrors !== null
            ? sumCounts(playbackSamples, playbackUnsupported, playbackErrors)
            : null
    const totalVideoFrames = safeCount(media.totalVideoFramesDelta)
    const droppedVideoFrames = safeCount(media.droppedVideoFramesDelta)
    const playbackRatio = safeNumber(media.playbackDropRatio, 1)
    const measuredAggregateValid =
        playbackSamples !== null &&
        (playbackSamples === 0
            ? (media.totalVideoFramesDelta === null || media.totalVideoFramesDelta === undefined) &&
              (media.droppedVideoFramesDelta === null || media.droppedVideoFramesDelta === undefined) &&
              playbackRatio === null
            : totalVideoFrames !== null &&
              droppedVideoFrames !== null &&
              droppedVideoFrames <= totalVideoFrames &&
              (totalVideoFrames === 0
                  ? droppedVideoFrames === 0 && playbackRatio === null
                  : playbackRatio !== null && playbackRatio === round(droppedVideoFrames / totalVideoFrames, 6)))
    const statusBreakdownValid =
        !statusBreakdownPresent ||
        (statusBreakdownComplete &&
            playbackUnsupported !== null &&
            playbackErrors !== null &&
            playbackStatusTotal === mediaProvider.retained)
    const playbackValid =
        mediaProvider.valid &&
        measuredAggregateValid &&
        statusBreakdownValid &&
        playbackSamples !== null &&
        playbackSamples <= mediaProvider.retained &&
        (playbackSamples > 0 || playbackRatio === null)
    if (!playbackValid) state.reasons.add('source-field-incomplete')
    const unsupportedOnly = statusBreakdownComplete && playbackSamples === 0 && (playbackUnsupported ?? 0) > 0 && playbackErrors === 0
    let playbackCapability: AnimationRumV2CapabilityState
    if (!mediaProvider.valid || !playbackValid) playbackCapability = 'unknown'
    else if (!mediaActive) playbackCapability = 'disabled'
    else if ((playbackSamples ?? 0) > 0) playbackCapability = 'supported'
    else if (unsupportedOnly && !mediaProvider.partial) playbackCapability = 'unsupported'
    else playbackCapability = 'unknown'
    state.capabilities['video-playback-quality'] = playbackCapability

    let playbackStatus: AnimationRumV2MetricStatus
    if (!playbackValid) playbackStatus = 'unknown'
    else if ((playbackSamples ?? 0) === 0) playbackStatus = unsupportedOnly && !mediaProvider.partial ? 'unsupported' : 'unknown'
    else if (playbackRatio === null) playbackStatus = 'not-observed'
    else playbackStatus = mediaProvider.partial ? 'partial' : 'measured'
    putMetric(
        state,
        'media.video-dropped-frame-rate.ratio',
        playbackValid ? playbackRatio : null,
        playbackValid && playbackRatio !== null ? playbackSamples : null,
        playbackStatus
    )
}

function projectInteractionQuality(state: ProjectionState, quality: InteractionQualitySummary | undefined): void {
    if (!quality) {
        state.capabilities['interaction-quality-adapter'] = 'disabled'
        for (const id of [
            'interaction.input-to-visual.p95',
            'interaction.pointer-sample-age.p95',
            'interaction.progress-error.p95',
            'motion.settle-time.p95',
        ]) {
            putMetric(state, id, null, null, 'not-instrumented')
        }
        return
    }
    state.capabilities['interaction-quality-adapter'] = 'supported'
    const accepted = safeCount(quality.acceptedSampleCount)
    const retained = safeCount(quality.retainedSampleCount)
    const dropped = safeCount(quality.droppedSampleCount)
    const rejected = safeCount(quality.rejectedSampleCount)
    if (accepted === null || retained === null || dropped === null || rejected === null || retained + dropped !== accepted) {
        state.reasons.add('source-field-incomplete')
        for (const id of [
            'interaction.input-to-visual.p95',
            'interaction.pointer-sample-age.p95',
            'interaction.progress-error.p95',
            'motion.settle-time.p95',
        ]) {
            putMetric(state, id, null, null, 'unknown')
        }
        return
    }
    registerProviderExact(state, 'target-sidecar', 'scrollGesture', accepted, retained, retained, rejected)
    registerProviderExact(state, 'target-sidecar', 'motionQuality', accepted, retained, retained, rejected)
    const status: AnimationRumV2MetricStatus =
        quality.status === 'partial' ? 'partial' : quality.status === 'not-observed' ? 'not-observed' : 'measured'
    putDistribution(state, 'interaction.input-to-visual.p95', quality.inputToVisual, 'p95', status)
    putDistribution(state, 'interaction.pointer-sample-age.p95', quality.pointerSampleAge, 'p95', status)
    putDistribution(state, 'interaction.progress-error.p95', quality.progressError, 'p95', status)
    putDistribution(state, 'motion.settle-time.p95', quality.settleTime, 'p95', status)
}

function targetSignalStatus(summary: InteractionSignalWindowSummary | InteractionFrameWindowSummary): AnimationRumV2MetricStatus {
    if (summary.status === 'measured' || summary.status === 'partial' || summary.status === 'unsupported' || summary.status === 'unknown') {
        return summary.status
    }
    return 'not-observed'
}

function projectTargetTemporalEvidence(state: ProjectionState, correlated: InteractionPerformanceSummary | null): void {
    if (!correlated) {
        for (const definition of ANIMATION_RUM_V2_METRIC_CATALOG) {
            if (definition.bindings.some(binding => binding.scope === 'target' && binding.relation === 'target-temporal-overlap')) {
                putMetric(state, definition.metricId, null, null, 'not-observed')
            }
        }
        projectInputScheduling(state, undefined)
        return
    }

    const frames = correlated.frames
    const frameStatus = targetSignalStatus(frames)
    const frameCount = safeCount(frames.retainedCount)
    const slowFrameCount = safeCount(frames.slowFrameCount)
    const slowFrameRatio = safeNumber(frames.slowFrameRatio, 1)
    const missedFrameOpportunities = safeCount(frames.missedFrameOpportunities)
    const burstCount = safeCount(frames.bursts.count)
    const longestSlowRun = safeCount(frames.bursts.longestFrameCount)
    const frameShapeValid =
        frameCount !== null &&
        slowFrameCount !== null &&
        missedFrameOpportunities !== null &&
        burstCount !== null &&
        longestSlowRun !== null &&
        slowFrameCount <= frameCount &&
        burstCount <= slowFrameCount &&
        longestSlowRun <= frameCount &&
        statisticsMatchRetainedCount(frames.duration, frameCount) &&
        ((frameCount === 0 && (frameStatus === 'not-observed' || frameStatus === 'partial') && slowFrameRatio === null) ||
            (frameCount > 0 &&
                (frameStatus === 'measured' || frameStatus === 'partial') &&
                slowFrameRatio !== null &&
                slowFrameRatio === round(slowFrameCount / frameCount, 6)))
    if (!frameShapeValid) state.reasons.add('source-field-incomplete')
    if (frameShapeValid && frameStatus !== 'not-observed') {
        registerProviderWindow(state, 'browser-core', 'frameCadence', frameCount, frameCount, frameCount, 0, frameStatus === 'partial')
    }
    for (const [id, stat] of [
        ['frame.duration.p50', 'p50'],
        ['frame.duration.p75', 'p75'],
        ['frame.duration.p95', 'p95'],
        ['frame.duration.p99', 'p99'],
        ['frame.duration.max', 'max'],
    ] as const) {
        const value = frameShapeValid ? safeNumber(frames.duration?.[stat]) : null
        putMetric(
            state,
            id,
            value,
            frameShapeValid ? frameCount : null,
            !frameShapeValid ? 'unknown' : value === null ? 'not-observed' : frameStatus
        )
    }
    const aggregateStatus: AnimationRumV2MetricStatus = frameShapeValid ? frameStatus : 'unknown'
    putMetric(state, 'frame.slow-rate.ratio', frameShapeValid ? slowFrameRatio : null, frameShapeValid ? frameCount : null, aggregateStatus)
    putMetric(state, 'frame.jank-burst.count', frameShapeValid ? burstCount : null, frameShapeValid ? frameCount : null, aggregateStatus)
    putMetric(
        state,
        'frame.longest-slow-run.max',
        frameShapeValid ? longestSlowRun : null,
        frameShapeValid ? frameCount : null,
        aggregateStatus
    )
    putMetric(
        state,
        'frame.missed-opportunities.sum',
        frameShapeValid ? missedFrameOpportunities : null,
        frameShapeValid ? frameCount : null,
        aggregateStatus
    )

    projectTargetSignal(state, correlated.longAnimationFrames, 'long-animation-frame', 'mainThread', {
        count: 'main.loaf.count',
        sum: 'main.loaf-duration.sum',
        p95: 'main.loaf-duration.p95',
    })
    putMetric(state, 'main.loaf-blocking.p95', null, null, 'not-instrumented')
    putMetric(state, 'pipeline.loaf-style-layout-tail.p95', null, null, 'not-instrumented')
    for (const id of [
        'pipeline.loaf-render-start-to-paint.count',
        'pipeline.loaf-render-start-to-paint.p95',
        'pipeline.loaf-paint-to-presentation.count',
        'pipeline.loaf-paint-to-presentation.p95',
        'outcome.loaf-first-ui-to-end.count',
        'outcome.loaf-first-ui-to-end.p95',
        'pipeline.loaf-forced-style-layout.count',
        'pipeline.loaf-forced-style-layout.p95',
    ]) {
        putMetric(state, id, null, null, 'not-instrumented')
    }

    projectTargetSignal(state, correlated.longTasks, 'longtask', 'mainThread', {
        count: 'main.long-task.count',
        sum: 'main.long-task-duration.sum',
        p95: 'main.long-task-duration.p95',
        max: 'main.long-task-duration.max',
    })

    const eventStatus = targetSignalStatus(correlated.eventTiming)
    const eventCount = safeCount(correlated.eventTiming.overlapCount)
    const eventOverlapDuration = safeNumber(correlated.eventTiming.overlapDurationMs)
    const eventDurationCount = safeCount(correlated.eventTiming.duration?.count)
    const eventUnavailable = eventStatus === 'unsupported' || eventStatus === 'unknown' || eventStatus === 'not-instrumented'
    const eventShapeValid =
        (eventUnavailable &&
            correlated.eventTiming.overlapCount === null &&
            correlated.eventTiming.overlapDurationMs === null &&
            correlated.eventTiming.duration === null) ||
        (eventStatus === 'not-observed' && eventCount === 0 && eventOverlapDuration === 0 && correlated.eventTiming.duration === null) ||
        ((eventStatus === 'measured' || eventStatus === 'partial') &&
            eventCount !== null &&
            eventOverlapDuration !== null &&
            ((eventCount === 0 && eventOverlapDuration === 0 && correlated.eventTiming.duration === null) ||
                (eventCount > 0 && eventDurationCount === eventCount && correlated.eventTiming.duration !== null)))
    if (!eventShapeValid) state.reasons.add('source-field-incomplete')
    if (eventShapeValid && !eventUnavailable) {
        registerProviderWindow(state, 'browser-core', 'userOutcome', eventCount, eventCount, eventCount, 0, eventStatus === 'partial')
    }
    putDistribution(
        state,
        'outcome.event-duration.p95',
        eventShapeValid ? correlated.eventTiming.duration : null,
        'p95',
        eventShapeValid ? eventStatus : 'unknown',
        eventShapeValid ? 'not-observed' : 'unknown'
    )
    putMetric(state, 'outcome.input-delay.p95', null, null, 'not-instrumented')
    putMetric(state, 'outcome.processing-duration.p95', null, null, 'not-instrumented')
    putMetric(state, 'pipeline.presentation-delay.p95', null, null, 'not-instrumented')
    for (const id of [
        'outcome.interaction.count',
        'outcome.interaction-duration.p95',
        'outcome.interaction-completed.count',
        'outcome.interaction-cancelled.count',
        'outcome.interaction-abandoned.count',
    ]) {
        putMetric(state, id, null, null, 'not-instrumented')
    }
    projectInputScheduling(state, correlated.inputFrameScheduling)
    projectInteractionQuality(state, correlated.quality)
}

function projectTargetSignal(
    state: ProjectionState,
    signal: InteractionSignalWindowSummary,
    capabilityName: AnimationRumV2CapabilityName,
    family: AnimationRumFamily,
    ids: { count: string; sum: string; p95: string; max?: string }
): void {
    const status = targetSignalStatus(signal)
    if (status === 'unsupported') state.capabilities[capabilityName] = 'unsupported'
    else if (status === 'unknown') state.capabilities[capabilityName] = 'unknown'
    else if (status === 'not-instrumented') state.capabilities[capabilityName] = 'disabled'
    else state.capabilities[capabilityName] = 'supported'
    let count = safeCount(signal.overlapCount)
    let duration = safeNumber(signal.overlapDurationMs)
    const durationCount = safeCount(signal.duration?.count)
    const unavailable = status === 'unsupported' || status === 'unknown' || status === 'not-instrumented'
    const validUnavailable = unavailable && signal.overlapCount === null && signal.overlapDurationMs === null && signal.duration === null
    const validZero = status === 'not-observed' && count === 0 && duration === 0 && signal.duration === null
    const validObserved =
        (status === 'measured' || status === 'partial') &&
        count !== null &&
        duration !== null &&
        ((count === 0 && duration === 0 && signal.duration === null) || (count > 0 && durationCount === count && signal.duration !== null))
    if (!(validUnavailable || validZero || validObserved)) {
        state.reasons.add('source-field-incomplete')
        count = null
        duration = null
        for (const id of [ids.count, ids.sum, ids.p95, ids.max].filter((value): value is string => Boolean(value))) {
            putMetric(state, id, null, null, 'unknown')
        }
        return
    }
    if (!unavailable) registerProviderWindow(state, 'browser-core', family, count, count, count, 0, status === 'partial')
    const aggregateStatus: AnimationRumV2MetricStatus = status === 'not-observed' ? 'measured' : status
    putMetric(state, ids.count, count, count, count === null ? status : aggregateStatus)
    putMetric(state, ids.sum, duration, count, duration === null ? status : aggregateStatus)
    putDistribution(state, ids.p95, signal.duration, 'p95', status)
    if (ids.max) putDistribution(state, ids.max, signal.duration, 'max', status)
}

function bucketUpperBound(value: unknown, buckets: readonly number[]): number | null {
    const numeric = safeNumber(value, buckets[buckets.length - 1])
    if (numeric === null || ((buckets[0] ?? 0) > 0 && numeric <= 0)) return null
    return buckets.find(bucket => numeric <= bucket) ?? null
}

function projectTargetDirect(state: ProjectionState, target: AnimationElementSelectionSnapshot): void {
    const direct = target.direct
    const directCapability = capabilityState(direct.capability)
    const geometryCapability = capabilityState(target.geometry.capability)
    state.capabilities['target-direct-inspection'] =
        directCapability === 'supported' || geometryCapability === 'supported'
            ? 'supported'
            : directCapability === 'unsupported' && geometryCapability === 'unsupported'
              ? 'unsupported'
              : 'unknown'
    state.capabilities['document-animations-inspection'] = directCapability
    const total = safeCount(direct.totalCount)
    const inspected = safeCount(direct.inspectedCount)
    const dropped = safeCount(direct.droppedAnimationCount)
    const running = safeCount(direct.runningCount)
    const infinite = safeCount(direct.infiniteCount)
    const directValid =
        direct.capability.state === 'supported' &&
        total !== null &&
        inspected !== null &&
        dropped !== null &&
        running !== null &&
        infinite !== null &&
        inspected + dropped === total &&
        running <= inspected &&
        infinite <= inspected
    if (directValid) {
        registerProviderWindow(state, 'target-sidecar', 'motionQuality', total, inspected)
    } else if (direct.capability.state === 'supported') state.reasons.add('source-field-incomplete')
    const directStatus: AnimationRumV2MetricStatus =
        direct.capability.state === 'supported' ? (directValid ? 'measured' : 'unknown') : unavailableStatus(direct.capability)
    putMetric(state, 'animation.running.count', directValid ? running : null, directValid ? inspected : null, directStatus)
    putMetric(state, 'animation.infinite.count', directValid ? infinite : null, directValid ? inspected : null, directStatus)

    if (target.geometry.capability.state === 'supported') registerProviderWindow(state, 'target-sidecar', 'renderer', 1, 1)
    const backingBucket = bucketUpperBound(
        target.geometry.backingPixelArea,
        [0, 262_144, 1_048_576, 2_073_600, 4_194_304, 8_294_400, 16_777_216, 33_554_432]
    )
    const ratioBucket = bucketUpperBound(target.geometry.effectivePixelRatio, [1, 1.5, 2, 3, 4, 8])
    const geometryStatus = unavailableStatus(target.geometry.capability)
    putMetric(
        state,
        'target.backing-store-pixels-bucket.latest',
        backingBucket,
        backingBucket === null ? null : 1,
        backingBucket === null ? geometryStatus : 'measured'
    )
    putMetric(
        state,
        'target.effective-pixel-ratio-bucket.latest',
        ratioBucket,
        ratioBucket === null ? null : 1,
        ratioBucket === null ? geometryStatus : 'measured'
    )
}

function targetRendererWindowValid(
    renderer: AnimationElementSelectionSnapshot['renderers'][number],
    projectionWindow: TargetProjectionWindow | null
): boolean {
    if (!projectionWindow) return false
    const startedAt = safeNumber(renderer.evidence.window.startedAt)
    const endedAt = safeNumber(renderer.evidence.window.endedAt)
    const durationMs = safeNumber(renderer.evidence.window.durationMs)
    return (
        startedAt !== null &&
        endedAt !== null &&
        durationMs !== null &&
        startedAt >= projectionWindow.startedAt &&
        endedAt <= projectionWindow.endedAt &&
        endedAt >= startedAt &&
        Math.abs(durationMs - round(endedAt - startedAt)) <= 0.001
    )
}

function projectTargetRenderer(
    state: ProjectionState,
    target: AnimationElementSelectionSnapshot,
    projectionWindow: TargetProjectionWindow | null
): void {
    const supported = target.renderers.filter(item => item.capability.state === 'supported')
    const usable = target.renderers.filter(item => item.capability.state === 'supported' && item.capability.observed)
    if (supported.length === 0) {
        const capability: AnimationRumV2CapabilityState = target.renderers.some(item => item.capability.state === 'unknown')
            ? 'unknown'
            : target.renderers.some(item => item.capability.state === 'unsupported')
              ? 'unsupported'
              : 'disabled'
        state.capabilities['renderer-adapter'] = capability
        state.capabilities['gpu-timer-query'] = capability
        const status: AnimationRumV2MetricStatus =
            capability === 'unsupported' ? 'unsupported' : capability === 'unknown' ? 'unknown' : 'not-instrumented'
        for (const id of ['renderer.gpu-frame.p95', 'renderer.draw-calls.p95', 'renderer.triangles.p95']) {
            putMetric(state, id, null, null, status)
        }
        return
    }
    state.capabilities['renderer-adapter'] = 'supported'
    if (usable.length === 0) {
        state.capabilities['gpu-timer-query'] = 'unknown'
        for (const id of ['renderer.gpu-frame.p95', 'renderer.draw-calls.p95', 'renderer.triangles.p95']) {
            putMetric(state, id, null, null, 'not-observed')
        }
        return
    }
    if (usable.length > 1) {
        state.reasons.add('source-field-incomplete')
        for (const id of ['renderer.gpu-frame.p95', 'renderer.draw-calls.p95', 'renderer.triangles.p95']) {
            putMetric(state, id, null, null, 'unknown')
        }
        state.capabilities['gpu-timer-query'] = 'unknown'
        return
    }
    const renderer = usable[0]!
    if (!targetRendererWindowValid(renderer, projectionWindow)) {
        state.reasons.add('source-field-incomplete')
        state.capabilities['gpu-timer-query'] = 'unknown'
        for (const id of ['renderer.gpu-frame.p95', 'renderer.draw-calls.p95', 'renderer.triangles.p95']) {
            putMetric(state, id, null, null, 'unknown')
        }
        return
    }
    const accepted = safeCount(renderer.evidence.acceptedSampleCount)
    const retained = safeCount(renderer.evidence.retainedSampleCount)
    const dropped = safeCount(renderer.evidence.droppedSampleCount)
    const rejected = safeCount(renderer.evidence.rejectedSampleCount ?? 0)
    const countsValid =
        accepted !== null &&
        retained !== null &&
        dropped !== null &&
        rejected !== null &&
        retained + dropped === accepted &&
        typeof renderer.evidence.truncated === 'boolean' &&
        renderer.evidence.truncated === dropped > 0
    if (countsValid) {
        registerProviderExact(state, 'renderer-adapter', 'renderer', accepted, retained, retained, rejected)
    } else state.reasons.add('source-field-incomplete')
    const samples = countsValid ? retained : null
    const status: AnimationRumV2MetricStatus = !countsValid ? 'unknown' : dropped > 0 || rejected > 0 ? 'partial' : 'measured'
    const gpu = safeNumber(renderer.metrics.gpuFrameMsP95)
    const gpuSourceCompatible = isTargetGpuTimingSourceCompatible(renderer.family, renderer.evidence.gpu.source)
    if (renderer.evidence.gpu.source !== 'unknown' && !gpuSourceCompatible) state.reasons.add('source-field-incomplete')
    const gpuValid =
        countsValid &&
        retained > 0 &&
        renderer.evidence.gpu.valid === true &&
        renderer.evidence.gpu.disjoint === false &&
        renderer.evidence.gpu.contextLost === false &&
        renderer.evidence.gpu.source !== 'unknown' &&
        gpuSourceCompatible &&
        renderer.evidence.gpu.rejectionReason === null &&
        gpu !== null
    const gpuCapability: AnimationRumV2CapabilityState = gpuValid
        ? 'supported'
        : renderer.evidence.gpu.rejectionReason === 'not-reported'
          ? 'disabled'
          : 'unknown'
    state.capabilities['gpu-timer-query'] = gpuCapability
    putMetric(
        state,
        'renderer.gpu-frame.p95',
        gpuValid ? gpu : null,
        gpuValid ? samples : null,
        gpuValid ? status : gpuCapability === 'disabled' ? 'not-instrumented' : 'unknown'
    )
    const drawCalls = safeNumber(renderer.metrics.drawCallsP95)
    const triangles = safeNumber(renderer.metrics.trianglesP95)
    const drawCallsValid = drawCalls === null || (countsValid && retained > 0)
    const trianglesValid = triangles === null || (countsValid && retained > 0)
    if (!drawCallsValid || !trianglesValid) state.reasons.add('source-field-incomplete')
    putMetric(
        state,
        'renderer.draw-calls.p95',
        drawCallsValid ? drawCalls : null,
        drawCallsValid && drawCalls !== null ? samples : null,
        !drawCallsValid ? 'unknown' : drawCalls === null ? 'not-observed' : status
    )
    putMetric(
        state,
        'renderer.triangles.p95',
        trianglesValid ? triangles : null,
        trianglesValid && triangles !== null ? samples : null,
        !trianglesValid ? 'unknown' : triangles === null ? 'not-observed' : status
    )
}

function addQualityFromSnapshot(state: ProjectionState, snapshot: AnimationSnapshot, frameCount: number, elapsedMs: number): void {
    if (state.scope === 'page') {
        const reasons = snapshot.captureSufficiency.reasons
        if (reasons.includes('visible-window-too-short')) state.reasons.add('visible-window-too-short')
        if (reasons.includes('insufficient-frame-samples')) state.reasons.add('insufficient-frame-samples')
        if (reasons.includes('refresh-confidence-low')) state.reasons.add('refresh-confidence-low')
        return
    }
    // A target capture has its own overlap window. Parent-page sufficiency is
    // context only and must not be copied into the target verdict.
    if (elapsedMs < snapshot.captureSufficiency.minimumVisibleDurationMs) state.reasons.add('visible-window-too-short')
    if (frameCount < snapshot.captureSufficiency.minimumFrameSamples) state.reasons.add('insufficient-frame-samples')
    if (snapshot.frameBudget.confidence === 'low') state.reasons.add('refresh-confidence-low')
}

function capabilityUnavailableStatus(states: readonly AnimationRumV2CapabilityState[]): AnimationRumV2MetricStatus | null {
    if (states.includes('unsupported')) return 'unsupported'
    if (states.includes('disabled')) return 'not-instrumented'
    if (states.includes('unknown')) return 'unknown'
    return null
}

function maximumForDefinition(definition: MetricDefinition): number {
    if (definition.allowedValues) return definition.allowedValues[definition.allowedValues.length - 1] ?? 0
    if (definition.unit === 'ratio') return 1
    if (definition.unit === 'multiplier') return 16
    if (definition.unit === 'percent' || definition.unit === 'score') return 100
    if (definition.unit === 'hz') return 1_000
    if (definition.unit === 'ms') return ANIMATION_RUM_MAX_WINDOW_DURATION_MS
    if (definition.unit === 'count' || definition.unit === 'frames') return MAX_COUNT
    if (definition.unit === 'pixels') return 1_000_000_000_000
    return MAX_VALUE
}

function bindingFor(definition: MetricDefinition, scope: Scope) {
    return definition.bindings.find(binding => binding.scope === scope)
}

function hasProviderLoss(state: ProjectionState, owner: AnimationRumV2ProviderOwner, family: AnimationRumFamily): boolean {
    const provider = state.providers.get(providerKey(owner, family))
    return Boolean(provider && (provider.hadLoss || provider.rejected > 0))
}

function addProviderQualityReasons(state: ProjectionState): void {
    if ([...state.providers.values()].some(value => value.hadLoss)) state.reasons.add('provider-truncated')
    if ([...state.providers.values()].some(value => value.rejected > 0)) state.reasons.add('provider-rejected-samples')
    for (const [metricId, candidate] of state.candidates) {
        if (candidate.status !== 'partial') continue
        const definition = ANIMATION_RUM_V2_METRIC_CATALOG.find(item => item.metricId === metricId)
        const binding = definition && bindingFor(definition, state.scope)
        if (definition && binding && !hasProviderLoss(state, binding.owners[0]!, definition.family as AnimationRumFamily)) {
            state.reasons.add('source-field-incomplete')
            break
        }
    }
}

function finalizeMetrics(state: ProjectionState): AnimationRumV2Metric[] {
    const metrics: AnimationRumV2Metric[] = []
    for (const definition of ANIMATION_RUM_V2_METRIC_CATALOG) {
        const binding = bindingFor(definition, state.scope)
        if (!binding) continue
        const owner = binding.owners[0] as AnimationRumV2ProviderOwner
        const requiredStates = definition.requiredCapabilities.map(name => state.capabilities[name])
        const unavailableByCapability = capabilityUnavailableStatus(requiredStates)
        const candidate = state.candidates.get(definition.metricId)
        let status: AnimationRumV2MetricStatus = candidate?.status ?? (binding.relation === 'adapter' ? 'not-instrumented' : 'not-observed')
        let value = candidate?.value ?? null
        let samples = candidate?.samples ?? null
        if (unavailableByCapability) {
            status = unavailableByCapability
            value = null
            samples = null
        }
        const available = status === 'measured' || status === 'partial'
        const safeValue = safeNumber(value, maximumForDefinition(definition))
        const safeSamples = safeCount(samples)
        const countIsIntegral = definition.stat !== 'count' || (safeValue !== null && Number.isInteger(safeValue))
        const bucketIsAllowed = !definition.allowedValues || (safeValue !== null && definition.allowedValues.includes(safeValue))
        const zeroPopulationAllowed = definition.stat === 'count' || definition.stat === 'sum'
        const validAvailable =
            available &&
            safeValue !== null &&
            safeSamples !== null &&
            countIsIntegral &&
            bucketIsAllowed &&
            (safeSamples > 0 || (zeroPopulationAllowed && safeValue === 0))
        const provider = state.providers.get(providerKey(owner, definition.family as AnimationRumFamily))
        if (!validAvailable || !provider || provider.evidence === 0) {
            if (available) status = unavailableByCapability ?? (binding.relation === 'adapter' ? 'not-instrumented' : 'not-observed')
            value = null
            samples = null
        } else {
            value = safeValue
            samples = safeSamples
            const qualityRequiresPartial = definition.partialWhenQualityReasons.some(reason => state.reasons.has(reason))
            if (status === 'partial' || hasProviderLoss(state, owner, definition.family as AnimationRumFamily) || qualityRequiresPartial) {
                status = 'partial'
            } else status = 'measured'
        }
        metrics.push({
            metricId: definition.metricId,
            relation: binding.relation,
            owner,
            value,
            samples,
            status,
        })
    }

    const byIdentity = new Map(metrics.map(metric => [metric.metricId, metric]))
    for (const metric of metrics) {
        const definition = ANIMATION_RUM_V2_METRIC_CATALOG.find(item => item.metricId === metric.metricId)
        if (!definition?.populationMetricId || (metric.status !== 'measured' && metric.status !== 'partial')) continue
        const population = byIdentity.get(definition.populationMetricId)
        if (!population || (population.status !== 'measured' && population.status !== 'partial') || population.value === 0) {
            metric.value = null
            metric.samples = null
            metric.status =
                population?.status === 'unsupported' ? 'unsupported' : population?.status === 'unknown' ? 'unknown' : 'not-observed'
        }
    }
    return metrics
}

function coverageFromMetrics(metrics: readonly AnimationRumV2Metric[]): AnimationRumV2Report['coverage'] {
    return Object.fromEntries(
        ANIMATION_RUM_FAMILIES.map(family => {
            const familyMetrics = metrics.filter(metric => {
                const definition = ANIMATION_RUM_V2_METRIC_CATALOG.find(item => item.metricId === metric.metricId)
                return definition?.family === family
            })
            const statuses = familyMetrics.map(metric => metric.status)
            const available = statuses.filter(status => status === 'measured' || status === 'partial')
            let status: AnimationRumV2MetricStatus
            if (available.includes('partial') || (available.length > 0 && available.length < statuses.length)) status = 'partial'
            else if (available.length > 0) status = 'measured'
            else if (statuses.length === 0 || statuses.every(value => value === 'not-instrumented')) status = 'not-instrumented'
            else if (statuses.includes('not-observed')) status = 'not-observed'
            else if (statuses.every(value => value === 'unsupported')) status = 'unsupported'
            else if (statuses.includes('unknown')) status = 'unknown'
            else status = 'not-instrumented'
            return [
                family,
                {
                    status,
                    evidenceLevel:
                        status === 'unsupported' || status === 'unknown' || status === 'not-instrumented'
                            ? 'unsupported-or-unknown'
                            : 'runtime-observation',
                },
            ]
        })
    ) as AnimationRumV2Report['coverage']
}

function frameworkFromValues(values: readonly string[]): AnimationRumV2RuntimeFramework {
    const safe = [
        ...new Set(values.filter(value => RUNTIME_FRAMEWORKS.has(value as AnimationRumV2RuntimeFramework))),
    ] as AnimationRumV2RuntimeFramework[]
    const withoutVanilla = safe.filter(value => value !== 'vanilla')
    const candidates = withoutVanilla.length > 0 ? withoutVanilla : safe
    if (candidates.length === 0) return 'unknown'
    return candidates.length === 1 ? candidates[0]! : 'mixed'
}

function rendererFromValues(values: readonly string[]): AnimationRumV2RuntimeRenderer {
    const normalized = new Set<AnimationRumV2RuntimeRenderer>()
    for (const value of values) {
        if (value === 'dom' || value === 'svg') normalized.add(value)
        else if (value === 'canvas' || value === 'canvas2d' || value === 'webgl' || value === 'webgl2' || value === 'webgpu') {
            normalized.add('canvas')
        } else if (value === 'other') normalized.add('other')
    }
    return normalized.size === 0 ? 'unknown' : normalized.size === 1 ? [...normalized][0]! : 'mixed'
}

function backendFromValues(values: readonly string[]): AnimationRumV2RuntimeBackend {
    const normalized = new Set<AnimationRumV2RuntimeBackend>()
    for (const value of values) {
        if (value === 'dom' || value === 'canvas2d' || value === 'webgl' || value === 'webgl2' || value === 'webgpu' || value === 'other') {
            normalized.add(value)
        }
    }
    return normalized.size === 0 ? 'unknown' : normalized.size === 1 ? [...normalized][0]! : 'mixed'
}

function resolvedRuntime(
    requested: AnimationRumV2RuntimeContext | undefined,
    inferred: AnimationRumV2Report['context']['runtime']
): AnimationRumV2Report['context']['runtime'] {
    const framework = requested?.framework ?? inferred.framework
    const renderer = requested?.renderer ?? inferred.renderer
    const backend = requested?.backend ?? inferred.backend
    if (!RUNTIME_FRAMEWORKS.has(framework) || !RUNTIME_RENDERERS.has(renderer) || !RUNTIME_BACKENDS.has(backend)) {
        throw new AnimationOptionsError('runtime context contains an unsupported closed value')
    }
    return { framework, renderer, backend }
}

function inferPageRuntime(snapshot: AnimationSnapshot, pageEvidence: AnimationRumV2PageEvidenceSource | undefined) {
    const frameworks = snapshot.hostEvidence.framework.frameworks
    const backends: string[] = [...snapshot.hostEvidence.renderer.backends]
    const surfaces = pageEvidence?.rendererSurfaces.current
    const rendererValues: string[] = []
    if (surfaces) {
        if (surfaces.svg > 0) rendererValues.push('svg')
        if (surfaces.canvasUnknown + surfaces.canvas2d + surfaces.webgl + surfaces.webgl2 + surfaces.webgpu > 0)
            rendererValues.push('canvas')
        if (surfaces.canvas2d > 0) backends.push('canvas2d')
        if (surfaces.webgl > 0) backends.push('webgl')
        if (surfaces.webgl2 > 0) backends.push('webgl2')
        if (surfaces.webgpu > 0) backends.push('webgpu')
    }
    if (rendererValues.length === 0 && frameworks.length > 0) rendererValues.push('dom')
    return {
        framework: frameworkFromValues(frameworks),
        renderer: rendererFromValues(rendererValues),
        backend: backendFromValues(backends),
    }
}

function inferTargetRuntime(target: AnimationElementSelectionSnapshot) {
    return {
        framework: frameworkFromValues(target.inventory.uiFrameworks),
        renderer: rendererFromValues(target.inventory.renderers),
        backend: backendFromValues([...target.inventory.renderers, ...target.renderers.map(item => item.family)]),
    }
}

function buildContext(
    snapshot: AnimationSnapshot,
    elapsedMs: number,
    options: AnimationRumV2ProjectionOptions,
    inferredRuntime: AnimationRumV2Report['context']['runtime']
): AnimationRumV2Report['context'] {
    const capped = elapsedMs > ANIMATION_RUM_MAX_WINDOW_DURATION_MS
    const routeKey = options.routeKey
    if (routeKey !== undefined && !isAnimationRumV2RouteKey(routeKey)) {
        throw new AnimationOptionsError('routeKey must be a static, already-redacted v2 route identity')
    }
    if (options.viewportBucket !== undefined && !VIEWPORT_BUCKETS.has(options.viewportBucket)) {
        throw new AnimationOptionsError('viewportBucket is unsupported')
    }
    if (options.dprBucket !== undefined && !DPR_BUCKETS.has(options.dprBucket)) throw new AnimationOptionsError('dprBucket is unsupported')
    const visibility = snapshot.visibility.current
    const safeRefresh = safeNumber(snapshot.frameBudget.expectedRefreshHz, 1_000)
    const refresh = safeRefresh !== null && safeRefresh >= 1 ? safeRefresh : null
    return {
        ...(routeKey ? { routeKey } : {}),
        visibilityState: visibility === 'visible' || visibility === 'hidden' || visibility === 'prerender' ? visibility : 'unknown',
        reducedMotion:
            snapshot.visibility.reducedMotion === true || snapshot.visibility.reducedMotion === false
                ? snapshot.visibility.reducedMotion
                : null,
        ...(options.viewportBucket ? { viewportBucket: options.viewportBucket } : {}),
        ...(options.dprBucket ? { dprBucket: options.dprBucket } : {}),
        refreshHz: refresh,
        refreshBudgetSource:
            snapshot.frameBudget.source === 'explicit' || snapshot.frameBudget.source === 'inferred'
                ? snapshot.frameBudget.source
                : 'unknown',
        refreshBudgetConfidence:
            snapshot.frameBudget.source === 'explicit'
                ? 'explicit'
                : snapshot.frameBudget.confidence === 'high' ||
                    snapshot.frameBudget.confidence === 'medium' ||
                    snapshot.frameBudget.confidence === 'low'
                  ? snapshot.frameBudget.confidence
                  : 'unknown',
        windowDurationMs: capped ? ANIMATION_RUM_MAX_WINDOW_DURATION_MS : round(elapsedMs, 6),
        windowDurationCapped: capped,
        runtime: resolvedRuntime(options.runtime, inferredRuntime),
    }
}

function validateProjectionOptions(options: AnimationRumV2ProjectionOptions): void {
    safeId('eventId', options.eventId)
    if (!Number.isFinite(options.capturedAtEpochMs) || options.capturedAtEpochMs < 0 || options.capturedAtEpochMs > 8_640_000_000_000_000) {
        throw new AnimationOptionsError('capturedAtEpochMs must be a valid non-negative epoch time')
    }
    if (!Number.isFinite(options.sampleRate) || options.sampleRate <= 0 || options.sampleRate > 1) {
        throw new AnimationOptionsError('sampleRate must be greater than 0 and no more than 1')
    }
    if (!Number.isInteger(options.samplingPolicyVersion) || options.samplingPolicyVersion < 1 || options.samplingPolicyVersion > 255) {
        throw new AnimationOptionsError('samplingPolicyVersion must be an integer between 1 and 255')
    }
}

function completeReport(
    state: ProjectionState,
    snapshot: AnimationSnapshot,
    options: AnimationRumV2ProjectionOptions,
    identity: Pick<AnimationRumV2Report, 'captureId' | 'scope' | 'parentCaptureId' | 'targetKey'>,
    elapsedMs: number,
    runtime: AnimationRumV2Report['context']['runtime']
): AnimationRumV2Report {
    validateProjectionOptions(options)
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new AnimationOptionsError('capture duration must be finite and non-negative')
    const context = buildContext(snapshot, elapsedMs, options, runtime)
    if (context.windowDurationCapped) state.reasons.add('window-capped')
    if (state.adapterErrorCount > 0) state.reasons.add('adapter-error')
    addProviderQualityReasons(state)
    const providerEvidence = providerTable(state)
    const metrics = finalizeMetrics(state)
    const reasons = [...state.reasons].sort() as AnimationRumV2QualityReason[]
    const report: AnimationRumV2Report = {
        contractVersion: 2,
        snapshotSchemaVersion: 1,
        eventId: safeId('eventId', options.eventId),
        captureId: safeId('captureId', identity.captureId),
        scope: identity.scope,
        parentCaptureId: identity.parentCaptureId,
        targetKey: identity.targetKey,
        capturedAt: new Date(options.capturedAtEpochMs).toISOString(),
        release: safeVersion('release', options.release, ''),
        dist: safeVersion('dist', options.dist, ''),
        environment: safeVersion('environment', options.environment, ''),
        sdkVersion: safeVersion('sdkVersion', options.sdkVersion, ANIMATION_MONITOR_VERSION),
        monitorVersion: ANIMATION_MONITOR_VERSION,
        sampleRate: options.sampleRate,
        samplingPolicyVersion: options.samplingPolicyVersion,
        context,
        capabilities: state.capabilities,
        coverage: coverageFromMetrics(metrics),
        captureQuality: {
            sufficiency: reasons.some(
                reason =>
                    reason === 'visible-window-too-short' || reason === 'insufficient-frame-samples' || reason === 'refresh-confidence-low'
            )
                ? 'insufficient'
                : 'sufficient',
            integrity: reasons.some(
                reason =>
                    reason === 'adapter-error' ||
                    reason === 'provider-rejected-samples' ||
                    reason === 'provider-truncated' ||
                    reason === 'source-field-incomplete' ||
                    reason === 'window-capped'
            )
                ? 'partial'
                : 'complete',
            reasons,
            adapterErrorCount: state.adapterErrorCount,
        },
        providerEvidence,
        metrics,
    }
    const validation = validateNormalizedAnimationRumV2(report, { nowEpochMs: options.capturedAtEpochMs })
    if (!validation.ok) throw new AnimationOptionsError(`Animation RUM v2 projection failed validation: ${validation.errors.join(', ')}`)
    const normalized = validation.value as AnimationRumV2Report
    const bytes = new TextEncoder().encode(JSON.stringify(normalized)).byteLength
    if (bytes > ANIMATION_RUM_V2_MAX_PAYLOAD_BYTES) {
        throw new AnimationOptionsError(`Animation RUM v2 projection exceeds ${ANIMATION_RUM_V2_MAX_PAYLOAD_BYTES} bytes`)
    }
    return normalized
}

/** Pure, closed page projection. It never mutates or serializes the local snapshot. */
export function toAnimationRumV2PageReport(
    snapshot: AnimationRumV2PageSnapshot,
    options: AnimationRumV2ProjectionOptions
): AnimationRumV2Report {
    if (!snapshot || typeof snapshot !== 'object' || snapshot.schemaVersion !== 1) {
        throw new AnimationOptionsError('snapshot.schemaVersion must be 1')
    }
    const state = createState('page')
    const pageEvidence = options.pageEvidence ?? snapshot.pageEvidence
    projectFrames(state, snapshot)
    projectLongAnimationFrames(state, snapshot)
    state.capabilities.longtask = capabilityState(snapshot.longTasks.capability)
    projectBoundedSignal(state, snapshot.longTasks, 'browser-core', 'mainThread', {
        count: 'main.long-task.count',
        sum: 'main.long-task-duration.sum',
        p95: 'main.long-task-duration.p95',
        max: 'main.long-task-duration.max',
    })
    projectEventTiming(state, snapshot)
    projectInteractions(state, snapshot)
    projectMonitorOverhead(state, snapshot)
    projectInputScheduling(state, snapshot.inputFrameScheduling)
    projectLoafSupplemental(
        state,
        options.loafDiagnostics?.loafFirstUiEventToFrameEnd,
        'userOutcome',
        'outcome.loaf-first-ui-to-end.count',
        'outcome.loaf-first-ui-to-end.p95'
    )
    projectLoafSupplemental(
        state,
        options.loafDiagnostics?.loafAttributedForcedStyleLayout,
        'renderingPipeline',
        'pipeline.loaf-forced-style-layout.count',
        'pipeline.loaf-forced-style-layout.p95'
    )
    projectWebVitals(state, snapshot)
    projectResources(state, snapshot)
    projectPageEvidence(state, pageEvidence)
    projectHostEvidence(state, snapshot)
    projectInteractionQuality(state, options.interactionQuality)
    state.capabilities['visibility-lifecycle'] = snapshot.visibility.current === 'unknown' ? 'unknown' : 'supported'
    if (state.capabilities['reduced-motion-preference'] === 'unknown') {
        state.capabilities['reduced-motion-preference'] = typeof snapshot.visibility.reducedMotion === 'boolean' ? 'supported' : 'unknown'
    }
    addQualityFromSnapshot(state, snapshot, snapshot.frames.retainedCount, snapshot.elapsedMs)
    return completeReport(
        state,
        snapshot,
        options,
        { captureId: snapshot.captureId, scope: 'page', parentCaptureId: null, targetKey: null },
        snapshot.elapsedMs,
        inferPageRuntime(snapshot, pageEvidence)
    )
}

/**
 * Pure target projection. Browser-window metrics come only from the explicit
 * target interaction overlap; the parent page snapshot is context, never
 * target causation evidence.
 */
export function toAnimationRumV2TargetReport(
    pageSnapshot: AnimationSnapshot,
    targetSnapshot: AnimationRumV2TargetSnapshot,
    options: AnimationRumV2TargetProjectionOptions
): AnimationRumV2Report {
    if (!pageSnapshot || typeof pageSnapshot !== 'object' || pageSnapshot.schemaVersion !== 1) {
        throw new AnimationOptionsError('pageSnapshot.schemaVersion must be 1')
    }
    if (!targetSnapshot || typeof targetSnapshot !== 'object' || targetSnapshot.schemaVersion !== 1) {
        throw new AnimationOptionsError('targetSnapshot.schemaVersion must be 1')
    }
    if (!isAnimationRumV2TargetKey(options.targetKey)) {
        throw new AnimationOptionsError('targetKey must be a static registered semantic identity, never a selector or DOM-derived value')
    }
    const captureId = safeId('captureId', options.captureId)
    const parentCaptureId = safeId('parentCaptureId', pageSnapshot.captureId)
    if (captureId === parentCaptureId) throw new AnimationOptionsError('target captureId must differ from the parent page captureId')
    const state = createState('target')
    const selectedAt = safeNumber(targetSnapshot.selectedAt)
    const capturedAt = safeNumber(targetSnapshot.capturedAt)
    const elapsedMs = safeNumber(targetSnapshot.elapsedMs)
    const selectionWindowValid =
        selectedAt !== null &&
        capturedAt !== null &&
        elapsedMs !== null &&
        capturedAt >= selectedAt &&
        Math.abs(elapsedMs - round(capturedAt - selectedAt)) <= 0.001
    const selectionWindow: TargetProjectionWindow | null = selectionWindowValid
        ? { startedAt: selectedAt, endedAt: capturedAt, durationMs: elapsedMs }
        : null
    const correlatedDurationMs = safeNumber(targetSnapshot.correlatedDurationMs)
    const rawCorrelatedWindow = targetSnapshot.correlatedWindow
    const correlatedStartedAt = safeNumber(rawCorrelatedWindow?.startedAt)
    const correlatedEndedAt = safeNumber(rawCorrelatedWindow?.endedAt)
    const correlatedWindowDurationMs = safeNumber(rawCorrelatedWindow?.durationMs)
    const correlatedWindowValid =
        selectionWindow !== null &&
        correlatedStartedAt !== null &&
        correlatedEndedAt !== null &&
        correlatedWindowDurationMs !== null &&
        correlatedDurationMs !== null &&
        correlatedStartedAt >= selectionWindow.startedAt &&
        correlatedEndedAt <= selectionWindow.endedAt &&
        correlatedEndedAt >= correlatedStartedAt &&
        Math.abs(correlatedWindowDurationMs - round(correlatedEndedAt - correlatedStartedAt)) <= 0.001 &&
        Math.abs(correlatedDurationMs - correlatedWindowDurationMs) <= 0.001
    const correlationValid = targetSnapshot.correlated
        ? targetSnapshot.correlationRelation === 'temporal-overlap' && correlatedWindowValid
        : targetSnapshot.correlationRelation === null &&
          (targetSnapshot.correlatedDurationMs === null || targetSnapshot.correlatedDurationMs === undefined) &&
          (targetSnapshot.correlatedWindow === null || targetSnapshot.correlatedWindow === undefined)
    if (!selectionWindowValid || !correlationValid) state.reasons.add('source-field-incomplete')
    const correlated = correlationValid ? targetSnapshot.correlated : null
    const projectionWindow: TargetProjectionWindow | null = targetSnapshot.correlated
        ? correlationValid && correlatedStartedAt !== null && correlatedEndedAt !== null && correlatedWindowDurationMs !== null
            ? { startedAt: correlatedStartedAt, endedAt: correlatedEndedAt, durationMs: correlatedWindowDurationMs }
            : null
        : selectionWindow
    const targetWindowDurationMs = correlated && correlatedDurationMs !== null ? correlatedDurationMs : targetSnapshot.elapsedMs
    state.capabilities['long-animation-frame'] = capabilityState(pageSnapshot.longAnimationFrames.capability)
    state.capabilities.longtask = capabilityState(pageSnapshot.longTasks.capability)
    state.capabilities['event-timing'] = capabilityState(pageSnapshot.eventTiming.capability)
    state.capabilities['loaf-paint-time'] = capabilityState(pageSnapshot.longAnimationFrames.paintTiming?.paintTimeCapability)
    state.capabilities['loaf-presentation-time'] = capabilityState(pageSnapshot.longAnimationFrames.paintTiming?.presentationTimeCapability)
    projectTargetTemporalEvidence(state, correlated)
    projectTargetDirect(state, targetSnapshot)
    projectTargetRenderer(state, targetSnapshot, projectionWindow)
    if (!correlated) projectInteractionQuality(state, undefined)
    state.capabilities['resource-timing'] = 'disabled'
    state.capabilities['resource-timing-buffer-events'] = 'disabled'
    state.capabilities['web-vitals'] = 'disabled'
    state.capabilities['web-vitals-attribution'] = 'disabled'
    state.capabilities['web-vitals-soft-navigation'] = 'disabled'
    state.capabilities['page-evidence'] = 'disabled'
    state.capabilities['canvas-context-registry'] = targetSnapshot.inventory.renderers.some(
        value => value === 'canvas2d' || value === 'webgl' || value === 'webgl2' || value === 'webgpu'
    )
        ? 'supported'
        : 'unknown'
    state.capabilities['video-frame-callback'] = 'disabled'
    state.capabilities['video-playback-quality'] = 'disabled'
    state.capabilities['media-adapter'] = 'disabled'
    state.capabilities['framework-adapter'] = targetSnapshot.owners.some(owner => owner.relation === 'framework-owner')
        ? 'supported'
        : 'disabled'
    state.capabilities['visibility-lifecycle'] = pageSnapshot.visibility.current === 'unknown' ? 'unknown' : 'supported'
    state.capabilities['reduced-motion-preference'] = typeof pageSnapshot.visibility.reducedMotion === 'boolean' ? 'supported' : 'unknown'
    state.adapterErrorCount = Math.min(MAX_COUNT, targetSnapshot.adapterErrors.length)
    addQualityFromSnapshot(state, pageSnapshot, correlated?.frames.retainedCount ?? 0, targetWindowDurationMs)
    return completeReport(
        state,
        pageSnapshot,
        options,
        { captureId, scope: 'target', parentCaptureId, targetKey: options.targetKey },
        targetWindowDurationMs,
        inferTargetRuntime(targetSnapshot)
    )
}
