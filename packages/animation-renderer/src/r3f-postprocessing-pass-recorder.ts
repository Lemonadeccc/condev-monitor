export type R3fPostprocessingPassKind = 'render' | 'effect' | 'mask' | 'clear' | 'copy' | 'resolve' | 'output' | 'other'

export type R3fPostprocessingGpuSource = 'webgl-timer-query' | 'webgpu-timestamp-query'

export type R3fPostprocessingGpuEvidence =
    | { status: 'measured'; timeMs: number; source: R3fPostprocessingGpuSource }
    | { status: 'invalid' | 'disjoint' | 'context-lost' | 'error'; source: R3fPostprocessingGpuSource }

export interface R3fPostprocessingPassRecorderOptions {
    passCoverage: 'caller-attests-complete-postprocessing-pass-boundaries'
    now?: () => number
    maxRetainedFrames?: number
    maxPassesPerFrame?: number
    maxPassIdentities?: number
    maxPendingGpuSamples?: number
}

declare const R3F_PASS_TICKET: unique symbol

export interface R3fPostprocessingPassTicket<Pass extends object> {
    readonly sampleId: number
    readonly [R3F_PASS_TICKET]: Pass
}

export interface R3fPostprocessingPassAggregate {
    anonymousId: string
    kind: R3fPostprocessingPassKind
    sampleCount: number
    cpuCallbackMsP95: number
    gpu:
        | { status: 'measured'; timeMsP95: number; source: R3fPostprocessingGpuSource }
        | { status: 'not-reported' | 'pending' | 'rejected' | 'mixed' }
}

export interface R3fPostprocessingPassWindow {
    status: 'observed' | 'unavailable'
    reason?: string
    window: { startedAt: number; endedAt: number } | null
    retainedFrameCount: number
    passExecutionCount: number
    truncated: boolean
    passes: readonly R3fPostprocessingPassAggregate[]
}

export interface R3fPostprocessingPassRecorderSnapshot extends R3fPostprocessingPassWindow {
    backend: 'r3f-postprocessing'
    capability: 'active' | 'incomplete' | 'disposed'
    evidenceLevel: 'caller-attested'
    completedFrameCount: number
    rejectedFrameCount: number
    rejectedPassCount: number
    pendingGpuSampleCount: number
    rejectedGpuEvidenceCount: number
    droppedFrameCount: number
}

export interface R3fPostprocessingPassRecorder<Pass extends object> {
    beginFrame(): boolean
    beginPass(pass: Pass, kind: R3fPostprocessingPassKind): R3fPostprocessingPassTicket<Pass> | null
    endPass(ticket: R3fPostprocessingPassTicket<Pass>, gpuExpectation?: 'will-report-existing-timestamp-result'): boolean
    recordGpuEvidence(
        ticket: R3fPostprocessingPassTicket<Pass>,
        attestation: 'caller-attests-existing-timestamp-result-covers-only-associated-pass',
        evidence: R3fPostprocessingGpuEvidence
    ): boolean
    endFrame(): boolean
    cancelFrame(): boolean
    inspectWindow(window: { startedAt: number; endedAt: number }): R3fPostprocessingPassWindow
    getSnapshot(): R3fPostprocessingPassRecorderSnapshot
    dispose(): void
}

export class R3fPostprocessingPassRecorderOptionsError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'R3fPostprocessingPassRecorderOptionsError'
    }
}

const PASS_KINDS = new Set<R3fPostprocessingPassKind>(['render', 'effect', 'mask', 'clear', 'copy', 'resolve', 'output', 'other'])
const DEFAULT_MAX_RETAINED_FRAMES = 120
const MAX_RETAINED_FRAMES = 4096
const DEFAULT_MAX_PASSES_PER_FRAME = 64
const MAX_PASSES_PER_FRAME = 1024
const DEFAULT_MAX_PASS_IDENTITIES = 256
const MAX_PASS_IDENTITIES = 8192
const DEFAULT_MAX_PENDING_GPU_SAMPLES = 32
const MAX_PENDING_GPU_SAMPLES = 1024
const MAX_DURATION_MS = 600_000
const MAX_COUNTER = Number.MAX_SAFE_INTEGER

type GpuSampleState = { status: 'not-reported' } | { status: 'pending' } | { status: 'rejected' } | R3fPostprocessingGpuEvidence

interface CompletedPass {
    ticket: object
    anonymousId: string
    identity: number
    kind: R3fPostprocessingPassKind
    cpuCallbackMs: number
    gpu: GpuSampleState
}

interface CompletedFrame {
    startedAt: number
    endedAt: number
    valid: boolean
    passes: CompletedPass[]
}

interface ActivePass<Pass extends object> {
    ticket: R3fPostprocessingPassTicket<Pass>
    identity: number
    anonymousId: string
    kind: R3fPostprocessingPassKind
    startedAt: number
}

interface ActiveFrame<Pass extends object> {
    startedAt: number
    valid: boolean
    passes: CompletedPass[]
    activePass: ActivePass<Pass> | null
}

function isObject(value: unknown): value is object {
    return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function boundedInteger(name: string, value: unknown, fallback: number, maximum: number): number {
    const normalized = value === undefined ? fallback : value
    if (!Number.isSafeInteger(normalized) || (normalized as number) < 1 || (normalized as number) > maximum) {
        throw new R3fPostprocessingPassRecorderOptionsError(`${name} must be an integer between 1 and ${maximum}`)
    }
    return normalized as number
}

function increment(value: number): number {
    return value >= MAX_COUNTER ? MAX_COUNTER : value + 1
}

function defaultNow(): number {
    const performanceNow = globalThis.performance?.now
    return typeof performanceNow === 'function' ? performanceNow.call(globalThis.performance) : Date.now()
}

function percentile95(values: readonly number[]): number {
    const sorted = [...values].sort((left, right) => left - right)
    return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

function aggregatePasses(frames: readonly CompletedFrame[]): readonly R3fPostprocessingPassAggregate[] {
    const grouped = new Map<string, CompletedPass[]>()
    for (const frame of frames) {
        for (const pass of frame.passes) {
            const samples = grouped.get(pass.anonymousId) ?? []
            samples.push(pass)
            grouped.set(pass.anonymousId, samples)
        }
    }
    return Object.freeze(
        [...grouped.entries()].map(([anonymousId, samples]) => {
            const first = samples[0]
            const gpuStates = samples.map(sample => sample.gpu)
            const measured = gpuStates.filter(
                (gpu): gpu is Extract<R3fPostprocessingGpuEvidence, { status: 'measured' }> => gpu.status === 'measured'
            )
            let gpu: R3fPostprocessingPassAggregate['gpu']
            if (gpuStates.every(state => state.status === 'not-reported')) gpu = { status: 'not-reported' }
            else if (gpuStates.some(state => state.status === 'pending')) gpu = { status: 'pending' }
            else if (
                gpuStates.some(
                    state =>
                        state.status === 'rejected' ||
                        state.status === 'invalid' ||
                        state.status === 'disjoint' ||
                        state.status === 'context-lost' ||
                        state.status === 'error'
                )
            ) {
                gpu = { status: 'rejected' }
            } else if (measured.length !== gpuStates.length || new Set(measured.map(state => state.source)).size !== 1) {
                gpu = { status: 'mixed' }
            } else {
                const firstMeasured = measured[0]
                gpu = firstMeasured
                    ? { status: 'measured', timeMsP95: percentile95(measured.map(state => state.timeMs)), source: firstMeasured.source }
                    : { status: 'mixed' }
            }
            return Object.freeze({
                anonymousId,
                kind: first?.kind ?? 'other',
                sampleCount: samples.length,
                cpuCallbackMsP95: percentile95(samples.map(sample => sample.cpuCallbackMs)),
                gpu: Object.freeze(gpu),
            })
        })
    )
}

/** Explicit local recorder for host-owned R3F/postprocessing pass boundaries. */
export function createR3fPostprocessingPassRecorder<Pass extends object>(
    options: R3fPostprocessingPassRecorderOptions
): R3fPostprocessingPassRecorder<Pass> {
    let coverage: unknown
    let now: () => number
    let maxRetainedFrames: number
    let maxPassesPerFrame: number
    let maxPassIdentities: number
    let maxPendingGpuSamples: number
    try {
        coverage = options.passCoverage
        const nowOption = options.now
        now = nowOption === undefined ? defaultNow : nowOption
        maxRetainedFrames = boundedInteger('maxRetainedFrames', options.maxRetainedFrames, DEFAULT_MAX_RETAINED_FRAMES, MAX_RETAINED_FRAMES)
        maxPassesPerFrame = boundedInteger(
            'maxPassesPerFrame',
            options.maxPassesPerFrame,
            DEFAULT_MAX_PASSES_PER_FRAME,
            MAX_PASSES_PER_FRAME
        )
        maxPassIdentities = boundedInteger('maxPassIdentities', options.maxPassIdentities, DEFAULT_MAX_PASS_IDENTITIES, MAX_PASS_IDENTITIES)
        maxPendingGpuSamples = boundedInteger(
            'maxPendingGpuSamples',
            options.maxPendingGpuSamples,
            DEFAULT_MAX_PENDING_GPU_SAMPLES,
            MAX_PENDING_GPU_SAMPLES
        )
    } catch (error) {
        if (error instanceof R3fPostprocessingPassRecorderOptionsError) throw error
        throw new R3fPostprocessingPassRecorderOptionsError('recorder options must be readable')
    }
    if (coverage !== 'caller-attests-complete-postprocessing-pass-boundaries') {
        throw new R3fPostprocessingPassRecorderOptionsError('passCoverage must explicitly attest complete pass boundaries')
    }
    if (typeof now !== 'function') throw new R3fPostprocessingPassRecorderOptionsError('now must be a function')

    const identities = new WeakMap<object, { identity: number; kind: R3fPostprocessingPassKind }>()
    const frames: CompletedFrame[] = []
    const pendingGpu = new Map<object, CompletedPass>()
    let active: ActiveFrame<Pass> | null = null
    let nextIdentity = 1
    let nextSampleId = 1
    let completedFrameCount = 0
    let rejectedFrameCount = 0
    let rejectedPassCount = 0
    let rejectedGpuEvidenceCount = 0
    let droppedFrameCount = 0
    let evictedThroughAt: number | null = null
    let firstCompletedStartedAt: number | null = null
    let incomplete = false
    let disposed = false
    let clockReading = false
    let clockReentered = false
    let gpuEvidenceReading = false
    let gpuEvidenceReentered = false

    const rejectReentry = (): boolean => {
        if (clockReading) {
            clockReentered = true
            return true
        }
        if (gpuEvidenceReading) {
            gpuEvidenceReentered = true
            return true
        }
        return false
    }

    const readNow = (): number | null => {
        clockReading = true
        clockReentered = false
        let value: unknown
        try {
            value = now()
        } catch {
            value = null
        }
        const reentered = clockReentered
        clockReading = false
        clockReentered = false
        return !reentered && typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
    }

    const removePendingForPasses = (passes: readonly CompletedPass[]): void => {
        for (const pass of passes) pendingGpu.delete(pass.ticket)
    }

    const removePendingForFrame = (frame: CompletedFrame): void => {
        removePendingForPasses(frame.passes)
    }

    const retainFrame = (frame: CompletedFrame): void => {
        firstCompletedStartedAt ??= frame.startedAt
        frames.push(frame)
        if (frames.length <= maxRetainedFrames) return
        const evicted = frames.shift()
        if (!evicted) return
        removePendingForFrame(evicted)
        evictedThroughAt = Math.max(evictedThroughAt ?? 0, evicted.endedAt)
        droppedFrameCount = increment(droppedFrameCount)
    }

    const unavailableWindow = (reason: string): R3fPostprocessingPassWindow => ({
        status: 'unavailable',
        reason,
        window: null,
        retainedFrameCount: 0,
        passExecutionCount: 0,
        truncated: false,
        passes: [],
    })

    const inspectFrames = (retained: CompletedFrame[], truncated: boolean): R3fPostprocessingPassWindow => {
        if (retained.length === 0) return unavailableWindow('No complete postprocessing frames were retained')
        if (retained.some(frame => !frame.valid)) return unavailableWindow('At least one frame has incomplete pass coverage')
        const startedAt = retained[0]?.startedAt
        const endedAt = retained[retained.length - 1]?.endedAt
        if (startedAt === undefined || endedAt === undefined) return unavailableWindow('Frame bounds are unavailable')
        return Object.freeze({
            status: 'observed',
            window: Object.freeze({ startedAt, endedAt }),
            retainedFrameCount: retained.length,
            passExecutionCount: retained.reduce((total, frame) => total + frame.passes.length, 0),
            truncated,
            passes: aggregatePasses(retained),
        })
    }

    const inspectWindow = (window: { startedAt: number; endedAt: number }): R3fPostprocessingPassWindow => {
        if (disposed || incomplete) return unavailableWindow(disposed ? 'Recorder is disposed' : 'Recorder capacity was exceeded')
        let startedAt: unknown
        let endedAt: unknown
        try {
            startedAt = window.startedAt
            endedAt = window.endedAt
        } catch {
            return unavailableWindow('Window was unreadable')
        }
        if (
            typeof startedAt !== 'number' ||
            typeof endedAt !== 'number' ||
            !Number.isFinite(startedAt) ||
            !Number.isFinite(endedAt) ||
            startedAt < 0 ||
            endedAt < startedAt
        ) {
            return unavailableWindow('A valid local evidence window is required')
        }
        if (
            evictedThroughAt !== null &&
            firstCompletedStartedAt !== null &&
            startedAt <= evictedThroughAt &&
            endedAt >= firstCompletedStartedAt
        ) {
            return unavailableWindow('Evicted frame history intersects this window')
        }
        return inspectFrames(
            frames.filter(frame => frame.startedAt >= startedAt && frame.endedAt <= endedAt),
            false
        )
    }

    return {
        beginFrame(): boolean {
            if (rejectReentry() || disposed || active) return false
            const startedAt = readNow()
            if (startedAt === null || disposed) {
                rejectedFrameCount = increment(rejectedFrameCount)
                return false
            }
            active = { startedAt, valid: true, passes: [], activePass: null }
            return true
        },
        beginPass(pass, kind): R3fPostprocessingPassTicket<Pass> | null {
            if (rejectReentry() || disposed || !active || active.activePass) return null
            const frame = active
            if (!isObject(pass) || typeof kind !== 'string' || !PASS_KINDS.has(kind)) {
                frame.valid = false
                rejectedPassCount = increment(rejectedPassCount)
                return null
            }
            let identity = identities.get(pass)
            if (identity && identity.kind !== kind) {
                active.valid = false
                rejectedPassCount = increment(rejectedPassCount)
                return null
            }
            if (!identity) {
                if (nextIdentity > maxPassIdentities) {
                    incomplete = true
                    frame.valid = false
                    rejectedPassCount = increment(rejectedPassCount)
                    return null
                }
                identity = { identity: nextIdentity, kind }
                nextIdentity += 1
                identities.set(pass, identity)
            }
            const startedAt = readNow()
            if (startedAt === null || disposed || active !== frame) {
                if (active === frame) frame.valid = false
                rejectedPassCount = increment(rejectedPassCount)
                return null
            }
            const ticket = Object.freeze({ sampleId: nextSampleId }) as R3fPostprocessingPassTicket<Pass>
            nextSampleId = increment(nextSampleId)
            frame.activePass = {
                ticket,
                identity: identity.identity,
                anonymousId: `r3f-pass-${identity.identity}`,
                kind,
                startedAt,
            }
            return ticket
        },
        endPass(ticket, gpuExpectation): boolean {
            if (rejectReentry() || disposed || !active?.activePass || active.activePass.ticket !== ticket) return false
            const frame = active
            const pass = frame.activePass as ActivePass<Pass>
            const endedAt = readNow()
            if (active === frame) frame.activePass = null
            if (
                endedAt === null ||
                endedAt < pass.startedAt ||
                endedAt - pass.startedAt > MAX_DURATION_MS ||
                disposed ||
                active !== frame
            ) {
                if (active === frame) frame.valid = false
                rejectedPassCount = increment(rejectedPassCount)
                return false
            }
            if (frame.passes.length >= maxPassesPerFrame) {
                frame.valid = false
                rejectedPassCount = increment(rejectedPassCount)
                return false
            }
            const expectsGpu = gpuExpectation === 'will-report-existing-timestamp-result'
            const sample: CompletedPass = {
                ticket: ticket as object,
                anonymousId: pass.anonymousId,
                identity: pass.identity,
                kind: pass.kind,
                cpuCallbackMs: endedAt - pass.startedAt,
                gpu: expectsGpu
                    ? pendingGpu.size < maxPendingGpuSamples
                        ? { status: 'pending' }
                        : { status: 'rejected' }
                    : { status: 'not-reported' },
            }
            frame.passes.push(sample)
            if (sample.gpu.status === 'pending') pendingGpu.set(ticket as object, sample)
            else if (expectsGpu) rejectedGpuEvidenceCount = increment(rejectedGpuEvidenceCount)
            return true
        },
        recordGpuEvidence(ticket, attestation, evidence): boolean {
            if (rejectReentry() || disposed || attestation !== 'caller-attests-existing-timestamp-result-covers-only-associated-pass') {
                return false
            }
            const sample = isObject(ticket) ? pendingGpu.get(ticket as object) : undefined
            if (!sample || sample.gpu.status !== 'pending') return false
            let accepted: GpuSampleState = { status: 'rejected' }
            gpuEvidenceReading = true
            gpuEvidenceReentered = false
            if (isObject(evidence)) {
                try {
                    const status = evidence.status
                    const source = evidence.source
                    if (source === 'webgl-timer-query' || source === 'webgpu-timestamp-query') {
                        if (status === 'measured') {
                            const timeMs = evidence.timeMs
                            if (typeof timeMs === 'number' && Number.isFinite(timeMs) && timeMs >= 0 && timeMs <= MAX_DURATION_MS) {
                                accepted = { status, timeMs, source }
                            }
                        } else if (status === 'invalid' || status === 'disjoint' || status === 'context-lost' || status === 'error') {
                            accepted = { status, source }
                        }
                    }
                } catch {
                    accepted = { status: 'rejected' }
                }
            }
            const reentered = gpuEvidenceReentered
            gpuEvidenceReading = false
            gpuEvidenceReentered = false
            if (reentered || disposed || pendingGpu.get(ticket as object) !== sample || sample.gpu.status !== 'pending') {
                if (!disposed && pendingGpu.get(ticket as object) === sample && sample.gpu.status === 'pending') {
                    pendingGpu.delete(ticket as object)
                    sample.gpu = { status: 'rejected' }
                    rejectedGpuEvidenceCount = increment(rejectedGpuEvidenceCount)
                }
                return false
            }
            pendingGpu.delete(ticket as object)
            sample.gpu = accepted
            if (accepted.status === 'rejected') {
                rejectedGpuEvidenceCount = increment(rejectedGpuEvidenceCount)
                return false
            }
            return true
        },
        endFrame(): boolean {
            if (rejectReentry() || disposed || !active || active.activePass) return false
            const frame = active
            const endedAt = readNow()
            active = null
            if (endedAt === null || endedAt < frame.startedAt || endedAt - frame.startedAt > MAX_DURATION_MS || disposed) {
                removePendingForPasses(frame.passes)
                rejectedFrameCount = increment(rejectedFrameCount)
                return false
            }
            frame.valid = frame.valid && frame.passes.length > 0
            const completed: CompletedFrame = { startedAt: frame.startedAt, endedAt, valid: frame.valid, passes: frame.passes }
            retainFrame(completed)
            if (!frame.valid) {
                removePendingForFrame(completed)
                rejectedFrameCount = increment(rejectedFrameCount)
                return false
            }
            completedFrameCount = increment(completedFrameCount)
            return true
        },
        cancelFrame(): boolean {
            if (rejectReentry() || disposed || !active) return false
            removePendingForPasses(active.passes)
            active = null
            rejectedFrameCount = increment(rejectedFrameCount)
            return true
        },
        inspectWindow,
        getSnapshot(): R3fPostprocessingPassRecorderSnapshot {
            const capability = disposed ? 'disposed' : incomplete ? 'incomplete' : 'active'
            const aggregate =
                capability === 'active'
                    ? inspectFrames(frames, droppedFrameCount > 0)
                    : unavailableWindow(disposed ? 'Recorder is disposed' : 'Recorder capacity was exceeded')
            return Object.freeze({
                ...aggregate,
                backend: 'r3f-postprocessing',
                capability,
                evidenceLevel: 'caller-attested',
                completedFrameCount,
                rejectedFrameCount,
                rejectedPassCount,
                pendingGpuSampleCount: pendingGpu.size,
                rejectedGpuEvidenceCount,
                droppedFrameCount,
            })
        },
        dispose(): void {
            if (disposed) return
            disposed = true
            active = null
            pendingGpu.clear()
            frames.length = 0
        },
    }
}
