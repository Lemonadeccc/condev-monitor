import type { MediaSemanticAttemptRecord } from '../media-semantics'
import { BoundedRing, durationStatistics, round } from '../statistics'
import type { AnimationRumV2MediaStageKind, AnimationRumV2MediaStageKindAggregate, AnimationRumV2MediaStageSource } from './types'

interface RetainedMediaStageAttempt {
    kind: AnimationRumV2MediaStageKind
    firstVisible: boolean
    beginToDecodeMs: number | null
    decodeToUploadMs: number | null
    uploadToFirstVisibleMs: number | null
    beginToFirstVisibleMs: number | null
    incomplete: boolean
}

export interface AnimationRumV2MediaStageRegistry {
    markInstrumented(): void
    record(record: Readonly<MediaSemanticAttemptRecord>): boolean
    snapshot(): AnimationRumV2MediaStageSource
}

const MEDIA_STAGE_KINDS = new Set<AnimationRumV2MediaStageKind>(['image', 'video', 'canvas', 'webgl', 'webgpu'])
const MAX_COUNT = 1_000_000_000
const MAX_DURATION_MS = 600_000
const MAX_TIMESTAMP_MS = 1_000_000_000_000_000

function boundedCapacity(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? Math.min(1_024, value) : 256
}

function finiteTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIMESTAMP_MS ? value : null
}

function orderedDuration(start: number | null, end: number | null): number | null {
    if (start === null || end === null || end < start || end - start > MAX_DURATION_MS) return null
    return round(end - start)
}

function stageTimestamp(value: unknown, startedAt: number, endedAt: number): number | null {
    if (value === null) return null
    if (typeof value !== 'object' || value === null) return Number.NaN
    try {
        const timestamp = finiteTimestamp((value as { timestampMs?: unknown }).timestampMs)
        return timestamp !== null && timestamp >= startedAt && timestamp <= endedAt ? timestamp : Number.NaN
    } catch {
        return Number.NaN
    }
}

function projectAttempt(record: Readonly<MediaSemanticAttemptRecord>): RetainedMediaStageAttempt | 'ignored' | null {
    try {
        if (record.kind === 'custom') return 'ignored'
        if (!MEDIA_STAGE_KINDS.has(record.kind as AnimationRumV2MediaStageKind)) return null
        if (record.outcome !== 'completed' && record.outcome !== 'cancelled') return null
        const startedAt = finiteTimestamp(record.startedAt)
        const endedAt = finiteTimestamp(record.endedAt)
        if (startedAt === null || endedAt === null || endedAt < startedAt || endedAt - startedAt > MAX_DURATION_MS) return null
        const decodeReadyAt = stageTimestamp(record.decodeReady, startedAt, endedAt)
        const uploadReadyAt = stageTimestamp(record.uploadReady, startedAt, endedAt)
        const firstVisibleAt = record.outcome === 'completed' ? stageTimestamp(record.firstVisible, startedAt, endedAt) : null
        if ([decodeReadyAt, uploadReadyAt, firstVisibleAt].some(value => Number.isNaN(value))) return null
        if (
            (decodeReadyAt !== null && uploadReadyAt !== null && uploadReadyAt < decodeReadyAt) ||
            (uploadReadyAt !== null && firstVisibleAt !== null && firstVisibleAt < uploadReadyAt) ||
            (decodeReadyAt !== null && firstVisibleAt !== null && firstVisibleAt < decodeReadyAt)
        ) {
            return null
        }
        const beginToDecodeMs = orderedDuration(startedAt, decodeReadyAt)
        const decodeToUploadMs = orderedDuration(decodeReadyAt, uploadReadyAt)
        const uploadToFirstVisibleMs = orderedDuration(uploadReadyAt, firstVisibleAt)
        const beginToFirstVisibleMs = orderedDuration(startedAt, firstVisibleAt)
        return Object.freeze({
            kind: record.kind as AnimationRumV2MediaStageKind,
            firstVisible: firstVisibleAt !== null,
            beginToDecodeMs,
            decodeToUploadMs,
            uploadToFirstVisibleMs,
            beginToFirstVisibleMs,
            incomplete:
                record.outcome !== 'completed' ||
                beginToDecodeMs === null ||
                decodeToUploadMs === null ||
                uploadToFirstVisibleMs === null ||
                beginToFirstVisibleMs === null,
        })
    } catch {
        return null
    }
}

function kindAggregate(
    attempts: readonly RetainedMediaStageAttempt[],
    kind: AnimationRumV2MediaStageKind
): AnimationRumV2MediaStageKindAggregate {
    const selected = attempts.filter(attempt => attempt.kind === kind)
    const values = (
        key: keyof Pick<
            RetainedMediaStageAttempt,
            'beginToDecodeMs' | 'decodeToUploadMs' | 'uploadToFirstVisibleMs' | 'beginToFirstVisibleMs'
        >
    ) =>
        selected.flatMap(attempt => {
            const value = attempt[key]
            return value === null ? [] : [value]
        })
    return Object.freeze({
        attemptCount: selected.length,
        firstVisibleCount: selected.filter(attempt => attempt.firstVisible).length,
        beginToDecodeMs: durationStatistics(values('beginToDecodeMs')),
        decodeToUploadMs: durationStatistics(values('decodeToUploadMs')),
        uploadToFirstVisibleMs: durationStatistics(values('uploadToFirstVisibleMs')),
        beginToFirstVisibleMs: durationStatistics(values('beginToFirstVisibleMs')),
    })
}

/** Independent production projection registry. It never reads the local overlay registry or retains media identity. */
export function createAnimationRumV2MediaStageRegistry(options: { capacity?: number } = {}): AnimationRumV2MediaStageRegistry {
    const attempts = new BoundedRing<RetainedMediaStageAttempt>(boundedCapacity(options.capacity))
    let instrumented = false
    let invalidAttemptCount = 0

    return {
        markInstrumented(): void {
            instrumented = true
        },
        record(record): boolean {
            const projected = projectAttempt(record)
            if (projected === 'ignored') return false
            if (!projected) {
                invalidAttemptCount = Math.min(MAX_COUNT, invalidAttemptCount + 1)
                return false
            }
            instrumented = true
            attempts.push(projected)
            return true
        },
        snapshot(): AnimationRumV2MediaStageSource {
            const retained = attempts.toArray()
            const incomplete = retained.filter(attempt => attempt.incomplete).length
            return Object.freeze({
                instrumented,
                acceptedAttemptCount: attempts.totalCount,
                retainedAttemptCount: attempts.retainedCount,
                droppedAttemptCount: attempts.droppedCount,
                rejectedAttemptCount: Math.min(MAX_COUNT, invalidAttemptCount + incomplete),
                truncated: attempts.droppedCount > 0,
                kinds: Object.freeze({
                    image: kindAggregate(retained, 'image'),
                    video: kindAggregate(retained, 'video'),
                    canvas: kindAggregate(retained, 'canvas'),
                    webgl: kindAggregate(retained, 'webgl'),
                    webgpu: kindAggregate(retained, 'webgpu'),
                }),
            })
        },
    }
}
