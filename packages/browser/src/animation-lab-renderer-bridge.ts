import type {
    AnimationGpuTimerCapability,
    AnimationGpuTimingStatus,
    AnimationHostGpuTimingSource,
    AnimationRenderStatsSample,
    AnimationRendererBackend,
} from '@condev-monitor/monitor-sdk-animation'

const LAB_RENDERER_BRIDGE_SYMBOL = Symbol.for('@condev-monitor/animation-lab/renderer-evidence/v1')
const RENDERER_BACKENDS = new Set<AnimationRendererBackend>(['canvas2d', 'webgl', 'webgl2', 'webgpu', 'unknown'])
const GPU_TIMER_CAPABILITIES = new Set<AnimationGpuTimerCapability>(['supported', 'unsupported', 'disabled', 'unknown'])
const GPU_STATUSES = new Set<AnimationGpuTimingStatus>(['measured', 'not-provided', 'invalid', 'disjoint', 'context-lost', 'error'])
const GPU_SOURCES = new Set<AnimationHostGpuTimingSource>(['webgl-disjoint-timer-query', 'webgpu-timestamp-query', 'host-timer-query'])
const MAX_RENDERER_COUNT = 1_000_000_000
const MAX_GPU_FRAME_MS = 60_000
const INTRINSIC_PROMISE_THEN = Promise.prototype.then

type LabRendererGpuEvidenceV1 =
    | {
          status: 'measured'
          timeMs: number
          source: AnimationHostGpuTimingSource
          valid: true
          disjoint: false
          contextLost: false
      }
    | { status: Exclude<AnimationGpuTimingStatus, 'measured'> }

interface LabRendererEvidenceV1 {
    contractVersion: 1
    backend: AnimationRendererBackend
    gpuTimerCapability?: AnimationGpuTimerCapability
    drawCalls?: number
    triangles?: number
    gpu: LabRendererGpuEvidenceV1
}

let publishing = false

function recordLike(value: unknown): value is Record<string, unknown> {
    try {
        return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    } catch {
        return false
    }
}

/**
 * Reads each caller-controlled field once. The same immutable snapshot is then
 * validated by the core collector and projected to Lab, preventing getter or
 * Proxy state from producing two different accepted samples.
 */
export function snapshotAnimationLabRendererSample(sample: AnimationRenderStatsSample): AnimationRenderStatsSample | null {
    if (!recordLike(sample)) return null
    try {
        const raw = sample as unknown as Record<string, unknown>
        const source = raw.source
        const backend = raw.backend
        const timestampMs = raw.timestampMs
        const gpuTimerCapability = raw.gpuTimerCapability
        const drawCalls = raw.drawCalls
        const triangles = raw.triangles
        const lines = raw.lines
        const points = raw.points
        const geometries = raw.geometries
        const textures = raw.textures
        const programs = raw.programs
        const rawGpu = raw.gpu
        if (!recordLike(rawGpu)) return null
        const gpuStatus = rawGpu.status
        const gpuTimeMs = rawGpu.timeMs
        const gpuSource = rawGpu.source
        const gpuValid = rawGpu.valid
        const gpuDisjoint = rawGpu.disjoint
        const gpuContextLost = rawGpu.contextLost
        const gpu = Object.freeze({
            status: gpuStatus,
            ...(gpuTimeMs === undefined ? {} : { timeMs: gpuTimeMs }),
            ...(gpuSource === undefined ? {} : { source: gpuSource }),
            ...(gpuValid === undefined ? {} : { valid: gpuValid }),
            ...(gpuDisjoint === undefined ? {} : { disjoint: gpuDisjoint }),
            ...(gpuContextLost === undefined ? {} : { contextLost: gpuContextLost }),
        })
        return Object.freeze({
            source,
            backend,
            timestampMs,
            ...(gpuTimerCapability === undefined ? {} : { gpuTimerCapability }),
            ...(drawCalls === undefined ? {} : { drawCalls }),
            ...(triangles === undefined ? {} : { triangles }),
            ...(lines === undefined ? {} : { lines }),
            ...(points === undefined ? {} : { points }),
            ...(geometries === undefined ? {} : { geometries }),
            ...(textures === undefined ? {} : { textures }),
            ...(programs === undefined ? {} : { programs }),
            gpu,
        }) as AnimationRenderStatsSample
    } catch {
        return null
    }
}

function finiteCount(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_RENDERER_COUNT ? value : undefined
}

function compatibleGpuSource(backend: AnimationRendererBackend, source: AnimationHostGpuTimingSource): boolean {
    if (backend === 'canvas2d') return false
    if (source === 'host-timer-query') return true
    if (source === 'webgl-disjoint-timer-query') return backend === 'webgl' || backend === 'webgl2'
    return source === 'webgpu-timestamp-query' && backend === 'webgpu'
}

function normalizedEvidence(sample: AnimationRenderStatsSample): Readonly<LabRendererEvidenceV1> | null {
    try {
        const backend = sample.backend
        const gpuTimerCapability = sample.gpuTimerCapability
        const rawDrawCalls = sample.drawCalls
        const rawTriangles = sample.triangles
        const gpu = sample.gpu
        const gpuStatus = gpu.status
        const gpuTimeMs = gpu.timeMs
        const gpuSource = gpu.source
        const gpuValid = gpu.valid
        const gpuDisjoint = gpu.disjoint
        const gpuContextLost = gpu.contextLost
        if (!RENDERER_BACKENDS.has(backend)) return null
        if (gpuTimerCapability !== undefined && !GPU_TIMER_CAPABILITIES.has(gpuTimerCapability)) return null

        const drawCalls = rawDrawCalls === undefined ? undefined : finiteCount(rawDrawCalls)
        const triangles = rawTriangles === undefined ? undefined : finiteCount(rawTriangles)
        if ((rawDrawCalls !== undefined && drawCalls === undefined) || (rawTriangles !== undefined && triangles === undefined)) {
            return null
        }

        if (!GPU_STATUSES.has(gpuStatus)) return null
        const normalizedGpuSource =
            typeof gpuSource === 'string' && GPU_SOURCES.has(gpuSource as AnimationHostGpuTimingSource)
                ? (gpuSource as AnimationHostGpuTimingSource)
                : null
        const projectedGpu: LabRendererGpuEvidenceV1 | null =
            gpuStatus === 'measured'
                ? typeof gpuTimeMs === 'number' &&
                  Number.isFinite(gpuTimeMs) &&
                  gpuTimeMs >= 0 &&
                  gpuTimeMs <= MAX_GPU_FRAME_MS &&
                  normalizedGpuSource !== null &&
                  compatibleGpuSource(backend, normalizedGpuSource) &&
                  gpuValid === true &&
                  gpuDisjoint === false &&
                  gpuContextLost === false
                    ? Object.freeze({
                          status: 'measured',
                          timeMs: gpuTimeMs,
                          source: normalizedGpuSource,
                          valid: true,
                          disjoint: false,
                          contextLost: false,
                      })
                    : null
                : Object.freeze({ status: gpuStatus })
        if (!projectedGpu) return null
        if (
            gpuTimerCapability !== undefined &&
            ((projectedGpu.status === 'measured' && gpuTimerCapability !== 'supported') ||
                (gpuTimerCapability === 'supported' && (projectedGpu.status === 'context-lost' || projectedGpu.status === 'error')) ||
                ((gpuTimerCapability === 'unsupported' || gpuTimerCapability === 'disabled') && projectedGpu.status !== 'not-provided'))
        ) {
            return null
        }

        return Object.freeze({
            contractVersion: 1,
            backend,
            ...(gpuTimerCapability === undefined ? {} : { gpuTimerCapability }),
            ...(drawCalls === undefined ? {} : { drawCalls }),
            ...(triangles === undefined ? {} : { triangles }),
            gpu: projectedGpu,
        })
    } catch {
        return null
    }
}

/** Local Lab evidence only. Missing or hostile bridges never affect application monitoring. */
export function publishAcceptedAnimationLabRendererSample(sample: AnimationRenderStatsSample): void {
    if (publishing) return
    publishing = true
    try {
        const evidence = normalizedEvidence(sample)
        if (!evidence) return
        const sink = (globalThis as Record<PropertyKey, unknown>)[LAB_RENDERER_BRIDGE_SYMBOL]
        if (typeof sink !== 'function') return
        const result = Reflect.apply(sink, undefined, [evidence])
        if (result && (typeof result === 'object' || typeof result === 'function')) {
            try {
                Reflect.apply(INTRINSIC_PROMISE_THEN, result, [undefined, () => undefined])
            } catch {
                // Only genuine Promise results are observed. Arbitrary thenable values
                // are intentionally ignored so hostile `then()` implementations
                // cannot manufacture an unhandled rejected Promise.
            }
        }
    } catch {
        // The page-owned Lab bridge is optional and must never affect the SDK.
    } finally {
        publishing = false
    }
}

export function isPublishingAnimationLabRendererSample(): boolean {
    return publishing
}
