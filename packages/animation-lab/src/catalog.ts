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

const METRIC_BY_ID_V1 = new Map(ANIMATION_LAB_METRIC_CATALOG_V1.map(entry => [entry.metricId, entry] as const))
const METRIC_BY_ID_V2 = new Map(ANIMATION_LAB_METRIC_CATALOG_V2.map(entry => [entry.metricId, entry] as const))

export function getAnimationLabMetricCatalog(version: LabMetricCatalogVersion): readonly LabMetricCatalogEntryV1[] {
    if (version === 1) return ANIMATION_LAB_METRIC_CATALOG_V1
    if (version === 2) return ANIMATION_LAB_METRIC_CATALOG_V2
    throw new RangeError(`Unsupported animation lab metric catalog version: ${String(version)}`)
}

export function getAnimationLabMetricCatalogEntry(
    metricId: string,
    version: LabMetricCatalogVersion = ANIMATION_LAB_METRIC_CATALOG_VERSION
): LabMetricCatalogEntryV1 | undefined {
    if (version === 1) return METRIC_BY_ID_V1.get(metricId)
    if (version === 2) return METRIC_BY_ID_V2.get(metricId)
    throw new RangeError(`Unsupported animation lab metric catalog version: ${String(version)}`)
}

export const DEFAULT_ANIMATION_LAB_BUDGET_REF_V1: Readonly<LabBudgetRefV1> = Object.freeze({
    catalogVersion: ANIMATION_LAB_BUDGET_CATALOG_VERSION,
    budgetId: 'condev.animation.default',
    budgetVersion: 1,
})

/** Diagnostic defaults, not universal UX grades. This closed v1 runtime executes only this bundled definition. */
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

export const ANIMATION_LAB_BUDGET_CATALOG_V1: readonly Readonly<LabBudgetDefinitionV1>[] = Object.freeze([DEFAULT_ANIMATION_LAB_BUDGET_V1])

export function getAnimationLabBudgetV1(budgetId: string, budgetVersion: number): Readonly<LabBudgetDefinitionV1> | undefined {
    return ANIMATION_LAB_BUDGET_CATALOG_V1.find(budget => budget.budgetId === budgetId && budget.budgetVersion === budgetVersion)
}
