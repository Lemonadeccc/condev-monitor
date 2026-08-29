import { round } from './statistics'

export interface BrowserVideoPresentationMetadata {
    readonly mediaTime?: number
    readonly presentedFrames?: number
    readonly expectedDisplayTime?: number
    readonly processingDuration?: number
}

export interface BrowserVideoPresentationRecord {
    readonly callbackAt: number
    readonly callbackIntervalMs: number | null
    readonly mediaTimeDeltaMs: number | null
    readonly presentedFramesDelta: number | null
    readonly expectedDisplayDeltaMs: number | null
    readonly processingDurationMs: number | null
}

export interface BrowserVideoPresentationSnapshot {
    readonly schemaVersion: 1
    readonly evidenceKind: 'browser-video-presentation-callback'
    readonly proves: 'browser-callback-and-metadata'
    readonly state: 'idle' | 'active' | 'stopped' | 'disposed'
    readonly startedAt: number | null
    readonly firstCallbackAt: number | null
    readonly startToFirstCallbackMs: number | null
    readonly acceptedRecordCount: number
    readonly retainedRecordCount: number
    readonly droppedRecordCount: number
    readonly rejectedRecordCount: number
    readonly truncated: boolean
    readonly window: { readonly startedAt: number; readonly endedAt: number } | null
    readonly records: readonly BrowserVideoPresentationRecord[]
}

export interface BrowserVideoPresentationRecorder {
    start(): boolean
    observe(callbackNowMs: number, metadata: BrowserVideoPresentationMetadata): boolean
    resetBaseline(): void
    stop(): void
    snapshot(window?: { readonly startedAt: number; readonly endedAt: number }): BrowserVideoPresentationSnapshot
    dispose(): void
}

export interface BrowserVideoPresentationRecorderOptions {
    readonly maxRecords?: number
    readonly now?: () => number
}

const MAX_DURATION_MS = 600_000
const MAX_TIMESTAMP_MS = 1_000_000_000_000_000
const MAX_COUNT = 1_000_000_000
const MAX_RECORDS = 256

interface EvidenceWindow {
    readonly startedAt: number
    readonly endedAt: number
}

function defaultNow(): number {
    return globalThis.performance?.now?.() ?? Date.now()
}

function finite(value: unknown, maximum = MAX_TIMESTAMP_MS): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null
}

function count(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT ? value : null
}

function evidenceWindow(value: unknown): EvidenceWindow | null {
    if (!value || typeof value !== 'object') return null
    const candidate = value as Record<string, unknown>
    const startedAt = finite(candidate.startedAt)
    const endedAt = finite(candidate.endedAt)
    if (startedAt === null || endedAt === null || endedAt < startedAt) return null
    return { startedAt, endedAt }
}

type ReadResult<T> = { ok: true; value: T } | { ok: false }

function safeRead<T>(read: () => T): ReadResult<T> {
    try {
        return { ok: true, value: read() }
    } catch {
        return { ok: false }
    }
}

interface Baseline {
    callbackAt: number
    mediaTimeMs: number | null
    presentedFrames: number | null
}

function projectRecord(input: unknown): BrowserVideoPresentationRecord | null {
    try {
        if (!input || typeof input !== 'object') return null
        const value = input as Record<string, unknown>
        const callbackAt = finite(value.callbackAt)
        const nullable = (candidate: unknown, maximum: number): number | null | undefined =>
            candidate === null ? null : (finite(candidate, maximum) ?? undefined)
        const callbackIntervalMs = nullable(value.callbackIntervalMs, MAX_DURATION_MS)
        const mediaTimeDeltaMs = nullable(value.mediaTimeDeltaMs, MAX_DURATION_MS)
        const presentedFramesDelta = value.presentedFramesDelta === null ? null : (count(value.presentedFramesDelta) ?? undefined)
        const expectedDisplayDeltaMs =
            value.expectedDisplayDeltaMs === null
                ? null
                : typeof value.expectedDisplayDeltaMs === 'number' &&
                    Number.isFinite(value.expectedDisplayDeltaMs) &&
                    Math.abs(value.expectedDisplayDeltaMs) <= MAX_DURATION_MS
                  ? value.expectedDisplayDeltaMs
                  : undefined
        const processingDurationMs = nullable(value.processingDurationMs, MAX_DURATION_MS)
        if (
            callbackAt === null ||
            callbackIntervalMs === undefined ||
            mediaTimeDeltaMs === undefined ||
            presentedFramesDelta === undefined ||
            expectedDisplayDeltaMs === undefined ||
            processingDurationMs === undefined
        ) {
            return null
        }
        return Object.freeze({
            callbackAt: round(callbackAt),
            callbackIntervalMs: callbackIntervalMs === null ? null : round(callbackIntervalMs),
            mediaTimeDeltaMs: mediaTimeDeltaMs === null ? null : round(mediaTimeDeltaMs),
            presentedFramesDelta,
            expectedDisplayDeltaMs: expectedDisplayDeltaMs === null ? null : round(expectedDisplayDeltaMs),
            processingDurationMs: processingDurationMs === null ? null : round(processingDurationMs),
        })
    } catch {
        return null
    }
}

/** Revalidates local adapter evidence and clips records to the SDK-owned selection/interaction window. */
export function projectBrowserVideoPresentationSnapshot(
    input: unknown,
    requiredWindow: { readonly startedAt: number; readonly endedAt: number }
): BrowserVideoPresentationSnapshot | null {
    try {
        const boundedWindow = evidenceWindow(requiredWindow)
        if (!boundedWindow) return null
        if (!input || typeof input !== 'object') return null
        const value = input as Record<string, unknown>
        if (
            value.schemaVersion !== 1 ||
            value.evidenceKind !== 'browser-video-presentation-callback' ||
            value.proves !== 'browser-callback-and-metadata' ||
            !Array.isArray(value.records)
        ) {
            return null
        }
        const states = new Set(['idle', 'active', 'stopped', 'disposed'])
        if (!states.has(value.state as string)) return null
        const acceptedRecordCount = count(value.acceptedRecordCount)
        const droppedRecordCount = count(value.droppedRecordCount)
        const rejectedRecordCount = count(value.rejectedRecordCount)
        if (acceptedRecordCount === null || droppedRecordCount === null || rejectedRecordCount === null) return null
        const records: BrowserVideoPresentationRecord[] = []
        for (const raw of value.records.slice(-MAX_RECORDS)) {
            const record = projectRecord(raw)
            if (!record) return null
            if (record.callbackAt >= boundedWindow.startedAt && record.callbackAt <= boundedWindow.endedAt) records.push(record)
        }
        const startedAt = value.startedAt === null ? null : finite(value.startedAt)
        const firstCallbackAt = value.firstCallbackAt === null ? null : finite(value.firstCallbackAt)
        const startToFirstCallbackMs = value.startToFirstCallbackMs === null ? null : finite(value.startToFirstCallbackMs, MAX_DURATION_MS)
        if (
            (value.startedAt !== null && startedAt === null) ||
            (value.firstCallbackAt !== null && firstCallbackAt === null) ||
            (value.startToFirstCallbackMs !== null && startToFirstCallbackMs === null)
        ) {
            return null
        }
        return Object.freeze({
            schemaVersion: 1,
            evidenceKind: 'browser-video-presentation-callback',
            proves: 'browser-callback-and-metadata',
            state: value.state as BrowserVideoPresentationSnapshot['state'],
            startedAt,
            firstCallbackAt,
            startToFirstCallbackMs,
            acceptedRecordCount,
            retainedRecordCount: records.length,
            droppedRecordCount,
            rejectedRecordCount,
            truncated: droppedRecordCount > 0 || value.records.length > records.length,
            window: Object.freeze({ startedAt: round(boundedWindow.startedAt), endedAt: round(boundedWindow.endedAt) }),
            records: Object.freeze(records),
        })
    } catch {
        return null
    }
}

export function createBrowserVideoPresentationRecorder(
    options: BrowserVideoPresentationRecorderOptions = {}
): BrowserVideoPresentationRecorder {
    const now = options.now ?? defaultNow
    const requestedCapacity = options.maxRecords ?? 64
    const capacity =
        typeof requestedCapacity === 'number' && Number.isFinite(requestedCapacity)
            ? Math.max(1, Math.min(MAX_RECORDS, Math.floor(requestedCapacity)))
            : 64
    const records: BrowserVideoPresentationRecord[] = []
    let state: BrowserVideoPresentationSnapshot['state'] = 'idle'
    let startedAt: number | null = null
    let firstCallbackAt: number | null = null
    let baseline: Baseline | null = null
    let acceptedRecordCount = 0
    let droppedRecordCount = 0
    let rejectedRecordCount = 0

    return {
        start(): boolean {
            if (state === 'disposed' || state === 'active') return false
            const current = safeRead(() => now())
            const started = current.ok ? finite(current.value) : null
            if (started === null) return false
            state = 'active'
            startedAt ??= started
            baseline = null
            return true
        },
        observe(callbackNowMs, metadata): boolean {
            if (state !== 'active' || !metadata || typeof metadata !== 'object') return false
            const callbackAt = finite(callbackNowMs)
            const mediaTimeRead = safeRead(() => metadata.mediaTime)
            const presentedFramesRead = safeRead(() => metadata.presentedFrames)
            const expectedDisplayTimeRead = safeRead(() => metadata.expectedDisplayTime)
            const processingDurationRead = safeRead(() => metadata.processingDuration)
            if (
                callbackAt === null ||
                !mediaTimeRead.ok ||
                !presentedFramesRead.ok ||
                !expectedDisplayTimeRead.ok ||
                !processingDurationRead.ok
            ) {
                rejectedRecordCount = Math.min(MAX_COUNT, rejectedRecordCount + 1)
                return false
            }
            const mediaTimeMs = mediaTimeRead.value === undefined ? null : finite(mediaTimeRead.value, MAX_TIMESTAMP_MS / 1_000)
            const presentedFrames = presentedFramesRead.value === undefined ? null : count(presentedFramesRead.value)
            const expectedDisplayTime = expectedDisplayTimeRead.value === undefined ? null : finite(expectedDisplayTimeRead.value)
            const processingDurationMs =
                processingDurationRead.value === undefined ? null : finite(processingDurationRead.value, MAX_DURATION_MS / 1_000)
            if (
                (mediaTimeRead.value !== undefined && mediaTimeMs === null) ||
                (presentedFramesRead.value !== undefined && presentedFrames === null) ||
                (expectedDisplayTimeRead.value !== undefined && expectedDisplayTime === null) ||
                (processingDurationRead.value !== undefined && processingDurationMs === null)
            ) {
                rejectedRecordCount = Math.min(MAX_COUNT, rejectedRecordCount + 1)
                return false
            }
            const normalizedMediaTimeMs = mediaTimeMs === null ? null : mediaTimeMs * 1_000
            const normalizedProcessingDurationMs = processingDurationMs === null ? null : processingDurationMs * 1_000
            const reset =
                baseline !== null &&
                (callbackAt < baseline.callbackAt ||
                    (normalizedMediaTimeMs !== null && baseline.mediaTimeMs !== null && normalizedMediaTimeMs < baseline.mediaTimeMs) ||
                    (presentedFrames !== null && baseline.presentedFrames !== null && presentedFrames < baseline.presentedFrames))
            const previous = reset ? null : baseline
            const callbackIntervalMs = previous ? callbackAt - previous.callbackAt : null
            const mediaTimeDeltaMs =
                previous && normalizedMediaTimeMs !== null && previous.mediaTimeMs !== null
                    ? normalizedMediaTimeMs - previous.mediaTimeMs
                    : null
            const presentedFramesDelta =
                previous && presentedFrames !== null && previous.presentedFrames !== null
                    ? presentedFrames - previous.presentedFrames
                    : null
            const expectedDisplayDeltaMs = expectedDisplayTime === null ? null : expectedDisplayTime - callbackAt
            if (
                (callbackIntervalMs !== null && (callbackIntervalMs <= 0 || callbackIntervalMs > MAX_DURATION_MS)) ||
                (mediaTimeDeltaMs !== null && (mediaTimeDeltaMs < 0 || mediaTimeDeltaMs > MAX_DURATION_MS)) ||
                (presentedFramesDelta !== null && (presentedFramesDelta < 0 || presentedFramesDelta > MAX_COUNT)) ||
                (expectedDisplayDeltaMs !== null && Math.abs(expectedDisplayDeltaMs) > MAX_DURATION_MS)
            ) {
                baseline = { callbackAt, mediaTimeMs: normalizedMediaTimeMs, presentedFrames }
                rejectedRecordCount = Math.min(MAX_COUNT, rejectedRecordCount + 1)
                return false
            }
            firstCallbackAt ??= callbackAt
            baseline = { callbackAt, mediaTimeMs: normalizedMediaTimeMs, presentedFrames }
            records.push(
                Object.freeze({
                    callbackAt: round(callbackAt),
                    callbackIntervalMs: callbackIntervalMs === null ? null : round(callbackIntervalMs),
                    mediaTimeDeltaMs: mediaTimeDeltaMs === null ? null : round(mediaTimeDeltaMs),
                    presentedFramesDelta,
                    expectedDisplayDeltaMs: expectedDisplayDeltaMs === null ? null : round(expectedDisplayDeltaMs),
                    processingDurationMs: normalizedProcessingDurationMs === null ? null : round(normalizedProcessingDurationMs),
                })
            )
            acceptedRecordCount = Math.min(MAX_COUNT, acceptedRecordCount + 1)
            if (records.length > capacity) {
                records.shift()
                droppedRecordCount = Math.min(MAX_COUNT, droppedRecordCount + 1)
            }
            return true
        },
        resetBaseline(): void {
            baseline = null
        },
        stop(): void {
            if (state === 'active') state = 'stopped'
            baseline = null
        },
        snapshot(window): BrowserVideoPresentationSnapshot {
            const boundedWindow = window === undefined ? undefined : evidenceWindow(window)
            const retained =
                window === undefined
                    ? [...records]
                    : boundedWindow
                      ? records.filter(record => record.callbackAt >= boundedWindow.startedAt && record.callbackAt <= boundedWindow.endedAt)
                      : []
            const startToFirstCallbackMs =
                startedAt === null || firstCallbackAt === null || firstCallbackAt < startedAt ? null : round(firstCallbackAt - startedAt)
            return Object.freeze({
                schemaVersion: 1,
                evidenceKind: 'browser-video-presentation-callback',
                proves: 'browser-callback-and-metadata',
                state,
                startedAt: startedAt === null ? null : round(startedAt),
                firstCallbackAt: firstCallbackAt === null ? null : round(firstCallbackAt),
                startToFirstCallbackMs,
                acceptedRecordCount,
                retainedRecordCount: retained.length,
                droppedRecordCount,
                rejectedRecordCount,
                truncated: droppedRecordCount > 0 || retained.length < records.length,
                window: boundedWindow
                    ? Object.freeze({ startedAt: round(boundedWindow.startedAt), endedAt: round(boundedWindow.endedAt) })
                    : retained.length > 0
                      ? Object.freeze({ startedAt: retained[0]!.callbackAt, endedAt: retained.at(-1)!.callbackAt })
                      : null,
                records: Object.freeze([...retained]),
            })
        },
        dispose(): void {
            if (state === 'disposed') return
            state = 'disposed'
            baseline = null
        },
    }
}
