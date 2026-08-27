// cspell:ignore readback webgpu

import type { WebGpuDeviceLostInfoLike } from './webgpu-timestamp-timer'

const DEFAULT_MAX_RETAINED_OPERATIONS = 512
const MAX_RETAINED_OPERATIONS = 4_096
const DEFAULT_MAX_PENDING_READBACKS = 2
const MAX_PENDING_READBACKS = 8
const MAX_DURATION_MS = 600_000
const MAX_CLOCK_MS = 1_000_000_000_000_000
const MAX_BYTES = 1_000_000_000_000
const MAX_COUNT = 1_000_000_000
const PromiseConstructor = Promise
const promiseThen = Promise.prototype.then
const reflectApply = Reflect.apply

export type WebGpuTransferRecorderCapability = 'supported' | 'device-lost' | 'error' | 'disposed'

export type WebGpuUploadKind =
    | 'queue-write-buffer'
    | 'queue-write-texture'
    | 'queue-copy-external-image-to-texture'
    | 'mapped-buffer-write-unmap'

export type WebGpuReadbackKind = 'buffer-map-read' | 'texture-to-buffer-map-read'

export interface WebGpuTransferDeviceLike {
    readonly lost: PromiseLike<WebGpuDeviceLostInfoLike>
}

export interface WebGpuUploadEvidence {
    kind: WebGpuUploadKind
    /** Caller-attested host-visible source bytes. Omit when the exact range is unknown. */
    bytes?: number
}

export interface WebGpuReadbackEvidence {
    kind: WebGpuReadbackKind
    /** Caller-attested mapped/copied byte range. Omit when the exact range is unknown. */
    bytes?: number
    /** Unverified caller attestation that the associated copy command stream was submitted before mapAsync. */
    submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted'
}

export interface WebGpuTransferRecorderOptions {
    /** The recorder observes device loss but never calls a device, queue, buffer, or texture method. */
    device: WebGpuTransferDeviceLike
    /** Number of completed operations retained locally. Default: 512; maximum: 4096. */
    maxRetainedOperations?: number
    /** Number of map-read promises observed concurrently. Default: 2; maximum: 8. */
    maxPendingReadbacks?: number
    /** Must share the target collector's clock domain. Defaults to performance.now(), then Date.now(). */
    now?: () => number
}

export interface WebGpuTransferTargetInspectionContext {
    readonly evidenceWindow: {
        readonly startedAt: number
        readonly endedAt: number
        readonly relation: 'selection-window' | 'interaction-window'
    }
}

export interface WebGpuTransferTargetRendererInspection {
    family: 'webgpu'
    capability: {
        state: 'supported' | 'unknown'
        observed: boolean
        buffered: false
        reason?: string
    }
    metrics?: {
        uploadBytes?: number
        readbackMsP95?: number
    }
    evidence?: {
        window: { startedAt: number; endedAt: number }
        acceptedSampleCount: number
        retainedSampleCount: number
        droppedSampleCount: number
        rejectedSampleCount: number
        truncated: boolean
    }
}

export interface WebGpuTransferTargetAdapterInspection {
    inventory: { renderers: readonly ['webgpu'] }
    owners: readonly [{ relation: 'renderer-host'; label: 'Condev WebGPU transfer recorder' }]
    renderer: WebGpuTransferTargetRendererInspection
}

export interface WebGpuTransferRecorderAggregate {
    /** Synchronous CPU call time, not GPU upload time. */
    uploadCallMsP95: number | null
    scheduledUploadBytes: number | null
    /** Host pre-operation-timestamp-to-Promise-reaction upper bound, including queue and microtask wait. */
    hostObservedReadbackReadyMsP95: number | null
    attestedReadbackBytes: number | null
    retainedMeasuredUploadKinds: Readonly<Record<WebGpuUploadKind, number>>
    retainedMeasuredReadbackKinds: Readonly<Record<WebGpuReadbackKind, number>>
}

export interface WebGpuTransferRecorderSnapshot {
    backend: 'webgpu'
    capability: WebGpuTransferRecorderCapability
    supported: boolean
    capacity: number
    maxPendingReadbacks: number
    pendingReadbackCount: number
    acceptedUploadCount: number
    acceptedReadbackCount: number
    retainedUploadCount: number
    retainedReadbackCount: number
    droppedUploadCount: number
    droppedReadbackCount: number
    rejectedUploadCount: number
    rejectedReadbackCount: number
    retainedRejectedUploadCount: number
    retainedRejectedReadbackCount: number
    droppedRejectedUploadCount: number
    droppedRejectedReadbackCount: number
    skippedReadbackCapacityCount: number
    reentrantOperationCount: number
    clockErrorCount: number
    observerErrorCount: number
    deviceLostCount: number
    uploadCorrelationInvalid: boolean
    readbackCorrelationInvalid: boolean
    aggregate: WebGpuTransferRecorderAggregate
}

export interface WebGpuTransferRecorder {
    readonly backend: 'webgpu'
    readonly supported: boolean
    /** Wraps one synchronous host-to-WebGPU transfer call and preserves its exact result/error. */
    measureUpload<T>(evidence: WebGpuUploadEvidence, operation: () => T): T
    /**
     * Observes one newly-created mapAsync promise. It returns a transparent
     * derived promise so fulfillment values and rejection objects are preserved
     * without hiding an unhandled rejection on the returned chain.
     */
    observeReadback<T>(evidence: WebGpuReadbackEvidence, operation: () => Promise<T>): Promise<T>
    inspectWindow(window: WebGpuTransferTargetInspectionContext['evidenceWindow']): WebGpuTransferTargetRendererInspection
    /** Bound callback for Browser animation.registerTarget(). Only one provider may own a canvas registration. */
    inspect(context?: WebGpuTransferTargetInspectionContext): WebGpuTransferTargetAdapterInspection
    getSnapshot(): WebGpuTransferRecorderSnapshot
    dispose(): void
}

export class WebGpuTransferRecorderOptionsError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'WebGpuTransferRecorderOptionsError'
    }
}

type TransferFamily = 'upload' | 'readback'
type TransferStatus = 'measured' | 'rejected'

interface TransferMetadata {
    kind: WebGpuUploadKind | WebGpuReadbackKind | null
    bytes: number | null
    bytesKnown: boolean
    valid: boolean
}

interface TransferRecord {
    family: TransferFamily
    status: TransferStatus
    kind: WebGpuUploadKind | WebGpuReadbackKind | null
    startedAt: number
    endedAt: number
    durationMs: number
    bytes: number | null
    bytesKnown: boolean
}

interface PendingReadback {
    startedAt: number
    metadata: TransferMetadata
}

interface DroppedTransferCounts {
    measuredUpload: number
    measuredReadback: number
    rejectedUpload: number
    rejectedReadback: number
}

interface DeviceLostListener {
    onLost(): void
    onError(): void
}

interface DeviceLostHub {
    state: 'pending' | 'lost' | 'error'
    listeners: Set<DeviceLostListener>
}

class BoundedRing<T> {
    private readonly values: Array<T | undefined>
    private cursor = 0
    private length = 0

    constructor(readonly capacity: number) {
        this.values = new Array<T | undefined>(capacity)
    }

    push(value: T): T | undefined {
        const evicted = this.length === this.capacity ? this.values[this.cursor] : undefined
        this.values[this.cursor] = value
        this.cursor = (this.cursor + 1) % this.capacity
        this.length = Math.min(this.length + 1, this.capacity)
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
}

const UPLOAD_KINDS = new Set<WebGpuUploadKind>([
    'queue-write-buffer',
    'queue-write-texture',
    'queue-copy-external-image-to-texture',
    'mapped-buffer-write-unmap',
])
const READBACK_KINDS = new Set<WebGpuReadbackKind>(['buffer-map-read', 'texture-to-buffer-map-read'])
const deviceLostHubs = new WeakMap<object, DeviceLostHub>()

function isObject(value: unknown): value is object {
    return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function boundedInteger(value: unknown, maximum: number): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null
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

function sumBytes(records: readonly TransferRecord[]): number | null {
    if (records.length === 0 || records.some(record => !record.bytesKnown || record.bytes === null)) return null
    let total = 0
    for (const record of records) {
        total += record.bytes ?? 0
        if (!Number.isSafeInteger(total) || total > MAX_BYTES) return null
    }
    return total
}

function emptyDroppedCounts(): DroppedTransferCounts {
    return { measuredUpload: 0, measuredReadback: 0, rejectedUpload: 0, rejectedReadback: 0 }
}

function increment(value: number): { value: number; exact: boolean } {
    return value >= MAX_COUNT ? { value: MAX_COUNT, exact: false } : { value: value + 1, exact: true }
}

function defaultNow(): number {
    return typeof performance === 'undefined' ? Date.now() : performance.now()
}

function sameRealmPromise(value: unknown): boolean | null {
    try {
        return value instanceof PromiseConstructor
    } catch {
        return null
    }
}

function attachPromise<T>(value: PromiseLike<T>, onFulfilled: (result: T) => void, onRejected: (error: unknown) => void): void {
    if (sameRealmPromise(value) === true) {
        void reflectApply(promiseThen, value, [onFulfilled, onRejected])
        return
    }
    const assimilated = new PromiseConstructor<T>(resolve => resolve(value))
    void reflectApply(promiseThen, assimilated, [onFulfilled, onRejected])
}

function passThroughPromise<T>(value: PromiseLike<T>): Promise<T> {
    return new PromiseConstructor<T>((resolve, reject) => {
        try {
            attachPromise(value, resolve, reject)
        } catch (error) {
            reject(error)
        }
    })
}

function subscribeDeviceLost(device: object, lost: PromiseLike<WebGpuDeviceLostInfoLike>, listener: DeviceLostListener): () => void {
    let hub = deviceLostHubs.get(device)
    if (!hub) {
        hub = { state: 'pending', listeners: new Set() }
        deviceLostHubs.set(device, hub)
        const currentHub = hub
        const settle = (state: 'lost' | 'error'): void => {
            if (currentHub.state !== 'pending') return
            currentHub.state = state
            const listeners = [...currentHub.listeners]
            currentHub.listeners.clear()
            for (const current of listeners) {
                if (state === 'lost') current.onLost()
                else current.onError()
            }
        }
        attachPromise(
            lost,
            () => settle('lost'),
            () => settle('error')
        )
    }
    if (hub.state === 'lost') listener.onLost()
    else if (hub.state === 'error') listener.onError()
    else hub.listeners.add(listener)
    return () => hub?.listeners.delete(listener)
}

function incrementKind<K extends string>(counts: Record<K, number>, kind: K): void {
    counts[kind] = Math.min(MAX_COUNT, counts[kind] + 1)
}

function uploadKindCounts(): Record<WebGpuUploadKind, number> {
    return {
        'queue-write-buffer': 0,
        'queue-write-texture': 0,
        'queue-copy-external-image-to-texture': 0,
        'mapped-buffer-write-unmap': 0,
    }
}

function readbackKindCounts(): Record<WebGpuReadbackKind, number> {
    return { 'buffer-map-read': 0, 'texture-to-buffer-map-read': 0 }
}

export function createWebGpuTransferRecorder(options: WebGpuTransferRecorderOptions): WebGpuTransferRecorder {
    let device: WebGpuTransferDeviceLike
    let lost: PromiseLike<WebGpuDeviceLostInfoLike>
    let now: () => number
    let maxRetainedOperations: number
    let maxPendingReadbacks: number
    try {
        if (!isObject(options)) throw new TypeError('options are required')
        const rawDevice = Reflect.get(options, 'device')
        if (!isObject(rawDevice)) throw new TypeError('device is required')
        const rawLost = Reflect.get(rawDevice, 'lost')
        if (!isObject(rawLost) || typeof Reflect.get(rawLost, 'then') !== 'function') {
            throw new TypeError('device.lost must be Promise-like')
        }
        const rawNow = Reflect.get(options, 'now')
        if (rawNow !== undefined && typeof rawNow !== 'function') throw new TypeError('now must be a function')
        const rawRetained = Reflect.get(options, 'maxRetainedOperations')
        const rawPending = Reflect.get(options, 'maxPendingReadbacks')
        maxRetainedOperations = rawRetained === undefined ? DEFAULT_MAX_RETAINED_OPERATIONS : rawRetained
        maxPendingReadbacks = rawPending === undefined ? DEFAULT_MAX_PENDING_READBACKS : rawPending
        if (!Number.isInteger(maxRetainedOperations) || maxRetainedOperations < 1 || maxRetainedOperations > MAX_RETAINED_OPERATIONS) {
            throw new TypeError(`maxRetainedOperations must be an integer between 1 and ${MAX_RETAINED_OPERATIONS}`)
        }
        if (!Number.isInteger(maxPendingReadbacks) || maxPendingReadbacks < 1 || maxPendingReadbacks > MAX_PENDING_READBACKS) {
            throw new TypeError(`maxPendingReadbacks must be an integer between 1 and ${MAX_PENDING_READBACKS}`)
        }
        device = rawDevice as WebGpuTransferDeviceLike
        lost = rawLost as PromiseLike<WebGpuDeviceLostInfoLike>
        now = (rawNow as (() => number) | undefined) ?? defaultNow
    } catch (error) {
        const message = error instanceof Error ? error.message : 'invalid WebGPU transfer recorder options'
        throw new WebGpuTransferRecorderOptionsError(message)
    }

    const records = new BoundedRing<TransferRecord>(maxRetainedOperations)
    const pendingReadbacks = new Set<PendingReadback>()
    const dropped = emptyDroppedCounts()
    let capability: WebGpuTransferRecorderCapability = 'supported'
    let acceptedUploadCount = 0
    let acceptedReadbackCount = 0
    let rejectedUploadCount = 0
    let rejectedReadbackCount = 0
    let skippedReadbackCapacityCount = 0
    let reentrantOperationCount = 0
    let clockErrorCount = 0
    let observerErrorCount = 0
    let deviceLostCount = 0
    let countersExact = true
    let uploadCorrelationInvalid = false
    let readbackCorrelationInvalid = false
    let evictedStartedAtMin: number | null = null
    let evictedEndedAtMax: number | null = null
    let lastClockAt: number | null = null
    let mutationVersion = 0
    let operationDepth = 0
    let activeOperationFamily: TransferFamily | null = null
    let operationInvalidated = false
    let inspectionDepth = 0
    let inspectionInvalidated = false
    let pendingDispose = false
    let unsubscribeDeviceLost = (): void => {}

    const mutate = (): void => {
        mutationVersion += 1
        if (inspectionDepth > 0) inspectionInvalidated = true
    }

    const noteCounter = (value: number): number => {
        const next = increment(value)
        if (!next.exact) countersExact = false
        return next.value
    }

    const invalidateFamilyCorrelation = (family: TransferFamily): void => {
        if (family === 'upload') uploadCorrelationInvalid = true
        else readbackCorrelationInvalid = true
        mutate()
    }

    const readNow = (family: TransferFamily): number | null => {
        try {
            const value = boundedTime(now())
            if (value !== null && (lastClockAt === null || value >= lastClockAt)) {
                lastClockAt = value
                return value
            }
        } catch {
            // Count below without exposing a host clock exception.
        }
        clockErrorCount = noteCounter(clockErrorCount)
        invalidateFamilyCorrelation(family)
        return null
    }

    const beginOperation = (family: TransferFamily): void => {
        operationDepth = 1
        activeOperationFamily = family
        operationInvalidated = false
    }

    const performDispose = (): void => {
        if (capability === 'disposed') return
        unsubscribeDeviceLost()
        capability = 'disposed'
        pendingReadbacks.clear()
        records.clear()
        mutate()
    }

    const endOperation = (): boolean => {
        const invalidated = operationInvalidated
        operationDepth = 0
        activeOperationFamily = null
        operationInvalidated = false
        if (pendingDispose) {
            pendingDispose = false
            performDispose()
        }
        return invalidated
    }

    const incrementDropped = (record: TransferRecord): void => {
        const key = `${record.status}${record.family === 'upload' ? 'Upload' : 'Readback'}` as keyof DroppedTransferCounts
        const next = increment(dropped[key])
        dropped[key] = next.value
        if (!next.exact) countersExact = false
        evictedStartedAtMin = Math.min(evictedStartedAtMin ?? record.startedAt, record.startedAt)
        evictedEndedAtMax = Math.max(evictedEndedAtMax ?? record.endedAt, record.endedAt)
    }

    const appendRecord = (record: TransferRecord): void => {
        if (record.status === 'measured' && record.family === 'upload') acceptedUploadCount = noteCounter(acceptedUploadCount)
        else if (record.status === 'measured') acceptedReadbackCount = noteCounter(acceptedReadbackCount)
        else if (record.family === 'upload') rejectedUploadCount = noteCounter(rejectedUploadCount)
        else rejectedReadbackCount = noteCounter(rejectedReadbackCount)
        const evicted = records.push(record)
        if (evicted) incrementDropped(evicted)
        mutate()
    }

    const terminalRecord = (
        family: TransferFamily,
        status: TransferStatus,
        metadata: TransferMetadata,
        startedAt: number | null,
        endedAt: number | null
    ): void => {
        if (startedAt === null || endedAt === null || endedAt < startedAt || endedAt - startedAt > MAX_DURATION_MS) {
            invalidateFamilyCorrelation(family)
            return
        }
        appendRecord({
            family,
            status,
            kind: metadata.kind,
            startedAt,
            endedAt,
            durationMs: round(endedAt - startedAt),
            bytes: metadata.bytes,
            bytesKnown: metadata.bytesKnown,
        })
    }

    const uploadMetadata = (evidence: WebGpuUploadEvidence): TransferMetadata => {
        try {
            const rawKind = evidence?.kind
            const rawBytes = evidence?.bytes
            const kind = typeof rawKind === 'string' && UPLOAD_KINDS.has(rawKind as WebGpuUploadKind) ? (rawKind as WebGpuUploadKind) : null
            const bytes = rawBytes === undefined ? null : boundedInteger(rawBytes, MAX_BYTES)
            return { kind, bytes, bytesKnown: rawBytes !== undefined, valid: kind !== null && (rawBytes === undefined || bytes !== null) }
        } catch {
            return { kind: null, bytes: null, bytesKnown: false, valid: false }
        }
    }

    const readbackMetadata = (evidence: WebGpuReadbackEvidence): TransferMetadata => {
        try {
            const rawKind = evidence?.kind
            const rawBytes = evidence?.bytes
            const submissionAttestation = evidence?.submissionAttestation
            const kind =
                typeof rawKind === 'string' && READBACK_KINDS.has(rawKind as WebGpuReadbackKind) ? (rawKind as WebGpuReadbackKind) : null
            const bytes = rawBytes === undefined ? null : boundedInteger(rawBytes, MAX_BYTES)
            return {
                kind,
                bytes,
                bytesKnown: rawBytes !== undefined,
                valid:
                    kind !== null &&
                    submissionAttestation === 'caller-attests-associated-copy-command-stream-submitted' &&
                    (rawBytes === undefined || bytes !== null),
            }
        } catch {
            return { kind: null, bytes: null, bytesKnown: false, valid: false }
        }
    }

    const loseDevice = (): void => {
        if (capability !== 'supported') return
        capability = 'device-lost'
        deviceLostCount = noteCounter(deviceLostCount)
        pendingReadbacks.clear()
        mutate()
    }

    const failObserver = (): void => {
        if (capability !== 'supported') return
        capability = 'error'
        observerErrorCount = noteCounter(observerErrorCount)
        pendingReadbacks.clear()
        mutate()
    }

    try {
        unsubscribeDeviceLost = subscribeDeviceLost(device as object, lost, { onLost: loseDevice, onError: failObserver })
    } catch {
        failObserver()
    }

    const aggregate = (retained: readonly TransferRecord[]): WebGpuTransferRecorderAggregate => {
        const measuredUploads = retained.filter(record => record.family === 'upload' && record.status === 'measured')
        const measuredReadbacks = retained.filter(record => record.family === 'readback' && record.status === 'measured')
        const uploads = uploadKindCounts()
        const readbacks = readbackKindCounts()
        for (const record of measuredUploads) {
            if (record.kind && UPLOAD_KINDS.has(record.kind as WebGpuUploadKind)) {
                incrementKind(uploads, record.kind as WebGpuUploadKind)
            }
        }
        for (const record of measuredReadbacks) {
            if (record.kind && READBACK_KINDS.has(record.kind as WebGpuReadbackKind)) {
                incrementKind(readbacks, record.kind as WebGpuReadbackKind)
            }
        }
        const uploadComplete = !uploadCorrelationInvalid && rejectedUploadCount === 0 && dropped.measuredUpload === 0
        const readbackComplete =
            !readbackCorrelationInvalid &&
            rejectedReadbackCount === 0 &&
            skippedReadbackCapacityCount === 0 &&
            pendingReadbacks.size === 0 &&
            dropped.measuredReadback === 0
        return {
            uploadCallMsP95: uploadComplete ? percentile95(measuredUploads.map(record => record.durationMs)) : null,
            scheduledUploadBytes: uploadComplete ? sumBytes(measuredUploads) : null,
            hostObservedReadbackReadyMsP95: readbackComplete ? percentile95(measuredReadbacks.map(record => record.durationMs)) : null,
            attestedReadbackBytes: readbackComplete ? sumBytes(measuredReadbacks) : null,
            retainedMeasuredUploadKinds: uploads,
            retainedMeasuredReadbackKinds: readbacks,
        }
    }

    const unobserved = (reason: string): WebGpuTransferTargetRendererInspection => ({
        family: 'webgpu',
        capability: {
            state: capability === 'supported' ? 'supported' : 'unknown',
            observed: false,
            buffered: false,
            reason,
        },
    })

    const exactDroppedForWindow = (startedAt: number, endedAt: number): DroppedTransferCounts | null => {
        const totalDropped = dropped.measuredUpload + dropped.measuredReadback + dropped.rejectedUpload + dropped.rejectedReadback
        if (totalDropped === 0) return emptyDroppedCounts()
        if (!countersExact || evictedStartedAtMin === null || evictedEndedAtMax === null) return null
        if (startedAt > evictedEndedAtMax || endedAt < evictedStartedAtMin) return emptyDroppedCounts()
        if (startedAt <= evictedStartedAtMin && endedAt >= evictedEndedAtMax) return { ...dropped }
        return null
    }

    const inspectWindow = (window: WebGpuTransferTargetInspectionContext['evidenceWindow']): WebGpuTransferTargetRendererInspection => {
        if (capability !== 'supported') return unobserved(`WebGPU transfer recorder is ${capability}`)
        if (operationDepth > 0) return unobserved('WebGPU transfer evidence is changing')
        if (inspectionDepth > 0) {
            inspectionInvalidated = true
            return unobserved('Nested WebGPU transfer inspection is unavailable')
        }
        let rawStartedAt: unknown
        let rawEndedAt: unknown
        let rawRelation: unknown
        const initialMutationVersion = mutationVersion
        inspectionInvalidated = false
        inspectionDepth += 1
        try {
            rawStartedAt = window?.startedAt
            rawEndedAt = window?.endedAt
            rawRelation = window?.relation
        } catch {
            return unobserved('Target evidence window was unreadable')
        } finally {
            inspectionDepth = Math.max(0, inspectionDepth - 1)
        }
        if (inspectionInvalidated || mutationVersion !== initialMutationVersion) {
            return unobserved('WebGPU transfer evidence changed during window inspection')
        }
        const startedAt = boundedTime(rawStartedAt)
        const endedAt = boundedTime(rawEndedAt)
        if (
            startedAt === null ||
            endedAt === null ||
            endedAt < startedAt ||
            (rawRelation !== 'selection-window' && rawRelation !== 'interaction-window')
        ) {
            return unobserved('A valid SDK evidence window is required')
        }

        const retained = records.toArray().filter(record => record.startedAt >= startedAt && record.endedAt <= endedAt)
        const droppedForWindow = exactDroppedForWindow(startedAt, endedAt)
        if (!droppedForWindow) {
            return unobserved('WebGPU transfer eviction intersects this window, but its exact sample count is unavailable')
        }
        const relevantPendingReadback = [...pendingReadbacks.values()].some(
            pending => pending.startedAt >= startedAt && pending.startedAt <= endedAt
        )
        const limitations = [
            ...(uploadCorrelationInvalid ? ['Upload correlation is incomplete'] : []),
            ...(readbackCorrelationInvalid ? ['Readback correlation is incomplete'] : []),
            ...(relevantPendingReadback ? ['A readback operation is pending in this window'] : []),
        ]
        if (limitations.length > 0) return unobserved(limitations.join('; '))
        if (retained.length === 0) {
            const droppedCount = Object.values(droppedForWindow).reduce((total, value) => total + value, 0)
            return unobserved(
                droppedCount > 0
                    ? 'WebGPU transfer operations in this window were evicted from the bounded recorder'
                    : 'No complete WebGPU transfer operations were retained in this window'
            )
        }

        const retainedMeasuredUploads = retained.filter(record => record.family === 'upload' && record.status === 'measured')
        const retainedMeasuredReadbacks = retained.filter(record => record.family === 'readback' && record.status === 'measured')
        const retainedRejectedUploads = retained.filter(record => record.family === 'upload' && record.status === 'rejected')
        const retainedRejectedReadbacks = retained.filter(record => record.family === 'readback' && record.status === 'rejected')
        const uploadValid =
            !uploadCorrelationInvalid &&
            droppedForWindow.measuredUpload === 0 &&
            droppedForWindow.rejectedUpload === 0 &&
            retainedRejectedUploads.length === 0 &&
            retainedMeasuredUploads.length > 0
        const readbackValid =
            !readbackCorrelationInvalid &&
            !relevantPendingReadback &&
            droppedForWindow.measuredReadback === 0 &&
            droppedForWindow.rejectedReadback === 0 &&
            retainedRejectedReadbacks.length === 0 &&
            retainedMeasuredReadbacks.length > 0
        const uploadBytes = uploadValid ? sumBytes(retainedMeasuredUploads) : null
        const readbackMsP95 = readbackValid ? percentile95(retainedMeasuredReadbacks.map(record => record.durationMs)) : null
        const measured = [...retainedMeasuredUploads, ...retainedMeasuredReadbacks]
        const droppedMeasured = droppedForWindow.measuredUpload + droppedForWindow.measuredReadback
        const retainedRejected = retainedRejectedUploads.length + retainedRejectedReadbacks.length
        const rejected = retainedRejected + droppedForWindow.rejectedUpload + droppedForWindow.rejectedReadback
        const metrics: NonNullable<WebGpuTransferTargetRendererInspection['metrics']> = {
            ...(uploadBytes === null ? {} : { uploadBytes }),
            ...(readbackMsP95 === null ? {} : { readbackMsP95 }),
        }
        return {
            family: 'webgpu',
            capability: {
                state: 'supported',
                observed: true,
                buffered: false,
            },
            metrics,
            evidence: {
                window: { startedAt, endedAt },
                acceptedSampleCount: measured.length + droppedMeasured,
                retainedSampleCount: measured.length,
                droppedSampleCount: droppedMeasured,
                rejectedSampleCount: rejected,
                truncated: droppedMeasured > 0,
            },
        }
    }

    const recorder: WebGpuTransferRecorder = {
        backend: 'webgpu',
        get supported(): boolean {
            return capability === 'supported'
        },
        measureUpload<T>(evidence: WebGpuUploadEvidence, operation: () => T): T {
            if (typeof operation !== 'function') throw new TypeError('upload operation must be a function')
            if (inspectionDepth > 0) {
                inspectionInvalidated = true
                reentrantOperationCount = noteCounter(reentrantOperationCount)
                invalidateFamilyCorrelation('upload')
                return operation()
            }
            if (operationDepth > 0) {
                operationInvalidated = true
                reentrantOperationCount = noteCounter(reentrantOperationCount)
                if (activeOperationFamily) invalidateFamilyCorrelation(activeOperationFamily)
                invalidateFamilyCorrelation('upload')
                return operation()
            }
            if (capability !== 'supported') return operation()

            beginOperation('upload')
            const metadata = uploadMetadata(evidence)
            const startedAt = readNow('upload')
            let result: T
            try {
                result = operation()
            } catch (error) {
                const endedAt = readNow('upload')
                terminalRecord('upload', 'rejected', metadata, startedAt, endedAt)
                endOperation()
                throw error
            }
            const endedAt = readNow('upload')
            const invalidated = endOperation()
            if (capability !== 'supported') return result
            terminalRecord(
                'upload',
                !invalidated && metadata.valid && result === undefined ? 'measured' : 'rejected',
                metadata,
                startedAt,
                endedAt
            )
            return result
        },
        observeReadback<T>(evidence: WebGpuReadbackEvidence, operation: () => Promise<T>): Promise<T> {
            if (typeof operation !== 'function') throw new TypeError('readback operation must be a function')
            if (inspectionDepth > 0) {
                inspectionInvalidated = true
                reentrantOperationCount = noteCounter(reentrantOperationCount)
                invalidateFamilyCorrelation('readback')
                return passThroughPromise(operation())
            }
            if (operationDepth > 0) {
                operationInvalidated = true
                reentrantOperationCount = noteCounter(reentrantOperationCount)
                if (activeOperationFamily) invalidateFamilyCorrelation(activeOperationFamily)
                invalidateFamilyCorrelation('readback')
                return passThroughPromise(operation())
            }
            if (capability !== 'supported') return passThroughPromise(operation())

            beginOperation('readback')
            const metadata = readbackMetadata(evidence)
            const startedAt = readNow('readback')
            let result: Promise<T>
            try {
                result = operation()
            } catch (error) {
                const endedAt = readNow('readback')
                terminalRecord('readback', 'rejected', metadata, startedAt, endedAt)
                endOperation()
                throw error
            }

            if (sameRealmPromise(result) !== true || !metadata.valid || startedAt === null || operationInvalidated) {
                const endedAt = readNow('readback')
                terminalRecord('readback', 'rejected', metadata, startedAt, endedAt)
                endOperation()
                return passThroughPromise(result)
            }
            if (pendingReadbacks.size >= maxPendingReadbacks) {
                skippedReadbackCapacityCount = noteCounter(skippedReadbackCapacityCount)
                readbackCorrelationInvalid = true
                mutate()
                endOperation()
                return passThroughPromise(result)
            }

            const pending: PendingReadback = { startedAt, metadata }
            pendingReadbacks.add(pending)
            mutate()
            const settleReadback = (status: TransferStatus): void => {
                try {
                    if (!pendingReadbacks.has(pending) || capability !== 'supported') return
                    pendingReadbacks.delete(pending)
                    mutate()
                    if (operationDepth > 0) {
                        readbackCorrelationInvalid = true
                        operationInvalidated = true
                        mutate()
                        return
                    }
                    beginOperation('readback')
                    const endedAt = readNow('readback')
                    const invalidated = endOperation()
                    if (invalidated || capability !== 'supported') {
                        if (capability === 'supported') invalidateFamilyCorrelation('readback')
                        return
                    }
                    terminalRecord('readback', status, pending.metadata, pending.startedAt, endedAt)
                } catch {
                    observerErrorCount = noteCounter(observerErrorCount)
                    invalidateFamilyCorrelation('readback')
                }
            }
            let attachmentFailed = false
            const observedResult = new PromiseConstructor<T>((resolve, reject) => {
                try {
                    attachPromise(
                        result,
                        value => {
                            settleReadback('measured')
                            resolve(value)
                        },
                        error => {
                            settleReadback('rejected')
                            reject(error)
                        }
                    )
                } catch (error) {
                    attachmentFailed = true
                    reject(error)
                }
            })
            if (attachmentFailed) {
                pendingReadbacks.delete(pending)
                observerErrorCount = noteCounter(observerErrorCount)
                readbackCorrelationInvalid = true
                mutate()
            }
            const invalidated = endOperation()
            if (invalidated && capability === 'supported') invalidateFamilyCorrelation('readback')
            return observedResult
        },
        inspectWindow,
        inspect(context): WebGpuTransferTargetAdapterInspection {
            let renderer: WebGpuTransferTargetRendererInspection
            if (operationDepth > 0) {
                renderer = unobserved('WebGPU transfer evidence is changing')
            } else if (inspectionDepth > 0) {
                inspectionInvalidated = true
                renderer = unobserved('Nested WebGPU transfer inspection is unavailable')
            } else if (!context) renderer = unobserved('An SDK target inspection context is required')
            else {
                let evidenceWindow: WebGpuTransferTargetInspectionContext['evidenceWindow'] | undefined
                const initialMutationVersion = mutationVersion
                inspectionInvalidated = false
                inspectionDepth += 1
                try {
                    evidenceWindow = context.evidenceWindow
                } catch {
                    renderer = unobserved('Target inspection context was unreadable')
                } finally {
                    inspectionDepth = Math.max(0, inspectionDepth - 1)
                }
                if (inspectionInvalidated || mutationVersion !== initialMutationVersion) {
                    renderer = unobserved('WebGPU transfer evidence changed during target context inspection')
                } else if (evidenceWindow) {
                    try {
                        renderer = inspectWindow(evidenceWindow)
                    } catch {
                        renderer = unobserved('Target inspection context was unreadable')
                    }
                } else {
                    renderer = unobserved('An SDK target evidence window is required')
                }
            }
            return {
                inventory: { renderers: ['webgpu'] },
                owners: [{ relation: 'renderer-host', label: 'Condev WebGPU transfer recorder' }],
                renderer,
            }
        },
        getSnapshot(): WebGpuTransferRecorderSnapshot {
            const retained = records.toArray()
            const retainedUploads = retained.filter(record => record.family === 'upload' && record.status === 'measured').length
            const retainedReadbacks = retained.filter(record => record.family === 'readback' && record.status === 'measured').length
            const retainedRejectedUploads = retained.filter(record => record.family === 'upload' && record.status === 'rejected').length
            const retainedRejectedReadbacks = retained.filter(record => record.family === 'readback' && record.status === 'rejected').length
            return {
                backend: 'webgpu',
                capability,
                supported: capability === 'supported',
                capacity: maxRetainedOperations,
                maxPendingReadbacks,
                pendingReadbackCount: pendingReadbacks.size,
                acceptedUploadCount,
                acceptedReadbackCount,
                retainedUploadCount: retainedUploads,
                retainedReadbackCount: retainedReadbacks,
                droppedUploadCount: Math.max(0, acceptedUploadCount - retainedUploads),
                droppedReadbackCount: Math.max(0, acceptedReadbackCount - retainedReadbacks),
                rejectedUploadCount,
                rejectedReadbackCount,
                retainedRejectedUploadCount: retainedRejectedUploads,
                retainedRejectedReadbackCount: retainedRejectedReadbacks,
                droppedRejectedUploadCount: Math.max(0, rejectedUploadCount - retainedRejectedUploads),
                droppedRejectedReadbackCount: Math.max(0, rejectedReadbackCount - retainedRejectedReadbacks),
                skippedReadbackCapacityCount,
                reentrantOperationCount,
                clockErrorCount,
                observerErrorCount,
                deviceLostCount,
                uploadCorrelationInvalid,
                readbackCorrelationInvalid,
                aggregate: aggregate(retained),
            }
        },
        dispose(): void {
            if (capability === 'disposed') return
            if (operationDepth > 0) {
                pendingDispose = true
                operationInvalidated = true
                return
            }
            performDispose()
        },
    }

    return recorder
}
