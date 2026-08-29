import type {
    AnimationElementSelectionSnapshot,
    AnimationRumFamily,
    AnimationSnapshot,
    CapabilityEvidence,
    DurationStatistics,
    InteractionQualitySummary,
} from '../types'

// cspell:ignore rvfc

export type AnimationRumV2CapabilityState = 'supported' | 'unsupported' | 'unknown' | 'disabled'
export type AnimationRumV2MetricStatus = 'measured' | 'partial' | 'not-observed' | 'not-instrumented' | 'unsupported' | 'unknown'
export type AnimationRumV2Relation = 'page-window' | 'target-direct' | 'target-temporal-overlap' | 'adapter'
export type AnimationRumV2ProviderOwner =
    | 'browser-core'
    | 'web-vitals-runtime'
    | 'resource-timing'
    | 'browser-page-evidence'
    | 'input-scheduling'
    | 'media-adapter'
    | 'media-stage-adapter'
    | 'renderer-adapter'
    | 'target-sidecar'
export type AnimationRumV2QualityReason =
    | 'adapter-error'
    | 'insufficient-frame-samples'
    | 'provider-rejected-samples'
    | 'provider-truncated'
    | 'refresh-confidence-low'
    | 'source-field-incomplete'
    | 'visible-window-too-short'
    | 'window-capped'

export type AnimationRumV2CapabilityName =
    | 'long-animation-frame'
    | 'longtask'
    | 'event-timing'
    | 'resource-timing'
    | 'resource-timing-buffer-events'
    | 'web-vitals'
    | 'web-vitals-attribution'
    | 'web-vitals-soft-navigation'
    | 'reduced-motion-preference'
    | 'document-animations-inspection'
    | 'visibility-lifecycle'
    | 'loaf-paint-time'
    | 'loaf-presentation-time'
    | 'input-frame-scheduling'
    | 'page-evidence'
    | 'canvas-context-registry'
    | 'video-frame-callback'
    | 'video-playback-quality'
    | 'framework-adapter'
    | 'renderer-adapter'
    | 'media-adapter'
    | 'target-direct-inspection'
    | 'interaction-quality-adapter'
    | 'gpu-timer-query'
    | 'media-stage-attestation'

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

export type AnimationRumV2RuntimeFramework =
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
export type AnimationRumV2RuntimeRenderer = 'dom' | 'svg' | 'canvas' | 'mixed' | 'other' | 'unknown'
export type AnimationRumV2RuntimeBackend = 'dom' | 'canvas2d' | 'webgl' | 'webgl2' | 'webgpu' | 'mixed' | 'other' | 'unknown'

export interface AnimationRumV2Report {
    contractVersion: 2
    snapshotSchemaVersion: 1 | 2
    eventId: string
    captureId: string
    scope: 'page' | 'target'
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
            framework: AnimationRumV2RuntimeFramework
            renderer: AnimationRumV2RuntimeRenderer
            backend: AnimationRumV2RuntimeBackend
        }
    }
    capabilities: Record<Exclude<AnimationRumV2CapabilityName, 'media-stage-attestation'>, AnimationRumV2CapabilityState> &
        Partial<Record<AnimationRumV2CapabilityName, AnimationRumV2CapabilityState>>
    coverage: Record<
        AnimationRumFamily,
        { status: AnimationRumV2MetricStatus; evidenceLevel: 'runtime-observation' | 'unsupported-or-unknown' }
    >
    captureQuality: {
        sufficiency: 'sufficient' | 'insufficient'
        integrity: 'complete' | 'partial'
        reasons: AnimationRumV2QualityReason[]
        adapterErrorCount: number
    }
    providerEvidence: Partial<Record<AnimationRumV2ProviderOwner, Partial<Record<AnimationRumFamily, AnimationRumV2ProviderEvidence>>>>
    metrics: AnimationRumV2Metric[]
}

export type AnimationRumV2PageEvidenceStatus = 'measured' | 'partial' | 'not-observed' | 'not-applicable' | 'unsupported' | 'unknown'

/**
 * Privacy-safe structural subset of Browser page evidence. Browser snapshots
 * are assignable to this interface without making the framework-neutral
 * animation package depend on the Browser package.
 */
export interface AnimationRumV2PageEvidenceSource {
    enabled: boolean
    sampleCount: number
    documentScopes?: {
        capability: CapabilityEvidence
        retainedCount: number
        truncated: boolean
    }
    animations: {
        capability: CapabilityEvidence
        status: AnimationRumV2PageEvidenceStatus
        sampleCount: number
        current: {
            total: number
            inspected: number
            dropped: number
            running: number
            infinite: number
        }
    }
    media: {
        capability: CapabilityEvidence
        status: AnimationRumV2PageEvidenceStatus
        currentVideoCount: number
        retainedVideoCount: number
        droppedVideoCount: number
        rvfcSupportedVideoCount: number
        rvfcUnsupportedVideoCount: number
    }
    rendererSurfaces: {
        discoveryCapability: CapabilityEvidence
        contextObservationCapability: CapabilityEvidence
        status: AnimationRumV2PageEvidenceStatus
        sampleCount: number
        current: {
            total: number
            retained: number
            dropped: number
            svg: number
            canvasUnknown: number
            canvas2d: number
            webgl: number
            webgl2: number
            webgpu: number
        }
    }
    reducedMotion: {
        capability: CapabilityEvidence
        status: AnimationRumV2PageEvidenceStatus
        preference: boolean | null
        reducedMotionSampleCount: number
        current: {
            runningAnimationCandidates: number
        }
    }
}

export interface AnimationRumV2LoafDiagnosticAggregate {
    capability: 'supported' | 'unsupported' | 'unknown'
    count: number | null
    p95Ms: number | null
    accepted: number | null
    rejected: number | null
    retained: number | null
    dropped: number | null
    truncated: boolean
    status: 'measured' | 'partial' | 'not-observed' | 'unsupported' | 'unknown'
}

/**
 * Structural match for browser-utils LongAnimationFrameDiagnosticsSnapshot.
 * It contains aggregates only and keeps the animation package decoupled from
 * the browser observer lifecycle.
 */
export interface AnimationRumV2LoafDiagnosticsSource {
    loafFirstUiEventToFrameEnd: AnimationRumV2LoafDiagnosticAggregate
    loafAttributedForcedStyleLayout: AnimationRumV2LoafDiagnosticAggregate
}

export interface AnimationRumV2RuntimeContext {
    framework?: AnimationRumV2RuntimeFramework
    renderer?: AnimationRumV2RuntimeRenderer
    backend?: AnimationRumV2RuntimeBackend
}

export type AnimationRumV2MediaStageKind = 'image' | 'video' | 'canvas' | 'webgl' | 'webgpu'

export interface AnimationRumV2MediaStageKindAggregate {
    attemptCount: number
    firstVisibleCount: number
    beginToDecodeMs: DurationStatistics | null
    decodeToUploadMs: DurationStatistics | null
    uploadToFirstVisibleMs: DurationStatistics | null
    beginToFirstVisibleMs: DurationStatistics | null
}

export interface AnimationRumV2MediaStageSource {
    instrumented: boolean
    acceptedAttemptCount: number
    retainedAttemptCount: number
    droppedAttemptCount: number
    rejectedAttemptCount: number
    truncated: boolean
    kinds: Record<AnimationRumV2MediaStageKind, AnimationRumV2MediaStageKindAggregate>
}

export interface AnimationRumV2ProjectionOptions {
    /** Caller-generated id; the pure builder never reads randomness or global state. */
    eventId: string
    capturedAtEpochMs: number
    sampleRate: number
    samplingPolicyVersion: number
    /** Wire schema 2 is an explicit opt-in; the local AnimationSnapshot remains schema 1. */
    snapshotSchemaVersion?: 1 | 2
    routeKey?: string
    release?: string
    dist?: string
    environment?: string
    sdkVersion?: string
    runtime?: AnimationRumV2RuntimeContext
    viewportBucket?: AnimationRumV2Report['context']['viewportBucket']
    dprBucket?: AnimationRumV2Report['context']['dprBucket']
    /** Browser-owned aggregate subset; raw page evidence is intentionally not accepted. */
    pageEvidence?: AnimationRumV2PageEvidenceSource
    /** Safe browser-utils aggregate; raw LoAF entries and scripts are never accepted. */
    loafDiagnostics?: AnimationRumV2LoafDiagnosticsSource
    /** Already aggregated page-window interaction quality from an explicit host adapter. */
    interactionQuality?: InteractionQualitySummary
    /** Closed caller-attested aggregates from the independent Browser RUM registry. */
    mediaStages?: AnimationRumV2MediaStageSource
}

export interface AnimationRumV2TargetProjectionOptions extends AnimationRumV2ProjectionOptions {
    /** Independent target capture id; never reuse the parent page capture id. */
    captureId: string
    /** Static, registered semantic key; never a selector, DOM path, id, text, URL, or hash of one. */
    targetKey: string
}

export type AnimationRumV2PageSnapshot = AnimationSnapshot & {
    readonly pageEvidence?: AnimationRumV2PageEvidenceSource
}

export type AnimationRumV2TargetSnapshot = AnimationElementSelectionSnapshot
