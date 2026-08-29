import { BoundedRing, round } from './statistics'

export type MediaSemanticKind = 'image' | 'video' | 'canvas' | 'webgl' | 'webgpu' | 'custom'
export type MediaSemanticStageKind = 'decode-ready' | 'upload-ready' | 'first-visible'
export type MediaSemanticAttemptOutcome = 'completed' | 'cancelled'

export interface MediaSemanticStageInput {
    timestampMs: number
    durationMs?: number
    byteCount?: number
    itemCount?: number
}

export interface MediaSemanticStageRecord {
    stage: MediaSemanticStageKind
    timestampMs: number
    elapsedMs: number
    durationMs: number | null
    byteCount: number | null
    itemCount: number | null
}

export interface MediaSemanticAttemptRecord {
    attemptId: number
    kind: MediaSemanticKind
    outcome: MediaSemanticAttemptOutcome
    startedAt: number
    endedAt: number
    durationMs: number
    decodeReady: MediaSemanticStageRecord | null
    uploadReady: MediaSemanticStageRecord | null
    /** Always null for cancelled attempts, even if visibility was declared before cancellation. */
    firstVisible: MediaSemanticStageRecord | null
}

export interface MediaSemanticAttemptHandle {
    readonly attemptId: number
    readonly kind: MediaSemanticKind
    readonly status: 'active' | MediaSemanticAttemptOutcome
    decodeReady(input: MediaSemanticStageInput): boolean
    uploadReady(input: MediaSemanticStageInput): boolean
    firstVisible(input: MediaSemanticStageInput): boolean
    end(timestampMs: number): MediaSemanticAttemptRecord
    cancel(timestampMs: number): MediaSemanticAttemptRecord
}

export interface MediaSemanticStageRecorderSnapshot {
    status: 'active' | 'disposed'
    capacity: number
    maximumActiveAttempts: number
    begunAttemptCount: number
    retainedAttemptCount: number
    droppedAttemptCount: number
    activeAttemptCount: number
    completedAttemptCount: number
    cancelledAttemptCount: number
    truncated: boolean
    attempts: readonly MediaSemanticAttemptRecord[]
}

export interface MediaSemanticStageRecorder {
    begin(kind: MediaSemanticKind, startedAt: number): MediaSemanticAttemptHandle
    snapshot(): MediaSemanticStageRecorderSnapshot
    /** Cancels open monitoring attempts only; it never touches or controls media/renderer hosts. */
    dispose(): void
}

export interface MediaSemanticStageRecorderOptions {
    /** Bounded completed-attempt tail. Defaults to 64 and is capped at 1,024. */
    capacity?: number
    /** Maximum simultaneously open attempts. Defaults to 32 and is capped at 512. */
    maximumActiveAttempts?: number
}

/** Optional observer for closed, immutable attempts. Observer failures never affect recorder state. */
export interface MediaSemanticStageRecorderObserver {
    onAttemptSettled(record: Readonly<MediaSemanticAttemptRecord>): void
}

interface AttemptController {
    recordStage(stage: MediaSemanticStageKind, input: MediaSemanticStageInput): boolean
    settle(outcome: MediaSemanticAttemptOutcome, timestampMs: number): Readonly<MediaSemanticAttemptRecord>
    cancelFromDispose(): void
}

interface HandleState {
    controller: AttemptController | null
    result: Readonly<MediaSemanticAttemptRecord> | null
}

const MAX_COUNT = 1_000_000_000
const MAX_BYTES = 1_000_000_000_000
const MAX_DURATION_MS = 600_000
const MAX_TIMESTAMP_MS = 1_000_000_000_000_000
const MEDIA_KINDS = new Set<MediaSemanticKind>(['image', 'video', 'canvas', 'webgl', 'webgpu', 'custom'])
const STAGE_RANK: Readonly<Record<MediaSemanticStageKind, number>> = Object.freeze({
    'decode-ready': 1,
    'upload-ready': 2,
    'first-visible': 3,
})

function boundedCapacity(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? Math.min(1_024, value) : 64
}

function boundedMaximumActiveAttempts(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? Math.min(512, value) : 32
}

function finiteNonNegative(value: unknown, maximum: number): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? round(value) : null
}

function optionalSafeCount(value: unknown, maximum: number): number | null | undefined {
    if (value === undefined) return null
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined
}

function projectStage(
    stage: MediaSemanticStageKind,
    input: unknown,
    startedAt: number,
    minimumTimestamp: number
): Readonly<MediaSemanticStageRecord> | null {
    if (typeof input !== 'object' || input === null) return null
    try {
        const value = input as MediaSemanticStageInput
        const rawTimestampMs = value.timestampMs
        const rawDurationMs = value.durationMs
        const rawByteCount = value.byteCount
        const rawItemCount = value.itemCount
        const timestampMs = finiteNonNegative(rawTimestampMs, MAX_TIMESTAMP_MS)
        const durationMs = rawDurationMs === undefined ? null : finiteNonNegative(rawDurationMs, MAX_DURATION_MS)
        const byteCount = optionalSafeCount(rawByteCount, MAX_BYTES)
        const itemCount = optionalSafeCount(rawItemCount, MAX_COUNT)
        const elapsedMs = timestampMs === null ? null : timestampMs - startedAt
        if (
            timestampMs === null ||
            timestampMs < startedAt ||
            timestampMs < minimumTimestamp ||
            elapsedMs === null ||
            elapsedMs > MAX_DURATION_MS ||
            (durationMs === null && rawDurationMs !== undefined) ||
            (durationMs !== null && durationMs > elapsedMs) ||
            byteCount === undefined ||
            itemCount === undefined
        ) {
            return null
        }
        return Object.freeze({
            stage,
            timestampMs,
            elapsedMs: round(elapsedMs),
            durationMs,
            byteCount,
            itemCount,
        })
    } catch {
        return null
    }
}

function validTerminalTimestamp(value: unknown, startedAt: number, minimumTimestamp: number): number | null {
    const timestampMs = finiteNonNegative(value, MAX_TIMESTAMP_MS)
    if (timestampMs === null || timestampMs < startedAt || timestampMs < minimumTimestamp) return null
    return timestampMs - startedAt <= MAX_DURATION_MS ? timestampMs : null
}

/**
 * Records caller-declared media lifecycle stages as closed local evidence.
 * It never opens a collector interaction, reads or controls a media host, or
 * projects these records into a RUM contract.
 */
export function createMediaSemanticStageRecorder(
    options: MediaSemanticStageRecorderOptions = {},
    observer?: MediaSemanticStageRecorderObserver
): MediaSemanticStageRecorder {
    const capacity = boundedCapacity(options.capacity)
    const maximumActiveAttempts = boundedMaximumActiveAttempts(options.maximumActiveAttempts)
    const attempts = new BoundedRing<MediaSemanticAttemptRecord>(capacity)
    const active = new Set<AttemptController>()
    let nextAttemptId = 1
    let begunAttemptCount = 0
    let completedAttemptCount = 0
    let cancelledAttemptCount = 0
    let disposed = false

    const snapshot = (): MediaSemanticStageRecorderSnapshot =>
        Object.freeze({
            status: disposed ? 'disposed' : 'active',
            capacity,
            maximumActiveAttempts,
            begunAttemptCount,
            retainedAttemptCount: attempts.retainedCount,
            droppedAttemptCount: attempts.droppedCount,
            activeAttemptCount: active.size,
            completedAttemptCount,
            cancelledAttemptCount,
            truncated: attempts.droppedCount > 0,
            attempts: Object.freeze(attempts.toArray()),
        })

    return {
        begin(kind, startedAt): MediaSemanticAttemptHandle {
            if (disposed) throw new Error('Cannot begin a media semantic attempt after recorder disposal')
            if (!MEDIA_KINDS.has(kind)) throw new TypeError(`Unsupported media semantic kind: ${String(kind)}`)
            const normalizedStartedAt = finiteNonNegative(startedAt, MAX_TIMESTAMP_MS)
            if (normalizedStartedAt === null) throw new TypeError('media semantic attempt requires a finite non-negative start timestamp')
            if (active.size >= maximumActiveAttempts) {
                throw new Error(`Cannot exceed ${maximumActiveAttempts} active media semantic attempts`)
            }

            const attemptId = nextAttemptId
            nextAttemptId = nextAttemptId >= Number.MAX_SAFE_INTEGER ? 1 : nextAttemptId + 1
            begunAttemptCount = Math.min(MAX_COUNT, begunAttemptCount + 1)
            let decodeReady: Readonly<MediaSemanticStageRecord> | null = null
            let uploadReady: Readonly<MediaSemanticStageRecord> | null = null
            let firstVisible: Readonly<MediaSemanticStageRecord> | null = null
            let highestStageRank = 0
            let latestTimestamp = normalizedStartedAt
            let settled = false
            const handleState: HandleState = { controller: null, result: null }

            const controller: AttemptController = {
                recordStage(stage, input): boolean {
                    if (settled || disposed || STAGE_RANK[stage] <= highestStageRank) return false
                    const projected = projectStage(stage, input, normalizedStartedAt, latestTimestamp)
                    // A hostile getter may synchronously dispose the recorder while projection is in progress.
                    if (!projected || settled || disposed) return false
                    if (stage === 'decode-ready') decodeReady = projected
                    else if (stage === 'upload-ready') uploadReady = projected
                    else firstVisible = projected
                    highestStageRank = STAGE_RANK[stage]
                    latestTimestamp = projected.timestampMs
                    return true
                },
                settle(outcome, timestampMs): Readonly<MediaSemanticAttemptRecord> {
                    if (handleState.result) return handleState.result
                    const endedAt = validTerminalTimestamp(timestampMs, normalizedStartedAt, latestTimestamp)
                    if (endedAt === null) throw new TypeError('media semantic attempt requires an ordered finite terminal timestamp')
                    const record = Object.freeze({
                        attemptId,
                        kind,
                        outcome,
                        startedAt: normalizedStartedAt,
                        endedAt,
                        durationMs: round(endedAt - normalizedStartedAt),
                        decodeReady,
                        uploadReady,
                        firstVisible: outcome === 'completed' ? firstVisible : null,
                    })
                    settled = true
                    attempts.push(record)
                    if (outcome === 'completed') completedAttemptCount = Math.min(MAX_COUNT, completedAttemptCount + 1)
                    else cancelledAttemptCount = Math.min(MAX_COUNT, cancelledAttemptCount + 1)
                    active.delete(controller)
                    handleState.result = record
                    handleState.controller = null
                    try {
                        observer?.onAttemptSettled(record)
                    } catch {
                        // Diagnostics observers cannot alter caller-owned media lifecycle state.
                    }
                    return record
                },
                cancelFromDispose(): void {
                    if (settled) return
                    controller.settle('cancelled', latestTimestamp)
                },
            }
            handleState.controller = controller
            active.add(controller)

            const settledResult = (): Readonly<MediaSemanticAttemptRecord> => {
                const result = handleState.result
                if (!result) throw new Error('Media semantic attempt is no longer active')
                return result
            }
            return Object.freeze({
                attemptId,
                kind,
                get status() {
                    return handleState.result?.outcome ?? 'active'
                },
                decodeReady(input: MediaSemanticStageInput): boolean {
                    return handleState.controller?.recordStage('decode-ready', input) ?? false
                },
                uploadReady(input: MediaSemanticStageInput): boolean {
                    return handleState.controller?.recordStage('upload-ready', input) ?? false
                },
                firstVisible(input: MediaSemanticStageInput): boolean {
                    return handleState.controller?.recordStage('first-visible', input) ?? false
                },
                end(timestampMs: number): MediaSemanticAttemptRecord {
                    return handleState.controller?.settle('completed', timestampMs) ?? settledResult()
                },
                cancel(timestampMs: number): MediaSemanticAttemptRecord {
                    return handleState.controller?.settle('cancelled', timestampMs) ?? settledResult()
                },
            })
        },
        snapshot,
        dispose(): void {
            if (disposed) return
            // Seal before cancellation so hostile/reentrant stage access cannot add evidence.
            disposed = true
            for (const attempt of [...active]) attempt.cancelFromDispose()
        },
    }
}
