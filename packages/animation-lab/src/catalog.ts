import {
    ANIMATION_LAB_BUDGET_CATALOG_VERSION,
    ANIMATION_LAB_METRIC_CATALOG_VERSION,
    type LabBudgetDefinitionV1,
    type LabBudgetRefV1,
    type LabMetricAggregationMethod,
    type LabMetricAggregationPopulation,
    type LabMetricCatalogEntryV1,
    type LabMetricCatalogVersion,
    type LabMetricFamily,
    type LabMetricScopeLevel,
    type LabMetricStat,
    type LabMetricUnit,
} from './types'

function metric(
    metricId: string,
    family: LabMetricFamily,
    name: string,
    stat: LabMetricStat,
    unit: LabMetricUnit,
    population: LabMetricAggregationPopulation,
    method: LabMetricAggregationMethod,
    defaultScope: LabMetricScopeLevel = 'attempt',
    defaultBudgetRuleIds: readonly string[] = []
): LabMetricCatalogEntryV1 {
    return Object.freeze({
        metricId,
        family,
        name,
        stat,
        unit,
        defaultScope,
        defaultAggregation: Object.freeze({ population, method }),
        defaultBudgetRuleIds: Object.freeze([...defaultBudgetRuleIds]),
    })
}

/** Closed v1 catalog for metrics currently produced by the page probe, trace and Lighthouse projections. */
export const ANIMATION_LAB_METRIC_CATALOG_V1: readonly LabMetricCatalogEntryV1[] = Object.freeze([
    metric('frame.duration.p50', 'frameCadence', 'frameDurationMs', 'p50', 'ms', 'frames', 'nearest-rank'),
    metric('frame.duration.p95', 'frameCadence', 'frameDurationMs', 'p95', 'ms', 'frames', 'nearest-rank', 'attempt', ['frame-tail']),
    metric('frame.duration.p99', 'frameCadence', 'frameDurationMs', 'p99', 'ms', 'frames', 'nearest-rank'),
    metric('frame.target.latest', 'frameCadence', 'targetFrameMs', 'latest', 'ms', 'latest', 'latest'),
    metric('frame.refresh.inferred', 'frameCadence', 'inferredRefreshHz', 'latest', 'hz', 'latest', 'latest'),
    metric('frame.slow-rate', 'frameCadence', 'slowFrameRate', 'ratio', 'ratio', 'frames', 'ratio', 'attempt', ['slow-frame-rate']),
    metric('frame.jank-bursts', 'frameCadence', 'jankBurstCount', 'count', 'count', 'frames', 'count', 'attempt', ['jank-bursts']),
    metric('frame.longest-slow-run', 'frameCadence', 'longestSlowFrameRun', 'max', 'frames', 'frames', 'max'),
    metric('frame.missed-opportunities', 'frameCadence', 'missedFrameOpportunities', 'sum', 'frames', 'frames', 'sum'),
    metric('main.long-task.count', 'mainThread', 'longTaskCount', 'count', 'count', 'tasks', 'count', 'attempt', ['long-task-count']),
    metric('main.long-task.duration.p95', 'mainThread', 'longTaskDurationMs', 'p95', 'ms', 'tasks', 'nearest-rank'),
    metric('main.long-task.duration.sum', 'mainThread', 'longTaskDurationMs', 'sum', 'ms', 'tasks', 'sum'),
    metric('main.loaf.count', 'mainThread', 'longAnimationFrameCount', 'count', 'count', 'frames', 'count'),
    metric('main.loaf.duration.p95', 'mainThread', 'longAnimationFrameDurationMs', 'p95', 'ms', 'frames', 'nearest-rank'),
    metric('main.loaf.blocking.p95', 'mainThread', 'longAnimationFrameBlockingMs', 'p95', 'ms', 'frames', 'nearest-rank'),
    metric(
        'pipeline.loaf-style-layout-tail.p95',
        'renderingPipeline',
        'longAnimationFrameStyleLayoutTailMs',
        'p95',
        'ms',
        'frames',
        'nearest-rank'
    ),
    metric('interaction.event-duration.p95', 'userOutcome', 'eventTimingDurationMs', 'p95', 'ms', 'events', 'nearest-rank'),
    metric('interaction.input-delay.p95', 'userOutcome', 'inputDelayMs', 'p95', 'ms', 'events', 'nearest-rank', 'attempt', ['input-delay']),
    metric('interaction.processing.p95', 'userOutcome', 'processingDurationMs', 'p95', 'ms', 'events', 'nearest-rank'),
    metric('interaction.presentation.p95', 'renderingPipeline', 'presentationDelayMs', 'p95', 'ms', 'events', 'nearest-rank'),
    metric('interaction.count', 'userOutcome', 'interactionCount', 'count', 'count', 'events', 'count'),
    metric('vital.cls.latest', 'userOutcome', 'CLS', 'latest', 'score', 'latest', 'latest'),
    metric('vital.lcp.latest', 'userOutcome', 'LCP', 'latest', 'ms', 'latest', 'latest'),
    metric('resource.count', 'resourcesMedia', 'resourceCount', 'count', 'count', 'resources', 'count'),
    metric('resource.duration.p95', 'resourcesMedia', 'resourceDurationMs', 'p95', 'ms', 'resources', 'nearest-rank'),
    metric('resource.transfer.sum', 'resourcesMedia', 'transferSizeBytes', 'sum', 'bytes', 'bytes', 'sum'),
    metric('resource.encoded.sum', 'resourcesMedia', 'encodedBodySizeBytes', 'sum', 'bytes', 'bytes', 'sum'),
    metric('resource.decoded.sum', 'resourcesMedia', 'decodedBodySizeBytes', 'sum', 'bytes', 'bytes', 'sum'),
    metric('animation.running.count', 'motionQuality', 'runningAnimations', 'count', 'count', 'animations', 'count'),
    metric('animation.infinite.count', 'motionQuality', 'infiniteAnimations', 'count', 'count', 'animations', 'count'),
    metric(
        'accessibility.reduced-motion-active.count',
        'accessibility',
        'reducedMotionActiveAnimationCandidates',
        'count',
        'count',
        'animations',
        'count'
    ),
    metric('surface.canvas.count', 'renderer', 'canvasSurfaces', 'count', 'count', 'surfaces', 'count'),
    metric('surface.svg.count', 'renderer', 'svgSurfaces', 'count', 'count', 'surfaces', 'count'),
    metric('surface.canvas2d.count', 'renderer', 'canvas2dSurfaces', 'count', 'count', 'surfaces', 'count'),
    metric('surface.webgl.count', 'renderer', 'webglSurfaces', 'count', 'count', 'surfaces', 'count'),
    metric('surface.webgpu.count', 'renderer', 'webgpuSurfaces', 'count', 'count', 'surfaces', 'count'),
    metric('surface.canvas-unknown.count', 'renderer', 'unknownCanvasSurfaces', 'count', 'count', 'surfaces', 'count'),
    metric('surface.backing-pixels.sum', 'renderer', 'backingStorePixels', 'sum', 'pixels', 'surfaces', 'sum'),
    metric('media.video-elements.count', 'resourcesMedia', 'videoElementCount', 'count', 'count', 'surfaces', 'count'),
    metric('media.video-dropped-frame-rate', 'resourcesMedia', 'videoDroppedFrameRate', 'ratio', 'ratio', 'media-frames', 'ratio'),
    metric('memory.js-heap.latest', 'memoryLifecycle', 'usedJsHeapBytes', 'latest', 'bytes', 'latest', 'latest'),
    metric('probe.dropped-samples.count', 'monitorOverhead', 'droppedProbeSamples', 'count', 'count', 'samples', 'count'),
    metric('probe.report-build.latest', 'monitorOverhead', 'reportBuildSelfTimeMs', 'latest', 'ms', 'latest', 'latest'),
    metric('trace.interaction.duration', 'scrollGesture', 'trace.interaction.durationMs', 'sum', 'ms', 'events', 'sum'),
    metric('trace.script.duration', 'mainThread', 'trace.script.durationMs', 'sum', 'ms', 'events', 'sum'),
    metric('trace.style-layout.duration', 'renderingPipeline', 'trace.style-layout.durationMs', 'sum', 'ms', 'events', 'sum'),
    metric('trace.paint.duration', 'renderingPipeline', 'trace.paint.durationMs', 'sum', 'ms', 'events', 'sum'),
    metric('trace.composite.duration', 'renderingPipeline', 'trace.composite.durationMs', 'sum', 'ms', 'events', 'sum'),
    metric('trace.raster-gpu.duration', 'renderer', 'trace.raster-gpu.durationMs', 'sum', 'ms', 'events', 'sum'),
    metric('trace.network.duration', 'resourcesMedia', 'trace.network.durationMs', 'sum', 'ms', 'events', 'sum'),
    metric('trace.animation.duration', 'mainThread', 'trace.animation.durationMs', 'sum', 'ms', 'events', 'sum'),
    metric('trace.gc.duration', 'mainThread', 'trace.gc.durationMs', 'sum', 'ms', 'events', 'sum'),
    metric('trace.other.duration', 'mainThread', 'trace.other.durationMs', 'sum', 'ms', 'events', 'sum'),
    metric('lighthouse.performance.score', 'lighthouse', 'performanceScore', 'latest', 'score', 'latest', 'latest'),
    metric('lighthouse.accessibility.score', 'lighthouse', 'accessibilityScore', 'latest', 'score', 'latest', 'latest'),
    metric('lighthouse.best-practices.score', 'lighthouse', 'best-practicesScore', 'latest', 'score', 'latest', 'latest'),
    metric('lighthouse.seo.score', 'lighthouse', 'seoScore', 'latest', 'score', 'latest', 'latest'),
    metric('lighthouse.fcp.latest', 'lighthouse', 'FCP', 'latest', 'ms', 'latest', 'latest'),
    metric('lighthouse.lcp.latest', 'lighthouse', 'LCP', 'latest', 'ms', 'latest', 'latest'),
    metric('lighthouse.cls.latest', 'userOutcome', 'CLS', 'latest', 'score', 'latest', 'latest'),
    metric('lighthouse.speed-index.latest', 'lighthouse', 'speedIndex', 'latest', 'ms', 'latest', 'latest'),
    metric('lighthouse.total-blocking-time.latest', 'lighthouse', 'totalBlockingTime', 'latest', 'ms', 'latest', 'latest'),
    metric('lighthouse.tti.latest', 'lighthouse', 'timeToInteractive', 'latest', 'ms', 'latest', 'latest'),
])

const ANIMATION_LAB_METRIC_CATALOG_V2_ADDITIONS: readonly LabMetricCatalogEntryV1[] = Object.freeze([
    metric(
        'pipeline.loaf-render-start-to-paint.count',
        'renderingPipeline',
        'longAnimationFrameRenderStartToPaintCount',
        'count',
        'count',
        'frames',
        'count'
    ),
    metric(
        'pipeline.loaf-render-start-to-paint.p95',
        'renderingPipeline',
        'longAnimationFrameRenderStartToPaintMs',
        'p95',
        'ms',
        'frames',
        'nearest-rank'
    ),
    metric(
        'pipeline.loaf-paint-to-presentation.count',
        'renderingPipeline',
        'longAnimationFramePaintToPresentationCount',
        'count',
        'count',
        'frames',
        'count'
    ),
    metric(
        'pipeline.loaf-paint-to-presentation.p95',
        'renderingPipeline',
        'longAnimationFramePaintToPresentationMs',
        'p95',
        'ms',
        'frames',
        'nearest-rank'
    ),
    metric(
        'main.input-capture-to-next-raf-callback.count',
        'mainThread',
        'inputCaptureToNextRafCallbackCount',
        'count',
        'count',
        'events',
        'count'
    ),
    metric(
        'main.input-capture-to-next-raf-callback.p95',
        'mainThread',
        'inputCaptureToNextRafCallbackMs',
        'p95',
        'ms',
        'events',
        'nearest-rank'
    ),
    metric(
        'interaction.loaf-first-ui-event-to-frame-end.count',
        'userOutcome',
        'longAnimationFrameFirstUIEventToFrameEndCount',
        'count',
        'count',
        'frames',
        'count'
    ),
    metric(
        'interaction.loaf-first-ui-event-to-frame-end.p95',
        'userOutcome',
        'longAnimationFrameFirstUIEventToFrameEndMs',
        'p95',
        'ms',
        'frames',
        'nearest-rank'
    ),
    metric(
        'pipeline.loaf-attributed-forced-style-layout.count',
        'renderingPipeline',
        'longAnimationFrameAttributedForcedStyleAndLayoutCount',
        'count',
        'count',
        'frames',
        'count'
    ),
    metric(
        'pipeline.loaf-attributed-forced-style-layout.p95',
        'renderingPipeline',
        'longAnimationFrameAttributedForcedStyleAndLayoutMs',
        'p95',
        'ms',
        'frames',
        'nearest-rank'
    ),
])

/** Additive catalog: every v1 identity remains byte-for-byte unchanged and in the same order. */
export const ANIMATION_LAB_METRIC_CATALOG_V2: readonly LabMetricCatalogEntryV1[] = Object.freeze([
    ...ANIMATION_LAB_METRIC_CATALOG_V1,
    ...ANIMATION_LAB_METRIC_CATALOG_V2_ADDITIONS,
])

const ANIMATION_LAB_METRIC_CATALOG_V3_ADDITIONS: readonly LabMetricCatalogEntryV1[] = Object.freeze([
    metric(
        'media.video-window-dropped-frame-rate',
        'resourcesMedia',
        'videoWindowDroppedFrameRate',
        'ratio',
        'ratio',
        'media-frames',
        'ratio',
        'action'
    ),
])

/** Additive catalog: v3 preserves v2 and adds action-window video counter deltas. */
export const ANIMATION_LAB_METRIC_CATALOG_V3: readonly LabMetricCatalogEntryV1[] = Object.freeze([
    ...ANIMATION_LAB_METRIC_CATALOG_V2,
    ...ANIMATION_LAB_METRIC_CATALOG_V3_ADDITIONS,
])

const ANIMATION_LAB_METRIC_CATALOG_V4_ADDITIONS: readonly LabMetricCatalogEntryV1[] = Object.freeze([
    metric('renderer.draw-calls.p95', 'renderer', 'drawCalls', 'p95', 'count', 'samples', 'nearest-rank'),
    metric('renderer.triangles.p95', 'renderer', 'triangles', 'p95', 'count', 'samples', 'nearest-rank'),
    metric('renderer.gpu-frame.p95', 'renderer', 'gpuFrameMs', 'p95', 'ms', 'samples', 'nearest-rank', 'attempt', [
        'renderer-gpu-frame-tail',
    ]),
])

/** Additive catalog: v4 preserves v3 and adds explicit renderer-adapter evidence. */
export const ANIMATION_LAB_METRIC_CATALOG_V4: readonly LabMetricCatalogEntryV1[] = Object.freeze([
    ...ANIMATION_LAB_METRIC_CATALOG_V3,
    ...ANIMATION_LAB_METRIC_CATALOG_V4_ADDITIONS,
])

const ANIMATION_LAB_METRIC_CATALOG_V5_ADDITIONS: readonly LabMetricCatalogEntryV1[] = Object.freeze([
    metric('media.declared-completed.count', 'resourcesMedia', 'declaredMediaCompletedAttempts', 'count', 'count', 'samples', 'count'),
    metric('media.declared-cancelled.count', 'resourcesMedia', 'declaredMediaCancelledAttempts', 'count', 'count', 'samples', 'count'),
    metric('media.declared-begin-to-decode.p95', 'resourcesMedia', 'declaredMediaBeginToDecodeMs', 'p95', 'ms', 'samples', 'nearest-rank'),
    metric(
        'media.declared-decode-to-upload.p95',
        'resourcesMedia',
        'declaredMediaDecodeToUploadMs',
        'p95',
        'ms',
        'samples',
        'nearest-rank'
    ),
    metric(
        'media.declared-upload-to-first-visible.p95',
        'resourcesMedia',
        'declaredMediaUploadToFirstVisibleMs',
        'p95',
        'ms',
        'samples',
        'nearest-rank'
    ),
    metric(
        'media.declared-begin-to-first-visible.p95',
        'resourcesMedia',
        'declaredMediaBeginToFirstVisibleMs',
        'p95',
        'ms',
        'samples',
        'nearest-rank'
    ),
])

/** Additive catalog: v5 preserves v4 and adds caller-attested media stage aggregates. */
export const ANIMATION_LAB_METRIC_CATALOG_V5: readonly LabMetricCatalogEntryV1[] = Object.freeze([
    ...ANIMATION_LAB_METRIC_CATALOG_V4,
    ...ANIMATION_LAB_METRIC_CATALOG_V5_ADDITIONS,
])

const METRIC_BY_ID_V1 = new Map(ANIMATION_LAB_METRIC_CATALOG_V1.map(entry => [entry.metricId, entry] as const))
const METRIC_BY_ID_V2 = new Map(ANIMATION_LAB_METRIC_CATALOG_V2.map(entry => [entry.metricId, entry] as const))
const METRIC_BY_ID_V3 = new Map(ANIMATION_LAB_METRIC_CATALOG_V3.map(entry => [entry.metricId, entry] as const))
const METRIC_BY_ID_V4 = new Map(ANIMATION_LAB_METRIC_CATALOG_V4.map(entry => [entry.metricId, entry] as const))
const METRIC_BY_ID_V5 = new Map(ANIMATION_LAB_METRIC_CATALOG_V5.map(entry => [entry.metricId, entry] as const))

export function getAnimationLabMetricCatalog(version: LabMetricCatalogVersion): readonly LabMetricCatalogEntryV1[] {
    if (version === 1) return ANIMATION_LAB_METRIC_CATALOG_V1
    if (version === 2) return ANIMATION_LAB_METRIC_CATALOG_V2
    if (version === 3) return ANIMATION_LAB_METRIC_CATALOG_V3
    if (version === 4) return ANIMATION_LAB_METRIC_CATALOG_V4
    if (version === 5) return ANIMATION_LAB_METRIC_CATALOG_V5
    throw new RangeError(`Unsupported animation lab metric catalog version: ${String(version)}`)
}

export function getAnimationLabMetricCatalogEntry(
    metricId: string,
    version: LabMetricCatalogVersion = ANIMATION_LAB_METRIC_CATALOG_VERSION
): LabMetricCatalogEntryV1 | undefined {
    if (version === 1) return METRIC_BY_ID_V1.get(metricId)
    if (version === 2) return METRIC_BY_ID_V2.get(metricId)
    if (version === 3) return METRIC_BY_ID_V3.get(metricId)
    if (version === 4) return METRIC_BY_ID_V4.get(metricId)
    if (version === 5) return METRIC_BY_ID_V5.get(metricId)
    throw new RangeError(`Unsupported animation lab metric catalog version: ${String(version)}`)
}

export const DEFAULT_ANIMATION_LAB_BUDGET_REF_V1: Readonly<LabBudgetRefV1> = Object.freeze({
    catalogVersion: ANIMATION_LAB_BUDGET_CATALOG_VERSION,
    budgetId: 'condev.animation.default',
    budgetVersion: 1,
})

export const DEFAULT_ANIMATION_LAB_BUDGET_REF_V2: Readonly<LabBudgetRefV1> = Object.freeze({
    catalogVersion: ANIMATION_LAB_BUDGET_CATALOG_VERSION,
    budgetId: 'condev.animation.default',
    budgetVersion: 2,
})

export const DEFAULT_ANIMATION_LAB_BUDGET_REF_V3: Readonly<LabBudgetRefV1> = Object.freeze({
    catalogVersion: ANIMATION_LAB_BUDGET_CATALOG_VERSION,
    budgetId: 'condev.animation.default',
    budgetVersion: 3,
})

export const DEFAULT_ANIMATION_LAB_BUDGET_REF_V4: Readonly<LabBudgetRefV1> = Object.freeze({
    catalogVersion: ANIMATION_LAB_BUDGET_CATALOG_VERSION,
    budgetId: 'condev.animation.default',
    budgetVersion: 4,
})

export const DEFAULT_ANIMATION_LAB_BUDGET_REF_V5: Readonly<LabBudgetRefV1> = Object.freeze({
    catalogVersion: ANIMATION_LAB_BUDGET_CATALOG_VERSION,
    budgetId: 'condev.animation.default',
    budgetVersion: 5,
})

/** Unchanged budget v1 diagnostic defaults, not universal UX grades. */
export const DEFAULT_ANIMATION_LAB_BUDGET_V1: Readonly<LabBudgetDefinitionV1> = Object.freeze({
    ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V1,
    rules: Object.freeze([
        Object.freeze({
            ruleId: 'frame-tail',
            metricId: 'frame.duration.p95',
            comparator: '<=',
            target: Object.freeze({ kind: 'target-frame-multiple', value: 1.5, unit: 'ratio' }),
            minimumSamples: 120,
        }),
        Object.freeze({
            ruleId: 'slow-frame-rate',
            metricId: 'frame.slow-rate',
            comparator: '<=',
            target: Object.freeze({ kind: 'absolute', value: 0.05, unit: 'ratio' }),
            minimumSamples: 120,
        }),
        Object.freeze({
            ruleId: 'jank-bursts',
            metricId: 'frame.jank-bursts',
            comparator: '<=',
            target: Object.freeze({ kind: 'absolute', value: 0, unit: 'count' }),
            minimumSamples: 120,
        }),
        Object.freeze({
            ruleId: 'long-task-count',
            metricId: 'main.long-task.count',
            comparator: '<=',
            target: Object.freeze({ kind: 'absolute', value: 0, unit: 'count' }),
            minimumSamples: 1,
        }),
        Object.freeze({
            ruleId: 'input-delay',
            metricId: 'interaction.input-delay.p95',
            comparator: '<=',
            target: Object.freeze({ kind: 'absolute', value: 100, unit: 'ms' }),
            minimumSamples: 3,
        }),
    ]),
})

/**
 * Explicit opt-in budget v2. The only semantic change is that a supported,
 * fully measured Long Task count can use its natural zero-event population as
 * sufficient evidence. All other rules retain v1 thresholds and sample gates.
 */
export const DEFAULT_ANIMATION_LAB_BUDGET_V2: Readonly<LabBudgetDefinitionV1> = Object.freeze({
    ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V2,
    rules: Object.freeze(
        DEFAULT_ANIMATION_LAB_BUDGET_V1.rules.map(rule =>
            Object.freeze(rule.ruleId === 'long-task-count' ? { ...rule, minimumSamples: 0 } : { ...rule })
        )
    ),
})

/**
 * Explicit opt-in diagnostic budget v3. It retains every v2 rule and adds
 * evidence-gated animation, interaction, loading and Lighthouse investigation
 * triggers. These thresholds are not a replacement for field percentiles or a
 * claim that one controlled run represents production users.
 */
export const DEFAULT_ANIMATION_LAB_BUDGET_V3: Readonly<LabBudgetDefinitionV1> = Object.freeze({
    ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V3,
    rules: Object.freeze([
        ...DEFAULT_ANIMATION_LAB_BUDGET_V2.rules.map(rule => Object.freeze({ ...rule })),
        Object.freeze({
            ruleId: 'loaf-count',
            metricId: 'main.loaf.count',
            comparator: '<=',
            target: Object.freeze({ kind: 'absolute', value: 0, unit: 'count' }),
            minimumSamples: 0,
        }),
        Object.freeze({
            ruleId: 'interaction-processing-tail',
            metricId: 'interaction.processing.p95',
            comparator: '<=',
            target: Object.freeze({ kind: 'absolute', value: 50, unit: 'ms' }),
            minimumSamples: 3,
        }),
        Object.freeze({
            ruleId: 'interaction-presentation-tail',
            metricId: 'interaction.presentation.p95',
            comparator: '<=',
            target: Object.freeze({ kind: 'absolute', value: 100, unit: 'ms' }),
            minimumSamples: 3,
        }),
        Object.freeze({
            ruleId: 'page-lcp',
            metricId: 'vital.lcp.latest',
            comparator: '<=',
            target: Object.freeze({ kind: 'absolute', value: 2_500, unit: 'ms' }),
            minimumSamples: 1,
        }),
        Object.freeze({
            ruleId: 'page-cls',
            metricId: 'vital.cls.latest',
            comparator: '<=',
            target: Object.freeze({ kind: 'absolute', value: 0.1, unit: 'score' }),
            minimumSamples: 1,
        }),
        Object.freeze({
            ruleId: 'lighthouse-first-contentful-paint',
            metricId: 'lighthouse.fcp.latest',
            comparator: '<=',
            target: Object.freeze({ kind: 'absolute', value: 1_800, unit: 'ms' }),
            minimumSamples: 1,
        }),
        Object.freeze({
            ruleId: 'lighthouse-total-blocking-time',
            metricId: 'lighthouse.total-blocking-time.latest',
            comparator: '<=',
            target: Object.freeze({ kind: 'absolute', value: 200, unit: 'ms' }),
            minimumSamples: 1,
        }),
    ]),
})

/**
 * Explicit opt-in diagnostic budget v4. Renderer GPU timing is evaluated only
 * when a renderer adapter supplies enough measured samples. Draw-call and
 * triangle evidence remain baseline/comparison signals without universal
 * absolute thresholds.
 */
export const DEFAULT_ANIMATION_LAB_BUDGET_V4: Readonly<LabBudgetDefinitionV1> = Object.freeze({
    ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V4,
    rules: Object.freeze([
        ...DEFAULT_ANIMATION_LAB_BUDGET_V3.rules.map(rule => Object.freeze({ ...rule })),
        Object.freeze({
            ruleId: 'renderer-gpu-frame-tail',
            metricId: 'renderer.gpu-frame.p95',
            comparator: '<=',
            target: Object.freeze({ kind: 'target-frame-multiple', value: 0.8, unit: 'ratio' }),
            minimumSamples: 30,
        }),
    ]),
})

/** Catalog-compatibility budget v5; media stage evidence has no universal absolute threshold. */
export const DEFAULT_ANIMATION_LAB_BUDGET_V5: Readonly<LabBudgetDefinitionV1> = Object.freeze({
    ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V5,
    rules: Object.freeze(DEFAULT_ANIMATION_LAB_BUDGET_V4.rules.map(rule => Object.freeze({ ...rule }))),
})

export const ANIMATION_LAB_BUDGET_CATALOG_V1: readonly Readonly<LabBudgetDefinitionV1>[] = Object.freeze([
    DEFAULT_ANIMATION_LAB_BUDGET_V1,
    DEFAULT_ANIMATION_LAB_BUDGET_V2,
    DEFAULT_ANIMATION_LAB_BUDGET_V3,
    DEFAULT_ANIMATION_LAB_BUDGET_V4,
    DEFAULT_ANIMATION_LAB_BUDGET_V5,
])

export function getAnimationLabBudgetV1(budgetId: string, budgetVersion: number): Readonly<LabBudgetDefinitionV1> | undefined {
    return ANIMATION_LAB_BUDGET_CATALOG_V1.find(budget => budget.budgetId === budgetId && budget.budgetVersion === budgetVersion)
}
