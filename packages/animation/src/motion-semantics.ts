// cspell:ignore inspectable uninspected

import type {
    GsapTickerCadenceSnapshot,
    GsapTickerObserver,
    LenisScrollObserver,
    LenisScrollObserverSnapshot,
    ScrollTriggerObserver,
} from './host-adapters'
import { BoundedRing, round } from './statistics'
import type {
    AnimationInteractionHandle,
    AnimationInteractionKind,
    DurationStatistics,
    InteractionMeasurement,
    InteractionOutcome,
    InteractionQualitySample,
    InteractionQualitySummary,
} from './types'

export type MotionSemanticSource = 'gsap-ticker' | 'lenis-scroll' | 'scroll-trigger'
export type MotionSemanticSourceStatus = 'not-configured' | 'measured' | 'not-observed' | 'error'
export type MotionSemanticCheckpointStatus = 'measured' | 'partial' | 'not-observed' | 'not-instrumented'

export interface MotionSemanticGsapTickerEvidence {
    status: GsapTickerCadenceSnapshot['status']
    running: boolean
    cleanupFailed: boolean
    acceptedTickCount: number
    droppedTickCount: number
    rejectedTickCount: number
    slowTickTotalObservedCount: number | null
    deltaTimeMsP95: number | null
}

export interface MotionSemanticLenisEvidence {
    status: LenisScrollObserverSnapshot['status']
    running: boolean
    cleanupFailed: boolean
    acceptedEventCount: number
    droppedEventCount: number
    rejectedEventCount: number
    progressP95: number | null
    velocityP95: number | null
    lastVelocityP95: number | null
    latestObservedLenisTimeMs: number | null
}

export interface MotionSemanticScrollTriggerEvidence {
    timestampMs: number
    totalTriggerCount: number
    inspectedTriggerCount: number
    uninspectedTriggerCount: number
    triggerListTruncated: boolean
    rejectedTriggerCount: number
    rejectedFieldCount: number
    activeStateSampleCount: number
    activeTriggerCount: number
    inactiveTriggerCount: number
    progressP95: number | null
    velocityPxPerSecondP95: number | null
    spanPxP95: number | null
}

export interface MotionSemanticCheckpoint {
    boundary: 'before-interaction' | 'after-interaction'
    capturedAt: number
    status: MotionSemanticCheckpointStatus
    configuredSourceCount: number
    measuredSourceCount: number
    unobservedSourceCount: number
    errorSourceCount: number
    sourceStatus: Readonly<Record<MotionSemanticSource, MotionSemanticSourceStatus>>
    gsapTicker: MotionSemanticGsapTickerEvidence | null
    lenisScroll: MotionSemanticLenisEvidence | null
    scrollTrigger: MotionSemanticScrollTriggerEvidence | null
}

export interface MotionSemanticInteractionRecord {
    id: string
    kind: AnimationInteractionKind
    startedAt: number
    endedAt: number
    durationMs: number
    outcome: InteractionOutcome
    quality: InteractionQualitySummary
    before: MotionSemanticCheckpoint
    after: MotionSemanticCheckpoint
}

export interface MotionSemanticInteractionResult {
    /** Closed local summary of the existing page interaction; observer evidence is not added to it. */
    measurement: MotionSemanticPageInteractionSummary
    /** Local-only motion observer correlation. It is never projected into RUM by this helper. */
    semantic: MotionSemanticInteractionRecord
}

export interface MotionSemanticPageInteractionSummary {
    id: string
    kind: AnimationInteractionKind
    startedAt: number
    endedAt: number
    durationMs: number
    outcome: InteractionOutcome
    quality: InteractionQualitySummary
}

export interface MotionSemanticInteractionHandle {
    readonly id: string
    readonly kind: AnimationInteractionKind
    recordQuality(sample: InteractionQualitySample): boolean
    end(): MotionSemanticInteractionResult
    cancel(): MotionSemanticInteractionResult
}

export interface MotionSemanticCheckpointRecorderSnapshot {
    status: 'active' | 'disposing' | 'dispose-failed' | 'disposed'
    capacity: number
    maximumActiveInteractions: number
    begunInteractionCount: number
    retainedInteractionCount: number
    droppedInteractionCount: number
    activeInteractionCount: number
    completedInteractionCount: number
    cancelledInteractionCount: number
    abandonedInteractionCount: number
    sourceReadErrorCount: number
    cleanupFailed: boolean
    cleanupFailureCount: number
    truncated: boolean
    interactions: readonly MotionSemanticInteractionRecord[]
}

export interface MotionSemanticCheckpointRecorder {
    begin(kind: AnimationInteractionKind, label?: string): MotionSemanticInteractionHandle
    snapshot(): MotionSemanticCheckpointRecorderSnapshot
    /** Cancels open monitoring windows only; it never controls a host animation or scroll engine. */
    dispose(): void
}

export interface MotionSemanticCheckpointRecorderOptions {
    beginInteraction(kind: AnimationInteractionKind, label?: string): AnimationInteractionHandle
    gsapTicker?: Pick<GsapTickerObserver, 'snapshot'>
    lenisScroll?: Pick<LenisScrollObserver, 'snapshot'>
    scrollTrigger?: Pick<ScrollTriggerObserver, 'capture'>
    /** Bounded completed-interaction tail. Defaults to 64 and is capped at 1,024. */
    capacity?: number
    /** Maximum simultaneously open semantic windows. Defaults to 32 and is capped at 512. */
    maximumActiveInteractions?: number
    now?: () => number
}

interface MotionSources {
    gsapTicker: Pick<GsapTickerObserver, 'snapshot'> | null
    lenisScroll: Pick<LenisScrollObserver, 'snapshot'> | null
    scrollTrigger: Pick<ScrollTriggerObserver, 'capture'> | null
}

interface SourceRead<T> {
    status: MotionSemanticSourceStatus
    evidence: T | null
}

const MAX_COUNT = 1_000_000_000
const MAX_ACCUMULATED_COUNT = 1_000_000_000_000_000
const MAX_DURATION_MS = 600_000
const MAX_SIGNED_VALUE = 1_000_000_000_000
const MAX_TIMESTAMP_MS = 1_000_000_000_000_000
const MAX_INTERACTION_ID_LENGTH = 128
const MAX_OBSERVER_CAPACITY = 4_096
const MAX_QUALITY_CAPACITY = 4_096
const INTERACTION_KINDS = new Set<AnimationInteractionKind>([
    'transition',
    'drag',
    'scroll',
    'pointer',
    'keyboard',
    'load',
    'lifecycle',
    'gesture',
    'navigation',
    'custom',
])

const GSAP_TICKER_STATUSES = new Set<GsapTickerCadenceSnapshot['status']>([
    'idle',
    'observing',
    'unsupported',
    'add-failed',
    'remove-failed',
    'disposed',
])
const LENIS_STATUSES = new Set<LenisScrollObserverSnapshot['status']>([
    'idle',
    'observing',
    'unsupported',
    'add-failed',
    'remove-failed',
    'disposed',
])

function boundedCapacity(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? Math.min(1_024, value) : 64
}

function boundedMaximumActiveInteractions(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? Math.min(512, value) : 32
}

function count(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT ? value : null
}

function accumulatedCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_ACCUMULATED_COUNT ? value : null
}

function optionalCount(value: unknown): number | null | undefined {
    if (value === null) return null
    const normalized = count(value)
    return normalized === null ? undefined : normalized
}

function finite(value: unknown, maximum = MAX_SIGNED_VALUE): number | null {
    return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= maximum ? round(value) : null
}

function finiteNonNegative(value: unknown, maximum = MAX_SIGNED_VALUE): number | null {
    const normalized = finite(value, maximum)
    return normalized !== null && normalized >= 0 ? normalized : null
}

function optionalFiniteNonNegative(value: unknown, maximum = MAX_SIGNED_VALUE): number | null | undefined {
    if (value === null) return null
    const normalized = finiteNonNegative(value, maximum)
    return normalized === null ? undefined : normalized
}

function interactionId(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_INTERACTION_ID_LENGTH || /\p{Cc}/u.test(value)) return null
    return value
}

function normalizedTripleCounts(
    value: unknown,
    keys: readonly [string, string, string]
): Readonly<{ first: number; second: number; third: number }> | null {
    if (typeof value !== 'object' || value === null) return null
    try {
        const record = value as Record<string, unknown>
        const first = count(record[keys[0] ?? ''])
        const second = count(record[keys[1] ?? ''])
        const third = count(record[keys[2] ?? ''])
        return first === null || second === null || third === null ? null : Object.freeze({ first, second, third })
    } catch {
        return null
    }
}

function durationStatistics(value: unknown, maximumValue: number, maximumCount: number): Readonly<DurationStatistics> | null | undefined {
    if (value === null) return null
    if (typeof value !== 'object' || value === null) return undefined
    try {
        const sampleCount = count((value as DurationStatistics).count)
        const p50 = finiteNonNegative((value as DurationStatistics).p50, maximumValue)
        const p75 = finiteNonNegative((value as DurationStatistics).p75, maximumValue)
        const p95Value = finiteNonNegative((value as DurationStatistics).p95, maximumValue)
        const p99 = finiteNonNegative((value as DurationStatistics).p99, maximumValue)
        const max = finiteNonNegative((value as DurationStatistics).max, maximumValue)
        const total = finiteNonNegative((value as DurationStatistics).total, MAX_ACCUMULATED_COUNT)
        if (
            sampleCount === null ||
            sampleCount < 1 ||
            sampleCount > maximumCount ||
            p50 === null ||
            p75 === null ||
            p95Value === null ||
            p99 === null ||
            max === null ||
            total === null ||
            p50 > p75 ||
            p75 > p95Value ||
            p95Value > p99 ||
            p99 > max ||
            total + 0.001 < max ||
            total > max * sampleCount + 0.001
        ) {
            return undefined
        }
        return Object.freeze({ count: sampleCount, p50, p75, p95: p95Value, p99, max, total })
    } catch {
        return undefined
    }
}

function hostStatisticsP95(value: unknown, minimumValue: number, maximumValue: number, maximumCount: number): number | null | undefined {
    if (value === null) return null
    if (typeof value !== 'object' || value === null) return undefined
    try {
        const sampleCount = count((value as { count?: unknown }).count)
        const magnitude = Math.max(Math.abs(minimumValue), Math.abs(maximumValue))
        const p50 = finite((value as { p50?: unknown }).p50, magnitude)
        const p75 = finite((value as { p75?: unknown }).p75, magnitude)
        const p95Value = finite((value as { p95?: unknown }).p95, magnitude)
        const p99 = finite((value as { p99?: unknown }).p99, magnitude)
        const min = finite((value as { min?: unknown }).min, magnitude)
        const max = finite((value as { max?: unknown }).max, magnitude)
        const total = finite((value as { total?: unknown }).total, MAX_ACCUMULATED_COUNT)
        if (
            sampleCount === null ||
            sampleCount < 1 ||
            sampleCount > maximumCount ||
            p50 === null ||
            p75 === null ||
            p95Value === null ||
            p99 === null ||
            min === null ||
            max === null ||
            total === null ||
            min < minimumValue ||
            max > maximumValue ||
            min > p50 ||
            p50 > p75 ||
            p75 > p95Value ||
            p95Value > p99 ||
            p99 > max ||
            total < min * sampleCount - 0.001 ||
            total > max * sampleCount + 0.001
        ) {
            return undefined
        }
        return p95Value
    } catch {
        return undefined
    }
}

function normalizeQuality(value: unknown): InteractionQualitySummary | null {
    if (typeof value !== 'object' || value === null) return null
    try {
        const status = (value as InteractionQualitySummary).status
        const acceptedSampleCount = count((value as InteractionQualitySummary).acceptedSampleCount)
        const retainedSampleCount = count((value as InteractionQualitySummary).retainedSampleCount)
        const droppedSampleCount = count((value as InteractionQualitySummary).droppedSampleCount)
        const rejectedSampleCount = count((value as InteractionQualitySummary).rejectedSampleCount)
        const capacity = count((value as InteractionQualitySummary).capacity)
        const controllerConflictSampleCount = count((value as InteractionQualitySummary).controllerConflictSampleCount)
        const coalescedEventsAvailable = accumulatedCount((value as InteractionQualitySummary).coalescedEventsAvailable)
        const coalescedEventsConsumed = accumulatedCount((value as InteractionQualitySummary).coalescedEventsConsumed)
        if (
            acceptedSampleCount === null ||
            retainedSampleCount === null ||
            droppedSampleCount === null ||
            rejectedSampleCount === null ||
            capacity === null ||
            capacity < 1 ||
            capacity > MAX_QUALITY_CAPACITY ||
            retainedSampleCount > capacity ||
            retainedSampleCount + droppedSampleCount !== acceptedSampleCount ||
            controllerConflictSampleCount === null ||
            controllerConflictSampleCount > acceptedSampleCount ||
            coalescedEventsAvailable === null ||
            coalescedEventsConsumed === null ||
            coalescedEventsConsumed > coalescedEventsAvailable
        ) {
            return null
        }
        const expectedStatus =
            acceptedSampleCount === 0 ? 'not-observed' : droppedSampleCount > 0 || rejectedSampleCount > 0 ? 'partial' : 'measured'
        if (status !== expectedStatus) return null

        const inputToVisual = durationStatistics((value as InteractionQualitySummary).inputToVisual, MAX_DURATION_MS, retainedSampleCount)
        const pointerSampleAge = durationStatistics(
            (value as InteractionQualitySummary).pointerSampleAge,
            MAX_DURATION_MS,
            retainedSampleCount
        )
        const progressError = durationStatistics((value as InteractionQualitySummary).progressError, 1, retainedSampleCount)
        const domWebglAlignmentError = durationStatistics(
            (value as InteractionQualitySummary).domWebglAlignmentError,
            MAX_SIGNED_VALUE,
            retainedSampleCount
        )
        const controlWritersPerFrame = durationStatistics(
            (value as InteractionQualitySummary).controlWritersPerFrame,
            MAX_COUNT,
            retainedSampleCount
        )
        const settleTime = durationStatistics((value as InteractionQualitySummary).settleTime, MAX_DURATION_MS, retainedSampleCount)
        const overshootRatio = durationStatistics((value as InteractionQualitySummary).overshootRatio, MAX_COUNT, retainedSampleCount)
        const oscillationCount = durationStatistics((value as InteractionQualitySummary).oscillationCount, MAX_COUNT, retainedSampleCount)
        if (
            inputToVisual === undefined ||
            pointerSampleAge === undefined ||
            progressError === undefined ||
            domWebglAlignmentError === undefined ||
            controlWritersPerFrame === undefined ||
            settleTime === undefined ||
            overshootRatio === undefined ||
            oscillationCount === undefined
        ) {
            return null
        }
        const utilizationValue = (value as InteractionQualitySummary).coalescedEventUtilization
        const expectedUtilization = coalescedEventsAvailable === 0 ? null : round(coalescedEventsConsumed / coalescedEventsAvailable, 6)
        const utilization = expectedUtilization === null ? null : finiteNonNegative(utilizationValue, 1)
        if (
            (expectedUtilization === null && utilizationValue !== null) ||
            (expectedUtilization !== null && (utilization === null || Math.abs(utilization - expectedUtilization) > 0.000001))
        ) {
            return null
        }
        return Object.freeze({
            status,
            acceptedSampleCount,
            retainedSampleCount,
            droppedSampleCount,
            rejectedSampleCount,
            capacity,
            inputToVisual,
            pointerSampleAge,
            progressError,
            domWebglAlignmentError,
            controlWritersPerFrame,
            controllerConflictSampleCount,
            settleTime,
            overshootRatio,
            oscillationCount,
            coalescedEventsAvailable,
            coalescedEventsConsumed,
            coalescedEventUtilization: expectedUtilization,
        })
    } catch {
        return null
    }
}

function normalizeSettlement(
    value: unknown,
    expectedId: string,
    expectedKind: AnimationInteractionKind,
    expectedOutcome: InteractionOutcome
): MotionSemanticPageInteractionSummary | null {
    if (typeof value !== 'object' || value === null) return null
    try {
        const id = interactionId((value as InteractionMeasurement).id)
        const kind = (value as InteractionMeasurement).kind
        const outcome = (value as InteractionMeasurement).outcome
        const startedAt = finiteNonNegative((value as InteractionMeasurement).startedAt, MAX_TIMESTAMP_MS)
        const endedAt = finiteNonNegative((value as InteractionMeasurement).endedAt, MAX_TIMESTAMP_MS)
        const durationMs = finiteNonNegative((value as InteractionMeasurement).durationMs, MAX_DURATION_MS)
        const performance = (value as InteractionMeasurement).performance
        const quality = typeof performance === 'object' && performance !== null ? normalizeQuality(performance.quality) : null
        if (
            id === null ||
            id !== expectedId ||
            kind !== expectedKind ||
            outcome !== expectedOutcome ||
            startedAt === null ||
            endedAt === null ||
            endedAt < startedAt ||
            durationMs === null ||
            Math.abs(durationMs - (endedAt - startedAt)) > 0.01 ||
            quality === null
        ) {
            return null
        }
        return Object.freeze({ id, kind, startedAt, endedAt, durationMs, outcome, quality })
    } catch {
        return null
    }
}

function readGsapTicker(source: MotionSources['gsapTicker']): SourceRead<MotionSemanticGsapTickerEvidence> {
    if (!source) return { status: 'not-configured', evidence: null }
    try {
        const value = source.snapshot()
        const capacity = count(value.capacity)
        const acceptedTickCount = count(value.acceptedTickCount)
        const retainedTickCount = count(value.retainedTickCount)
        const droppedTickCount = count(value.droppedTickCount)
        const rejectedTickCount = count(value.rejectedTickCount)
        const slowTickTotalObservedCount = optionalCount(value.slowTickTotalObservedCount)
        const slowTickThresholdMs = optionalFiniteNonNegative(value.slowTickThresholdMs, MAX_DURATION_MS)
        const deltaTimeMs = durationStatistics(value.deltaTimeMs, MAX_DURATION_MS, retainedTickCount ?? 0)
        const deltaTimeMsP95 = deltaTimeMs?.p95 ?? (deltaTimeMs === null ? null : undefined)
        if (
            !GSAP_TICKER_STATUSES.has(value.status) ||
            typeof value.running !== 'boolean' ||
            typeof value.cleanupFailed !== 'boolean' ||
            capacity === null ||
            capacity < 1 ||
            capacity > MAX_OBSERVER_CAPACITY ||
            acceptedTickCount === null ||
            retainedTickCount === null ||
            droppedTickCount === null ||
            rejectedTickCount === null ||
            slowTickTotalObservedCount === undefined ||
            slowTickThresholdMs === undefined ||
            deltaTimeMsP95 === undefined
        ) {
            return { status: 'error', evidence: null }
        }
        if (
            retainedTickCount > capacity ||
            retainedTickCount + droppedTickCount !== acceptedTickCount ||
            value.truncated !== droppedTickCount > 0 ||
            value.running !== (value.status === 'observing') ||
            (value.running && value.cleanupFailed) ||
            (value.cleanupFailed && !['add-failed', 'remove-failed', 'disposed'].includes(value.status)) ||
            (value.status === 'unsupported' && (acceptedTickCount !== 0 || rejectedTickCount !== 0)) ||
            (retainedTickCount === 0 ? deltaTimeMs !== null : deltaTimeMs?.count !== retainedTickCount) ||
            (slowTickThresholdMs === null ? slowTickTotalObservedCount !== null : slowTickTotalObservedCount === null) ||
            (slowTickThresholdMs !== null && slowTickThresholdMs <= 0) ||
            (slowTickTotalObservedCount !== null && slowTickTotalObservedCount > acceptedTickCount)
        ) {
            return { status: 'error', evidence: null }
        }
        const evidence = Object.freeze({
            status: value.status,
            running: value.running,
            cleanupFailed: value.cleanupFailed,
            acceptedTickCount,
            droppedTickCount,
            rejectedTickCount,
            slowTickTotalObservedCount,
            deltaTimeMsP95,
        })
        return { status: acceptedTickCount > 0 ? 'measured' : 'not-observed', evidence }
    } catch {
        return { status: 'error', evidence: null }
    }
}

function readLenis(source: MotionSources['lenisScroll']): SourceRead<MotionSemanticLenisEvidence> {
    if (!source) return { status: 'not-configured', evidence: null }
    try {
        const value = source.snapshot()
        const capacity = count(value.capacity)
        const acceptedEventCount = count(value.acceptedEventCount)
        const retainedEventCount = count(value.retainedEventCount)
        const droppedEventCount = count(value.droppedEventCount)
        const rejectedEventCount = count(value.rejectedEventCount)
        const progressP95 = hostStatisticsP95(value.progress, 0, 1, retainedEventCount ?? 0)
        const velocityP95 = hostStatisticsP95(value.velocity, -MAX_SIGNED_VALUE, MAX_SIGNED_VALUE, retainedEventCount ?? 0)
        const lastVelocityP95 = hostStatisticsP95(value.lastVelocity, -MAX_SIGNED_VALUE, MAX_SIGNED_VALUE, retainedEventCount ?? 0)
        const latestObservedLenisTimeMs = optionalFiniteNonNegative(value.latestObservedLenisTimeMs)
        const scrollStates = normalizedTripleCounts(value.scrollStateTotalObservedCounts, ['smooth', 'native', 'idle'])
        const directions = normalizedTripleCounts(value.directionTotalObservedCounts, ['negative', 'zero', 'positive'])
        if (
            !LENIS_STATUSES.has(value.status) ||
            typeof value.running !== 'boolean' ||
            typeof value.cleanupFailed !== 'boolean' ||
            capacity === null ||
            capacity < 1 ||
            capacity > MAX_OBSERVER_CAPACITY ||
            acceptedEventCount === null ||
            retainedEventCount === null ||
            droppedEventCount === null ||
            rejectedEventCount === null ||
            progressP95 === undefined ||
            velocityP95 === undefined ||
            lastVelocityP95 === undefined ||
            latestObservedLenisTimeMs === undefined ||
            scrollStates === null ||
            directions === null
        ) {
            return { status: 'error', evidence: null }
        }
        const scrollStateCount = scrollStates.first + scrollStates.second + scrollStates.third
        const directionCount = directions.first + directions.second + directions.third
        if (
            retainedEventCount > capacity ||
            retainedEventCount + droppedEventCount !== acceptedEventCount ||
            value.truncated !== droppedEventCount > 0 ||
            value.running !== (value.status === 'observing') ||
            (value.running && value.cleanupFailed) ||
            (value.cleanupFailed && !['add-failed', 'remove-failed', 'disposed'].includes(value.status)) ||
            (value.status === 'unsupported' && (acceptedEventCount !== 0 || rejectedEventCount !== 0)) ||
            scrollStateCount > acceptedEventCount ||
            directionCount > acceptedEventCount
        ) {
            return { status: 'error', evidence: null }
        }
        const evidence = Object.freeze({
            status: value.status,
            running: value.running,
            cleanupFailed: value.cleanupFailed,
            acceptedEventCount,
            droppedEventCount,
            rejectedEventCount,
            progressP95,
            velocityP95,
            lastVelocityP95,
            latestObservedLenisTimeMs,
        })
        return { status: acceptedEventCount > 0 ? 'measured' : 'not-observed', evidence }
    } catch {
        return { status: 'error', evidence: null }
    }
}

function readScrollTrigger(source: MotionSources['scrollTrigger']): SourceRead<MotionSemanticScrollTriggerEvidence> {
    if (!source) return { status: 'not-configured', evidence: null }
    try {
        const value = source.capture()
        if (!value) return { status: 'not-observed', evidence: null }
        const timestampMs = finiteNonNegative(value.timestampMs)
        const totalTriggerCount = count(value.totalTriggerCount)
        const inspectedTriggerCount = count(value.inspectedTriggerCount)
        const uninspectedTriggerCount = count(value.uninspectedTriggerCount)
        const rejectedTriggerCount = count(value.rejectedTriggerCount)
        const rejectedFieldCount = count(value.rejectedFieldCount)
        const activeStateSampleCount = count(value.activeStateSampleCount)
        const activeTriggerCount = count(value.activeTriggerCount)
        const inactiveTriggerCount = count(value.inactiveTriggerCount)
        const inspectableTriggerCount =
            inspectedTriggerCount === null || rejectedTriggerCount === null ? 0 : inspectedTriggerCount - rejectedTriggerCount
        const progressP95 = hostStatisticsP95(value.progress, 0, 1, Math.max(0, inspectableTriggerCount))
        const velocityPxPerSecondP95 = hostStatisticsP95(
            value.velocityPxPerSecond,
            -MAX_SIGNED_VALUE,
            MAX_SIGNED_VALUE,
            Math.max(0, inspectableTriggerCount)
        )
        const spanPxP95 = hostStatisticsP95(value.spanPx, 0, MAX_SIGNED_VALUE, Math.max(0, inspectableTriggerCount))
        const directionSampleCount = count(value.directionSampleCount)
        const directionCounts = normalizedTripleCounts(value.directionCounts, ['negative', 'zero', 'positive'])
        if (
            value.reason !== 'manual' ||
            timestampMs === null ||
            totalTriggerCount === null ||
            inspectedTriggerCount === null ||
            uninspectedTriggerCount === null ||
            typeof value.triggerListTruncated !== 'boolean' ||
            rejectedTriggerCount === null ||
            rejectedFieldCount === null ||
            activeStateSampleCount === null ||
            activeTriggerCount === null ||
            inactiveTriggerCount === null ||
            directionSampleCount === null ||
            directionCounts === null ||
            progressP95 === undefined ||
            velocityPxPerSecondP95 === undefined ||
            spanPxP95 === undefined
        ) {
            return { status: 'error', evidence: null }
        }
        const directionTotal = directionCounts.first + directionCounts.second + directionCounts.third
        if (
            inspectedTriggerCount + uninspectedTriggerCount !== totalTriggerCount ||
            value.triggerListTruncated !== uninspectedTriggerCount > 0 ||
            rejectedTriggerCount > inspectedTriggerCount ||
            activeStateSampleCount > inspectableTriggerCount ||
            activeTriggerCount + inactiveTriggerCount !== activeStateSampleCount ||
            directionSampleCount > inspectableTriggerCount ||
            directionTotal !== directionSampleCount
        ) {
            return { status: 'error', evidence: null }
        }
        return {
            status: 'measured',
            evidence: Object.freeze({
                timestampMs,
                totalTriggerCount,
                inspectedTriggerCount,
                uninspectedTriggerCount,
                triggerListTruncated: value.triggerListTruncated,
                rejectedTriggerCount,
                rejectedFieldCount,
                activeStateSampleCount,
                activeTriggerCount,
                inactiveTriggerCount,
                progressP95,
                velocityPxPerSecondP95,
                spanPxP95,
            }),
        }
    } catch {
        return { status: 'error', evidence: null }
    }
}

function checkpointStatus(statuses: readonly MotionSemanticSourceStatus[]): MotionSemanticCheckpointStatus {
    const configured = statuses.filter(status => status !== 'not-configured')
    if (configured.length === 0) return 'not-instrumented'
    const measured = configured.filter(status => status === 'measured').length
    if (measured === configured.length) return 'measured'
    return measured > 0 ? 'partial' : 'not-observed'
}

function safeNow(now: () => number): number {
    try {
        const value = finiteNonNegative(now())
        if (value !== null) return value
    } catch {
        // Fall through to a runtime-owned clock.
    }
    return round(globalThis.performance?.now?.() ?? Date.now())
}

/**
 * Correlates caller-declared business interactions with closed public motion
 * observer evidence. It never infers semantics from library callbacks, starts
 * or controls a host engine, or adds observer snapshots to a RUM contract.
 */
export function createMotionSemanticCheckpointRecorder(options: MotionSemanticCheckpointRecorderOptions): MotionSemanticCheckpointRecorder {
    if (typeof options.beginInteraction !== 'function') {
        throw new TypeError('motion semantic checkpoints require a beginInteraction function')
    }
    let beginInteraction: MotionSemanticCheckpointRecorderOptions['beginInteraction'] | null = options.beginInteraction
    const capacity = boundedCapacity(options.capacity)
    const maximumActiveInteractions = boundedMaximumActiveInteractions(options.maximumActiveInteractions)
    const now = typeof options.now === 'function' ? options.now : () => globalThis.performance?.now?.() ?? Date.now()
    let sources: MotionSources | null = {
        gsapTicker: options.gsapTicker ?? null,
        lenisScroll: options.lenisScroll ?? null,
        scrollTrigger: options.scrollTrigger ?? null,
    }
    const interactions = new BoundedRing<MotionSemanticInteractionRecord>(capacity)
    const active = new Set<{ cancelFromDispose(): void }>()
    const activeRegistry = new WeakRef(active)
    let begunInteractionCount = 0
    let completedInteractionCount = 0
    let cancelledInteractionCount = 0
    let abandonedInteractionCount = 0
    let sourceReadErrorCount = 0
    let cleanupFailureCount = 0
    let cleanupFailed = false
    let disposalRequested = false
    let disposing = false
    let disposed = false
    let inFlightBeginCount = 0

    const finalizeDisposalIfIdle = (): void => {
        if (!disposalRequested || active.size > 0 || inFlightBeginCount > 0) return
        sources = null
        beginInteraction = null
        cleanupFailed = false
        disposed = true
    }

    const capture = (boundary: MotionSemanticCheckpoint['boundary']): MotionSemanticCheckpoint => {
        const currentSources = sources ?? { gsapTicker: null, lenisScroll: null, scrollTrigger: null }
        const gsapTicker = readGsapTicker(currentSources.gsapTicker)
        const lenisScroll = readLenis(currentSources.lenisScroll)
        const scrollTrigger = readScrollTrigger(currentSources.scrollTrigger)
        const statuses = [gsapTicker.status, lenisScroll.status, scrollTrigger.status]
        const configuredSourceCount = statuses.filter(status => status !== 'not-configured').length
        const measuredSourceCount = statuses.filter(status => status === 'measured').length
        const unobservedSourceCount = statuses.filter(status => status === 'not-observed').length
        const errorSourceCount = statuses.filter(status => status === 'error').length
        sourceReadErrorCount = Math.min(MAX_COUNT, sourceReadErrorCount + errorSourceCount)
        return Object.freeze({
            boundary,
            capturedAt: safeNow(now),
            status: checkpointStatus(statuses),
            configuredSourceCount,
            measuredSourceCount,
            unobservedSourceCount,
            errorSourceCount,
            sourceStatus: Object.freeze({
                'gsap-ticker': gsapTicker.status,
                'lenis-scroll': lenisScroll.status,
                'scroll-trigger': scrollTrigger.status,
            }),
            gsapTicker: gsapTicker.evidence,
            lenisScroll: lenisScroll.evidence,
            scrollTrigger: scrollTrigger.evidence,
        })
    }

    const snapshot = (): MotionSemanticCheckpointRecorderSnapshot =>
        Object.freeze({
            status: disposed ? 'disposed' : cleanupFailed ? 'dispose-failed' : disposalRequested ? 'disposing' : 'active',
            capacity,
            maximumActiveInteractions,
            begunInteractionCount,
            retainedInteractionCount: interactions.retainedCount,
            droppedInteractionCount: interactions.droppedCount,
            activeInteractionCount: active.size,
            completedInteractionCount,
            cancelledInteractionCount,
            abandonedInteractionCount,
            sourceReadErrorCount,
            cleanupFailed,
            cleanupFailureCount,
            truncated: interactions.droppedCount > 0,
            interactions: Object.freeze(interactions.toArray()),
        })

    return {
        begin(kind: AnimationInteractionKind, label?: string): MotionSemanticInteractionHandle {
            if (disposalRequested || disposed) {
                throw new Error('Cannot begin a motion semantic interaction after recorder disposal started')
            }
            if (!INTERACTION_KINDS.has(kind)) throw new TypeError(`Unsupported motion semantic interaction kind: ${String(kind)}`)
            if (active.size + inFlightBeginCount >= maximumActiveInteractions) {
                throw new Error(`Cannot exceed ${maximumActiveInteractions} active motion semantic interactions`)
            }
            const currentBeginInteraction = beginInteraction
            if (!currentBeginInteraction) throw new Error('Cannot begin a motion semantic interaction after recorder disposal started')
            inFlightBeginCount += 1
            let rawInteraction: AnimationInteractionHandle | null = null
            try {
                rawInteraction = currentBeginInteraction(kind, label)
            } catch (error) {
                inFlightBeginCount -= 1
                finalizeDisposalIfIdle()
                throw error
            }
            let id: string | null = null
            let handleKind: AnimationInteractionKind | null = null
            let validHandle = false
            try {
                id = interactionId(rawInteraction?.id)
                handleKind = rawInteraction?.kind ?? null
                validHandle =
                    !!rawInteraction &&
                    id !== null &&
                    handleKind === kind &&
                    typeof rawInteraction.recordQuality === 'function' &&
                    typeof rawInteraction.end === 'function' &&
                    typeof rawInteraction.cancel === 'function'
            } catch {
                validHandle = false
            }
            if (!validHandle || !rawInteraction || id === null || handleKind === null) {
                let malformedInteraction: unknown = rawInteraction
                const cleanupEntry = {
                    cancelFromDispose: (): void => {
                        if (typeof malformedInteraction !== 'object' || malformedInteraction === null) {
                            throw new TypeError('malformed animation interaction has no cleanup handle')
                        }
                        const cancel = (malformedInteraction as { cancel?: unknown }).cancel
                        if (typeof cancel !== 'function') throw new TypeError('malformed animation interaction has no cancel function')
                        cancel.call(malformedInteraction)
                        malformedInteraction = null
                        activeRegistry.deref()?.delete(cleanupEntry)
                        if (!disposing) finalizeDisposalIfIdle()
                    },
                }
                let cleanupSucceeded = false
                try {
                    cleanupEntry.cancelFromDispose()
                    cleanupSucceeded = true
                } catch {
                    // Best-effort cleanup of a malformed monitoring handle.
                }
                if (!cleanupSucceeded) {
                    active.add(cleanupEntry)
                    disposalRequested = true
                    beginInteraction = null
                    cleanupFailed = true
                    cleanupFailureCount = Math.min(MAX_COUNT, cleanupFailureCount + 1)
                }
                inFlightBeginCount -= 1
                finalizeDisposalIfIdle()
                throw new TypeError('beginInteraction returned an invalid animation interaction handle')
            }
            const before = capture('before-interaction')
            if (disposalRequested || disposed) {
                let compensationInteraction: AnimationInteractionHandle | null = rawInteraction
                const cleanupEntry = {
                    cancelFromDispose: (): void => {
                        const currentInteraction = compensationInteraction
                        if (!currentInteraction) return
                        const rawMeasurement = currentInteraction.cancel()
                        if (
                            !normalizeSettlement(rawMeasurement, id, kind, 'cancelled') &&
                            !normalizeSettlement(rawMeasurement, id, kind, 'abandoned')
                        ) {
                            throw new TypeError('animation interaction compensation returned an invalid measurement')
                        }
                        compensationInteraction = null
                        activeRegistry.deref()?.delete(cleanupEntry)
                        if (!disposing) finalizeDisposalIfIdle()
                    },
                }
                active.add(cleanupEntry)
                inFlightBeginCount -= 1
                disposing = true
                try {
                    cleanupEntry.cancelFromDispose()
                } catch {
                    cleanupFailed = true
                    cleanupFailureCount = Math.min(MAX_COUNT, cleanupFailureCount + 1)
                } finally {
                    disposing = false
                }
                finalizeDisposalIfIdle()
                throw new Error('Motion semantic interaction creation was aborted because recorder disposal started')
            }
            begunInteractionCount = Math.min(MAX_COUNT, begunInteractionCount + 1)
            let result: MotionSemanticInteractionResult | null = null
            let interaction: AnimationInteractionHandle | null = rawInteraction
            const owned = {
                cancelFromDispose: (): void => {
                    settle('cancelled', true)
                },
            }

            const settle = (
                outcome: Extract<InteractionOutcome, 'completed' | 'cancelled'>,
                acceptParentAbandonment = false
            ): MotionSemanticInteractionResult => {
                if (result) return result
                const currentInteraction = interaction
                if (!currentInteraction) throw new Error('Motion semantic interaction is no longer active')
                const rawMeasurement = outcome === 'completed' ? currentInteraction.end() : currentInteraction.cancel()
                const measurement =
                    normalizeSettlement(rawMeasurement, id, kind, outcome) ??
                    (acceptParentAbandonment && outcome === 'cancelled' ? normalizeSettlement(rawMeasurement, id, kind, 'abandoned') : null)
                if (!measurement) throw new TypeError('animation interaction settlement returned an invalid measurement')
                const after = capture('after-interaction')
                const semantic = Object.freeze({
                    id: measurement.id,
                    kind: measurement.kind,
                    startedAt: measurement.startedAt,
                    endedAt: measurement.endedAt,
                    durationMs: measurement.durationMs,
                    outcome: measurement.outcome,
                    quality: measurement.quality,
                    before,
                    after,
                })
                result = Object.freeze({ measurement, semantic })
                interactions.push(semantic)
                if (measurement.outcome === 'completed') {
                    completedInteractionCount = Math.min(MAX_COUNT, completedInteractionCount + 1)
                } else if (measurement.outcome === 'cancelled') {
                    cancelledInteractionCount = Math.min(MAX_COUNT, cancelledInteractionCount + 1)
                } else {
                    abandonedInteractionCount = Math.min(MAX_COUNT, abandonedInteractionCount + 1)
                }
                interaction = null
                activeRegistry.deref()?.delete(owned)
                if (!disposing) finalizeDisposalIfIdle()
                return result
            }

            active.add(owned)
            inFlightBeginCount -= 1
            return {
                id,
                kind,
                recordQuality: sample => {
                    if (result || disposalRequested || !interaction) return false
                    try {
                        return interaction.recordQuality(sample)
                    } catch {
                        return false
                    }
                },
                end: () => settle('completed'),
                cancel: () => settle('cancelled'),
            }
        },
        snapshot,
        dispose(): void {
            if (disposed || disposing) return
            disposalRequested = true
            beginInteraction = null
            disposing = true
            let failedThisAttempt = 0
            for (const interaction of [...active]) {
                try {
                    interaction.cancelFromDispose()
                } catch {
                    failedThisAttempt += 1
                }
            }
            disposing = false
            if (failedThisAttempt > 0 || active.size > 0) {
                cleanupFailed = true
                cleanupFailureCount = Math.min(MAX_COUNT, cleanupFailureCount + failedThisAttempt)
                return
            }
            finalizeDisposalIfIdle()
        },
    }
}
