// cspell:ignore rvfc

import { isHostGpuTimingSourceCompatible } from './gpu-timing-compatibility'
import type {
    AnimationFrameworkStatsSample,
    AnimationLifecycleCountEvidence,
    AnimationLifecycleStatsSample,
    AnimationMediaStatsSample,
    AnimationRenderStatsSample,
    AnimationWorkStatsSample,
} from './host-adapters'
import { BoundedRing, durationStatistics, round } from './statistics'
import type { AnimationHostEvidenceFamilySummary, AnimationHostEvidenceSummary, AnimationUiFramework } from './types'

const MAX_DURATION_MS = 600_000
const MAX_COUNT = 1_000_000_000
const FRAMEWORKS = new Set<AnimationUiFramework>([
    'vanilla',
    'react',
    'preact',
    'vue',
    'angular',
    'svelte',
    'solid',
    'qwik',
    'lit',
    'other',
])
const FRAMEWORK_PHASES = ['mount', 'update', 'nested-update', 'hydrate', 'other'] as const
const RENDERER_BACKENDS = ['webgl', 'webgl2', 'webgpu', 'unknown'] as const
const GPU_STATUSES = ['measured', 'not-provided', 'invalid', 'disjoint', 'context-lost', 'error'] as const
const GPU_SOURCES = ['webgl-disjoint-timer-query', 'webgpu-timestamp-query', 'host-timer-query'] as const
const LIFECYCLE_CHECKPOINTS = ['mount', 'after-interaction', 'unmount', 'manual'] as const
const LIFECYCLE_STATUSES = ['measured', 'unsupported', 'error'] as const
const WORK_CATEGORIES = ['script', 'layout', 'paint', 'composite', 'other'] as const
const PLAYBACK_STATUSES = ['measured', 'unsupported', 'error'] as const

type StoredFrameworkSample = Omit<AnimationFrameworkStatsSample, 'timestampMs'> & { capturedAt: number }
type StoredRendererSample = Omit<AnimationRenderStatsSample, 'timestampMs'> & { capturedAt: number }
type StoredLifecycleSample = Omit<AnimationLifecycleStatsSample, 'timestampMs'> & { capturedAt: number }
type StoredWorkSample = Omit<AnimationWorkStatsSample, 'timestampMs'> & { capturedAt: number }
type StoredMediaSample = Omit<AnimationMediaStatsSample, 'timestampMs'> & { capturedAt: number }

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function inSet<T extends string>(value: unknown, values: readonly T[]): value is T {
    return typeof value === 'string' && (values as readonly string[]).includes(value)
}

function finiteNonNegative(value: unknown, maximum = MAX_DURATION_MS): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : undefined
}

function finitePositive(value: unknown, maximum = MAX_DURATION_MS): number | undefined {
    const normalized = finiteNonNegative(value, maximum)
    return normalized !== undefined && normalized > 0 ? normalized : undefined
}

function finiteCount(value: unknown): number | undefined {
    const normalized = finiteNonNegative(value, MAX_COUNT)
    return normalized !== undefined && Number.isInteger(normalized) ? normalized : undefined
}

function optionalNumber(value: unknown, maximum = MAX_DURATION_MS): { valid: boolean; value?: number } {
    if (value === undefined) return { valid: true }
    const normalized = finiteNonNegative(value, maximum)
    return normalized === undefined ? { valid: false } : { valid: true, value: normalized }
}

function optionalCount(value: unknown): { valid: boolean; value?: number } {
    if (value === undefined) return { valid: true }
    const normalized = finiteCount(value)
    return normalized === undefined ? { valid: false } : { valid: true, value: normalized }
}

function countRecord<T extends string>(values: readonly T[]): Record<T, number> {
    return Object.fromEntries(values.map(value => [value, 0])) as Record<T, number>
}

class HostFamily<T extends { capturedAt: number }> {
    readonly samples: BoundedRing<T>
    private readonly retainedEvidence: BoundedRing<boolean>
    private firstAcceptedAt: number | null = null
    private lastAcceptedAt: number | null = null
    rejectedSampleCount = 0
    evidenceSampleCount = 0

    constructor(capacity: number) {
        this.samples = new BoundedRing<T>(capacity)
        this.retainedEvidence = new BoundedRing<boolean>(capacity)
    }

    accept(sample: T, capturedAt: number, evidence: boolean): true {
        this.samples.push(sample)
        this.retainedEvidence.push(evidence)
        this.firstAcceptedAt ??= capturedAt
        this.lastAcceptedAt = capturedAt
        if (evidence) this.evidenceSampleCount = Math.min(MAX_COUNT, this.evidenceSampleCount + 1)
        return true
    }

    reject(): false {
        this.rejectedSampleCount = Math.min(MAX_COUNT, this.rejectedSampleCount + 1)
        return false
    }

    summary(): AnimationHostEvidenceFamilySummary {
        const retained = this.samples.toArray()
        const retainedStartedAt = retained[0]?.capturedAt ?? null
        const retainedEndedAt = retained[retained.length - 1]?.capturedAt ?? null
        const windowSummary = (startedAt: number | null, endedAt: number | null) => ({
            startedAt: startedAt === null ? null : round(startedAt),
            endedAt: endedAt === null ? null : round(endedAt),
            durationMs: startedAt === null || endedAt === null ? null : round(Math.max(0, endedAt - startedAt)),
        })
        return {
            acceptedSampleCount: this.samples.totalCount,
            retainedSampleCount: this.samples.retainedCount,
            droppedSampleCount: this.samples.droppedCount,
            rejectedSampleCount: this.rejectedSampleCount,
            evidenceSampleCount: this.evidenceSampleCount,
            retainedEvidenceSampleCount: this.retainedEvidence.toArray().filter(Boolean).length,
            capacity: this.samples.capacity,
            truncated: this.samples.droppedCount > 0,
            detailScope: 'retained-samples',
            acceptedWindow: windowSummary(this.firstAcceptedAt, this.lastAcceptedAt),
            window: windowSummary(retainedStartedAt, retainedEndedAt),
        }
    }
}

function normalizeLifecycleCounts(value: unknown): AnimationLifecycleCountEvidence | null {
    if (!isRecord(value) || !inSet(value.status, LIFECYCLE_STATUSES)) return null
    if (value.status !== 'measured') return { status: value.status }
    const total = optionalCount(value.total)
    const active = optionalCount(value.active)
    const rejected = optionalCount(value.rejectedActiveChecks)
    if (!total.valid || !active.valid || !rejected.valid || total.value === undefined) return null
    if (active.value !== undefined && active.value > total.value) return null
    if (rejected.value !== undefined && rejected.value > total.value) return null
    if ((rejected.value ?? 0) > 0 && active.value !== undefined) return null
    return {
        status: 'measured',
        total: total.value,
        ...(active.value === undefined ? {} : { active: active.value }),
        ...(rejected.value === undefined ? {} : { rejectedActiveChecks: rejected.value }),
    }
}

function latestMeasuredCount(
    samples: readonly StoredLifecycleSample[],
    select: (sample: StoredLifecycleSample) => AnimationLifecycleCountEvidence,
    field: 'total' | 'active'
): number | null {
    for (let index = samples.length - 1; index >= 0; index -= 1) {
        const evidence = select(samples[index]!)
        if (evidence.status === 'measured' && evidence[field] !== undefined) return evidence[field] ?? null
    }
    return null
}

/**
 * Local, bounded sink for explicit host adapters. Caller timestamps are ignored;
 * the collector supplies its own monotonic capture clock.
 */
export class AnimationHostEvidenceRecorder {
    private readonly framework: HostFamily<StoredFrameworkSample>
    private readonly renderer: HostFamily<StoredRendererSample>
    private readonly lifecycle: HostFamily<StoredLifecycleSample>
    private readonly work: HostFamily<StoredWorkSample>
    private readonly media: HostFamily<StoredMediaSample>

    constructor(capacity: number) {
        this.framework = new HostFamily(capacity)
        this.renderer = new HostFamily(capacity)
        this.lifecycle = new HostFamily(capacity)
        this.work = new HostFamily(capacity)
        this.media = new HostFamily(capacity)
    }

    recordFrameworkStats(sample: AnimationFrameworkStatsSample, capturedAt: number): boolean {
        if (!isRecord(sample) || !FRAMEWORKS.has(sample.framework) || !inSet(sample.phase, FRAMEWORK_PHASES)) {
            return this.framework.reject()
        }
        if (sample.source !== 'manual' && sample.source !== 'react-profiler') return this.framework.reject()
        if (sample.source === 'react-profiler' && sample.framework !== 'react') return this.framework.reject()
        const renderMs = optionalNumber(sample.renderMs)
        const commitMs = optionalNumber(sample.commitMs)
        const baseRenderMs = optionalNumber(sample.baseRenderMs)
        if (!renderMs.valid || !commitMs.valid || !baseRenderMs.valid) return this.framework.reject()
        const evidence = renderMs.value !== undefined || commitMs.value !== undefined || baseRenderMs.value !== undefined
        if (!evidence) return this.framework.reject()
        return this.framework.accept(
            {
                source: sample.source,
                framework: sample.framework,
                phase: sample.phase,
                capturedAt,
                ...(renderMs.value === undefined ? {} : { renderMs: renderMs.value }),
                ...(commitMs.value === undefined ? {} : { commitMs: commitMs.value }),
                ...(baseRenderMs.value === undefined ? {} : { baseRenderMs: baseRenderMs.value }),
            },
            capturedAt,
            true
        )
    }

    recordRenderStats(sample: AnimationRenderStatsSample, capturedAt: number): boolean {
        if (!isRecord(sample) || sample.source !== 'three-renderer-info' || !inSet(sample.backend, RENDERER_BACKENDS)) {
            return this.renderer.reject()
        }
        const numericFields = {
            drawCalls: optionalCount(sample.drawCalls),
            triangles: optionalCount(sample.triangles),
            lines: optionalCount(sample.lines),
            points: optionalCount(sample.points),
            geometries: optionalCount(sample.geometries),
            textures: optionalCount(sample.textures),
            programs: optionalCount(sample.programs),
        }
        if (Object.values(numericFields).some(field => !field.valid) || !isRecord(sample.gpu) || !inSet(sample.gpu.status, GPU_STATUSES)) {
            return this.renderer.reject()
        }
        const gpuSource = inSet(sample.gpu.source, GPU_SOURCES) ? sample.gpu.source : undefined
        const gpuTime = optionalNumber(sample.gpu.timeMs)
        if (!gpuTime.valid) return this.renderer.reject()
        const gpu =
            sample.gpu.status === 'measured'
                ? gpuTime.value !== undefined &&
                  gpuSource &&
                  sample.gpu.valid === true &&
                  sample.gpu.disjoint === false &&
                  sample.gpu.contextLost === false &&
                  isHostGpuTimingSourceCompatible(sample.backend, gpuSource)
                    ? {
                          status: 'measured' as const,
                          timeMs: gpuTime.value,
                          source: gpuSource,
                          valid: true as const,
                          disjoint: false as const,
                          contextLost: false as const,
                      }
                    : null
                : { status: sample.gpu.status }
        if (!gpu) return this.renderer.reject()
        const evidence = Object.values(numericFields).some(field => field.value !== undefined) || gpu.status === 'measured'
        return this.renderer.accept(
            {
                source: sample.source,
                backend: sample.backend,
                capturedAt,
                ...Object.fromEntries(
                    Object.entries(numericFields).flatMap(([name, field]) => (field.value === undefined ? [] : [[name, field.value]]))
                ),
                gpu,
            } as StoredRendererSample,
            capturedAt,
            evidence
        )
    }

    recordLifecycleStats(sample: AnimationLifecycleStatsSample, capturedAt: number): boolean {
        if (!isRecord(sample) || sample.source !== 'gsap-public-api' || !inSet(sample.checkpoint, LIFECYCLE_CHECKPOINTS)) {
            return this.lifecycle.reject()
        }
        const animations = normalizeLifecycleCounts(sample.animations)
        const scrollTriggers = normalizeLifecycleCounts(sample.scrollTriggers)
        if (!animations || !scrollTriggers) return this.lifecycle.reject()
        const evidence = animations.status === 'measured' || scrollTriggers.status === 'measured'
        return this.lifecycle.accept(
            { source: sample.source, checkpoint: sample.checkpoint, capturedAt, animations, scrollTriggers },
            capturedAt,
            evidence
        )
    }

    recordWorkStats(sample: AnimationWorkStatsSample, capturedAt: number): boolean {
        if (!isRecord(sample) || sample.source !== 'host' || !inSet(sample.category, WORK_CATEGORIES)) return this.work.reject()
        const workMs = finiteNonNegative(sample.workMs)
        if (workMs === undefined) return this.work.reject()
        return this.work.accept({ source: sample.source, category: sample.category, workMs, capturedAt }, capturedAt, true)
    }

    recordMediaStats(sample: AnimationMediaStatsSample, capturedAt: number): boolean {
        if (!isRecord(sample) || sample.source !== 'video-rvfc' || !isRecord(sample.playbackQuality)) return this.media.reject()
        const callbackIntervalMs = finitePositive(sample.callbackIntervalMs)
        const mediaTimeDeltaMs = optionalNumber(sample.mediaTimeDeltaMs)
        const presentedFramesDelta = optionalCount(sample.presentedFramesDelta)
        const displayLatenessMs = optionalNumber(sample.displayLatenessMs)
        const processingDurationMs = optionalNumber(sample.processingDurationMs)
        if (
            callbackIntervalMs === undefined ||
            !mediaTimeDeltaMs.valid ||
            !presentedFramesDelta.valid ||
            !displayLatenessMs.valid ||
            !processingDurationMs.valid ||
            !inSet(sample.playbackQuality.status, PLAYBACK_STATUSES)
        ) {
            return this.media.reject()
        }
        const total = optionalCount(sample.playbackQuality.totalVideoFramesDelta)
        const dropped = optionalCount(sample.playbackQuality.droppedVideoFramesDelta)
        const corrupted = optionalCount(sample.playbackQuality.corruptedVideoFramesDelta)
        if (!total.valid || !dropped.valid || !corrupted.valid) return this.media.reject()
        const playbackQuality =
            sample.playbackQuality.status === 'measured'
                ? total.value !== undefined &&
                  dropped.value !== undefined &&
                  dropped.value <= total.value &&
                  (corrupted.value === undefined || corrupted.value <= total.value)
                    ? {
                          status: 'measured' as const,
                          totalVideoFramesDelta: total.value,
                          droppedVideoFramesDelta: dropped.value,
                          ...(corrupted.value === undefined ? {} : { corruptedVideoFramesDelta: corrupted.value }),
                      }
                    : null
                : { status: sample.playbackQuality.status }
        if (!playbackQuality) return this.media.reject()
        return this.media.accept(
            {
                source: sample.source,
                capturedAt,
                callbackIntervalMs,
                ...(mediaTimeDeltaMs.value === undefined ? {} : { mediaTimeDeltaMs: mediaTimeDeltaMs.value }),
                ...(presentedFramesDelta.value === undefined ? {} : { presentedFramesDelta: presentedFramesDelta.value }),
                ...(displayLatenessMs.value === undefined ? {} : { displayLatenessMs: displayLatenessMs.value }),
                ...(processingDurationMs.value === undefined ? {} : { processingDurationMs: processingDurationMs.value }),
                playbackQuality,
            },
            capturedAt,
            true
        )
    }

    snapshot(): AnimationHostEvidenceSummary {
        const frameworkSamples = this.framework.samples.toArray()
        const rendererSamples = this.renderer.samples.toArray()
        const lifecycleSamples = this.lifecycle.samples.toArray()
        const workSamples = this.work.samples.toArray()
        const mediaSamples = this.media.samples.toArray()
        const phases = countRecord(FRAMEWORK_PHASES)
        const checkpoints = countRecord(LIFECYCLE_CHECKPOINTS)
        const workCategories = countRecord(WORK_CATEGORIES)
        const playbackStatuses = countRecord(PLAYBACK_STATUSES)
        for (const sample of frameworkSamples) phases[sample.phase] += 1
        for (const sample of lifecycleSamples) checkpoints[sample.checkpoint] += 1
        for (const sample of workSamples) workCategories[sample.category] += 1
        for (const sample of mediaSamples) playbackStatuses[sample.playbackQuality.status] += 1
        const playbackMeasured = mediaSamples.filter(sample => sample.playbackQuality.status === 'measured')
        const totalVideoFramesDelta =
            playbackMeasured.length === 0
                ? null
                : playbackMeasured.reduce(
                      (sum, sample) => Math.min(MAX_COUNT, sum + (sample.playbackQuality.totalVideoFramesDelta ?? 0)),
                      0
                  )
        const droppedVideoFramesDelta =
            playbackMeasured.length === 0
                ? null
                : playbackMeasured.reduce(
                      (sum, sample) => Math.min(MAX_COUNT, sum + (sample.playbackQuality.droppedVideoFramesDelta ?? 0)),
                      0
                  )
        const corruptedVideoFramesDelta =
            playbackMeasured.length === 0 || playbackMeasured.some(sample => sample.playbackQuality.corruptedVideoFramesDelta === undefined)
                ? null
                : playbackMeasured.reduce(
                      (sum, sample) => Math.min(MAX_COUNT, sum + (sample.playbackQuality.corruptedVideoFramesDelta ?? 0)),
                      0
                  )

        return {
            scope: 'capture-window-local',
            framework: {
                ...this.framework.summary(),
                frameworks: [...new Set(frameworkSamples.map(sample => sample.framework))].sort(),
                phases,
                renderMs: durationStatistics(frameworkSamples.flatMap(sample => (sample.renderMs === undefined ? [] : [sample.renderMs]))),
                commitMs: durationStatistics(frameworkSamples.flatMap(sample => (sample.commitMs === undefined ? [] : [sample.commitMs]))),
                baseRenderMs: durationStatistics(
                    frameworkSamples.flatMap(sample => (sample.baseRenderMs === undefined ? [] : [sample.baseRenderMs]))
                ),
            },
            renderer: {
                ...this.renderer.summary(),
                backends: [...new Set(rendererSamples.map(sample => sample.backend))].sort(),
                drawCalls: durationStatistics(
                    rendererSamples.flatMap(sample => (sample.drawCalls === undefined ? [] : [sample.drawCalls]))
                ),
                triangles: durationStatistics(
                    rendererSamples.flatMap(sample => (sample.triangles === undefined ? [] : [sample.triangles]))
                ),
                lines: durationStatistics(rendererSamples.flatMap(sample => (sample.lines === undefined ? [] : [sample.lines]))),
                points: durationStatistics(rendererSamples.flatMap(sample => (sample.points === undefined ? [] : [sample.points]))),
                geometries: durationStatistics(
                    rendererSamples.flatMap(sample => (sample.geometries === undefined ? [] : [sample.geometries]))
                ),
                textures: durationStatistics(rendererSamples.flatMap(sample => (sample.textures === undefined ? [] : [sample.textures]))),
                programs: durationStatistics(rendererSamples.flatMap(sample => (sample.programs === undefined ? [] : [sample.programs]))),
                gpuFrameMs: durationStatistics(
                    rendererSamples.flatMap(sample =>
                        sample.gpu.status === 'measured' && sample.gpu.timeMs !== undefined ? [sample.gpu.timeMs] : []
                    )
                ),
                gpuMeasuredSampleCount: rendererSamples.filter(sample => sample.gpu.status === 'measured').length,
                gpuRejectedSampleCount: rendererSamples.filter(
                    sample => sample.gpu.status !== 'measured' && sample.gpu.status !== 'not-provided'
                ).length,
            },
            lifecycle: {
                ...this.lifecycle.summary(),
                checkpoints,
                measuredAnimationSampleCount: lifecycleSamples.filter(sample => sample.animations.status === 'measured').length,
                measuredScrollTriggerSampleCount: lifecycleSamples.filter(sample => sample.scrollTriggers.status === 'measured').length,
                latestAnimationTotal: latestMeasuredCount(lifecycleSamples, sample => sample.animations, 'total'),
                latestActiveAnimationCount: latestMeasuredCount(lifecycleSamples, sample => sample.animations, 'active'),
                latestScrollTriggerTotal: latestMeasuredCount(lifecycleSamples, sample => sample.scrollTriggers, 'total'),
                rejectedActiveCheckCount: lifecycleSamples.reduce(
                    (sum, sample) => Math.min(MAX_COUNT, sum + (sample.animations.rejectedActiveChecks ?? 0)),
                    0
                ),
                growthCandidate: null,
            },
            work: {
                ...this.work.summary(),
                workMs: durationStatistics(workSamples.map(sample => sample.workMs)),
                categories: workCategories,
            },
            media: {
                ...this.media.summary(),
                callbackIntervalMs: durationStatistics(mediaSamples.map(sample => sample.callbackIntervalMs)),
                mediaTimeDeltaMs: durationStatistics(
                    mediaSamples.flatMap(sample => (sample.mediaTimeDeltaMs === undefined ? [] : [sample.mediaTimeDeltaMs]))
                ),
                presentedFramesDelta: durationStatistics(
                    mediaSamples.flatMap(sample => (sample.presentedFramesDelta === undefined ? [] : [sample.presentedFramesDelta]))
                ),
                displayLatenessMs: durationStatistics(
                    mediaSamples.flatMap(sample => (sample.displayLatenessMs === undefined ? [] : [sample.displayLatenessMs]))
                ),
                processingDurationMs: durationStatistics(
                    mediaSamples.flatMap(sample => (sample.processingDurationMs === undefined ? [] : [sample.processingDurationMs]))
                ),
                totalVideoFramesDelta,
                droppedVideoFramesDelta,
                corruptedVideoFramesDelta,
                playbackDropRatio:
                    totalVideoFramesDelta !== null && droppedVideoFramesDelta !== null && totalVideoFramesDelta > 0
                        ? round(droppedVideoFramesDelta / totalVideoFramesDelta, 6)
                        : null,
                playbackQualityMeasuredSampleCount: playbackStatuses.measured,
                playbackQualityUnsupportedSampleCount: playbackStatuses.unsupported,
                playbackQualityErrorSampleCount: playbackStatuses.error,
            },
        }
    }
}
