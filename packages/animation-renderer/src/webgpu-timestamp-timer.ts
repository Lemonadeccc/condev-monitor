// cspell:ignore webgpu readback unsubmitted

const GPU_TIMING_SOURCE = 'webgpu-timestamp-query' as const
const DEFAULT_SAMPLE_EVERY = 60
const DEFAULT_MAX_PENDING_FRAMES = 2
const MAX_SAMPLE_EVERY = 60_000
const MAX_PENDING_FRAMES = 8
const MAX_GPU_TIME_MS = 600_000
const QUERY_COUNT = 2
const QUERY_RESULT_BYTES = 16
const NANOSECONDS_PER_MILLISECOND = 1_000_000
const MAX_COUNTER = Number.MAX_SAFE_INTEGER

// Stable WebGPU bit values. Keeping them local avoids making the public
// declaration depend on GPUBufferUsage/GPUMapMode globals that TypeScript's
// DOM library does not currently provide in every consumer configuration.
const GPU_MAP_MODE_READ = 0x0001
const GPU_BUFFER_USAGE_MAP_READ = 0x0001
const GPU_BUFFER_USAGE_COPY_SRC = 0x0004
const GPU_BUFFER_USAGE_COPY_DST = 0x0008
const GPU_BUFFER_USAGE_QUERY_RESOLVE = 0x0200

export type WebGpuTimestampTimerCapability = 'supported' | 'unsupported' | 'device-lost' | 'error' | 'disposed'

/** Closed capability state shared with the renderer host evidence contract. */
export type WebGpuTimestampTimerHostCapability = 'supported' | 'unsupported' | 'disabled' | 'unknown'

export type WebGpuTimestampTimingEvidence =
    | {
          status: 'measured'
          timeMs: number
          source: typeof GPU_TIMING_SOURCE
      }
    | {
          status: 'invalid' | 'context-lost' | 'error'
          source: typeof GPU_TIMING_SOURCE
      }

export interface WebGpuTimestampTimerHostReading {
    gpuTimerCapability: WebGpuTimestampTimerHostCapability
    gpu: WebGpuTimestampTimingEvidence | null
}

/** Minimal structural counterpart of GPUSupportedFeatures. */
export interface WebGpuSupportedFeaturesLike {
    has(feature: 'timestamp-query'): boolean
}

/** Minimal structural counterpart of GPUQuerySet. */
export interface WebGpuQuerySetLike {
    destroy(): void
}

/** Minimal structural counterpart of the GPUBuffer methods used by this timer. */
export interface WebGpuBufferLike {
    mapAsync(mode: number, offset?: number, size?: number): PromiseLike<void>
    getMappedRange(offset?: number, size?: number): ArrayBuffer
    unmap(): void
    destroy(): void
}

export interface WebGpuDeviceLostInfoLike {
    readonly reason?: unknown
    readonly message?: unknown
}

export interface WebGpuQuerySetDescriptorLike {
    readonly type: 'timestamp'
    readonly count: 2
    readonly label?: string
}

export interface WebGpuBufferDescriptorLike {
    readonly size: 16
    readonly usage: number
    readonly mappedAtCreation?: false
    readonly label?: string
}

/**
 * Narrow structural device contract. Generic query/buffer types preserve the
 * nominal brands supplied by @webgpu/types or a browser's future DOM types.
 */
export interface WebGpuDeviceLike<QuerySet extends WebGpuQuerySetLike, Buffer extends WebGpuBufferLike> {
    readonly features: WebGpuSupportedFeaturesLike
    readonly lost: PromiseLike<WebGpuDeviceLostInfoLike>
    createQuerySet(descriptor: WebGpuQuerySetDescriptorLike): QuerySet
    createBuffer(descriptor: WebGpuBufferDescriptorLike): Buffer
}

/** Minimal structural counterpart of the command-encoder methods used here. */
export interface WebGpuCommandEncoderLike<QuerySet extends WebGpuQuerySetLike, Buffer extends WebGpuBufferLike> {
    resolveQuerySet(querySet: QuerySet, firstQuery: number, queryCount: number, destination: Buffer, destinationOffset: number): void
    copyBufferToBuffer(source: Buffer, sourceOffset: number, destination: Buffer, destinationOffset: number, size: number): void
}

export interface WebGpuTimestampWritesLike<QuerySet extends WebGpuQuerySetLike> {
    readonly querySet: QuerySet
    readonly beginningOfPassWriteIndex: 0
    readonly endOfPassWriteIndex: 1
}

/** Timestamp writes attached only to the first pass of a multi-pass frame. */
export interface WebGpuFrameStartTimestampWritesLike<QuerySet extends WebGpuQuerySetLike> {
    readonly querySet: QuerySet
    readonly beginningOfPassWriteIndex: 0
}

/** Timestamp writes attached only to the last pass of a multi-pass frame. */
export interface WebGpuFrameEndTimestampWritesLike<QuerySet extends WebGpuQuerySetLike> {
    readonly querySet: QuerySet
    readonly endOfPassWriteIndex: 1
}

export interface WebGpuMultiPassBoundaryDescriptors<
    FirstDescriptor extends object,
    LastDescriptor extends object,
    QuerySet extends WebGpuQuerySetLike,
> {
    readonly firstPassDescriptor: FirstDescriptor & {
        readonly timestampWrites: WebGpuFrameStartTimestampWritesLike<QuerySet>
    }
    readonly lastPassDescriptor: LastDescriptor & {
        readonly timestampWrites: WebGpuFrameEndTimestampWritesLike<QuerySet>
    }
}

declare const WEBGPU_FRAME_TICKET: unique symbol

/** Opaque handle for one sampled renderer frame. */
export interface WebGpuTimestampFrameTicket<QuerySet extends WebGpuQuerySetLike> {
    readonly sampleId: number
    readonly [WEBGPU_FRAME_TICKET]: QuerySet
}

export interface WebGpuTimestampTimerOptions<QuerySet extends WebGpuQuerySetLike, Buffer extends WebGpuBufferLike> {
    /** The timer observes this device but never destroys it. */
    device: WebGpuDeviceLike<QuerySet, Buffer>
    /**
     * Required host attestation: the one instrumented render/compute pass is
     * the complete renderer frame represented by the resulting duration.
     */
    frameBoundary: 'single-pass-complete-frame'
    /** Sample the first eligible frame and then every Nth beginFrame call. Default: 60. */
    sampleEvery?: number
    /** Bound allocated/in-flight query and readback resource sets. Default: 2. */
    maxPendingFrames?: number
}

export interface WebGpuMultiPassTimestampTimerOptions<QuerySet extends WebGpuQuerySetLike, Buffer extends WebGpuBufferLike> {
    /** The timer observes this device but never destroys it. */
    device: WebGpuDeviceLike<QuerySet, Buffer>
    /**
     * Required host attestation: the returned first/last descriptors delimit
     * the complete renderer frame in one command encoder/command buffer.
     */
    frameBoundary: 'multi-pass-single-command-buffer-complete-frame'
    /** Sample the first eligible frame and then every Nth beginFrame call. Default: 60. */
    sampleEvery?: number
    /** Bound allocated/in-flight query and readback resource sets. Default: 2. */
    maxPendingFrames?: number
}

export interface WebGpuTimestampTimerSnapshot {
    backend: 'webgpu'
    capability: WebGpuTimestampTimerCapability
    supported: boolean
    pendingFrameCount: number
    mappingFrameCount: number
    evidenceBuffered: boolean
    beginAttemptCount: number
    startedFrameCount: number
    measuredFrameCount: number
    invalidFrameCount: number
    cancelledFrameCount: number
    skippedCapacityCount: number
    rejectedTicketCount: number
    conflictingTimestampWritesCount: number
    abandonedCommandFrameCount: number
    droppedEvidenceCount: number
    deviceLostCount: number
    errorCount: number
}

export interface WebGpuTimestampTimerCommon<QuerySet extends WebGpuQuerySetLike> {
    readonly backend: 'webgpu'
    readonly supported: boolean
    /** Allocates a sparse, bounded query/readback set. Null means this frame is not sampled. */
    beginFrame(): WebGpuTimestampFrameTicket<QuerySet> | null
    /**
     * Call synchronously after the application's queue.submit succeeds. This
     * is the only method that starts asynchronous MAP_READ.
     */
    notifySubmitted(ticket: WebGpuTimestampFrameTicket<QuerySet>, submission: 'associated-command-stream-submitted'): boolean
    /**
     * Releases an unsubmitted ticket. Once an instrumented descriptor has been
     * returned, pass `will-not-submit` to attest that every command encoder
     * using it will be discarded; otherwise resources remain intact.
     */
    cancelFrame(ticket: WebGpuTimestampFrameTicket<QuerySet>, commandStream?: 'will-not-submit'): boolean
    /** Consume once so a resolved query cannot be recorded on multiple captures. */
    takeLatestEvidence(): WebGpuTimestampTimingEvidence | null
    /** Consume the latest result together with an explicit host capability. */
    takeRendererHostTiming(): WebGpuTimestampTimerHostReading
    getSnapshot(): WebGpuTimestampTimerSnapshot
    /** Releases only resources created by this timer. It never destroys the application device. */
    dispose(): void
}

export interface WebGpuTimestampTimer<QuerySet extends WebGpuQuerySetLike, Buffer extends WebGpuBufferLike>
    extends WebGpuTimestampTimerCommon<QuerySet> {
    /**
     * Returns a shallow copy with this timer's timestampWrites. Existing
     * timestampWrites are never overwritten. Use the returned descriptor for
     * exactly one render or compute pass.
     */
    instrumentPassDescriptor<Descriptor extends object>(
        ticket: WebGpuTimestampFrameTicket<QuerySet>,
        descriptor: Descriptor
    ): (Descriptor & { readonly timestampWrites: WebGpuTimestampWritesLike<QuerySet> }) | null
    /** Encodes resolve/copy after the instrumented pass has ended. It does not finish or submit the encoder. */
    endFrame(ticket: WebGpuTimestampFrameTicket<QuerySet>, encoder: WebGpuCommandEncoderLike<QuerySet, Buffer>): boolean
}

export interface WebGpuMultiPassTimestampTimer<QuerySet extends WebGpuQuerySetLike, Buffer extends WebGpuBufferLike>
    extends WebGpuTimestampTimerCommon<QuerySet> {
    /**
     * Atomically instruments two distinct descriptors. Neither descriptor is
     * returned when either boundary conflicts or caller access is re-entrant.
     */
    instrumentFrameBoundaryPasses<FirstDescriptor extends object, LastDescriptor extends object>(
        ticket: WebGpuTimestampFrameTicket<QuerySet>,
        firstDescriptor: FirstDescriptor,
        lastDescriptor: LastDescriptor
    ): WebGpuMultiPassBoundaryDescriptors<FirstDescriptor, LastDescriptor, QuerySet> | null
    /** Encodes resolve/copy after every pass has ended on the associated encoder. */
    endFrame(
        ticket: WebGpuTimestampFrameTicket<QuerySet>,
        encoder: WebGpuCommandEncoderLike<QuerySet, Buffer>,
        completion: 'all-frame-passes-ended-on-associated-encoder'
    ): boolean
}

export class WebGpuTimestampTimerOptionsError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'WebGpuTimestampTimerOptionsError'
    }
}

type FrameState = 'created' | 'instrumenting' | 'instrumented' | 'encoding' | 'encoded' | 'submitted' | 'mapping'

type CallerOperation = 'begin' | 'instrument' | 'encode' | 'submit' | 'cleanup'

interface FrameRecord<QuerySet extends WebGpuQuerySetLike, Buffer extends WebGpuBufferLike> {
    sampleId: number
    ticket: WebGpuTimestampFrameTicket<QuerySet>
    querySet: QuerySet
    resolveBuffer: Buffer
    readBuffer: Buffer
    state: FrameState
}

type WebGpuTimestampTimerMode = 'single-pass' | 'multi-pass'

interface WebGpuTimestampTimerCoreOptions<QuerySet extends WebGpuQuerySetLike, Buffer extends WebGpuBufferLike> {
    device: WebGpuDeviceLike<QuerySet, Buffer>
    sampleEvery?: number
    maxPendingFrames?: number
}

interface WebGpuTimestampTimerInternal<QuerySet extends WebGpuQuerySetLike, Buffer extends WebGpuBufferLike>
    extends WebGpuTimestampTimerCommon<QuerySet> {
    instrumentPassDescriptor<Descriptor extends object>(
        ticket: WebGpuTimestampFrameTicket<QuerySet>,
        descriptor: Descriptor
    ): (Descriptor & { readonly timestampWrites: WebGpuTimestampWritesLike<QuerySet> }) | null
    instrumentFrameBoundaryPasses<FirstDescriptor extends object, LastDescriptor extends object>(
        ticket: WebGpuTimestampFrameTicket<QuerySet>,
        firstDescriptor: FirstDescriptor,
        lastDescriptor: LastDescriptor
    ): WebGpuMultiPassBoundaryDescriptors<FirstDescriptor, LastDescriptor, QuerySet> | null
    endFrame(
        ticket: WebGpuTimestampFrameTicket<QuerySet>,
        encoder: WebGpuCommandEncoderLike<QuerySet, Buffer>,
        completion?: 'all-frame-passes-ended-on-associated-encoder'
    ): boolean
}

interface DeviceLostListener {
    onLost(): void
    onError(): void
}

interface DeviceLostHub {
    state: 'pending' | 'lost' | 'error'
    listeners: Set<DeviceLostListener>
}

const deviceLostHubs = new WeakMap<object, DeviceLostHub>()

function increment(value: number): number {
    return value >= MAX_COUNTER ? MAX_COUNTER : value + 1
}

function isObject(value: unknown): value is object {
    return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function requireBoundedInteger(name: string, value: unknown, defaultValue: number, maximum: number): number {
    const normalized = value === undefined ? defaultValue : value
    if (typeof normalized !== 'number' || !Number.isInteger(normalized) || normalized < 1 || normalized > maximum) {
        throw new WebGpuTimestampTimerOptionsError(`${name} must be an integer between 1 and ${maximum}`)
    }
    return normalized
}

function hostCapability(capability: WebGpuTimestampTimerCapability): WebGpuTimestampTimerHostCapability {
    if (capability === 'supported') return 'supported'
    if (capability === 'unsupported') return 'unsupported'
    if (capability === 'disposed') return 'disabled'
    return 'unknown'
}

function method<T extends object, K extends keyof T>(target: T, key: K): Extract<T[K], (...args: never[]) => unknown> | null {
    const value = target[key]
    return typeof value === 'function' ? (value as Extract<T[K], (...args: never[]) => unknown>) : null
}

function errorName(error: unknown): string | null {
    if (!isObject(error)) return null
    try {
        const name = Reflect.get(error, 'name')
        return typeof name === 'string' ? name : null
    } catch {
        return null
    }
}

interface PassDescriptorCopy {
    conflict: boolean
    descriptor: object | null
}

/**
 * Copy one pass descriptor with ordinary object-spread semantics while
 * intentionally omitting timestampWrites. Reading that caller-controlled
 * property exactly once avoids accessor/Proxy time-of-check re-entry.
 */
function copyPassDescriptorWithoutTimestampWrites(source: object): PassDescriptorCopy {
    if (Reflect.get(source, 'timestampWrites') !== undefined) {
        return { conflict: true, descriptor: null }
    }

    const descriptor: Record<PropertyKey, unknown> = {}
    for (const key of Reflect.ownKeys(source)) {
        const property = Reflect.getOwnPropertyDescriptor(source, key)
        if (!property?.enumerable || key === 'timestampWrites') continue
        Object.defineProperty(descriptor, key, {
            value: Reflect.get(source, key),
            enumerable: true,
            configurable: true,
            writable: true,
        })
    }
    return { conflict: false, descriptor }
}

function subscribeDeviceLost(device: object, lost: PromiseLike<WebGpuDeviceLostInfoLike>, listener: DeviceLostListener): () => void {
    let hub = deviceLostHubs.get(device)
    if (!hub) {
        hub = { state: 'pending', listeners: new Set() }
        deviceLostHubs.set(device, hub)
        const settle = (state: 'lost' | 'error'): void => {
            if (!hub || hub.state !== 'pending') return
            hub.state = state
            const listeners = [...hub.listeners]
            hub.listeners.clear()
            for (const current of listeners) {
                if (state === 'lost') current.onLost()
                else current.onError()
            }
        }
        Promise.resolve(lost).then(
            () => settle('lost'),
            () => settle('error')
        )
    }
    if (hub.state === 'lost') listener.onLost()
    else if (hub.state === 'error') listener.onError()
    else hub.listeners.add(listener)
    return () => {
        hub?.listeners.delete(listener)
    }
}

function createWebGpuTimestampTimerCore<QuerySet extends WebGpuQuerySetLike, Buffer extends WebGpuBufferLike>(
    options: WebGpuTimestampTimerCoreOptions<QuerySet, Buffer>,
    mode: WebGpuTimestampTimerMode
): WebGpuTimestampTimerInternal<QuerySet, Buffer> {
    const sampleEvery = requireBoundedInteger('sampleEvery', options.sampleEvery, DEFAULT_SAMPLE_EVERY, MAX_SAMPLE_EVERY)
    const maxPendingFrames = requireBoundedInteger(
        'maxPendingFrames',
        options.maxPendingFrames,
        DEFAULT_MAX_PENDING_FRAMES,
        MAX_PENDING_FRAMES
    )
    const device = options.device
    const records = new Map<object, FrameRecord<QuerySet, Buffer>>()
    let capability: WebGpuTimestampTimerCapability = 'unsupported'
    let latestEvidence: WebGpuTimestampTimingEvidence | null = null
    let beginAttemptCount = 0
    let startedFrameCount = 0
    let measuredFrameCount = 0
    let invalidFrameCount = 0
    let cancelledFrameCount = 0
    let skippedCapacityCount = 0
    let rejectedTicketCount = 0
    let conflictingTimestampWritesCount = 0
    let abandonedCommandFrameCount = 0
    let droppedEvidenceCount = 0
    let deviceLostCount = 0
    let errorCount = 0
    let nextSampleId = 1
    let highestSettledSampleId = 0
    let unsubscribeDeviceLost = (): void => {}
    let callerOperation: CallerOperation | null = null
    let callerOperationReentered = false
    let pendingDispose = false
    let drainPendingDispose = (): void => {}

    const rejectCallerOperationReentry = (): boolean => {
        if (callerOperation === null) return false
        callerOperationReentered = true
        rejectedTicketCount = increment(rejectedTicketCount)
        return true
    }

    const beginCallerOperation = (operation: CallerOperation): void => {
        callerOperation = operation
        callerOperationReentered = false
    }

    const endCallerOperation = (): boolean => {
        const reentered = callerOperationReentered
        callerOperation = null
        callerOperationReentered = false
        drainPendingDispose()
        return reentered
    }

    const emit = (evidence: WebGpuTimestampTimingEvidence): void => {
        if (latestEvidence) droppedEvidenceCount = increment(droppedEvidenceCount)
        latestEvidence = evidence
    }

    const emitFrame = (record: FrameRecord<QuerySet, Buffer>, evidence: WebGpuTimestampTimingEvidence): void => {
        if (record.sampleId <= highestSettledSampleId) {
            droppedEvidenceCount = increment(droppedEvidenceCount)
            return
        }
        highestSettledSampleId = record.sampleId
        emit(evidence)
    }

    const noteError = (): void => {
        errorCount = increment(errorCount)
    }

    const safeResourceCall = (target: object, name: 'unmap' | 'destroy'): void => {
        try {
            const call = method(target as WebGpuBufferLike, name)
            if (call) Reflect.apply(call, target, [])
            else noteError()
        } catch {
            noteError()
        }
    }

    const releaseRecord = (record: FrameRecord<QuerySet, Buffer>, useApi: boolean): void => {
        records.delete(record.ticket as object)
        if (!useApi) return
        if (record.state === 'mapping') safeResourceCall(record.readBuffer, 'unmap')
        safeResourceCall(record.querySet, 'destroy')
        safeResourceCall(record.resolveBuffer, 'destroy')
        safeResourceCall(record.readBuffer, 'destroy')
    }

    const releaseAll = (mode: 'device-lost' | 'terminal'): void => {
        for (const record of [...records.values()]) {
            // Once an instrumented descriptor may have been encoded, destroying
            // its query set before a later host submit would poison that submit.
            // On terminal shutdown, abandon only those unconfirmed command
            // resources to normal WebGPU/GC lifetime instead of invalidating the
            // application's command buffer. Submitted resources are safe to end.
            const useApi =
                mode !== 'device-lost' &&
                (record.state === 'created' ||
                    record.state === 'instrumenting' ||
                    record.state === 'submitted' ||
                    record.state === 'mapping')
            if (mode === 'terminal' && !useApi) abandonedCommandFrameCount = increment(abandonedCommandFrameCount)
            releaseRecord(record, useApi)
        }
    }

    const performDispose = (): void => {
        if (capability === 'disposed') return
        unsubscribeDeviceLost()
        const releaseMode = capability === 'device-lost' ? 'device-lost' : 'terminal'
        capability = 'disposed'
        callerOperation = 'cleanup'
        callerOperationReentered = false
        releaseAll(releaseMode)
        callerOperation = null
        callerOperationReentered = false
        latestEvidence = null
    }

    drainPendingDispose = (): void => {
        if (!pendingDispose) return
        pendingDispose = false
        performDispose()
    }

    const fail = (): void => {
        if (capability === 'disposed' || capability === 'device-lost' || capability === 'error') return
        unsubscribeDeviceLost()
        noteError()
        capability = 'error'
        beginCallerOperation('cleanup')
        releaseAll('terminal')
        endCallerOperation()
        if (capability === 'error') emit({ status: 'error', source: GPU_TIMING_SOURCE })
    }

    const loseDevice = (): void => {
        if (capability === 'disposed' || capability === 'device-lost') return
        unsubscribeDeviceLost()
        deviceLostCount = increment(deviceLostCount)
        capability = 'device-lost'
        // Device loss invalidates every object. Drop references without calling
        // methods on resources whose underlying device is already gone.
        beginCallerOperation('cleanup')
        releaseAll('device-lost')
        endCallerOperation()
        if (capability === 'device-lost') emit({ status: 'context-lost', source: GPU_TIMING_SOURCE })
    }

    try {
        const features = Reflect.get(device, 'features')
        const lost = Reflect.get(device, 'lost')
        if (!isObject(features) || !isObject(lost)) throw new TypeError('device features and lost promise are required')
        const has = method(features as WebGpuSupportedFeaturesLike, 'has')
        const then = method(lost as PromiseLike<WebGpuDeviceLostInfoLike>, 'then')
        if (!has || !then) throw new TypeError('device features.has and lost.then are required')
        const enabled = Reflect.apply(has, features, ['timestamp-query'])
        if (typeof enabled !== 'boolean') throw new TypeError('features.has must return boolean')
        capability = enabled ? 'supported' : 'unsupported'
        unsubscribeDeviceLost = subscribeDeviceLost(device, lost as PromiseLike<WebGpuDeviceLostInfoLike>, {
            onLost: loseDevice,
            onError: fail,
        })
    } catch {
        capability = 'error'
        noteError()
        emit({ status: 'error', source: GPU_TIMING_SOURCE })
    }

    const lookup = (ticket: WebGpuTimestampFrameTicket<QuerySet>): FrameRecord<QuerySet, Buffer> | null => {
        if (!isObject(ticket)) {
            rejectedTicketCount = increment(rejectedTicketCount)
            return null
        }
        const record = records.get(ticket as object)
        if (!record || record.ticket !== ticket) {
            rejectedTicketCount = increment(rejectedTicketCount)
            return null
        }
        return record
    }

    const ownsDuringCallerOperation = (record: FrameRecord<QuerySet, Buffer>, state: FrameState): boolean =>
        !callerOperationReentered && capability === 'supported' && records.get(record.ticket as object) === record && record.state === state

    const settleMappedRecord = (record: FrameRecord<QuerySet, Buffer>): void => {
        if (capability !== 'supported' || records.get(record.ticket as object) !== record || record.state !== 'mapping') return
        let startNanoseconds: bigint | null = null
        let endNanoseconds: bigint | null = null
        let operationError = false
        beginCallerOperation('cleanup')
        try {
            const getMappedRange = method(record.readBuffer, 'getMappedRange')
            if (!getMappedRange) throw new TypeError('read buffer getMappedRange is required')
            if (!ownsDuringCallerOperation(record, 'mapping')) throw new TypeError('mapped buffer access was re-entrant')
            const value = Reflect.apply(getMappedRange, record.readBuffer, [0, QUERY_RESULT_BYTES])
            if (!(value instanceof ArrayBuffer)) throw new TypeError('getMappedRange must return ArrayBuffer')
            if (value.byteLength >= QUERY_RESULT_BYTES) {
                try {
                    const values = new BigUint64Array(value, 0, QUERY_COUNT)
                    startNanoseconds = values[0] ?? null
                    endNanoseconds = values[1] ?? null
                } catch {
                    startNanoseconds = null
                    endNanoseconds = null
                }
            }
            if (!ownsDuringCallerOperation(record, 'mapping')) throw new TypeError('mapped buffer read was re-entrant')
        } catch {
            operationError = true
        }
        const operationReentered = endCallerOperation()
        if (
            operationError ||
            operationReentered ||
            capability !== 'supported' ||
            records.get(record.ticket as object) !== record ||
            record.state !== 'mapping'
        ) {
            fail()
            return
        }
        beginCallerOperation('cleanup')
        releaseRecord(record, true)
        endCallerOperation()
        if (capability !== 'supported') return

        if (
            startNanoseconds === null ||
            endNanoseconds === null ||
            (startNanoseconds === 0n && endNanoseconds === 0n) ||
            endNanoseconds < startNanoseconds
        ) {
            invalidFrameCount = increment(invalidFrameCount)
            emitFrame(record, { status: 'invalid', source: GPU_TIMING_SOURCE })
            return
        }
        const elapsedNanoseconds = endNanoseconds - startNanoseconds
        const maxNanoseconds = BigInt(MAX_GPU_TIME_MS) * BigInt(NANOSECONDS_PER_MILLISECOND)
        if (elapsedNanoseconds > maxNanoseconds) {
            invalidFrameCount = increment(invalidFrameCount)
            emitFrame(record, { status: 'invalid', source: GPU_TIMING_SOURCE })
            return
        }
        const timeMs = Number(elapsedNanoseconds) / NANOSECONDS_PER_MILLISECOND
        if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > MAX_GPU_TIME_MS) {
            invalidFrameCount = increment(invalidFrameCount)
            emitFrame(record, { status: 'invalid', source: GPU_TIMING_SOURCE })
            return
        }
        measuredFrameCount = increment(measuredFrameCount)
        emitFrame(record, { status: 'measured', timeMs, source: GPU_TIMING_SOURCE })
    }

    return {
        backend: 'webgpu',
        get supported(): boolean {
            return capability === 'supported'
        },
        beginFrame(): WebGpuTimestampFrameTicket<QuerySet> | null {
            if (rejectCallerOperationReentry()) return null
            if (capability !== 'supported') return null
            beginAttemptCount = increment(beginAttemptCount)
            if ((beginAttemptCount - 1) % sampleEvery !== 0) return null
            if (records.size >= maxPendingFrames) {
                skippedCapacityCount = increment(skippedCapacityCount)
                return null
            }

            let querySet: QuerySet | null = null
            let resolveBuffer: Buffer | null = null
            let readBuffer: Buffer | null = null
            let operationError = false
            beginCallerOperation('begin')
            try {
                const createQuerySet = method(device, 'createQuerySet')
                if (!createQuerySet) throw new TypeError('device query-set factory is required')
                if (callerOperationReentered || capability !== 'supported') throw new TypeError('device factory access was re-entrant')
                const createBuffer = method(device, 'createBuffer')
                if (!createBuffer) throw new TypeError('device buffer factory is required')
                if (callerOperationReentered || capability !== 'supported') throw new TypeError('device factory access was re-entrant')
                const createdQuerySet = Reflect.apply(createQuerySet, device, [
                    { type: 'timestamp', count: QUERY_COUNT, label: 'condev-webgpu-frame-timestamps' },
                ])
                if (!isObject(createdQuerySet)) throw new TypeError('device returned a malformed query set')
                querySet = createdQuerySet as QuerySet
                if (callerOperationReentered || capability !== 'supported') throw new TypeError('query-set creation was re-entrant')
                const createdResolveBuffer = Reflect.apply(createBuffer, device, [
                    {
                        size: QUERY_RESULT_BYTES,
                        usage: GPU_BUFFER_USAGE_QUERY_RESOLVE | GPU_BUFFER_USAGE_COPY_SRC,
                        label: 'condev-webgpu-timestamp-resolve',
                    },
                ])
                if (!isObject(createdResolveBuffer)) throw new TypeError('device returned a malformed resolve buffer')
                resolveBuffer = createdResolveBuffer as Buffer
                if (callerOperationReentered || capability !== 'supported') throw new TypeError('resolve-buffer creation was re-entrant')
                const createdReadBuffer = Reflect.apply(createBuffer, device, [
                    {
                        size: QUERY_RESULT_BYTES,
                        usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
                        label: 'condev-webgpu-timestamp-readback',
                    },
                ])
                if (!isObject(createdReadBuffer)) throw new TypeError('device returned a malformed read buffer')
                readBuffer = createdReadBuffer as Buffer
                if (callerOperationReentered || capability !== 'supported') throw new TypeError('read-buffer creation was re-entrant')
            } catch {
                operationError = true
            }
            const operationReentered = endCallerOperation()
            if (operationError || operationReentered || capability !== 'supported' || !querySet || !resolveBuffer || !readBuffer) {
                beginCallerOperation('cleanup')
                if (querySet) safeResourceCall(querySet, 'destroy')
                if (resolveBuffer) safeResourceCall(resolveBuffer, 'destroy')
                if (readBuffer) safeResourceCall(readBuffer, 'destroy')
                endCallerOperation()
                if (operationReentered) {
                    invalidFrameCount = increment(invalidFrameCount)
                    return null
                }
                if (capability !== 'supported') return null
                fail()
                return null
            }

            const sampleId = nextSampleId
            nextSampleId = increment(nextSampleId)
            const ticket = Object.freeze({ sampleId }) as WebGpuTimestampFrameTicket<QuerySet>
            records.set(ticket as object, {
                sampleId,
                ticket,
                querySet,
                resolveBuffer,
                readBuffer,
                state: 'created',
            })
            startedFrameCount = increment(startedFrameCount)
            return ticket
        },
        instrumentPassDescriptor<Descriptor extends object>(
            ticket: WebGpuTimestampFrameTicket<QuerySet>,
            descriptor: Descriptor
        ): (Descriptor & { readonly timestampWrites: WebGpuTimestampWritesLike<QuerySet> }) | null {
            if (rejectCallerOperationReentry()) return null
            if (mode !== 'single-pass') {
                rejectedTicketCount = increment(rejectedTicketCount)
                return null
            }
            const record = lookup(ticket)
            if (!record || record.state !== 'created' || !isObject(descriptor) || capability !== 'supported') {
                if (record && record.state !== 'created') rejectedTicketCount = increment(rejectedTicketCount)
                return null
            }
            let conflict = false
            let invalid = false
            let instrumented: object | null = null
            record.state = 'instrumenting'
            beginCallerOperation('instrument')
            try {
                const copied = copyPassDescriptorWithoutTimestampWrites(descriptor)
                if (!ownsDuringCallerOperation(record, 'instrumenting')) {
                    throw new TypeError('pass descriptor copy was re-entrant')
                }
                conflict = copied.conflict
                instrumented = copied.descriptor
                if (instrumented) {
                    const timestampWrites: WebGpuTimestampWritesLike<QuerySet> = Object.freeze({
                        querySet: record.querySet,
                        beginningOfPassWriteIndex: 0,
                        endOfPassWriteIndex: 1,
                    })
                    Object.defineProperty(instrumented, 'timestampWrites', {
                        value: timestampWrites,
                        enumerable: true,
                        configurable: true,
                        writable: true,
                    })
                }
            } catch {
                invalid = true
            }
            const operationReentered = endCallerOperation()
            const stillOwned = records.get(record.ticket as object) === record && record.state === 'instrumenting'
            if (conflict && !operationReentered && !invalid && stillOwned && capability === 'supported') {
                conflictingTimestampWritesCount = increment(conflictingTimestampWritesCount)
                beginCallerOperation('cleanup')
                releaseRecord(record, true)
                endCallerOperation()
                return null
            }
            if (operationReentered || invalid || !stillOwned || capability !== 'supported' || !instrumented) {
                invalidFrameCount = increment(invalidFrameCount)
                if (stillOwned) {
                    beginCallerOperation('cleanup')
                    releaseRecord(record, true)
                    endCallerOperation()
                }
                return null
            }
            record.state = 'instrumented'
            return instrumented as Descriptor & { readonly timestampWrites: WebGpuTimestampWritesLike<QuerySet> }
        },
        instrumentFrameBoundaryPasses<FirstDescriptor extends object, LastDescriptor extends object>(
            ticket: WebGpuTimestampFrameTicket<QuerySet>,
            firstDescriptor: FirstDescriptor,
            lastDescriptor: LastDescriptor
        ): WebGpuMultiPassBoundaryDescriptors<FirstDescriptor, LastDescriptor, QuerySet> | null {
            if (rejectCallerOperationReentry()) return null
            if (mode !== 'multi-pass') {
                rejectedTicketCount = increment(rejectedTicketCount)
                return null
            }
            const record = lookup(ticket)
            if (
                !record ||
                record.state !== 'created' ||
                !isObject(firstDescriptor) ||
                !isObject(lastDescriptor) ||
                Object.is(firstDescriptor, lastDescriptor) ||
                capability !== 'supported'
            ) {
                if (record && record.state !== 'created') rejectedTicketCount = increment(rejectedTicketCount)
                else if (
                    record &&
                    (!isObject(firstDescriptor) || !isObject(lastDescriptor) || Object.is(firstDescriptor, lastDescriptor))
                ) {
                    invalidFrameCount = increment(invalidFrameCount)
                    beginCallerOperation('cleanup')
                    releaseRecord(record, true)
                    endCallerOperation()
                }
                return null
            }

            let conflict = false
            let invalid = false
            let firstCopy: object | null = null
            let lastCopy: object | null = null
            record.state = 'instrumenting'
            beginCallerOperation('instrument')
            try {
                const copiedFirst = copyPassDescriptorWithoutTimestampWrites(firstDescriptor)
                if (!ownsDuringCallerOperation(record, 'instrumenting')) {
                    throw new TypeError('first pass descriptor copy was re-entrant')
                }
                const copiedLast = copiedFirst.conflict
                    ? { conflict: false, descriptor: null }
                    : copyPassDescriptorWithoutTimestampWrites(lastDescriptor)
                if (!ownsDuringCallerOperation(record, 'instrumenting')) {
                    throw new TypeError('last pass descriptor copy was re-entrant')
                }
                conflict = copiedFirst.conflict || copiedLast.conflict
                firstCopy = copiedFirst.descriptor
                lastCopy = copiedLast.descriptor
                if (firstCopy && lastCopy) {
                    const firstTimestampWrites: WebGpuFrameStartTimestampWritesLike<QuerySet> = Object.freeze({
                        querySet: record.querySet,
                        beginningOfPassWriteIndex: 0,
                    })
                    const lastTimestampWrites: WebGpuFrameEndTimestampWritesLike<QuerySet> = Object.freeze({
                        querySet: record.querySet,
                        endOfPassWriteIndex: 1,
                    })
                    Object.defineProperty(firstCopy, 'timestampWrites', {
                        value: firstTimestampWrites,
                        enumerable: true,
                        configurable: true,
                        writable: true,
                    })
                    Object.defineProperty(lastCopy, 'timestampWrites', {
                        value: lastTimestampWrites,
                        enumerable: true,
                        configurable: true,
                        writable: true,
                    })
                }
            } catch {
                invalid = true
            }

            const operationReentered = endCallerOperation()
            const stillOwned = records.get(record.ticket as object) === record && record.state === 'instrumenting'
            if (conflict && !operationReentered && !invalid && stillOwned && capability === 'supported') {
                conflictingTimestampWritesCount = increment(conflictingTimestampWritesCount)
                beginCallerOperation('cleanup')
                releaseRecord(record, true)
                endCallerOperation()
                return null
            }
            if (operationReentered || invalid || !stillOwned || capability !== 'supported' || !firstCopy || !lastCopy) {
                invalidFrameCount = increment(invalidFrameCount)
                if (stillOwned) {
                    beginCallerOperation('cleanup')
                    releaseRecord(record, true)
                    endCallerOperation()
                }
                return null
            }

            record.state = 'instrumented'
            return {
                firstPassDescriptor: firstCopy,
                lastPassDescriptor: lastCopy,
            } as WebGpuMultiPassBoundaryDescriptors<FirstDescriptor, LastDescriptor, QuerySet>
        },
        endFrame(
            ticket: WebGpuTimestampFrameTicket<QuerySet>,
            encoder: WebGpuCommandEncoderLike<QuerySet, Buffer>,
            completion?: 'all-frame-passes-ended-on-associated-encoder'
        ): boolean {
            if (rejectCallerOperationReentry()) return false
            const record = lookup(ticket)
            if (
                !record ||
                record.state !== 'instrumented' ||
                !isObject(encoder) ||
                capability !== 'supported' ||
                (mode === 'multi-pass' && completion !== 'all-frame-passes-ended-on-associated-encoder')
            ) {
                if (record && record.state !== 'instrumented') rejectedTicketCount = increment(rejectedTicketCount)
                else if (record && mode === 'multi-pass' && completion !== 'all-frame-passes-ended-on-associated-encoder') {
                    rejectedTicketCount = increment(rejectedTicketCount)
                }
                return false
            }
            let operationError = false
            record.state = 'encoding'
            beginCallerOperation('encode')
            try {
                const resolveQuerySet = method(encoder, 'resolveQuerySet')
                if (
                    callerOperationReentered ||
                    capability !== 'supported' ||
                    records.get(record.ticket as object) !== record ||
                    record.state !== 'encoding'
                ) {
                    throw new TypeError('command encoder access was re-entrant')
                }
                const copyBufferToBuffer = method(encoder, 'copyBufferToBuffer')
                if (!resolveQuerySet || !copyBufferToBuffer) throw new TypeError('command encoder methods are required')
                if (
                    callerOperationReentered ||
                    capability !== 'supported' ||
                    records.get(record.ticket as object) !== record ||
                    record.state !== 'encoding'
                ) {
                    throw new TypeError('command encoder access was re-entrant')
                }
                Reflect.apply(resolveQuerySet, encoder, [record.querySet, 0, QUERY_COUNT, record.resolveBuffer, 0])
                if (
                    callerOperationReentered ||
                    capability !== 'supported' ||
                    records.get(record.ticket as object) !== record ||
                    record.state !== 'encoding'
                ) {
                    throw new TypeError('query resolve was re-entrant')
                }
                Reflect.apply(copyBufferToBuffer, encoder, [record.resolveBuffer, 0, record.readBuffer, 0, QUERY_RESULT_BYTES])
                if (
                    callerOperationReentered ||
                    capability !== 'supported' ||
                    records.get(record.ticket as object) !== record ||
                    record.state !== 'encoding'
                ) {
                    throw new TypeError('readback copy was re-entrant')
                }
            } catch {
                operationError = true
            }
            const operationReentered = endCallerOperation()
            if (
                operationError ||
                operationReentered ||
                capability !== 'supported' ||
                records.get(record.ticket as object) !== record ||
                record.state !== 'encoding'
            ) {
                fail()
                return false
            }
            record.state = 'encoded'
            return true
        },
        notifySubmitted(ticket: WebGpuTimestampFrameTicket<QuerySet>, submission: 'associated-command-stream-submitted'): boolean {
            if (rejectCallerOperationReentry()) return false
            const record = lookup(ticket)
            if (
                !record ||
                record.state !== 'encoded' ||
                submission !== 'associated-command-stream-submitted' ||
                capability !== 'supported'
            ) {
                if (record && record.state !== 'encoded') rejectedTicketCount = increment(rejectedTicketCount)
                else if (record && submission !== 'associated-command-stream-submitted') {
                    rejectedTicketCount = increment(rejectedTicketCount)
                }
                return false
            }
            let mapping: Promise<void> | null = null
            let operationError = false
            record.state = 'submitted'
            beginCallerOperation('submit')
            try {
                const mapAsync = method(record.readBuffer, 'mapAsync')
                if (!mapAsync) throw new TypeError('read buffer mapAsync is required')
                if (
                    callerOperationReentered ||
                    capability !== 'supported' ||
                    records.get(record.ticket as object) !== record ||
                    record.state !== 'submitted'
                ) {
                    throw new TypeError('read buffer access was re-entrant')
                }
                const result = Reflect.apply(mapAsync, record.readBuffer, [GPU_MAP_MODE_READ, 0, QUERY_RESULT_BYTES])
                if (!isObject(result)) throw new TypeError('mapAsync returned an invalid result')
                const then = method(result as PromiseLike<void>, 'then')
                if (!then) throw new TypeError('mapAsync must return a promise')
                let thenCallError = false
                mapping = new Promise<void>((resolve, reject) => {
                    try {
                        Reflect.apply(then, result, [resolve, reject])
                    } catch (error) {
                        thenCallError = true
                        reject(error)
                    }
                })
                if (
                    thenCallError ||
                    callerOperationReentered ||
                    capability !== 'supported' ||
                    records.get(record.ticket as object) !== record ||
                    record.state !== 'submitted'
                ) {
                    throw new TypeError('mapAsync promise subscription was re-entrant')
                }
            } catch {
                operationError = true
            }
            const operationReentered = endCallerOperation()
            if (
                operationError ||
                operationReentered ||
                !mapping ||
                capability !== 'supported' ||
                records.get(record.ticket as object) !== record ||
                record.state !== 'submitted'
            ) {
                if (mapping) void mapping.catch(() => {})
                fail()
                return false
            }
            record.state = 'mapping'
            mapping.then(
                () => settleMappedRecord(record),
                error => {
                    if (records.get(record.ticket as object) !== record || capability === 'disposed') return
                    beginCallerOperation('submit')
                    const name = errorName(error)
                    const operationReentered = endCallerOperation()
                    if (operationReentered) fail()
                    else if (name === 'AbortError') loseDevice()
                    else fail()
                }
            )
            return true
        },
        cancelFrame(ticket: WebGpuTimestampFrameTicket<QuerySet>, commandStream?: 'will-not-submit'): boolean {
            if (rejectCallerOperationReentry()) return false
            const record = lookup(ticket)
            if (!record || record.state === 'mapping' || capability !== 'supported') {
                if (record && record.state === 'mapping') rejectedTicketCount = increment(rejectedTicketCount)
                return false
            }
            if (record.state !== 'created' && commandStream !== 'will-not-submit') {
                rejectedTicketCount = increment(rejectedTicketCount)
                return false
            }
            cancelledFrameCount = increment(cancelledFrameCount)
            beginCallerOperation('cleanup')
            releaseRecord(record, true)
            endCallerOperation()
            return true
        },
        takeLatestEvidence(): WebGpuTimestampTimingEvidence | null {
            if (rejectCallerOperationReentry()) return null
            const evidence = latestEvidence
            latestEvidence = null
            return evidence
        },
        takeRendererHostTiming(): WebGpuTimestampTimerHostReading {
            if (rejectCallerOperationReentry()) {
                return {
                    gpuTimerCapability: hostCapability(capability),
                    gpu: null,
                }
            }
            const gpu = latestEvidence
            latestEvidence = null
            return {
                gpuTimerCapability: hostCapability(capability),
                gpu,
            }
        },
        getSnapshot(): WebGpuTimestampTimerSnapshot {
            let mappingFrameCount = 0
            for (const record of records.values()) {
                if (record.state === 'mapping') mappingFrameCount = increment(mappingFrameCount)
            }
            return {
                backend: 'webgpu',
                capability,
                supported: capability === 'supported',
                pendingFrameCount: records.size,
                mappingFrameCount,
                evidenceBuffered: latestEvidence !== null,
                beginAttemptCount,
                startedFrameCount,
                measuredFrameCount,
                invalidFrameCount,
                cancelledFrameCount,
                skippedCapacityCount,
                rejectedTicketCount,
                conflictingTimestampWritesCount,
                abandonedCommandFrameCount,
                droppedEvidenceCount,
                deviceLostCount,
                errorCount,
            }
        },
        dispose(): void {
            if (capability === 'disposed') return
            if (callerOperation !== null) {
                pendingDispose = true
                rejectCallerOperationReentry()
                return
            }
            performDispose()
        },
    }
}

export function createWebGpuTimestampTimer<QuerySet extends WebGpuQuerySetLike, Buffer extends WebGpuBufferLike>(
    options: WebGpuTimestampTimerOptions<QuerySet, Buffer>
): WebGpuTimestampTimer<QuerySet, Buffer> {
    if (!options || !isObject(options.device)) throw new WebGpuTimestampTimerOptionsError('device must be a WebGPU device')
    if (options.frameBoundary !== 'single-pass-complete-frame') {
        throw new WebGpuTimestampTimerOptionsError('frameBoundary must explicitly be single-pass-complete-frame')
    }
    return createWebGpuTimestampTimerCore(options, 'single-pass')
}

export function createWebGpuMultiPassTimestampTimer<QuerySet extends WebGpuQuerySetLike, Buffer extends WebGpuBufferLike>(
    options: WebGpuMultiPassTimestampTimerOptions<QuerySet, Buffer>
): WebGpuMultiPassTimestampTimer<QuerySet, Buffer> {
    if (!options || !isObject(options.device)) throw new WebGpuTimestampTimerOptionsError('device must be a WebGPU device')
    if (options.frameBoundary !== 'multi-pass-single-command-buffer-complete-frame') {
        throw new WebGpuTimestampTimerOptionsError('frameBoundary must explicitly be multi-pass-single-command-buffer-complete-frame')
    }
    return createWebGpuTimestampTimerCore(options, 'multi-pass')
}
