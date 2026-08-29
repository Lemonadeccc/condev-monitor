export type AnimationRumV2JsonInteger = number | string | null

export type AnimationRumV2Scope = 'page' | 'target'
export type AnimationRumV2Relation = 'page-window' | 'target-direct' | 'target-temporal-overlap' | 'adapter'
export type AnimationRumV2MetricStatus = 'measured' | 'partial' | 'not-observed' | 'not-instrumented' | 'unsupported' | 'unknown'
export type AnimationRumV2CapabilityState = 'supported' | 'unsupported' | 'unknown' | 'disabled'
export type AnimationRumV2EvidenceLevel = 'runtime-observation' | 'unsupported-or-unknown'
export type AnimationRumV2MetricStat = 'latest' | 'count' | 'sum' | 'avg' | 'min' | 'max' | 'p50' | 'p75' | 'p95' | 'p99' | 'rate' | 'ratio'
export type AnimationRumV2MetricUnit = 'ms' | 'count' | 'ratio' | 'multiplier' | 'bytes' | 'pixels' | 'hz' | 'frames' | 'percent' | 'score'
export type AnimationRumV2EvidenceWindow = 'capture-window' | 'document-lifetime'

export const ANIMATION_RUM_V2_FAMILIES = [
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
] as const

export type AnimationRumV2Family = (typeof ANIMATION_RUM_V2_FAMILIES)[number]

export const ANIMATION_RUM_V2_CAPABILITIES = [
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
] as const

export const ANIMATION_RUM_V2_SCHEMA_2_CAPABILITIES = [...ANIMATION_RUM_V2_CAPABILITIES, 'media-stage-attestation'] as const

export type AnimationRumV2CapabilityName = (typeof ANIMATION_RUM_V2_SCHEMA_2_CAPABILITIES)[number]

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

export type AnimationRumV2ProjectionIntegrityStatus = 'verified' | 'mismatch' | 'not-observed'

export type AnimationRumV2CaptureProjectionIntegrity = {
    semantics: 'completion-marker-child-row-counts'
    status: 'verified'
    expected: {
        metrics: number
        providerEvidence: number
    }
    observed: {
        metrics: AnimationRumV2JsonInteger
        providerEvidence: AnimationRumV2JsonInteger
    }
}

export type AnimationRumV2Window = {
    from: string
    to: string
    retentionClamped: boolean
}

export type AnimationRumV2Filters = {
    scope: AnimationRumV2Scope | null
    release: string | null
    dist: string | null
    environment: string | null
    routeKey: string | null
    targetKey: string | null
    runtimeFramework: string | null
    runtimeRenderer: string | null
    runtimeBackend: string | null
}

export type AnimationRumV2ScopeCounts = {
    observed: AnimationRumV2JsonInteger
    sufficient: AnimationRumV2JsonInteger
    insufficient: AnimationRumV2JsonInteger
    complete: AnimationRumV2JsonInteger
    partial: AnimationRumV2JsonInteger
    capped: AnimationRumV2JsonInteger
    adapterErrors: AnimationRumV2JsonInteger
}

export type AnimationRumV2MetricStatusCounts = {
    measured: AnimationRumV2JsonInteger
    partial: AnimationRumV2JsonInteger
    notObserved: AnimationRumV2JsonInteger
    notInstrumented: AnimationRumV2JsonInteger
    unsupported: AnimationRumV2JsonInteger
    unknown: AnimationRumV2JsonInteger
}

export type AnimationRumV2SummaryMetric = {
    metricId: string
    family: AnimationRumV2Family
    name: string
    stat: AnimationRumV2MetricStat
    unit: AnimationRumV2MetricUnit
    evidenceWindow: AnimationRumV2EvidenceWindow
    scope: AnimationRumV2Scope
    relation: AnimationRumV2Relation
    owner: AnimationRumV2ProviderOwner
    captureCount: AnimationRumV2JsonInteger
    statusCounts: AnimationRumV2MetricStatusCounts
    capturesWithValue: AnimationRumV2JsonInteger
    measuredCaptures: AnimationRumV2JsonInteger
    partialCaptures: AnimationRumV2JsonInteger
    excludedPartialCaptures: AnimationRumV2JsonInteger
    reportedSamples: AnimationRumV2JsonInteger
    measuredReportedSamples: AnimationRumV2JsonInteger
    partialReportedSamples: AnimationRumV2JsonInteger
    captureValue: {
        aggregation: 'distribution-of-capture-aggregates'
        measuredCaptures: AnimationRumV2JsonInteger
        partialCaptures: AnimationRumV2JsonInteger
        excludedPartialCaptures: AnimationRumV2JsonInteger
        average: number | null
        p50: number | null
        p75: number | null
        p95: number | null
        min: number | null
        max: number | null
    }
    valuePerMinute: {
        capturesWithValue: AnimationRumV2JsonInteger
        average: number | null
        p50: number | null
        p75: number | null
        p95: number | null
        min: number | null
        max: number | null
    } | null
}

export type AnimationRumV2TrendMetric = {
    statusCounts: AnimationRumV2MetricStatusCounts
    measuredCaptures: AnimationRumV2JsonInteger
    partialCaptures: AnimationRumV2JsonInteger
    excludedPartialCaptures: AnimationRumV2JsonInteger
    captureValue: { p50: number | null; p75: number | null; p95: number | null }
}

export type AnimationRumV2TrendPoint = {
    at: string
    observedCaptures: AnimationRumV2JsonInteger
    pageCaptures: AnimationRumV2JsonInteger
    targetCaptures: AnimationRumV2JsonInteger
    frameP95: {
        page: AnimationRumV2TrendMetric | null
        target: AnimationRumV2TrendMetric | null
    }
    gpuFrameP95?: {
        page: AnimationRumV2TrendMetric | null
        target: AnimationRumV2TrendMetric | null
    }
}

export type AnimationRumV2SummaryApiResponse = {
    success: true
    data: {
        contractVersion: 2
        snapshotSchemaVersion: 1 | 2
        catalogMetricCount: number
        retentionDays: number
        aggregationSemantics: 'distribution-of-capture-aggregates'
        window: AnimationRumV2Window
        filters: AnimationRumV2Filters
        projectionIntegrity?: {
            semantics: 'completion-marker-child-row-counts'
            status: AnimationRumV2ProjectionIntegrityStatus
            completionMarkers: AnimationRumV2JsonInteger
            verified: AnimationRumV2JsonInteger
            mismatched: AnimationRumV2JsonInteger
            excludedFromAnalytics: AnimationRumV2JsonInteger
            metricCountMismatches: AnimationRumV2JsonInteger
            providerEvidenceCountMismatches: AnimationRumV2JsonInteger
            childIdentityMismatches: AnimationRumV2JsonInteger
        }
        captures: {
            observed: AnimationRumV2JsonInteger
            page: AnimationRumV2JsonInteger
            target: AnimationRumV2JsonInteger
            sufficient: AnimationRumV2JsonInteger
            insufficient: AnimationRumV2JsonInteger
            complete: AnimationRumV2JsonInteger
            partial: AnimationRumV2JsonInteger
            capped: AnimationRumV2JsonInteger
            byScope: Record<AnimationRumV2Scope, AnimationRumV2ScopeCounts>
            distinctRoutes: AnimationRumV2JsonInteger
            distinctTargets: AnimationRumV2JsonInteger
            adapterErrors: AnimationRumV2JsonInteger
            firstCapturedAt: string | null
            lastCapturedAt: string | null
        }
        qualityReasons: Array<{ reason: AnimationRumV2QualityReason; captures: AnimationRumV2JsonInteger }>
        qualityReasonsByScope: Record<
            AnimationRumV2Scope,
            Array<{ reason: AnimationRumV2QualityReason; captures: AnimationRumV2JsonInteger }>
        >
        normalization: {
            kind: 'per-minute'
            minimumWindowMs: number
            excludesCappedWindows: true
            requiresMeasuredStatus: true
            appliesTo: 'closed event-flow count and sum metrics'
        }
        trend: {
            bucket: {
                kind: 'hour' | 'six-hours' | 'day'
                durationMs: number
                maximumPoints: number
                timezone: 'UTC'
            }
            metric: {
                metricId: 'frame.duration.p95'
                aggregationSemantics: 'distribution-of-capture-aggregates'
            }
            gpuMetric?: {
                metricId: 'renderer.gpu-frame.p95'
                aggregationSemantics: 'distribution-of-capture-aggregates'
            }
            points: AnimationRumV2TrendPoint[]
        }
        metrics: AnimationRumV2SummaryMetric[]
    }
}

export type AnimationRumV2PipelineStatus = 'idle' | 'in-flight' | 'healthy' | 'delayed' | 'quarantined' | 'inconsistent' | 'unknown'

export type AnimationRumV2PipelineDiagnostic = {
    diagnosticSchemaVersion: 1
    rumContractVersion: 2
    observedAt: string
    status: AnimationRumV2PipelineStatus
    window: {
        lookbackSeconds: 3600
        outboxDelaySeconds: 300
        projectionGraceSeconds: 120
        comparisonLimit: 500
    }
    receipts: {
        recent: { count: number; truncated: boolean }
        byState: {
            pending: number
            published: number
            persisted: number
            quarantined: number
        }
        latestTransitionAt: string | null
        statePairMismatch: number
    }
    outbox: {
        pending: { count: number; truncated: boolean }
        due: number
        retrying: number
        leased: number
        oldestPendingAt: string | null
        maxAttemptCount: number | null
        recentQuarantined: { count: number; truncated: boolean }
    }
    projection: {
        availability: 'not-checked' | 'available' | 'unavailable'
        eligible: { count: number; truncated: boolean }
        matched: number | null
        missingAfterGrace: number | null
        identityMismatch: number | null
        /** Additive schema-v1 extension. All three fields are either absent together or present together. */
        storageComplete?: number | null
        childCountMismatch?: number | null
        childIdentityMismatch?: number | null
    }
    semantics: {
        publishedMeans: 'kafka-broker-ack-only'
        projectedMeans: 'clickhouse-capture-completion-marker'
        diagnosticMeans: 'bounded-inference-not-worker-health'
    }
}

export type AnimationRumV2PipelineApiResponse = {
    success: true
    data: AnimationRumV2PipelineDiagnostic
}

export type AnimationRumV2CaptureBase = {
    captureId: string
    snapshotSchemaVersion: 1 | 2 | null
    parentCaptureId: string | null
    scope: AnimationRumV2Scope
    targetKey: string | null
    capturedAt: string | null
    receivedAt: string | null
    release: string
    dist: string
    environment: string
    sdkVersion: string
    monitorVersion: string
    sampleRate: number | null
    samplingPolicyVersion: number | null
    context: {
        routeKey: string | null
        visibilityState: 'visible' | 'hidden' | 'prerender' | 'unknown'
        reducedMotion: boolean | null
        viewportBucket: 'tiny' | 'small' | 'medium' | 'large' | 'xlarge' | 'unknown'
        dprBucket: '1' | '1.5' | '2' | '3' | '4+' | 'unknown'
        refreshHz: number | null
        refreshBudgetSource: 'explicit' | 'inferred' | 'observed' | 'unknown'
        refreshBudgetConfidence: 'explicit' | 'high' | 'medium' | 'low' | 'unknown'
        windowDurationMs: number | null
        windowDurationCapped: boolean
        runtime: {
            framework: string
            renderer: string
            backend: string
        }
    }
    quality: {
        sufficiency: 'sufficient' | 'insufficient'
        integrity: 'complete' | 'partial'
        reasons: AnimationRumV2QualityReason[]
        adapterErrorCount: number | null
    }
    providerEvidenceCount: number | null
    metricCount: number | null
    /** Missing when reading an older Monitor backend. Missing never means verified. */
    projectionIntegrity?: AnimationRumV2CaptureProjectionIntegrity
}

export type AnimationRumV2Metric = {
    metricId: string
    family: AnimationRumV2Family
    name: string
    stat: AnimationRumV2MetricStat
    unit: AnimationRumV2MetricUnit
    evidenceWindow: AnimationRumV2EvidenceWindow
    relation: AnimationRumV2Relation
    owner: AnimationRumV2ProviderOwner
    value: number | null
    samples: number | null
    status: AnimationRumV2MetricStatus
}

export type AnimationRumV2CaptureListItem = AnimationRumV2CaptureBase & {
    targetChildCount: AnimationRumV2JsonInteger | null
    frameP95: AnimationRumV2Metric | null
}

export type AnimationRumV2CapturesApiResponse = {
    success: true
    data: {
        contractVersion: 2
        snapshotSchemaVersion: 1 | 2
        window: AnimationRumV2Window
        filters: AnimationRumV2Filters
        pagination: {
            total: AnimationRumV2JsonInteger
            limit: number
            offset: number
            hasMore: boolean | null
        }
        captures: AnimationRumV2CaptureListItem[]
    }
}

export type AnimationRumV2CaptureDetail = AnimationRumV2CaptureBase & {
    eventId: string
    contractVersion: 2 | null
    capabilities: Partial<Record<AnimationRumV2CapabilityName, AnimationRumV2CapabilityState>>
    coverage: Record<
        AnimationRumV2Family,
        {
            status: AnimationRumV2MetricStatus
            evidenceLevel: AnimationRumV2EvidenceLevel
        }
    >
}

export type AnimationRumV2ProviderEvidence = {
    owner: AnimationRumV2ProviderOwner
    family: AnimationRumV2Family
    providerVersion: string
    accepted: number
    retained: number
    evidence: number
    dropped: number
    rejected: number
    truncated: boolean
}

export type AnimationRumV2CaptureDetailApiResponse = {
    success: true
    data: {
        contractVersion: 2
        snapshotSchemaVersion: 1 | 2
        capture: AnimationRumV2CaptureDetail
        metrics: AnimationRumV2Metric[]
        providerEvidence: AnimationRumV2ProviderEvidence[]
        relationships: {
            parent: AnimationRumV2CaptureBase | null
            targets: {
                items: AnimationRumV2CaptureBase[]
                returned: number
                hasMore: boolean
            } | null
        }
    }
}
