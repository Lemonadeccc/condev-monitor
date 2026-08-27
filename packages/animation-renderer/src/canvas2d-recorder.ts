// cspell:ignore readback

const DEFAULT_MAX_RETAINED_FRAMES = 512
const MAX_RETAINED_FRAMES = 4_096
const MAX_DURATION_MS = 600_000
const MAX_CLOCK_MS = 1_000_000_000_000_000
const MAX_COUNT = 1_000_000_000
const MAX_BYTES = 1_000_000_000_000
const MAX_CONTEXT_EVENTS = 64

export type Canvas2dDrawKind = 'path' | 'text' | 'image' | 'pixel-write' | 'clear' | 'other'
export type Canvas2dRecorderCapability = 'supported' | 'disposed'

export interface Canvas2dSurfaceLike {
    readonly width: number
    readonly height: number
    addEventListener?(type: string, listener: EventListenerOrEventListenerObject): void
    removeEventListener?(type: string, listener: EventListenerOrEventListenerObject): void
}

/** Minimal structural context contract; the recorder never calls a drawing API. */
export interface Canvas2dContextLike {
    readonly canvas: Canvas2dSurfaceLike
}

export interface Canvas2dRecorderOptions {
    /** The recorder observes only this context's surface identity and dimensions. */
    context: Canvas2dContextLike
    /** Required host attestation that begin/end enclose one complete logical Canvas2D frame. */
    frameBoundary: 'complete-canvas-frame'
    /** Required before reported commands may be mapped to target drawCallsP95. */
    drawCallCoverage?: 'complete-frame'
    /** Required before the absence of Canvas2D context-loss events may be reported as measured zero. */
    contextLossEventCoverage?: 'complete-window'
    /** Number of complete numeric frame records retained locally. Default: 512; maximum: 4096. */
    maxRetainedFrames?: number
    /** Must share the target collector's clock domain. Defaults to performance.now(), then Date.now(). */
    now?: () => number
}

export interface Canvas2dDrawOperations {
    path?: number
    text?: number
    image?: number
    pixelWrite?: number
    clear?: number
    other?: number
}

export interface Canvas2dReadbackEvidence {
    pixels?: number
    bytes?: number
}

export interface Canvas2dUploadEvidence {
    pixels?: number
    bytes?: number
}

export interface Canvas2dTargetInspectionContext {
    readonly evidenceWindow: {
        readonly startedAt: number
        readonly endedAt: number
        readonly relation: 'selection-window' | 'interaction-window'
    }
}

export interface Canvas2dTargetRendererInspection {
    family: 'canvas2d'
    capability: {
        state: 'supported' | 'unknown'
        observed: boolean
        buffered: false
        reason?: string
    }
    metrics?: {
        cpuFrameMsP95?: number
        drawCallsP95?: number
        uploadBytes?: number
        readbackMsP95?: number
        contextLossCount?: number
    }
    evidence?: {
        window: { startedAt: number; endedAt: number }
        acceptedSampleCount: number
        retainedSampleCount: number
        droppedSampleCount: number
        truncated: boolean
    }
}

export interface Canvas2dTargetAdapterInspection {
    inventory: { renderers: readonly ['canvas2d'] }
    owners: readonly [{ relation: 'renderer-host'; label: 'Condev Canvas2D recorder' }]
    renderer: Canvas2dTargetRendererInspection
}

export interface Canvas2dRendererHostReading {
    gpuTimerCapability: 'unsupported'
    gpu: null
    drawCalls: number
}

export interface Canvas2dRecorderAggregate {
    cpuFrameMsP95: number | null
    drawCommandsP95: number | null
    pathCommandsP95: number | null
    textCommandsP95: number | null
    imageCommandsP95: number | null
    pixelWriteCommandsP95: number | null
    clearCommandsP95: number | null
    otherCommandsP95: number | null
    readbackMsP95: number | null
    uploadMsP95: number | null
    readbackPixels: number | null
    readbackBytes: number | null
    uploadPixels: number | null
    uploadBytes: number | null
}

export interface Canvas2dRecorderSnapshot {
    backend: 'canvas2d'
    capability: Canvas2dRecorderCapability
    supported: boolean
    active: boolean
    capacity: number
    acceptedFrameCount: number
    retainedFrameCount: number
    droppedFrameCount: number
    rejectedFrameCount: number
    cancelledFrameCount: number
    rejectedOperationCount: number
    measuredReadbackCount: number
    measuredUploadCount: number
    backingResizeCount: number
    backingWidth: number | null
    backingHeight: number | null
    /** True only after explicit coverage attestation or an observed context event proves delivery. */
    contextLossEventCapability: boolean
    contextLossCount: number
    contextRestoreCount: number
    hostReadingBuffered: boolean
    droppedHostReadingCount: number
    clockErrorCount: number
    contextErrorCount: number
    aggregate: Canvas2dRecorderAggregate
}

export interface Canvas2dRecorder {
    readonly backend: 'canvas2d'
    readonly supported: boolean
    /** Begins one caller-owned complete logical frame. Nested frames are rejected. */
    beginFrame(): boolean
    /** Records one closed Canvas2D command family while a frame is active. */
    recordDraw(kind: Canvas2dDrawKind, count?: number): boolean
    /** Adds already-known command counts without reading or wrapping the context. */
    recordOperations(operations: Canvas2dDrawOperations): boolean
    /** Times one synchronous, explicitly wrapped readback and preserves its exact result/error. */
    measureReadback<T>(evidence: Canvas2dReadbackEvidence, operation: () => T): T
    /** Times one synchronous, explicitly wrapped upload and preserves its exact result/error. */
    measureUpload<T>(evidence: Canvas2dUploadEvidence, operation: () => T): T
    /** Completes the active logical frame. */
    endFrame(): boolean
    /** Discards the active frame without manufacturing a sample. */
    cancelFrame(): boolean
    /** Consumes at most one complete draw reading for the generic page renderer probe. */
    takeRendererHostReading(): Canvas2dRendererHostReading | null
    /** Produces a renderer-only inspection for an SDK-owned evidence window. */
    inspectWindow(window: Canvas2dTargetInspectionContext['evidenceWindow']): Canvas2dTargetRendererInspection
    /** Bound callback for Browser animation.registerTarget() or a target adapter registry. */
    inspect(context?: Canvas2dTargetInspectionContext): Canvas2dTargetAdapterInspection
    getSnapshot(): Canvas2dRecorderSnapshot
    dispose(): void
}

export class Canvas2dRecorderOptionsError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'Canvas2dRecorderOptionsError'
    }
}

interface BackingSize {
    width: number
    height: number
}

interface DrawCounts {
    path: number
    text: number
    image: number
    pixelWrite: number
    clear: number
    other: number
}

interface ActiveFrame {
    startedAt: number
    drawValid: boolean
    draws: DrawCounts
    readbackAttempted: boolean
    readbackValid: boolean
    readbackMs: number
    readbackPixels: number
    readbackPixelsComplete: boolean
    readbackBytes: number
    readbackBytesComplete: boolean
    uploadAttempted: boolean
    uploadValid: boolean
    uploadMs: number
    uploadPixels: number
    uploadPixelsComplete: boolean
    uploadBytes: number
    uploadBytesComplete: boolean
    backingResizeCount: number
}

interface CompletedFrame extends ActiveFrame {
    endedAt: number
    cpuFrameMs: number
}

interface ContextEventRecord {
    type: 'lost' | 'restored'
    timestamp: number
}

class BoundedRing<T> {
    private readonly values: Array<T | undefined>
    private cursor = 0
    private length = 0
    private total = 0
    private totalExact = true

    constructor(readonly capacity: number) {
        this.values = new Array<T | undefined>(capacity)
    }

    push(value: T): T | undefined {
        const evicted = this.length === this.capacity ? this.values[this.cursor] : undefined
        this.values[this.cursor] = value
        this.cursor = (this.cursor + 1) % this.capacity
        this.length = Math.min(this.length + 1, this.capacity)
        if (this.total >= MAX_COUNT) this.totalExact = false
        else this.total += 1
        return evicted
    }

    toArray(): T[] {
        const result: T[] = []
        const start = this.length === this.capacity ? this.cursor : 0
        for (let index = 0; index < this.length; index += 1) {
            const value = this.values[(start + index) % this.capacity]
            if (value !== undefined) result.push(value)
        }
        return result
    }

    clear(): void {
        this.values.fill(undefined)
        this.cursor = 0
        this.length = 0
    }

    get retainedCount(): number {
        return this.length
    }

    get totalCount(): number {
        return this.total
    }

    get hasExactTotalCount(): boolean {
        return this.totalExact
    }
}

const DRAW_KEYS: Record<Canvas2dDrawKind, keyof DrawCounts> = {
    path: 'path',
    text: 'text',
    image: 'image',
    'pixel-write': 'pixelWrite',
    clear: 'clear',
    other: 'other',
}

function increment(value: number): number {
    return value >= MAX_COUNT ? MAX_COUNT : value + 1
}

function isObject(value: unknown): value is object {
    return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function boundedInteger(value: unknown, maximum: number): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null
}

function boundedTime(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_CLOCK_MS ? value : null
}

function addBounded(current: number, value: number, maximum: number): number | null {
    const next = current + value
    return Number.isFinite(next) && next >= 0 && next <= maximum ? next : null
}

function round(value: number): number {
    return Math.round(value * 1_000) / 1_000
}

function percentile95(values: readonly number[]): number | null {
    if (values.length === 0) return null
    const sorted = [...values].sort((left, right) => left - right)
    if (sorted.length === 1) return round(sorted[0] ?? 0)
    const rank = (sorted.length - 1) * 0.95
    const lowerIndex = Math.floor(rank)
    const upperIndex = Math.ceil(rank)
    const lower = sorted[lowerIndex] ?? 0
    const upper = sorted[upperIndex] ?? lower
    return round(lower + (upper - lower) * (rank - lowerIndex))
}

function sumBounded(values: readonly number[], maximum: number): number | null {
    let total = 0
    for (const value of values) {
        const next = addBounded(total, value, maximum)
        if (next === null) return null
        total = next
    }
    return total
}

function drawTotal(draws: DrawCounts): number | null {
    return sumBounded([draws.path, draws.text, draws.image, draws.pixelWrite, draws.clear, draws.other], MAX_COUNT)
}

function emptyDrawCounts(): DrawCounts {
    return { path: 0, text: 0, image: 0, pixelWrite: 0, clear: 0, other: 0 }
}

function emptyAggregate(): Canvas2dRecorderAggregate {
    return {
        cpuFrameMsP95: null,
        drawCommandsP95: null,
        pathCommandsP95: null,
        textCommandsP95: null,
        imageCommandsP95: null,
        pixelWriteCommandsP95: null,
        clearCommandsP95: null,
        otherCommandsP95: null,
        readbackMsP95: null,
        uploadMsP95: null,
        readbackPixels: null,
        readbackBytes: null,
        uploadPixels: null,
        uploadBytes: null,
    }
}

function aggregateFrames(frames: readonly CompletedFrame[], completeDrawCoverage: boolean): Canvas2dRecorderAggregate {
    if (frames.length === 0) return emptyAggregate()
    const drawsValid = completeDrawCoverage && frames.every(frame => frame.drawValid)
    const readbacks = frames.filter(frame => frame.readbackAttempted)
    const uploads = frames.filter(frame => frame.uploadAttempted)
    const readbacksValid = readbacks.length > 0 && readbacks.every(frame => frame.readbackValid)
    const uploadsValid = uploads.length > 0 && uploads.every(frame => frame.uploadValid)
    const readbackPixelsComplete = readbacksValid && readbacks.every(frame => frame.readbackPixelsComplete)
    const readbackBytesComplete = readbacksValid && readbacks.every(frame => frame.readbackBytesComplete)
    const uploadPixelsComplete = uploadsValid && uploads.every(frame => frame.uploadPixelsComplete)
    const uploadBytesComplete = uploadsValid && uploads.every(frame => frame.uploadBytesComplete)

    return {
        cpuFrameMsP95: percentile95(frames.map(frame => frame.cpuFrameMs)),
        drawCommandsP95: drawsValid ? percentile95(frames.map(frame => drawTotal(frame.draws) ?? 0)) : null,
        pathCommandsP95: drawsValid ? percentile95(frames.map(frame => frame.draws.path)) : null,
        textCommandsP95: drawsValid ? percentile95(frames.map(frame => frame.draws.text)) : null,
        imageCommandsP95: drawsValid ? percentile95(frames.map(frame => frame.draws.image)) : null,
        pixelWriteCommandsP95: drawsValid ? percentile95(frames.map(frame => frame.draws.pixelWrite)) : null,
        clearCommandsP95: drawsValid ? percentile95(frames.map(frame => frame.draws.clear)) : null,
        otherCommandsP95: drawsValid ? percentile95(frames.map(frame => frame.draws.other)) : null,
        readbackMsP95: readbacksValid ? percentile95(readbacks.map(frame => frame.readbackMs)) : null,
        uploadMsP95: uploadsValid ? percentile95(uploads.map(frame => frame.uploadMs)) : null,
        readbackPixels: readbackPixelsComplete
            ? sumBounded(
                  readbacks.map(frame => frame.readbackPixels),
                  MAX_BYTES
              )
            : null,
        readbackBytes: readbackBytesComplete
            ? sumBounded(
                  readbacks.map(frame => frame.readbackBytes),
                  MAX_BYTES
              )
            : null,
        uploadPixels: uploadPixelsComplete
            ? sumBounded(
                  uploads.map(frame => frame.uploadPixels),
                  MAX_BYTES
              )
            : null,
        uploadBytes: uploadBytesComplete
            ? sumBounded(
                  uploads.map(frame => frame.uploadBytes),
                  MAX_BYTES
              )
            : null,
    }
}

function isSameRealmPromise(value: unknown): boolean | null {
    try {
        return typeof Promise !== 'undefined' && value instanceof Promise
    } catch {
        // Promise classification is diagnostic only. A hostile/opaque return
        // value must never replace the business callback's exact result.
        return null
    }
}

function defaultNow(): number {
    return typeof performance === 'undefined' ? Date.now() : performance.now()
}

export function createCanvas2dRecorder(options: Canvas2dRecorderOptions): Canvas2dRecorder {
    let context: Canvas2dContextLike
    let surface: Canvas2dSurfaceLike
    try {
        if (!options || !isObject(options.context) || !isObject(options.context.canvas)) {
            throw new Canvas2dRecorderOptionsError('context must expose one Canvas2D surface')
        }
        context = options.context
        surface = context.canvas
    } catch (error) {
        if (error instanceof Canvas2dRecorderOptionsError) throw error
        throw new Canvas2dRecorderOptionsError('context must expose one Canvas2D surface')
    }
    if (options.frameBoundary !== 'complete-canvas-frame') {
        throw new Canvas2dRecorderOptionsError('frameBoundary must explicitly be complete-canvas-frame')
    }
    if (options.drawCallCoverage !== undefined && options.drawCallCoverage !== 'complete-frame') {
        throw new Canvas2dRecorderOptionsError('drawCallCoverage must be complete-frame when provided')
    }
    if (options.contextLossEventCoverage !== undefined && options.contextLossEventCoverage !== 'complete-window') {
        throw new Canvas2dRecorderOptionsError('contextLossEventCoverage must be complete-window when provided')
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
        throw new Canvas2dRecorderOptionsError('now must be a function when provided')
    }
    const maxRetainedFrames = options.maxRetainedFrames ?? DEFAULT_MAX_RETAINED_FRAMES
    if (!Number.isInteger(maxRetainedFrames) || maxRetainedFrames < 1 || maxRetainedFrames > MAX_RETAINED_FRAMES) {
        throw new Canvas2dRecorderOptionsError(`maxRetainedFrames must be an integer between 1 and ${MAX_RETAINED_FRAMES}`)
    }

    const now = options.now ?? defaultNow
    const completeDrawCoverage = options.drawCallCoverage === 'complete-frame'
    const completeContextLossEventCoverage = options.contextLossEventCoverage === 'complete-window'
    const frames = new BoundedRing<CompletedFrame>(maxRetainedFrames)
    const contextEvents = new BoundedRing<ContextEventRecord>(MAX_CONTEXT_EVENTS)
    let active: ActiveFrame | null = null
    let disposed = false
    let rejectedFrameCount = 0
    let cancelledFrameCount = 0
    let rejectedOperationCount = 0
    let measuredReadbackCount = 0
    let measuredUploadCount = 0
    let backingResizeCount = 0
    let contextLossCount = 0
    let contextRestoreCount = 0
    let latestHostReading: Canvas2dRendererHostReading | null = null
    let droppedHostReadingCount = 0
    let clockErrorCount = 0
    let contextErrorCount = 0
    let firstCompletedStartedAt: number | null = null
    let firstContextTimestamp: number | null = null
    let lastCompletedEndedAt: number | null = null
    let evictedFrameThroughAt: number | null = null
    let evictedContextThroughAt: number | null = null
    let contextEvidenceInvalid = false
    let contextLossListenerInstalled = false
    let contextRestoreListenerInstalled = false
    let transferDepth = 0
    let activeTransferFamily: 'readback' | 'upload' | null = null
    let recordOperationsGuard: { frame: ActiveFrame; invalid: boolean } | null = null

    const readNow = (): number | null => {
        try {
            const value = boundedTime(now())
            if (value !== null) return value
        } catch {
            // Count below without exposing the host exception.
        }
        clockErrorCount = increment(clockErrorCount)
        return null
    }

    const readBacking = (): BackingSize | null => {
        try {
            const width = boundedInteger(surface.width, MAX_COUNT)
            const height = boundedInteger(surface.height, MAX_COUNT)
            if (width !== null && height !== null) return { width, height }
        } catch {
            // Count below without changing application behavior.
        }
        contextErrorCount = increment(contextErrorCount)
        return null
    }

    let lastBacking = readBacking()

    const observeBacking = (frame: ActiveFrame): void => {
        const current = readBacking()
        if (!current) return
        if (lastBacking && (lastBacking.width !== current.width || lastBacking.height !== current.height)) {
            backingResizeCount = increment(backingResizeCount)
            frame.backingResizeCount = increment(frame.backingResizeCount)
        }
        lastBacking = current
    }

    const recordContextEvent = (type: ContextEventRecord['type']): void => {
        if (disposed) return
        const timestamp = readNow()
        if (timestamp === null) {
            contextEvidenceInvalid = true
            contextErrorCount = increment(contextErrorCount)
            return
        }
        const evicted = contextEvents.push({ type, timestamp })
        firstContextTimestamp ??= timestamp
        if (evicted) evictedContextThroughAt = Math.max(evictedContextThroughAt ?? 0, evicted.timestamp)
        if (type === 'lost') contextLossCount = increment(contextLossCount)
        else contextRestoreCount = increment(contextRestoreCount)
    }
    const onContextLost: EventListener = () => recordContextEvent('lost')
    const onContextRestored: EventListener = () => recordContextEvent('restored')
    let addListener: Canvas2dSurfaceLike['addEventListener']
    let removeListener: Canvas2dSurfaceLike['removeEventListener']
    try {
        addListener = surface.addEventListener
        removeListener = surface.removeEventListener
    } catch {
        contextErrorCount = increment(contextErrorCount)
    }
    if (typeof addListener === 'function' && typeof removeListener === 'function') {
        try {
            addListener.call(surface, 'contextlost', onContextLost)
            contextLossListenerInstalled = true
            addListener.call(surface, 'contextrestored', onContextRestored)
            contextRestoreListenerInstalled = true
        } catch {
            contextErrorCount = increment(contextErrorCount)
            if (contextLossListenerInstalled) {
                try {
                    removeListener.call(surface, 'contextlost', onContextLost)
                    contextLossListenerInstalled = false
                } catch {
                    contextErrorCount = increment(contextErrorCount)
                }
            }
            if (contextRestoreListenerInstalled) {
                try {
                    removeListener.call(surface, 'contextrestored', onContextRestored)
                    contextRestoreListenerInstalled = false
                } catch {
                    contextErrorCount = increment(contextErrorCount)
                }
            }
        }
    }

    const hasContextLossEventCapability = (): boolean =>
        contextLossListenerInstalled && (completeContextLossEventCoverage || contextEvents.totalCount > 0)

    const dropBufferedHostReading = (): void => {
        if (!latestHostReading) return
        latestHostReading = null
        droppedHostReadingCount = increment(droppedHostReadingCount)
    }

    const exactDroppedFrameCountForWindow = (startedAt: number, endedAt: number): number | null => {
        const totalDropped = Math.max(0, frames.totalCount - frames.retainedCount)
        if (totalDropped === 0) return 0
        if (!frames.hasExactTotalCount || firstCompletedStartedAt === null || evictedFrameThroughAt === null) return null
        if (startedAt > evictedFrameThroughAt || endedAt < firstCompletedStartedAt) return 0
        if (startedAt <= firstCompletedStartedAt && endedAt >= evictedFrameThroughAt) return totalDropped
        return null
    }

    const poisonFrameOperation = (frame: ActiveFrame, family: 'draw' | 'readback' | 'upload'): void => {
        rejectedOperationCount = increment(rejectedOperationCount)
        if (family === 'draw') frame.drawValid = false
        else if (family === 'readback') frame.readbackValid = false
        else frame.uploadValid = false
    }

    const poisonOperation = (family: 'draw' | 'readback' | 'upload'): void => {
        if (active) poisonFrameOperation(active, family)
        else rejectedOperationCount = increment(rejectedOperationCount)
    }

    const measureTransfer = <T>(
        family: 'readback' | 'upload',
        evidence: Canvas2dReadbackEvidence | Canvas2dUploadEvidence,
        operation: () => T
    ): T => {
        if (typeof operation !== 'function') throw new TypeError(`${family} operation must be a function`)
        const frame = !disposed ? active : null
        if (!frame) return operation()
        if (family === 'readback') frame.readbackAttempted = true
        else frame.uploadAttempted = true
        if (transferDepth > 0) {
            poisonFrameOperation(frame, family)
            return operation()
        }

        transferDepth += 1
        activeTransferFamily = family
        try {
            let rawPixels: unknown
            let rawBytes: unknown
            let metadataReadable = true
            try {
                rawPixels = evidence?.pixels
                rawBytes = evidence?.bytes
            } catch {
                metadataReadable = false
            }
            const pixels = rawPixels === undefined ? undefined : boundedInteger(rawPixels, MAX_BYTES)
            const bytes = rawBytes === undefined ? undefined : boundedInteger(rawBytes, MAX_BYTES)
            const metadataValid =
                metadataReadable && (rawPixels === undefined || pixels !== null) && (rawBytes === undefined || bytes !== null)
            const startedAt = readNow()
            let result: T
            try {
                result = operation()
            } catch (error) {
                poisonFrameOperation(frame, family)
                throw error
            }
            if (active !== frame) {
                poisonFrameOperation(frame, family)
                return result
            }
            const endedAt = readNow()
            const duration = startedAt !== null && endedAt !== null ? endedAt - startedAt : Number.NaN
            const sameRealmPromise = isSameRealmPromise(result)
            const familyValid = family === 'readback' ? frame.readbackValid : frame.uploadValid
            if (!metadataValid || !Number.isFinite(duration) || duration < 0 || duration > MAX_DURATION_MS || sameRealmPromise !== false) {
                if (familyValid) poisonFrameOperation(frame, family)
                return result
            }

            if (family === 'readback') {
                if (!frame.readbackValid) return result
                const nextDuration = addBounded(frame.readbackMs, round(duration), MAX_DURATION_MS)
                const nextPixels = rawPixels === undefined ? frame.readbackPixels : addBounded(frame.readbackPixels, pixels ?? 0, MAX_BYTES)
                const nextBytes = rawBytes === undefined ? frame.readbackBytes : addBounded(frame.readbackBytes, bytes ?? 0, MAX_BYTES)
                if (nextDuration === null || nextPixels === null || nextBytes === null) {
                    poisonFrameOperation(frame, 'readback')
                    return result
                }
                frame.readbackMs = nextDuration
                frame.readbackPixels = nextPixels
                frame.readbackBytes = nextBytes
                if (rawPixels === undefined) frame.readbackPixelsComplete = false
                if (rawBytes === undefined) frame.readbackBytesComplete = false
                measuredReadbackCount = increment(measuredReadbackCount)
            } else {
                if (!frame.uploadValid) return result
                const nextDuration = addBounded(frame.uploadMs, round(duration), MAX_DURATION_MS)
                const nextPixels = rawPixels === undefined ? frame.uploadPixels : addBounded(frame.uploadPixels, pixels ?? 0, MAX_BYTES)
                const nextBytes = rawBytes === undefined ? frame.uploadBytes : addBounded(frame.uploadBytes, bytes ?? 0, MAX_BYTES)
                if (nextDuration === null || nextPixels === null || nextBytes === null) {
                    poisonFrameOperation(frame, 'upload')
                    return result
                }
                frame.uploadMs = nextDuration
                frame.uploadPixels = nextPixels
                frame.uploadBytes = nextBytes
                if (rawPixels === undefined) frame.uploadPixelsComplete = false
                if (rawBytes === undefined) frame.uploadBytesComplete = false
                measuredUploadCount = increment(measuredUploadCount)
            }
            return result
        } finally {
            transferDepth = Math.max(0, transferDepth - 1)
            if (transferDepth === 0) activeTransferFamily = null
        }
    }

    const inspectWindow = (window: Canvas2dTargetInspectionContext['evidenceWindow']): Canvas2dTargetRendererInspection => {
        if (disposed) {
            return {
                family: 'canvas2d',
                capability: { state: 'unknown', observed: false, buffered: false, reason: 'Canvas2D recorder is disposed' },
            }
        }
        let rawStartedAt: unknown
        let rawEndedAt: unknown
        let rawRelation: unknown
        try {
            rawStartedAt = window?.startedAt
            rawEndedAt = window?.endedAt
            rawRelation = window?.relation
        } catch {
            return {
                family: 'canvas2d',
                capability: { state: 'supported', observed: false, buffered: false, reason: 'Target evidence window was unreadable' },
            }
        }
        const startedAt = boundedTime(rawStartedAt)
        const endedAt = boundedTime(rawEndedAt)
        const relationValid = rawRelation === 'selection-window' || rawRelation === 'interaction-window'
        if (startedAt === null || endedAt === null || endedAt < startedAt || !relationValid) {
            return {
                family: 'canvas2d',
                capability: { state: 'supported', observed: false, buffered: false, reason: 'A valid SDK evidence window is required' },
            }
        }
        const retained = frames.toArray().filter(frame => frame.startedAt >= startedAt && frame.endedAt <= endedAt)
        const droppedSampleCount = exactDroppedFrameCountForWindow(startedAt, endedAt)
        if (droppedSampleCount === null) {
            return {
                family: 'canvas2d',
                capability: {
                    state: 'supported',
                    observed: false,
                    buffered: false,
                    reason: 'Canvas2D frame eviction intersects this window, but its exact sample count is unavailable',
                },
            }
        }
        if (retained.length === 0) {
            return {
                family: 'canvas2d',
                capability: {
                    state: 'supported',
                    observed: false,
                    buffered: false,
                    reason:
                        droppedSampleCount > 0
                            ? 'Canvas2D frames in this window were evicted from the bounded recorder'
                            : 'No complete Canvas2D frames were retained in this window',
                },
            }
        }

        const aggregate = aggregateFrames(retained, completeDrawCoverage)
        const measuredStartedAt = retained[0]?.startedAt ?? startedAt
        const measuredEndedAt = retained[retained.length - 1]?.endedAt ?? endedAt
        const contextHistoryTruncated =
            firstContextTimestamp !== null &&
            evictedContextThroughAt !== null &&
            measuredStartedAt <= evictedContextThroughAt &&
            measuredEndedAt >= firstContextTimestamp
        const truncated = droppedSampleCount > 0
        const metrics: NonNullable<Canvas2dTargetRendererInspection['metrics']> = {
            ...(aggregate.cpuFrameMsP95 === null ? {} : { cpuFrameMsP95: aggregate.cpuFrameMsP95 }),
            ...(aggregate.drawCommandsP95 === null ? {} : { drawCallsP95: aggregate.drawCommandsP95 }),
            ...(aggregate.uploadBytes === null ? {} : { uploadBytes: aggregate.uploadBytes }),
            ...(aggregate.readbackMsP95 === null ? {} : { readbackMsP95: aggregate.readbackMsP95 }),
        }
        if (hasContextLossEventCapability() && !contextEvidenceInvalid && !contextHistoryTruncated) {
            metrics.contextLossCount = contextEvents
                .toArray()
                .filter(event => event.type === 'lost' && event.timestamp >= measuredStartedAt && event.timestamp <= measuredEndedAt).length
        }
        return {
            family: 'canvas2d',
            capability: { state: 'supported', observed: true, buffered: false },
            metrics,
            evidence: {
                window: { startedAt: measuredStartedAt, endedAt: measuredEndedAt },
                acceptedSampleCount: retained.length + droppedSampleCount,
                retainedSampleCount: retained.length,
                droppedSampleCount,
                truncated,
            },
        }
    }

    const recorder: Canvas2dRecorder = {
        backend: 'canvas2d',
        get supported() {
            return !disposed
        },
        beginFrame(): boolean {
            if (disposed || active) return false
            dropBufferedHostReading()
            const startedAt = readNow()
            if (startedAt === null) {
                rejectedFrameCount = increment(rejectedFrameCount)
                return false
            }
            active = {
                startedAt,
                drawValid: true,
                draws: emptyDrawCounts(),
                readbackAttempted: false,
                readbackValid: true,
                readbackMs: 0,
                readbackPixels: 0,
                readbackPixelsComplete: true,
                readbackBytes: 0,
                readbackBytesComplete: true,
                uploadAttempted: false,
                uploadValid: true,
                uploadMs: 0,
                uploadPixels: 0,
                uploadPixelsComplete: true,
                uploadBytes: 0,
                uploadBytesComplete: true,
                backingResizeCount: 0,
            }
            observeBacking(active)
            return true
        },
        recordDraw(kind, count = 1): boolean {
            if (disposed || !active) return false
            if (typeof kind !== 'string') {
                poisonOperation('draw')
                return false
            }
            const key = DRAW_KEYS[kind]
            if (!key) {
                poisonOperation('draw')
                return false
            }
            const normalized = boundedInteger(count, MAX_COUNT)
            if (normalized === null) {
                poisonOperation('draw')
                return false
            }
            const nextDraws = { ...active.draws }
            const next = addBounded(nextDraws[key], normalized, MAX_COUNT)
            if (next === null) {
                poisonOperation('draw')
                return false
            }
            nextDraws[key] = next
            if (drawTotal(nextDraws) === null) {
                poisonOperation('draw')
                return false
            }
            active.draws = nextDraws
            return true
        },
        recordOperations(operations): boolean {
            if (recordOperationsGuard) {
                recordOperationsGuard.invalid = true
                poisonFrameOperation(recordOperationsGuard.frame, 'draw')
                return false
            }
            if (disposed || !active || !operations || typeof operations !== 'object') return false
            const frame = active
            const guard = { frame, invalid: false }
            recordOperationsGuard = guard
            try {
                const allowed = new Set(['path', 'text', 'image', 'pixelWrite', 'clear', 'other'])
                if (Object.keys(operations).some(key => !allowed.has(key))) {
                    poisonFrameOperation(frame, 'draw')
                    return false
                }
                const entries: Array<[Canvas2dDrawKind, unknown]> = [
                    ['path', operations.path],
                    ['text', operations.text],
                    ['image', operations.image],
                    ['pixel-write', operations.pixelWrite],
                    ['clear', operations.clear],
                    ['other', operations.other],
                ]
                if (guard.invalid) return false
                if (disposed || active !== frame) {
                    poisonFrameOperation(frame, 'draw')
                    return false
                }
                const provided = entries.filter(([, value]) => value !== undefined)
                if (provided.length === 0) {
                    poisonFrameOperation(frame, 'draw')
                    return false
                }
                const normalized = provided.map(([kind, value]) => [kind, boundedInteger(value, MAX_COUNT)] as const)
                if (normalized.some(([, value]) => value === null)) {
                    poisonFrameOperation(frame, 'draw')
                    return false
                }
                const nextDraws = { ...frame.draws }
                for (const [kind, value] of normalized) {
                    const key = DRAW_KEYS[kind]
                    const next = addBounded(nextDraws[key], value ?? 0, MAX_COUNT)
                    if (next === null) {
                        poisonFrameOperation(frame, 'draw')
                        return false
                    }
                    nextDraws[key] = next
                }
                if (drawTotal(nextDraws) === null) {
                    poisonFrameOperation(frame, 'draw')
                    return false
                }
                if (guard.invalid) return false
                if (disposed || active !== frame) {
                    poisonFrameOperation(frame, 'draw')
                    return false
                }
                frame.draws = nextDraws
                return true
            } catch {
                poisonFrameOperation(frame, 'draw')
                return false
            } finally {
                if (recordOperationsGuard === guard) recordOperationsGuard = null
            }
        },
        measureReadback<T>(evidence: Canvas2dReadbackEvidence, operation: () => T): T {
            return measureTransfer('readback', evidence, operation)
        },
        measureUpload<T>(evidence: Canvas2dUploadEvidence, operation: () => T): T {
            return measureTransfer('upload', evidence, operation)
        },
        endFrame(): boolean {
            if (disposed || !active) return false
            let reentrant = false
            if (recordOperationsGuard) {
                const guardedFrame = recordOperationsGuard.frame
                recordOperationsGuard.invalid = true
                poisonFrameOperation(guardedFrame, 'draw')
                if (active !== guardedFrame) poisonFrameOperation(active, 'draw')
                reentrant = true
            }
            if (transferDepth > 0) {
                if (activeTransferFamily) poisonOperation(activeTransferFamily)
                reentrant = true
            }
            if (reentrant) return false
            const frame = active
            active = null
            const endedAt = readNow()
            if (endedAt === null) {
                rejectedFrameCount = increment(rejectedFrameCount)
                return false
            }
            const cpuFrameMs = endedAt - frame.startedAt
            if (
                !Number.isFinite(cpuFrameMs) ||
                cpuFrameMs < 0 ||
                cpuFrameMs > MAX_DURATION_MS ||
                (lastCompletedEndedAt !== null && frame.startedAt < lastCompletedEndedAt)
            ) {
                rejectedFrameCount = increment(rejectedFrameCount)
                return false
            }
            observeBacking(frame)
            const completed: CompletedFrame = { ...frame, endedAt, cpuFrameMs: round(cpuFrameMs) }
            firstCompletedStartedAt ??= completed.startedAt
            lastCompletedEndedAt = completed.endedAt
            const evicted = frames.push(completed)
            if (evicted) evictedFrameThroughAt = Math.max(evictedFrameThroughAt ?? 0, evicted.endedAt)
            if (completeDrawCoverage && completed.drawValid) {
                const drawCalls = drawTotal(completed.draws)
                if (drawCalls !== null) {
                    if (latestHostReading) droppedHostReadingCount = increment(droppedHostReadingCount)
                    latestHostReading = { gpuTimerCapability: 'unsupported', gpu: null, drawCalls }
                }
            }
            return true
        },
        cancelFrame(): boolean {
            if (disposed || !active) return false
            active = null
            cancelledFrameCount = increment(cancelledFrameCount)
            return true
        },
        takeRendererHostReading(): Canvas2dRendererHostReading | null {
            const value = latestHostReading
            latestHostReading = null
            return value
        },
        inspectWindow,
        inspect(context): Canvas2dTargetAdapterInspection {
            const renderer = context
                ? inspectWindow(context.evidenceWindow)
                : {
                      family: 'canvas2d' as const,
                      capability: {
                          state: disposed ? ('unknown' as const) : ('supported' as const),
                          observed: false,
                          buffered: false as const,
                          reason: disposed ? 'Canvas2D recorder is disposed' : 'An SDK target inspection context is required',
                      },
                  }
            return {
                inventory: { renderers: ['canvas2d'] },
                owners: [{ relation: 'renderer-host', label: 'Condev Canvas2D recorder' }],
                renderer,
            }
        },
        getSnapshot(): Canvas2dRecorderSnapshot {
            const retained = frames.toArray()
            return {
                backend: 'canvas2d',
                capability: disposed ? 'disposed' : 'supported',
                supported: !disposed,
                active: active !== null,
                capacity: maxRetainedFrames,
                acceptedFrameCount: frames.totalCount,
                retainedFrameCount: frames.retainedCount,
                droppedFrameCount: Math.max(0, frames.totalCount - frames.retainedCount),
                rejectedFrameCount,
                cancelledFrameCount,
                rejectedOperationCount,
                measuredReadbackCount,
                measuredUploadCount,
                backingResizeCount,
                backingWidth: lastBacking?.width ?? null,
                backingHeight: lastBacking?.height ?? null,
                contextLossEventCapability: hasContextLossEventCapability(),
                contextLossCount,
                contextRestoreCount,
                hostReadingBuffered: latestHostReading !== null,
                droppedHostReadingCount,
                clockErrorCount,
                contextErrorCount,
                aggregate: aggregateFrames(retained, completeDrawCoverage),
            }
        },
        dispose(): void {
            if (disposed) return
            disposed = true
            active = null
            latestHostReading = null
            frames.clear()
            contextEvents.clear()
            if (typeof removeListener === 'function') {
                if (contextLossListenerInstalled) {
                    try {
                        removeListener.call(surface, 'contextlost', onContextLost)
                        contextLossListenerInstalled = false
                    } catch {
                        contextErrorCount = increment(contextErrorCount)
                    }
                }
                if (contextRestoreListenerInstalled) {
                    try {
                        removeListener.call(surface, 'contextrestored', onContextRestored)
                        contextRestoreListenerInstalled = false
                    } catch {
                        contextErrorCount = increment(contextErrorCount)
                    }
                }
            }
        },
    }

    return recorder
}
