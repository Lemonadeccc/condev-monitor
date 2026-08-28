import type { MediaSemanticAttemptOutcome, MediaSemanticKind, MediaSemanticStageKind } from './media-semantics'
import type { MotionSemanticCheckpointStatus, MotionSemanticSource, MotionSemanticSourceStatus } from './motion-semantics'
import type { AnimationInteractionKind, InteractionOutcome } from './types'

export const ANIMATION_LOCAL_EVIDENCE_VERSION = 1 as const

const MAX_PROVIDER_COUNT = 16
const MAX_RECORD_COUNT_PER_FAMILY = 32
const MAX_RECORD_INSPECTION_COUNT = 64
const MAX_COUNT = 1_000_000_000
const MAX_DURATION_MS = 600_000
const MAX_BYTE_COUNT = 1_000_000_000_000

const MEDIA_KINDS = new Set<MediaSemanticKind>(['image', 'video', 'canvas', 'webgl', 'webgpu', 'custom'])
const MEDIA_OUTCOMES = new Set<MediaSemanticAttemptOutcome>(['completed', 'cancelled'])
const MEDIA_STAGES = new Set<MediaSemanticStageKind>(['decode-ready', 'upload-ready', 'first-visible'])
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
const INTERACTION_OUTCOMES = new Set<InteractionOutcome>(['completed', 'cancelled', 'abandoned'])
const CHECKPOINT_STATUSES = new Set<MotionSemanticCheckpointStatus>(['measured', 'partial', 'not-observed', 'not-instrumented'])
const SOURCE_STATUSES = new Set<MotionSemanticSourceStatus>(['not-configured', 'measured', 'not-observed', 'error'])
const MOTION_SOURCES = ['gsap-ticker', 'lenis-scroll', 'scroll-trigger'] as const satisfies readonly MotionSemanticSource[]

export interface AnimationLocalEvidenceProviderInput {
    readonly kind: 'media' | 'motion'
    readonly snapshot: unknown
}

export interface AnimationLocalEvidenceInputV1 {
    readonly version: typeof ANIMATION_LOCAL_EVIDENCE_VERSION
    readonly providers: readonly AnimationLocalEvidenceProviderInput[]
    readonly droppedProviderCount?: unknown
}

export interface AnimationLocalMediaStageEvidence {
    readonly stage: MediaSemanticStageKind
    readonly elapsedMs: number
    readonly durationMs: number | null
    readonly byteCount: number | null
    readonly itemCount: number | null
}

export interface AnimationLocalMediaAttemptEvidence {
    readonly kind: MediaSemanticKind
    readonly outcome: MediaSemanticAttemptOutcome
    readonly durationMs: number
    readonly decodeReady: AnimationLocalMediaStageEvidence | null
    readonly uploadReady: AnimationLocalMediaStageEvidence | null
    readonly firstVisible: AnimationLocalMediaStageEvidence | null
}

export interface AnimationLocalMotionCheckpointEvidence {
    readonly boundary: 'before-interaction' | 'after-interaction'
    readonly status: MotionSemanticCheckpointStatus
    readonly configuredSourceCount: number
    readonly measuredSourceCount: number
    readonly unobservedSourceCount: number
    readonly errorSourceCount: number
    readonly sourceStatus: Readonly<Record<MotionSemanticSource, MotionSemanticSourceStatus>>
}

export interface AnimationLocalMotionInteractionEvidence {
    readonly kind: AnimationInteractionKind
    readonly outcome: InteractionOutcome
    readonly durationMs: number
    readonly before: AnimationLocalMotionCheckpointEvidence
    readonly after: AnimationLocalMotionCheckpointEvidence
}

export interface AnimationLocalEvidenceFamily<TRecord> {
    readonly providerCount: number
    readonly retainedRecordCount: number
    readonly droppedRecordCount: number
    readonly records: readonly TRecord[]
    readonly truncated: boolean
}

export interface AnimationLocalEvidenceSnapshotV1 {
    readonly version: typeof ANIMATION_LOCAL_EVIDENCE_VERSION
    readonly providerCount: number
    readonly rejectedProviderCount: number
    readonly droppedProviderCount: number
    readonly truncated: boolean
    readonly media: AnimationLocalEvidenceFamily<AnimationLocalMediaAttemptEvidence>
    readonly motion: AnimationLocalEvidenceFamily<AnimationLocalMotionInteractionEvidence>
}

export type AnimationLocalEvidenceSnapshot = AnimationLocalEvidenceSnapshotV1

interface MutableFamily<TRecord> {
    providerCount: number
    droppedRecordCount: number
    records: TRecord[]
}

function record(value: unknown): Record<PropertyKey, unknown> | null {
    return typeof value === 'object' && value !== null ? (value as Record<PropertyKey, unknown>) : null
}

function property(value: Record<PropertyKey, unknown>, key: PropertyKey): unknown {
    return value[key]
}

function safeCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT ? value : null
}

function safeNumber(value: unknown, maximum: number): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null
}

function nullableNumber(value: unknown, maximum: number): number | null | undefined {
    return value === null ? null : (safeNumber(value, maximum) ?? undefined)
}

function nullableCount(value: unknown, maximum = MAX_COUNT): number | null | undefined {
    return value === null
        ? null
        : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
          ? value
          : undefined
}

function arrayLength(value: unknown): number | null {
    if (!Array.isArray(value)) return null
    const length = value.length
    return Number.isSafeInteger(length) && length >= 0 ? length : null
}

function addBoundedCount(left: number, right: number): number {
    return Math.min(MAX_COUNT, left + right)
}

function projectMediaStage(value: unknown, expectedStage: MediaSemanticStageKind): AnimationLocalMediaStageEvidence | null | undefined {
    if (value === null) return null
    const input = record(value)
    if (!input) return undefined
    const stage = property(input, 'stage')
    const elapsedMs = safeNumber(property(input, 'elapsedMs'), MAX_DURATION_MS)
    const durationMs = nullableNumber(property(input, 'durationMs'), MAX_DURATION_MS)
    const byteCount = nullableCount(property(input, 'byteCount'), MAX_BYTE_COUNT)
    const itemCount = nullableCount(property(input, 'itemCount'))
    if (!MEDIA_STAGES.has(stage as MediaSemanticStageKind) || stage !== expectedStage) return undefined
    if (elapsedMs === null || durationMs === undefined || byteCount === undefined || itemCount === undefined) return undefined
    if (durationMs !== null && durationMs > elapsedMs) return undefined
    return Object.freeze({ stage: expectedStage, elapsedMs, durationMs, byteCount, itemCount })
}

function projectMediaAttempt(value: unknown): AnimationLocalMediaAttemptEvidence | null {
    try {
        const input = record(value)
        if (!input) return null
        const kind = property(input, 'kind')
        const outcome = property(input, 'outcome')
        const durationMs = safeNumber(property(input, 'durationMs'), MAX_DURATION_MS)
        const decodeReady = projectMediaStage(property(input, 'decodeReady'), 'decode-ready')
        const uploadReady = projectMediaStage(property(input, 'uploadReady'), 'upload-ready')
        const firstVisible = projectMediaStage(property(input, 'firstVisible'), 'first-visible')
        if (!MEDIA_KINDS.has(kind as MediaSemanticKind) || !MEDIA_OUTCOMES.has(outcome as MediaSemanticAttemptOutcome)) return null
        if (durationMs === null || decodeReady === undefined || uploadReady === undefined || firstVisible === undefined) return null
        if (outcome === 'cancelled' && firstVisible !== null) return null
        const orderedStages = [decodeReady, uploadReady, firstVisible].filter(
            (stage): stage is AnimationLocalMediaStageEvidence => stage !== null
        )
        if (orderedStages.some((stage, index) => index > 0 && stage.elapsedMs < orderedStages[index - 1]!.elapsedMs)) return null
        if (orderedStages.some(stage => stage.elapsedMs > durationMs)) return null
        return Object.freeze({
            kind: kind as MediaSemanticKind,
            outcome: outcome as MediaSemanticAttemptOutcome,
            durationMs,
            decodeReady,
            uploadReady,
            firstVisible,
        })
    } catch {
        return null
    }
}

function projectMotionCheckpoint(
    value: unknown,
    expectedBoundary: AnimationLocalMotionCheckpointEvidence['boundary']
): AnimationLocalMotionCheckpointEvidence | null {
    try {
        const input = record(value)
        if (!input || property(input, 'boundary') !== expectedBoundary) return null
        const status = property(input, 'status')
        const configuredSourceCount = safeCount(property(input, 'configuredSourceCount'))
        const measuredSourceCount = safeCount(property(input, 'measuredSourceCount'))
        const unobservedSourceCount = safeCount(property(input, 'unobservedSourceCount'))
        const errorSourceCount = safeCount(property(input, 'errorSourceCount'))
        const rawStatuses = record(property(input, 'sourceStatus'))
        if (
            !CHECKPOINT_STATUSES.has(status as MotionSemanticCheckpointStatus) ||
            configuredSourceCount === null ||
            measuredSourceCount === null ||
            unobservedSourceCount === null ||
            errorSourceCount === null ||
            !rawStatuses ||
            configuredSourceCount > MOTION_SOURCES.length ||
            measuredSourceCount + unobservedSourceCount + errorSourceCount > configuredSourceCount
        ) {
            return null
        }
        const statuses = {} as Record<MotionSemanticSource, MotionSemanticSourceStatus>
        for (const source of MOTION_SOURCES) {
            const sourceStatus = property(rawStatuses, source)
            if (!SOURCE_STATUSES.has(sourceStatus as MotionSemanticSourceStatus)) return null
            statuses[source] = sourceStatus as MotionSemanticSourceStatus
        }
        const computedConfiguredSourceCount = MOTION_SOURCES.filter(source => statuses[source] !== 'not-configured').length
        const computedMeasuredSourceCount = MOTION_SOURCES.filter(source => statuses[source] === 'measured').length
        const computedUnobservedSourceCount = MOTION_SOURCES.filter(source => statuses[source] === 'not-observed').length
        const computedErrorSourceCount = MOTION_SOURCES.filter(source => statuses[source] === 'error').length
        const computedStatus: MotionSemanticCheckpointStatus =
            computedConfiguredSourceCount === 0
                ? 'not-instrumented'
                : computedMeasuredSourceCount === computedConfiguredSourceCount
                  ? 'measured'
                  : computedMeasuredSourceCount > 0
                    ? 'partial'
                    : 'not-observed'
        if (
            status !== computedStatus ||
            configuredSourceCount !== computedConfiguredSourceCount ||
            measuredSourceCount !== computedMeasuredSourceCount ||
            unobservedSourceCount !== computedUnobservedSourceCount ||
            errorSourceCount !== computedErrorSourceCount
        ) {
            return null
        }
        return Object.freeze({
            boundary: expectedBoundary,
            status: status as MotionSemanticCheckpointStatus,
            configuredSourceCount,
            measuredSourceCount,
            unobservedSourceCount,
            errorSourceCount,
            sourceStatus: Object.freeze(statuses),
        })
    } catch {
        return null
    }
}

function projectMotionInteraction(value: unknown): AnimationLocalMotionInteractionEvidence | null {
    try {
        const input = record(value)
        if (!input) return null
        const kind = property(input, 'kind')
        const outcome = property(input, 'outcome')
        const durationMs = safeNumber(property(input, 'durationMs'), MAX_DURATION_MS)
        const before = projectMotionCheckpoint(property(input, 'before'), 'before-interaction')
        const after = projectMotionCheckpoint(property(input, 'after'), 'after-interaction')
        if (
            !INTERACTION_KINDS.has(kind as AnimationInteractionKind) ||
            !INTERACTION_OUTCOMES.has(outcome as InteractionOutcome) ||
            durationMs === null ||
            !before ||
            !after
        ) {
            return null
        }
        return Object.freeze({ kind: kind as AnimationInteractionKind, outcome: outcome as InteractionOutcome, durationMs, before, after })
    } catch {
        return null
    }
}

function projectProvider(
    value: unknown,
    media: MutableFamily<AnimationLocalMediaAttemptEvidence>,
    motion: MutableFamily<AnimationLocalMotionInteractionEvidence>
): boolean {
    try {
        const provider = record(value)
        if (!provider) return false
        const kind = property(provider, 'kind')
        const snapshot = record(property(provider, 'snapshot'))
        if ((kind !== 'media' && kind !== 'motion') || !snapshot) return false
        const rawRecords = property(snapshot, kind === 'media' ? 'attempts' : 'interactions')
        const length = arrayLength(rawRecords)
        if (length === null) return false
        const recorderDropped = safeCount(property(snapshot, kind === 'media' ? 'droppedAttemptCount' : 'droppedInteractionCount'))
        if (recorderDropped === null) return false
        const target = kind === 'media' ? media : motion
        target.providerCount += 1
        const project = kind === 'media' ? projectMediaAttempt : projectMotionInteraction
        const inspectionStart = Math.max(0, length - MAX_RECORD_INSPECTION_COUNT)
        target.droppedRecordCount = addBoundedCount(target.droppedRecordCount, inspectionStart)
        for (let index = inspectionStart; index < length; index += 1) {
            let projected: AnimationLocalMediaAttemptEvidence | AnimationLocalMotionInteractionEvidence | null
            try {
                projected = project((rawRecords as unknown[])[index] as never)
            } catch {
                projected = null
            }
            if (!projected) {
                target.droppedRecordCount = addBoundedCount(target.droppedRecordCount, 1)
                continue
            }
            ;(target.records as Array<typeof projected>).push(projected)
            if (target.records.length > MAX_RECORD_COUNT_PER_FAMILY) {
                target.records.shift()
                target.droppedRecordCount = addBoundedCount(target.droppedRecordCount, 1)
            }
        }
        target.droppedRecordCount = addBoundedCount(target.droppedRecordCount, recorderDropped)
        return true
    } catch {
        return false
    }
}

function freezeFamily<TRecord>(family: MutableFamily<TRecord>): AnimationLocalEvidenceFamily<TRecord> {
    return Object.freeze({
        providerCount: family.providerCount,
        retainedRecordCount: family.records.length,
        droppedRecordCount: family.droppedRecordCount,
        records: Object.freeze(family.records),
        truncated: family.droppedRecordCount > 0,
    })
}

function projectClosedFamily<TRecord>(
    value: unknown,
    project: (value: unknown) => TRecord | null
): AnimationLocalEvidenceFamily<TRecord> | null {
    try {
        const family = record(value)
        if (!family) return null
        const providerCount = safeCount(property(family, 'providerCount'))
        const suppliedDroppedRecordCount = safeCount(property(family, 'droppedRecordCount'))
        const rawRecords = property(family, 'records')
        const length = arrayLength(rawRecords)
        if (providerCount === null || suppliedDroppedRecordCount === null || length === null) return null
        const records: TRecord[] = []
        let droppedRecordCount = suppliedDroppedRecordCount
        const inspectionStart = Math.max(0, length - MAX_RECORD_INSPECTION_COUNT)
        droppedRecordCount = addBoundedCount(droppedRecordCount, inspectionStart)
        for (let index = inspectionStart; index < length; index += 1) {
            const projected = project((rawRecords as unknown[])[index])
            if (!projected) {
                droppedRecordCount = addBoundedCount(droppedRecordCount, 1)
                continue
            }
            records.push(projected)
            if (records.length > MAX_RECORD_COUNT_PER_FAMILY) {
                records.shift()
                droppedRecordCount = addBoundedCount(droppedRecordCount, 1)
            }
        }
        return freezeFamily({ providerCount, droppedRecordCount, records })
    } catch {
        return null
    }
}

function projectClosedSnapshot(value: Record<PropertyKey, unknown>): AnimationLocalEvidenceSnapshotV1 | null {
    const providerCount = safeCount(property(value, 'providerCount'))
    const rejectedProviderCount = safeCount(property(value, 'rejectedProviderCount'))
    const droppedProviderCount = safeCount(property(value, 'droppedProviderCount'))
    const media = projectClosedFamily(property(value, 'media'), projectMediaAttempt)
    const motion = projectClosedFamily(property(value, 'motion'), projectMotionInteraction)
    if (
        providerCount === null ||
        rejectedProviderCount === null ||
        droppedProviderCount === null ||
        !media ||
        !motion ||
        providerCount !== media.providerCount + motion.providerCount ||
        providerCount + rejectedProviderCount > MAX_PROVIDER_COUNT
    ) {
        return null
    }
    return Object.freeze({
        version: ANIMATION_LOCAL_EVIDENCE_VERSION,
        providerCount,
        rejectedProviderCount,
        droppedProviderCount,
        truncated: droppedProviderCount > 0 || media.truncated || motion.truncated,
        media,
        motion,
    })
}

/**
 * Projects local recorder snapshots into a bounded, pointer-free, versioned
 * view. The projection never retains provider identity, labels, selectors,
 * URLs, DOM nodes, framework objects, renderer hosts, props, or state.
 */
export function projectAnimationLocalEvidenceSnapshot(input: unknown): AnimationLocalEvidenceSnapshotV1 | null {
    try {
        const value = record(input)
        if (!value || property(value, 'version') !== ANIMATION_LOCAL_EVIDENCE_VERSION) return null
        const providers = property(value, 'providers')
        if (providers === undefined) return projectClosedSnapshot(value)
        const providerLength = arrayLength(providers)
        if (providerLength === null) return null
        const rawDroppedProviderCount = property(value, 'droppedProviderCount')
        const registryDroppedProviderCount = rawDroppedProviderCount === undefined ? 0 : safeCount(rawDroppedProviderCount)
        if (registryDroppedProviderCount === null) return null
        const media: MutableFamily<AnimationLocalMediaAttemptEvidence> = { providerCount: 0, droppedRecordCount: 0, records: [] }
        const motion: MutableFamily<AnimationLocalMotionInteractionEvidence> = { providerCount: 0, droppedRecordCount: 0, records: [] }
        const inspectedProviderCount = Math.min(providerLength, MAX_PROVIDER_COUNT)
        let rejectedProviderCount = 0
        for (let index = 0; index < inspectedProviderCount; index += 1) {
            let projected = false
            try {
                projected = projectProvider((providers as unknown[])[index], media, motion)
            } catch {
                projected = false
            }
            if (!projected) rejectedProviderCount += 1
        }
        const droppedProviderCount = addBoundedCount(registryDroppedProviderCount, providerLength - inspectedProviderCount)
        const providerCount = media.providerCount + motion.providerCount
        const mediaOutput = freezeFamily(media)
        const motionOutput = freezeFamily(motion)
        return Object.freeze({
            version: ANIMATION_LOCAL_EVIDENCE_VERSION,
            providerCount,
            rejectedProviderCount,
            droppedProviderCount,
            truncated: droppedProviderCount > 0 || mediaOutput.truncated || motionOutput.truncated,
            media: mediaOutput,
            motion: motionOutput,
        })
    } catch {
        return null
    }
}
