export type LabRunStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'unknown'

export type LabRunSource = 'local-runner' | 'ci' | 'import' | 'unknown'

/** These semantic API types mirror `@condev-monitor/animation-lab` v2. */
export type LabEvidenceLevel = 'controlled-lab-measurement' | 'runtime-observation' | 'unsupported-or-unknown'
export type LabEvidenceConfidence = 'explicit' | 'high' | 'medium' | 'low' | 'unknown'
export type LabActionKind = 'wait' | 'click' | 'hover' | 'pointer-path' | 'scroll' | 'resize' | 'drag' | 'press'
export type LabSubjectScope = 'page' | 'route' | 'frame' | 'subject' | 'renderer-surface' | 'media'
export type LabSubjectSurface = 'dom' | 'svg' | 'canvas2d' | 'webgl' | 'webgl2' | 'webgpu' | 'video' | 'audio' | 'unknown'
export type LabActionTriggerSource =
    | 'scenario'
    | 'manual'
    | 'auto-discovery'
    | 'replay'
    | 'browser'
    | 'framework-adapter'
    | 'renderer-adapter'
    | 'unknown'

export type LabActionSubject = {
    scope: LabSubjectScope
    /** Caller-owned semantic token. Selectors, DOM text, URLs and attributes are forbidden. */
    subjectKey?: string
    role?: string
    surface?: LabSubjectSurface
}

export type LabActionTrigger = {
    source: LabActionTriggerSource
}

export type LabScenarioAction = {
    actionId: string
    order: number
    kind: LabActionKind
    label: string
    subject?: LabActionSubject
    trigger: LabActionTrigger
}

export type LabActionWindow = {
    actionId: string
    order: number
    kind: LabActionKind
    trigger: LabActionTrigger
    subject?: LabActionSubject
    outcome: {
        status: 'completed' | 'cancelled' | 'failed' | 'timed-out' | 'unknown'
        outcomeKey?: string
    }
    timestamps: {
        clock: 'attempt-monotonic'
        startedAtMs: number
        endedAtMs: number
        durationMs: number
    }
    evidenceRefs: string[]
    limitations: string[]
}

export type LabMetricScope = {
    level: 'run' | 'attempt' | 'action' | 'subject'
    attemptId?: string
    actionId?: string
    subjectKey?: string
}

export type LabBudgetRef = {
    catalogVersion: 1
    budgetId: string
    budgetVersion: number
}

export type LabBudgetRuleRef = LabBudgetRef & {
    ruleId: string
}

export type LabMetric = {
    metricId?: string
    family: string
    name: string
    stat: string
    unit: string
    value: number | null
    samples: number | null
    status: string
    evidenceLevel?: LabEvidenceLevel
    scope?: LabMetricScope
    aggregation?: {
        population: string
        method: string
    }
    budgetRefs?: LabBudgetRuleRef[]
    evidenceRefs?: string[]
    limitations?: string[]
}

export type LabMeasurementContract = {
    contractVersion: 2
    expectedHz: number
    targetFrameMs: number
    source: 'explicit' | 'observed' | 'inferred' | 'package-default' | 'unknown'
    confidence: LabEvidenceConfidence
    budgetRef: LabBudgetRef
    metricCatalogVersion: 1
}

export type LabTechnologyAxis =
    | 'ui-framework'
    | 'meta-runtime'
    | 'motion-engine'
    | 'renderer'
    | 'graphics-api'
    | 'media'
    | 'browser-runtime'

export type LabTechnologyEvidence = {
    evidenceId: string
    axis: LabTechnologyAxis
    technologyKey: string
    version?: string
    source: 'scenario-declaration' | 'runtime-probe' | 'host-adapter' | 'cdp-trace' | 'lighthouse' | 'unknown'
    confidence: LabEvidenceConfidence
    status: 'observed' | 'declared' | 'inferred' | 'unsupported' | 'unknown'
    scope: LabMetricScope
    actionId?: string
    limitations: string[]
}

export type LabFinding = {
    findingId: string
    ruleId: string
    severity: 'info' | 'warning' | 'critical'
    status: 'observed' | 'candidate' | 'not-observed' | 'unsupported'
    scope: LabMetricScope
    metricIds: string[]
    evidenceRefs: string[]
    budgetRefs: LabBudgetRuleRef[]
    actionIds: string[]
    limitations: string[]
}

export type LabRunAnalysis = {
    semanticsVersion: 2
    measurementContract: LabMeasurementContract
    scenarioActions: LabScenarioAction[]
    actionWindows: LabActionWindow[]
    metrics: LabMetric[]
    technologyEvidence: LabTechnologyEvidence[]
    findings: LabFinding[]
}

export type LabRun = {
    runId: string
    appId: string
    name: string
    targetUrl?: string | null
    status: LabRunStatus
    source: LabRunSource
    createdAt: string
    startedAt?: string | null
    completedAt?: string | null
    durationMs?: number | null
    release?: string | null
    environment?: string | null
    browser?: string | null
    viewport?: { width: number; height: number; dpr?: number | null } | null
    summary?: LabRunSummary | null
    errorMessage?: string | null
}

export type LabRunSummary = {
    performanceScore?: number | null
    accessibilityScore?: number | null
    animationScore?: number | null
    frameP95Ms?: number | null
    slowFrameRate?: number | null
    longTaskCount?: number | null
    lighthouseScore?: number | null
    eventCount?: number | null
    warningCount?: number | null
    metrics?: LabMetric[]
    capabilities?: Record<string, boolean | 'unknown' | null>
    limitations?: string[]
}

export type LabApiResponse<T> = {
    success: boolean
    data: T
    message?: string
}

export type LabRunsApiResponse = LabApiResponse<{
    runs: LabRun[]
    count: number
}>

export type LabRunApiResponse = LabApiResponse<{
    run: LabRun
    /** Optional schema-v2 semantic projection. Missing or null on legacy reports. */
    analysis?: LabRunAnalysis | null
}>

export type LabCreateRequest = {
    action: 'create'
    appId: string
    name: string
    targetUrl: string
    browser: 'chromium' | 'firefox' | 'webkit'
}

export type LabRunnerGrant = {
    token: string
    expiresAt: string
    returnedOnce: boolean
}

export type LabCreateApiResponse = LabApiResponse<{
    run: LabRun
    runnerGrant: LabRunnerGrant
}>

export type LabTimelineCategory =
    | 'frame'
    | 'interaction'
    | 'animation'
    | 'script'
    | 'long-task'
    | 'style-layout'
    | 'paint-composite'
    | 'renderer'
    | 'resource'
    | 'marker'
    | 'other'

export type LabTimelineSeverity = 'info' | 'warning' | 'error'

export type LabTimelineStackFrame = {
    functionName?: string | null
    fileName?: string | null
    lineNumber?: number | null
    columnNumber?: number | null
}

export type LabTimelineEvent = {
    eventId: string
    name: string
    category: LabTimelineCategory
    lane?: string | null
    startTimeMs: number
    durationMs: number
    severity?: LabTimelineSeverity
    description?: string | null
    stack?: LabTimelineStackFrame[]
    actionId?: string | null
    actionLabel?: string | null
    subjectKey?: string | null
    evidenceLevel?: LabEvidenceLevel | null
    confidence?: LabEvidenceConfidence | null
    limitations?: string[]
    attributes?: Record<string, string | number | boolean | null>
}

export type LabTimelineApiResponse = LabApiResponse<{
    runId: string
    durationMs: number
    events: LabTimelineEvent[]
    totalEvents: number
    truncated: boolean
    maxEvents: number
}>

export type LabLighthouseCategory = {
    id: string
    title: string
    score: number | null
    description?: string | null
}

export type LabLighthouseMetric = {
    id: string
    title: string
    value: number | null
    displayValue?: string | null
    unit?: string | null
    score?: number | null
}

export type LabLighthouseAudit = {
    id: string
    title: string
    description?: string | null
    score: number | null
    displayValue?: string | null
    details?: string | null
}

export type LabLighthouseReport = {
    version?: string | null
    fetchedAt?: string | null
    requestedUrl?: string | null
    finalUrl?: string | null
    categories: LabLighthouseCategory[]
    metrics: LabLighthouseMetric[]
    failedAudits: LabLighthouseAudit[]
}

export type LabLighthouseApiResponse = LabApiResponse<{
    runId: string
    report: LabLighthouseReport | null
}>

export type LabArtifactKind = 'trace' | 'lighthouse' | 'screenshot' | 'report' | 'log' | 'json' | 'other'

export type LabArtifact = {
    artifactId: string
    name: string
    kind: LabArtifactKind
    sizeBytes?: number | null
    contentType?: string | null
    createdAt?: string | null
    downloadUrl?: string | null
    sha256?: string | null
}

export type LabArtifactsApiResponse = LabApiResponse<{
    runId: string
    artifacts: LabArtifact[]
}>
