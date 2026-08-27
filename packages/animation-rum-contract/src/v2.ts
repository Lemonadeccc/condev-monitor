// cspell:ignore adaptererrors clientx clienty componentname domid dragpath elementid noncanonical ownerlabel pagex pagey pixelscontent pointerpath rawsamples screenx screeny shadersource textcontent webgl webgpu rAF

export const ANIMATION_RUM_EVENT_TYPE = 'animation_rum' as const
export const ANIMATION_RUM_V2_CONTRACT_VERSION = 2 as const
// The current local AnimationSnapshot remains schema v1. Wire and snapshot
// versions are intentionally independent.
export const ANIMATION_RUM_V2_SNAPSHOT_SCHEMA_VERSION = 1 as const
export const ANIMATION_RUM_V2_MAX_PAYLOAD_BYTES = 64 * 1024
export const ANIMATION_RUM_V2_MAX_METRICS = 128
export const ANIMATION_RUM_V2_INHERITED_V1_METRIC_COUNT = 32
export const ANIMATION_RUM_V2_PAGE_ADDITION_COUNT = 28
export const ANIMATION_RUM_V2_TARGET_ADAPTER_ADDITION_COUNT = 9

export const ANIMATION_RUM_FAMILIES = Object.freeze([
    'userOutcome',
    'frameCadence',
    'mainThread',
    'renderingPipeline',
    'renderer',
    'scrollGesture',
    'resourcesMedia',
    'memoryLifecycle',
    'workAvoidance',
    'accessibility',
    'motionQuality',
    'monitorOverhead',
] as const)

export const ANIMATION_RUM_V2_CAPABILITIES = Object.freeze([
    'long-animation-frame',
    'longtask',
    'event-timing',
    'resource-timing',
    'resource-timing-buffer-events',
    'web-vitals',
    'web-vitals-attribution',
    'web-vitals-soft-navigation',
    'reduced-motion-preference',
    'document-animations-inspection',
    'visibility-lifecycle',
    'loaf-paint-time',
    'loaf-presentation-time',
    'input-frame-scheduling',
    'page-evidence',
    'canvas-context-registry',
    'video-frame-callback',
    'video-playback-quality',
    'framework-adapter',
    'renderer-adapter',
    'media-adapter',
    'target-direct-inspection',
    'interaction-quality-adapter',
    'gpu-timer-query',
] as const)

export const ANIMATION_RUM_V2_PROVIDER_OWNERS = Object.freeze([
    'browser-core',
    'web-vitals-runtime',
    'resource-timing',
    'browser-page-evidence',
    'input-scheduling',
    'media-adapter',
    'renderer-adapter',
    'target-sidecar',
] as const)

export const ANIMATION_RUM_V2_QUALITY_REASONS = Object.freeze([
    'adapter-error',
    'insufficient-frame-samples',
    'provider-rejected-samples',
    'provider-truncated',
    'refresh-confidence-low',
    'source-field-incomplete',
    'visible-window-too-short',
    'window-capped',
] as const)

export type AnimationRumFamily = (typeof ANIMATION_RUM_FAMILIES)[number]
export type AnimationRumV2CapabilityName = (typeof ANIMATION_RUM_V2_CAPABILITIES)[number]
export type AnimationRumV2CapabilityState = 'supported' | 'unsupported' | 'unknown' | 'disabled'
export type AnimationRumV2Scope = 'page' | 'target'
export type AnimationRumV2Relation = 'page-window' | 'target-direct' | 'target-temporal-overlap' | 'adapter'
export type AnimationRumV2ProviderOwner = (typeof ANIMATION_RUM_V2_PROVIDER_OWNERS)[number]
export type AnimationRumV2QualityReason = (typeof ANIMATION_RUM_V2_QUALITY_REASONS)[number]
export type AnimationRumV2MetricStatus = 'measured' | 'partial' | 'not-observed' | 'not-instrumented' | 'unsupported' | 'unknown'
export type AnimationRumV2CoverageStatus = AnimationRumV2MetricStatus
export type AnimationRumV2EvidenceLevel = 'runtime-observation' | 'unsupported-or-unknown'
export type AnimationRumV2MetricStat = 'latest' | 'count' | 'sum' | 'avg' | 'min' | 'max' | 'p50' | 'p75' | 'p95' | 'p99' | 'rate' | 'ratio'
export type AnimationRumV2MetricUnit = 'ms' | 'count' | 'ratio' | 'multiplier' | 'bytes' | 'pixels' | 'hz' | 'frames' | 'percent' | 'score'
export type AnimationRumV2EvidenceWindow = 'capture-window' | 'document-lifetime'

export interface AnimationRumV2MetricBinding {
    readonly scope: AnimationRumV2Scope
    readonly relation: AnimationRumV2Relation
    readonly owners: readonly AnimationRumV2ProviderOwner[]
}

export interface AnimationRumV2MetricDefinition {
    readonly metricId: string
    readonly family: AnimationRumFamily
    readonly name: string
    readonly stat: AnimationRumV2MetricStat
    readonly unit: AnimationRumV2MetricUnit
    readonly evidenceWindow: AnimationRumV2EvidenceWindow
    readonly bindings: readonly AnimationRumV2MetricBinding[]
    readonly requiredCapabilities: readonly AnimationRumV2CapabilityName[]
    /** Closed quantization values for metrics that could otherwise expose exact target geometry. */
    readonly allowedValues?: readonly number[]
    /** Capture-quality reasons that make this particular metric partial. */
    readonly partialWhenQualityReasons: readonly AnimationRumV2QualityReason[]
    /** Optional measured-count identity whose zero population forbids this distribution. */
    readonly populationMetricId?: string
}

const pageBrowser = [{ scope: 'page', relation: 'page-window', owners: ['browser-core'] }] as const
const pageAndTargetBrowser = [...pageBrowser, { scope: 'target', relation: 'target-temporal-overlap', owners: ['browser-core'] }] as const
const pageAndTargetInput = [
    { scope: 'page', relation: 'page-window', owners: ['input-scheduling'] },
    { scope: 'target', relation: 'target-temporal-overlap', owners: ['input-scheduling'] },
] as const
const pageWebVitals = [{ scope: 'page', relation: 'page-window', owners: ['web-vitals-runtime'] }] as const
const pageResources = [{ scope: 'page', relation: 'page-window', owners: ['resource-timing'] }] as const
const pageEvidence = [{ scope: 'page', relation: 'page-window', owners: ['browser-page-evidence'] }] as const
const pageAndTargetAnimations = [...pageEvidence, { scope: 'target', relation: 'target-direct', owners: ['target-sidecar'] }] as const
const pageMedia = [{ scope: 'page', relation: 'page-window', owners: ['media-adapter'] }] as const
const targetDirect = [{ scope: 'target', relation: 'target-direct', owners: ['target-sidecar'] }] as const
const rendererAdapter = [
    { scope: 'page', relation: 'adapter', owners: ['renderer-adapter'] },
    { scope: 'target', relation: 'adapter', owners: ['renderer-adapter'] },
] as const
const interactionAdapter = [
    { scope: 'page', relation: 'adapter', owners: ['target-sidecar'] },
    { scope: 'target', relation: 'adapter', owners: ['target-sidecar'] },
] as const

function metric(
    metricId: string,
    family: AnimationRumFamily,
    name: string,
    stat: AnimationRumV2MetricStat,
    unit: AnimationRumV2MetricUnit,
    bindings: readonly AnimationRumV2MetricBinding[],
    requiredCapabilities: readonly AnimationRumV2CapabilityName[] = [],
    evidenceWindow: AnimationRumV2EvidenceWindow = 'capture-window',
    allowedValues?: readonly number[],
    populationMetricId?: string
): AnimationRumV2MetricDefinition {
    const partialWhenQualityReasons = new Set<AnimationRumV2QualityReason>()
    if (evidenceWindow === 'capture-window') {
        partialWhenQualityReasons.add('window-capped')
        partialWhenQualityReasons.add('source-field-incomplete')
    }
    if (family === 'frameCadence') {
        partialWhenQualityReasons.add('visible-window-too-short')
        partialWhenQualityReasons.add('insufficient-frame-samples')
        partialWhenQualityReasons.add('refresh-confidence-low')
    }
    if (bindings.some(binding => binding.relation === 'adapter')) partialWhenQualityReasons.add('adapter-error')
    return Object.freeze({
        metricId,
        family,
        name,
        stat,
        unit,
        evidenceWindow,
        bindings: Object.freeze(
            bindings.map(binding =>
                Object.freeze({
                    scope: binding.scope,
                    relation: binding.relation,
                    owners: Object.freeze([...binding.owners]),
                })
            )
        ),
        requiredCapabilities: Object.freeze([...requiredCapabilities]),
        ...(allowedValues ? { allowedValues: Object.freeze([...allowedValues]) } : {}),
        partialWhenQualityReasons: Object.freeze([...partialWhenQualityReasons].sort()),
        ...(populationMetricId ? { populationMetricId } : {}),
    })
}

/**
 * Closed v2 registry: the 32 v1 identities, 28 page additions, and nine
 * target/adapter additions. The wire sends metricId rather than allowing a
 * client to freely combine family/name/stat/unit strings.
 */
export const ANIMATION_RUM_V2_METRIC_CATALOG: readonly AnimationRumV2MetricDefinition[] = Object.freeze([
    metric('frame.duration.p50', 'frameCadence', 'frameDurationMs', 'p50', 'ms', pageAndTargetBrowser),
    metric('frame.duration.p75', 'frameCadence', 'frameDurationMs', 'p75', 'ms', pageAndTargetBrowser),
    metric('frame.duration.p95', 'frameCadence', 'frameDurationMs', 'p95', 'ms', pageAndTargetBrowser),
    metric('frame.duration.p99', 'frameCadence', 'frameDurationMs', 'p99', 'ms', pageAndTargetBrowser),
    metric('frame.duration.max', 'frameCadence', 'frameDurationMs', 'max', 'ms', pageAndTargetBrowser),
    metric('frame.target.latest', 'frameCadence', 'targetFrameMs', 'latest', 'ms', pageBrowser),
    metric('frame.refresh.latest', 'frameCadence', 'inferredRefreshHz', 'latest', 'hz', pageBrowser),
    metric('frame.slow-rate.ratio', 'frameCadence', 'slowFrameRate', 'ratio', 'ratio', pageAndTargetBrowser),
    metric('frame.jank-burst.count', 'frameCadence', 'jankBurstCount', 'count', 'count', pageAndTargetBrowser),
    metric('frame.longest-slow-run.max', 'frameCadence', 'longestSlowFrameRun', 'max', 'frames', pageAndTargetBrowser),
    metric('frame.missed-opportunities.sum', 'frameCadence', 'missedFrameOpportunities', 'sum', 'frames', pageAndTargetBrowser),
    metric('main.loaf.count', 'mainThread', 'longAnimationFrameCount', 'count', 'count', pageAndTargetBrowser, ['long-animation-frame']),
    metric('main.loaf-duration.sum', 'mainThread', 'longAnimationFrameDurationMs', 'sum', 'ms', pageAndTargetBrowser, [
        'long-animation-frame',
    ]),
    metric(
        'main.loaf-duration.p95',
        'mainThread',
        'longAnimationFrameDurationMs',
        'p95',
        'ms',
        pageAndTargetBrowser,
        ['long-animation-frame'],
        'capture-window',
        undefined,
        'main.loaf.count'
    ),
    metric(
        'main.loaf-blocking.p95',
        'mainThread',
        'longAnimationFrameBlockingMs',
        'p95',
        'ms',
        pageAndTargetBrowser,
        ['long-animation-frame'],
        'capture-window',
        undefined,
        'main.loaf.count'
    ),
    metric(
        'pipeline.loaf-style-layout-tail.p95',
        'renderingPipeline',
        'longAnimationFrameStyleLayoutTailMs',
        'p95',
        'ms',
        pageAndTargetBrowser,
        ['long-animation-frame'],
        'capture-window',
        undefined,
        'main.loaf.count'
    ),
    metric('main.long-task.count', 'mainThread', 'longTaskCount', 'count', 'count', pageAndTargetBrowser, ['longtask']),
    metric('main.long-task-duration.sum', 'mainThread', 'longTaskDurationMs', 'sum', 'ms', pageAndTargetBrowser, ['longtask']),
    metric(
        'main.long-task-duration.p95',
        'mainThread',
        'longTaskDurationMs',
        'p95',
        'ms',
        pageAndTargetBrowser,
        ['longtask'],
        'capture-window',
        undefined,
        'main.long-task.count'
    ),
    metric(
        'main.long-task-duration.max',
        'mainThread',
        'longTaskDurationMs',
        'max',
        'ms',
        pageAndTargetBrowser,
        ['longtask'],
        'capture-window',
        undefined,
        'main.long-task.count'
    ),
    metric('outcome.event-duration.p95', 'userOutcome', 'eventTimingDurationMs', 'p95', 'ms', pageAndTargetBrowser, ['event-timing']),
    metric('outcome.input-delay.p95', 'userOutcome', 'inputDelayMs', 'p95', 'ms', pageAndTargetBrowser, ['event-timing']),
    metric('outcome.processing-duration.p95', 'userOutcome', 'processingDurationMs', 'p95', 'ms', pageAndTargetBrowser, ['event-timing']),
    metric('pipeline.presentation-delay.p95', 'renderingPipeline', 'presentationDelayMs', 'p95', 'ms', pageAndTargetBrowser, [
        'event-timing',
    ]),
    metric('outcome.interaction.count', 'userOutcome', 'interactionCount', 'count', 'count', pageAndTargetBrowser),
    metric(
        'outcome.interaction-duration.p95',
        'userOutcome',
        'interactionDurationMs',
        'p95',
        'ms',
        pageAndTargetBrowser,
        [],
        'capture-window',
        undefined,
        'outcome.interaction.count'
    ),
    metric('outcome.interaction-completed.count', 'userOutcome', 'completedInteractions', 'count', 'count', pageAndTargetBrowser),
    metric('outcome.interaction-cancelled.count', 'userOutcome', 'cancelledInteractions', 'count', 'count', pageAndTargetBrowser),
    metric('outcome.interaction-abandoned.count', 'userOutcome', 'abandonedInteractions', 'count', 'count', pageAndTargetBrowser),
    metric('monitor.callback.count', 'monitorOverhead', 'callbackCount', 'count', 'count', pageBrowser),
    metric('monitor.callback-self-time.ratio', 'monitorOverhead', 'callbackSelfTimeRatio', 'ratio', 'ratio', pageBrowser),
    metric('monitor.report-build.p95', 'monitorOverhead', 'reportBuildSelfTimeMs', 'p95', 'ms', pageBrowser),

    metric(
        'pipeline.loaf-render-start-to-paint.count',
        'renderingPipeline',
        'longAnimationFrameRenderStartToPaintCount',
        'count',
        'count',
        pageAndTargetBrowser,
        ['loaf-paint-time']
    ),
    metric(
        'pipeline.loaf-render-start-to-paint.p95',
        'renderingPipeline',
        'longAnimationFrameRenderStartToPaintMs',
        'p95',
        'ms',
        pageAndTargetBrowser,
        ['loaf-paint-time'],
        'capture-window',
        undefined,
        'pipeline.loaf-render-start-to-paint.count'
    ),
    metric(
        'pipeline.loaf-paint-to-presentation.count',
        'renderingPipeline',
        'longAnimationFramePaintToPresentationCount',
        'count',
        'count',
        pageAndTargetBrowser,
        ['loaf-presentation-time']
    ),
    metric(
        'pipeline.loaf-paint-to-presentation.p95',
        'renderingPipeline',
        'longAnimationFramePaintToPresentationMs',
        'p95',
        'ms',
        pageAndTargetBrowser,
        ['loaf-presentation-time'],
        'capture-window',
        undefined,
        'pipeline.loaf-paint-to-presentation.count'
    ),
    metric(
        'main.input-capture-to-next-raf.count',
        'mainThread',
        'inputCaptureToNextRafCallbackCount',
        'count',
        'count',
        pageAndTargetInput,
        ['input-frame-scheduling']
    ),
    metric(
        'main.input-capture-to-next-raf.p95',
        'mainThread',
        'inputCaptureToNextRafCallbackMs',
        'p95',
        'ms',
        pageAndTargetInput,
        ['input-frame-scheduling'],
        'capture-window',
        undefined,
        'main.input-capture-to-next-raf.count'
    ),
    metric(
        'outcome.loaf-first-ui-to-end.count',
        'userOutcome',
        'longAnimationFrameFirstUIEventToFrameEndCount',
        'count',
        'count',
        pageAndTargetBrowser,
        ['long-animation-frame']
    ),
    metric(
        'outcome.loaf-first-ui-to-end.p95',
        'userOutcome',
        'longAnimationFrameFirstUIEventToFrameEndMs',
        'p95',
        'ms',
        pageAndTargetBrowser,
        ['long-animation-frame'],
        'capture-window',
        undefined,
        'outcome.loaf-first-ui-to-end.count'
    ),
    metric(
        'pipeline.loaf-forced-style-layout.count',
        'renderingPipeline',
        'longAnimationFrameAttributedForcedStyleAndLayoutCount',
        'count',
        'count',
        pageAndTargetBrowser,
        ['long-animation-frame']
    ),
    metric(
        'pipeline.loaf-forced-style-layout.p95',
        'renderingPipeline',
        'longAnimationFrameAttributedForcedStyleAndLayoutMs',
        'p95',
        'ms',
        pageAndTargetBrowser,
        ['long-animation-frame'],
        'capture-window',
        undefined,
        'pipeline.loaf-forced-style-layout.count'
    ),
    metric('vital.cls.latest', 'userOutcome', 'CLS', 'latest', 'score', pageWebVitals, ['web-vitals'], 'document-lifetime'),
    metric('vital.inp.latest', 'userOutcome', 'INP', 'latest', 'ms', pageWebVitals, ['web-vitals'], 'document-lifetime'),
    metric('vital.lcp.latest', 'userOutcome', 'LCP', 'latest', 'ms', pageWebVitals, ['web-vitals'], 'document-lifetime'),
    metric('resource.count', 'resourcesMedia', 'resourceCount', 'count', 'count', pageResources, ['resource-timing']),
    metric(
        'resource.duration.p95',
        'resourcesMedia',
        'resourceDurationMs',
        'p95',
        'ms',
        pageResources,
        ['resource-timing'],
        'capture-window',
        undefined,
        'resource.count'
    ),
    metric('resource.transfer-size.sum', 'resourcesMedia', 'transferSizeBytes', 'sum', 'bytes', pageResources, ['resource-timing']),
    metric('resource.encoded-size.sum', 'resourcesMedia', 'encodedBodySizeBytes', 'sum', 'bytes', pageResources, ['resource-timing']),
    metric('resource.decoded-size.sum', 'resourcesMedia', 'decodedBodySizeBytes', 'sum', 'bytes', pageResources, ['resource-timing']),
    metric('animation.running.count', 'motionQuality', 'runningAnimations', 'count', 'count', pageAndTargetAnimations, [
        'document-animations-inspection',
    ]),
    metric('animation.infinite.count', 'motionQuality', 'infiniteAnimations', 'count', 'count', pageAndTargetAnimations, [
        'document-animations-inspection',
    ]),
    metric(
        'accessibility.reduced-motion-active-candidate.count',
        'accessibility',
        'reducedMotionActiveAnimationCandidates',
        'count',
        'count',
        pageEvidence,
        ['reduced-motion-preference', 'document-animations-inspection']
    ),
    metric('surface.canvas.count', 'renderer', 'canvasSurfaces', 'count', 'count', pageEvidence, ['page-evidence']),
    metric('surface.svg.count', 'renderer', 'svgSurfaces', 'count', 'count', pageEvidence, ['page-evidence']),
    metric('surface.canvas2d.count', 'renderer', 'canvas2dSurfaces', 'count', 'count', pageEvidence, ['canvas-context-registry']),
    metric('surface.webgl.count', 'renderer', 'webglSurfaces', 'count', 'count', pageEvidence, ['canvas-context-registry']),
    metric('surface.webgpu.count', 'renderer', 'webgpuSurfaces', 'count', 'count', pageEvidence, ['canvas-context-registry']),
    metric('media.video-element.count', 'resourcesMedia', 'videoElementCount', 'count', 'count', pageEvidence, ['page-evidence']),
    metric('media.video-dropped-frame-rate.ratio', 'resourcesMedia', 'videoDroppedFrameRate', 'ratio', 'ratio', pageMedia, [
        'video-playback-quality',
    ]),

    metric(
        'target.backing-store-pixels-bucket.latest',
        'renderer',
        'backingStorePixelsBucketUpperBound',
        'latest',
        'pixels',
        targetDirect,
        ['target-direct-inspection'],
        'capture-window',
        [0, 262_144, 1_048_576, 2_073_600, 4_194_304, 8_294_400, 16_777_216, 33_554_432]
    ),
    metric(
        'target.effective-pixel-ratio-bucket.latest',
        'renderer',
        'effectivePixelRatioBucket',
        'latest',
        'multiplier',
        targetDirect,
        ['target-direct-inspection'],
        'capture-window',
        [1, 1.5, 2, 3, 4, 8]
    ),
    metric('renderer.gpu-frame.p95', 'renderer', 'gpuFrameMs', 'p95', 'ms', rendererAdapter, ['renderer-adapter', 'gpu-timer-query']),
    metric('renderer.draw-calls.p95', 'renderer', 'drawCalls', 'p95', 'count', rendererAdapter, ['renderer-adapter']),
    metric('renderer.triangles.p95', 'renderer', 'triangles', 'p95', 'count', rendererAdapter, ['renderer-adapter']),
    metric('interaction.input-to-visual.p95', 'scrollGesture', 'inputToVisualMs', 'p95', 'ms', interactionAdapter, [
        'interaction-quality-adapter',
    ]),
    metric('interaction.pointer-sample-age.p95', 'scrollGesture', 'pointerSampleAgeMs', 'p95', 'ms', interactionAdapter, [
        'interaction-quality-adapter',
    ]),
    metric('interaction.progress-error.p95', 'scrollGesture', 'progressError', 'p95', 'ratio', interactionAdapter, [
        'interaction-quality-adapter',
    ]),
    metric('motion.settle-time.p95', 'motionQuality', 'settleTimeMs', 'p95', 'ms', interactionAdapter, ['interaction-quality-adapter']),
])

/**
 * Closed event-flow aggregates that can be divided by a capture window.
 * Point-in-time inventory such as running animations, surfaces, and video
 * elements is intentionally excluded even though those metrics use `count`.
 */
export const ANIMATION_RUM_V2_PER_MINUTE_METRIC_IDS = Object.freeze([
    'frame.jank-burst.count',
    'frame.missed-opportunities.sum',
    'main.loaf.count',
    'main.loaf-duration.sum',
    'main.long-task.count',
    'main.long-task-duration.sum',
    'outcome.interaction.count',
    'outcome.interaction-completed.count',
    'outcome.interaction-cancelled.count',
    'outcome.interaction-abandoned.count',
    'monitor.callback.count',
    'pipeline.loaf-render-start-to-paint.count',
    'pipeline.loaf-paint-to-presentation.count',
    'main.input-capture-to-next-raf.count',
    'outcome.loaf-first-ui-to-end.count',
    'pipeline.loaf-forced-style-layout.count',
    'resource.count',
    'resource.transfer-size.sum',
    'resource.encoded-size.sum',
    'resource.decoded-size.sum',
] as const)

const METRIC_BY_ID = new Map(ANIMATION_RUM_V2_METRIC_CATALOG.map(definition => [definition.metricId, definition]))

export function getAnimationRumV2MetricDefinition(metricId: string): AnimationRumV2MetricDefinition | undefined {
    return METRIC_BY_ID.get(metricId)
}

export interface AnimationRumV2Metric {
    metricId: string
    relation: AnimationRumV2Relation
    owner: AnimationRumV2ProviderOwner
    value: number | null
    samples: number | null
    status: AnimationRumV2MetricStatus
}

export interface AnimationRumV2ProviderEvidence {
    version: string
    accepted: number
    retained: number
    evidence: number
    dropped: number
    rejected: number
    truncated: boolean
}

export interface AnimationRumV2Report {
    contractVersion: 2
    snapshotSchemaVersion: 1
    eventId: string
    captureId: string
    scope: AnimationRumV2Scope
    parentCaptureId: string | null
    targetKey: string | null
    capturedAt: string
    release: string
    dist: string
    environment: string
    sdkVersion: string
    monitorVersion: string
    sampleRate: number
    samplingPolicyVersion: number
    context: {
        routeKey?: string
        visibilityState?: 'visible' | 'hidden' | 'prerender' | 'unknown'
        reducedMotion?: boolean | null
        viewportBucket?: 'tiny' | 'small' | 'medium' | 'large' | 'xlarge' | 'unknown'
        dprBucket?: '1' | '1.5' | '2' | '3' | '4+' | 'unknown'
        refreshHz?: number | null
        refreshBudgetSource?: 'explicit' | 'inferred' | 'observed' | 'unknown'
        refreshBudgetConfidence?: 'explicit' | 'high' | 'medium' | 'low' | 'unknown'
        windowDurationMs: number
        windowDurationCapped: boolean
        runtime: {
            framework:
                | 'vanilla'
                | 'react'
                | 'preact'
                | 'vue'
                | 'angular'
                | 'svelte'
                | 'solid'
                | 'qwik'
                | 'lit'
                | 'mixed'
                | 'other'
                | 'unknown'
            renderer: 'dom' | 'svg' | 'canvas' | 'mixed' | 'other' | 'unknown'
            backend: 'dom' | 'canvas2d' | 'webgl' | 'webgl2' | 'webgpu' | 'mixed' | 'other' | 'unknown'
        }
    }
    capabilities: Record<AnimationRumV2CapabilityName, AnimationRumV2CapabilityState>
    coverage: Record<AnimationRumFamily, { status: AnimationRumV2CoverageStatus; evidenceLevel: AnimationRumV2EvidenceLevel }>
    captureQuality: {
        sufficiency: 'sufficient' | 'insufficient'
        integrity: 'complete' | 'partial'
        reasons: AnimationRumV2QualityReason[]
        adapterErrorCount: number
    }
    providerEvidence: Partial<Record<AnimationRumV2ProviderOwner, Partial<Record<AnimationRumFamily, AnimationRumV2ProviderEvidence>>>>
    metrics: AnimationRumV2Metric[]
}

export type AnimationRumV2ValidationResult = { ok: true; value: AnimationRumV2Report } | { ok: false; errors: string[] }
export type AnimationRumProtocol = 'v1' | 'v2' | 'versioned-unknown' | 'legacy-animation-rum' | 'other'

const ROOT_KEYS = new Set([
    'contractVersion',
    'snapshotSchemaVersion',
    'eventId',
    'captureId',
    'scope',
    'parentCaptureId',
    'targetKey',
    'capturedAt',
    'release',
    'dist',
    'environment',
    'sdkVersion',
    'monitorVersion',
    'sampleRate',
    'samplingPolicyVersion',
    'context',
    'capabilities',
    'coverage',
    'captureQuality',
    'providerEvidence',
    'metrics',
])
const CONTEXT_KEYS = new Set([
    'routeKey',
    'visibilityState',
    'reducedMotion',
    'viewportBucket',
    'dprBucket',
    'refreshHz',
    'refreshBudgetSource',
    'refreshBudgetConfidence',
    'windowDurationMs',
    'windowDurationCapped',
    'runtime',
])
const RUNTIME_KEYS = new Set(['framework', 'renderer', 'backend'])
const COVERAGE_KEYS = new Set(['status', 'evidenceLevel'])
const QUALITY_KEYS = new Set(['sufficiency', 'integrity', 'reasons', 'adapterErrorCount'])
const PROVIDER_KEYS = new Set(['version', 'accepted', 'retained', 'evidence', 'dropped', 'rejected', 'truncated'])
const METRIC_KEYS = new Set(['metricId', 'relation', 'owner', 'value', 'samples', 'status'])
const FAMILY_SET = new Set<string>(ANIMATION_RUM_FAMILIES)
const CAPABILITY_SET = new Set<string>(ANIMATION_RUM_V2_CAPABILITIES)
const OWNER_SET = new Set<string>(ANIMATION_RUM_V2_PROVIDER_OWNERS)
const QUALITY_REASON_SET = new Set<string>(ANIMATION_RUM_V2_QUALITY_REASONS)
const RELATION_SET = new Set<string>(['page-window', 'target-direct', 'target-temporal-overlap', 'adapter'])
const STATUS_SET = new Set<string>(['measured', 'partial', 'not-observed', 'not-instrumented', 'unsupported', 'unknown'])
const AVAILABLE_STATUSES = new Set<string>(['measured', 'partial'])
const UNAVAILABLE_STATUSES = new Set<string>(['not-observed', 'not-instrumented', 'unsupported', 'unknown'])
const CAPABILITY_STATES = new Set<string>(['supported', 'unsupported', 'unknown', 'disabled'])
const EVIDENCE_LEVELS = new Set<string>(['runtime-observation', 'unsupported-or-unknown'])
const VISIBILITY_STATES = new Set<string>(['visible', 'hidden', 'prerender', 'unknown'])
const VIEWPORT_BUCKETS = new Set<string>(['tiny', 'small', 'medium', 'large', 'xlarge', 'unknown'])
const DPR_BUCKETS = new Set<string>(['1', '1.5', '2', '3', '4+', 'unknown'])
const REFRESH_SOURCES = new Set<string>(['explicit', 'inferred', 'observed', 'unknown'])
const REFRESH_CONFIDENCES = new Set<string>(['explicit', 'high', 'medium', 'low', 'unknown'])
const FRAMEWORKS = new Set<string>([
    'vanilla',
    'react',
    'preact',
    'vue',
    'angular',
    'svelte',
    'solid',
    'qwik',
    'lit',
    'mixed',
    'other',
    'unknown',
])
const RENDERERS = new Set<string>(['dom', 'svg', 'canvas', 'mixed', 'other', 'unknown'])
const BACKENDS = new Set<string>(['dom', 'canvas2d', 'webgl', 'webgl2', 'webgpu', 'mixed', 'other', 'unknown'])
const SUFFICIENCY_REASONS = new Set<string>(['visible-window-too-short', 'insufficient-frame-samples', 'refresh-confidence-low'])
const INTEGRITY_REASONS = new Set<string>([
    'adapter-error',
    'provider-rejected-samples',
    'provider-truncated',
    'source-field-incomplete',
    'window-capped',
])
const FORBIDDEN_KEYS = new Set([
    'user',
    'userid',
    'useremail',
    'email',
    'ip',
    'ipaddress',
    'useragent',
    'browserinfo',
    'url',
    'href',
    'referrer',
    'referer',
    'query',
    'hash',
    'selector',
    'selectors',
    'element',
    'elementid',
    'dom',
    'domid',
    'class',
    'classname',
    'tag',
    'tagname',
    'role',
    'text',
    'innertext',
    'textcontent',
    'input',
    'inputvalue',
    'props',
    'state',
    'component',
    'componentname',
    'ownerlabel',
    'source',
    'sourcefile',
    'file',
    'line',
    'column',
    'stack',
    'frames',
    'rawframes',
    'rawsamples',
    'entries',
    'events',
    'scripts',
    'keyframes',
    'resourcename',
    'resourceurl',
    'coordinates',
    'clientx',
    'clienty',
    'pagex',
    'pagey',
    'screenx',
    'screeny',
    'pointerpath',
    'dragpath',
    'screenshot',
    'pixelscontent',
    'shadersource',
    'adaptererrors',
    'custom',
    'customdata',
    'details',
    'metadata',
    'snapshot',
    'cookies',
    'headers',
    'authorization',
])
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u
const PROVIDER_VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z][a-z0-9.-]{0,23})?$/u
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/u
const ROUTE_KEY_RE = /^[a-z][a-z0-9._:-]{0,95}$/u
const TARGET_KEY_RE = /^[a-z][a-z0-9._-]{0,47}$/u
const HIGH_CARDINALITY_TOKEN_RE = /(?:^|[._:-])(?:\d{5,}|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,})(?:$|[._:-])/u
const ISO_UTC_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function add(errors: string[], code: string): void {
    if (errors.length < 32 && !errors.includes(code)) errors.push(code)
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, errors: string[], code: string): void {
    if (Object.keys(value).some(key => !allowed.has(key))) add(errors, code)
}

function rejectForbiddenKeys(value: unknown, errors: string[], depth = 0): void {
    if (depth > 6 || errors.length >= 32) return
    if (Array.isArray(value)) {
        for (const item of value) rejectForbiddenKeys(item, errors, depth + 1)
        return
    }
    if (!isRecord(value)) return
    for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key.toLowerCase())) add(errors, 'forbidden_field')
        rejectForbiddenKeys(child, errors, depth + 1)
    }
}

function finiteNumber(value: unknown, minimum: number, maximum: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function boundedInteger(value: unknown, maximum = 1_000_000_000): value is number {
    return Number.isInteger(value) && finiteNumber(value, 0, maximum)
}

function boundedString(value: unknown, maximum: number, pattern: RegExp, allowEmpty = false): value is string {
    return (
        typeof value === 'string' &&
        value.length <= maximum &&
        (allowEmpty ? value.length === 0 || pattern.test(value) : pattern.test(value))
    )
}

function boundedSemanticKey(value: unknown, maximum: number, pattern: RegExp): value is string {
    return boundedString(value, maximum, pattern) && !HIGH_CARDINALITY_TOKEN_RE.test(value)
}

/**
 * Validates a static, application-registered route template identity. This does
 * not replace server-side registration or cardinality enforcement.
 */
export function isAnimationRumV2RouteKey(value: unknown): value is string {
    return boundedSemanticKey(value, 96, ROUTE_KEY_RE)
}

/**
 * Validates a static, application-registered target identity. This does not
 * replace server-side registration or cardinality enforcement.
 */
export function isAnimationRumV2TargetKey(value: unknown): value is string {
    return boundedSemanticKey(value, 48, TARGET_KEY_RE)
}

function payloadBytes(value: unknown): number {
    try {
        return new TextEncoder().encode(JSON.stringify(value)).byteLength
    } catch {
        return Number.POSITIVE_INFINITY
    }
}

function canonicalUtcTimestamp(value: unknown): number | null {
    if (!boundedString(value, 40, ISO_UTC_RE)) return null
    const match = ISO_UTC_RE.exec(value)
    if (!match) return null
    const normalized = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === normalized ? timestamp : null
}

function valueMaximum(unit: AnimationRumV2MetricUnit): number {
    if (unit === 'ratio') return 1
    if (unit === 'multiplier') return 16
    if (unit === 'percent') return 100
    if (unit === 'score') return 100
    if (unit === 'hz') return 1_000
    if (unit === 'ms') return 604_800_000
    if (unit === 'count' || unit === 'frames') return 1_000_000_000
    if (unit === 'pixels') return 1_000_000_000_000
    return 1_000_000_000_000_000
}

export function detectAnimationRumProtocol(value: unknown): AnimationRumProtocol {
    if (!isRecord(value) || value.event_type !== ANIMATION_RUM_EVENT_TYPE) return 'other'
    const hasVersion = 'contractVersion' in value || 'snapshotSchemaVersion' in value
    if (!hasVersion) return 'legacy-animation-rum'
    if (value.contractVersion === 1 && value.snapshotSchemaVersion === 1) return 'v1'
    if (
        value.contractVersion === ANIMATION_RUM_V2_CONTRACT_VERSION &&
        value.snapshotSchemaVersion === ANIMATION_RUM_V2_SNAPSHOT_SCHEMA_VERSION
    ) {
        return 'v2'
    }
    return 'versioned-unknown'
}

function parseContext(raw: unknown, errors: string[]): AnimationRumV2Report['context'] | null {
    if (!isRecord(raw)) {
        add(errors, 'invalid_context')
        return null
    }
    rejectUnknownKeys(raw, CONTEXT_KEYS, errors, 'unknown_context_field')
    if (raw.routeKey !== undefined && !isAnimationRumV2RouteKey(raw.routeKey)) add(errors, 'invalid_route_key')
    if (raw.visibilityState !== undefined && (typeof raw.visibilityState !== 'string' || !VISIBILITY_STATES.has(raw.visibilityState))) {
        add(errors, 'invalid_visibility_state')
    }
    if (raw.reducedMotion !== undefined && raw.reducedMotion !== null && typeof raw.reducedMotion !== 'boolean') {
        add(errors, 'invalid_reduced_motion')
    }
    if (raw.viewportBucket !== undefined && (typeof raw.viewportBucket !== 'string' || !VIEWPORT_BUCKETS.has(raw.viewportBucket))) {
        add(errors, 'invalid_viewport_bucket')
    }
    if (raw.dprBucket !== undefined && (typeof raw.dprBucket !== 'string' || !DPR_BUCKETS.has(raw.dprBucket))) {
        add(errors, 'invalid_dpr_bucket')
    }
    if (raw.refreshHz !== undefined && raw.refreshHz !== null && !finiteNumber(raw.refreshHz, 1, 1_000)) add(errors, 'invalid_refresh_hz')
    if (
        raw.refreshBudgetSource !== undefined &&
        (typeof raw.refreshBudgetSource !== 'string' || !REFRESH_SOURCES.has(raw.refreshBudgetSource))
    ) {
        add(errors, 'invalid_refresh_budget_source')
    }
    if (
        raw.refreshBudgetConfidence !== undefined &&
        (typeof raw.refreshBudgetConfidence !== 'string' || !REFRESH_CONFIDENCES.has(raw.refreshBudgetConfidence))
    ) {
        add(errors, 'invalid_refresh_budget_confidence')
    }
    if (!finiteNumber(raw.windowDurationMs, 0, 604_800_000)) add(errors, 'invalid_window_duration')
    if (typeof raw.windowDurationCapped !== 'boolean') add(errors, 'invalid_window_duration_capped')
    if (raw.windowDurationCapped === true && raw.windowDurationMs !== 604_800_000) add(errors, 'invalid_window_duration_cap_semantics')
    if (!isRecord(raw.runtime)) add(errors, 'invalid_runtime')
    else {
        rejectUnknownKeys(raw.runtime, RUNTIME_KEYS, errors, 'unknown_runtime_field')
        if (typeof raw.runtime.framework !== 'string' || !FRAMEWORKS.has(raw.runtime.framework)) add(errors, 'invalid_runtime_framework')
        if (typeof raw.runtime.renderer !== 'string' || !RENDERERS.has(raw.runtime.renderer)) add(errors, 'invalid_runtime_renderer')
        if (typeof raw.runtime.backend !== 'string' || !BACKENDS.has(raw.runtime.backend)) add(errors, 'invalid_runtime_backend')
    }
    return raw as AnimationRumV2Report['context']
}

function parseCapabilities(raw: unknown, errors: string[]): AnimationRumV2Report['capabilities'] | null {
    if (!isRecord(raw)) {
        add(errors, 'invalid_capabilities')
        return null
    }
    rejectUnknownKeys(raw, CAPABILITY_SET, errors, 'unknown_capability')
    if (Object.keys(raw).length !== ANIMATION_RUM_V2_CAPABILITIES.length || ANIMATION_RUM_V2_CAPABILITIES.some(name => !(name in raw))) {
        add(errors, 'missing_capability')
    }
    for (const value of Object.values(raw)) {
        if (typeof value !== 'string' || !CAPABILITY_STATES.has(value)) add(errors, 'invalid_capability_state')
    }
    return raw as AnimationRumV2Report['capabilities']
}

function parseCoverage(raw: unknown, errors: string[]): AnimationRumV2Report['coverage'] | null {
    if (!isRecord(raw)) {
        add(errors, 'invalid_coverage')
        return null
    }
    rejectUnknownKeys(raw, FAMILY_SET, errors, 'unknown_coverage_family')
    if (Object.keys(raw).length !== ANIMATION_RUM_FAMILIES.length || ANIMATION_RUM_FAMILIES.some(family => !(family in raw))) {
        add(errors, 'missing_coverage_family')
    }
    for (const value of Object.values(raw)) {
        if (!isRecord(value)) {
            add(errors, 'invalid_coverage_value')
            continue
        }
        rejectUnknownKeys(value, COVERAGE_KEYS, errors, 'unknown_coverage_field')
        if (typeof value.status !== 'string' || !STATUS_SET.has(value.status)) add(errors, 'invalid_coverage_status')
        if (typeof value.evidenceLevel !== 'string' || !EVIDENCE_LEVELS.has(value.evidenceLevel))
            add(errors, 'invalid_coverage_evidence_level')
        const unavailable = typeof value.status === 'string' && ['not-instrumented', 'unsupported', 'unknown'].includes(value.status)
        if (unavailable && value.evidenceLevel !== 'unsupported-or-unknown') add(errors, 'invalid_coverage_evidence_semantics')
        if (!unavailable && value.evidenceLevel !== 'runtime-observation') add(errors, 'invalid_coverage_evidence_semantics')
    }
    return raw as AnimationRumV2Report['coverage']
}

function parseProviderEvidence(raw: unknown, errors: string[]): AnimationRumV2Report['providerEvidence'] | null {
    if (!isRecord(raw)) {
        add(errors, 'invalid_provider_evidence')
        return null
    }
    rejectUnknownKeys(raw, OWNER_SET, errors, 'unknown_provider_owner')
    for (const families of Object.values(raw)) {
        if (!isRecord(families)) {
            add(errors, 'invalid_provider_family_evidence')
            continue
        }
        rejectUnknownKeys(families, FAMILY_SET, errors, 'unknown_provider_family')
        if (Object.keys(families).length === 0) add(errors, 'empty_provider_evidence')
        let providerVersion: string | null = null
        for (const value of Object.values(families)) {
            if (!isRecord(value)) {
                add(errors, 'invalid_provider_evidence_value')
                continue
            }
            rejectUnknownKeys(value, PROVIDER_KEYS, errors, 'unknown_provider_evidence_field')
            if (Object.keys(value).length !== PROVIDER_KEYS.size) add(errors, 'missing_provider_evidence_field')
            if (!boundedString(value.version, 32, PROVIDER_VERSION_RE)) add(errors, 'invalid_provider_version')
            else if (providerVersion !== null && providerVersion !== value.version) add(errors, 'inconsistent_provider_version')
            else providerVersion = value.version
            for (const key of ['accepted', 'retained', 'evidence', 'dropped', 'rejected'] as const) {
                if (!boundedInteger(value[key])) add(errors, 'invalid_provider_count')
            }
            if (typeof value.truncated !== 'boolean') add(errors, 'invalid_provider_truncated')
            if (
                boundedInteger(value.accepted) &&
                boundedInteger(value.retained) &&
                boundedInteger(value.evidence) &&
                boundedInteger(value.dropped)
            ) {
                if (
                    value.retained > value.accepted ||
                    value.evidence > value.retained ||
                    value.dropped !== value.accepted - value.retained
                ) {
                    add(errors, 'invalid_provider_count_semantics')
                }
                if (value.truncated !== value.dropped > 0) add(errors, 'invalid_provider_truncated_semantics')
            }
        }
    }
    return raw as AnimationRumV2Report['providerEvidence']
}

function parseCaptureQuality(
    raw: unknown,
    context: AnimationRumV2Report['context'] | null,
    providers: AnimationRumV2Report['providerEvidence'] | null,
    errors: string[]
): AnimationRumV2Report['captureQuality'] | null {
    if (!isRecord(raw)) {
        add(errors, 'invalid_capture_quality')
        return null
    }
    rejectUnknownKeys(raw, QUALITY_KEYS, errors, 'unknown_capture_quality_field')
    if (raw.sufficiency !== 'sufficient' && raw.sufficiency !== 'insufficient') add(errors, 'invalid_capture_sufficiency')
    if (raw.integrity !== 'complete' && raw.integrity !== 'partial') add(errors, 'invalid_capture_integrity')
    if (!boundedInteger(raw.adapterErrorCount)) add(errors, 'invalid_adapter_error_count')
    if (!Array.isArray(raw.reasons) || raw.reasons.length > ANIMATION_RUM_V2_QUALITY_REASONS.length) {
        add(errors, 'invalid_capture_quality_reasons')
        return raw as AnimationRumV2Report['captureQuality']
    }
    if (raw.reasons.some(reason => typeof reason !== 'string' || !QUALITY_REASON_SET.has(reason)))
        add(errors, 'invalid_capture_quality_reason')
    const reasons = raw.reasons.filter((reason): reason is string => typeof reason === 'string')
    if (new Set(reasons).size !== reasons.length || reasons.join('\0') !== [...reasons].sort().join('\0')) {
        add(errors, 'noncanonical_capture_quality_reasons')
    }
    const hasSufficiencyReason = reasons.some(reason => SUFFICIENCY_REASONS.has(reason))
    if ((raw.sufficiency === 'insufficient') !== hasSufficiencyReason) add(errors, 'invalid_capture_sufficiency_semantics')
    const providerValues = providers ? Object.values(providers).flatMap(families => (families ? Object.values(families) : [])) : []
    const hasTruncation = providerValues.some(value => value?.truncated === true || (value?.dropped ?? 0) > 0)
    const hasRejected = providerValues.some(value => (value?.rejected ?? 0) > 0)
    const hasAdapterErrors = typeof raw.adapterErrorCount === 'number' && raw.adapterErrorCount > 0
    const factReasons = new Map<AnimationRumV2QualityReason, boolean>([
        ['provider-truncated', hasTruncation],
        ['provider-rejected-samples', hasRejected],
        ['window-capped', context?.windowDurationCapped === true],
        ['adapter-error', hasAdapterErrors],
    ])
    for (const [reason, fact] of factReasons) {
        if (reasons.includes(reason) !== fact) add(errors, 'invalid_capture_quality_fact')
    }
    const hasIntegrityReason = reasons.some(reason => INTEGRITY_REASONS.has(reason))
    if ((raw.integrity === 'partial') !== hasIntegrityReason) add(errors, 'invalid_capture_integrity_semantics')
    return raw as AnimationRumV2Report['captureQuality']
}

function bindingAllows(definition: AnimationRumV2MetricDefinition, scope: unknown, relation: unknown, owner: unknown): boolean {
    return definition.bindings.some(
        binding => binding.scope === scope && binding.relation === relation && binding.owners.some(candidate => candidate === owner)
    )
}

function parseMetrics(
    raw: unknown,
    scope: unknown,
    capabilities: AnimationRumV2Report['capabilities'] | null,
    providers: AnimationRumV2Report['providerEvidence'] | null,
    quality: AnimationRumV2Report['captureQuality'] | null,
    errors: string[]
): AnimationRumV2Metric[] | null {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > ANIMATION_RUM_V2_MAX_METRICS) {
        add(errors, 'invalid_metrics_count')
        return null
    }
    const identities = new Set<string>()
    for (const value of raw) {
        if (!isRecord(value)) {
            add(errors, 'invalid_metric')
            continue
        }
        rejectUnknownKeys(value, METRIC_KEYS, errors, 'unknown_metric_field')
        if (Object.keys(value).length !== METRIC_KEYS.size) add(errors, 'missing_metric_field')
        const definition = typeof value.metricId === 'string' ? METRIC_BY_ID.get(value.metricId) : undefined
        if (!definition) add(errors, 'unknown_metric_id')
        if (typeof value.relation !== 'string' || !RELATION_SET.has(value.relation)) add(errors, 'invalid_metric_relation')
        if (typeof value.owner !== 'string' || !OWNER_SET.has(value.owner)) add(errors, 'invalid_metric_owner')
        if (definition && !bindingAllows(definition, scope, value.relation, value.owner)) add(errors, 'invalid_metric_binding')
        if (typeof value.status !== 'string' || !STATUS_SET.has(value.status)) add(errors, 'invalid_metric_status')
        const allowedValues = definition?.allowedValues
        const maximumValue = allowedValues?.[allowedValues.length - 1] ?? (definition ? valueMaximum(definition.unit) : 0)
        if (value.value !== null && (!definition || !finiteNumber(value.value, 0, maximumValue))) {
            add(errors, 'invalid_metric_value')
        }
        if (typeof value.value === 'number' && definition?.allowedValues && !definition.allowedValues.includes(value.value)) {
            add(errors, 'invalid_metric_bucket')
        }
        if (definition?.stat === 'count' && typeof value.value === 'number' && !Number.isInteger(value.value)) {
            add(errors, 'invalid_count_metric_value')
        }
        if (value.samples !== null && !boundedInteger(value.samples)) add(errors, 'invalid_metric_samples')
        const available = typeof value.status === 'string' && AVAILABLE_STATUSES.has(value.status)
        const unavailable = typeof value.status === 'string' && UNAVAILABLE_STATUSES.has(value.status)
        if (available && (value.value === null || value.samples === null)) add(errors, 'invalid_metric_null_semantics')
        if (unavailable && (value.value !== null || value.samples !== null)) add(errors, 'invalid_metric_null_semantics')
        if (available && definition && typeof value.samples === 'number') {
            const zeroPopulationAllowed = definition.stat === 'count' || definition.stat === 'sum'
            if (value.samples === 0 && (!zeroPopulationAllowed || value.value !== 0)) add(errors, 'invalid_zero_population_metric')
        }
        const owner = typeof value.owner === 'string' && OWNER_SET.has(value.owner) ? (value.owner as AnimationRumV2ProviderOwner) : null
        const provider = owner && providers && definition ? providers[owner]?.[definition.family] : undefined
        if (available && !provider) add(errors, 'missing_metric_provider_evidence')
        if (available && provider && provider.evidence === 0) add(errors, 'missing_metric_evidence')
        const providerLoss = provider ? provider.truncated || provider.dropped > 0 || provider.rejected > 0 : false
        const qualityRequiresPartial =
            definition?.partialWhenQualityReasons.some(reason => quality?.reasons.includes(reason) === true) ?? false
        if (value.status === 'measured' && (providerLoss || qualityRequiresPartial)) add(errors, 'metric_requires_partial_status')
        if (value.status === 'partial' && !providerLoss && !qualityRequiresPartial) {
            add(errors, 'partial_metric_without_limitation')
        }
        if (available && definition && capabilities) {
            for (const capability of definition.requiredCapabilities) {
                if (capabilities[capability] !== 'supported') add(errors, 'metric_capability_mismatch')
            }
        }
        if (typeof value.metricId === 'string' && typeof value.relation === 'string') {
            const identity = `${value.metricId}\0${value.relation}`
            if (identities.has(identity)) add(errors, 'duplicate_metric')
            identities.add(identity)
        }
    }
    return raw as AnimationRumV2Metric[]
}

function validateMetricSemantics(metrics: AnimationRumV2Metric[] | null, errors: string[]): void {
    if (!metrics) return
    const available = metrics.filter(
        (metricValue): metricValue is AnimationRumV2Metric & { value: number; samples: number } =>
            AVAILABLE_STATUSES.has(metricValue.status) && typeof metricValue.value === 'number' && typeof metricValue.samples === 'number'
    )
    const groups = new Map<string, Array<{ stat: AnimationRumV2MetricStat; value: number }>>()
    for (const metricValue of available) {
        const definition = METRIC_BY_ID.get(metricValue.metricId)
        if (!definition) continue
        const key = `${definition.family}\0${definition.name}\0${metricValue.owner}\0${metricValue.relation}`
        const group = groups.get(key) ?? []
        group.push({ stat: definition.stat, value: metricValue.value })
        groups.set(key, group)

        if (definition.populationMetricId) {
            const population = metrics.find(
                candidate =>
                    candidate.metricId === definition.populationMetricId &&
                    candidate.owner === metricValue.owner &&
                    candidate.relation === metricValue.relation
            )
            if (
                population &&
                (!AVAILABLE_STATUSES.has(population.status) || typeof population.value !== 'number' || population.value === 0)
            ) {
                add(errors, 'metric_population_contradiction')
            }
        }
    }
    const orderedStats: readonly AnimationRumV2MetricStat[] = ['min', 'p50', 'p75', 'p95', 'p99', 'max']
    for (const group of groups.values()) {
        let previous: number | null = null
        for (const stat of orderedStats) {
            const current = group.find(candidate => candidate.stat === stat)?.value
            if (current === undefined) continue
            if (previous !== null && current < previous) add(errors, 'invalid_metric_distribution_order')
            previous = current
        }
    }
}

function validateCoverageAgainstMetrics(
    coverage: AnimationRumV2Report['coverage'] | null,
    metrics: AnimationRumV2Metric[] | null,
    errors: string[]
): void {
    if (!coverage || !metrics) return
    for (const family of ANIMATION_RUM_FAMILIES) {
        const familyMetrics = metrics.filter(metric => METRIC_BY_ID.get(metric.metricId)?.family === family)
        const available = familyMetrics.filter(metric => AVAILABLE_STATUSES.has(metric.status))
        const state = coverage[family]?.status
        if (
            available.length > 0 &&
            (state === 'not-observed' || state === 'not-instrumented' || state === 'unsupported' || state === 'unknown')
        ) {
            add(errors, 'coverage_metric_status_mismatch')
        }
        if ((state === 'measured' || state === 'partial') && available.length === 0) add(errors, 'coverage_without_available_metric')
        if (available.some(metric => metric.status === 'partial') && state === 'measured') add(errors, 'coverage_ignores_partial_metric')
    }
}

/**
 * Validates only the normalized report. Transport wrapper aliases, target-key
 * registration, parent ownership, and persistence checks belong to the DSN or
 * Worker integration and must not be silently normalized here.
 */
export function validateNormalizedAnimationRumV2(raw: unknown, options: { nowEpochMs?: number } = {}): AnimationRumV2ValidationResult {
    const errors: string[] = []
    if (!isRecord(raw)) return { ok: false, errors: ['invalid_payload'] }
    if (payloadBytes(raw) > ANIMATION_RUM_V2_MAX_PAYLOAD_BYTES) add(errors, 'payload_too_large')
    rejectForbiddenKeys(raw, errors)
    rejectUnknownKeys(raw, ROOT_KEYS, errors, 'unknown_root_field')
    if (Object.keys(raw).length !== ROOT_KEYS.size) add(errors, 'missing_root_field')
    if (raw.contractVersion !== ANIMATION_RUM_V2_CONTRACT_VERSION) add(errors, 'unsupported_contract_version')
    if (raw.snapshotSchemaVersion !== ANIMATION_RUM_V2_SNAPSHOT_SCHEMA_VERSION) add(errors, 'unsupported_snapshot_schema_version')
    if (!boundedString(raw.eventId, 80, ID_RE)) add(errors, 'invalid_event_id')
    if (!boundedString(raw.captureId, 80, ID_RE)) add(errors, 'invalid_capture_id')
    if (raw.scope !== 'page' && raw.scope !== 'target') add(errors, 'invalid_scope')
    if (raw.scope === 'page') {
        if (raw.parentCaptureId !== null || raw.targetKey !== null) add(errors, 'invalid_page_scope_identity')
    } else if (raw.scope === 'target') {
        if (!boundedString(raw.parentCaptureId, 80, ID_RE)) add(errors, 'invalid_parent_capture_id')
        if (raw.parentCaptureId === raw.captureId) add(errors, 'self_parent_capture')
        if (!isAnimationRumV2TargetKey(raw.targetKey)) add(errors, 'invalid_target_key')
    }
    const capturedTimestamp = canonicalUtcTimestamp(raw.capturedAt)
    const now = finiteNumber(options.nowEpochMs, 0, Number.MAX_SAFE_INTEGER) ? options.nowEpochMs : Date.now()
    if (capturedTimestamp === null) add(errors, 'invalid_captured_at')
    else if (capturedTimestamp < now - 90 * 24 * 60 * 60 * 1_000 || capturedTimestamp > now + 5 * 60 * 1_000) {
        add(errors, 'captured_at_out_of_range')
    }
    for (const [code, value] of [
        ['invalid_release', raw.release],
        ['invalid_dist', raw.dist],
        ['invalid_environment', raw.environment],
        ['invalid_sdk_version', raw.sdkVersion],
    ] as const) {
        if (!boundedString(value, 64, VERSION_RE, true)) add(errors, code)
    }
    if (!boundedString(raw.monitorVersion, 64, VERSION_RE)) add(errors, 'invalid_monitor_version')
    if (!finiteNumber(raw.sampleRate, 0.000001, 1)) add(errors, 'invalid_sample_rate')
    if (!boundedInteger(raw.samplingPolicyVersion, 255) || raw.samplingPolicyVersion < 1) add(errors, 'invalid_sampling_policy_version')

    const context = parseContext(raw.context, errors)
    const capabilities = parseCapabilities(raw.capabilities, errors)
    const coverage = parseCoverage(raw.coverage, errors)
    const providers = parseProviderEvidence(raw.providerEvidence, errors)
    const quality = parseCaptureQuality(raw.captureQuality, context, providers, errors)
    const metrics = parseMetrics(raw.metrics, raw.scope, capabilities, providers, quality, errors)
    validateMetricSemantics(metrics, errors)
    validateCoverageAgainstMetrics(coverage, metrics, errors)

    if (errors.length > 0 || !context || !capabilities || !coverage || !providers || !quality || !metrics) return { ok: false, errors }
    return { ok: true, value: raw as unknown as AnimationRumV2Report }
}
