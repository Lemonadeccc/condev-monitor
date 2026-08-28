// cspell:ignore gsap profiler rvfc tweens webgl webgpu

/**
 * Explicit, framework-neutral evidence emitted by host integrations.
 *
 * These adapters deliberately do not create semantic interactions. They only
 * forward measurements the host can prove, and they keep sink failures from
 * changing application behavior.
 */

import { isHostGpuTimingSourceCompatible } from './gpu-timing-compatibility'
import { BoundedRing, durationStatistics } from './statistics'
import type { DurationStatistics } from './types'

export type AnimationHostFramework = 'react' | 'preact' | 'vue' | 'angular' | 'svelte' | 'solid' | 'qwik' | 'lit' | 'vanilla' | 'other'

export type AnimationFrameworkCommitPhase = 'mount' | 'update' | 'check' | 'nested-update' | 'hydrate' | 'other'

export interface AnimationFrameworkStatsSample {
    source: 'manual' | 'react-profiler' | 'framework-lifecycle' | 'framework-check'
    framework: AnimationHostFramework
    phase: AnimationFrameworkCommitPhase
    /** Render work only. React Profiler actualDuration is recorded here. */
    renderMs?: number
    /** Commit work only when the host measured it independently. */
    commitMs?: number
    /** React Profiler baseDuration; it is not a commit duration. */
    baseRenderMs?: number
    /** Host lifecycle update window; it is not framework render or commit work. */
    updateWindowMs?: number
    /** Host component check window; it does not prove a DOM update, paint, or GPU work. */
    checkWindowMs?: number
    timestampMs: number
}

export type AnimationRendererBackend = 'canvas2d' | 'webgl' | 'webgl2' | 'webgpu' | 'unknown'
export type AnimationThreeRendererBackend = Exclude<AnimationRendererBackend, 'canvas2d'>
export type AnimationHostGpuTimingSource = 'webgl-disjoint-timer-query' | 'webgpu-timestamp-query' | 'host-timer-query'
export type AnimationGpuTimingStatus = 'measured' | 'not-provided' | 'invalid' | 'disjoint' | 'context-lost' | 'error'
export type AnimationGpuTimerCapability = 'supported' | 'unsupported' | 'disabled' | 'unknown'

export type AnimationGpuTimingEvidence =
    | {
          status: 'measured'
          timeMs: number
          source: AnimationHostGpuTimingSource
          valid: true
          disjoint: false
          contextLost: false
      }
    | {
          status: Exclude<AnimationGpuTimingStatus, 'measured'>
          timeMs?: never
          source?: AnimationHostGpuTimingSource
          valid?: boolean
          disjoint?: boolean
          contextLost?: boolean
      }

export interface AnimationRenderStatsSample {
    source: 'three-renderer-info' | 'renderer-host'
    backend: AnimationRendererBackend
    timestampMs: number
    /** Explicit timer availability. Omission keeps legacy GPU-status inference. */
    gpuTimerCapability?: AnimationGpuTimerCapability
    drawCalls?: number
    triangles?: number
    lines?: number
    points?: number
    geometries?: number
    textures?: number
    programs?: number
    gpu: AnimationGpuTimingEvidence
}

export type AnimationLifecycleCheckpoint = 'mount' | 'after-interaction' | 'unmount' | 'manual'
export type AnimationLifecycleReadStatus = 'measured' | 'unsupported' | 'error'

export interface AnimationLifecycleCountEvidence {
    status: AnimationLifecycleReadStatus
    total?: number
    active?: number
    rejectedActiveChecks?: number
}

export interface AnimationLifecycleStatsSample {
    source: 'gsap-public-api'
    checkpoint: AnimationLifecycleCheckpoint
    timestampMs: number
    animations: AnimationLifecycleCountEvidence
    scrollTriggers: AnimationLifecycleCountEvidence
}

export interface AnimationWorkStatsSample {
    source: 'host'
    timestampMs: number
    workMs: number
    category: 'script' | 'layout' | 'paint' | 'composite' | 'other'
}

export type AnimationPlaybackQualityStatus = 'measured' | 'unsupported' | 'error'

export interface AnimationMediaStatsSample {
    source: 'video-rvfc'
    timestampMs: number
    callbackIntervalMs: number
    mediaTimeDeltaMs?: number
    presentedFramesDelta?: number
    displayLatenessMs?: number
    processingDurationMs?: number
    playbackQuality: {
        status: AnimationPlaybackQualityStatus
        totalVideoFramesDelta?: number
        droppedVideoFramesDelta?: number
        corruptedVideoFramesDelta?: number
    }
}

/** Closed host-evidence surface; arbitrary event families are intentionally absent. */
export interface AnimationHostEvidenceSink {
    recordFrameworkStats(sample: AnimationFrameworkStatsSample): boolean | void
    recordRenderStats(sample: AnimationRenderStatsSample): boolean | void
    recordLifecycleStats(sample: AnimationLifecycleStatsSample): boolean | void
    recordWorkStats(sample: AnimationWorkStatsSample): boolean | void
    recordMediaStats(sample: AnimationMediaStatsSample): boolean | void
}

export interface FrameworkCommitInput {
    phase?: AnimationFrameworkCommitPhase
    renderMs?: number
    commitMs?: number
    baseRenderMs?: number
    timestampMs?: number
}

export interface FrameworkUpdateWindowInput {
    updateWindowMs: number
    timestampMs?: number
}

export interface FrameworkCheckWindowInput {
    checkWindowMs: number
    timestampMs?: number
}

export interface FrameworkCommitProbe {
    recordCommit(input: FrameworkCommitInput): boolean
    recordUpdateWindow(input: FrameworkUpdateWindowInput): boolean
    recordCheckWindow(input: FrameworkCheckWindowInput): boolean
    /** Compatible with React Profiler's onRender callback without importing React. */
    onReactProfilerRender(
        id: string,
        phase: string,
        actualDuration: number,
        baseDuration: number,
        startTime: number,
        commitTime: number
    ): void
    dispose(): void
}

export interface FrameworkCommitProbeOptions {
    sink: Pick<AnimationHostEvidenceSink, 'recordFrameworkStats'>
    framework: AnimationHostFramework
    now?: () => number
}

function defaultNow(): number {
    return globalThis.performance?.now?.() ?? Date.now()
}

const MAX_HOST_DURATION_MS = 600_000
const MAX_HOST_COUNT = 1_000_000_000
const MAX_HOST_TIMESTAMP_MS = 1_000_000_000_000_000

function finiteNonNegative(value: unknown, maximum = MAX_HOST_DURATION_MS): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : undefined
}

function finiteTimestamp(value: unknown): number | undefined {
    return finiteNonNegative(value, MAX_HOST_TIMESTAMP_MS)
}

function finiteCount(value: unknown): number | undefined {
    const normalized = finiteNonNegative(value, MAX_HOST_COUNT)
    return normalized === undefined || !Number.isInteger(normalized) ? undefined : normalized
}

function safeNow(now: () => number): number {
    try {
        return finiteTimestamp(now()) ?? finiteTimestamp(defaultNow()) ?? 0
    } catch {
        return finiteTimestamp(defaultNow()) ?? 0
    }
}

function safeEmit(emit: () => boolean | void): boolean {
    try {
        return emit() !== false
    } catch {
        return false
    }
}

function normalizeFrameworkPhase(phase: unknown): AnimationFrameworkCommitPhase {
    if (phase === 'mount' || phase === 'update' || phase === 'check' || phase === 'nested-update' || phase === 'hydrate') return phase
    return 'other'
}

function normalizeHostFramework(framework: unknown): AnimationHostFramework {
    return ['react', 'preact', 'vue', 'angular', 'svelte', 'solid', 'qwik', 'lit', 'vanilla'].includes(framework as string)
        ? (framework as AnimationHostFramework)
        : 'other'
}

export function createFrameworkCommitProbe(options: FrameworkCommitProbeOptions): FrameworkCommitProbe {
    const now = options.now ?? defaultNow
    const framework = normalizeHostFramework(options.framework)
    let disposed = false

    const record = (input: FrameworkCommitInput, source: AnimationFrameworkStatsSample['source']): boolean => {
        if (disposed) return false
        const renderMs = finiteNonNegative(input.renderMs)
        const commitMs = finiteNonNegative(input.commitMs)
        const baseRenderMs = finiteNonNegative(input.baseRenderMs)
        if (renderMs === undefined && commitMs === undefined) return false

        const sample: AnimationFrameworkStatsSample = {
            source,
            framework,
            phase: normalizeFrameworkPhase(input.phase),
            timestampMs: finiteTimestamp(input.timestampMs) ?? safeNow(now),
            ...(renderMs === undefined ? {} : { renderMs }),
            ...(commitMs === undefined ? {} : { commitMs }),
            ...(baseRenderMs === undefined ? {} : { baseRenderMs }),
        }
        return safeEmit(() => options.sink.recordFrameworkStats(sample))
    }

    return {
        recordCommit(input): boolean {
            return record(input, 'manual')
        },
        recordUpdateWindow(input): boolean {
            if (disposed) return false
            const updateWindowMs = finiteNonNegative(input.updateWindowMs)
            if (updateWindowMs === undefined) return false
            return safeEmit(() =>
                options.sink.recordFrameworkStats({
                    source: 'framework-lifecycle',
                    framework,
                    phase: 'update',
                    updateWindowMs,
                    timestampMs: finiteTimestamp(input.timestampMs) ?? safeNow(now),
                })
            )
        },
        recordCheckWindow(input): boolean {
            if (disposed) return false
            const checkWindowMs = finiteNonNegative(input.checkWindowMs)
            if (checkWindowMs === undefined) return false
            return safeEmit(() =>
                options.sink.recordFrameworkStats({
                    source: 'framework-check',
                    framework,
                    phase: 'check',
                    checkWindowMs,
                    timestampMs: finiteTimestamp(input.timestampMs) ?? safeNow(now),
                })
            )
        },
        onReactProfilerRender(_id, phase, actualDuration, baseDuration, _startTime, commitTime): void {
            if (framework !== 'react') return
            // React commitTime is a timestamp. It must never be relabelled as commit work.
            record(
                {
                    phase: normalizeFrameworkPhase(phase),
                    renderMs: actualDuration,
                    baseRenderMs: baseDuration,
                    timestampMs: commitTime,
                },
                'react-profiler'
            )
        },
        dispose(): void {
            disposed = true
        },
    }
}

export interface ThreeRendererLike {
    info?: {
        render?: {
            calls?: number
            triangles?: number
            lines?: number
            points?: number
        }
        memory?: {
            geometries?: number
            textures?: number
        }
        programs?: ArrayLike<unknown> | null
    }
    getContext?(): {
        isContextLost?(): boolean
    } | null
}

export interface ThreeGpuTimingReading {
    timeMs: number
    valid: boolean
    disjoint: boolean
    contextLost: boolean
    source?: AnimationHostGpuTimingSource
}

/**
 * A completed GPU timer result supplied by a renderer integration. The probe
 * never starts a query or waits for the GPU; callers may only hand it evidence
 * that their renderer has already resolved.
 */
export type RendererHostGpuTimingReading =
    | (ThreeGpuTimingReading & { status?: never })
    | {
          status: 'measured'
          timeMs: number
          source: AnimationHostGpuTimingSource
          valid?: never
          disjoint?: never
          contextLost?: never
      }
    | {
          status: Exclude<AnimationGpuTimingStatus, 'measured'>
          timeMs?: never
          source?: AnimationHostGpuTimingSource
          valid?: never
          disjoint?: never
          contextLost?: never
      }

/** Closed, engine-neutral renderer evidence read explicitly by the host. */
export interface RendererHostReading {
    /** Explicit timer availability. Omission keeps legacy GPU-status inference. */
    gpuTimerCapability?: AnimationGpuTimerCapability
    drawCalls?: number
    triangles?: number
    lines?: number
    points?: number
    geometries?: number
    textures?: number
    programs?: number
    contextLost?: boolean
    gpu?: RendererHostGpuTimingReading | null
}

export interface RendererHostProbeOptions {
    sink: Pick<AnimationHostEvidenceSink, 'recordRenderStats'>
    /** Backend provenance is fixed by the integration, not inferred from counters. */
    backend?: AnimationRendererBackend
    /** One explicit, side-effect-free read of public host counters per capture. */
    read: () => RendererHostReading | null | undefined
    now?: () => number
}

export interface RendererHostProbe {
    capture(): AnimationRenderStatsSample | null
    dispose(): void
}

export interface ThreeRendererSnapshotOptions {
    backend?: AnimationThreeRendererBackend
    now?: () => number
    readGpuTiming?: () => RendererHostGpuTimingReading | null | undefined
}

export interface ThreeRendererProbeOptions extends ThreeRendererSnapshotOptions {
    sink: Pick<AnimationHostEvidenceSink, 'recordRenderStats'>
    renderer: ThreeRendererLike
}

export interface ThreeRendererProbe {
    capture(): AnimationRenderStatsSample | null
    dispose(): void
}

const GPU_TIMING_SOURCES = new Set<AnimationHostGpuTimingSource>([
    'webgl-disjoint-timer-query',
    'webgpu-timestamp-query',
    'host-timer-query',
])
const GPU_TIMER_CAPABILITIES = new Set<AnimationGpuTimerCapability>(['supported', 'unsupported', 'disabled', 'unknown'])

function normalizeRendererBackend(backend: unknown): AnimationRendererBackend {
    return backend === 'canvas2d' || backend === 'webgl' || backend === 'webgl2' || backend === 'webgpu' ? backend : 'unknown'
}

function normalizeThreeRendererBackend(backend: unknown): AnimationThreeRendererBackend {
    return backend === 'webgl' || backend === 'webgl2' || backend === 'webgpu' ? backend : 'unknown'
}

function safeProperty<T>(read: () => T): T | undefined {
    try {
        return read()
    } catch {
        return undefined
    }
}

type SafePropertyResult<T> = { ok: true; value: T } | { ok: false }

function safePropertyResult<T>(read: () => T): SafePropertyResult<T> {
    try {
        return { ok: true, value: read() }
    } catch {
        return { ok: false }
    }
}

function rendererContextLost(renderer: ThreeRendererLike): boolean | 'error' | undefined {
    if (!renderer.getContext) return undefined
    let context: ReturnType<NonNullable<ThreeRendererLike['getContext']>>
    try {
        context = renderer.getContext()
    } catch {
        return 'error'
    }
    if (!context?.isContextLost) return undefined
    try {
        return context.isContextLost()
    } catch {
        return 'error'
    }
}

function readGpuEvidence(
    renderer: ThreeRendererLike,
    backend: AnimationRendererBackend,
    readGpuTiming: ThreeRendererSnapshotOptions['readGpuTiming']
): AnimationGpuTimingEvidence {
    if (!readGpuTiming) return { status: 'not-provided' }

    let reading: RendererHostGpuTimingReading | null | undefined
    try {
        reading = readGpuTiming()
    } catch {
        return { status: 'error' }
    }
    if (!reading) return { status: 'not-provided' }

    const contextLost = rendererContextLost(renderer)
    if (contextLost === 'error') return { status: 'error' }
    try {
        return normalizeRendererHostGpuEvidence(reading, backend, contextLost)
    } catch {
        return { status: 'error' }
    }
}

function normalizeRendererHostGpuEvidence(
    reading: RendererHostGpuTimingReading | null | undefined,
    backend: AnimationRendererBackend,
    contextLost: unknown
): AnimationGpuTimingEvidence {
    if (contextLost !== undefined && typeof contextLost !== 'boolean') return { status: 'error' }
    if (contextLost === true) return { status: 'context-lost' }
    if (!reading) return { status: 'not-provided' }

    if (typeof reading !== 'object' || Array.isArray(reading)) return { status: 'invalid' }
    const candidate = reading as RendererHostGpuTimingReading & Record<string, unknown>
    const hasStatus = 'status' in candidate
    const sourceValue = candidate.source
    const source = GPU_TIMING_SOURCES.has(sourceValue as AnimationHostGpuTimingSource)
        ? (sourceValue as AnimationHostGpuTimingSource)
        : undefined
    if (sourceValue !== undefined && source === undefined) return { status: 'invalid' }

    if (hasStatus) {
        const status = candidate.status
        if (
            status !== 'measured' &&
            status !== 'not-provided' &&
            status !== 'invalid' &&
            status !== 'disjoint' &&
            status !== 'context-lost' &&
            status !== 'error'
        ) {
            return { status: 'invalid', ...(source ? { source } : {}) }
        }

        const hasTimeMs = 'timeMs' in candidate
        const hasLegacyFlags = 'valid' in candidate || 'disjoint' in candidate || 'contextLost' in candidate
        if (status === 'measured') {
            const timeMs = finiteNonNegative(candidate.timeMs)
            if (!hasTimeMs || hasLegacyFlags || timeMs === undefined || !source) {
                return { status: 'invalid', ...(source ? { source } : {}) }
            }
            if (!isHostGpuTimingSourceCompatible(backend, source)) return { status: 'invalid', source }
            return { status: 'measured', timeMs, source, valid: true, disjoint: false, contextLost: false }
        }

        if (hasTimeMs || hasLegacyFlags) return { status: 'invalid', ...(source ? { source } : {}) }
        return { status, ...(source ? { source } : {}) }
    }

    // Backward-compatible path for the original Three-style result shape.
    const timeMs = finiteNonNegative(candidate.timeMs)
    if (candidate.contextLost !== false) return { status: 'context-lost', ...(source ? { source } : {}) }
    if (candidate.disjoint !== false) return { status: 'disjoint', ...(source ? { source } : {}) }
    if (candidate.valid !== true || timeMs === undefined || !source) return { status: 'invalid', ...(source ? { source } : {}) }
    if (!isHostGpuTimingSourceCompatible(backend, source)) return { status: 'invalid', source }
    return { status: 'measured', timeMs, source, valid: true, disjoint: false, contextLost: false }
}

/**
 * Creates a zero-dependency renderer probe around an explicit host read.
 *
 * It does not schedule frames, patch renderer methods, wait for the GPU, or
 * inspect private fields. Explicit invalid counters reject the whole reading,
 * and GPU provenance stays fail-closed before the sink sees the sample.
 */
export function createRendererHostProbe(options: RendererHostProbeOptions): RendererHostProbe {
    const backend = normalizeRendererBackend(options.backend)
    const now = options.now ?? defaultNow
    let disposed = false

    return {
        capture(): AnimationRenderStatsSample | null {
            if (disposed) return null

            let reading: RendererHostReading | null | undefined
            try {
                reading = options.read()
            } catch {
                return null
            }
            if (typeof reading !== 'object' || reading === null) return null
            try {
                if (Array.isArray(reading)) return null
            } catch {
                return null
            }
            const snapshot = reading
            const normalizedCounts: Partial<
                Pick<AnimationRenderStatsSample, 'drawCalls' | 'triangles' | 'lines' | 'points' | 'geometries' | 'textures' | 'programs'>
            > = {}
            for (const field of ['drawCalls', 'triangles', 'lines', 'points', 'geometries', 'textures', 'programs'] as const) {
                const property = safePropertyResult(() => snapshot[field])
                if (!property.ok) return null
                if (property.value === undefined) continue
                const count = finiteCount(property.value)
                // An explicitly supplied invalid counter is an invalid reading,
                // not the same thing as an unobserved optional counter.
                if (count === undefined) return null
                normalizedCounts[field] = count
            }
            const contextLost = safePropertyResult(() => snapshot.contextLost)
            if (contextLost.ok && contextLost.value !== undefined && typeof contextLost.value !== 'boolean') return null
            const gpuTimerCapability = safePropertyResult(() => snapshot.gpuTimerCapability)
            if (
                !gpuTimerCapability.ok ||
                (gpuTimerCapability.value !== undefined && !GPU_TIMER_CAPABILITIES.has(gpuTimerCapability.value))
            ) {
                return null
            }
            if (backend === 'canvas2d' && gpuTimerCapability.value === 'supported') return null
            const gpu = safePropertyResult(() => snapshot.gpu)
            let gpuEvidence: AnimationGpuTimingEvidence
            if (!contextLost.ok || !gpu.ok) {
                gpuEvidence = { status: 'error' }
            } else {
                try {
                    gpuEvidence = normalizeRendererHostGpuEvidence(gpu.value, backend, contextLost.value)
                } catch {
                    // Nested accessors and revoked proxies are untrusted host
                    // boundaries too. They must never escape or become measured.
                    gpuEvidence = { status: 'error' }
                }
            }
            if (
                gpuTimerCapability.value !== undefined &&
                ((gpuEvidence.status === 'measured' && gpuTimerCapability.value !== 'supported') ||
                    (gpuTimerCapability.value === 'supported' &&
                        (gpuEvidence.status === 'context-lost' || gpuEvidence.status === 'error')) ||
                    ((gpuTimerCapability.value === 'unsupported' || gpuTimerCapability.value === 'disabled') &&
                        gpuEvidence.status !== 'not-provided'))
            ) {
                return null
            }
            const sample: AnimationRenderStatsSample = {
                source: 'renderer-host',
                backend,
                timestampMs: safeNow(now),
                ...(gpuTimerCapability.value === undefined ? {} : { gpuTimerCapability: gpuTimerCapability.value }),
                ...normalizedCounts,
                gpu: gpuEvidence,
            }
            safeEmit(() => options.sink.recordRenderStats(sample))
            return sample
        },
        dispose(): void {
            disposed = true
        },
    }
}

export function readThreeRendererSnapshot(
    renderer: ThreeRendererLike,
    options: ThreeRendererSnapshotOptions = {}
): AnimationRenderStatsSample {
    const now = options.now ?? defaultNow
    const backend = normalizeThreeRendererBackend(options.backend)
    const drawCalls = finiteCount(safeProperty(() => renderer.info?.render?.calls))
    const triangles = finiteCount(safeProperty(() => renderer.info?.render?.triangles))
    const lines = finiteCount(safeProperty(() => renderer.info?.render?.lines))
    const points = finiteCount(safeProperty(() => renderer.info?.render?.points))
    const geometries = finiteCount(safeProperty(() => renderer.info?.memory?.geometries))
    const textures = finiteCount(safeProperty(() => renderer.info?.memory?.textures))
    const programs = finiteCount(safeProperty(() => renderer.info?.programs?.length))

    return {
        source: 'three-renderer-info',
        backend,
        timestampMs: safeNow(now),
        ...(drawCalls === undefined ? {} : { drawCalls }),
        ...(triangles === undefined ? {} : { triangles }),
        ...(lines === undefined ? {} : { lines }),
        ...(points === undefined ? {} : { points }),
        ...(geometries === undefined ? {} : { geometries }),
        ...(textures === undefined ? {} : { textures }),
        ...(programs === undefined ? {} : { programs }),
        gpu: readGpuEvidence(renderer, backend, options.readGpuTiming),
    }
}

export function createThreeRendererProbe(options: ThreeRendererProbeOptions): ThreeRendererProbe {
    let disposed = false
    return {
        capture(): AnimationRenderStatsSample | null {
            if (disposed) return null
            const sample = readThreeRendererSnapshot(options.renderer, options)
            safeEmit(() => options.sink.recordRenderStats(sample))
            return sample
        },
        dispose(): void {
            disposed = true
        },
    }
}

export interface GsapLike {
    globalTimeline?: {
        getChildren?(nested?: boolean, tweens?: boolean, timelines?: boolean): readonly unknown[]
    }
}

export interface GsapAnimationLike {
    isActive?(): boolean
}

export interface ScrollTriggerLike {
    getAll?(): readonly unknown[]
}

export interface GsapLifecycleSources {
    gsap?: GsapLike
    scrollTrigger?: ScrollTriggerLike
}

export interface GsapLifecycleSnapshotOptions {
    checkpoint?: AnimationLifecycleCheckpoint
    now?: () => number
}

export interface GsapLifecycleProbeOptions extends GsapLifecycleSources, GsapLifecycleSnapshotOptions {
    sink: Pick<AnimationHostEvidenceSink, 'recordLifecycleStats'>
}

export interface GsapLifecycleProbe {
    capture(checkpoint?: AnimationLifecycleCheckpoint): AnimationLifecycleStatsSample | null
    dispose(): void
}

function normalizeLifecycleCheckpoint(checkpoint: unknown): AnimationLifecycleCheckpoint {
    return checkpoint === 'mount' || checkpoint === 'after-interaction' || checkpoint === 'unmount' ? checkpoint : 'manual'
}

function readGsapAnimationCounts(gsap: GsapLike | undefined): AnimationLifecycleCountEvidence {
    if (!gsap?.globalTimeline?.getChildren) return { status: 'unsupported' }
    let children: readonly unknown[]
    try {
        // getChildren is a public GSAP API. Private ticker internals are intentionally untouched.
        children = gsap.globalTimeline.getChildren(true, true, true)
    } catch {
        return { status: 'error' }
    }
    if (!Array.isArray(children)) return { status: 'error' }

    let active = 0
    let rejectedActiveChecks = 0
    for (const child of children) {
        const isActive = (child as GsapAnimationLike | null)?.isActive
        if (typeof isActive !== 'function') {
            rejectedActiveChecks += 1
            continue
        }
        try {
            if (isActive.call(child)) active += 1
        } catch {
            rejectedActiveChecks += 1
        }
    }
    return {
        status: 'measured',
        total: children.length,
        ...(rejectedActiveChecks === 0 ? { active } : {}),
        ...(rejectedActiveChecks === 0 ? {} : { rejectedActiveChecks }),
    }
}

function readScrollTriggerCounts(scrollTrigger: ScrollTriggerLike | undefined): AnimationLifecycleCountEvidence {
    if (!scrollTrigger?.getAll) return { status: 'unsupported' }
    try {
        const triggers = scrollTrigger.getAll()
        if (!Array.isArray(triggers)) return { status: 'error' }
        return { status: 'measured', total: triggers.length }
    } catch {
        return { status: 'error' }
    }
}

export function readGsapLifecycleSnapshot(
    sources: GsapLifecycleSources,
    options: GsapLifecycleSnapshotOptions = {}
): AnimationLifecycleStatsSample {
    const now = options.now ?? defaultNow
    return {
        source: 'gsap-public-api',
        checkpoint: normalizeLifecycleCheckpoint(options.checkpoint),
        timestampMs: safeNow(now),
        animations: readGsapAnimationCounts(sources.gsap),
        scrollTriggers: readScrollTriggerCounts(sources.scrollTrigger),
    }
}

export function createGsapLifecycleProbe(options: GsapLifecycleProbeOptions): GsapLifecycleProbe {
    let disposed = false
    return {
        capture(checkpoint = options.checkpoint ?? 'manual'): AnimationLifecycleStatsSample | null {
            if (disposed) return null
            const sample = readGsapLifecycleSnapshot(options, {
                checkpoint: normalizeLifecycleCheckpoint(checkpoint),
                now: options.now,
            })
            safeEmit(() => options.sink.recordLifecycleStats(sample))
            return sample
        },
        dispose(): void {
            // The probe owns no GSAP animation and therefore never calls kill().
            disposed = true
        },
    }
}

export interface GsapLifecycleCycleAnalyzerOptions {
    /** At least three equivalent completed cycles are required. Defaults to 3. */
    minimumCycles?: number
    /** Bounded retained cleanup tail. Defaults to 10 and cannot be lower than `minimumCycles`. */
    capacity?: number
}

export type GsapLifecycleCycleAnalysisStatus = 'insufficient-cycles' | 'inconclusive' | 'no-strict-growth-candidate' | 'growth-candidate'

export interface GsapLifecycleCycleAnalysis {
    status: GsapLifecycleCycleAnalysisStatus
    /** Never a leak verdict. Null means insufficient or incomplete evidence. */
    growthCandidate: boolean | null
    animationGrowthCandidate: boolean | null
    scrollTriggerGrowthCandidate: boolean | null
    completedCycleCount: number
    retainedCycleCount: number
    minimumCycles: number
    capacity: number
    droppedCycleCount: number
    rejectedCheckpointCount: number
    truncated: boolean
    postUnmountAnimationTotals: readonly (number | null)[]
    postUnmountScrollTriggerTotals: readonly (number | null)[]
}

export interface GsapLifecycleCycleAnalyzer {
    /** Accepts only an ordered mount → after-interaction → unmount sequence. */
    record(sample: AnimationLifecycleStatsSample | null | undefined): boolean
    snapshot(): GsapLifecycleCycleAnalysis
    reset(): void
    dispose(): void
}

interface GsapLifecycleCompletedCycle {
    animations: number | null
    scrollTriggers: number | null
}

function boundedCycleInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
    const normalized = finiteCount(value)
    if (normalized === undefined) return fallback
    return Math.min(maximum, Math.max(minimum, normalized))
}

function lifecycleCleanupTotal(evidence: AnimationLifecycleCountEvidence): number | null {
    if (evidence?.status !== 'measured') return null
    return finiteCount(evidence.total) ?? null
}

function trailingGrowthCandidate(values: readonly (number | null)[], minimumCycles: number): boolean | null {
    if (values.length < minimumCycles) return null
    const tail = values.slice(-minimumCycles)
    if (tail.some(value => value === null)) return null
    return tail.slice(1).every((value, index) => (value as number) > (tail[index] as number))
}

/**
 * Compares explicit, caller-declared equivalent lifecycle cycles.
 *
 * It never creates or controls animations and cannot prove a memory leak. A
 * candidate means only that a retained post-unmount public inventory increased
 * strictly across the configured trailing cycle window.
 */
export function createGsapLifecycleCycleAnalyzer(options: GsapLifecycleCycleAnalyzerOptions = {}): GsapLifecycleCycleAnalyzer {
    const minimumCycles = boundedCycleInteger(options.minimumCycles, 3, 3, 20)
    const capacity = boundedCycleInteger(options.capacity, Math.max(10, minimumCycles), minimumCycles, 100)
    const cycles: GsapLifecycleCompletedCycle[] = []
    let phase: 'idle' | 'mounted' | 'interacted' = 'idle'
    let completedCycleCount = 0
    let droppedCycleCount = 0
    let rejectedCheckpointCount = 0
    let disposed = false

    const reset = (): void => {
        if (disposed) return
        cycles.length = 0
        phase = 'idle'
        completedCycleCount = 0
        droppedCycleCount = 0
        rejectedCheckpointCount = 0
    }

    return {
        record(sample): boolean {
            if (disposed) return false
            if (!sample || sample.source !== 'gsap-public-api') {
                rejectedCheckpointCount += 1
                phase = 'idle'
                return false
            }
            if (sample.checkpoint === 'mount') {
                if (phase !== 'idle') rejectedCheckpointCount += 1
                phase = 'mounted'
                return true
            }
            if (sample.checkpoint === 'after-interaction' && phase === 'mounted') {
                phase = 'interacted'
                return true
            }
            if (sample.checkpoint !== 'unmount' || phase !== 'interacted') {
                rejectedCheckpointCount += 1
                phase = 'idle'
                return false
            }

            phase = 'idle'
            completedCycleCount += 1
            cycles.push({
                animations: lifecycleCleanupTotal(sample.animations),
                scrollTriggers: lifecycleCleanupTotal(sample.scrollTriggers),
            })
            if (cycles.length > capacity) {
                cycles.shift()
                droppedCycleCount += 1
            }
            return true
        },
        snapshot(): GsapLifecycleCycleAnalysis {
            const postUnmountAnimationTotals = cycles.map(cycle => cycle.animations)
            const postUnmountScrollTriggerTotals = cycles.map(cycle => cycle.scrollTriggers)
            const animationGrowthCandidate = trailingGrowthCandidate(postUnmountAnimationTotals, minimumCycles)
            const scrollTriggerGrowthCandidate = trailingGrowthCandidate(postUnmountScrollTriggerTotals, minimumCycles)
            const growthCandidate =
                animationGrowthCandidate === true || scrollTriggerGrowthCandidate === true
                    ? true
                    : animationGrowthCandidate === false && scrollTriggerGrowthCandidate === false
                      ? false
                      : null
            const status: GsapLifecycleCycleAnalysisStatus =
                cycles.length < minimumCycles
                    ? 'insufficient-cycles'
                    : growthCandidate === true
                      ? 'growth-candidate'
                      : growthCandidate === false
                        ? 'no-strict-growth-candidate'
                        : 'inconclusive'
            return {
                status,
                growthCandidate,
                animationGrowthCandidate,
                scrollTriggerGrowthCandidate,
                completedCycleCount,
                retainedCycleCount: cycles.length,
                minimumCycles,
                capacity,
                droppedCycleCount,
                rejectedCheckpointCount,
                truncated: droppedCycleCount > 0,
                postUnmountAnimationTotals: Object.freeze(postUnmountAnimationTotals),
                postUnmountScrollTriggerTotals: Object.freeze(postUnmountScrollTriggerTotals),
            }
        },
        reset,
        dispose(): void {
            disposed = true
            phase = 'idle'
        },
    }
}

export type GsapTickerCallback = (timeSeconds: number, deltaTimeMs: number, frame: number) => void

/** Narrow public GSAP ticker surface supplied by the host application. */
export interface GsapTickerLike {
    add(callback: GsapTickerCallback): void
    remove(callback: GsapTickerCallback): void
}

export interface GsapTickerObserverOptions {
    ticker: Partial<GsapTickerLike>
    /** Bounded retained delta-time tail. Defaults to 256 and is capped at 4,096. */
    capacity?: number
    /** Optional application-owned cadence threshold; no universal default is inferred. */
    slowTickThresholdMs?: number
}

export type GsapTickerObserverStatus = 'idle' | 'observing' | 'unsupported' | 'add-failed' | 'remove-failed' | 'disposed'

export interface GsapTickerCadenceSnapshot {
    status: GsapTickerObserverStatus
    running: boolean
    /** True when the observer could not prove that its listener was removed. */
    cleanupFailed: boolean
    capacity: number
    acceptedTickCount: number
    retainedTickCount: number
    droppedTickCount: number
    rejectedTickCount: number
    truncated: boolean
    slowTickThresholdMs: number | null
    /** Full-stream count against the caller-owned threshold, not a page FPS verdict. */
    slowTickTotalObservedCount: number | null
    /** Retained GSAP ticker callback delta distribution; it is not presented-frame time. */
    deltaTimeMs: DurationStatistics | null
}

export interface GsapTickerObserver {
    readonly running: boolean
    start(): boolean
    /** Returns false when listener removal could not be proved. */
    stop(): boolean
    snapshot(): GsapTickerCadenceSnapshot
    reset(): void
    dispose(): void
}

function incrementBoundedCount(value: number): number {
    return Math.min(MAX_HOST_COUNT, value + 1)
}

/**
 * Observes the public GSAP ticker callback cadence without controlling GSAP.
 *
 * The observer calls `ticker.add(listener)` with no ordering arguments and
 * removes that exact listener identity. It never reads or changes ticker FPS,
 * lag smoothing, animation time, or browser frame scheduling. GSAP delta time
 * may be smoothed or background-throttled, so this result must not be labelled
 * page FPS, display cadence, or presented-frame timing.
 */
export function createGsapTickerObserver(options: GsapTickerObserverOptions): GsapTickerObserver {
    const capacity = boundedCycleInteger(options.capacity, 256, 1, 4_096)
    const normalizedThreshold = finiteNonNegative(options.slowTickThresholdMs, 10_000)
    const slowTickThresholdMs = normalizedThreshold !== undefined && normalizedThreshold > 0 ? normalizedThreshold : null
    let ticker: Partial<GsapTickerLike> | null = null
    let tickerReadFailed = false
    try {
        // Pin one registration target. A mutable options object must not redirect
        // teardown to a different ticker after start.
        ticker = options.ticker
    } catch {
        tickerReadFailed = true
    }
    let deltas = new BoundedRing<number>(capacity)
    let rejectedTickCount = 0
    let slowTickTotalObservedCount = 0
    let collecting = false
    let registered = false
    let registeredRemove: GsapTickerLike['remove'] | null = null
    let cleanupFailed = false
    let disposed = false
    let status: GsapTickerObserverStatus = tickerReadFailed ? 'add-failed' : 'idle'

    const listener: GsapTickerCallback = (_timeSeconds, deltaTimeMs): void => {
        if (!collecting || disposed) return
        const normalizedDelta = finiteNonNegative(deltaTimeMs)
        if (normalizedDelta === undefined || normalizedDelta <= 0) {
            rejectedTickCount = incrementBoundedCount(rejectedTickCount)
            return
        }
        deltas.push(normalizedDelta)
        if (slowTickThresholdMs !== null && normalizedDelta > slowTickThresholdMs) {
            slowTickTotalObservedCount = incrementBoundedCount(slowTickTotalObservedCount)
        }
    }

    const removeListener = (successStatus: GsapTickerObserverStatus, failureStatus: GsapTickerObserverStatus): boolean => {
        collecting = false
        if (!registered) {
            if (status === 'observing') status = successStatus
            return true
        }
        if (!ticker || !registeredRemove) {
            cleanupFailed = true
            status = failureStatus
            return false
        }
        try {
            registeredRemove.call(ticker, listener)
            registered = false
            registeredRemove = null
            cleanupFailed = false
            status = successStatus
            return true
        } catch {
            cleanupFailed = true
            status = failureStatus
            return false
        }
    }

    return {
        get running(): boolean {
            return collecting
        },
        start(): boolean {
            if (disposed || collecting || registered) return false
            let add: GsapTickerLike['add'] | undefined
            let remove: GsapTickerLike['remove'] | undefined
            try {
                add = ticker?.add
                remove = ticker?.remove
            } catch {
                status = 'add-failed'
                return false
            }
            if (!ticker || typeof add !== 'function' || typeof remove !== 'function') {
                status = 'unsupported'
                return false
            }
            // Treat registration as uncertain before invoking host code: an
            // implementation may attach the callback and then throw.
            registered = true
            registeredRemove = remove
            try {
                // Default ordering observes after GSAP core updates and does not
                // prioritize the monitor ahead of application animation work.
                add.call(ticker, listener)
            } catch {
                status = 'add-failed'
                removeListener('add-failed', 'add-failed')
                return false
            }
            collecting = true
            cleanupFailed = false
            status = 'observing'
            return true
        },
        stop(): boolean {
            if (disposed) return removeListener('disposed', 'disposed')
            if (status === 'add-failed') return removeListener('add-failed', 'add-failed')
            if (status === 'unsupported') return true
            return removeListener('idle', 'remove-failed')
        },
        snapshot(): GsapTickerCadenceSnapshot {
            const retained = deltas.toArray()
            return {
                status,
                running: collecting,
                cleanupFailed,
                capacity,
                acceptedTickCount: deltas.totalCount,
                retainedTickCount: deltas.retainedCount,
                droppedTickCount: deltas.droppedCount,
                rejectedTickCount,
                truncated: deltas.droppedCount > 0,
                slowTickThresholdMs,
                slowTickTotalObservedCount: slowTickThresholdMs === null ? null : slowTickTotalObservedCount,
                deltaTimeMs: durationStatistics(retained),
            }
        },
        reset(): void {
            if (disposed) return
            deltas = new BoundedRing<number>(capacity)
            rejectedTickCount = 0
            slowTickTotalObservedCount = 0
        },
        dispose(): void {
            if (disposed && !registered) return
            collecting = false
            disposed = true
            removeListener('disposed', 'disposed')
            status = 'disposed'
        },
    }
}

export interface VideoPlaybackQualityLike {
    totalVideoFrames: number
    droppedVideoFrames: number
    corruptedVideoFrames?: number
}

export interface VideoFrameMetadataLike {
    mediaTime?: number
    presentedFrames?: number
    expectedDisplayTime?: number
    processingDuration?: number
}

export type VideoFrameRequestCallbackLike = (now: number, metadata: VideoFrameMetadataLike) => void

export interface VideoFrameSourceLike {
    requestVideoFrameCallback?(callback: VideoFrameRequestCallbackLike): number
    cancelVideoFrameCallback?(handle: number): void
    getVideoPlaybackQuality?(): VideoPlaybackQualityLike
}

export interface VideoPlaybackQualitySnapshot {
    status: AnimationPlaybackQualityStatus
    totalVideoFrames?: number
    droppedVideoFrames?: number
    corruptedVideoFrames?: number
}

export interface VideoFrameProbeOptions {
    sink: Pick<AnimationHostEvidenceSink, 'recordMediaStats'>
    video: VideoFrameSourceLike
    /**
     * Optional aggregate cadence. Intermediate RVFC callbacks keep the probe alive
     * but do not read playback quality or emit. Defaults to every callback.
     */
    minimumSampleIntervalMs?: number
}

export interface VideoFrameProbe {
    readonly running: boolean
    start(): boolean
    /** Re-baseline after hidden/offscreen periods without controlling playback. */
    resetBaseline(): void
    stop(): void
    dispose(): void
}

interface VideoFrameBaseline {
    callbackNowMs: number
    mediaTimeMs?: number
    presentedFrames?: number
    quality: VideoPlaybackQualitySnapshot
}

export function readVideoPlaybackQuality(video: VideoFrameSourceLike): VideoPlaybackQualitySnapshot {
    if (!video.getVideoPlaybackQuality) return { status: 'unsupported' }
    let quality: VideoPlaybackQualityLike
    try {
        quality = video.getVideoPlaybackQuality()
    } catch {
        return { status: 'error' }
    }
    const totalVideoFrames = finiteCount(quality?.totalVideoFrames)
    const droppedVideoFrames = finiteCount(quality?.droppedVideoFrames)
    const corruptedVideoFrames = quality?.corruptedVideoFrames === undefined ? undefined : finiteCount(quality.corruptedVideoFrames)
    if (
        totalVideoFrames === undefined ||
        droppedVideoFrames === undefined ||
        (quality?.corruptedVideoFrames !== undefined && corruptedVideoFrames === undefined)
    ) {
        return { status: 'error' }
    }
    if (droppedVideoFrames > totalVideoFrames || (corruptedVideoFrames !== undefined && corruptedVideoFrames > totalVideoFrames)) {
        return { status: 'error' }
    }
    return {
        status: 'measured',
        totalVideoFrames,
        droppedVideoFrames,
        ...(corruptedVideoFrames === undefined ? {} : { corruptedVideoFrames }),
    }
}

function counterReset(previous: number | undefined, current: number | undefined): boolean {
    return previous !== undefined && current !== undefined && current < previous
}

function playbackCountersReset(previous: VideoPlaybackQualitySnapshot, current: VideoPlaybackQualitySnapshot): boolean {
    if (previous.status !== 'measured' || current.status !== 'measured') return false
    return (
        counterReset(previous.totalVideoFrames, current.totalVideoFrames) ||
        counterReset(previous.droppedVideoFrames, current.droppedVideoFrames) ||
        counterReset(previous.corruptedVideoFrames, current.corruptedVideoFrames)
    )
}

function optionalDelta(current: number | undefined, previous: number | undefined): number | undefined {
    if (current === undefined || previous === undefined || current < previous) return undefined
    return current - previous
}

function nextVideoBaseline(
    callbackNowMs: number,
    metadata: VideoFrameMetadataLike,
    quality: VideoPlaybackQualitySnapshot
): VideoFrameBaseline | null {
    const safeCallbackNow = finiteTimestamp(callbackNowMs)
    if (safeCallbackNow === undefined) return null
    const mediaTimeSeconds = finiteNonNegative(metadata.mediaTime, MAX_HOST_TIMESTAMP_MS / 1_000)
    const presentedFrames = finiteCount(metadata.presentedFrames)
    return {
        callbackNowMs: safeCallbackNow,
        ...(mediaTimeSeconds === undefined ? {} : { mediaTimeMs: mediaTimeSeconds * 1_000 }),
        ...(presentedFrames === undefined ? {} : { presentedFrames }),
        quality,
    }
}

export function createVideoFrameProbe(options: VideoFrameProbeOptions): VideoFrameProbe {
    const minimumSampleIntervalMs = finiteNonNegative(options.minimumSampleIntervalMs, 10_000) ?? 0
    let active = false
    let disposed = false
    let pendingHandle: number | null = null
    let baseline: VideoFrameBaseline | null = null

    const schedule = (): boolean => {
        const request = options.video.requestVideoFrameCallback
        if (!active || !request) return false
        try {
            pendingHandle = request.call(options.video, onVideoFrame)
            return true
        } catch {
            pendingHandle = null
            active = false
            return false
        }
    }

    const onVideoFrame: VideoFrameRequestCallbackLike = (callbackNowMs, metadata): void => {
        pendingHandle = null
        if (!active) return

        const safeCallbackNow = finiteTimestamp(callbackNowMs)
        if (
            safeCallbackNow !== undefined &&
            baseline &&
            safeCallbackNow >= baseline.callbackNowMs &&
            safeCallbackNow - baseline.callbackNowMs < minimumSampleIntervalMs
        ) {
            schedule()
            return
        }

        const quality = readVideoPlaybackQuality(options.video)
        const current = nextVideoBaseline(callbackNowMs, metadata, quality)
        if (!current) {
            baseline = null
            schedule()
            return
        }

        const previous = baseline
        const reset =
            previous !== null &&
            (current.callbackNowMs < previous.callbackNowMs ||
                counterReset(previous.mediaTimeMs, current.mediaTimeMs) ||
                counterReset(previous.presentedFrames, current.presentedFrames) ||
                (current.quality.status === 'measured' && previous.quality.status !== 'measured') ||
                playbackCountersReset(previous.quality, current.quality))
        baseline = current

        // The first callback and every counter reset establish a baseline only.
        if (previous && !reset) {
            const callbackIntervalMs = current.callbackNowMs - previous.callbackNowMs
            const mediaTimeDeltaMs = optionalDelta(current.mediaTimeMs, previous.mediaTimeMs)
            const presentedFramesDelta = optionalDelta(current.presentedFrames, previous.presentedFrames)
            const expectedDisplayTime = finiteTimestamp(metadata.expectedDisplayTime)
            const processingDurationSeconds = finiteNonNegative(metadata.processingDuration, MAX_HOST_DURATION_MS / 1_000)
            const displayLatenessMs =
                expectedDisplayTime === undefined ? undefined : Math.max(0, current.callbackNowMs - expectedDisplayTime)
            if (
                callbackIntervalMs <= 0 ||
                callbackIntervalMs > MAX_HOST_DURATION_MS ||
                (mediaTimeDeltaMs !== undefined && mediaTimeDeltaMs > MAX_HOST_DURATION_MS) ||
                (displayLatenessMs !== undefined && displayLatenessMs > MAX_HOST_DURATION_MS) ||
                (metadata.expectedDisplayTime !== undefined && expectedDisplayTime === undefined) ||
                (metadata.processingDuration !== undefined && processingDurationSeconds === undefined)
            ) {
                schedule()
                return
            }
            const measuredQuality = previous.quality.status === 'measured' && current.quality.status === 'measured'
            const sample: AnimationMediaStatsSample = {
                source: 'video-rvfc',
                timestampMs: current.callbackNowMs,
                callbackIntervalMs,
                ...(mediaTimeDeltaMs === undefined ? {} : { mediaTimeDeltaMs }),
                ...(presentedFramesDelta === undefined ? {} : { presentedFramesDelta }),
                ...(displayLatenessMs === undefined ? {} : { displayLatenessMs }),
                ...(processingDurationSeconds === undefined ? {} : { processingDurationMs: processingDurationSeconds * 1_000 }),
                playbackQuality: measuredQuality
                    ? {
                          status: 'measured',
                          totalVideoFramesDelta: current.quality.totalVideoFrames! - previous.quality.totalVideoFrames!,
                          droppedVideoFramesDelta: current.quality.droppedVideoFrames! - previous.quality.droppedVideoFrames!,
                          ...(() => {
                              const corruptedVideoFramesDelta = optionalDelta(
                                  current.quality.corruptedVideoFrames,
                                  previous.quality.corruptedVideoFrames
                              )
                              return corruptedVideoFramesDelta === undefined ? {} : { corruptedVideoFramesDelta }
                          })(),
                      }
                    : { status: current.quality.status },
            }
            safeEmit(() => options.sink.recordMediaStats(sample))
        }
        schedule()
    }

    const stop = (): void => {
        if (!active && pendingHandle === null) return
        active = false
        baseline = null
        const handle = pendingHandle
        pendingHandle = null
        if (handle === null || !options.video.cancelVideoFrameCallback) return
        try {
            options.video.cancelVideoFrameCallback.call(options.video, handle)
        } catch {
            // Teardown must remain safe when a host has already released the video.
        }
    }

    return {
        get running(): boolean {
            return active
        },
        start(): boolean {
            if (disposed || active || !options.video.requestVideoFrameCallback) return false
            active = true
            baseline = null
            return schedule()
        },
        resetBaseline(): void {
            baseline = null
        },
        stop,
        dispose(): void {
            if (disposed) return
            disposed = true
            stop()
        },
    }
}
