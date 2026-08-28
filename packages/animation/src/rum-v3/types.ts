import type {
    AnimationRumV2CapabilityState,
    AnimationRumV2Report,
    AnimationRumV2RuntimeBackend,
    AnimationRumV2RuntimeFramework,
    AnimationRumV2RuntimeRenderer,
} from '../rum-v2/types'

export type AnimationRumV3VitalName = 'CLS' | 'INP' | 'LCP'
export type AnimationRumV3MetricId =
    | 'vital.soft-navigation.cls.latest'
    | 'vital.soft-navigation.inp.latest'
    | 'vital.soft-navigation.lcp.latest'
export type AnimationRumV3MetricStatus = 'measured' | 'partial' | 'not-observed' | 'not-instrumented' | 'unsupported' | 'unknown'
export type AnimationRumV3QualityReason = 'provider-rejected-samples' | 'provider-truncated' | 'source-field-incomplete' | 'window-capped'

export interface AnimationRumV3Metric {
    metricId: AnimationRumV3MetricId
    relation: 'page-window'
    owner: 'web-vitals-runtime'
    value: number | null
    samples: 1 | null
    status: AnimationRumV3MetricStatus
}

export interface AnimationRumV3SoftNavigationCapability {
    status: AnimationRumV2CapabilityState
    metrics: Record<AnimationRumV3VitalName, AnimationRumV2CapabilityState>
}

export interface AnimationRumV3Report {
    contractVersion: 3
    snapshotSchemaVersion: 1
    captureKind: 'soft-navigation'
    eventId: string
    captureId: string
    scope: 'page'
    parentCaptureId: null
    targetKey: null
    capturedAt: string
    release: string
    dist: string
    environment: string
    sdkVersion: string
    monitorVersion: string
    sampleRate: number
    samplingPolicyVersion: number
    context: {
        routeKey: string
        visibilityState?: AnimationRumV2Report['context']['visibilityState']
        reducedMotion?: AnimationRumV2Report['context']['reducedMotion']
        viewportBucket?: AnimationRumV2Report['context']['viewportBucket']
        dprBucket?: AnimationRumV2Report['context']['dprBucket']
        refreshHz?: AnimationRumV2Report['context']['refreshHz']
        refreshBudgetSource?: AnimationRumV2Report['context']['refreshBudgetSource']
        refreshBudgetConfidence?: AnimationRumV2Report['context']['refreshBudgetConfidence']
        windowDurationMs: number
        windowDurationCapped: boolean
        runtime: {
            framework: AnimationRumV2RuntimeFramework
            renderer: AnimationRumV2RuntimeRenderer
            backend: AnimationRumV2RuntimeBackend
        }
    }
    capabilities: { 'web-vitals-soft-navigation': AnimationRumV3SoftNavigationCapability }
    coverage: {
        userOutcome: {
            status: AnimationRumV3MetricStatus
            evidenceLevel: 'runtime-observation' | 'unsupported-or-unknown'
        }
    }
    captureQuality: {
        sufficiency: 'sufficient' | 'insufficient'
        integrity: 'complete' | 'partial'
        reasons: AnimationRumV3QualityReason[]
    }
    providerEvidence: {
        'web-vitals-runtime': {
            userOutcome: {
                version: string
                accepted: number
                retained: number
                evidence: number
                dropped: number
                rejected: number
                truncated: boolean
            }
        }
    }
    metrics: [AnimationRumV3Metric, AnimationRumV3Metric, AnimationRumV3Metric]
}

export interface AnimationRumV3SoftNavigationProjectionOptions {
    /** Caller-generated identity; the pure builder never reads randomness or native navigation identity. */
    eventId: string
    /** Caller-generated capture identity; never derive this from the local segment id. */
    captureId: string
    capturedAtEpochMs: number
    sampleRate: number
    samplingPolicyVersion: number
    /** Static, caller-owned semantic key; never a URL, pathname, selector, or user-derived value. */
    routeKey: string
    release?: string
    dist?: string
    environment?: string
    sdkVersion?: string
    visibilityState?: AnimationRumV3Report['context']['visibilityState']
    reducedMotion?: AnimationRumV3Report['context']['reducedMotion']
    viewportBucket?: AnimationRumV3Report['context']['viewportBucket']
    dprBucket?: AnimationRumV3Report['context']['dprBucket']
    refreshHz?: AnimationRumV3Report['context']['refreshHz']
    refreshBudgetSource?: AnimationRumV3Report['context']['refreshBudgetSource']
    refreshBudgetConfidence?: AnimationRumV3Report['context']['refreshBudgetConfidence']
    runtime: AnimationRumV3Report['context']['runtime']
}
