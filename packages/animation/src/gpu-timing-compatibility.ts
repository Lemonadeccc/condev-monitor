// Keep renderer provenance checks in one place so host and target adapters
// cannot disagree about which backend produced a GPU timing value.

const HOST_RENDERER_BACKENDS = new Set(['canvas2d', 'webgl', 'webgl2', 'webgpu', 'unknown'])
const TARGET_RENDERER_FAMILIES = new Set(['dom', 'svg', 'canvas', 'canvas2d', 'webgl', 'webgl2', 'webgpu', 'other'])

const HOST_GPU_TIMING_SOURCES = new Set(['webgl-disjoint-timer-query', 'webgpu-timestamp-query', 'host-timer-query'])
const TARGET_GPU_TIMING_SOURCES = new Set(['webgl-timer-query', 'webgpu-timestamp-query', 'host-summary'])

const NEUTRAL_GPU_TIMING_SOURCES = new Set(['host-summary', 'host-timer-query'])

const GPU_TIMING_SOURCE_BACKENDS: Readonly<Record<string, ReadonlySet<string>>> = {
    'webgl-timer-query': new Set(['webgl', 'webgl2']),
    'webgl-disjoint-timer-query': new Set(['webgl', 'webgl2']),
    'webgpu-timestamp-query': new Set(['webgpu']),
}

function matchesGpuTimingBackend(backend: string, source: string): boolean {
    if (NEUTRAL_GPU_TIMING_SOURCES.has(source)) return true
    return GPU_TIMING_SOURCE_BACKENDS[source]?.has(backend) === true
}

export function isHostGpuTimingSourceCompatible(backend: unknown, source: unknown): boolean {
    if (typeof backend !== 'string' || !HOST_RENDERER_BACKENDS.has(backend)) return false
    if (typeof source !== 'string' || !HOST_GPU_TIMING_SOURCES.has(source)) return false
    // Canvas2D exposes no renderer-independent GPU timer. A CPU duration or a
    // neutral host summary must not be relabelled as GPU time.
    if (backend === 'canvas2d') return false
    return matchesGpuTimingBackend(backend, source)
}

export function isTargetGpuTimingSourceCompatible(family: unknown, source: unknown): boolean {
    if (typeof family !== 'string' || !TARGET_RENDERER_FAMILIES.has(family)) return false
    if (typeof source !== 'string' || !TARGET_GPU_TIMING_SOURCES.has(source)) return false
    return matchesGpuTimingBackend(family, source)
}
