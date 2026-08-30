export type AnimationRumV3Count = number | string
export type AnimationRumV3MetricStatus = 'measured' | 'partial' | 'not-observed' | 'not-instrumented' | 'unsupported' | 'unknown'
export type AnimationRumV3QualityReason = 'provider-rejected-samples' | 'provider-truncated' | 'source-field-incomplete' | 'window-capped'
export type AnimationRumV3CapabilityState = 'supported' | 'unsupported' | 'unknown' | 'disabled'

export type AnimationRumV3MetricView = {
    metricId: string
    vitalName: 'CLS' | 'INP' | 'LCP'
    unit: 'ratio' | 'ms'
    relation: 'page-window'
    owner: 'web-vitals-runtime'
    value: number | null
    samples: 1 | null
    status: AnimationRumV3MetricStatus
}

export type AnimationRumV3SummaryGroup = {
    dimensions: {
        routeKey: string | null
        release: string
        environment: string
        runtime: { framework: string; renderer: string; backend: string }
    }
    metric: { metricId: string; vitalName: 'CLS' | 'INP' | 'LCP'; unit: 'ratio' | 'ms' }
    captureCount: AnimationRumV3Count
    measuredCount: AnimationRumV3Count
    partialCount: AnimationRumV3Count
    notObservedCount: AnimationRumV3Count
    notInstrumentedCount: AnimationRumV3Count
    unsupportedCount: AnimationRumV3Count
    unknownCount: AnimationRumV3Count
    insufficientEvidenceCount: AnimationRumV3Count
    reportedSamples: AnimationRumV3Count
    disclosure: { minimumSampleThreshold: number; status: 'available' | 'insufficient-samples' }
    captureValue: { p50: number | null; p75: number | null; p95: number | null }
}

export type AnimationRumV3Capture = {
    eventId: string
    captureId: string
    captureKind: 'soft-navigation' | null
    scope: 'page' | null
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
        visibilityState: string
        reducedMotion: boolean | null
        viewportBucket: string
        dprBucket: string
        refreshHz: number | null
        refreshBudgetSource: string
        refreshBudgetConfidence: string
        windowDurationMs: number | null
        windowDurationCapped: boolean
        runtime: { framework: string; renderer: string; backend: string }
    }
    quality: {
        sufficiency: 'sufficient' | 'insufficient'
        integrity: 'complete' | 'partial'
        reasons: AnimationRumV3QualityReason[]
    }
    providerEvidenceCount: number | null
    metricCount: number | null
    metrics: AnimationRumV3MetricView[]
}

export type AnimationRumV3CaptureDetail = AnimationRumV3Capture & {
    capabilities: {
        'web-vitals-soft-navigation': {
            status: AnimationRumV3CapabilityState
            metrics: Record<'CLS' | 'INP' | 'LCP', AnimationRumV3CapabilityState>
        }
    }
    coverage: {
        userOutcome: {
            status: AnimationRumV3MetricStatus
            evidenceLevel: 'runtime-observation' | 'unsupported-or-unknown'
        }
    }
    providerEvidence: {
        owner: 'web-vitals-runtime'
        family: 'userOutcome'
        version: string
        accepted: number
        retained: number
        evidence: number
        dropped: number
        rejected: number
        truncated: boolean
    }
}

export type AnimationRumV3SummaryApiResponse = {
    success: true
    data: {
        contractVersion: 3
        snapshotSchemaVersion: 1
        captureKind: 'soft-navigation'
        minimumSampleThreshold: number
        window: { from: string; to: string; retentionDays: number; retentionClamped: boolean }
        captures: {
            total: AnimationRumV3Count
            sufficient: AnimationRumV3Count
            insufficient: AnimationRumV3Count
            partial: AnimationRumV3Count
        }
        projectionIntegrity: {
            semantics: 'completion-marker-child-row-counts'
            completionMarkers: AnimationRumV3Count
            verified: AnimationRumV3Count
            excludedFromAnalytics: AnimationRumV3Count
            metricCountMismatches: AnimationRumV3Count
            providerEvidenceCountMismatches: AnimationRumV3Count
            childIdentityMismatches: AnimationRumV3Count
        }
        groups: AnimationRumV3SummaryGroup[]
    }
}

export type AnimationRumV3CapturesApiResponse = {
    success: true
    data: {
        contractVersion: 3
        snapshotSchemaVersion: 1
        captureKind: 'soft-navigation'
        minimumSampleThreshold: number
        pagination: { total: AnimationRumV3Count; limit: number; offset: number; hasMore: boolean }
        captures: AnimationRumV3Capture[]
    }
}

export type AnimationRumV3CaptureDetailApiResponse = {
    success: true
    data: {
        contractVersion: 3
        snapshotSchemaVersion: 1
        capture: AnimationRumV3CaptureDetail
    }
}

export type AnimationRumV3PipelineStatus = 'idle' | 'in-flight' | 'healthy' | 'delayed' | 'quarantined' | 'inconsistent' | 'unknown'

export type AnimationRumV3PipelineDiagnostic = {
    diagnosticSchemaVersion: 1
    rumContractVersion: 3
    observedAt: string
    status: AnimationRumV3PipelineStatus
    window: {
        lookbackSeconds: 3600
        outboxDelaySeconds: 300
        projectionGraceSeconds: 120
        comparisonLimit: 500
    }
    receipts: {
        recent: { count: number; truncated: boolean }
        byState: { pending: number; published: number; persisted: number; quarantined: number }
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
