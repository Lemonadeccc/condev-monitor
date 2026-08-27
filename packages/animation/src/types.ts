// cspell:ignore gsap

export type CapabilityState = 'supported' | 'unsupported' | 'unknown'
export type CollectorState = 'idle' | 'running' | 'stopped' | 'destroyed'
export type FrameBudgetSource = 'explicit' | 'inferred'
export type Confidence = 'high' | 'medium' | 'low'
export type VisibilityState = 'visible' | 'hidden' | 'prerender' | 'unknown'
export type AnimationInteractionKind =
    | 'transition'
    | 'drag'
    | 'scroll'
    | 'pointer'
    | 'keyboard'
    | 'load'
    | 'lifecycle'
    | 'gesture'
    | 'navigation'
    | 'custom'
export type InteractionOutcome = 'completed' | 'cancelled' | 'abandoned'
export type PerformanceSignalType = 'long-animation-frame' | 'longtask' | 'event' | 'resource'
export type AnimationPageLifecycleEvent =
    | { type: 'hidden' }
    | { type: 'visible' }
    | { type: 'pagehide'; persisted: boolean }
    | { type: 'pageshow'; persisted: boolean }

export interface DurationStatistics {
    count: number
    p50: number
    p75: number
    p95: number
    p99: number
    max: number
    total: number
}

export interface CapabilityEvidence {
    state: CapabilityState
    observed: boolean
    buffered: boolean
    reason?: string
}

export interface FrameBudget {
    frameBudgetMs: number
    expectedRefreshHz: number
    source: FrameBudgetSource
    confidence: Confidence
    sampleCount: number
}

export interface FrameSummary {
    retainedCount: number
    totalObservedCount: number
    droppedSampleCount: number
    capacity: number
    duration: DurationStatistics | null
    slowFrameThresholdMs: number
    slowFrameCount: number
    slowFrameRatio: number | null
    missedFrameOpportunities: number
}

export interface BurstSummary {
    count: number
    longestFrameCount: number
    longestDurationMs: number
    maxMissedFrameOpportunities: number
}

export interface BoundedSignalSummary {
    capability: CapabilityEvidence
    retainedCount: number | null
    totalObservedCount: number | null
    droppedSampleCount: number | null
    /** One-shot evidence that buffered Performance Timeline history was incomplete; not an exact live-loss count. */
    performanceObserverDroppedEntryCount?: number | null
    capacity: number
    /** Scalar aggregation across all observed entries, including samples evicted from the ring. */
    totalDurationMs: number | null
    duration: DurationStatistics | null
}

export interface LongAnimationFramePaintTimingSummary {
    /** Whether accepted LoAF entries expose PaintTimingMixin.paintTime. */
    paintTimeCapability: CapabilityEvidence
    /** Whether accepted LoAF entries expose nullable PaintTimingMixin.presentationTime. */
    presentationTimeCapability: CapabilityEvidence
    /** Accepted LoAF entries that expose paintTime; null when no entry could establish field support. */
    paintTimeExposedCount: number | null
    /** Accepted LoAF entries that expose presentationTime; null when no entry could establish field support. */
    presentationTimeExposedCount: number | null
    /** Complete renderStart → paintTime samples across the full bounded stream. */
    renderStartToPaintTotalObservedCount: number | null
    /** Complete paintTime → presentationTime samples across the full bounded stream. */
    paintToPresentationTotalObservedCount: number | null
    /** renderStart → paintTime for retained, complete LoAF entries only. */
    renderStartToPaintDuration: DurationStatistics | null
    /** paintTime → presentationTime for retained, complete LoAF entries only. */
    paintToPresentationDuration: DurationStatistics | null
}

export interface LongAnimationFrameSummary extends BoundedSignalSummary {
    blockingDuration: DurationStatistics | null
    /** Interval from styleAndLayoutStart through the LoAF end; includes subsequent rendering work. */
    styleAndLayoutTailDuration: DurationStatistics | null
    /** Additive local-only PaintTimingMixin evidence; never projected as animation_rum v1 metric tuples. */
    paintTiming?: LongAnimationFramePaintTimingSummary
}

export interface EventTimingSummary extends BoundedSignalSummary {
    inputDelay: DurationStatistics | null
    processingDuration: DurationStatistics | null
    presentationDelay: DurationStatistics | null
    presentationDelayCapability: CapabilityEvidence
}

/**
 * Explicit host evidence for continuous interactions. Browsers cannot infer
 * semantic visual progress, controller ownership, or spring settling from
 * Event Timing alone, so callers record only the fields they can prove.
 */
export interface InteractionQualitySample {
    inputToVisualMs?: number
    pointerSampleAgeMs?: number
    coalescedEventsAvailable?: number
    coalescedEventsConsumed?: number
    progressError?: number
    intendedProgress?: number
    visualProgress?: number
    domWebglAlignmentErrorPx?: number
    controlWritersPerFrame?: number
    settleTimeMs?: number
    overshootRatio?: number
    oscillationCount?: number
}

export interface InteractionQualitySummary {
    status: Extract<InteractionWindowStatus, 'measured' | 'partial' | 'not-observed'>
    acceptedSampleCount: number
    retainedSampleCount: number
    droppedSampleCount: number
    rejectedSampleCount: number
    capacity: number
    inputToVisual: DurationStatistics | null
    pointerSampleAge: DurationStatistics | null
    progressError: DurationStatistics | null
    domWebglAlignmentError: DurationStatistics | null
    controlWritersPerFrame: DurationStatistics | null
    controllerConflictSampleCount: number
    settleTime: DurationStatistics | null
    overshootRatio: DurationStatistics | null
    oscillationCount: DurationStatistics | null
    coalescedEventsAvailable: number
    coalescedEventsConsumed: number
    coalescedEventUtilization: number | null
}

export interface InteractionMeasurement {
    id: string
    kind: AnimationInteractionKind
    label: string
    startedAt: number
    endedAt: number
    durationMs: number
    outcome: InteractionOutcome
    performance: InteractionPerformanceSummary
}

export interface ActiveInteractionMeasurement {
    id: string
    kind: AnimationInteractionKind
    label: string
    startedAt: number
    capturedAt: number
    durationMs: number
    performance: InteractionPerformanceSummary
}

export type InteractionWindowStatus = 'measured' | 'partial' | 'not-observed' | 'unsupported' | 'unknown'

export interface InteractionFrameWindowSummary {
    status: InteractionWindowStatus
    retainedCount: number
    duration: DurationStatistics | null
    slowFrameCount: number
    slowFrameRatio: number | null
    missedFrameOpportunities: number
    bursts: BurstSummary
}

export interface InteractionSignalWindowSummary {
    status: InteractionWindowStatus
    overlapCount: number | null
    overlapDurationMs: number | null
    duration: DurationStatistics | null
}

export type AnimationInputDispatchKind = 'pointer' | 'keyboard' | 'click'

export type InputFrameSchedulingStatus = 'measured' | 'partial' | 'not-observed' | 'not-instrumented'

/**
 * Local scheduling evidence from an input capture-listener entry to the next
 * main-thread rAF callback entry. This is not paint, presentation, a visual
 * update, or GPU completion evidence.
 */
export interface InputFrameSchedulingSummary {
    version: 1
    status: InputFrameSchedulingStatus
    retainedCount: number
    totalObservedCount: number
    droppedSampleCount: number
    cancelledSampleCount: number
    pendingCount: number
    capacity: number
    duration: DurationStatistics | null
    byKind: Record<AnimationInputDispatchKind, number>
}

export interface InteractionInputFrameSchedulingSummary {
    status: InputFrameSchedulingStatus
    retainedCount: number
    totalObservedCount: number
    droppedSampleCount: number
    cancelledSampleCount: number
    pendingCount: number
    duration: DurationStatistics | null
}

/** Opaque one-shot marker used to associate a captured input with its SDK interaction. */
export interface InputFrameSchedulingMarker {
    readonly accepted: boolean
    associateInteraction(interactionId: string): boolean
}

/** Browser-owned low-level recorder; it retains no Event or DOM data. */
export interface InputFrameSchedulingRecorder {
    record(kind: AnimationInputDispatchKind): InputFrameSchedulingMarker | null
    dispose(): void
}

export interface InteractionPerformanceSummary {
    frames: InteractionFrameWindowSummary
    longAnimationFrames: InteractionSignalWindowSummary
    longTasks: InteractionSignalWindowSummary
    eventTiming: InteractionSignalWindowSummary
    /** Additive local-only field; absent in snapshots produced before this probe existed. */
    inputFrameScheduling?: InteractionInputFrameSchedulingSummary
    quality: InteractionQualitySummary
}

export interface InteractionSummary {
    retainedCount: number
    totalObservedCount: number
    droppedSampleCount: number
    capacity: number
    activeCount: number
    completedCount: number
    cancelledCount: number
    abandonedCount: number
    duration: DurationStatistics | null
    byKind: Record<AnimationInteractionKind, number>
    active: readonly ActiveInteractionMeasurement[]
    recent: readonly InteractionMeasurement[]
}

export interface VisibilitySummary {
    initial: VisibilityState
    current: VisibilityState
    transitionCount: number
    hiddenTransitionCount: number
    visibleTransitionCount: number
    reducedMotion: boolean | null
    reducedMotionChangeCount: number
}

export type CaptureSufficiencyReason =
    | 'visible-window-too-short'
    | 'insufficient-frame-samples'
    | 'frame-buffer-truncated'
    | 'refresh-confidence-low'

export interface CaptureSufficiencySummary {
    status: 'sufficient' | 'insufficient'
    reasons: readonly CaptureSufficiencyReason[]
    minimumVisibleDurationMs: number
    minimumFrameSamples: number
    visibleDurationMs: number
    hiddenDurationMs: number
    otherDurationMs: number
    retainedFrameSamples: number
    totalObservedFrameSamples: number
    frameSamplesTruncated: boolean
    refreshConfidence: Confidence
}

export type AnimationWebVitalName = 'CLS' | 'INP' | 'LCP'
export type AnimationWebVitalRating = 'good' | 'needs-improvement' | 'poor'
export type AnimationWebVitalNavigationType = 'navigate' | 'reload' | 'back-forward' | 'back-forward-cache' | 'prerender' | 'restore'

interface AnimationWebVitalBase<Name extends AnimationWebVitalName, Attribution> {
    name: Name
    value: number
    delta: number
    rating: AnimationWebVitalRating
    navigationType: AnimationWebVitalNavigationType
    attribution: Readonly<Attribution>
}

export type AnimationWebVitalMeasurement =
    | AnimationWebVitalBase<
          'CLS',
          {
              largestShiftTime?: number
              largestShiftValue?: number
              loadState?: 'loading' | 'dom-interactive' | 'dom-content-loaded' | 'complete'
          }
      >
    | AnimationWebVitalBase<
          'INP',
          {
              interactionTime?: number
              nextPaintTime?: number
              interactionType?: 'pointer' | 'keyboard'
              inputDelay?: number
              processingDuration?: number
              presentationDelay?: number
              loadState?: 'loading' | 'dom-interactive' | 'dom-content-loaded' | 'complete'
          }
      >
    | AnimationWebVitalBase<
          'LCP',
          { timeToFirstByte?: number; resourceLoadDelay?: number; resourceLoadDuration?: number; elementRenderDelay?: number }
      >

export interface AnimationWebVitalsSummary {
    capability: CapabilityEvidence
    /** Web Vitals span the document/navigation lifetime, not this collector window. */
    scope: 'document-lifetime'
    observedUpdateCount: number | null
    latest: {
        CLS: Extract<AnimationWebVitalMeasurement, { name: 'CLS' }> | null
        INP: Extract<AnimationWebVitalMeasurement, { name: 'INP' }> | null
        LCP: Extract<AnimationWebVitalMeasurement, { name: 'LCP' }> | null
    }
}

export type AnimationResourceCategory = 'script' | 'image' | 'media' | 'fetch-xhr' | 'link-css' | 'frame' | 'other'

export interface AnimationResourceCategorySummary {
    totalObservedCount: number | null
    totalDurationMs: number | null
    transferSizeBytes: number | null
    encodedBodySizeBytes: number | null
    decodedBodySizeBytes: number | null
    zeroTransferSizeCount: number | null
    duration: DurationStatistics | null
}

/** Capture-window Resource Timing aggregates. Resource names and URLs are never retained. */
export interface AnimationResourceTimingSummary {
    capability: CapabilityEvidence
    bufferEventCapability: CapabilityEvidence
    scope: 'capture-window'
    retainedCount: number | null
    totalObservedCount: number | null
    droppedSampleCount: number | null
    /** One-shot evidence that buffered Performance Timeline history was incomplete; not an exact live-loss count. */
    performanceObserverDroppedEntryCount?: number | null
    rejectedEntryCount: number | null
    bufferFullEventCount: number | null
    excludedPreCaptureCount: number | null
    capacity: number
    totalDurationMs: number | null
    transferSizeBytes: number | null
    encodedBodySizeBytes: number | null
    decodedBodySizeBytes: number | null
    zeroTransferSizeCount: number | null
    duration: DurationStatistics | null
    categories: Readonly<Record<AnimationResourceCategory, AnimationResourceCategorySummary>>
}

export interface AnimationHostEvidenceWindow {
    startedAt: number | null
    endedAt: number | null
    durationMs: number | null
}

export interface AnimationHostEvidenceFamilySummary {
    acceptedSampleCount: number
    retainedSampleCount: number
    droppedSampleCount: number
    rejectedSampleCount: number
    /** Samples containing at least one usable numeric measurement. */
    evidenceSampleCount: number
    /** Usable numeric samples still present in the bounded retained tail. */
    retainedEvidenceSampleCount: number
    capacity: number
    truncated: boolean
    /** Percentiles and categorical detail below are computed from the retained bounded tail. */
    detailScope: 'retained-samples'
    /** Full accepted-sample observation window, including samples later evicted from the ring. */
    acceptedWindow: AnimationHostEvidenceWindow
    /** Window represented by the currently retained bounded tail. */
    window: AnimationHostEvidenceWindow
}

export interface AnimationHostFrameworkSummary extends AnimationHostEvidenceFamilySummary {
    frameworks: readonly AnimationUiFramework[]
    phases: Readonly<Record<'mount' | 'update' | 'nested-update' | 'hydrate' | 'other', number>>
    renderMs: DurationStatistics | null
    commitMs: DurationStatistics | null
    baseRenderMs: DurationStatistics | null
}

export interface AnimationHostRendererSummary extends AnimationHostEvidenceFamilySummary {
    backends: readonly ('canvas2d' | 'webgl' | 'webgl2' | 'webgpu' | 'unknown')[]
    /** Backends attached to retained samples with at least one usable measurement. */
    evidenceBackends: readonly ('canvas2d' | 'webgl' | 'webgl2' | 'webgpu' | 'unknown')[]
    drawCalls: DurationStatistics | null
    triangles: DurationStatistics | null
    lines: DurationStatistics | null
    points: DurationStatistics | null
    geometries: DurationStatistics | null
    textures: DurationStatistics | null
    programs: DurationStatistics | null
    gpuFrameMs: DurationStatistics | null
    gpuMeasuredSampleCount: number
    gpuRejectedSampleCount: number
}

export interface AnimationHostLifecycleSummary extends AnimationHostEvidenceFamilySummary {
    checkpoints: Readonly<Record<'mount' | 'after-interaction' | 'unmount' | 'manual', number>>
    measuredAnimationSampleCount: number
    measuredScrollTriggerSampleCount: number
    latestAnimationTotal: number | null
    latestActiveAnimationCount: number | null
    latestScrollTriggerTotal: number | null
    rejectedActiveCheckCount: number
    /** A leak verdict needs repeated equivalent cycles; raw checkpoints alone cannot prove one. */
    growthCandidate: null
}

export interface AnimationHostWorkSummary extends AnimationHostEvidenceFamilySummary {
    workMs: DurationStatistics | null
    categories: Readonly<Record<'script' | 'layout' | 'paint' | 'composite' | 'other', number>>
}

export interface AnimationHostMediaSummary extends AnimationHostEvidenceFamilySummary {
    callbackIntervalMs: DurationStatistics | null
    mediaTimeDeltaMs: DurationStatistics | null
    presentedFramesDelta: DurationStatistics | null
    displayLatenessMs: DurationStatistics | null
    processingDurationMs: DurationStatistics | null
    totalVideoFramesDelta: number | null
    droppedVideoFramesDelta: number | null
    corruptedVideoFramesDelta: number | null
    playbackDropRatio: number | null
    playbackQualityMeasuredSampleCount: number
    /** Retained-tail status counts. Optional for snapshots produced before playback capability projection. */
    playbackQualityUnsupportedSampleCount?: number
    playbackQualityErrorSampleCount?: number
}

/** Bounded, local-only evidence from explicit framework, renderer, lifecycle, work, and media probes. */
export interface AnimationHostEvidenceSummary {
    scope: 'capture-window-local'
    framework: AnimationHostFrameworkSummary
    renderer: AnimationHostRendererSummary
    lifecycle: AnimationHostLifecycleSummary
    work: AnimationHostWorkSummary
    media: AnimationHostMediaSummary
}

export interface MonitorOverheadSummary {
    callbackCount: number
    retainedCount: number
    droppedSampleCount: number
    /** Scalar aggregation across every measured callback, including samples evicted from the ring. */
    totalCallbackDurationMs: number
    duration: DurationStatistics | null
    p95FrameBudgetRatio: number | null
    reportBuildDuration: DurationStatistics | null
    reportBuildRetainedCount: number
    reportBuildDroppedSampleCount: number
}

export interface AnimationSnapshot {
    schemaVersion: 1
    captureId: string
    state: 'running' | 'stopped'
    startedAt: number
    capturedAt: number
    elapsedMs: number
    frameBudget: FrameBudget
    frames: FrameSummary
    bursts: BurstSummary
    longAnimationFrames: LongAnimationFrameSummary
    longTasks: BoundedSignalSummary
    eventTiming: EventTimingSummary
    /** Additive local-only field; never projected into animation_rum v1. */
    inputFrameScheduling?: InputFrameSchedulingSummary
    interactions: InteractionSummary
    visibility: VisibilitySummary
    captureSufficiency: CaptureSufficiencySummary
    webVitals: AnimationWebVitalsSummary
    resourceTiming: AnimationResourceTimingSummary
    hostEvidence: AnimationHostEvidenceSummary
    monitorOverhead: MonitorOverheadSummary
    capabilities: AnimationRumCapabilities
    coverage: AnimationRumCoverage
}

export interface SanitizedPerformanceEntry {
    duration: number
    startTime?: number
    blockingDuration?: number
    renderStart?: number
    styleAndLayoutStart?: number
    /** Missing means the LoAF entry did not expose the field; null means exposed without a usable timestamp. */
    paintTime?: number | null
    /** Missing means the LoAF entry did not expose the field; null is a valid unavailable value in the platform API. */
    presentationTime?: number | null
    processingStart?: number
    processingEnd?: number
    interactionId?: number
    resourceInitiatorType?: string
    responseEnd?: number
    transferSize?: number
    encodedBodySize?: number
    decodedBodySize?: number
}

export interface PerformanceObserverHandle {
    state: CapabilityState
    buffered: boolean
    reason?: string
    /** Dynamic while connected; frozen at the last known value after disconnect. */
    readonly droppedEntriesCount?: number | null
    disconnect(): void
}

export interface AnimationRuntime {
    readonly isBrowser: boolean
    readonly frameCapability?: CapabilityState
    now(): number
    wallNow?(): number
    subscribeFrames(callback: (timestamp: number) => void): () => void
    getVisibilityState(): VisibilityState
    onVisibilityChange(callback: (state: VisibilityState) => void): () => void
    onPageLifecycle?(callback: (event: AnimationPageLifecycleEvent) => void, options?: { priority?: number }): () => void
    onResourceTimingBufferFull?(callback: () => void): PerformanceObserverHandle
    getReducedMotion(): boolean | null
    onReducedMotionChange(callback: (reduced: boolean) => void): () => void
    /** Optional process-wide document-lifetime Web Vitals stream. */
    subscribeWebVitals?(callback: (metric: AnimationWebVitalMeasurement) => void): () => void
    /** Synchronously delivers browser observer records queued before a report boundary. */
    drainPendingPerformanceEntries?(): void
    observePerformance(
        type: PerformanceSignalType,
        callback: (entries: readonly SanitizedPerformanceEntry[]) => void
    ): PerformanceObserverHandle
}

export interface AnimationCollectorOptions {
    maxFrames?: number
    maxInteractions?: number
    maxSignalEntries?: number
    maxResourceEntries?: number
    maxHostEvidenceSamples?: number
    maxInteractionQualitySamples?: number
    /** Bounded local input-dispatch → next-rAF callback proxy samples. */
    maxInputFrameSchedulingSamples?: number
    explicitRefreshHz?: number
    slowFrameFactor?: number
    inferenceMinimumSamples?: number
    runtime?: AnimationRuntime
}

export interface InteractionHandle {
    readonly id: string
    readonly kind: AnimationInteractionKind
    end(): InteractionMeasurement
    cancel(): InteractionMeasurement
}

/** Handle returned by this collector; the base handle remains compatible with existing wrappers. */
export interface AnimationInteractionHandle extends InteractionHandle {
    /** Returns false when the sample is invalid or the interaction has ended. */
    recordQuality(sample: InteractionQualitySample): boolean
}

export type AnimationElementSelectionMode = 'self' | 'subtree'
export type AnimationElementSelectionState = 'selected' | 'recording' | 'disconnected' | 'cleared'
export type AnimationTargetAttributionRelation =
    | 'direct-element'
    | 'direct-subtree'
    | 'temporal-overlap'
    | 'framework-owner'
    | 'renderer-host'

export type AnimationPropertyImpact = 'compositor-candidate' | 'layout-candidate' | 'paint-candidate' | 'unknown'

export interface AnimationPropertySummary {
    compositorCandidate: readonly string[]
    layoutCandidate: readonly string[]
    paintCandidate: readonly string[]
    unknown: readonly string[]
}

export interface AnimationElementLifecycleSummary {
    animationStartCount: number
    animationEndCount: number
    animationCancelCount: number
    transitionRunCount: number
    transitionEndCount: number
    transitionCancelCount: number
}

export interface AnimationElementAnimationSummary {
    capability: CapabilityEvidence
    relation: 'direct-element' | 'direct-subtree'
    totalCount: number | null
    inspectedCount: number | null
    droppedAnimationCount: number | null
    runningCount: number | null
    pausedCount: number | null
    finishedCount: number | null
    idleCount: number | null
    pendingCount: number | null
    cssAnimationCount: number | null
    cssTransitionCount: number | null
    webAnimationCount: number | null
    infiniteCount: number | null
    duration: DurationStatistics | null
    delay: DurationStatistics | null
    playbackRate: DurationStatistics | null
    properties: AnimationPropertySummary
    propertyTruncated: boolean | null
    lifecycle: AnimationElementLifecycleSummary
}

export interface AnimationElementGeometrySummary {
    capability: CapabilityEvidence
    width: number | null
    height: number | null
    cssPixelArea: number | null
    viewportIntersectionRatio: number | null
    /** Distinct size changes observed after the selection baseline. */
    resizeCount: number
    /** Resize samples where the CSS box changed. */
    cssResizeCount: number
    /** Resize samples where a Canvas backing-store dimension changed. */
    backingResizeCount: number
    backingWidth: number | null
    backingHeight: number | null
    backingPixelArea: number | null
    backingScaleX: number | null
    backingScaleY: number | null
    backingAspectRatioMismatch: boolean | null
    /** Geometric mean of backingScaleX/Y, retained for compatibility. */
    effectivePixelRatio: number | null
}

export type AnimationUiFramework = 'vanilla' | 'react' | 'preact' | 'vue' | 'angular' | 'svelte' | 'solid' | 'qwik' | 'lit' | 'other'
export type AnimationMetaRuntime = 'next' | 'nuxt' | 'sveltekit' | 'astro' | 'remix' | 'other'
export type AnimationRendererFamily = 'dom' | 'svg' | 'canvas' | 'canvas2d' | 'webgl' | 'webgl2' | 'webgpu' | 'other'
export type AnimationMotionEngine = 'css' | 'waapi' | 'gsap' | 'motion' | 'anime' | 'lenis' | 'other'

export interface AnimationTargetRuntimeInventory {
    uiFrameworks: readonly AnimationUiFramework[]
    metaRuntimes: readonly AnimationMetaRuntime[]
    renderers: readonly AnimationRendererFamily[]
    motionEngines: readonly AnimationMotionEngine[]
}

/** Local-only attribution. It is intentionally absent from the production RUM v1 contract. */
export interface AnimationTargetOwnerAttribution {
    adapterId: string
    adapterVersion: string
    relation: 'framework-owner' | 'renderer-host'
    framework?: AnimationUiFramework
    label?: string
    source?: { file: string; line?: number; column?: number }
}

export interface AnimationRendererMetrics {
    cpuFrameMsP95: number | null
    gpuFrameMsP95: number | null
    drawCallsP95: number | null
    trianglesP95: number | null
    pointsP95: number | null
    linesP95: number | null
    programs: number | null
    geometries: number | null
    textures: number | null
    renderTargets: number | null
    renderTargetPixels: number | null
    uploadBytes: number | null
    readbackMsP95: number | null
    contextLossCount: number | null
}

export type AnimationGpuTimingSource = 'webgl-timer-query' | 'webgpu-timestamp-query' | 'host-summary' | 'unknown'

export type AnimationGpuTimingRejectionReason =
    | 'not-reported'
    | 'metric-invalid'
    | 'validity-unknown'
    | 'timer-invalid'
    | 'timer-disjoint'
    | 'context-lost'
    | 'source-unknown'
    | 'backend-source-mismatch'

export interface AnimationTargetRendererEvidenceWindow {
    startedAt: number | null
    endedAt: number | null
    durationMs: number | null
}

export interface AnimationTargetRendererGpuEvidence {
    valid: boolean | null
    disjoint: boolean | null
    contextLost: boolean | null
    source: AnimationGpuTimingSource
    /** Null only when gpuFrameMsP95 passed every fail-closed validity check. */
    rejectionReason: AnimationGpuTimingRejectionReason | null
}

/** Normalized, bounded renderer evidence in a local target snapshot. */
export interface AnimationTargetRendererEvidence {
    window: AnimationTargetRendererEvidenceWindow
    acceptedSampleCount: number | null
    retainedSampleCount: number | null
    droppedSampleCount: number | null
    rejectedSampleCount: number | null
    truncated: boolean | null
    gpu: AnimationTargetRendererGpuEvidence
}

export interface AnimationTargetRendererInspection {
    adapterId: string
    adapterVersion: string
    family: AnimationRendererFamily
    capability: CapabilityEvidence
    metrics: AnimationRendererMetrics
    evidence: AnimationTargetRendererEvidence
}

export type AnimationTargetAdapterOwnerInspection = Omit<AnimationTargetOwnerAttribution, 'adapterId' | 'adapterVersion'>

export interface AnimationTargetAdapterRendererEvidence {
    /**
     * Bounds in the same `AnimationRuntime.now()` clock domain as the target
     * collector. In a normal document this means `performance.now()`, never a
     * separately chosen epoch timestamp, GPU tick, Three Clock value, or
     * another realm's clock.
     * Provide both endpoints whenever retained samples or metrics are reported.
     */
    window?: {
        startedAt?: number
        endedAt?: number
    }
    acceptedSampleCount?: number
    retainedSampleCount?: number
    droppedSampleCount?: number
    rejectedSampleCount?: number
    truncated?: boolean
    gpu?: {
        valid?: boolean
        disjoint?: boolean
        contextLost?: boolean
        source?: AnimationGpuTimingSource
    }
}

export interface AnimationTargetAdapterRendererInspection {
    family: AnimationRendererFamily
    capability: CapabilityEvidence
    metrics?: Partial<AnimationRendererMetrics>
    /**
     * Optional only for not-observed/backward-compatible adapters. An observed
     * renderer must provide a complete, capture-contained window; snapshots
     * always expose the normalized form and RUM revalidates it independently.
     */
    evidence?: AnimationTargetAdapterRendererEvidence
}

/**
 * Optional framework/renderer enrichment. The browser-native element evidence
 * remains available when no adapter can inspect the target.
 */
export interface AnimationTargetAdapter {
    readonly id: string
    readonly version: string
    canInspect(element: Element): boolean
    inspect(element: Element): AnimationTargetAdapterInspection | null
}

export interface AnimationTargetAdapterInspection {
    inventory?: Partial<AnimationTargetRuntimeInventory>
    owners?: readonly AnimationTargetAdapterOwnerInspection[]
    renderer?: AnimationTargetAdapterRendererInspection
}

export interface AnimationTargetAdapterRegistry {
    readonly adapter: AnimationTargetAdapter
    register(element: Element, inspect: () => AnimationTargetAdapterInspection | null): () => void
    unregister(element: Element): void
}

export interface AnimationElementSelectionOptions {
    mode?: AnimationElementSelectionMode
    adapters?: readonly AnimationTargetAdapter[]
}

export interface AnimationElementSelectionSnapshot {
    schemaVersion: 1
    selectionId: string
    state: Exclude<AnimationElementSelectionState, 'cleared'>
    selectedAt: number
    capturedAt: number
    elapsedMs: number
    /** Bounded local descriptor; never projected into animation_rum v1. */
    localDescriptor: {
        tagName: string
        role: string | null
        mode: AnimationElementSelectionMode
        connected: boolean
    }
    direct: AnimationElementAnimationSummary
    geometry: AnimationElementGeometrySummary
    inventory: AnimationTargetRuntimeInventory
    owners: readonly AnimationTargetOwnerAttribution[]
    renderers: readonly AnimationTargetRendererInspection[]
    activeInteractionId: string | null
    correlated: InteractionPerformanceSummary | null
    correlationRelation: 'temporal-overlap' | null
    /** Duration of the completed interaction represented by `correlated`; never the selection lifetime. */
    correlatedDurationMs?: number | null
    /**
     * SDK-owned `AnimationRuntime.now()` boundaries for the completed
     * interaction represented by `correlated`; never adapter-supplied.
     */
    correlatedWindow?: {
        startedAt: number
        endedAt: number
        durationMs: number
    } | null
    adapterErrors: readonly string[]
}

export interface AnimationElementSelectionHandle {
    readonly id: string
    /** Runtime-only reference. It is never included in snapshots or RUM. */
    readonly element: Element
    readonly state: AnimationElementSelectionState
    beginInteraction(kind: AnimationInteractionKind, label?: string): AnimationInteractionHandle
    snapshot(): AnimationElementSelectionSnapshot
    clear(): void
}

export type AnimationElementPickerState = 'idle' | 'picking' | 'selected' | 'destroyed'

export interface AnimationElementPickerOptions {
    document?: Document
    exclude?: (element: Element) => boolean
    onSelect(element: Element): void
    onCancel?(): void
    onStateChange?(state: AnimationElementPickerState): void
}

export interface AnimationElementPicker {
    readonly state: AnimationElementPickerState
    start(): boolean
    cancel(): void
    destroy(): void
}

export interface AnimationRumOptions {
    enabled?: boolean
    sampleRate?: number
    sampleKey?: string
    seed?: string
    policyVersion?: number
}

export interface AnimationIntegrationOptions extends AnimationCollectorOptions {
    autoStart?: boolean
    rum?: AnimationRumOptions
    context?: {
        /** A caller-supplied, already-redacted route identifier; never a raw URL. */
        routeKey?: string
        /** A caller-supplied release identifier. */
        release?: string
        dist?: string
        environment?: string
        sdkVersion?: string
        runtimeFamily?: AnimationRuntimeFamily
    }
}

export type AnimationRumFamily =
    | 'userOutcome'
    | 'frameCadence'
    | 'mainThread'
    | 'renderingPipeline'
    | 'renderer'
    | 'scrollGesture'
    | 'resourcesMedia'
    | 'memoryLifecycle'
    | 'workAvoidance'
    | 'accessibility'
    | 'motionQuality'
    | 'monitorOverhead'

export type AnimationCoverageStatus = 'measured' | 'partial' | 'not-observed' | 'not-instrumented' | 'unsupported'
export type AnimationMetricStatus = AnimationCoverageStatus | 'unknown'
export type AnimationEvidenceLevel =
    | 'field-measurement'
    | 'controlled-lab-measurement'
    | 'runtime-observation'
    | 'static-candidate'
    | 'unsupported-or-unknown'
export type AnimationRuntimeFamily =
    | 'vanilla'
    | 'react'
    | 'vue'
    | 'svelte'
    | 'solid'
    | 'angular'
    | 'three'
    | 'babylon'
    | 'pixi'
    | 'gsap'
    | 'motion'
    | 'unknown'

export type AnimationCapabilityName =
    | 'long-animation-frame'
    | 'longtask'
    | 'event'
    | 'resourceTiming'
    | 'resourceTimingBufferEvents'
    | 'webVitalsAttribution'
    | 'webVitalsSoftNavigation'
    | 'webVitalsDisabled'
    | 'reducedMotionPreference'
    | 'documentAnimationsInspection'
    | 'visibilityLifecycle'
    | 'longAnimationFramePaintTime'
    | 'longAnimationFramePresentationTime'

export type AnimationRumCapabilities = Record<AnimationCapabilityName, boolean | null>
export type AnimationRumCoverage = Record<AnimationRumFamily, { status: AnimationCoverageStatus; evidenceLevel: AnimationEvidenceLevel }>

export interface AnimationRumMetric {
    family: AnimationRumFamily
    name: AnimationRumMetricName
    stat: 'latest' | 'count' | 'sum' | 'avg' | 'min' | 'max' | 'p50' | 'p75' | 'p95' | 'p99' | 'rate' | 'ratio'
    unit: 'ms' | 'count' | 'ratio' | 'bytes' | 'pixels' | 'hz' | 'frames' | 'percent'
    value: number | null
    samples: number | null
    status: AnimationMetricStatus
}

export type AnimationRumMetricName =
    | 'frameDurationMs'
    | 'targetFrameMs'
    | 'inferredRefreshHz'
    | 'slowFrameRate'
    | 'jankBurstCount'
    | 'longestSlowFrameRun'
    | 'missedFrameOpportunities'
    | 'longAnimationFrameCount'
    | 'longAnimationFrameDurationMs'
    | 'longAnimationFrameBlockingMs'
    | 'longAnimationFrameStyleLayoutTailMs'
    | 'longTaskCount'
    | 'longTaskDurationMs'
    | 'eventTimingDurationMs'
    | 'inputDelayMs'
    | 'processingDurationMs'
    | 'presentationDelayMs'
    | 'interactionCount'
    | 'interactionDurationMs'
    | 'completedInteractions'
    | 'cancelledInteractions'
    | 'abandonedInteractions'
    | 'callbackCount'
    | 'callbackSelfTimeRatio'
    | 'reportBuildSelfTimeMs'

export interface AnimationRumContext {
    routeKey?: string
    runtimeFamily?: AnimationRuntimeFamily
    /** Capture duration used for downstream rate calculations, capped at seven days on the wire. */
    windowDurationMs: number
    /** True when the local capture exceeded the wire duration bound. */
    windowDurationCapped: boolean
    visibilityState?: VisibilityState
    reducedMotion?: boolean | null
    refreshHz?: number | null
    refreshBudgetSource?: FrameBudgetSource | 'observed' | 'unknown'
    refreshBudgetConfidence?: Confidence | 'explicit' | 'unknown'
}

export interface AnimationRumSummary {
    contractVersion: 1
    snapshotSchemaVersion: 1
    eventId: string
    captureId: string
    capturedAt: string
    release: string
    dist: string
    environment: string
    sdkVersion: string
    monitorVersion: string
    sampleRate: number
    samplingPolicyVersion: number
    context: AnimationRumContext
    capabilities: AnimationRumCapabilities
    coverage: AnimationRumCoverage
    metrics: readonly AnimationRumMetric[]
}

export interface AnimationRumEnvelope extends AnimationRumSummary, Record<string, unknown> {
    event_type: 'animation_rum'
    message: ''
}

export type AnimationOverlayLocale = 'en' | 'zh-CN'
export type AnimationOverlayLocalePreference = AnimationOverlayLocale | 'auto'

export interface AnimationOverlayOptions {
    refreshIntervalMs?: number
    production?: boolean
    document?: Document
    /** Starts with the details panel expanded. Defaults to false. */
    initiallyOpen?: boolean
    /** Initial UI locale. `auto` reads the injected document/browser language. Defaults to `auto`. */
    locale?: AnimationOverlayLocalePreference
    /** Native target scope used by the one-shot element picker. Defaults to `subtree`. */
    targetSelectionMode?: AnimationElementSelectionMode
    /** Optional framework or renderer enrichments. The native target report works without them. */
    targetAdapters?: readonly AnimationTargetAdapter[]
}

export interface AnimationOverlay {
    readonly mounted: boolean
    readonly refreshIntervalMs: number
    readonly expanded: boolean
    readonly targetState: AnimationElementPickerState | AnimationElementSelectionState
    setExpanded(expanded: boolean): void
    toggle(): void
    startTargetPicker(): boolean
    clearTarget(): void
    refresh(): void
    destroy(): void
}

export type RecommendationConfidence = 'high' | 'medium' | 'low'
export type RecommendationTargetKind = 'standard' | 'project-budget'

export interface AnimationRecommendation {
    id: string
    family: AnimationRumFamily
    evidence: AnimationEvidenceLevel
    confidence: RecommendationConfidence
    metric: {
        name: string
        value: number
        unit: AnimationRumMetric['unit']
        samples: number
    }
    target: {
        kind: RecommendationTargetKind
        comparator: '<=' | '>' | '='
        value: number
        unit: AnimationRumMetric['unit']
    }
    why: string
    actions: readonly string[]
    expectedDirection: 'increase' | 'decrease' | 'hold'
    After: 'proposed'
    rerunProtocol: readonly string[]
    regressionChecks: readonly string[]
}

export interface AnimationRecommendationOptions {
    frameTailBudgetMs?: number
    longTaskBudgetMs?: number
    styleAndLayoutTailBudgetMs?: number
    eventPhaseBudgetMs?: number
    /** Project investigation budgets for explicit continuous-interaction evidence. */
    inputToVisualBudgetMs?: number
    pointerSampleAgeBudgetMs?: number
    progressErrorBudget?: number
    domWebglAlignmentErrorBudgetPx?: number
    controlWritersPerFrameBudget?: number
    settleTimeBudgetMs?: number
    overshootRatioBudget?: number
    coalescedEventUtilizationBudget?: number
    callbackSelfTimeRatioBudget?: number
    targetKind?: RecommendationTargetKind
    /** Optional evidence from an explicit lifecycle adapter; never inferred from observer delivery time. */
    adapterEvidence?: {
        hiddenWorkSamples?: { value: number; samples: number }
        reducedMotionViolations?: { value: number; samples: number }
    }
}
