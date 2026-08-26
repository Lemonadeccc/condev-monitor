import { createAnimationElementSelection } from './element-selection'
import type {
    AnimationFrameworkStatsSample,
    AnimationLifecycleStatsSample,
    AnimationMediaStatsSample,
    AnimationRenderStatsSample,
    AnimationWorkStatsSample,
} from './host-adapters'
import { AnimationHostEvidenceRecorder } from './host-evidence'
import { createBrowserAnimationRuntime } from './runtime'
import { BoundedRing, durationStatistics, inferFrameBudget, missedFrameOpportunities, round } from './statistics'
import type {
    ActiveInteractionMeasurement,
    AnimationCollectorOptions,
    AnimationElementSelectionHandle,
    AnimationElementSelectionOptions,
    AnimationHostEvidenceSummary,
    AnimationInteractionHandle,
    AnimationInteractionKind,
    AnimationResourceCategory,
    AnimationResourceTimingSummary,
    AnimationRumCapabilities,
    AnimationRumCoverage,
    AnimationRuntime,
    AnimationSnapshot,
    AnimationWebVitalMeasurement,
    AnimationWebVitalsSummary,
    BoundedSignalSummary,
    BurstSummary,
    CapabilityEvidence,
    CaptureSufficiencySummary,
    CollectorState,
    EventTimingSummary,
    FrameBudget,
    FrameSummary,
    InteractionFrameWindowSummary,
    InteractionMeasurement,
    InteractionOutcome,
    InteractionPerformanceSummary,
    InteractionQualitySample,
    InteractionQualitySummary,
    InteractionSignalWindowSummary,
    InteractionSummary,
    LongAnimationFrameSummary,
    MonitorOverheadSummary,
    PerformanceObserverHandle,
    PerformanceSignalType,
    SanitizedPerformanceEntry,
    VisibilityState,
    VisibilitySummary,
} from './types'

const DEFAULT_MAX_FRAMES = 2048
const DEFAULT_MAX_INTERACTIONS = 64
const DEFAULT_MAX_SIGNAL_ENTRIES = 128
const DEFAULT_MAX_RESOURCE_ENTRIES = 512
const DEFAULT_MAX_HOST_EVIDENCE_SAMPLES = 256
const DEFAULT_MAX_INTERACTION_QUALITY_SAMPLES = 256
const DEFAULT_SLOW_FRAME_FACTOR = 1.5
const DEFAULT_INFERENCE_MINIMUM_SAMPLES = 30
const MINIMUM_VISIBLE_CAPTURE_MS = 5_000
const MINIMUM_CAPTURE_FRAME_SAMPLES = 30
const MAX_FRAME_CAPACITY = 20_000
const MAX_INTERACTION_CAPACITY = 512
const MAX_SIGNAL_CAPACITY = 2_048
const MAX_RESOURCE_CAPACITY = 8_192
const MAX_HOST_EVIDENCE_CAPACITY = 4_096
const MAX_INTERACTION_QUALITY_CAPACITY = 4_096
const MAX_QUALITY_DURATION_MS = 600_000
const MAX_QUALITY_COUNT = 1_000_000
const INTERACTION_KINDS: readonly AnimationInteractionKind[] = [
    'transition',
    'drag',
    'scroll',
    'gesture',
    'navigation',
    'pointer',
    'keyboard',
    'load',
    'lifecycle',
    'custom',
]
const RESOURCE_CATEGORIES: readonly AnimationResourceCategory[] = ['script', 'image', 'media', 'fetch-xhr', 'link-css', 'frame', 'other']

interface ResolvedOptions {
    maxFrames: number
    maxInteractions: number
    maxSignalEntries: number
    maxResourceEntries: number
    maxHostEvidenceSamples: number
    maxInteractionQualitySamples: number
    explicitRefreshHz?: number
    slowFrameFactor: number
    inferenceMinimumSamples: number
}

interface ActiveInteraction {
    finalize(): InteractionMeasurement
    snapshot(capturedAt: number): ActiveInteractionMeasurement
}

interface StoredInteractionQualitySample {
    inputToVisualMs?: number
    pointerSampleAgeMs?: number
    progressError?: number
    domWebglAlignmentErrorPx?: number
    controlWritersPerFrame?: number
    settleTimeMs?: number
    overshootRatio?: number
    oscillationCount?: number
    coalescedEventsAvailable?: number
    coalescedEventsConsumed?: number
}

interface LoafSample {
    startTime: number
    endTime: number
    duration: number
    blockingDuration?: number
    styleAndLayoutTailDuration?: number
}

interface EventSample {
    startTime: number
    endTime: number
    duration: number
    inputDelay?: number
    processingDuration?: number
    presentationDelay?: number
}

interface FrameSample {
    startTime: number
    endTime: number
    duration: number
}

interface ResourceTimingSample {
    startTime: number
    endTime: number
    duration: number
    category: AnimationResourceCategory
    transferSize?: number
    encodedBodySize?: number
    decodedBodySize?: number
}

interface ResourceTimingCounters {
    count: number
    durationMs: number
    transferSizeBytes: number
    transferSizeSamples: number
    encodedBodySizeBytes: number
    encodedBodySizeSamples: number
    decodedBodySizeBytes: number
    decodedBodySizeSamples: number
    zeroTransferSizeCount: number
}

interface CaptureWindowEntry {
    originalStartTime: number
    startTime: number
    endTime: number
    duration: number
    clippedAtStart: boolean
}

type StoredInteractionMeasurement = Omit<InteractionMeasurement, 'performance'> & { qualitySummary: InteractionQualitySummary }

let captureSequence = 0

export class AnimationStateError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'AnimationStateError'
    }
}

export class AnimationUnsupportedError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'AnimationUnsupportedError'
    }
}

export class AnimationOptionsError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'AnimationOptionsError'
    }
}

function boundedInteger(name: string, value: number | undefined, fallback: number, maximum: number): number {
    const resolved = value ?? fallback
    if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
        throw new AnimationOptionsError(`${name} must be an integer between 1 and ${maximum}`)
    }
    return resolved
}

function resolveOptions(options: AnimationCollectorOptions): ResolvedOptions {
    const slowFrameFactor = options.slowFrameFactor ?? DEFAULT_SLOW_FRAME_FACTOR
    if (!Number.isFinite(slowFrameFactor) || slowFrameFactor < 1 || slowFrameFactor > 10) {
        throw new AnimationOptionsError('slowFrameFactor must be between 1 and 10')
    }
    if (
        options.explicitRefreshHz !== undefined &&
        (!Number.isFinite(options.explicitRefreshHz) || options.explicitRefreshHz < 20 || options.explicitRefreshHz > 360)
    ) {
        throw new AnimationOptionsError('explicitRefreshHz must be between 20 and 360')
    }
    const maxFrames = boundedInteger('maxFrames', options.maxFrames, DEFAULT_MAX_FRAMES, MAX_FRAME_CAPACITY)
    const inferenceMinimumSamples = boundedInteger(
        'inferenceMinimumSamples',
        options.inferenceMinimumSamples,
        DEFAULT_INFERENCE_MINIMUM_SAMPLES,
        1_000
    )
    if (options.explicitRefreshHz === undefined && inferenceMinimumSamples > maxFrames) {
        throw new AnimationOptionsError('inferenceMinimumSamples cannot exceed maxFrames without an explicit refresh rate')
    }
    return {
        maxFrames,
        maxInteractions: boundedInteger('maxInteractions', options.maxInteractions, DEFAULT_MAX_INTERACTIONS, MAX_INTERACTION_CAPACITY),
        maxSignalEntries: boundedInteger('maxSignalEntries', options.maxSignalEntries, DEFAULT_MAX_SIGNAL_ENTRIES, MAX_SIGNAL_CAPACITY),
        maxResourceEntries: boundedInteger(
            'maxResourceEntries',
            options.maxResourceEntries,
            DEFAULT_MAX_RESOURCE_ENTRIES,
            MAX_RESOURCE_CAPACITY
        ),
        maxHostEvidenceSamples: boundedInteger(
            'maxHostEvidenceSamples',
            options.maxHostEvidenceSamples,
            DEFAULT_MAX_HOST_EVIDENCE_SAMPLES,
            MAX_HOST_EVIDENCE_CAPACITY
        ),
        maxInteractionQualitySamples: boundedInteger(
            'maxInteractionQualitySamples',
            options.maxInteractionQualitySamples,
            DEFAULT_MAX_INTERACTION_QUALITY_SAMPLES,
            MAX_INTERACTION_QUALITY_CAPACITY
        ),
        explicitRefreshHz: options.explicitRefreshHz,
        slowFrameFactor,
        inferenceMinimumSamples,
    }
}

function finiteInRange(value: unknown, minimum: number, maximum: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function optionalNumber(value: unknown, minimum: number, maximum: number, integer = false): { valid: boolean; value?: number } {
    if (value === undefined) return { valid: true }
    if (!finiteInRange(value, minimum, maximum) || (integer && !Number.isInteger(value))) return { valid: false }
    return { valid: true, value }
}

function normalizeInteractionQualitySample(sample: InteractionQualitySample): StoredInteractionQualitySample | null {
    if (!sample || typeof sample !== 'object') return null
    const inputToVisualMs = optionalNumber(sample.inputToVisualMs, 0, MAX_QUALITY_DURATION_MS)
    const pointerSampleAgeMs = optionalNumber(sample.pointerSampleAgeMs, 0, MAX_QUALITY_DURATION_MS)
    const directProgressError = optionalNumber(sample.progressError, 0, 1)
    const intendedProgress = optionalNumber(sample.intendedProgress, 0, 1)
    const visualProgress = optionalNumber(sample.visualProgress, 0, 1)
    const alignmentError = optionalNumber(sample.domWebglAlignmentErrorPx, 0, 1_000_000_000)
    const controlWriters = optionalNumber(sample.controlWritersPerFrame, 0, MAX_QUALITY_COUNT, true)
    const settleTime = optionalNumber(sample.settleTimeMs, 0, MAX_QUALITY_DURATION_MS)
    const overshoot = optionalNumber(sample.overshootRatio, 0, 100)
    const oscillations = optionalNumber(sample.oscillationCount, 0, MAX_QUALITY_COUNT, true)
    const coalescedAvailable = optionalNumber(sample.coalescedEventsAvailable, 0, MAX_QUALITY_COUNT, true)
    const coalescedConsumed = optionalNumber(sample.coalescedEventsConsumed, 0, MAX_QUALITY_COUNT, true)

    if (
        !inputToVisualMs.valid ||
        !pointerSampleAgeMs.valid ||
        !directProgressError.valid ||
        !intendedProgress.valid ||
        !visualProgress.valid ||
        !alignmentError.valid ||
        !controlWriters.valid ||
        !settleTime.valid ||
        !overshoot.valid ||
        !oscillations.valid ||
        !coalescedAvailable.valid ||
        !coalescedConsumed.valid
    ) {
        return null
    }

    const hasProgressPair = intendedProgress.value !== undefined || visualProgress.value !== undefined
    if (hasProgressPair && (intendedProgress.value === undefined || visualProgress.value === undefined)) return null
    const computedProgressError =
        intendedProgress.value === undefined || visualProgress.value === undefined
            ? undefined
            : Math.abs(intendedProgress.value - visualProgress.value)
    if (
        computedProgressError !== undefined &&
        directProgressError.value !== undefined &&
        Math.abs(computedProgressError - directProgressError.value) > 0.001
    ) {
        return null
    }

    const hasCoalescedPair = coalescedAvailable.value !== undefined || coalescedConsumed.value !== undefined
    if (hasCoalescedPair && (coalescedAvailable.value === undefined || coalescedConsumed.value === undefined)) return null
    if (
        coalescedAvailable.value !== undefined &&
        coalescedConsumed.value !== undefined &&
        coalescedConsumed.value > coalescedAvailable.value
    ) {
        return null
    }

    const normalized: StoredInteractionQualitySample = {
        ...(inputToVisualMs.value === undefined ? {} : { inputToVisualMs: inputToVisualMs.value }),
        ...(pointerSampleAgeMs.value === undefined ? {} : { pointerSampleAgeMs: pointerSampleAgeMs.value }),
        ...(directProgressError.value === undefined && computedProgressError === undefined
            ? {}
            : { progressError: round(directProgressError.value ?? computedProgressError ?? 0, 6) }),
        ...(alignmentError.value === undefined ? {} : { domWebglAlignmentErrorPx: alignmentError.value }),
        ...(controlWriters.value === undefined ? {} : { controlWritersPerFrame: controlWriters.value }),
        ...(settleTime.value === undefined ? {} : { settleTimeMs: settleTime.value }),
        ...(overshoot.value === undefined ? {} : { overshootRatio: overshoot.value }),
        ...(oscillations.value === undefined ? {} : { oscillationCount: oscillations.value }),
        ...(coalescedAvailable.value === undefined ? {} : { coalescedEventsAvailable: coalescedAvailable.value }),
        ...(coalescedConsumed.value === undefined ? {} : { coalescedEventsConsumed: coalescedConsumed.value }),
    }
    return Object.keys(normalized).length > 0 ? normalized : null
}

function interactionQualitySummary(
    samples: BoundedRing<StoredInteractionQualitySample>,
    rejectedSampleCount: number,
    controllerConflictSampleCount: number,
    coalescedEventsAvailable: number,
    coalescedEventsConsumed: number
): InteractionQualitySummary {
    const retained = samples.toArray()
    return {
        status: samples.totalCount === 0 ? 'not-observed' : samples.droppedCount > 0 || rejectedSampleCount > 0 ? 'partial' : 'measured',
        acceptedSampleCount: samples.totalCount,
        retainedSampleCount: samples.retainedCount,
        droppedSampleCount: samples.droppedCount,
        rejectedSampleCount,
        capacity: samples.capacity,
        inputToVisual: durationStatistics(
            retained.flatMap(sample => (sample.inputToVisualMs === undefined ? [] : [sample.inputToVisualMs]))
        ),
        pointerSampleAge: durationStatistics(
            retained.flatMap(sample => (sample.pointerSampleAgeMs === undefined ? [] : [sample.pointerSampleAgeMs]))
        ),
        progressError: durationStatistics(retained.flatMap(sample => (sample.progressError === undefined ? [] : [sample.progressError]))),
        domWebglAlignmentError: durationStatistics(
            retained.flatMap(sample => (sample.domWebglAlignmentErrorPx === undefined ? [] : [sample.domWebglAlignmentErrorPx]))
        ),
        controlWritersPerFrame: durationStatistics(
            retained.flatMap(sample => (sample.controlWritersPerFrame === undefined ? [] : [sample.controlWritersPerFrame]))
        ),
        controllerConflictSampleCount,
        settleTime: durationStatistics(retained.flatMap(sample => (sample.settleTimeMs === undefined ? [] : [sample.settleTimeMs]))),
        overshootRatio: durationStatistics(
            retained.flatMap(sample => (sample.overshootRatio === undefined ? [] : [sample.overshootRatio]))
        ),
        oscillationCount: durationStatistics(
            retained.flatMap(sample => (sample.oscillationCount === undefined ? [] : [sample.oscillationCount]))
        ),
        coalescedEventsAvailable,
        coalescedEventsConsumed,
        coalescedEventUtilization: coalescedEventsAvailable === 0 ? null : round(coalescedEventsConsumed / coalescedEventsAvailable, 6),
    }
}

function hasMotionQualityEvidence(sample: StoredInteractionQualitySample): boolean {
    return (
        sample.progressError !== undefined ||
        sample.domWebglAlignmentErrorPx !== undefined ||
        sample.settleTimeMs !== undefined ||
        sample.overshootRatio !== undefined ||
        sample.oscillationCount !== undefined
    )
}

function normalizeWebVital(metric: AnimationWebVitalMeasurement): AnimationWebVitalMeasurement | null {
    if (!metric || !['CLS', 'INP', 'LCP'].includes(metric.name)) return null
    if (!finiteInRange(metric.value, 0, 1_000_000_000) || !finiteInRange(metric.delta, 0, 1_000_000_000)) return null
    if (!['good', 'needs-improvement', 'poor'].includes(metric.rating)) return null
    if (!['navigate', 'reload', 'back-forward', 'back-forward-cache', 'prerender', 'restore'].includes(metric.navigationType)) {
        return null
    }
    const numberValue = (value: unknown): number | undefined => (finiteInRange(value, 0, 1_000_000_000) ? value : undefined)
    const loadState = (value: unknown): 'loading' | 'dom-interactive' | 'dom-content-loaded' | 'complete' | undefined =>
        ['loading', 'dom-interactive', 'dom-content-loaded', 'complete'].includes(String(value))
            ? (value as 'loading' | 'dom-interactive' | 'dom-content-loaded' | 'complete')
            : undefined
    const base = {
        value: metric.value,
        delta: metric.delta,
        rating: metric.rating,
        navigationType: metric.navigationType,
    }
    const attribution =
        metric.attribution && typeof metric.attribution === 'object' ? (metric.attribution as Readonly<Record<string, unknown>>) : {}
    if (metric.name === 'CLS') {
        const largestShiftTime = numberValue(attribution.largestShiftTime)
        const largestShiftValue = numberValue(attribution.largestShiftValue)
        const state = loadState(attribution.loadState)
        return {
            ...base,
            name: 'CLS',
            attribution: {
                ...(largestShiftTime === undefined ? {} : { largestShiftTime }),
                ...(largestShiftValue === undefined ? {} : { largestShiftValue }),
                ...(state === undefined ? {} : { loadState: state }),
            },
        }
    }
    if (metric.name === 'INP') {
        const interactionTime = numberValue(attribution.interactionTime)
        const nextPaintTime = numberValue(attribution.nextPaintTime)
        const inputDelay = numberValue(attribution.inputDelay)
        const processingDuration = numberValue(attribution.processingDuration)
        const presentationDelay = numberValue(attribution.presentationDelay)
        const interactionType =
            attribution.interactionType === 'pointer' || attribution.interactionType === 'keyboard'
                ? attribution.interactionType
                : undefined
        const state = loadState(attribution.loadState)
        return {
            ...base,
            name: 'INP',
            attribution: {
                ...(interactionTime === undefined ? {} : { interactionTime }),
                ...(nextPaintTime === undefined ? {} : { nextPaintTime }),
                ...(interactionType === undefined ? {} : { interactionType }),
                ...(inputDelay === undefined ? {} : { inputDelay }),
                ...(processingDuration === undefined ? {} : { processingDuration }),
                ...(presentationDelay === undefined ? {} : { presentationDelay }),
                ...(state === undefined ? {} : { loadState: state }),
            },
        }
    }
    const timeToFirstByte = numberValue(attribution.timeToFirstByte)
    const resourceLoadDelay = numberValue(attribution.resourceLoadDelay)
    const resourceLoadDuration = numberValue(attribution.resourceLoadDuration)
    const elementRenderDelay = numberValue(attribution.elementRenderDelay)
    return {
        ...base,
        name: 'LCP',
        attribution: {
            ...(timeToFirstByte === undefined ? {} : { timeToFirstByte }),
            ...(resourceLoadDelay === undefined ? {} : { resourceLoadDelay }),
            ...(resourceLoadDuration === undefined ? {} : { resourceLoadDuration }),
            ...(elementRenderDelay === undefined ? {} : { elementRenderDelay }),
        },
    }
}

function emptyCapability(reason: string): CapabilityEvidence {
    return {
        state: 'unknown',
        observed: false,
        buffered: false,
        reason,
    }
}

function evidenceFromHandle(handle: PerformanceObserverHandle): CapabilityEvidence {
    return {
        state: handle.state,
        observed: false,
        buffered: handle.buffered,
        ...(handle.reason ? { reason: handle.reason } : {}),
    }
}

function createKindCounts(): Record<AnimationInteractionKind, number> {
    return {
        transition: 0,
        drag: 0,
        scroll: 0,
        pointer: 0,
        keyboard: 0,
        load: 0,
        lifecycle: 0,
        gesture: 0,
        navigation: 0,
        custom: 0,
    }
}

function emptyResourceCounters(): ResourceTimingCounters {
    return {
        count: 0,
        durationMs: 0,
        transferSizeBytes: 0,
        transferSizeSamples: 0,
        encodedBodySizeBytes: 0,
        encodedBodySizeSamples: 0,
        decodedBodySizeBytes: 0,
        decodedBodySizeSamples: 0,
        zeroTransferSizeCount: 0,
    }
}

function createResourceCategoryCounters(): Record<AnimationResourceCategory, ResourceTimingCounters> {
    return Object.fromEntries(RESOURCE_CATEGORIES.map(category => [category, emptyResourceCounters()])) as Record<
        AnimationResourceCategory,
        ResourceTimingCounters
    >
}

function resourceCategory(initiatorType: string | undefined): AnimationResourceCategory {
    if (initiatorType === 'script') return 'script'
    if (initiatorType === 'img' || initiatorType === 'image' || initiatorType === 'input' || initiatorType === 'icon') return 'image'
    if (initiatorType === 'audio' || initiatorType === 'video' || initiatorType === 'track') return 'media'
    if (initiatorType === 'fetch' || initiatorType === 'xmlhttprequest' || initiatorType === 'beacon' || initiatorType === 'ping') {
        return 'fetch-xhr'
    }
    if (initiatorType === 'css' || initiatorType === 'link' || initiatorType === 'early-hint') return 'link-css'
    if (initiatorType === 'frame' || initiatorType === 'iframe' || initiatorType === 'navigation') return 'frame'
    return 'other'
}

function addResourceCounters(counters: ResourceTimingCounters, sample: ResourceTimingSample): void {
    counters.count = clampCount(counters.count)
    counters.durationMs = Math.min(1e15, counters.durationMs + sample.duration)
    if (sample.transferSize !== undefined) {
        counters.transferSizeBytes = Math.min(1e15, counters.transferSizeBytes + sample.transferSize)
        counters.transferSizeSamples = clampCount(counters.transferSizeSamples)
        if (sample.transferSize === 0) counters.zeroTransferSizeCount = clampCount(counters.zeroTransferSizeCount)
    }
    if (sample.encodedBodySize !== undefined) {
        counters.encodedBodySizeBytes = Math.min(1e15, counters.encodedBodySizeBytes + sample.encodedBodySize)
        counters.encodedBodySizeSamples = clampCount(counters.encodedBodySizeSamples)
    }
    if (sample.decodedBodySize !== undefined) {
        counters.decodedBodySizeBytes = Math.min(1e15, counters.decodedBodySizeBytes + sample.decodedBodySize)
        counters.decodedBodySizeSamples = clampCount(counters.decodedBodySizeSamples)
    }
}

function completeResourceSize(total: number, samples: number, count: number): number | null {
    if (count === 0) return 0
    return samples === count ? round(total) : null
}

function normalizeLabel(kind: AnimationInteractionKind, label: string | undefined): string {
    const normalized = (label ?? kind)
        .replace(/\p{Cc}/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    return (normalized || kind).slice(0, 64)
}

function createCaptureId(): string {
    captureSequence += 1
    const cryptoValue = typeof crypto === 'undefined' ? undefined : crypto
    const random = cryptoValue?.randomUUID
        ? cryptoValue.randomUUID().replace(/-/g, '')
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
    return `animation_${random.slice(0, 48)}_${captureSequence.toString(36)}`
}

function clampCount(value: number): number {
    return Math.min(1_000_000_000, value + 1)
}

function signalSummary<T extends { duration: number }>(
    ring: BoundedRing<T>,
    capability: CapabilityEvidence,
    totalDurationMs: number
): BoundedSignalSummary {
    const samples = ring.toArray()
    const unavailable = capability.state !== 'supported' && !capability.observed
    return {
        capability: { ...capability },
        retainedCount: unavailable ? null : ring.retainedCount,
        totalObservedCount: unavailable ? null : ring.totalCount,
        droppedSampleCount: unavailable ? null : ring.droppedCount,
        capacity: ring.capacity,
        totalDurationMs: unavailable ? null : round(totalDurationMs),
        duration: durationStatistics(samples.map(sample => sample.duration)),
    }
}

function summarizeBursts(samples: readonly number[], threshold: number, budgetMs: number): BurstSummary {
    let count = 0
    let longestFrameCount = 0
    let longestDurationMs = 0
    let maxMissedFrameOpportunities = 0
    let currentFrameCount = 0
    let currentDuration = 0
    let currentMissed = 0

    const finishBurst = (): void => {
        if (currentFrameCount === 0) return
        count += 1
        longestFrameCount = Math.max(longestFrameCount, currentFrameCount)
        longestDurationMs = Math.max(longestDurationMs, currentDuration)
        maxMissedFrameOpportunities = Math.max(maxMissedFrameOpportunities, currentMissed)
        currentFrameCount = 0
        currentDuration = 0
        currentMissed = 0
    }

    for (const sample of samples) {
        if (sample > threshold) {
            currentFrameCount += 1
            currentDuration += sample
            currentMissed += missedFrameOpportunities(sample, budgetMs)
        } else {
            finishBurst()
        }
    }
    finishBurst()

    return {
        count,
        longestFrameCount,
        longestDurationMs: round(longestDurationMs),
        maxMissedFrameOpportunities,
    }
}

function cloneAnimationSnapshot(snapshot: AnimationSnapshot): AnimationSnapshot {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(snapshot)
        } catch {
            // Snapshots contain plain data; retain a compatibility fallback for
            // older or partially implemented structuredClone hosts.
        }
    }
    return JSON.parse(JSON.stringify(snapshot)) as AnimationSnapshot
}

export class AnimationCollector {
    private readonly options: ResolvedOptions
    private readonly runtime: AnimationRuntime
    private readonly frameSamples: BoundedRing<FrameSample>
    private readonly loafSamples: BoundedRing<LoafSample>
    private readonly longTaskSamples: BoundedRing<{ startTime: number; endTime: number; duration: number }>
    private readonly eventSamples: BoundedRing<EventSample>
    private readonly resourceSamples: BoundedRing<ResourceTimingSample>
    private readonly hostEvidence: AnimationHostEvidenceRecorder
    private readonly overheadSamples: BoundedRing<number>
    private readonly reportBuildSamples: BoundedRing<number>
    private readonly interactionSamples: BoundedRing<StoredInteractionMeasurement>
    private readonly activeInteractions = new Map<string, ActiveInteraction>()
    private readonly interactionKindCounts = createKindCounts()
    private readonly cleanupCallbacks = new Set<() => void>()

    private collectorState: CollectorState = 'idle'
    private captureId = ''
    private startedAt = 0
    private stoppedAt = 0
    private lastFrameTimestamp: number | null = null
    private interactionSequence = 0
    private completedInteractions = 0
    private cancelledInteractions = 0
    private abandonedInteractions = 0
    private initialVisibility: VisibilityState = 'unknown'
    private currentVisibility: VisibilityState = 'unknown'
    private visibilityEpochStartedAt = 0
    private readonly visibilityDurationMs: Record<VisibilityState, number> = {
        visible: 0,
        hidden: 0,
        prerender: 0,
        unknown: 0,
    }
    private visibilityTransitions = 0
    private hiddenTransitions = 0
    private visibleTransitions = 0
    private reducedMotion: boolean | null = null
    private reducedMotionChanges = 0
    private finalSnapshot: AnimationSnapshot | null = null
    private loafCapability = emptyCapability('collector not started')
    private longTaskCapability = emptyCapability('collector not started')
    private eventCapability = emptyCapability('collector not started')
    private resourceCapability = emptyCapability('collector not started')
    private resourceBufferEventCapability = emptyCapability('collector not started')
    private presentationDelayCapability = emptyCapability('collector not started')
    private webVitalsCapability = emptyCapability('collector not started')
    private webVitalsObservedUpdates = 0
    private readonly latestWebVitals: AnimationWebVitalsSummary['latest'] = {
        CLS: null,
        INP: null,
        LCP: null,
    }
    private interactionQualityAcceptedCount = 0
    private interactionQualityDroppedCount = 0
    private interactionQualityRejectedCount = 0
    private continuousQualityAcceptedCount = 0
    private continuousQualityDroppedCount = 0
    private continuousQualityRejectedCount = 0
    private interactionMotionQualitySampleCount = 0
    private loafTotalDuration = 0
    private longTaskTotalDuration = 0
    private eventTotalDuration = 0
    private readonly resourceCounters = emptyResourceCounters()
    private readonly resourceCategoryCounters = createResourceCategoryCounters()
    private rejectedResourceEntries = 0
    private resourceBufferFullEvents = 0
    private excludedPreCaptureResources = 0
    private callbackTotalDuration = 0

    constructor(options: AnimationCollectorOptions = {}) {
        this.options = resolveOptions(options)
        this.runtime = options.runtime ?? createBrowserAnimationRuntime()
        this.frameSamples = new BoundedRing<FrameSample>(this.options.maxFrames)
        this.loafSamples = new BoundedRing<LoafSample>(this.options.maxSignalEntries)
        this.longTaskSamples = new BoundedRing<{ startTime: number; endTime: number; duration: number }>(this.options.maxSignalEntries)
        this.eventSamples = new BoundedRing<EventSample>(this.options.maxSignalEntries)
        this.resourceSamples = new BoundedRing<ResourceTimingSample>(this.options.maxResourceEntries)
        this.hostEvidence = new AnimationHostEvidenceRecorder(this.options.maxHostEvidenceSamples)
        this.overheadSamples = new BoundedRing<number>(this.options.maxSignalEntries)
        this.reportBuildSamples = new BoundedRing<number>(this.options.maxSignalEntries)
        this.interactionSamples = new BoundedRing<StoredInteractionMeasurement>(this.options.maxInteractions)
    }

    get state(): CollectorState {
        return this.collectorState
    }

    get isBrowserRuntime(): boolean {
        return this.runtime.isBrowser
    }

    start(): this {
        if (this.collectorState !== 'idle') {
            throw new AnimationStateError(`start() requires idle state; current state is ${this.collectorState}`)
        }
        if (!this.runtime.isBrowser) {
            throw new AnimationUnsupportedError('animation collection requires a browser runtime')
        }
        if (this.runtime.frameCapability === 'unsupported') {
            throw new AnimationUnsupportedError('animation collection requires requestAnimationFrame support')
        }

        this.collectorState = 'running'
        this.startedAt = this.runtime.now()
        this.captureId = createCaptureId()
        this.initialVisibility = this.runtime.getVisibilityState()
        this.currentVisibility = this.initialVisibility
        this.visibilityEpochStartedAt = this.startedAt
        this.reducedMotion = this.runtime.getReducedMotion()

        try {
            this.addCleanup(
                this.runtime.onVisibilityChange(state => {
                    this.measureOverhead(() => this.handleVisibilityChange(state))
                })
            )
            this.addCleanup(
                this.runtime.onReducedMotionChange(reduced => {
                    this.measureOverhead(() => {
                        if (reduced !== this.reducedMotion) this.reducedMotionChanges = clampCount(this.reducedMotionChanges)
                        this.reducedMotion = reduced
                    })
                })
            )
            this.loafCapability = this.registerObserver('long-animation-frame', entries => this.ingestLoaf(entries))
            this.longTaskCapability = this.registerObserver('longtask', entries => this.ingestLongTasks(entries))
            this.eventCapability = this.registerObserver('event', entries => this.ingestEventTiming(entries))
            this.resourceCapability = this.registerObserver('resource', entries => this.ingestResourceTiming(entries))
            if (this.runtime.onResourceTimingBufferFull) {
                const bufferHandle = this.runtime.onResourceTimingBufferFull(() => {
                    this.measureOverhead(() => {
                        this.resourceBufferFullEvents = clampCount(this.resourceBufferFullEvents)
                        if (this.resourceBufferEventCapability.state === 'unknown') {
                            this.resourceBufferEventCapability.state = 'supported'
                        }
                        this.resourceBufferEventCapability.observed = true
                    })
                })
                this.resourceBufferEventCapability = evidenceFromHandle(bufferHandle)
                this.addCleanup(() => bufferHandle.disconnect())
            } else {
                this.resourceBufferEventCapability = emptyCapability('runtime does not expose resource timing buffer events')
            }
            this.presentationDelayCapability =
                this.eventCapability.state === 'unsupported'
                    ? { ...this.eventCapability }
                    : emptyCapability('presentation timing not observed')
            if (this.runtime.subscribeWebVitals) {
                this.webVitalsCapability = emptyCapability('document-lifetime Web Vitals not observed')
                this.addCleanup(
                    this.runtime.subscribeWebVitals(metric => {
                        this.measureOverhead(() => this.ingestWebVital(metric))
                    })
                )
            } else {
                this.webVitalsCapability = emptyCapability('runtime does not expose Web Vitals')
            }
            this.addCleanup(
                this.runtime.subscribeFrames(timestamp => {
                    this.measureOverhead(() => this.handleFrame(timestamp))
                })
            )
        } catch (error) {
            this.cleanupResources()
            this.collectorState = 'idle'
            throw error
        }

        return this
    }

    snapshot(): AnimationSnapshot {
        if (this.collectorState !== 'running' && this.collectorState !== 'stopped') {
            throw new AnimationStateError(`snapshot() requires running or stopped state; current state is ${this.collectorState}`)
        }
        if (this.collectorState === 'stopped' && this.finalSnapshot) return cloneAnimationSnapshot(this.finalSnapshot)
        this.drainPendingPerformanceEntries()
        return this.captureSnapshot(this.runtime.now(), 'running')
    }

    stop(): AnimationSnapshot {
        if (this.collectorState === 'stopped' && this.finalSnapshot) return cloneAnimationSnapshot(this.finalSnapshot)
        if (this.collectorState !== 'running') {
            throw new AnimationStateError(`stop() requires running state; current state is ${this.collectorState}`)
        }

        // Drain while observers and semantic interactions are still active so
        // records queued immediately before stop participate in attribution.
        this.drainPendingPerformanceEntries()
        for (const active of [...this.activeInteractions.values()]) active.finalize()
        this.stoppedAt = this.runtime.now()
        this.cleanupResources()
        this.collectorState = 'stopped'
        this.finalSnapshot = this.captureSnapshot(this.stoppedAt, 'stopped')
        return cloneAnimationSnapshot(this.finalSnapshot)
    }

    destroy(): void {
        if (this.collectorState === 'destroyed') return
        if (this.collectorState === 'running') this.stop()
        else this.cleanupResources()
        this.collectorState = 'destroyed'
    }

    beginInteraction(kind: AnimationInteractionKind, label?: string): AnimationInteractionHandle {
        if (this.collectorState !== 'running') {
            throw new AnimationStateError(`beginInteraction() requires running state; current state is ${this.collectorState}`)
        }
        if (!INTERACTION_KINDS.includes(kind)) {
            throw new AnimationOptionsError(`unsupported interaction kind: ${String(kind)}`)
        }

        const id = `${this.captureId}-interaction-${(this.interactionSequence += 1).toString(36)}`
        const startedAt = this.runtime.now()
        const safeLabel = normalizeLabel(kind, label)
        const qualitySamples = new BoundedRing<StoredInteractionQualitySample>(this.options.maxInteractionQualitySamples)
        let rejectedQualitySamples = 0
        let controllerConflictSamples = 0
        let coalescedEventsAvailable = 0
        let coalescedEventsConsumed = 0
        let result: InteractionMeasurement | null = null

        const qualitySummary = (): InteractionQualitySummary =>
            interactionQualitySummary(
                qualitySamples,
                rejectedQualitySamples,
                controllerConflictSamples,
                coalescedEventsAvailable,
                coalescedEventsConsumed
            )

        const publicMeasurement = (stored: StoredInteractionMeasurement): InteractionMeasurement => ({
            id: stored.id,
            kind: stored.kind,
            label: stored.label,
            startedAt: stored.startedAt,
            endedAt: stored.endedAt,
            durationMs: stored.durationMs,
            outcome: stored.outcome,
            performance: this.interactionPerformance(stored),
        })

        const recordQuality = (sample: InteractionQualitySample): boolean => {
            if (result || this.collectorState !== 'running') return false
            const normalized = normalizeInteractionQualitySample(sample)
            if (!normalized) {
                rejectedQualitySamples = clampCount(rejectedQualitySamples)
                this.interactionQualityRejectedCount = clampCount(this.interactionQualityRejectedCount)
                if (kind === 'scroll' || kind === 'drag' || kind === 'pointer' || kind === 'gesture') {
                    this.continuousQualityRejectedCount = clampCount(this.continuousQualityRejectedCount)
                }
                return false
            }
            const droppedBefore = qualitySamples.droppedCount
            qualitySamples.push(normalized)
            this.interactionQualityAcceptedCount = clampCount(this.interactionQualityAcceptedCount)
            if (kind === 'scroll' || kind === 'drag' || kind === 'pointer' || kind === 'gesture') {
                this.continuousQualityAcceptedCount = clampCount(this.continuousQualityAcceptedCount)
            }
            if (qualitySamples.droppedCount > droppedBefore) {
                this.interactionQualityDroppedCount = clampCount(this.interactionQualityDroppedCount)
                if (kind === 'scroll' || kind === 'drag' || kind === 'pointer' || kind === 'gesture') {
                    this.continuousQualityDroppedCount = clampCount(this.continuousQualityDroppedCount)
                }
            }
            if ((normalized.controlWritersPerFrame ?? 0) > 1) controllerConflictSamples = clampCount(controllerConflictSamples)
            if (hasMotionQualityEvidence(normalized)) {
                this.interactionMotionQualitySampleCount = clampCount(this.interactionMotionQualitySampleCount)
            }
            coalescedEventsAvailable = Math.min(1e15, coalescedEventsAvailable + (normalized.coalescedEventsAvailable ?? 0))
            coalescedEventsConsumed = Math.min(1e15, coalescedEventsConsumed + (normalized.coalescedEventsConsumed ?? 0))
            return true
        }

        const finish = (outcome: InteractionOutcome): InteractionMeasurement => {
            if (result) return result
            const endedAt = this.runtime.now()
            const stored: StoredInteractionMeasurement = {
                id,
                kind,
                label: safeLabel,
                startedAt: round(startedAt),
                endedAt: round(endedAt),
                durationMs: round(Math.max(0, endedAt - startedAt)),
                outcome,
                qualitySummary: qualitySummary(),
            }
            this.activeInteractions.delete(id)
            this.interactionSamples.push(stored)
            this.interactionKindCounts[kind] = clampCount(this.interactionKindCounts[kind])
            if (outcome === 'completed') this.completedInteractions = clampCount(this.completedInteractions)
            else if (outcome === 'cancelled') this.cancelledInteractions = clampCount(this.cancelledInteractions)
            else this.abandonedInteractions = clampCount(this.abandonedInteractions)
            result = publicMeasurement(stored)
            return result
        }

        this.activeInteractions.set(id, {
            finalize: () => finish('abandoned'),
            snapshot: capturedAt => {
                const stored: StoredInteractionMeasurement = {
                    id,
                    kind,
                    label: safeLabel,
                    startedAt: round(startedAt),
                    endedAt: round(capturedAt),
                    durationMs: round(Math.max(0, capturedAt - startedAt)),
                    outcome: 'abandoned',
                    qualitySummary: qualitySummary(),
                }
                return {
                    id,
                    kind,
                    label: safeLabel,
                    startedAt: stored.startedAt,
                    capturedAt: stored.endedAt,
                    durationMs: stored.durationMs,
                    performance: this.interactionPerformance(stored),
                }
            },
        })

        return {
            id,
            kind,
            recordQuality,
            end: () => finish('completed'),
            cancel: () => finish('cancelled'),
        }
    }

    /**
     * Creates a local element sidecar without filtering, restarting, or
     * otherwise changing the page-level collector.
     */
    selectElement(element: Element, options: AnimationElementSelectionOptions = {}): AnimationElementSelectionHandle {
        if (this.collectorState !== 'running') {
            throw new AnimationStateError(`selectElement() requires running state; current state is ${this.collectorState}`)
        }
        if (!element || typeof element.addEventListener !== 'function') {
            throw new AnimationOptionsError('selectElement() requires a DOM Element')
        }
        const selection = createAnimationElementSelection(
            element,
            {
                now: () => this.runtime.now(),
                beginInteraction: (kind, label) => this.beginInteraction(kind, label),
            },
            options
        )
        this.addCleanup(() => selection.clear())
        return selection
    }

    recordFrameworkStats(sample: AnimationFrameworkStatsSample): boolean {
        return this.recordHostEvidence(() => this.hostEvidence.recordFrameworkStats(sample, this.runtime.now()))
    }

    recordRenderStats(sample: AnimationRenderStatsSample): boolean {
        return this.recordHostEvidence(() => this.hostEvidence.recordRenderStats(sample, this.runtime.now()))
    }

    recordLifecycleStats(sample: AnimationLifecycleStatsSample): boolean {
        return this.recordHostEvidence(() => this.hostEvidence.recordLifecycleStats(sample, this.runtime.now()))
    }

    recordWorkStats(sample: AnimationWorkStatsSample): boolean {
        return this.recordHostEvidence(() => this.hostEvidence.recordWorkStats(sample, this.runtime.now()))
    }

    recordMediaStats(sample: AnimationMediaStatsSample): boolean {
        return this.recordHostEvidence(() => this.hostEvidence.recordMediaStats(sample, this.runtime.now()))
    }

    /** Epoch time is only used by the explicit RUM projection, never by local frame math. */
    epochNow(): number {
        return this.runtime.wallNow?.() ?? Date.now()
    }

    private recordHostEvidence(record: () => boolean): boolean {
        if (this.collectorState !== 'running') return false
        let accepted = false
        this.measureOverhead(() => {
            accepted = record()
        })
        return accepted
    }

    private registerObserver(
        type: PerformanceSignalType,
        ingest: (entries: readonly SanitizedPerformanceEntry[]) => void
    ): CapabilityEvidence {
        const handle = this.runtime.observePerformance(type, entries => {
            this.measureOverhead(() => ingest(entries))
        })
        this.addCleanup(() => handle.disconnect())
        return evidenceFromHandle(handle)
    }

    private drainPendingPerformanceEntries(): void {
        try {
            this.runtime.drainPendingPerformanceEntries?.()
        } catch {
            // Reporting boundaries must remain available when a host drain
            // implementation fails; already-delivered evidence stays valid.
        }
    }

    private ingestLoaf(entries: readonly SanitizedPerformanceEntry[]): void {
        for (const entry of entries) {
            if (!Number.isFinite(entry.duration) || entry.duration < 0) continue
            const windowEntry = this.captureWindowEntry(entry)
            if (!windowEntry) continue
            const { originalStartTime, startTime, endTime, duration, clippedAtStart } = windowEntry
            const styleAndLayoutStart = entry.styleAndLayoutStart
            // The LoAF API uses zero when this phase boundary is unavailable.
            // Fail closed for zero/non-finite/out-of-entry values instead of
            // turning the whole frame into a fabricated rendering tail.
            const styleAndLayoutTailDuration =
                styleAndLayoutStart !== undefined &&
                Number.isFinite(styleAndLayoutStart) &&
                styleAndLayoutStart > 0 &&
                styleAndLayoutStart >= originalStartTime &&
                styleAndLayoutStart < endTime
                    ? Math.max(0, endTime - Math.max(startTime, styleAndLayoutStart))
                    : undefined
            this.loafSamples.push({
                startTime,
                endTime,
                duration,
                ...(!clippedAtStart && entry.blockingDuration !== undefined && entry.blockingDuration >= 0
                    ? { blockingDuration: entry.blockingDuration }
                    : {}),
                ...(styleAndLayoutTailDuration !== undefined ? { styleAndLayoutTailDuration } : {}),
            })
            this.loafTotalDuration = Math.min(1e15, this.loafTotalDuration + duration)
            if (this.loafCapability.state === 'unknown') this.loafCapability.state = 'supported'
            this.loafCapability.observed = true
        }
    }

    private ingestLongTasks(entries: readonly SanitizedPerformanceEntry[]): void {
        for (const entry of entries) {
            if (!Number.isFinite(entry.duration) || entry.duration < 0) continue
            const windowEntry = this.captureWindowEntry(entry)
            if (!windowEntry) continue
            const { startTime, endTime, duration } = windowEntry
            this.longTaskSamples.push({ startTime, endTime, duration })
            this.longTaskTotalDuration = Math.min(1e15, this.longTaskTotalDuration + duration)
            if (this.longTaskCapability.state === 'unknown') this.longTaskCapability.state = 'supported'
            this.longTaskCapability.observed = true
        }
    }

    private ingestEventTiming(entries: readonly SanitizedPerformanceEntry[]): void {
        for (const entry of entries) {
            if (!Number.isFinite(entry.duration) || entry.duration < 0) continue
            const windowEntry = this.captureWindowEntry(entry)
            if (!windowEntry) continue
            const { originalStartTime, startTime, endTime, duration } = windowEntry
            const inputDelay =
                entry.processingStart !== undefined
                    ? this.intervalOverlap(originalStartTime, entry.processingStart, startTime, endTime)
                    : undefined
            const processingDuration =
                entry.processingStart !== undefined && entry.processingEnd !== undefined
                    ? this.intervalOverlap(entry.processingStart, entry.processingEnd, startTime, endTime)
                    : undefined
            const presentationDelay =
                entry.processingEnd !== undefined ? this.intervalOverlap(entry.processingEnd, endTime, startTime, endTime) : undefined
            this.eventSamples.push({
                startTime,
                endTime,
                duration,
                ...(inputDelay !== undefined ? { inputDelay } : {}),
                ...(processingDuration !== undefined ? { processingDuration } : {}),
                ...(presentationDelay !== undefined ? { presentationDelay } : {}),
            })
            this.eventTotalDuration = Math.min(1e15, this.eventTotalDuration + duration)
            if (this.eventCapability.state === 'unknown') this.eventCapability.state = 'supported'
            this.eventCapability.observed = true
            if (presentationDelay !== undefined) {
                this.presentationDelayCapability = {
                    state: 'supported',
                    observed: true,
                    buffered: this.eventCapability.buffered,
                }
            }
        }
    }

    private ingestResourceTiming(entries: readonly SanitizedPerformanceEntry[]): void {
        for (const entry of entries) {
            const startTime = entry.startTime
            if (!finiteInRange(startTime, 0, 1e15) || !finiteInRange(entry.duration, 0, 1e15)) {
                this.rejectedResourceEntries = clampCount(this.rejectedResourceEntries)
                continue
            }
            // Resource bytes describe the complete request and cannot be
            // clipped safely. Buffered requests that began before start are
            // excluded instead of being attributed incorrectly to this capture.
            if (startTime < this.startedAt) {
                this.excludedPreCaptureResources = clampCount(this.excludedPreCaptureResources)
                continue
            }
            const optionalSize = (value: number | undefined): number | undefined => (finiteInRange(value, 0, 1e15) ? value : undefined)
            const transferSize = optionalSize(entry.transferSize)
            const encodedBodySize = optionalSize(entry.encodedBodySize)
            const decodedBodySize = optionalSize(entry.decodedBodySize)
            const sample: ResourceTimingSample = {
                startTime,
                endTime: startTime + entry.duration,
                duration: entry.duration,
                category: resourceCategory(entry.resourceInitiatorType),
                ...(transferSize === undefined ? {} : { transferSize }),
                ...(encodedBodySize === undefined ? {} : { encodedBodySize }),
                ...(decodedBodySize === undefined ? {} : { decodedBodySize }),
            }
            this.resourceSamples.push(sample)
            addResourceCounters(this.resourceCounters, sample)
            addResourceCounters(this.resourceCategoryCounters[sample.category], sample)
            if (this.resourceCapability.state === 'unknown') this.resourceCapability.state = 'supported'
            this.resourceCapability.observed = true
        }
    }

    private ingestWebVital(metric: AnimationWebVitalMeasurement): void {
        const normalized = normalizeWebVital(metric)
        if (!normalized) return
        if (normalized.name === 'CLS') this.latestWebVitals.CLS = normalized
        else if (normalized.name === 'INP') this.latestWebVitals.INP = normalized
        else this.latestWebVitals.LCP = normalized
        this.webVitalsObservedUpdates = clampCount(this.webVitalsObservedUpdates)
        this.webVitalsCapability = {
            state: 'supported',
            observed: true,
            buffered: false,
        }
    }

    private captureWindowEntry(entry: SanitizedPerformanceEntry): CaptureWindowEntry | null {
        const originalStartTime = entry.startTime ?? Math.max(0, this.runtime.now() - entry.duration)
        const endTime = originalStartTime + entry.duration
        if (endTime <= this.startedAt) return null
        const startTime = Math.max(originalStartTime, this.startedAt)
        return {
            originalStartTime,
            startTime,
            endTime,
            duration: Math.max(0, endTime - startTime),
            clippedAtStart: originalStartTime < this.startedAt,
        }
    }

    private intervalOverlap(intervalStart: number, intervalEnd: number, windowStart: number, windowEnd: number): number {
        return Math.max(0, Math.min(intervalEnd, windowEnd) - Math.max(intervalStart, windowStart))
    }

    private handleVisibilityChange(state: VisibilityState): void {
        if (state === this.currentVisibility) return
        const changedAt = this.runtime.now()
        this.visibilityDurationMs[this.currentVisibility] = Math.min(
            1e15,
            this.visibilityDurationMs[this.currentVisibility] + Math.max(0, changedAt - this.visibilityEpochStartedAt)
        )
        this.visibilityEpochStartedAt = changedAt
        this.visibilityTransitions = clampCount(this.visibilityTransitions)
        this.currentVisibility = state
        this.lastFrameTimestamp = null
        if (state === 'visible') {
            this.visibleTransitions = clampCount(this.visibleTransitions)
        } else {
            if (state === 'hidden') this.hiddenTransitions = clampCount(this.hiddenTransitions)
        }
    }

    private handleFrame(timestamp: number): void {
        if (this.collectorState !== 'running' || this.currentVisibility !== 'visible') return
        if (this.lastFrameTimestamp !== null) {
            const delta = timestamp - this.lastFrameTimestamp
            if (Number.isFinite(delta) && delta > 0) {
                this.frameSamples.push({
                    startTime: this.lastFrameTimestamp,
                    endTime: timestamp,
                    duration: delta,
                })
            }
        }
        this.lastFrameTimestamp = timestamp
    }

    private measureOverhead(callback: () => void): void {
        const started = this.runtime.now()
        try {
            callback()
        } finally {
            const elapsed = Math.max(0, this.runtime.now() - started)
            if (Number.isFinite(elapsed)) {
                this.overheadSamples.push(elapsed)
                this.callbackTotalDuration = Math.min(1e15, this.callbackTotalDuration + elapsed)
            }
        }
    }

    private addCleanup(callback: () => void): void {
        let cleaned = false
        this.cleanupCallbacks.add(() => {
            if (cleaned) return
            cleaned = true
            callback()
        })
    }

    private cleanupResources(): void {
        this.lastFrameTimestamp = null
        for (const cleanup of [...this.cleanupCallbacks]) {
            try {
                cleanup()
            } catch {
                // Cleanup is best-effort, but remains idempotent.
            }
        }
        this.cleanupCallbacks.clear()
    }

    private frameBudget(): FrameBudget {
        return inferFrameBudget(
            this.frameSamples.toArray().map(sample => sample.duration),
            this.options.explicitRefreshHz,
            this.options.inferenceMinimumSamples
        )
    }

    private frameSummary(budget: FrameBudget): FrameSummary {
        const samples = this.frameSamples.toArray().map(sample => sample.duration)
        const threshold = budget.frameBudgetMs * this.options.slowFrameFactor
        const slowSamples = samples.filter(duration => duration > threshold)
        return {
            retainedCount: this.frameSamples.retainedCount,
            totalObservedCount: this.frameSamples.totalCount,
            droppedSampleCount: this.frameSamples.droppedCount,
            capacity: this.frameSamples.capacity,
            duration: durationStatistics(samples),
            slowFrameThresholdMs: round(threshold),
            slowFrameCount: slowSamples.length,
            slowFrameRatio: samples.length === 0 ? null : round(slowSamples.length / samples.length, 6),
            missedFrameOpportunities: samples.reduce((sum, duration) => sum + missedFrameOpportunities(duration, budget.frameBudgetMs), 0),
        }
    }

    private loafSummary(): LongAnimationFrameSummary {
        const base = signalSummary(this.loafSamples, this.loafCapability, this.loafTotalDuration)
        const samples = this.loafSamples.toArray()
        return {
            ...base,
            blockingDuration: durationStatistics(
                samples.flatMap(sample => (sample.blockingDuration === undefined ? [] : [sample.blockingDuration]))
            ),
            styleAndLayoutTailDuration: durationStatistics(
                samples.flatMap(sample => (sample.styleAndLayoutTailDuration === undefined ? [] : [sample.styleAndLayoutTailDuration]))
            ),
        }
    }

    private eventSummary(): EventTimingSummary {
        const base = signalSummary(this.eventSamples, this.eventCapability, this.eventTotalDuration)
        const samples = this.eventSamples.toArray()
        return {
            ...base,
            inputDelay: durationStatistics(samples.flatMap(sample => (sample.inputDelay === undefined ? [] : [sample.inputDelay]))),
            processingDuration: durationStatistics(
                samples.flatMap(sample => (sample.processingDuration === undefined ? [] : [sample.processingDuration]))
            ),
            presentationDelay: durationStatistics(
                samples.flatMap(sample => (sample.presentationDelay === undefined ? [] : [sample.presentationDelay]))
            ),
            presentationDelayCapability: { ...this.presentationDelayCapability },
        }
    }

    private resourceSummary(): AnimationResourceTimingSummary {
        const unavailable = this.resourceCapability.state !== 'supported' && !this.resourceCapability.observed
        const retained = this.resourceSamples.toArray()
        const categorySummary = (category: AnimationResourceCategory) => {
            const counters = this.resourceCategoryCounters[category]
            const durations = retained.filter(sample => sample.category === category).map(sample => sample.duration)
            return {
                totalObservedCount: unavailable ? null : counters.count,
                totalDurationMs: unavailable ? null : round(counters.durationMs),
                transferSizeBytes: unavailable
                    ? null
                    : completeResourceSize(counters.transferSizeBytes, counters.transferSizeSamples, counters.count),
                encodedBodySizeBytes: unavailable
                    ? null
                    : completeResourceSize(counters.encodedBodySizeBytes, counters.encodedBodySizeSamples, counters.count),
                decodedBodySizeBytes: unavailable
                    ? null
                    : completeResourceSize(counters.decodedBodySizeBytes, counters.decodedBodySizeSamples, counters.count),
                zeroTransferSizeCount: unavailable ? null : counters.zeroTransferSizeCount,
                duration: unavailable ? null : durationStatistics(durations),
            }
        }
        return {
            capability: { ...this.resourceCapability },
            bufferEventCapability: { ...this.resourceBufferEventCapability },
            scope: 'capture-window',
            retainedCount: unavailable ? null : this.resourceSamples.retainedCount,
            totalObservedCount: unavailable ? null : this.resourceSamples.totalCount,
            droppedSampleCount: unavailable ? null : this.resourceSamples.droppedCount,
            rejectedEntryCount: unavailable ? null : this.rejectedResourceEntries,
            bufferFullEventCount:
                unavailable || (this.resourceBufferEventCapability.state !== 'supported' && !this.resourceBufferEventCapability.observed)
                    ? null
                    : this.resourceBufferFullEvents,
            excludedPreCaptureCount: unavailable ? null : this.excludedPreCaptureResources,
            capacity: this.resourceSamples.capacity,
            totalDurationMs: unavailable ? null : round(this.resourceCounters.durationMs),
            transferSizeBytes: unavailable
                ? null
                : completeResourceSize(
                      this.resourceCounters.transferSizeBytes,
                      this.resourceCounters.transferSizeSamples,
                      this.resourceCounters.count
                  ),
            encodedBodySizeBytes: unavailable
                ? null
                : completeResourceSize(
                      this.resourceCounters.encodedBodySizeBytes,
                      this.resourceCounters.encodedBodySizeSamples,
                      this.resourceCounters.count
                  ),
            decodedBodySizeBytes: unavailable
                ? null
                : completeResourceSize(
                      this.resourceCounters.decodedBodySizeBytes,
                      this.resourceCounters.decodedBodySizeSamples,
                      this.resourceCounters.count
                  ),
            zeroTransferSizeCount: unavailable ? null : this.resourceCounters.zeroTransferSizeCount,
            duration: unavailable ? null : durationStatistics(retained.map(sample => sample.duration)),
            categories: Object.fromEntries(RESOURCE_CATEGORIES.map(category => [category, categorySummary(category)])) as Record<
                AnimationResourceCategory,
                ReturnType<typeof categorySummary>
            >,
        }
    }

    private capabilities(): AnimationRumCapabilities {
        const value = (evidence: CapabilityEvidence): boolean | null => {
            if (evidence.state === 'supported') return true
            if (evidence.state === 'unsupported') return false
            return null
        }
        return {
            'long-animation-frame': value(this.loafCapability),
            longtask: value(this.longTaskCapability),
            event: value(this.eventCapability),
            resourceTiming: value(this.resourceCapability),
            resourceTimingBufferEvents: value(this.resourceBufferEventCapability),
            webVitalsAttribution: this.webVitalsCapability.observed ? true : null,
            webVitalsSoftNavigation: null,
            webVitalsDisabled: this.runtime.subscribeWebVitals ? false : null,
            reducedMotionPreference: this.reducedMotion === null ? null : true,
            documentAnimationsInspection: null,
            visibilityLifecycle: this.currentVisibility === 'unknown' ? null : true,
            longAnimationFramePaintTime: null,
            longAnimationFramePresentationTime: null,
        }
    }

    private coverage(captureSufficiency: CaptureSufficiencySummary, hostEvidence: AnimationHostEvidenceSummary): AnimationRumCoverage {
        const runtime = { evidenceLevel: 'runtime-observation' as const }
        const unavailable = { evidenceLevel: 'unsupported-or-unknown' as const }
        const mainThreadObserved = this.loafSamples.totalCount + this.longTaskSamples.totalCount > 0
        const mainThreadUnsupported = this.loafCapability.state === 'unsupported' && this.longTaskCapability.state === 'unsupported'
        const renderingObserved = this.loafSamples.toArray().some(sample => sample.styleAndLayoutTailDuration !== undefined)
        const scrollGestureObserved =
            this.interactionKindCounts.scroll +
                this.interactionKindCounts.drag +
                this.interactionKindCounts.pointer +
                this.interactionKindCounts.gesture >
            0
        const resourceUnsupported = this.resourceCapability.state === 'unsupported'
        const resourceObservedWindow = this.resourceCapability.state === 'supported' || this.resourceCapability.observed
        const rendererObserved = hostEvidence.renderer.evidenceSampleCount > 0
        const mediaObserved = hostEvidence.media.evidenceSampleCount > 0
        const lifecycleObserved = hostEvidence.lifecycle.evidenceSampleCount > 0

        return {
            userOutcome: {
                status:
                    this.interactionSamples.totalCount > 0
                        ? this.interactionSamples.droppedCount > 0
                            ? 'partial'
                            : 'measured'
                        : this.eventSamples.totalCount > 0
                          ? 'partial'
                          : this.webVitalsObservedUpdates > 0
                            ? 'partial'
                            : 'not-observed',
                ...runtime,
            },
            frameCadence: {
                status:
                    this.frameSamples.totalCount > 0
                        ? captureSufficiency.status === 'insufficient'
                            ? 'partial'
                            : 'measured'
                        : 'not-observed',
                ...runtime,
            },
            mainThread: {
                status: mainThreadObserved ? 'partial' : mainThreadUnsupported ? 'unsupported' : 'not-observed',
                ...(mainThreadUnsupported ? unavailable : runtime),
            },
            renderingPipeline: {
                status: renderingObserved ? 'partial' : this.loafCapability.state === 'unsupported' ? 'unsupported' : 'not-observed',
                ...(this.loafCapability.state === 'unsupported' ? unavailable : runtime),
            },
            renderer: rendererObserved ? { status: 'partial', ...runtime } : { status: 'not-instrumented', ...unavailable },
            scrollGesture: {
                status: scrollGestureObserved
                    ? this.continuousQualityAcceptedCount > 0
                        ? this.continuousQualityDroppedCount + this.continuousQualityRejectedCount > 0
                            ? 'partial'
                            : 'measured'
                        : 'partial'
                    : 'not-observed',
                ...runtime,
            },
            resourcesMedia: {
                status: mediaObserved || resourceObservedWindow ? 'partial' : resourceUnsupported ? 'unsupported' : 'not-observed',
                ...(mediaObserved || !resourceUnsupported ? runtime : unavailable),
            },
            memoryLifecycle: lifecycleObserved ? { status: 'partial', ...runtime } : { status: 'not-instrumented', ...unavailable },
            // These samples measure work and inventories, not whether the work
            // was avoidable or continued while hidden/offscreen.
            workAvoidance: { status: 'not-instrumented', ...unavailable },
            accessibility: { status: 'not-instrumented', ...unavailable },
            motionQuality: {
                status:
                    this.interactionMotionQualitySampleCount > 0
                        ? this.interactionQualityDroppedCount + this.interactionQualityRejectedCount > 0
                            ? 'partial'
                            : 'measured'
                        : 'not-instrumented',
                ...(this.interactionMotionQualitySampleCount > 0 ? runtime : unavailable),
            },
            monitorOverhead: this.monitorOverheadCoverage(),
        }
    }

    private monitorOverheadCoverage(): AnimationRumCoverage['monitorOverhead'] {
        return {
            status:
                this.overheadSamples.totalCount + this.reportBuildSamples.totalCount > 0
                    ? this.overheadSamples.droppedCount + this.reportBuildSamples.droppedCount > 0
                        ? 'partial'
                        : 'measured'
                    : 'not-observed',
            evidenceLevel: 'runtime-observation',
        }
    }

    private interactionSummary(capturedAt: number): InteractionSummary {
        const recent = this.interactionSamples.toArray().map(
            (measurement): InteractionMeasurement => ({
                id: measurement.id,
                kind: measurement.kind,
                label: measurement.label,
                startedAt: measurement.startedAt,
                endedAt: measurement.endedAt,
                durationMs: measurement.durationMs,
                outcome: measurement.outcome,
                performance: this.interactionPerformance(measurement),
            })
        )
        const active = [...this.activeInteractions.values()].map(interaction => interaction.snapshot(capturedAt))
        return {
            retainedCount: this.interactionSamples.retainedCount,
            totalObservedCount: this.interactionSamples.totalCount,
            droppedSampleCount: this.interactionSamples.droppedCount,
            capacity: this.interactionSamples.capacity,
            activeCount: this.activeInteractions.size,
            completedCount: this.completedInteractions,
            cancelledCount: this.cancelledInteractions,
            abandonedCount: this.abandonedInteractions,
            duration: durationStatistics(recent.map(measurement => measurement.durationMs)),
            byKind: { ...this.interactionKindCounts },
            active,
            recent,
        }
    }

    private interactionPerformance(measurement: StoredInteractionMeasurement): InteractionPerformanceSummary {
        const budget = this.frameBudget()
        const frameSamples = this.frameSamples
            .toArray()
            .filter(sample => sample.endTime > measurement.startedAt && sample.startTime < measurement.endedAt)
        const threshold = budget.frameBudgetMs * this.options.slowFrameFactor
        const frameDurations = frameSamples.map(sample => sample.duration)
        const slowFrames = frameDurations.filter(duration => duration > threshold)
        const frameStatus: InteractionFrameWindowSummary['status'] =
            this.frameSamples.droppedCount > 0 ? 'partial' : frameSamples.length > 0 ? 'measured' : 'not-observed'

        return {
            frames: {
                status: frameStatus,
                retainedCount: frameSamples.length,
                duration: durationStatistics(frameDurations),
                slowFrameCount: slowFrames.length,
                slowFrameRatio: frameSamples.length === 0 ? null : round(slowFrames.length / frameSamples.length, 6),
                missedFrameOpportunities: frameDurations.reduce(
                    (sum, duration) => sum + missedFrameOpportunities(duration, budget.frameBudgetMs),
                    0
                ),
                bursts: summarizeBursts(frameDurations, threshold, budget.frameBudgetMs),
            },
            longAnimationFrames: this.signalOverlap(this.loafSamples, this.loafCapability, measurement.startedAt, measurement.endedAt),
            longTasks: this.signalOverlap(this.longTaskSamples, this.longTaskCapability, measurement.startedAt, measurement.endedAt),
            eventTiming: this.signalOverlap(this.eventSamples, this.eventCapability, measurement.startedAt, measurement.endedAt),
            quality: measurement.qualitySummary,
        }
    }

    private signalOverlap<T extends { startTime: number; endTime: number; duration: number }>(
        ring: BoundedRing<T>,
        capability: CapabilityEvidence,
        startedAt: number,
        endedAt: number
    ): InteractionSignalWindowSummary {
        if (capability.state === 'unsupported') {
            return { status: 'unsupported', overlapCount: null, overlapDurationMs: null, duration: null }
        }
        if (capability.state === 'unknown' && !capability.observed) {
            return { status: 'unknown', overlapCount: null, overlapDurationMs: null, duration: null }
        }
        const overlapping = ring.toArray().filter(sample => sample.endTime > startedAt && sample.startTime < endedAt)
        const overlapDuration = overlapping.reduce(
            (sum, sample) => sum + Math.max(0, Math.min(sample.endTime, endedAt) - Math.max(sample.startTime, startedAt)),
            0
        )
        return {
            status: ring.droppedCount > 0 ? 'partial' : overlapping.length > 0 ? 'measured' : 'not-observed',
            overlapCount: overlapping.length,
            overlapDurationMs: round(overlapDuration),
            duration: durationStatistics(overlapping.map(sample => sample.duration)),
        }
    }

    private visibilitySummary(): VisibilitySummary {
        return {
            initial: this.initialVisibility,
            current: this.currentVisibility,
            transitionCount: this.visibilityTransitions,
            hiddenTransitionCount: this.hiddenTransitions,
            visibleTransitionCount: this.visibleTransitions,
            reducedMotion: this.reducedMotion,
            reducedMotionChangeCount: this.reducedMotionChanges,
        }
    }

    private captureSufficiency(capturedAt: number, budget: FrameBudget): CaptureSufficiencySummary {
        const durations = { ...this.visibilityDurationMs }
        durations[this.currentVisibility] = Math.min(
            1e15,
            durations[this.currentVisibility] + Math.max(0, capturedAt - this.visibilityEpochStartedAt)
        )
        const visibleDurationMs = round(durations.visible)
        const hiddenDurationMs = round(durations.hidden)
        const otherDurationMs = round(durations.prerender + durations.unknown)
        const reasons: Array<CaptureSufficiencySummary['reasons'][number]> = []
        if (visibleDurationMs < MINIMUM_VISIBLE_CAPTURE_MS) reasons.push('visible-window-too-short')
        if (this.frameSamples.retainedCount < MINIMUM_CAPTURE_FRAME_SAMPLES) reasons.push('insufficient-frame-samples')
        if (this.frameSamples.droppedCount > 0) reasons.push('frame-buffer-truncated')
        if (budget.confidence === 'low') reasons.push('refresh-confidence-low')
        return {
            status: reasons.length === 0 ? 'sufficient' : 'insufficient',
            reasons,
            minimumVisibleDurationMs: MINIMUM_VISIBLE_CAPTURE_MS,
            minimumFrameSamples: MINIMUM_CAPTURE_FRAME_SAMPLES,
            visibleDurationMs,
            hiddenDurationMs,
            otherDurationMs,
            retainedFrameSamples: this.frameSamples.retainedCount,
            totalObservedFrameSamples: this.frameSamples.totalCount,
            frameSamplesTruncated: this.frameSamples.droppedCount > 0,
            refreshConfidence: budget.confidence,
        }
    }

    private webVitalsSummary(): AnimationWebVitalsSummary {
        const copy = <T extends AnimationWebVitalMeasurement>(metric: T | null): T | null =>
            metric ? ({ ...metric, attribution: { ...metric.attribution } } as T) : null
        return {
            capability: { ...this.webVitalsCapability },
            scope: 'document-lifetime',
            observedUpdateCount: this.runtime.subscribeWebVitals ? this.webVitalsObservedUpdates : null,
            latest: {
                CLS: copy(this.latestWebVitals.CLS),
                INP: copy(this.latestWebVitals.INP),
                LCP: copy(this.latestWebVitals.LCP),
            },
        }
    }

    private overheadSummary(budget: FrameBudget): MonitorOverheadSummary {
        const duration = durationStatistics(this.overheadSamples.toArray())
        return {
            callbackCount: this.overheadSamples.totalCount,
            retainedCount: this.overheadSamples.retainedCount,
            droppedSampleCount: this.overheadSamples.droppedCount,
            totalCallbackDurationMs: round(this.callbackTotalDuration),
            duration,
            p95FrameBudgetRatio: duration ? round(duration.p95 / budget.frameBudgetMs, 6) : null,
            reportBuildDuration: durationStatistics(this.reportBuildSamples.toArray()),
            reportBuildRetainedCount: this.reportBuildSamples.retainedCount,
            reportBuildDroppedSampleCount: this.reportBuildSamples.droppedCount,
        }
    }

    private captureSnapshot(capturedAt: number, state: 'running' | 'stopped'): AnimationSnapshot {
        const buildStartedAt = this.runtime.now()
        const snapshot = this.buildSnapshot(capturedAt, state)
        const buildDuration = Math.max(0, this.runtime.now() - buildStartedAt)
        if (Number.isFinite(buildDuration)) this.reportBuildSamples.push(buildDuration)
        snapshot.monitorOverhead.reportBuildDuration = durationStatistics(this.reportBuildSamples.toArray())
        snapshot.monitorOverhead.reportBuildRetainedCount = this.reportBuildSamples.retainedCount
        snapshot.monitorOverhead.reportBuildDroppedSampleCount = this.reportBuildSamples.droppedCount
        snapshot.coverage.monitorOverhead = this.monitorOverheadCoverage()
        return snapshot
    }

    private buildSnapshot(capturedAt: number, state: 'running' | 'stopped'): AnimationSnapshot {
        const budget = this.frameBudget()
        const captureSufficiency = this.captureSufficiency(capturedAt, budget)
        const hostEvidence = this.hostEvidence.snapshot()
        const frameSamples = this.frameSamples.toArray().map(sample => sample.duration)
        const threshold = budget.frameBudgetMs * this.options.slowFrameFactor
        return {
            schemaVersion: 1,
            captureId: this.captureId,
            state,
            startedAt: round(this.startedAt),
            capturedAt: round(capturedAt),
            elapsedMs: round(Math.max(0, capturedAt - this.startedAt)),
            frameBudget: budget,
            frames: this.frameSummary(budget),
            bursts: summarizeBursts(frameSamples, threshold, budget.frameBudgetMs),
            longAnimationFrames: this.loafSummary(),
            longTasks: signalSummary(this.longTaskSamples, this.longTaskCapability, this.longTaskTotalDuration),
            eventTiming: this.eventSummary(),
            interactions: this.interactionSummary(capturedAt),
            visibility: this.visibilitySummary(),
            captureSufficiency,
            webVitals: this.webVitalsSummary(),
            resourceTiming: this.resourceSummary(),
            hostEvidence,
            monitorOverhead: this.overheadSummary(budget),
            capabilities: this.capabilities(),
            coverage: this.coverage(captureSufficiency, hostEvidence),
        }
    }
}
