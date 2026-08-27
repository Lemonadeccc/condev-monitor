// cspell:ignore disjoint webgl

const WEBGL1_EXTENSION = 'EXT_disjoint_timer_query'
const WEBGL2_EXTENSION = 'EXT_disjoint_timer_query_webgl2'
const GPU_TIMING_SOURCE = 'webgl-disjoint-timer-query' as const
const DEFAULT_SAMPLE_EVERY = 60
const DEFAULT_MAX_PENDING_QUERIES = 2
const DEFAULT_MAX_POLL_ATTEMPTS = 240
const MAX_SAMPLE_EVERY = 60_000
const MAX_PENDING_QUERIES = 8
const MAX_POLL_ATTEMPTS = 60_000
const MAX_GPU_TIME_MS = 600_000
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

interface PendingQuery {
    query: QueryObject
    pollAttempts: number
}

const contextOwners = new WeakMap<object, symbol>()

function increment(value: number): number {
    return value >= MAX_COUNTER ? MAX_COUNTER : value + 1
}

function requireBoundedInteger(name: string, value: unknown, defaultValue: number, maximum: number): number {
    const normalized = value === undefined ? defaultValue : value
    if (typeof normalized !== 'number' || !Number.isInteger(normalized) || normalized < 1 || normalized > maximum) {
        throw new WebGlGpuTimerOptionsError(`${name} must be an integer between 1 and ${maximum}`)
    }
    return normalized
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
    if (!options || !isObject(options.gl)) throw new WebGlGpuTimerOptionsError('gl must be a WebGL rendering context')
    if (options.backend !== 'webgl' && options.backend !== 'webgl2') {
        throw new WebGlGpuTimerOptionsError('backend must be webgl or webgl2')
    }
    if (options.disjointQueryOwnership !== 'exclusive') {
        throw new WebGlGpuTimerOptionsError('disjointQueryOwnership must explicitly be exclusive')
    }
    const sampleEvery = requireBoundedInteger('sampleEvery', options.sampleEvery, DEFAULT_SAMPLE_EVERY, MAX_SAMPLE_EVERY)
    const maxPendingQueries = requireBoundedInteger(
        'maxPendingQueries',
        options.maxPendingQueries,
        DEFAULT_MAX_PENDING_QUERIES,
        MAX_PENDING_QUERIES
    )
    const maxPollAttempts = requireBoundedInteger('maxPollAttempts', options.maxPollAttempts, DEFAULT_MAX_POLL_ATTEMPTS, MAX_POLL_ATTEMPTS)
    const backend = options.backend
    const gl = options.gl as unknown as WebGlContextBaseLike
    const contextKey = options.gl as unknown as object
    const owner = Symbol('condev-webgl-gpu-timer')
    const existingOwner = contextOwners.get(contextKey)
    let ownsContext = existingOwner === undefined
    if (ownsContext) contextOwners.set(contextKey, owner)

    let api: QueryApi | null = null
    let capability: WebGlGpuTimerCapability = existingOwner === undefined ? 'unsupported' : 'owner-conflict'
    let counterBits: number | null = null
    let activeQuery: QueryObject | null = null
    const pendingQueries: PendingQuery[] = []
    let latestEvidence: WebGlGpuTimingEvidence | null = null
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
    let errorCount = 0

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

    const safeDelete = (query: QueryObject): void => {
        if (!api) return
        try {
            api.deleteQuery(query)
        } catch {
            noteError()
        }
    }

    const clearQueries = (useApi: boolean): void => {
        if (activeQuery) {
            if (useApi && api) {
                try {
                    api.endQuery()
                } catch {
                    noteError()
                }
                safeDelete(activeQuery)
            }
            activeQuery = null
        }
        for (const pending of pendingQueries.splice(0)) {
            if (useApi) safeDelete(pending.query)
        }
    }

    const fail = (): void => {
        if (capability === 'disposed' || capability === 'context-lost') return
        noteError()
        clearQueries(true)
        capability = 'error'
        emit({ status: 'error', source: GPU_TIMING_SOURCE })
    }

    const loseContext = (): void => {
        if (capability === 'disposed' || capability === 'context-lost') return
        clearQueries(false)
        api = null
        counterBits = null
        capability = 'context-lost'
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

    const invalidateDisjointEpoch = (): void => {
        disjointEpochCount = increment(disjointEpochCount)
        clearQueries(true)
        emit({ status: 'disjoint', source: GPU_TIMING_SOURCE })
    }

    const readDisjoint = (): boolean | null => {
        if (!api) return null
        try {
            const disjoint = api.readDisjoint()
            if (typeof disjoint !== 'boolean') {
                fail()
                return null
            }
            // A sticky flag can predate this timer. Clear it before the first
            // owned query without inventing a rejected sample. It becomes
            // evidence only when at least one owned query is invalidated.
            if (disjoint && (activeQuery !== null || pendingQueries.length > 0)) invalidateDisjointEpoch()
            return disjoint
        } catch {
            fail()
            return null
        }
    }

    const hostQueryIsActive = (): boolean | null => {
        if (!api) return null
        let currentQuery: unknown
        try {
            currentQuery = api.readCurrentQuery()
        } catch {
            fail()
            return null
        }
        if (currentQuery === undefined) {
            fail()
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

    return {
        backend,
        get supported(): boolean {
            return capability === 'supported'
        },
        beginFrame(): boolean {
            if (capability !== 'supported' || !api) return false
            beginAttemptCount = increment(beginAttemptCount)
            if (contextIsLost() !== false || capability !== 'supported' || !api) return false
            if (activeQuery) {
                skippedActiveCount = increment(skippedActiveCount)
                return false
            }
            if ((beginAttemptCount - 1) % sampleEvery !== 0) return false
            if (pendingQueries.length >= maxPendingQueries) {
                skippedCapacityCount = increment(skippedCapacityCount)
                return false
            }
            if (hostQueryIsActive() !== false || capability !== 'supported' || !api) return false
            if (readDisjoint() !== false || capability !== 'supported' || !api) return false

            let query: unknown
            try {
                query = api.createQuery()
            } catch {
                fail()
                return false
            }
            if (!isObject(query)) {
                fail()
                return false
            }
            try {
                api.beginQuery(query)
            } catch {
                safeDelete(query)
                fail()
                return false
            }
            activeQuery = query
            startedQueryCount = increment(startedQueryCount)
            return true
        },
        endFrame(): boolean {
            if (capability !== 'supported' || !api || !activeQuery) return false
            if (contextIsLost() !== false || capability !== 'supported' || !api || !activeQuery) return false
            const query = activeQuery
            try {
                api.endQuery()
            } catch {
                fail()
                return false
            }
            activeQuery = null
            pendingQueries.push({ query, pollAttempts: 0 })
            return true
        },
        poll(): void {
            // Polling while the caller is inside the measured render boundary
            // must never end or invalidate that active query unexpectedly.
            if (capability !== 'supported' || !api || activeQuery || pendingQueries.length === 0) return
            if (contextIsLost() !== false || capability !== 'supported' || !api) return
            if (hostQueryIsActive() !== false || capability !== 'supported' || !api) return
            const pending = pendingQueries[0]
            if (!pending) return
            pending.pollAttempts = increment(pending.pollAttempts)

            let available: unknown
            try {
                available = api.readAvailable(pending.query)
            } catch {
                fail()
                return
            }
            if (typeof available !== 'boolean') {
                fail()
                return
            }
            // Follow the extension's availability -> disjoint -> result order.
            // The result is never fetched before both gates have passed.
            if (readDisjoint() !== false || capability !== 'supported' || !api) return
            if (!available) {
                if (pending.pollAttempts >= maxPollAttempts) {
                    pendingQueries.shift()
                    safeDelete(pending.query)
                    timedOutQueryCount = increment(timedOutQueryCount)
                    invalidQueryCount = increment(invalidQueryCount)
                    emit({ status: 'invalid', source: GPU_TIMING_SOURCE })
                }
                return
            }

            let nanoseconds: unknown
            try {
                nanoseconds = api.readResultNanoseconds(pending.query)
            } catch {
                fail()
                return
            }
            if (contextIsLost() !== false || capability !== 'supported' || !api) return
            pendingQueries.shift()
            safeDelete(pending.query)
            const timeMs = Number.isSafeInteger(nanoseconds) ? (nanoseconds as number) / NANOSECONDS_PER_MILLISECOND : Number.NaN
            if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > MAX_GPU_TIME_MS) {
                invalidQueryCount = increment(invalidQueryCount)
                emit({ status: 'invalid', source: GPU_TIMING_SOURCE })
                return
            }
            measuredQueryCount = increment(measuredQueryCount)
            emit({
                status: 'measured',
                timeMs,
                source: GPU_TIMING_SOURCE,
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
            if (capability === 'supported') contextIsLost()
            const gpu = latestEvidence
            latestEvidence = null
            return {
                gpuTimerCapability: hostCapability(capability),
                gpu,
            }
        },
        getSnapshot(): WebGlGpuTimerSnapshot {
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
                errorCount,
            }
        },
        dispose(): void {
            if (capability === 'disposed') return
            clearQueries(capability !== 'context-lost')
            api = null
            counterBits = null
            latestEvidence = null
            capability = 'disposed'
            releaseOwnership()
        },
    }
}
