export const ANIMATION_LAB_SCHEMA_VERSION = 1 as const
export const ANIMATION_LAB_SEMANTICS_VERSION = 2 as const
export const ANIMATION_LAB_BUDGET_CATALOG_VERSION = 1 as const
export const ANIMATION_LAB_METRIC_CATALOG_VERSION = 1 as const

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

export type LabTechnologyAxis =
    | 'ui-framework'
    | 'meta-runtime'
    | 'motion-engine'
    | 'renderer'
    | 'graphics-api'
    | 'media'
    | 'browser-runtime'
export type LabDeclaredTechnologyAxis = Exclude<LabTechnologyAxis, 'browser-runtime'>

/** Local scenario declaration only; the report marks it declared, never observed. */
export interface LabActionTechnologyDeclaration {
    axis: LabDeclaredTechnologyAxis
    technologyKey: string
    version?: string
}

/** Caller-owned semantic aliases only. Selectors, DOM text, URLs and attributes are forbidden. */
export interface LabActionSubject {
    scope: LabSubjectScope
    subjectKey?: string
    role?: string
    surface?: LabSubjectSurface
}

export interface LabActionTrigger {
    source?: LabActionTriggerSource
}

export interface LabActionBase {
    kind: LabActionKind
    /** Static, caller-owned token. It is the only action identity retained in reports. */
    label: string
    timeoutMs?: number
    /** Optional explicit identity. `resolveLabActionId()` supplies a deterministic fallback. */
    actionId?: string
    subject?: LabActionSubject
    trigger?: LabActionTrigger
    technologies?: readonly LabActionTechnologyDeclaration[]
}

export type LabScenarioAction =
    | (LabActionBase & { kind: 'wait'; durationMs: number })
    | (LabActionBase & { kind: 'click' | 'hover'; selector: string; durationMs?: number })
    | (LabActionBase & {
          kind: 'pointer-path'
          selector?: string
          durationMs: number
          points: readonly { xRatio: number; yRatio: number }[]
      })
    | (LabActionBase & { kind: 'scroll'; selector?: string; deltaX?: number; deltaY: number; durationMs: number })
    | (LabActionBase & { kind: 'resize'; width: number; height: number })
    | (LabActionBase & { kind: 'drag'; fromSelector: string; toSelector?: string; deltaX?: number; deltaY?: number; durationMs: number })
    | (LabActionBase & { kind: 'press'; key: 'Enter' | 'Space' | 'Tab' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Escape' })

export interface AnimationLabScenario {
    schemaVersion: 1
    name: string
    /** Local runner input only. Reports retain routeKey instead of this URL. */
    url: string
    routeKey: string
    release?: string
    dist?: string
    environment?: string
    viewport: { width: number; height: number; deviceScaleFactor?: number }
    reducedMotion?: 'no-preference' | 'reduce'
    colorScheme?: 'light' | 'dark'
    cacheMode?: 'cold' | 'warm'
    /** Minimum observation window for each warm-up, measured, and trace page attempt. */
    durationMs?: number
    cpuThrottleRate?: number
    network?: {
        offline?: boolean
        latencyMs?: number
        downloadBytesPerSecond?: number
        uploadBytesPerSecond?: number
    }
    warmupRuns: number
    measuredRuns: number
    actions: readonly LabScenarioAction[]
    /** Optional v2 semantics; old v1 scenarios remain valid without it. */
    measurementContract?: LabMeasurementContractV2
    trace?: { enabled?: boolean; screenshots?: boolean; maxDurationMs?: number }
    lighthouse?: {
        enabled?: boolean
        categories?: readonly ('performance' | 'accessibility' | 'best-practices' | 'seo')[]
        formFactor?: 'mobile' | 'desktop'
    }
}

export type LabEvidenceLevel = 'controlled-lab-measurement' | 'runtime-observation' | 'unsupported-or-unknown'
export type LabMetricStatus = 'measured' | 'partial' | 'not-observed' | 'unsupported' | 'unknown'
export type LabMetricFamily =
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
    | 'lighthouse'

export type LabMetricStat = 'latest' | 'count' | 'sum' | 'avg' | 'min' | 'max' | 'p50' | 'p75' | 'p95' | 'p99' | 'rate' | 'ratio'
export type LabMetricUnit = 'ms' | 'count' | 'ratio' | 'bytes' | 'pixels' | 'hz' | 'frames' | 'percent' | 'score'
export type LabMetricScopeLevel = 'run' | 'attempt' | 'action' | 'subject'
export type LabMetricAggregationPopulation =
    | 'frames'
    | 'events'
    | 'tasks'
    | 'attempts'
    | 'actions'
    | 'resources'
    | 'surfaces'
    | 'animations'
    | 'media-frames'
    | 'bytes'
    | 'samples'
    | 'latest'
export type LabMetricAggregationMethod =
    | 'latest'
    | 'count'
    | 'sum'
    | 'ratio'
    | 'nearest-rank'
    | 'median-of-attempts'
    | 'arithmetic-mean'
    | 'min'
    | 'max'

export interface LabMetricScopeV2 {
    level: LabMetricScopeLevel
    /** Omitted for an aggregate of the same action across measured attempts. */
    attemptId?: string
    actionId?: string
    subjectKey?: string
}

export interface LabMetricAggregationV2 {
    population: LabMetricAggregationPopulation
    method: LabMetricAggregationMethod
}

export interface LabBudgetRefV1 {
    catalogVersion: 1
    budgetId: string
    budgetVersion: number
}

export interface LabBudgetRuleRefV1 extends LabBudgetRefV1 {
    ruleId: string
}

export type LabMeasurementSource = 'explicit' | 'observed' | 'inferred' | 'package-default' | 'unknown'
export type LabEvidenceConfidence = 'explicit' | 'high' | 'medium' | 'low' | 'unknown'

export interface LabMeasurementContractV2 {
    contractVersion: 2
    expectedHz: number
    targetFrameMs: number
    source: LabMeasurementSource
    confidence: LabEvidenceConfidence
    budgetRef: LabBudgetRefV1
    metricCatalogVersion: 1
}

export interface AnimationLabMetric {
    family: LabMetricFamily
    name: string
    stat: LabMetricStat
    unit: LabMetricUnit
    value: number | null
    samples: number | null
    status: LabMetricStatus
    evidenceLevel: LabEvidenceLevel
    /** v2 catalog identity. Names remain a closed catalog, never a custom-data channel. */
    metricId?: string
    scope?: LabMetricScopeV2
    aggregation?: LabMetricAggregationV2
    budgetRefs?: readonly LabBudgetRuleRefV1[]
    evidenceRefs?: readonly string[]
    /** Bounded machine-readable codes, not prose or DOM-derived content. */
    limitations?: readonly string[]
}

export type AnimationLabMetricV2 = AnimationLabMetric & {
    metricId: string
    scope: LabMetricScopeV2
    aggregation: LabMetricAggregationV2
    budgetRefs: readonly LabBudgetRuleRefV1[]
    evidenceRefs: readonly string[]
    limitations: readonly string[]
}

export interface LabMetricCatalogEntryV1 {
    metricId: string
    family: LabMetricFamily
    name: string
    stat: LabMetricStat
    unit: LabMetricUnit
    defaultScope: LabMetricScopeLevel
    defaultAggregation: LabMetricAggregationV2
    defaultBudgetRuleIds: readonly string[]
}

export type LabBudgetComparator = '<=' | '>=' | '<' | '>'
export type LabBudgetTargetV1 =
    | { kind: 'absolute'; value: number; unit: LabMetricUnit }
    | { kind: 'target-frame-multiple'; value: number; unit: 'ratio' }

export interface LabBudgetRuleDefinitionV1 {
    ruleId: string
    metricId: string
    comparator: LabBudgetComparator
    target: LabBudgetTargetV1
    minimumSamples: number
}

export interface LabBudgetDefinitionV1 extends LabBudgetRefV1 {
    rules: readonly LabBudgetRuleDefinitionV1[]
}

export interface LabReportScenarioActionV2 {
    actionId: string
    /** Zero-based order within the scenario. */
    order: number
    kind: LabActionKind
    label: string
    subject?: LabActionSubject
    trigger: Required<LabActionTrigger>
}

export type LabActionOutcomeStatus = 'completed' | 'cancelled' | 'failed' | 'timed-out' | 'unknown'

export interface LabActionOutcomeV2 {
    status: LabActionOutcomeStatus
    outcomeKey?: string
}

export interface LabActionTimestampsV2 {
    clock: 'attempt-monotonic'
    startedAtMs: number
    endedAtMs: number
    durationMs: number
}

export interface LabActionWindowV2 {
    actionId: string
    order: number
    kind: LabActionKind
    trigger: Required<LabActionTrigger>
    subject?: LabActionSubject
    outcome: LabActionOutcomeV2
    timestamps: LabActionTimestampsV2
    evidenceRefs: readonly string[]
    limitations: readonly string[]
}

export type LabTechnologyEvidenceSource = 'scenario-declaration' | 'runtime-probe' | 'host-adapter' | 'cdp-trace' | 'lighthouse' | 'unknown'
export type LabTechnologyEvidenceStatus = 'observed' | 'declared' | 'inferred' | 'unsupported' | 'unknown'

export interface LabTechnologyEvidenceV2 {
    evidenceId: string
    axis: LabTechnologyAxis
    technologyKey: string
    version?: string
    source: LabTechnologyEvidenceSource
    confidence: LabEvidenceConfidence
    status: LabTechnologyEvidenceStatus
    scope: LabMetricScopeV2
    actionId?: string
    limitations: readonly string[]
}

export type LabFindingSeverity = 'info' | 'warning' | 'critical'
export type LabFindingStatus = 'observed' | 'candidate' | 'not-observed' | 'unsupported'

export interface LabFindingV2 {
    findingId: string
    ruleId: string
    severity: LabFindingSeverity
    status: LabFindingStatus
    scope: LabMetricScopeV2
    metricIds: readonly string[]
    evidenceRefs: readonly string[]
    budgetRefs: readonly LabBudgetRuleRefV1[]
    actionIds: readonly string[]
    limitations: readonly string[]
}

/** Strict, selector-free semantic subset shared by runner, backend and UI. */
export interface AnimationLabSemanticsV2 {
    semanticsVersion: 2
    measurementContract: LabMeasurementContractV2
    scenarioActions: readonly LabReportScenarioActionV2[]
    actionWindows: readonly LabActionWindowV2[]
    metrics: readonly AnimationLabMetricV2[]
    technologyEvidence: readonly LabTechnologyEvidenceV2[]
    findings: readonly LabFindingV2[]
}

export type LabTimelineCategory =
    | 'interaction'
    | 'script'
    | 'style-layout'
    | 'paint'
    | 'composite'
    | 'raster-gpu'
    | 'network'
    | 'animation'
    | 'gc'
    | 'other'

export interface LabStackFrame {
    functionName: string
    /** Sanitized path or generated script token. Never contains query/hash/credentials. */
    source: string
    line: number | null
    column: number | null
}

export interface LabTimelineEvent {
    id: string
    category: LabTimelineCategory
    name: string
    startMs: number
    durationMs: number
    selfTimeMs: number | null
    thread: 'main' | 'worker' | 'raster' | 'gpu' | 'network' | 'unknown'
    stack: readonly LabStackFrame[]
    actionLabel?: string
}

export interface LabTimelineChunk {
    schemaVersion: 1
    startMs: number
    endMs: number
    totalInputEvents: number
    retainedEvents: number
    droppedEvents: number
    events: readonly LabTimelineEvent[]
    categoryDurationMs: Readonly<Record<LabTimelineCategory, number>>
}

export interface LabLighthouseAudit {
    id: string
    title: string
    score: number | null
    scoreDisplayMode: string
    numericValue: number | null
    numericUnit: string | null
    displayValue: string | null
    description: string | null
    savingsMs: number | null
    savingsBytes: number | null
}

export interface LabLighthouseSummary {
    schemaVersion: 1
    lighthouseVersion: string
    fetchTime: string
    requestedRouteKey: string
    categories: Readonly<Record<string, { title: string; score: number | null }>>
    metrics: readonly AnimationLabMetric[]
    failedAudits: readonly LabLighthouseAudit[]
    diagnostics: readonly LabLighthouseAudit[]
}

export interface LabAttemptSummary {
    attemptId: string
    phase: 'warmup' | 'measured' | 'diagnostic-trace' | 'lighthouse'
    index: number
    startedAt: string
    endedAt: string
    durationMs: number
    /** Post-navigation runner-owned observation window; absent for unavailable diagnostics. */
    observationDurationMs?: number
    metrics: readonly AnimationLabMetric[]
    capabilities: Readonly<Record<string, boolean | null>>
    limitations: readonly string[]
    actionWindows?: readonly LabActionWindowV2[]
}

export interface AnimationLabReport {
    schemaVersion: 1
    runId: string
    scenario: {
        name: string
        routeKey: string
        release: string
        dist: string
        environment: string
        viewport: { width: number; height: number; deviceScaleFactor: number }
        reducedMotion: 'no-preference' | 'reduce'
        cacheMode: 'cold' | 'warm'
        execution?: {
            warmupRuns: number
            measuredRuns: number
            durationMs?: number
            trace: boolean
            lighthouse: boolean
            colorScheme: 'light' | 'dark' | null
            cpuThrottleRate: number
            network: {
                offline?: boolean
                latencyMs?: number
                downloadBytesPerSecond?: number
                uploadBytesPerSecond?: number
            } | null
        }
        actionLabels: readonly string[]
        actions?: readonly LabReportScenarioActionV2[]
    }
    browser: { name: string; version: string; headless: boolean }
    startedAt: string
    endedAt: string
    attempts: readonly LabAttemptSummary[]
    aggregateMetrics: readonly AnimationLabMetric[]
    timeline?: LabTimelineChunk
    lighthouse?: LabLighthouseSummary
    semanticsVersion?: 2
    measurementContract?: LabMeasurementContractV2
    /** Canonical per-action windows aggregated across measured attempts. */
    actionWindows?: readonly LabActionWindowV2[]
    technologyEvidence?: readonly LabTechnologyEvidenceV2[]
    findings?: readonly LabFindingV2[]
    privacy: {
        selectorsRetained: false
        inputValuesRetained: false
        responseBodiesRetained: false
        cookiesRetained: false
        authorizationRetained: false
        screenshotsRetained: boolean
        rawTraceUploaded: false
    }
}

export interface RawTraceEvent {
    name?: unknown
    cat?: unknown
    ph?: unknown
    ts?: unknown
    dur?: unknown
    pid?: unknown
    tid?: unknown
    args?: unknown
}
