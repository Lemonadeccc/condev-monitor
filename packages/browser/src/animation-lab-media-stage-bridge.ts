import type { MediaSemanticAttemptRecord, MediaSemanticAttemptOutcome, MediaSemanticKind } from '@condev-monitor/monitor-sdk-animation'

const LAB_MEDIA_STAGE_BRIDGE_SYMBOL = Symbol.for('@condev-monitor/animation-lab/media-stage-evidence/v1')
const MEDIA_KINDS = new Set<MediaSemanticKind>(['image', 'video', 'canvas', 'webgl', 'webgpu', 'custom'])
const MEDIA_OUTCOMES = new Set<MediaSemanticAttemptOutcome>(['completed', 'cancelled'])
const MAX_ATTEMPT_DURATION_MS = 600_000
const MAX_TIMESTAMP_MS = 1_000_000_000_000_000
const INTRINSIC_PROMISE_THEN = Promise.prototype.then

export interface LabMediaStageEvidenceV1 {
    readonly contractVersion: 1
    readonly kind: MediaSemanticKind
    readonly outcome: MediaSemanticAttemptOutcome
    readonly startedAtMs: number
    readonly endedAtMs: number
    readonly decodeReadyAtMs: number | null
    readonly uploadReadyAtMs: number | null
    readonly firstVisibleAtMs: number | null
}

export type AnimationLabMediaAttemptSnapshot = Omit<LabMediaStageEvidenceV1, 'contractVersion'>

let publishing = false

function recordLike(value: unknown): value is Record<string, unknown> {
    try {
        return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    } catch {
        return false
    }
}

function timestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIMESTAMP_MS ? value : null
}

function stageTimestamp(value: unknown): number | null | undefined {
    if (value === null) return null
    if (!recordLike(value)) return undefined
    try {
        return timestamp(value.timestampMs) ?? undefined
    } catch {
        return undefined
    }
}

/** Reads each caller-controlled field once before the Lab bridge consumes it. */
export function snapshotAnimationLabMediaAttempt(record: MediaSemanticAttemptRecord): Readonly<AnimationLabMediaAttemptSnapshot> | null {
    if (!recordLike(record)) return null
    try {
        const raw = record as unknown as Record<string, unknown>
        const kind = raw.kind
        const outcome = raw.outcome
        const startedAtMs = raw.startedAt
        const endedAtMs = raw.endedAt
        const decodeReadyAtMs = stageTimestamp(raw.decodeReady)
        const uploadReadyAtMs = stageTimestamp(raw.uploadReady)
        const firstVisibleAtMs = stageTimestamp(raw.firstVisible)
        return Object.freeze({
            kind,
            outcome,
            startedAtMs,
            endedAtMs,
            decodeReadyAtMs,
            uploadReadyAtMs,
            firstVisibleAtMs,
        }) as Readonly<AnimationLabMediaAttemptSnapshot>
    } catch {
        return null
    }
}

function normalizedEvidence(record: Readonly<AnimationLabMediaAttemptSnapshot>): Readonly<LabMediaStageEvidenceV1> | null {
    try {
        const kind = record.kind
        const outcome = record.outcome
        const startedAtMs = timestamp(record.startedAtMs)
        const endedAtMs = timestamp(record.endedAtMs)
        const decodeReadyAtMs = record.decodeReadyAtMs
        const uploadReadyAtMs = record.uploadReadyAtMs
        const firstVisibleAtMs = record.firstVisibleAtMs
        if (
            !MEDIA_KINDS.has(kind) ||
            !MEDIA_OUTCOMES.has(outcome) ||
            startedAtMs === null ||
            endedAtMs === null ||
            endedAtMs < startedAtMs ||
            endedAtMs - startedAtMs > MAX_ATTEMPT_DURATION_MS ||
            decodeReadyAtMs === undefined ||
            uploadReadyAtMs === undefined ||
            firstVisibleAtMs === undefined ||
            (decodeReadyAtMs !== null && (decodeReadyAtMs < startedAtMs || decodeReadyAtMs > endedAtMs)) ||
            (uploadReadyAtMs !== null && (uploadReadyAtMs < (decodeReadyAtMs ?? startedAtMs) || uploadReadyAtMs > endedAtMs)) ||
            (firstVisibleAtMs !== null &&
                (firstVisibleAtMs < (uploadReadyAtMs ?? decodeReadyAtMs ?? startedAtMs) || firstVisibleAtMs > endedAtMs)) ||
            (outcome === 'cancelled' && firstVisibleAtMs !== null)
        ) {
            return null
        }
        return Object.freeze({
            contractVersion: 1,
            kind,
            outcome,
            startedAtMs,
            endedAtMs,
            decodeReadyAtMs,
            uploadReadyAtMs,
            firstVisibleAtMs,
        })
    } catch {
        return null
    }
}

/** Local Lab evidence only. Missing or hostile bridges never affect application monitoring. */
export function publishAcceptedAnimationLabMediaAttempt(record: MediaSemanticAttemptRecord): void {
    if (publishing) return
    publishing = true
    try {
        const snapshot = snapshotAnimationLabMediaAttempt(record)
        const evidence = snapshot ? normalizedEvidence(snapshot) : null
        if (!evidence) return
        const sink = (globalThis as Record<PropertyKey, unknown>)[LAB_MEDIA_STAGE_BRIDGE_SYMBOL]
        if (typeof sink !== 'function') return
        const result = Reflect.apply(sink, undefined, [evidence])
        if (result && (typeof result === 'object' || typeof result === 'function')) {
            try {
                Reflect.apply(INTRINSIC_PROMISE_THEN, result, [undefined, () => undefined])
            } catch {
                // Ignore arbitrary thenable values; only genuine Promise rejection is observed.
            }
        }
    } catch {
        // The page-owned Lab bridge is optional and must never affect the SDK.
    } finally {
        publishing = false
    }
}

export function isPublishingAnimationLabMediaAttempt(): boolean {
    return publishing
}
