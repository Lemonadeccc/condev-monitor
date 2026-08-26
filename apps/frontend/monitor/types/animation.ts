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

export type AnimationMetricStat = 'latest' | 'count' | 'sum' | 'avg' | 'min' | 'max' | 'p50' | 'p75' | 'p95' | 'p99' | 'rate' | 'ratio'
export type AnimationMetricUnit = 'ms' | 'count' | 'ratio' | 'bytes' | 'pixels' | 'hz' | 'frames' | 'percent'

export type AnimationMetric = {
    family: AnimationRumFamily
    name: string
    stat: AnimationMetricStat
    unit: AnimationMetricUnit
    value: number | null
    samples: number | null
    status: AnimationMetricStatus
}

export type AnimationAggregateMetric = Omit<AnimationMetric, 'value' | 'samples'> & {
    capturesWithValue: number
    reportedSamples: number
    valueAvg: number | null
    valueP50: number | null
    valueP75: number | null
    valueP95: number | null
    valueMin: number | null
    valueMax: number | null
    normalizedCapturesWithValue: number
    valuePerMinuteAvg: number | null
    valuePerMinuteP50: number | null
    valuePerMinuteP75: number | null
    valuePerMinuteP95: number | null
    valuePerMinuteMin: number | null
    valuePerMinuteMax: number | null
}

export type AnimationCoverage = {
    status: AnimationCoverageStatus
    evidenceLevel: AnimationEvidenceLevel
}

export type AnimationCapture = {
    eventId: string
    captureId: string
    capturedAt: string
    receivedAt: string
    release: string
    dist: string
    environment: string
    sdkVersion: string
    monitorVersion: string
    sampleRate: number
    samplingPolicyVersion: number
    routeKey: string
    runtimeFamily: string
    context: {
        routeKey?: string
        runtimeFamily?: string
        visibilityState?: 'visible' | 'hidden' | 'prerender' | 'unknown'
        reducedMotion?: boolean | null
        viewportBucket?: 'tiny' | 'small' | 'medium' | 'large' | 'xlarge' | 'unknown'
        dprBucket?: '1' | '1.5' | '2' | '3' | '4+' | 'unknown'
        refreshHz?: number | null
        refreshBudgetSource?: 'explicit' | 'inferred' | 'observed' | 'unknown'
        refreshBudgetConfidence?: 'explicit' | 'high' | 'medium' | 'low' | 'unknown'
        windowDurationMs: number
        windowDurationCapped: boolean
        adapterVersions?: Record<string, string>
    }
    capabilities: Record<string, boolean | 'unknown' | null>
    coverage: Partial<Record<AnimationRumFamily, AnimationCoverage>>
    metrics: AnimationMetric[]
}

export type AnimationSummaryApiResponse = {
    success: true
    data: {
        window: { from: string; to: string }
        captureCount: number
        normalization: {
            kind: 'per-minute'
            minimumWindowMs: number
            excludesCappedWindows: boolean
            requiresMeasuredStatus: boolean
        }
        metrics: AnimationAggregateMetric[]
    }
}

export type AnimationCapturesApiResponse = {
    success: true
    data: {
        window: { from: string; to: string }
        limit: number
        offset: number
        captures: AnimationCapture[]
    }
}

export const ANIMATION_RUM_FAMILIES: readonly AnimationRumFamily[] = [
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
]
