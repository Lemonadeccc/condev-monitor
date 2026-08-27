// cspell:ignore disjoint webgl

const WEBGL1_EXTENSION = 'EXT_disjoint_timer_query'
const WEBGL2_EXTENSION = 'EXT_disjoint_timer_query_webgl2'
const GPU_TIMING_SOURCE = 'webgl-disjoint-timer-query' as const
const TARGET_GPU_TIMING_SOURCE = 'webgl-timer-query' as const
const DEFAULT_SAMPLE_EVERY = 60
const DEFAULT_MAX_PENDING_QUERIES = 2
const DEFAULT_MAX_POLL_ATTEMPTS = 240
const DEFAULT_MAX_RETAINED_FRAMES = 512
const MAX_SAMPLE_EVERY = 60_000
const MAX_PENDING_QUERIES = 8
const MAX_POLL_ATTEMPTS = 60_000
const MAX_RETAINED_FRAMES = 4_096
const MAX_GPU_TIME_MS = 600_000
const MAX_CLOCK_MS = 1_000_000_000_000_000
const NANOSECONDS_PER_MILLISECOND = 1_000_000
const MAX_COUNTER = Number.MAX_SAFE_INTEGER

export type WebGlGpuTimerBackend = 'webgl' | 'webgl2'

export type WebGlGpuTimerCapability = 'supported' | 'unsupported' | 'owner-conflict' | 'context-lost' | 'error' | 'disposed'

/** Closed capability state shared with the renderer host evidence contract. */
export type WebGlGpuTimerHostCapability = 'supported' | 'unsupported' | 'disabled' | 'unknown'

export type WebGlGpuTimingEvidence =
    | {
          status: 'measured'
          timeMs: number
          source: typeof GPU_TIMING_SOURCE
      }
    | {
          status: 'invalid' | 'disjoint' | 'context-lost' | 'error'
          source: typeof GPU_TIMING_SOURCE
      }

export interface WebGlGpuTimerHostReading {
    gpuTimerCapability: WebGlGpuTimerHostCapability
    gpu: WebGlGpuTimingEvidence | null
}

export interface WebGlGpuTimerOptions {
    /** The timer never owns or destroys this application WebGL context. */
    gl: WebGLRenderingContext | WebGL2RenderingContext
    /** Explicit provenance prevents WebGL 1 and WebGL 2 query APIs from being mixed. */
    backend: WebGlGpuTimerBackend
    /**
     * Required host attestation. No renderer, profiler, duplicate bundle, or
     * other code may read GPU_DISJOINT_EXT or own timer queries on this context.
     */
    disjointQueryOwnership: 'exclusive'
    /** Sample the first eligible frame and then every Nth beginFrame call. Default: 60. */
    sampleEvery?: number
    /** Bound unresolved query objects rather than replacing an older query. Default: 2. */
    maxPendingQueries?: number
    /** Bound polls of the oldest unresolved query. Default: 240. */
    maxPollAttempts?: number
    /** Number of completed target-window query records retained locally. Default: 512; maximum: 4096. */
    maxRetainedFrames?: number
    /** Must share the target collector's clock domain. Defaults to performance.now(), then Date.now(). */
    now?: () => number
}

export interface WebGlGpuTimerTargetInspectionContext {
    readonly evidenceWindow: {
        readonly startedAt: number
        readonly endedAt: number
        readonly relation: 'selection-window' | 'interaction-window'
    }
}

export interface WebGlGpuTimerTargetRendererInspection {
    family: WebGlGpuTimerBackend
    capability: {
        state: 'supported' | 'unsupported' | 'unknown'
        observed: boolean
        buffered: false
        reason?: string
    }
    metrics?: {
        gpuFrameMsP95?: number
    }
    evidence?: {
        window: { startedAt: number; endedAt: number }
        acceptedSampleCount: number
        retainedSampleCount: number
        droppedSampleCount: number
        rejectedSampleCount: number
        truncated: boolean
        gpu: {
            valid: boolean
            disjoint: boolean
            contextLost: boolean
            source: typeof TARGET_GPU_TIMING_SOURCE
        }
    }
}

export interface WebGlGpuTimerTargetAdapterInspection {
    inventory: { renderers: readonly WebGlGpuTimerBackend[] }
    owners: readonly [{ relation: 'renderer-host'; label: 'Condev WebGL GPU timer' }]
    renderer: WebGlGpuTimerTargetRendererInspection
}

export interface WebGlGpuTimerSnapshot {
    backend: WebGlGpuTimerBackend
    capability: WebGlGpuTimerCapability
    supported: boolean
    counterBits: number | null
    active: boolean
    pendingQueryCount: number
    evidenceBuffered: boolean
    beginAttemptCount: number
    startedQueryCount: number
    measuredQueryCount: number
    invalidQueryCount: number
    disjointEpochCount: number
    timedOutQueryCount: number
    skippedActiveCount: number
    skippedCapacityCount: number
    skippedHostQueryCount: number
    droppedEvidenceCount: number
    targetResultCapacity: number
    acceptedTargetSampleCount: number
    retainedTargetSampleCount: number
    droppedTargetSampleCount: number
    rejectedTargetSampleCount: number
    retainedTargetRejectionCount: number
    droppedTargetRejectionCount: number
    clockErrorCount: number
    errorCount: number
}

export interface WebGlGpuTimer {
    readonly backend: WebGlGpuTimerBackend
    readonly supported: boolean
    /**
     * Starts a sparse TIME_ELAPSED query around one complete, synchronous
     * renderer frame. False means the caller must not call endFrame.
     */
    beginFrame(): boolean
    /** Ends the query started by beginFrame and enqueues it for asynchronous polling. */
    endFrame(): boolean
    /** Performs finite work on at most the oldest query; never waits for the GPU. */
    poll(): void
    /** Consume once so a single GPU result cannot be recorded on multiple frames. */
    takeLatestEvidence(): WebGlGpuTimingEvidence | null
    /**
     * Consume the latest result together with an explicit host capability.
     * The returned object can be spread directly into RendererHostReading.
     */
    takeRendererHostTiming(): WebGlGpuTimerHostReading
    /** Produces non-consuming GPU timing evidence for one SDK-owned target window. */
    inspectWindow(window: WebGlGpuTimerTargetInspectionContext['evidenceWindow']): WebGlGpuTimerTargetRendererInspection
    /** Bound callback for Browser animation.registerTarget(canvas, timer.inspect). */
    inspect(context?: WebGlGpuTimerTargetInspectionContext): WebGlGpuTimerTargetAdapterInspection
    getSnapshot(): WebGlGpuTimerSnapshot
    /** Releases only query objects created by this timer. It never loses the application context. */
    dispose(): void
}

export class WebGlGpuTimerOptionsError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'WebGlGpuTimerOptionsError'
    }
}

function hostCapability(capability: WebGlGpuTimerCapability): WebGlGpuTimerHostCapability {
    if (capability === 'supported') return 'supported'
    if (capability === 'unsupported') return 'unsupported'
    if (capability === 'disposed') return 'disabled'
    return 'unknown'
}

type QueryObject = object

interface WebGlContextBaseLike {
    getExtension(name: string): unknown
    getParameter(pname: number): unknown
    isContextLost(): boolean
}

interface WebGl1TimerExtensionLike {
    QUERY_COUNTER_BITS_EXT: number
    CURRENT_QUERY_EXT: number
    QUERY_RESULT_EXT: number
    QUERY_RESULT_AVAILABLE_EXT: number
    TIME_ELAPSED_EXT: number
    GPU_DISJOINT_EXT: number
    createQueryEXT(): unknown
    deleteQueryEXT(query: unknown): void
    beginQueryEXT(target: number, query: unknown): void
    endQueryEXT(target: number): void
    getQueryEXT(target: number, pname: number): unknown
    getQueryObjectEXT(query: unknown, pname: number): unknown
}

interface WebGl2ContextLike extends WebGlContextBaseLike {
    CURRENT_QUERY: number
    QUERY_RESULT: number
    QUERY_RESULT_AVAILABLE: number
    createQuery(): unknown
    deleteQuery(query: unknown): void
    beginQuery(target: number, query: unknown): void
    endQuery(target: number): void
    getQuery(target: number, pname: number): unknown
    getQueryParameter(query: unknown, pname: number): unknown
}

interface WebGl2TimerExtensionLike {
    QUERY_COUNTER_BITS_EXT: number
    TIME_ELAPSED_EXT: number
    GPU_DISJOINT_EXT: number
}

interface QueryApi {
    readCounterBits(): unknown
    readCurrentQuery(): unknown
    readDisjoint(): unknown
    isContextLost(): unknown
    createQuery(): unknown
    beginQuery(query: QueryObject): void
    endQuery(): void
    readAvailable(query: QueryObject): unknown
    readResultNanoseconds(query: QueryObject): unknown
    deleteQuery(query: QueryObject): void
}

interface ActiveQuery {
    query: QueryObject
    startedAt: number | null
    endedAt: number | null
}

interface PendingQuery {
    query: QueryObject
    pollAttempts: number
    startedAt: number | null
    endedAt: number | null
}

type TerminalQueryStatus = 'measured' | 'invalid' | 'disjoint' | 'context-lost' | 'error'

interface TerminalQueryResult {
    startedAt: number
    endedAt: number
    status: TerminalQueryStatus
    timeMs: number | null
}

interface RejectionStatusCounts {
    invalid: number
    disjoint: number
    'context-lost': number
    error: number
}

interface DroppedTargetResultCounts {
    measured: number
    rejected: RejectionStatusCounts
}

const contextOwners = new WeakMap<object, symbol>()

function increment(value: number): number {
    return value >= MAX_COUNTER ? MAX_COUNTER : value + 1
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
        if (this.total >= MAX_COUNTER) this.totalExact = false
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

function requireBoundedInteger(name: string, value: unknown, defaultValue: number, maximum: number): number {
    const normalized = value === undefined ? defaultValue : value
    if (typeof normalized !== 'number' || !Number.isInteger(normalized) || normalized < 1 || normalized > maximum) {
        throw new WebGlGpuTimerOptionsError(`${name} must be an integer between 1 and ${maximum}`)
    }
    return normalized
}

function boundedTime(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_CLOCK_MS ? value : null
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

function defaultNow(): number {
    return typeof performance === 'undefined' ? Date.now() : performance.now()
}

function isObject(value: unknown): value is object {
    return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function finiteEnum(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function method<T extends object, K extends keyof T>(target: T, key: K): Extract<T[K], (...args: never[]) => unknown> | null {
    const value = target[key]
    return typeof value === 'function' ? (value as Extract<T[K], (...args: never[]) => unknown>) : null
}

function createWebGl1Api(gl: WebGlContextBaseLike, extension: WebGl1TimerExtensionLike): QueryApi | null {
    const getParameter = method(gl, 'getParameter')
    const isContextLost = method(gl, 'isContextLost')
    const createQuery = method(extension, 'createQueryEXT')
    const deleteQuery = method(extension, 'deleteQueryEXT')
    const beginQuery = method(extension, 'beginQueryEXT')
    const endQuery = method(extension, 'endQueryEXT')
    const getQuery = method(extension, 'getQueryEXT')
    const getQueryObject = method(extension, 'getQueryObjectEXT')
    const constants = [
        extension.QUERY_COUNTER_BITS_EXT,
        extension.CURRENT_QUERY_EXT,
        extension.QUERY_RESULT_EXT,
        extension.QUERY_RESULT_AVAILABLE_EXT,
        extension.TIME_ELAPSED_EXT,
        extension.GPU_DISJOINT_EXT,
    ]
    if (
        !getParameter ||
        !isContextLost ||
        !createQuery ||
        !deleteQuery ||
        !beginQuery ||
        !endQuery ||
        !getQuery ||
        !getQueryObject ||
        !constants.every(finiteEnum)
    ) {
        return null
    }

    return {
        readCounterBits: () => Reflect.apply(getQuery, extension, [extension.TIME_ELAPSED_EXT, extension.QUERY_COUNTER_BITS_EXT]),
        readCurrentQuery: () => Reflect.apply(getQuery, extension, [extension.TIME_ELAPSED_EXT, extension.CURRENT_QUERY_EXT]),
        readDisjoint: () => Reflect.apply(getParameter, gl, [extension.GPU_DISJOINT_EXT]),
        isContextLost: () => Reflect.apply(isContextLost, gl, []),
        createQuery: () => Reflect.apply(createQuery, extension, []),
        beginQuery: query => Reflect.apply(beginQuery, extension, [extension.TIME_ELAPSED_EXT, query]),
        endQuery: () => Reflect.apply(endQuery, extension, [extension.TIME_ELAPSED_EXT]),
        readAvailable: query => Reflect.apply(getQueryObject, extension, [query, extension.QUERY_RESULT_AVAILABLE_EXT]),
        readResultNanoseconds: query => Reflect.apply(getQueryObject, extension, [query, extension.QUERY_RESULT_EXT]),
        deleteQuery: query => Reflect.apply(deleteQuery, extension, [query]),
    }
}

function createWebGl2Api(gl: WebGl2ContextLike, extension: WebGl2TimerExtensionLike): QueryApi | null {
    const getParameter = method(gl, 'getParameter')
    const isContextLost = method(gl, 'isContextLost')
    const createQuery = method(gl, 'createQuery')
    const deleteQuery = method(gl, 'deleteQuery')
    const beginQuery = method(gl, 'beginQuery')
    const endQuery = method(gl, 'endQuery')
    const getQuery = method(gl, 'getQuery')
    const getQueryParameter = method(gl, 'getQueryParameter')
    const constants = [
        gl.CURRENT_QUERY,
        gl.QUERY_RESULT,
        gl.QUERY_RESULT_AVAILABLE,
        extension.QUERY_COUNTER_BITS_EXT,
        extension.TIME_ELAPSED_EXT,
        extension.GPU_DISJOINT_EXT,
    ]
    if (
        !getParameter ||
        !isContextLost ||
        !createQuery ||
        !deleteQuery ||
        !beginQuery ||
        !endQuery ||
        !getQuery ||
        !getQueryParameter ||
        !constants.every(finiteEnum)
    ) {
        return null
    }

    return {
        readCounterBits: () => Reflect.apply(getQuery, gl, [extension.TIME_ELAPSED_EXT, extension.QUERY_COUNTER_BITS_EXT]),
        readCurrentQuery: () => Reflect.apply(getQuery, gl, [extension.TIME_ELAPSED_EXT, gl.CURRENT_QUERY]),
        readDisjoint: () => Reflect.apply(getParameter, gl, [extension.GPU_DISJOINT_EXT]),
        isContextLost: () => Reflect.apply(isContextLost, gl, []),
        createQuery: () => Reflect.apply(createQuery, gl, []),
        beginQuery: query => Reflect.apply(beginQuery, gl, [extension.TIME_ELAPSED_EXT, query]),
        endQuery: () => Reflect.apply(endQuery, gl, [extension.TIME_ELAPSED_EXT]),
        readAvailable: query => Reflect.apply(getQueryParameter, gl, [query, gl.QUERY_RESULT_AVAILABLE]),
        readResultNanoseconds: query => Reflect.apply(getQueryParameter, gl, [query, gl.QUERY_RESULT]),
        deleteQuery: query => Reflect.apply(deleteQuery, gl, [query]),
    }
}

type ApiInitialization = { kind: 'ready'; api: QueryApi } | { kind: 'unsupported' } | { kind: 'context-lost' } | { kind: 'malformed' }

function initializeApi(gl: WebGlContextBaseLike, backend: WebGlGpuTimerBackend): ApiInitialization {
    const getExtension = method(gl, 'getExtension')
    const isContextLost = method(gl, 'isContextLost')
    if (!getExtension || !isContextLost) return { kind: 'malformed' }
    const contextLostBeforeExtension = Reflect.apply(isContextLost, gl, [])
    if (typeof contextLostBeforeExtension !== 'boolean') return { kind: 'malformed' }
    if (contextLostBeforeExtension) return { kind: 'context-lost' }
    const extensionName = backend === 'webgl2' ? WEBGL2_EXTENSION : WEBGL1_EXTENSION
    const extension = Reflect.apply(getExtension, gl, [extensionName])
    if (extension === null) {
        // A lost context makes non-HandlesContextLoss nullable methods return
        // null too. Recheck after getExtension so that race is not mislabeled
        // as an unsupported timer-query extension.
        const contextLostAfterExtension = Reflect.apply(isContextLost, gl, [])
        if (typeof contextLostAfterExtension !== 'boolean') return { kind: 'malformed' }
        return contextLostAfterExtension ? { kind: 'context-lost' } : { kind: 'unsupported' }
    }
    if (!isObject(extension)) return { kind: 'malformed' }
    const api =
        backend === 'webgl2'
            ? createWebGl2Api(gl as WebGl2ContextLike, extension as WebGl2TimerExtensionLike)
            : createWebGl1Api(gl, extension as WebGl1TimerExtensionLike)
    return api ? { kind: 'ready', api } : { kind: 'malformed' }
}

export function createWebGlGpuTimer(options: WebGlGpuTimerOptions): WebGlGpuTimer {
    if (!options || !isObject(options)) throw new WebGlGpuTimerOptionsError('options must be an object')
    let rawGl: unknown
    let rawBackend: unknown
    let rawOwnership: unknown
    let rawSampleEvery: unknown
    let rawMaxPendingQueries: unknown
    let rawMaxPollAttempts: unknown
    let rawMaxRetainedFrames: unknown
    let rawNow: unknown
    try {
        rawGl = options.gl
        rawBackend = options.backend
        rawOwnership = options.disjointQueryOwnership
        rawSampleEvery = options.sampleEvery
        rawMaxPendingQueries = options.maxPendingQueries
        rawMaxPollAttempts = options.maxPollAttempts
        rawMaxRetainedFrames = options.maxRetainedFrames
        rawNow = options.now
    } catch {
        throw new WebGlGpuTimerOptionsError('timer options must be readable')
    }
    if (!isObject(rawGl)) throw new WebGlGpuTimerOptionsError('gl must be a WebGL rendering context')
    if (rawBackend !== 'webgl' && rawBackend !== 'webgl2') {
        throw new WebGlGpuTimerOptionsError('backend must be webgl or webgl2')
    }
    if (rawOwnership !== 'exclusive') {
        throw new WebGlGpuTimerOptionsError('disjointQueryOwnership must explicitly be exclusive')
    }
    if (rawNow !== undefined && typeof rawNow !== 'function') {
        throw new WebGlGpuTimerOptionsError('now must be a function when provided')
    }
    const sampleEvery = requireBoundedInteger('sampleEvery', rawSampleEvery, DEFAULT_SAMPLE_EVERY, MAX_SAMPLE_EVERY)
    const maxPendingQueries = requireBoundedInteger(
        'maxPendingQueries',
        rawMaxPendingQueries,
        DEFAULT_MAX_PENDING_QUERIES,
        MAX_PENDING_QUERIES
    )
    const maxPollAttempts = requireBoundedInteger('maxPollAttempts', rawMaxPollAttempts, DEFAULT_MAX_POLL_ATTEMPTS, MAX_POLL_ATTEMPTS)
    const maxRetainedFrames = requireBoundedInteger(
        'maxRetainedFrames',
        rawMaxRetainedFrames,
        DEFAULT_MAX_RETAINED_FRAMES,
        MAX_RETAINED_FRAMES
    )
    const now = (rawNow as (() => number) | undefined) ?? defaultNow
    const backend = rawBackend
    const gl = rawGl as WebGlContextBaseLike
    const contextKey = rawGl
    const owner = Symbol('condev-webgl-gpu-timer')
    const existingOwner = contextOwners.get(contextKey)
    let ownsContext = existingOwner === undefined
    if (ownsContext) contextOwners.set(contextKey, owner)

    let api: QueryApi | null = null
    let capability: WebGlGpuTimerCapability = existingOwner === undefined ? 'unsupported' : 'owner-conflict'
    let counterBits: number | null = null
    let activeQuery: ActiveQuery | null = null
    const pendingQueries: PendingQuery[] = []
    const targetResults = new BoundedRing<TerminalQueryResult>(maxRetainedFrames)
    let latestEvidence: WebGlGpuTimingEvidence | null = null
    let firstTargetResultStartedAt: number | null = null
    let evictedTargetResultThroughAt: number | null = null
    let acceptedTargetSampleCount = 0
    let rejectedTargetSampleCount = 0
    let droppedTargetSampleCount = 0
    const droppedTargetRejections: RejectionStatusCounts = { invalid: 0, disjoint: 0, 'context-lost': 0, error: 0 }
    let targetCountsExact = true
    let lastTargetClockAt: number | null = null
    let beginAttemptCount = 0
    let startedQueryCount = 0
    let measuredQueryCount = 0
    let invalidQueryCount = 0
    let disjointEpochCount = 0
    let timedOutQueryCount = 0
    let skippedActiveCount = 0
    let skippedCapacityCount = 0
    let skippedHostQueryCount = 0
    let droppedEvidenceCount = 0
    let clockErrorCount = 0
    let errorCount = 0
    let clockReadDepth = 0
    let clockReadInvalidated = false
    let inspectionDepth = 0
    let inspectionInvalidated = false
    let targetMutationVersion = 0
    let transactionDepth = 0
    let disposeRequested = false
    let provisionalQuery: QueryObject | null = null
    let contextLossRecheckDepth = 0

    const releaseOwnership = (): void => {
        if (!ownsContext) return
        if (contextOwners.get(contextKey) === owner) contextOwners.delete(contextKey)
        ownsContext = false
    }

    const emit = (evidence: WebGlGpuTimingEvidence): void => {
        if (latestEvidence) droppedEvidenceCount = increment(droppedEvidenceCount)
        latestEvidence = evidence
    }

    const noteError = (): void => {
        errorCount = increment(errorCount)
    }

    const incrementTargetCount = (value: number): number => {
        if (value >= MAX_COUNTER) {
            targetCountsExact = false
            return MAX_COUNTER
        }
        return value + 1
    }

    const rejectionCount = (counts: RejectionStatusCounts): number =>
        counts.invalid + counts.disjoint + counts['context-lost'] + counts.error

    const readNow = (): number | null => {
        if (clockReadDepth > 0) {
            clockReadInvalidated = true
            clockErrorCount = increment(clockErrorCount)
            return null
        }
        clockReadInvalidated = false
        clockReadDepth += 1
        let value: number | null = null
        let readFailed = false
        try {
            value = boundedTime(now())
            readFailed = value === null
        } catch {
            readFailed = true
        } finally {
            clockReadDepth = Math.max(0, clockReadDepth - 1)
        }
        if (readFailed) clockErrorCount = increment(clockErrorCount)
        return readFailed || clockReadInvalidated ? null : value
    }

    const recordTargetResult = (
        frame: { startedAt: number; endedAt: number },
        status: TerminalQueryStatus,
        timeMs: number | null = null
    ): void => {
        const result: TerminalQueryResult = {
            startedAt: frame.startedAt,
            endedAt: frame.endedAt,
            status,
            timeMs: status === 'measured' ? timeMs : null,
        }
        firstTargetResultStartedAt ??= result.startedAt
        if (status === 'measured') acceptedTargetSampleCount = incrementTargetCount(acceptedTargetSampleCount)
        else rejectedTargetSampleCount = incrementTargetCount(rejectedTargetSampleCount)
        const evicted = targetResults.push(result)
        targetMutationVersion = increment(targetMutationVersion)
        if (evicted) {
            evictedTargetResultThroughAt = Math.max(evictedTargetResultThroughAt ?? 0, evicted.endedAt)
            if (evicted.status === 'measured') droppedTargetSampleCount = incrementTargetCount(droppedTargetSampleCount)
            else droppedTargetRejections[evicted.status] = incrementTargetCount(droppedTargetRejections[evicted.status])
        }
    }

    const safeDelete = (query: QueryObject): void => {
        if (!api) return
        try {
            api.deleteQuery(query)
        } catch {
            noteError()
        }
    }

    const clearQueries = (useApi: boolean, terminalStatus?: Exclude<TerminalQueryStatus, 'measured' | 'invalid'>): void => {
        const active = activeQuery
        activeQuery = null
        if (active) {
            if (useApi && api) {
                try {
                    api.endQuery()
                } catch {
                    noteError()
                }
                safeDelete(active.query)
            }
        }
        const pending = pendingQueries.splice(0)
        for (const entry of pending) {
            if (useApi) safeDelete(entry.query)
        }
        if (terminalStatus) {
            for (const entry of pending) {
                if (entry.startedAt !== null && entry.endedAt !== null) {
                    recordTargetResult({ startedAt: entry.startedAt, endedAt: entry.endedAt }, terminalStatus)
                }
            }
            if (active && active.startedAt !== null && active.endedAt !== null) {
                recordTargetResult({ startedAt: active.startedAt, endedAt: active.endedAt }, terminalStatus)
            }
        }
    }

    const fail = (): void => {
        if (capability === 'disposed' || capability === 'context-lost') return
        capability = 'error'
        noteError()
        clearQueries(true, 'error')
        emit({ status: 'error', source: GPU_TIMING_SOURCE })
    }

    const loseContext = (): void => {
        if (capability === 'disposed' || capability === 'context-lost') return
        capability = 'context-lost'
        clearQueries(false, 'context-lost')
        api = null
        counterBits = null
        emit({ status: 'context-lost', source: GPU_TIMING_SOURCE })
    }

    const contextIsLost = (): boolean | null => {
        if (!api) return false
        try {
            const lost = api.isContextLost()
            if (typeof lost !== 'boolean') {
                fail()
                return null
            }
            if (lost) loseContext()
            return lost
        } catch {
            fail()
            return null
        }
    }

    const recheckContextLossAfterRuntimeFailure = (): boolean => {
        const currentApi = api
        if (!currentApi || contextLossRecheckDepth > 0) return false
        contextLossRecheckDepth += 1
        let lost = false
        try {
            lost = currentApi.isContextLost() === true
        } catch {
            // This is a single best-effort recheck. Never recurse into fail().
        } finally {
            contextLossRecheckDepth = Math.max(0, contextLossRecheckDepth - 1)
        }
        if (lost && capability !== 'disposed') loseContext()
        return lost
    }

    const failRuntime = (): void => {
        if (capability === 'disposed' || capability === 'context-lost' || disposeRequested) return
        if (recheckContextLossAfterRuntimeFailure()) return
        if (!disposeRequested) fail()
    }

    const invalidateDisjointEpoch = (): void => {
        disjointEpochCount = increment(disjointEpochCount)
        clearQueries(true, 'disjoint')
        emit({ status: 'disjoint', source: GPU_TIMING_SOURCE })
    }

    const readDisjoint = (): boolean | null => {
        if (!api) return null
        try {
            const disjoint = api.readDisjoint()
            if (typeof disjoint !== 'boolean') {
                failRuntime()
                return null
            }
            // A sticky flag can predate this timer. Clear it before the first
            // owned query without inventing a rejected sample. It becomes
            // evidence only when at least one owned query is invalidated.
            if (disjoint && recheckContextLossAfterRuntimeFailure()) return null
            if (disjoint && (activeQuery !== null || pendingQueries.length > 0)) invalidateDisjointEpoch()
            return disjoint
        } catch {
            failRuntime()
            return null
        }
    }

    const hostQueryIsActive = (): boolean | null => {
        if (!api) return null
        let currentQuery: unknown
        try {
            currentQuery = api.readCurrentQuery()
        } catch {
            failRuntime()
            return null
        }
        if (currentQuery !== null && !isObject(currentQuery)) {
            failRuntime()
            return null
        }
        if (currentQuery !== null) {
            skippedHostQueryCount = increment(skippedHostQueryCount)
            return true
        }
        return false
    }

    if (ownsContext) {
        try {
            const initialized = initializeApi(gl, backend)
            if (initialized.kind === 'context-lost') {
                loseContext()
            } else if (initialized.kind === 'unsupported') {
                capability = 'unsupported'
                releaseOwnership()
            } else if (initialized.kind === 'malformed') {
                capability = 'error'
                noteError()
                emit({ status: 'error', source: GPU_TIMING_SOURCE })
                releaseOwnership()
            } else {
                api = initialized.api
                const lost = api.isContextLost()
                if (typeof lost !== 'boolean') throw new TypeError('isContextLost must return boolean')
                if (lost) {
                    loseContext()
                } else {
                    const bits = api.readCounterBits()
                    if (typeof bits !== 'number' || !Number.isInteger(bits)) throw new TypeError('counter bits must be an integer')
                    if (bits === 0) {
                        api = null
                        capability = 'unsupported'
                        releaseOwnership()
                    } else if (bits < 30 || bits > 64) {
                        throw new TypeError('counter bits must be between 30 and 64')
                    } else {
                        counterBits = bits
                        capability = 'supported'
                    }
                }
            }
        } catch {
            api = null
            counterBits = null
            capability = 'error'
            noteError()
            emit({ status: 'error', source: GPU_TIMING_SOURCE })
            releaseOwnership()
        }
    }

    const finalizeDispose = (): void => {
        if (capability === 'disposed') return
        const useApi = capability !== 'context-lost'
        capability = 'disposed'
        disposeRequested = false
        const provisional = provisionalQuery
        provisionalQuery = null
        if (provisional && useApi) safeDelete(provisional)
        clearQueries(useApi)
        api = null
        counterBits = null
        latestEvidence = null
        for (const retained of targetResults.toArray()) {
            if (retained.status === 'measured') droppedTargetSampleCount = incrementTargetCount(droppedTargetSampleCount)
            else droppedTargetRejections[retained.status] = incrementTargetCount(droppedTargetRejections[retained.status])
        }
        targetResults.clear()
        targetMutationVersion = increment(targetMutationVersion)
        releaseOwnership()
    }

    const noteBlockedReentry = (): void => {
        if (clockReadDepth <= 0) return
        clockReadInvalidated = true
        clockErrorCount = increment(clockErrorCount)
    }

    const runBooleanTransaction = (operation: () => boolean): boolean => {
        if (transactionDepth > 0) {
            noteBlockedReentry()
            return false
        }
        transactionDepth += 1
        let result = false
        try {
            result = operation()
        } catch {
            failRuntime()
        } finally {
            transactionDepth = Math.max(0, transactionDepth - 1)
            if (disposeRequested) finalizeDispose()
        }
        return result && capability !== 'disposed'
    }

    const runVoidTransaction = (operation: () => void): void => {
        if (transactionDepth > 0) {
            noteBlockedReentry()
            return
        }
        transactionDepth += 1
        try {
            operation()
        } catch {
            failRuntime()
        } finally {
            transactionDepth = Math.max(0, transactionDepth - 1)
            if (disposeRequested) finalizeDispose()
        }
    }

    const unobservedTargetInspection = (reason: string): WebGlGpuTimerTargetRendererInspection => ({
        family: backend,
        capability: {
            state: capability === 'unsupported' ? 'unsupported' : capability === 'supported' ? 'supported' : 'unknown',
            observed: false,
            buffered: false,
            reason,
        },
    })

    const exactDroppedTargetResultCountsForWindow = (startedAt: number, endedAt: number): DroppedTargetResultCounts | null => {
        const droppedRejected = rejectionCount(droppedTargetRejections)
        const totalDropped = droppedTargetSampleCount + droppedRejected
        const empty = (): DroppedTargetResultCounts => ({
            measured: 0,
            rejected: { invalid: 0, disjoint: 0, 'context-lost': 0, error: 0 },
        })
        if (totalDropped === 0) return empty()
        if (!targetCountsExact || firstTargetResultStartedAt === null || evictedTargetResultThroughAt === null) return null
        if (startedAt > evictedTargetResultThroughAt || endedAt < firstTargetResultStartedAt) return empty()
        if (startedAt <= firstTargetResultStartedAt && endedAt >= evictedTargetResultThroughAt) {
            return { measured: droppedTargetSampleCount, rejected: { ...droppedTargetRejections } }
        }
        return null
    }

    const inspectWindow = (window: WebGlGpuTimerTargetInspectionContext['evidenceWindow']): WebGlGpuTimerTargetRendererInspection => {
        if (capability === 'disposed') return unobservedTargetInspection('WebGL GPU timer is disposed')
        if (transactionDepth > 0) return unobservedTargetInspection('WebGL GPU timer state is changing')
        if (inspectionDepth > 0) {
            inspectionInvalidated = true
            return unobservedTargetInspection('Reentrant target inspection is unavailable')
        }
        if (targetResults.retainedCount === 0 && capability !== 'supported') {
            const reason =
                capability === 'unsupported'
                    ? 'WebGL disjoint timer queries are unsupported'
                    : capability === 'owner-conflict'
                      ? 'Another timer owns disjoint-query evidence for this WebGL context'
                      : capability === 'context-lost'
                        ? 'The WebGL context was lost before a complete query result was retained'
                        : 'WebGL GPU timing failed before a complete query result was retained'
            return unobservedTargetInspection(reason)
        }

        let rawStartedAt: unknown
        let rawEndedAt: unknown
        let rawRelation: unknown
        const initialMutationVersion = targetMutationVersion
        inspectionInvalidated = false
        inspectionDepth += 1
        try {
            rawStartedAt = window?.startedAt
            rawEndedAt = window?.endedAt
            rawRelation = window?.relation
        } catch {
            return unobservedTargetInspection('Target evidence window was unreadable')
        } finally {
            inspectionDepth = Math.max(0, inspectionDepth - 1)
        }
        if (inspectionInvalidated || targetMutationVersion !== initialMutationVersion) {
            return unobservedTargetInspection('Target evidence changed during window inspection')
        }
        const startedAt = boundedTime(rawStartedAt)
        const endedAt = boundedTime(rawEndedAt)
        const relationValid = rawRelation === 'selection-window' || rawRelation === 'interaction-window'
        if (startedAt === null || endedAt === null || endedAt < startedAt || !relationValid) {
            return unobservedTargetInspection('A valid SDK evidence window is required')
        }

        const containedPending = pendingQueries.some(
            pending =>
                pending.startedAt !== null && pending.endedAt !== null && pending.startedAt >= startedAt && pending.endedAt <= endedAt
        )
        if (containedPending) {
            return unobservedTargetInspection('A complete WebGL timer query in this window is still pending GPU resolution')
        }

        const retained = targetResults.toArray().filter(result => result.startedAt >= startedAt && result.endedAt <= endedAt)
        const dropped = exactDroppedTargetResultCountsForWindow(startedAt, endedAt)
        if (dropped === null) {
            return unobservedTargetInspection(
                'WebGL timer-result eviction intersects this window, but its exact sample count is unavailable'
            )
        }
        if (retained.length === 0) {
            const droppedTerminalCount = dropped.measured + rejectionCount(dropped.rejected)
            return unobservedTargetInspection(
                droppedTerminalCount > 0
                    ? 'WebGL GPU timer results in this window were evicted from the bounded recorder'
                    : 'No complete WebGL GPU timer results were retained in this window'
            )
        }

        const measuredStartedAt = retained[0]?.startedAt ?? startedAt
        const measuredEndedAt = retained[retained.length - 1]?.endedAt ?? endedAt
        const retainedMeasured = retained.filter(result => result.status === 'measured')
        const retainedRejected = retained.filter(result => result.status !== 'measured')
        const rejectedSampleCount = retainedRejected.length + rejectionCount(dropped.rejected)
        const contextLost = dropped.rejected['context-lost'] > 0 || retainedRejected.some(result => result.status === 'context-lost')
        const disjoint = !contextLost && (dropped.rejected.disjoint > 0 || retainedRejected.some(result => result.status === 'disjoint'))
        const measuredTimes = retainedMeasured.map(result => result.timeMs)
        const measuredTimesValid = measuredTimes.every(
            value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_GPU_TIME_MS
        )
        const droppedTerminalCount = dropped.measured + rejectionCount(dropped.rejected)
        const valid = retainedMeasured.length > 0 && droppedTerminalCount === 0 && rejectedSampleCount === 0 && measuredTimesValid
        const gpuFrameMsP95 = valid ? percentile95(measuredTimes as number[]) : null
        const metrics: NonNullable<WebGlGpuTimerTargetRendererInspection['metrics']> = gpuFrameMsP95 === null ? {} : { gpuFrameMsP95 }

        return {
            family: backend,
            capability: { state: 'supported', observed: true, buffered: false },
            metrics,
            evidence: {
                window: { startedAt: measuredStartedAt, endedAt: measuredEndedAt },
                acceptedSampleCount: retainedMeasured.length + dropped.measured,
                retainedSampleCount: retainedMeasured.length,
                droppedSampleCount: dropped.measured,
                rejectedSampleCount,
                truncated: dropped.measured > 0,
                gpu: {
                    valid: valid && gpuFrameMsP95 !== null,
                    disjoint,
                    contextLost,
                    source: TARGET_GPU_TIMING_SOURCE,
                },
            },
        }
    }

    const inspect = (context?: WebGlGpuTimerTargetInspectionContext): WebGlGpuTimerTargetAdapterInspection => {
        let renderer: WebGlGpuTimerTargetRendererInspection
        if (!context) {
            renderer = unobservedTargetInspection('An SDK target inspection context is required')
        } else if (transactionDepth > 0) {
            renderer = unobservedTargetInspection('WebGL GPU timer state is changing')
        } else if (inspectionDepth > 0) {
            inspectionInvalidated = true
            renderer = unobservedTargetInspection('Reentrant target inspection is unavailable')
        } else {
            let evidenceWindow: WebGlGpuTimerTargetInspectionContext['evidenceWindow']
            const initialMutationVersion = targetMutationVersion
            inspectionInvalidated = false
            inspectionDepth += 1
            try {
                evidenceWindow = context.evidenceWindow
            } catch {
                renderer = unobservedTargetInspection('Target inspection context was unreadable')
                return {
                    inventory: { renderers: [backend] },
                    owners: [{ relation: 'renderer-host', label: 'Condev WebGL GPU timer' }],
                    renderer,
                }
            } finally {
                inspectionDepth = Math.max(0, inspectionDepth - 1)
            }
            if (capability === 'disposed' || inspectionInvalidated || targetMutationVersion !== initialMutationVersion) {
                renderer = unobservedTargetInspection('Target evidence changed during context inspection')
            } else {
                renderer = inspectWindow(evidenceWindow)
            }
        }
        return {
            inventory: { renderers: [backend] },
            owners: [{ relation: 'renderer-host', label: 'Condev WebGL GPU timer' }],
            renderer,
        }
    }

    return {
        backend,
        get supported(): boolean {
            return capability === 'supported'
        },
        beginFrame(): boolean {
            return runBooleanTransaction(() => {
                if (capability !== 'supported' || !api) return false
                beginAttemptCount = increment(beginAttemptCount)
                if (contextIsLost() !== false || capability !== 'supported' || !api || disposeRequested) return false
                if (activeQuery) {
                    skippedActiveCount = increment(skippedActiveCount)
                    return false
                }
                if ((beginAttemptCount - 1) % sampleEvery !== 0) return false
                if (pendingQueries.length >= maxPendingQueries) {
                    skippedCapacityCount = increment(skippedCapacityCount)
                    return false
                }
                if (hostQueryIsActive() !== false || capability !== 'supported' || !api || disposeRequested) return false
                if (readDisjoint() !== false || capability !== 'supported' || !api || disposeRequested) return false
                let startedAt = readNow()
                if (capability !== 'supported' || !api || disposeRequested) return false
                if (startedAt !== null && lastTargetClockAt !== null && startedAt < lastTargetClockAt) {
                    clockErrorCount = increment(clockErrorCount)
                    startedAt = null
                } else if (startedAt !== null) {
                    lastTargetClockAt = startedAt
                }

                const currentApi = api
                let query: unknown
                try {
                    query = currentApi.createQuery()
                } catch {
                    failRuntime()
                    return false
                }
                if (!isObject(query)) {
                    failRuntime()
                    return false
                }
                provisionalQuery = query
                if (disposeRequested || capability !== 'supported' || api !== currentApi) {
                    if (api === currentApi) safeDelete(query)
                    provisionalQuery = null
                    return false
                }
                try {
                    currentApi.beginQuery(query)
                } catch {
                    provisionalQuery = null
                    const contextLost = recheckContextLossAfterRuntimeFailure()
                    if (!contextLost && api) safeDelete(query)
                    if (!contextLost && !disposeRequested) fail()
                    return false
                }
                activeQuery = { query, startedAt, endedAt: null }
                provisionalQuery = null
                startedQueryCount = increment(startedQueryCount)
                return !disposeRequested
            })
        },
        endFrame(): boolean {
            return runBooleanTransaction(() => {
                if (capability !== 'supported' || !api || !activeQuery) return false
                const active = activeQuery
                if (contextIsLost() !== false || capability !== 'supported' || !api || activeQuery !== active || disposeRequested) {
                    return false
                }
                const currentApi = api
                try {
                    currentApi.endQuery()
                } catch {
                    // The first end attempt may have partially changed the host.
                    // Remove it before failure cleanup so endQuery is never retried.
                    activeQuery = null
                    const contextLost = recheckContextLossAfterRuntimeFailure()
                    if (!contextLost && api) safeDelete(active.query)
                    if (!contextLost && !disposeRequested) fail()
                    return false
                }
                activeQuery = null
                const pending: PendingQuery = {
                    query: active.query,
                    pollAttempts: 0,
                    startedAt: null,
                    endedAt: null,
                }
                pendingQueries.push(pending)
                if (disposeRequested || capability !== 'supported' || api !== currentApi) return false

                const rawEndedAt = readNow()
                if (disposeRequested || capability !== 'supported' || api !== currentApi) return false
                const frameDuration = rawEndedAt === null || active.startedAt === null ? Number.NaN : rawEndedAt - active.startedAt
                const clockRegressed = rawEndedAt !== null && lastTargetClockAt !== null && rawEndedAt < lastTargetClockAt
                const targetWindowValid =
                    active.startedAt !== null &&
                    rawEndedAt !== null &&
                    Number.isFinite(frameDuration) &&
                    frameDuration >= 0 &&
                    frameDuration <= MAX_GPU_TIME_MS &&
                    !clockRegressed
                if (!targetWindowValid && rawEndedAt !== null && active.startedAt !== null) {
                    clockErrorCount = increment(clockErrorCount)
                }
                if (rawEndedAt !== null && (lastTargetClockAt === null || rawEndedAt > lastTargetClockAt)) {
                    lastTargetClockAt = rawEndedAt
                }
                pending.startedAt = targetWindowValid ? active.startedAt : null
                pending.endedAt = targetWindowValid ? rawEndedAt : null
                return true
            })
        },
        poll(): void {
            runVoidTransaction(() => {
                // Polling while the caller is inside the measured render boundary
                // must never end or invalidate that active query unexpectedly.
                if (capability !== 'supported' || !api || activeQuery || pendingQueries.length === 0) return
                if (contextIsLost() !== false || capability !== 'supported' || !api || disposeRequested) return
                if (hostQueryIsActive() !== false || capability !== 'supported' || !api || disposeRequested) return
                const pending = pendingQueries[0]
                if (!pending) return
                pending.pollAttempts = increment(pending.pollAttempts)

                const currentApi = api
                let available: unknown
                try {
                    available = currentApi.readAvailable(pending.query)
                } catch {
                    failRuntime()
                    return
                }
                if (disposeRequested || capability !== 'supported' || api !== currentApi) return
                if (typeof available !== 'boolean') {
                    failRuntime()
                    return
                }
                // Follow the extension's availability -> disjoint -> result order.
                // The result is never fetched before both gates have passed.
                if (readDisjoint() !== false || capability !== 'supported' || !api || disposeRequested) return
                if (!available) {
                    if (pending.pollAttempts >= maxPollAttempts) {
                        pendingQueries.shift()
                        safeDelete(pending.query)
                        if (disposeRequested) return
                        timedOutQueryCount = increment(timedOutQueryCount)
                        invalidQueryCount = increment(invalidQueryCount)
                        if (pending.startedAt !== null && pending.endedAt !== null) {
                            recordTargetResult({ startedAt: pending.startedAt, endedAt: pending.endedAt }, 'invalid')
                        }
                        emit({ status: 'invalid', source: GPU_TIMING_SOURCE })
                    }
                    return
                }

                let nanoseconds: unknown
                try {
                    nanoseconds = currentApi.readResultNanoseconds(pending.query)
                } catch {
                    failRuntime()
                    return
                }
                if (disposeRequested || capability !== 'supported' || api !== currentApi) return
                if (contextIsLost() !== false || capability !== 'supported' || !api || disposeRequested) return
                pendingQueries.shift()
                safeDelete(pending.query)
                if (disposeRequested) return
                const timeMs = Number.isSafeInteger(nanoseconds) ? (nanoseconds as number) / NANOSECONDS_PER_MILLISECOND : Number.NaN
                if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > MAX_GPU_TIME_MS) {
                    invalidQueryCount = increment(invalidQueryCount)
                    if (pending.startedAt !== null && pending.endedAt !== null) {
                        recordTargetResult({ startedAt: pending.startedAt, endedAt: pending.endedAt }, 'invalid')
                    }
                    emit({ status: 'invalid', source: GPU_TIMING_SOURCE })
                    return
                }
                measuredQueryCount = increment(measuredQueryCount)
                if (pending.startedAt !== null && pending.endedAt !== null) {
                    recordTargetResult({ startedAt: pending.startedAt, endedAt: pending.endedAt }, 'measured', timeMs)
                }
                emit({
                    status: 'measured',
                    timeMs,
                    source: GPU_TIMING_SOURCE,
                })
            })
        },
        takeLatestEvidence(): WebGlGpuTimingEvidence | null {
            const evidence = latestEvidence
            latestEvidence = null
            return evidence
        },
        takeRendererHostTiming(): WebGlGpuTimerHostReading {
            // Keep an idle timer honest even when the host stops rendering and
            // therefore never calls beginFrame() or poll() after context loss.
            if (transactionDepth > 0) {
                return { gpuTimerCapability: hostCapability(capability), gpu: null }
            }
            let gpu: WebGlGpuTimingEvidence | null = null
            runVoidTransaction(() => {
                if (capability === 'supported') contextIsLost()
                if (disposeRequested) return
                gpu = latestEvidence
                latestEvidence = null
            })
            return {
                gpuTimerCapability: hostCapability(capability),
                gpu,
            }
        },
        inspectWindow,
        inspect,
        getSnapshot(): WebGlGpuTimerSnapshot {
            const retainedTargetResults = targetResults.toArray()
            const retainedTargetSampleCount = retainedTargetResults.filter(result => result.status === 'measured').length
            const retainedTargetRejectionCount = retainedTargetResults.length - retainedTargetSampleCount
            return {
                backend,
                capability,
                supported: capability === 'supported',
                counterBits,
                active: activeQuery !== null,
                pendingQueryCount: pendingQueries.length,
                evidenceBuffered: latestEvidence !== null,
                beginAttemptCount,
                startedQueryCount,
                measuredQueryCount,
                invalidQueryCount,
                disjointEpochCount,
                timedOutQueryCount,
                skippedActiveCount,
                skippedCapacityCount,
                skippedHostQueryCount,
                droppedEvidenceCount,
                targetResultCapacity: maxRetainedFrames,
                acceptedTargetSampleCount,
                retainedTargetSampleCount,
                droppedTargetSampleCount,
                rejectedTargetSampleCount,
                retainedTargetRejectionCount,
                droppedTargetRejectionCount: rejectionCount(droppedTargetRejections),
                clockErrorCount,
                errorCount,
            }
        },
        dispose(): void {
            if (capability === 'disposed') return
            if (transactionDepth > 0) {
                disposeRequested = true
                noteBlockedReentry()
                return
            }
            finalizeDispose()
        },
    }
}
