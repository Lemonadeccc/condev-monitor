import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'

export const ANIMATION_LAB_METRIC_SAMPLES_MAX = 10_000_000
export const ANIMATION_LAB_AGGREGATE_SAMPLE_OVERFLOW_LIMITATION = 'aggregate-sample-count-exceeds-contract-bound'

const MAX_ACTIONS = 100
const MAX_WINDOWS = 100
const MAX_METRICS = 256
const MAX_EVIDENCE = 256
const MAX_FINDINGS = 256
const MAX_REFS = 64
const MAX_LIMITATIONS = 32
const MAX_WINDOW_MS = 60 * 60 * 1000
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,159}$/
const EXPANDED_METRIC_KEYS = ['metricId', 'scope', 'aggregation', 'budgetRefs', 'evidenceRefs', 'limitations'] as const
type DefaultBudgetRuleDefinition = {
    ruleId: string
    metricId: string
    comparator: '<=' | '<' | '>=' | '>'
    target: { kind: 'absolute' | 'target-frame-multiple'; value: number }
    minimumSamples: number
}

const DEFAULT_BUDGET_RULES_V1: readonly DefaultBudgetRuleDefinition[] = [
    {
        ruleId: 'frame-tail',
        metricId: 'frame.duration.p95',
        comparator: '<=',
        target: { kind: 'target-frame-multiple', value: 1.5 },
        minimumSamples: 120,
    },
    {
        ruleId: 'slow-frame-rate',
        metricId: 'frame.slow-rate',
        comparator: '<=',
        target: { kind: 'absolute', value: 0.05 },
        minimumSamples: 120,
    },
    {
        ruleId: 'jank-bursts',
        metricId: 'frame.jank-bursts',
        comparator: '<=',
        target: { kind: 'absolute', value: 0 },
        minimumSamples: 120,
    },
    {
        ruleId: 'long-task-count',
        metricId: 'main.long-task.count',
        comparator: '<=',
        target: { kind: 'absolute', value: 0 },
        minimumSamples: 1,
    },
    {
        ruleId: 'input-delay',
        metricId: 'interaction.input-delay.p95',
        comparator: '<=',
        target: { kind: 'absolute', value: 100 },
        minimumSamples: 3,
    },
]
const DEFAULT_BUDGET_RULES_V2: readonly DefaultBudgetRuleDefinition[] = DEFAULT_BUDGET_RULES_V1.map(rule =>
    rule.ruleId === 'long-task-count' ? { ...rule, minimumSamples: 0 } : { ...rule }
)
const DEFAULT_BUDGET_RULES_V3: readonly DefaultBudgetRuleDefinition[] = [
    ...DEFAULT_BUDGET_RULES_V2,
    {
        ruleId: 'loaf-count',
        metricId: 'main.loaf.count',
        comparator: '<=',
        target: { kind: 'absolute', value: 0 },
        minimumSamples: 0,
    },
    {
        ruleId: 'interaction-processing-tail',
        metricId: 'interaction.processing.p95',
        comparator: '<=',
        target: { kind: 'absolute', value: 50 },
        minimumSamples: 3,
    },
    {
        ruleId: 'interaction-presentation-tail',
        metricId: 'interaction.presentation.p95',
        comparator: '<=',
        target: { kind: 'absolute', value: 100 },
        minimumSamples: 3,
    },
    {
        ruleId: 'page-lcp',
        metricId: 'vital.lcp.latest',
        comparator: '<=',
        target: { kind: 'absolute', value: 2_500 },
        minimumSamples: 1,
    },
    {
        ruleId: 'page-cls',
        metricId: 'vital.cls.latest',
        comparator: '<=',
        target: { kind: 'absolute', value: 0.1 },
        minimumSamples: 1,
    },
    {
        ruleId: 'lighthouse-first-contentful-paint',
        metricId: 'lighthouse.fcp.latest',
        comparator: '<=',
        target: { kind: 'absolute', value: 1_800 },
        minimumSamples: 1,
    },
    {
        ruleId: 'lighthouse-total-blocking-time',
        metricId: 'lighthouse.total-blocking-time.latest',
        comparator: '<=',
        target: { kind: 'absolute', value: 200 },
        minimumSamples: 1,
    },
]
const DEFAULT_BUDGET_RULES_BY_VERSION = new Map<number, readonly DefaultBudgetRuleDefinition[]>([
    [1, DEFAULT_BUDGET_RULES_V1],
    [2, DEFAULT_BUDGET_RULES_V2],
    [3, DEFAULT_BUDGET_RULES_V3],
])
const DEFAULT_BUDGET_RULE_METRICS_BY_VERSION = new Map<number, Readonly<Record<string, string>>>(
    [...DEFAULT_BUDGET_RULES_BY_VERSION].map(([version, rules]) => [
        version,
        Object.freeze(Object.fromEntries(rules.map(rule => [rule.ruleId, rule.metricId]))),
    ])
)
const DEFAULT_BUDGET_ID = 'condev.animation.default'

function defaultBudgetRuleDefinitions(ref: {
    budgetId: string
    budgetVersion: number
}): readonly DefaultBudgetRuleDefinition[] | undefined {
    return ref.budgetId === DEFAULT_BUDGET_ID ? DEFAULT_BUDGET_RULES_BY_VERSION.get(ref.budgetVersion) : undefined
}

function defaultBudgetRules(ref: { budgetId: string; budgetVersion: number }): Readonly<Record<string, string>> | undefined {
    return ref.budgetId === DEFAULT_BUDGET_ID ? DEFAULT_BUDGET_RULE_METRICS_BY_VERSION.get(ref.budgetVersion) : undefined
}

function isKnownDefaultBudget(ref: { budgetId: string; budgetVersion: number }): boolean {
    return defaultBudgetRules(ref) !== undefined
}

const ACTION_KINDS = ['wait', 'click', 'hover', 'pointer-path', 'scroll', 'resize', 'drag', 'press'] as const
const SUBJECT_SCOPES = ['page', 'route', 'frame', 'subject', 'renderer-surface', 'media'] as const
const SUBJECT_SURFACES = ['dom', 'svg', 'canvas2d', 'webgl', 'webgl2', 'webgpu', 'video', 'audio', 'unknown'] as const
const TRIGGER_SOURCES = [
    'scenario',
    'manual',
    'auto-discovery',
    'replay',
    'browser',
    'framework-adapter',
    'renderer-adapter',
    'unknown',
] as const
const MEASUREMENT_SOURCES = ['explicit', 'observed', 'inferred', 'package-default', 'unknown'] as const
const CONFIDENCES = ['explicit', 'high', 'medium', 'low', 'unknown'] as const
const SCOPE_LEVELS = ['run', 'attempt', 'action', 'subject'] as const
const AGGREGATION_POPULATIONS = [
    'frames',
    'events',
    'tasks',
    'attempts',
    'actions',
    'resources',
    'surfaces',
    'animations',
    'media-frames',
    'bytes',
    'samples',
    'latest',
] as const
const AGGREGATION_METHODS = [
    'latest',
    'count',
    'sum',
    'ratio',
    'nearest-rank',
    'median-of-attempts',
    'arithmetic-mean',
    'min',
    'max',
] as const
const METRIC_FAMILIES = [
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
    'lighthouse',
] as const
const METRIC_STATS = ['latest', 'count', 'sum', 'avg', 'min', 'max', 'p50', 'p75', 'p95', 'p99', 'rate', 'ratio'] as const
const METRIC_UNITS = ['ms', 'count', 'ratio', 'bytes', 'pixels', 'hz', 'frames', 'percent', 'score'] as const
const METRIC_STATUSES = ['measured', 'partial', 'not-observed', 'unsupported', 'unknown'] as const
const EVIDENCE_LEVELS = ['controlled-lab-measurement', 'runtime-observation', 'unsupported-or-unknown'] as const
const TECHNOLOGY_AXES = ['ui-framework', 'meta-runtime', 'motion-engine', 'renderer', 'graphics-api', 'media', 'browser-runtime'] as const
const TECHNOLOGY_SOURCES = ['scenario-declaration', 'runtime-probe', 'host-adapter', 'cdp-trace', 'lighthouse', 'unknown'] as const
const TECHNOLOGY_STATUSES = ['observed', 'declared', 'inferred', 'unsupported', 'unknown'] as const
const OUTCOME_STATUSES = ['completed', 'cancelled', 'failed', 'timed-out', 'unknown'] as const
const FINDING_SEVERITIES = ['info', 'warning', 'critical'] as const
const FINDING_STATUSES = ['observed', 'candidate', 'not-observed', 'unsupported'] as const

// cspell:ignore innertext outerhtml inputvalue
const FORBIDDEN_SEMANTIC_KEYS = new Set([
    'selector',
    'selectors',
    'dom',
    'element',
    'elements',
    'node',
    'nodes',
    'text',
    'innertext',
    'outerhtml',
    'html',
    'url',
    'href',
    'src',
    'class',
    'classname',
    'attributes',
    'keyframes',
    'inputvalue',
    'credential',
    'credentials',
    'authorization',
    'cookie',
    'cookies',
    'password',
    'username',
])

type ActionKind = (typeof ACTION_KINDS)[number]
type SubjectScope = (typeof SUBJECT_SCOPES)[number]
type SubjectSurface = (typeof SUBJECT_SURFACES)[number]
type TriggerSource = (typeof TRIGGER_SOURCES)[number]
type EvidenceConfidence = (typeof CONFIDENCES)[number]
type MetricScopeLevel = (typeof SCOPE_LEVELS)[number]
type AggregationPopulation = (typeof AGGREGATION_POPULATIONS)[number]
type AggregationMethod = (typeof AGGREGATION_METHODS)[number]
type MetricFamily = (typeof METRIC_FAMILIES)[number]
type MetricStat = (typeof METRIC_STATS)[number]
type MetricUnit = (typeof METRIC_UNITS)[number]
type MetricStatus = (typeof METRIC_STATUSES)[number]
type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number]
type MetricCatalogVersion = 1 | 2 | 3

export type LabMetricScopeV2Projection = {
    level: MetricScopeLevel
    attemptId?: string
    actionId?: string
    subjectKey?: string
}

export type LabBudgetRefV1Projection = {
    catalogVersion: 1
    budgetId: string
    budgetVersion: number
}

export type LabBudgetRuleRefV1Projection = LabBudgetRefV1Projection & { ruleId: string }

export type AnimationLabMetricV2Projection = {
    family: MetricFamily
    name: string
    stat: MetricStat
    unit: MetricUnit
    value: number | null
    samples: number | null
    status: MetricStatus
    evidenceLevel: EvidenceLevel
    metricId: string
    scope: LabMetricScopeV2Projection
    aggregation: { population: AggregationPopulation; method: AggregationMethod }
    budgetRefs: LabBudgetRuleRefV1Projection[]
    evidenceRefs: string[]
    limitations: string[]
}

type ActionSubject = {
    scope: SubjectScope
    subjectKey?: string
    role?: string
    surface?: SubjectSurface
}

type ScenarioAction = {
    actionId: string
    order: number
    kind: ActionKind
    label: string
    subject?: ActionSubject
    trigger: { source: TriggerSource }
}

type ActionWindow = {
    actionId: string
    order: number
    kind: ActionKind
    trigger: { source: TriggerSource }
    subject?: ActionSubject
    outcome: { status: (typeof OUTCOME_STATUSES)[number]; outcomeKey?: string }
    timestamps: { clock: 'attempt-monotonic'; startedAtMs: number; endedAtMs: number; durationMs: number }
    evidenceRefs: string[]
    limitations: string[]
}

type TechnologyEvidence = {
    evidenceId: string
    axis: (typeof TECHNOLOGY_AXES)[number]
    technologyKey: string
    version?: string
    source: (typeof TECHNOLOGY_SOURCES)[number]
    confidence: EvidenceConfidence
    status: (typeof TECHNOLOGY_STATUSES)[number]
    scope: LabMetricScopeV2Projection
    actionId?: string
    limitations: string[]
}

type Finding = {
    findingId: string
    ruleId: string
    severity: (typeof FINDING_SEVERITIES)[number]
    status: (typeof FINDING_STATUSES)[number]
    scope: LabMetricScopeV2Projection
    metricIds: string[]
    evidenceRefs: string[]
    budgetRefs: LabBudgetRuleRefV1Projection[]
    actionIds: string[]
    limitations: string[]
}

export type AnimationLabSemanticsV2 = {
    semanticsVersion: 2
    measurementContract: {
        contractVersion: 2
        expectedHz: number
        targetFrameMs: number
        source: (typeof MEASUREMENT_SOURCES)[number]
        confidence: EvidenceConfidence
        budgetRef: LabBudgetRefV1Projection
        metricCatalogVersion: MetricCatalogVersion
    }
    scenarioActions: ScenarioAction[]
    actionWindows: ActionWindow[]
    metrics: AnimationLabMetricV2Projection[]
    technologyEvidence: TechnologyEvidence[]
    findings: Finding[]
}

type RecordValue = Record<string, unknown>

function hasExpandedMetricFields(value: RecordValue): boolean {
    return EXPANDED_METRIC_KEYS.some(key => Object.prototype.hasOwnProperty.call(value, key))
}

function record(value: unknown, label: string): RecordValue {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new BadRequestException(`${label} must be a plain object`)
    }
    return value as RecordValue
}

function exactKeys(value: RecordValue, allowed: readonly string[], label: string): void {
    const allowedSet = new Set(allowed)
    const unknown = Object.keys(value).find(key => !allowedSet.has(key))
    if (unknown) throw new BadRequestException(`${label} contains unsupported field: ${unknown}`)
}

function boundedArray(value: unknown, label: string, maximumLength: number): unknown[] {
    if (!Array.isArray(value)) throw new BadRequestException(`${label} must be an array`)
    if (value.length > maximumLength) throw new PayloadTooLargeException(`${label} exceeds ${maximumLength} entries`)
    return value
}

function stringToken(value: unknown, label: string, maximumLength = 160): string {
    if (typeof value !== 'string' || !value || value.length > maximumLength || !SAFE_TOKEN.test(value)) {
        throw new BadRequestException(`Invalid ${label}`)
    }
    return value
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
        throw new BadRequestException(`Invalid ${label}`)
    }
    return value
}

function nullableFinite(value: unknown, label: string, minimum: number, maximum: number): number | null {
    return value === null ? null : finite(value, label, minimum, maximum)
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
    const parsed = finite(value, label, minimum, maximum)
    if (!Number.isInteger(parsed)) throw new BadRequestException(`Invalid ${label}`)
    return parsed
}

function enumeration<T extends string>(value: unknown, label: string, choices: readonly T[]): T {
    if (typeof value !== 'string' || !choices.includes(value as T)) throw new BadRequestException(`Invalid ${label}`)
    return value as T
}

function tokenArray(value: unknown, label: string, maximumLength = MAX_REFS): string[] {
    const parsed = boundedArray(value, label, maximumLength).map((item, index) => stringToken(item, `${label}[${index}]`))
    if (new Set(parsed).size !== parsed.length) throw new BadRequestException(`${label} contains duplicate entries`)
    return parsed
}

function rejectForbiddenKeys(value: unknown, depth = 0): void {
    if (depth > 10) throw new BadRequestException('animation-report v2 semantic fields exceed the nesting limit')
    if (Array.isArray(value)) {
        value.forEach(item => rejectForbiddenKeys(item, depth + 1))
        return
    }
    if (!value || typeof value !== 'object') return
    const raw = value as Record<string, unknown>
    for (const [key, child] of Object.entries(raw)) {
        if (FORBIDDEN_SEMANTIC_KEYS.has(key.toLowerCase())) {
            throw new BadRequestException('animation-report v2 contains a forbidden privacy field')
        }
        rejectForbiddenKeys(child, depth + 1)
    }
}

function subject(value: unknown, label: string): ActionSubject {
    const raw = record(value, label)
    exactKeys(raw, ['scope', 'subjectKey', 'role', 'surface'], label)
    const scope = enumeration(raw.scope, `${label}.scope`, SUBJECT_SCOPES)
    const subjectKey = raw.subjectKey === undefined ? undefined : stringToken(raw.subjectKey, `${label}.subjectKey`, 128)
    if (['subject', 'renderer-surface', 'media'].includes(scope) && subjectKey === undefined) {
        throw new BadRequestException(`${label} requires subjectKey`)
    }
    return {
        scope,
        ...(subjectKey ? { subjectKey } : {}),
        ...(raw.role === undefined ? {} : { role: stringToken(raw.role, `${label}.role`, 80) }),
        ...(raw.surface === undefined ? {} : { surface: enumeration(raw.surface, `${label}.surface`, SUBJECT_SURFACES) }),
    }
}

function trigger(value: unknown, label: string): { source: TriggerSource } {
    const raw = record(value, label)
    exactKeys(raw, ['source'], label)
    return { source: enumeration(raw.source, `${label}.source`, TRIGGER_SOURCES) }
}

function metricScope(value: unknown, label: string): LabMetricScopeV2Projection {
    const raw = record(value, label)
    exactKeys(raw, ['level', 'attemptId', 'actionId', 'subjectKey'], label)
    const level = enumeration(raw.level, `${label}.level`, SCOPE_LEVELS)
    const attemptId = raw.attemptId === undefined ? undefined : stringToken(raw.attemptId, `${label}.attemptId`, 120)
    const actionId = raw.actionId === undefined ? undefined : stringToken(raw.actionId, `${label}.actionId`, 120)
    const subjectKey = raw.subjectKey === undefined ? undefined : stringToken(raw.subjectKey, `${label}.subjectKey`, 128)
    if (level === 'run' && (attemptId || actionId || subjectKey)) throw new BadRequestException(`${label} run scope has narrow references`)
    if (level === 'attempt' && (!attemptId || actionId || subjectKey)) throw new BadRequestException(`Invalid ${label} attempt scope`)
    if (level === 'action' && (!actionId || subjectKey)) throw new BadRequestException(`Invalid ${label} action scope`)
    if (level === 'subject' && !subjectKey) throw new BadRequestException(`${label} subject scope requires subjectKey`)
    return {
        level,
        ...(attemptId ? { attemptId } : {}),
        ...(actionId ? { actionId } : {}),
        ...(subjectKey ? { subjectKey } : {}),
    }
}

function budgetRef(value: unknown, label: string, requireRule: false): LabBudgetRefV1Projection
function budgetRef(value: unknown, label: string, requireRule: true): LabBudgetRuleRefV1Projection
function budgetRef(value: unknown, label: string, requireRule: boolean): LabBudgetRefV1Projection | LabBudgetRuleRefV1Projection {
    const raw = record(value, label)
    exactKeys(
        raw,
        requireRule ? ['catalogVersion', 'budgetId', 'budgetVersion', 'ruleId'] : ['catalogVersion', 'budgetId', 'budgetVersion'],
        label
    )
    if (raw.catalogVersion !== 1) throw new BadRequestException(`Invalid ${label}.catalogVersion`)
    const parsed = {
        catalogVersion: 1 as const,
        budgetId: stringToken(raw.budgetId, `${label}.budgetId`, 120),
        budgetVersion: integer(raw.budgetVersion, `${label}.budgetVersion`, 1, 10_000),
    }
    if (!requireRule) return parsed
    const ruleId = stringToken(raw.ruleId, `${label}.ruleId`, 120)
    if (isKnownDefaultBudget(parsed) && !defaultBudgetRules(parsed)?.[ruleId]) {
        throw new BadRequestException(`${label} references an unknown canonical budget rule`)
    }
    return { ...parsed, ruleId }
}

function measurementContract(value: unknown): AnimationLabSemanticsV2['measurementContract'] {
    const label = 'animation-report.measurementContract'
    const raw = record(value, label)
    exactKeys(raw, ['contractVersion', 'expectedHz', 'targetFrameMs', 'source', 'confidence', 'budgetRef', 'metricCatalogVersion'], label)
    if (raw.contractVersion !== 2) throw new BadRequestException(`Invalid ${label}.contractVersion`)
    const expectedHz = finite(raw.expectedHz, `${label}.expectedHz`, 1, 1_000)
    const targetFrameMs = finite(raw.targetFrameMs, `${label}.targetFrameMs`, 1, 1_000)
    if (Math.abs(targetFrameMs - 1_000 / expectedHz) > Math.max(0.05, (1_000 / expectedHz) * 0.01)) {
        throw new BadRequestException(`${label} has an inconsistent frame target`)
    }
    const source = enumeration(raw.source, `${label}.source`, MEASUREMENT_SOURCES)
    const confidence = enumeration(raw.confidence, `${label}.confidence`, CONFIDENCES)
    if (source === 'explicit' && confidence !== 'explicit')
        throw new BadRequestException(`${label} explicit source requires explicit confidence`)
    if (raw.metricCatalogVersion !== 1 && raw.metricCatalogVersion !== 2 && raw.metricCatalogVersion !== 3) {
        throw new BadRequestException(`Invalid ${label}.metricCatalogVersion`)
    }
    return {
        contractVersion: 2,
        expectedHz,
        targetFrameMs,
        source,
        confidence,
        budgetRef: budgetRef(raw.budgetRef, `${label}.budgetRef`, false),
        metricCatalogVersion: raw.metricCatalogVersion,
    }
}

const METRIC_CATALOG = new Map<string, readonly [MetricFamily, string, MetricStat, MetricUnit]>([
    ['frame.duration.p50', ['frameCadence', 'frameDurationMs', 'p50', 'ms']],
    ['frame.duration.p95', ['frameCadence', 'frameDurationMs', 'p95', 'ms']],
    ['frame.duration.p99', ['frameCadence', 'frameDurationMs', 'p99', 'ms']],
    ['frame.target.latest', ['frameCadence', 'targetFrameMs', 'latest', 'ms']],
    ['frame.refresh.inferred', ['frameCadence', 'inferredRefreshHz', 'latest', 'hz']],
    ['frame.slow-rate', ['frameCadence', 'slowFrameRate', 'ratio', 'ratio']],
    ['frame.jank-bursts', ['frameCadence', 'jankBurstCount', 'count', 'count']],
    ['frame.longest-slow-run', ['frameCadence', 'longestSlowFrameRun', 'max', 'frames']],
    ['frame.missed-opportunities', ['frameCadence', 'missedFrameOpportunities', 'sum', 'frames']],
    ['main.long-task.count', ['mainThread', 'longTaskCount', 'count', 'count']],
    ['main.long-task.duration.p95', ['mainThread', 'longTaskDurationMs', 'p95', 'ms']],
    ['main.long-task.duration.sum', ['mainThread', 'longTaskDurationMs', 'sum', 'ms']],
    ['main.loaf.count', ['mainThread', 'longAnimationFrameCount', 'count', 'count']],
    ['main.loaf.duration.p95', ['mainThread', 'longAnimationFrameDurationMs', 'p95', 'ms']],
    ['main.loaf.blocking.p95', ['mainThread', 'longAnimationFrameBlockingMs', 'p95', 'ms']],
    ['pipeline.loaf-style-layout-tail.p95', ['renderingPipeline', 'longAnimationFrameStyleLayoutTailMs', 'p95', 'ms']],
    ['interaction.event-duration.p95', ['userOutcome', 'eventTimingDurationMs', 'p95', 'ms']],
    ['interaction.input-delay.p95', ['userOutcome', 'inputDelayMs', 'p95', 'ms']],
    ['interaction.processing.p95', ['userOutcome', 'processingDurationMs', 'p95', 'ms']],
    ['interaction.presentation.p95', ['renderingPipeline', 'presentationDelayMs', 'p95', 'ms']],
    ['interaction.count', ['userOutcome', 'interactionCount', 'count', 'count']],
    ['vital.cls.latest', ['userOutcome', 'CLS', 'latest', 'score']],
    ['vital.lcp.latest', ['userOutcome', 'LCP', 'latest', 'ms']],
    ['resource.count', ['resourcesMedia', 'resourceCount', 'count', 'count']],
    ['resource.duration.p95', ['resourcesMedia', 'resourceDurationMs', 'p95', 'ms']],
    ['resource.transfer.sum', ['resourcesMedia', 'transferSizeBytes', 'sum', 'bytes']],
    ['resource.encoded.sum', ['resourcesMedia', 'encodedBodySizeBytes', 'sum', 'bytes']],
    ['resource.decoded.sum', ['resourcesMedia', 'decodedBodySizeBytes', 'sum', 'bytes']],
    ['animation.running.count', ['motionQuality', 'runningAnimations', 'count', 'count']],
    ['animation.infinite.count', ['motionQuality', 'infiniteAnimations', 'count', 'count']],
    ['accessibility.reduced-motion-active.count', ['accessibility', 'reducedMotionActiveAnimationCandidates', 'count', 'count']],
    ['surface.canvas.count', ['renderer', 'canvasSurfaces', 'count', 'count']],
    ['surface.svg.count', ['renderer', 'svgSurfaces', 'count', 'count']],
    ['surface.canvas2d.count', ['renderer', 'canvas2dSurfaces', 'count', 'count']],
    ['surface.webgl.count', ['renderer', 'webglSurfaces', 'count', 'count']],
    ['surface.webgpu.count', ['renderer', 'webgpuSurfaces', 'count', 'count']],
    ['surface.canvas-unknown.count', ['renderer', 'unknownCanvasSurfaces', 'count', 'count']],
    ['surface.backing-pixels.sum', ['renderer', 'backingStorePixels', 'sum', 'pixels']],
    ['media.video-elements.count', ['resourcesMedia', 'videoElementCount', 'count', 'count']],
    ['media.video-dropped-frame-rate', ['resourcesMedia', 'videoDroppedFrameRate', 'ratio', 'ratio']],
    ['media.video-window-dropped-frame-rate', ['resourcesMedia', 'videoWindowDroppedFrameRate', 'ratio', 'ratio']],
    ['memory.js-heap.latest', ['memoryLifecycle', 'usedJsHeapBytes', 'latest', 'bytes']],
    ['probe.dropped-samples.count', ['monitorOverhead', 'droppedProbeSamples', 'count', 'count']],
    ['probe.report-build.latest', ['monitorOverhead', 'reportBuildSelfTimeMs', 'latest', 'ms']],
    ['trace.interaction.duration', ['scrollGesture', 'trace.interaction.durationMs', 'sum', 'ms']],
    ['trace.script.duration', ['mainThread', 'trace.script.durationMs', 'sum', 'ms']],
    ['trace.style-layout.duration', ['renderingPipeline', 'trace.style-layout.durationMs', 'sum', 'ms']],
    ['trace.paint.duration', ['renderingPipeline', 'trace.paint.durationMs', 'sum', 'ms']],
    ['trace.composite.duration', ['renderingPipeline', 'trace.composite.durationMs', 'sum', 'ms']],
    ['trace.raster-gpu.duration', ['renderer', 'trace.raster-gpu.durationMs', 'sum', 'ms']],
    ['trace.network.duration', ['resourcesMedia', 'trace.network.durationMs', 'sum', 'ms']],
    ['trace.animation.duration', ['mainThread', 'trace.animation.durationMs', 'sum', 'ms']],
    ['trace.gc.duration', ['mainThread', 'trace.gc.durationMs', 'sum', 'ms']],
    ['trace.other.duration', ['mainThread', 'trace.other.durationMs', 'sum', 'ms']],
    ['lighthouse.performance.score', ['lighthouse', 'performanceScore', 'latest', 'score']],
    ['lighthouse.accessibility.score', ['lighthouse', 'accessibilityScore', 'latest', 'score']],
    ['lighthouse.best-practices.score', ['lighthouse', 'best-practicesScore', 'latest', 'score']],
    ['lighthouse.seo.score', ['lighthouse', 'seoScore', 'latest', 'score']],
    ['lighthouse.fcp.latest', ['lighthouse', 'FCP', 'latest', 'ms']],
    ['lighthouse.lcp.latest', ['lighthouse', 'LCP', 'latest', 'ms']],
    ['lighthouse.cls.latest', ['userOutcome', 'CLS', 'latest', 'score']],
    ['lighthouse.speed-index.latest', ['lighthouse', 'speedIndex', 'latest', 'ms']],
    ['lighthouse.total-blocking-time.latest', ['lighthouse', 'totalBlockingTime', 'latest', 'ms']],
    ['lighthouse.tti.latest', ['lighthouse', 'timeToInteractive', 'latest', 'ms']],
    ['pipeline.loaf-render-start-to-paint.count', ['renderingPipeline', 'longAnimationFrameRenderStartToPaintCount', 'count', 'count']],
    ['pipeline.loaf-render-start-to-paint.p95', ['renderingPipeline', 'longAnimationFrameRenderStartToPaintMs', 'p95', 'ms']],
    ['pipeline.loaf-paint-to-presentation.count', ['renderingPipeline', 'longAnimationFramePaintToPresentationCount', 'count', 'count']],
    ['pipeline.loaf-paint-to-presentation.p95', ['renderingPipeline', 'longAnimationFramePaintToPresentationMs', 'p95', 'ms']],
    ['main.input-capture-to-next-raf-callback.count', ['mainThread', 'inputCaptureToNextRafCallbackCount', 'count', 'count']],
    ['main.input-capture-to-next-raf-callback.p95', ['mainThread', 'inputCaptureToNextRafCallbackMs', 'p95', 'ms']],
    [
        'interaction.loaf-first-ui-event-to-frame-end.count',
        ['userOutcome', 'longAnimationFrameFirstUIEventToFrameEndCount', 'count', 'count'],
    ],
    ['interaction.loaf-first-ui-event-to-frame-end.p95', ['userOutcome', 'longAnimationFrameFirstUIEventToFrameEndMs', 'p95', 'ms']],
    [
        'pipeline.loaf-attributed-forced-style-layout.count',
        ['renderingPipeline', 'longAnimationFrameAttributedForcedStyleAndLayoutCount', 'count', 'count'],
    ],
    [
        'pipeline.loaf-attributed-forced-style-layout.p95',
        ['renderingPipeline', 'longAnimationFrameAttributedForcedStyleAndLayoutMs', 'p95', 'ms'],
    ],
])

const METRIC_CATALOG_V2_ONLY = new Set([
    'pipeline.loaf-render-start-to-paint.count',
    'pipeline.loaf-render-start-to-paint.p95',
    'pipeline.loaf-paint-to-presentation.count',
    'pipeline.loaf-paint-to-presentation.p95',
    'main.input-capture-to-next-raf-callback.count',
    'main.input-capture-to-next-raf-callback.p95',
    'interaction.loaf-first-ui-event-to-frame-end.count',
    'interaction.loaf-first-ui-event-to-frame-end.p95',
    'pipeline.loaf-attributed-forced-style-layout.count',
    'pipeline.loaf-attributed-forced-style-layout.p95',
])

const METRIC_CATALOG_V3_ONLY = new Set(['media.video-window-dropped-frame-rate'])

export function assertAnimationLabMetricCatalogTupleV2(
    value: { metricId: string; family: string; name: string; stat: string; unit: string },
    label: string,
    metricCatalogVersion: MetricCatalogVersion = 3
): void {
    const catalog = METRIC_CATALOG.get(value.metricId)
    if (!catalog) throw new BadRequestException(`${label} references an unknown metricId`)
    if (metricCatalogVersion === 1 && METRIC_CATALOG_V2_ONLY.has(value.metricId)) {
        throw new BadRequestException(`${label} requires metric catalog v2`)
    }
    if (metricCatalogVersion < 3 && METRIC_CATALOG_V3_ONLY.has(value.metricId)) {
        throw new BadRequestException(`${label} requires metric catalog v3`)
    }
    if (value.family !== catalog[0] || value.name !== catalog[1] || value.stat !== catalog[2] || value.unit !== catalog[3]) {
        throw new BadRequestException(`${label} does not match the canonical metric catalog`)
    }
}

export function parseAnimationLabMetricV2(
    value: unknown,
    label: string,
    metricCatalogVersion: MetricCatalogVersion = 3
): AnimationLabMetricV2Projection {
    const raw = record(value, label)
    exactKeys(
        raw,
        [
            'family',
            'name',
            'stat',
            'unit',
            'value',
            'samples',
            'status',
            'evidenceLevel',
            'metricId',
            'scope',
            'aggregation',
            'budgetRefs',
            'evidenceRefs',
            'limitations',
        ],
        label
    )
    const metricId = stringToken(raw.metricId, `${label}.metricId`)
    const family = enumeration(raw.family, `${label}.family`, METRIC_FAMILIES)
    const name = stringToken(raw.name, `${label}.name`)
    const stat = enumeration(raw.stat, `${label}.stat`, METRIC_STATS)
    const unit = enumeration(raw.unit, `${label}.unit`, METRIC_UNITS)
    assertAnimationLabMetricCatalogTupleV2({ metricId, family, name, stat, unit }, label, metricCatalogVersion)
    const status = enumeration(raw.status, `${label}.status`, METRIC_STATUSES)
    const valueNumber = nullableFinite(raw.value, `${label}.value`, 0, Number.MAX_VALUE)
    if ((status === 'measured' || status === 'partial') && valueNumber === null) {
        throw new BadRequestException(`${label} measured status requires a value`)
    }
    if (status !== 'measured' && status !== 'partial' && valueNumber !== null) {
        throw new BadRequestException(`${label} unavailable status requires a null value`)
    }
    const evidenceLevel = enumeration(raw.evidenceLevel, `${label}.evidenceLevel`, EVIDENCE_LEVELS)
    const unavailableEvidence = status === 'unsupported' || status === 'unknown'
    if (
        (!unavailableEvidence && evidenceLevel === 'unsupported-or-unknown') ||
        (metricCatalogVersion >= 2 && unavailableEvidence !== (evidenceLevel === 'unsupported-or-unknown'))
    ) {
        throw new BadRequestException(`${label} status conflicts with evidenceLevel`)
    }
    const aggregationRaw = record(raw.aggregation, `${label}.aggregation`)
    exactKeys(aggregationRaw, ['population', 'method'], `${label}.aggregation`)
    const scope = metricScope(raw.scope, `${label}.scope`)
    const aggregation = {
        population: enumeration(aggregationRaw.population, `${label}.aggregation.population`, AGGREGATION_POPULATIONS),
        method: enumeration(aggregationRaw.method, `${label}.aggregation.method`, AGGREGATION_METHODS),
    }
    if (scope.level === 'action' && scope.attemptId === undefined && aggregation.method !== 'median-of-attempts') {
        throw new BadRequestException(`${label} aggregate action scope requires median-of-attempts`)
    }
    const budgetRefs = boundedArray(raw.budgetRefs, `${label}.budgetRefs`, 8).map((item, index) =>
        budgetRef(item, `${label}.budgetRefs[${index}]`, true)
    )
    for (const ref of budgetRefs) {
        if (isKnownDefaultBudget(ref) && defaultBudgetRules(ref)?.[ref.ruleId] !== metricId) {
            throw new BadRequestException(`${label} budget rule does not apply to metricId`)
        }
    }
    const samples = raw.samples === null ? null : integer(raw.samples, `${label}.samples`, 0, ANIMATION_LAB_METRIC_SAMPLES_MAX)
    const evidenceRefs = tokenArray(raw.evidenceRefs, `${label}.evidenceRefs`)
    const limitations = tokenArray(raw.limitations, `${label}.limitations`, MAX_LIMITATIONS)
    if (metricId === 'media.video-window-dropped-frame-rate') {
        const required = [
            'video-playback-quality-window-counter-delta',
            'video-playback-quality-total-includes-displayed-and-dropped',
            'video-playback-quality-window-object-identity-only',
            'video-playback-quality-not-decode-presentation-or-gpu-timing',
        ]
        if (scope.level !== 'action' || required.some(limitation => !limitations.includes(limitation))) {
            throw new BadRequestException(`${label} has an invalid video window evidence contract`)
        }
        if ((status === 'measured' || status === 'partial') && (samples === null || samples <= 0)) {
            throw new BadRequestException(`${label} video window measurement requires a positive frame delta`)
        }
        if (
            scope.attemptId !== undefined &&
            status === 'partial' &&
            !limitations.includes('video-playback-quality-window-partial-surface-coverage')
        ) {
            throw new BadRequestException(`${label} partial video window evidence must disclose incomplete surface coverage`)
        }
        if (
            status === 'not-observed' &&
            !limitations.includes('video-playback-quality-window-no-video-elements') &&
            !limitations.includes('video-playback-quality-window-zero-total-frame-delta')
        ) {
            throw new BadRequestException(`${label} not-observed video window evidence must disclose its empty population`)
        }
        if (status === 'unknown' && !limitations.includes('video-playback-quality-window-coverage-unavailable')) {
            throw new BadRequestException(`${label} unknown video window evidence must disclose unavailable coverage`)
        }
        if (status === 'unsupported' && !limitations.includes('video-playback-quality-api-unsupported')) {
            throw new BadRequestException(`${label} unsupported video window evidence must disclose API support`)
        }
    }
    return {
        family,
        name,
        stat,
        unit,
        value: valueNumber,
        samples,
        status,
        evidenceLevel,
        metricId,
        scope,
        aggregation,
        budgetRefs,
        evidenceRefs,
        limitations,
    }
}

function scenarioAction(value: unknown, index: number): ScenarioAction {
    const label = `animation-report.scenario.actions[${index}]`
    const raw = record(value, label)
    exactKeys(raw, ['actionId', 'order', 'kind', 'label', 'subject', 'trigger'], label)
    return {
        actionId: stringToken(raw.actionId, `${label}.actionId`, 120),
        order: integer(raw.order, `${label}.order`, 0, MAX_ACTIONS - 1),
        kind: enumeration(raw.kind, `${label}.kind`, ACTION_KINDS),
        label: stringToken(raw.label, `${label}.label`, 120),
        ...(raw.subject === undefined ? {} : { subject: subject(raw.subject, `${label}.subject`) }),
        trigger: trigger(raw.trigger, `${label}.trigger`),
    }
}

function actionWindow(value: unknown, label: string): ActionWindow {
    const raw = record(value, label)
    exactKeys(raw, ['actionId', 'order', 'kind', 'trigger', 'subject', 'outcome', 'timestamps', 'evidenceRefs', 'limitations'], label)
    const outcomeRaw = record(raw.outcome, `${label}.outcome`)
    exactKeys(outcomeRaw, ['status', 'outcomeKey'], `${label}.outcome`)
    const timestampsRaw = record(raw.timestamps, `${label}.timestamps`)
    exactKeys(timestampsRaw, ['clock', 'startedAtMs', 'endedAtMs', 'durationMs'], `${label}.timestamps`)
    if (timestampsRaw.clock !== 'attempt-monotonic') throw new BadRequestException(`Invalid ${label}.timestamps.clock`)
    const startedAtMs = finite(timestampsRaw.startedAtMs, `${label}.timestamps.startedAtMs`, 0, MAX_WINDOW_MS)
    const endedAtMs = finite(timestampsRaw.endedAtMs, `${label}.timestamps.endedAtMs`, 0, MAX_WINDOW_MS)
    const durationMs = finite(timestampsRaw.durationMs, `${label}.timestamps.durationMs`, 0, MAX_WINDOW_MS)
    if (endedAtMs < startedAtMs || Math.abs(endedAtMs - startedAtMs - durationMs) > 0.01) {
        throw new BadRequestException(`${label}.timestamps are inconsistent`)
    }
    return {
        actionId: stringToken(raw.actionId, `${label}.actionId`, 120),
        order: integer(raw.order, `${label}.order`, 0, MAX_ACTIONS - 1),
        kind: enumeration(raw.kind, `${label}.kind`, ACTION_KINDS),
        trigger: trigger(raw.trigger, `${label}.trigger`),
        ...(raw.subject === undefined ? {} : { subject: subject(raw.subject, `${label}.subject`) }),
        outcome: {
            status: enumeration(outcomeRaw.status, `${label}.outcome.status`, OUTCOME_STATUSES),
            ...(outcomeRaw.outcomeKey === undefined
                ? {}
                : { outcomeKey: stringToken(outcomeRaw.outcomeKey, `${label}.outcome.outcomeKey`, 120) }),
        },
        timestamps: { clock: 'attempt-monotonic', startedAtMs, endedAtMs, durationMs },
        evidenceRefs: tokenArray(raw.evidenceRefs, `${label}.evidenceRefs`),
        limitations: tokenArray(raw.limitations, `${label}.limitations`, MAX_LIMITATIONS),
    }
}

function technologyEvidence(value: unknown, index: number): TechnologyEvidence {
    const label = `animation-report.technologyEvidence[${index}]`
    const raw = record(value, label)
    exactKeys(
        raw,
        ['evidenceId', 'axis', 'technologyKey', 'version', 'source', 'confidence', 'status', 'scope', 'actionId', 'limitations'],
        label
    )
    return {
        evidenceId: stringToken(raw.evidenceId, `${label}.evidenceId`),
        axis: enumeration(raw.axis, `${label}.axis`, TECHNOLOGY_AXES),
        technologyKey: stringToken(raw.technologyKey, `${label}.technologyKey`, 120),
        ...(raw.version === undefined ? {} : { version: stringToken(raw.version, `${label}.version`, 80) }),
        source: enumeration(raw.source, `${label}.source`, TECHNOLOGY_SOURCES),
        confidence: enumeration(raw.confidence, `${label}.confidence`, CONFIDENCES),
        status: enumeration(raw.status, `${label}.status`, TECHNOLOGY_STATUSES),
        scope: metricScope(raw.scope, `${label}.scope`),
        ...(raw.actionId === undefined ? {} : { actionId: stringToken(raw.actionId, `${label}.actionId`, 120) }),
        limitations: tokenArray(raw.limitations, `${label}.limitations`, MAX_LIMITATIONS),
    }
}

function finding(value: unknown, index: number): Finding {
    const label = `animation-report.findings[${index}]`
    const raw = record(value, label)
    exactKeys(
        raw,
        ['findingId', 'ruleId', 'severity', 'status', 'scope', 'metricIds', 'evidenceRefs', 'budgetRefs', 'actionIds', 'limitations'],
        label
    )
    return {
        findingId: stringToken(raw.findingId, `${label}.findingId`),
        ruleId: stringToken(raw.ruleId, `${label}.ruleId`),
        severity: enumeration(raw.severity, `${label}.severity`, FINDING_SEVERITIES),
        status: enumeration(raw.status, `${label}.status`, FINDING_STATUSES),
        scope: metricScope(raw.scope, `${label}.scope`),
        metricIds: tokenArray(raw.metricIds, `${label}.metricIds`),
        evidenceRefs: tokenArray(raw.evidenceRefs, `${label}.evidenceRefs`),
        budgetRefs: boundedArray(raw.budgetRefs, `${label}.budgetRefs`, 8).map((item, refIndex) =>
            budgetRef(item, `${label}.budgetRefs[${refIndex}]`, true)
        ),
        actionIds: tokenArray(raw.actionIds, `${label}.actionIds`),
        limitations: tokenArray(raw.limitations, `${label}.limitations`, MAX_LIMITATIONS),
    }
}

function assertUnique(values: readonly string[], label: string): void {
    if (new Set(values).size !== values.length) throw new BadRequestException(`${label} contains duplicate identifiers`)
}

function assertScopeReferences(
    scope: LabMetricScopeV2Projection,
    actionIds: ReadonlySet<string>,
    attemptIds: ReadonlySet<string>,
    label: string
): void {
    if (scope.actionId && !actionIds.has(scope.actionId)) throw new BadRequestException(`${label} references an unknown actionId`)
    if (scope.attemptId && !attemptIds.has(scope.attemptId)) throw new BadRequestException(`${label} references an unknown attemptId`)
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((item, index) => item === right[index])
}

function sameMetricScope(left: LabMetricScopeV2Projection, right: LabMetricScopeV2Projection): boolean {
    return (
        left.level === right.level &&
        left.attemptId === right.attemptId &&
        left.actionId === right.actionId &&
        left.subjectKey === right.subjectKey
    )
}

function sameBudgetRuleRefs(left: readonly LabBudgetRuleRefV1Projection[], right: readonly LabBudgetRuleRefV1Projection[]): boolean {
    return (
        left.length === right.length &&
        left.every((item, index) => {
            const other = right[index]
            return (
                other !== undefined &&
                item.catalogVersion === other.catalogVersion &&
                item.budgetId === other.budgetId &&
                item.budgetVersion === other.budgetVersion &&
                item.ruleId === other.ruleId
            )
        })
    )
}

function resolveDefaultBudgetTarget(rule: DefaultBudgetRuleDefinition, targetFrameMs: number): number {
    return rule.target.kind === 'target-frame-multiple' ? targetFrameMs * rule.target.value : rule.target.value
}

function violatesDefaultBudget(value: number, rule: DefaultBudgetRuleDefinition, target: number): boolean {
    if (rule.comparator === '<=') return value > target
    if (rule.comparator === '<') return value >= target
    if (rule.comparator === '>=') return value < target
    return value <= target
}

function evaluateDefaultBudgetRule(
    rule: DefaultBudgetRuleDefinition,
    metric: AnimationLabMetricV2Projection,
    targetFrameMs: number
): { status: 'breach' | 'candidate-breach' | 'within-budget' | 'insufficient-evidence'; target: number } {
    const target = resolveDefaultBudgetTarget(rule, targetFrameMs)
    if (
        metric.metricId !== rule.metricId ||
        typeof metric.value !== 'number' ||
        !Number.isFinite(metric.value) ||
        metric.value < 0 ||
        typeof metric.samples !== 'number' ||
        !Number.isFinite(metric.samples) ||
        metric.samples < rule.minimumSamples ||
        !Number.isInteger(metric.samples) ||
        (metric.status !== 'measured' && metric.status !== 'partial')
    ) {
        return { status: 'insufficient-evidence', target }
    }
    const zeroEventCountRule =
        rule.minimumSamples === 0 &&
        (rule.metricId === 'main.long-task.count' || rule.metricId === 'main.loaf.count') &&
        rule.comparator === '<=' &&
        rule.target.kind === 'absolute' &&
        rule.target.value === 0
    if (zeroEventCountRule && (metric.value === 0) !== (metric.samples === 0)) {
        return { status: 'insufficient-evidence', target }
    }
    const breached = violatesDefaultBudget(metric.value, rule, target)
    if (metric.status === 'partial') {
        return { status: breached ? 'candidate-breach' : 'insufficient-evidence', target }
    }
    return { status: breached ? 'breach' : 'within-budget', target }
}

function canonicalFindings(semantics: AnimationLabSemanticsV2): Finding[] {
    const budgetRef = semantics.measurementContract.budgetRef
    const rules = defaultBudgetRuleDefinitions(budgetRef)
    if (!rules || budgetRef.catalogVersion !== 1) return []
    const rulesById = new Map(rules.map(rule => [rule.ruleId, rule]))
    const output: Finding[] = []
    for (const metric of semantics.metrics) {
        for (const metricBudgetRef of metric.budgetRefs) {
            if (
                metricBudgetRef.catalogVersion !== budgetRef.catalogVersion ||
                metricBudgetRef.budgetId !== budgetRef.budgetId ||
                metricBudgetRef.budgetVersion !== budgetRef.budgetVersion
            ) {
                continue
            }
            const rule = rulesById.get(metricBudgetRef.ruleId)
            if (!rule || rule.metricId !== metric.metricId) continue
            const evaluation = evaluateDefaultBudgetRule(rule, metric, semantics.measurementContract.targetFrameMs)
            if (evaluation.status !== 'breach' && evaluation.status !== 'candidate-breach') continue
            const actionId = metric.scope.actionId
            output.push({
                findingId: `finding-${rule.ruleId}-${metric.scope.level}-${actionId ?? 'all'}`,
                ruleId: rule.ruleId,
                severity:
                    evaluation.target > 0 &&
                    typeof metric.value === 'number' &&
                    Number.isFinite(metric.value) &&
                    metric.value > evaluation.target * 2
                        ? 'critical'
                        : 'warning',
                status: evaluation.status === 'breach' ? 'observed' : 'candidate',
                scope: metric.scope,
                metricIds: [metric.metricId],
                evidenceRefs: metric.evidenceRefs,
                budgetRefs: [metricBudgetRef],
                actionIds: actionId ? [actionId] : [],
                limitations: [...new Set([...metric.limitations, 'diagnostic-project-budget-not-web-standard'])],
            })
        }
    }
    return output.slice(0, MAX_FINDINGS)
}

/** Verifies that caller-supplied findings are the exact closed projection of accepted canonical metrics. */
export function assertAnimationLabCanonicalFindings(semantics: AnimationLabSemanticsV2): void {
    const expected = canonicalFindings(semantics)
    if (expected.length !== semantics.findings.length) {
        throw new BadRequestException('animation-report findings conflict with canonical budget evaluation')
    }
    for (const [index, findingValue] of semantics.findings.entries()) {
        const expectedFinding = expected[index]
        if (
            expectedFinding === undefined ||
            findingValue.findingId !== expectedFinding.findingId ||
            findingValue.ruleId !== expectedFinding.ruleId ||
            findingValue.severity !== expectedFinding.severity ||
            findingValue.status !== expectedFinding.status ||
            !sameMetricScope(findingValue.scope, expectedFinding.scope) ||
            !sameStringArray(findingValue.metricIds, expectedFinding.metricIds) ||
            !sameStringArray(findingValue.evidenceRefs, expectedFinding.evidenceRefs) ||
            !sameBudgetRuleRefs(findingValue.budgetRefs, expectedFinding.budgetRefs) ||
            !sameStringArray(findingValue.actionIds, expectedFinding.actionIds) ||
            !sameStringArray(findingValue.limitations, expectedFinding.limitations)
        ) {
            throw new BadRequestException(`animation-report findings[${index}] conflicts with canonical budget evaluation`)
        }
    }
}

/** Parses the semantic fields embedded in a schema-v1 report with semanticsVersion 2. */
export function parseAnimationLabSemanticsV2FromReport(reportValue: RecordValue): AnimationLabSemanticsV2 {
    if (reportValue.semanticsVersion !== 2) throw new BadRequestException('Unsupported animation-report semanticsVersion')
    const scenarioRaw = record(reportValue.scenario, 'animation-report.scenario')
    const attemptsRaw = boundedArray(reportValue.attempts, 'animation-report.attempts', 32)
    const semanticSources = {
        measurementContract: reportValue.measurementContract,
        scenarioActions: scenarioRaw.actions,
        actionWindows: reportValue.actionWindows,
        attemptActionWindows: attemptsRaw.map(item =>
            item && typeof item === 'object' && !Array.isArray(item) ? (item as RecordValue).actionWindows : undefined
        ),
        attemptMetrics: attemptsRaw.map(item =>
            item && typeof item === 'object' && !Array.isArray(item) ? (item as RecordValue).metrics : undefined
        ),
        aggregateMetrics: reportValue.aggregateMetrics,
        technologyEvidence: reportValue.technologyEvidence,
        findings: reportValue.findings,
    }
    rejectForbiddenKeys(semanticSources)
    const parsedMeasurementContract = measurementContract(reportValue.measurementContract)
    const metricCatalogVersion = parsedMeasurementContract.metricCatalogVersion

    const actions = boundedArray(scenarioRaw.actions, 'animation-report.scenario.actions', MAX_ACTIONS).map(scenarioAction)
    if (actions.length === 0) throw new BadRequestException('animation-report.scenario.actions must not be empty')
    assertUnique(
        actions.map(action => action.actionId),
        'animation-report.scenario.actions actionId'
    )
    assertUnique(
        actions.map(action => action.label),
        'animation-report.scenario.actions label'
    )
    if (actions.some((action, index) => action.order !== index)) {
        throw new BadRequestException('animation-report.scenario.actions order must be contiguous')
    }
    const actionLabels = tokenArray(scenarioRaw.actionLabels, 'animation-report.scenario.actionLabels', MAX_ACTIONS)
    if (actionLabels.length !== actions.length || actionLabels.some((label, index) => label !== actions[index]?.label)) {
        throw new BadRequestException('animation-report.scenario.actionLabels must match scenario.actions')
    }
    const actionIds = new Set(actions.map(action => action.actionId))

    const attemptIds = new Set<string>()
    const attemptWindows: ActionWindow[] = []
    const attemptMetrics: Array<{ metric: AnimationLabMetricV2Projection; attemptId: string }> = []
    attemptsRaw.forEach((item, attemptIndex) => {
        const attemptRaw = record(item, `animation-report.attempts[${attemptIndex}]`)
        const attemptId = stringToken(attemptRaw.attemptId, `animation-report.attempts[${attemptIndex}].attemptId`)
        if (attemptIds.has(attemptId)) throw new BadRequestException('animation-report.attempts contains duplicate attemptId')
        attemptIds.add(attemptId)
        boundedArray(attemptRaw.metrics, `animation-report.attempts[${attemptIndex}].metrics`, MAX_METRICS).forEach(
            (metric, metricIndex) => {
                const metricRaw = record(metric, `animation-report.attempts[${attemptIndex}].metrics[${metricIndex}]`)
                if (!hasExpandedMetricFields(metricRaw)) return
                attemptMetrics.push({
                    metric: parseAnimationLabMetricV2(
                        metricRaw,
                        `animation-report.attempts[${attemptIndex}].metrics[${metricIndex}]`,
                        metricCatalogVersion
                    ),
                    attemptId,
                })
            }
        )
        if (attemptRaw.actionWindows !== undefined) {
            const parsedAttemptWindows = boundedArray(
                attemptRaw.actionWindows,
                `animation-report.attempts[${attemptIndex}].actionWindows`,
                MAX_WINDOWS
            ).map((window, windowIndex) => actionWindow(window, `animation-report.attempts[${attemptIndex}].actionWindows[${windowIndex}]`))
            assertUnique(
                parsedAttemptWindows.map(window => window.actionId),
                `animation-report.attempts[${attemptIndex}].actionWindows actionId`
            )
            attemptWindows.push(...parsedAttemptWindows)
        }
    })
    const windows = boundedArray(reportValue.actionWindows, 'animation-report.actionWindows', MAX_WINDOWS).map((window, windowIndex) =>
        actionWindow(window, `animation-report.actionWindows[${windowIndex}]`)
    )
    assertUnique(
        windows.map(window => window.actionId),
        'animation-report actionWindows actionId'
    )
    for (const window of [...windows, ...attemptWindows]) {
        const action = actions.find(candidate => candidate.actionId === window.actionId)
        if (!action || action.order !== window.order || action.kind !== window.kind) {
            throw new BadRequestException('animation-report actionWindow does not match its scenario action')
        }
    }

    const parsedMetrics = boundedArray(reportValue.aggregateMetrics, 'animation-report.aggregateMetrics', MAX_METRICS).flatMap(
        (item, index) => {
            const raw = record(item, `animation-report.aggregateMetrics[${index}]`)
            return hasExpandedMetricFields(raw)
                ? [parseAnimationLabMetricV2(raw, `animation-report.aggregateMetrics[${index}]`, metricCatalogVersion)]
                : []
        }
    )
    const technologies = boundedArray(reportValue.technologyEvidence, 'animation-report.technologyEvidence', MAX_EVIDENCE).map(
        technologyEvidence
    )
    assertUnique(
        technologies.map(item => item.evidenceId),
        'animation-report.technologyEvidence evidenceId'
    )
    const evidenceIds = new Set(technologies.map(item => item.evidenceId))
    const parsedFindings = boundedArray(reportValue.findings, 'animation-report.findings', MAX_FINDINGS).map(finding)
    assertUnique(
        parsedFindings.map(item => item.findingId),
        'animation-report.findings findingId'
    )
    const metricIds = new Set(parsedMetrics.map(item => item.metricId))

    for (const window of [...windows, ...attemptWindows]) {
        for (const evidenceRef of window.evidenceRefs) {
            if (!evidenceIds.has(evidenceRef)) throw new BadRequestException('animation-report actionWindow has an unknown evidenceRef')
        }
    }

    for (const { metric, attemptId } of attemptMetrics) {
        assertScopeReferences(metric.scope, actionIds, attemptIds, `animation-report attempt metric ${metric.metricId}`)
        if (metric.scope.attemptId && metric.scope.attemptId !== attemptId) {
            throw new BadRequestException(`animation-report attempt metric ${metric.metricId} references a different attemptId`)
        }
        for (const ref of metric.budgetRefs) {
            if (
                ref.catalogVersion !== parsedMeasurementContract.budgetRef.catalogVersion ||
                ref.budgetId !== parsedMeasurementContract.budgetRef.budgetId ||
                ref.budgetVersion !== parsedMeasurementContract.budgetRef.budgetVersion
            ) {
                throw new BadRequestException(
                    `animation-report attempt metric ${metric.metricId} budgetRef conflicts with measurementContract`
                )
            }
        }
    }

    for (const metric of parsedMetrics) {
        assertScopeReferences(metric.scope, actionIds, attemptIds, `animation-report metric ${metric.metricId}`)
        for (const ref of metric.budgetRefs) {
            if (
                ref.catalogVersion !== parsedMeasurementContract.budgetRef.catalogVersion ||
                ref.budgetId !== parsedMeasurementContract.budgetRef.budgetId ||
                ref.budgetVersion !== parsedMeasurementContract.budgetRef.budgetVersion
            ) {
                throw new BadRequestException(`animation-report metric ${metric.metricId} budgetRef conflicts with measurementContract`)
            }
        }
        for (const evidenceRef of metric.evidenceRefs) {
            if (!evidenceIds.has(evidenceRef))
                throw new BadRequestException(`animation-report metric ${metric.metricId} has an unknown evidenceRef`)
        }
    }
    for (const technology of technologies) {
        assertScopeReferences(technology.scope, actionIds, attemptIds, `animation-report technology ${technology.evidenceId}`)
        if (technology.actionId && !actionIds.has(technology.actionId)) {
            throw new BadRequestException(`animation-report technology ${technology.evidenceId} has an unknown actionId`)
        }
    }
    for (const item of parsedFindings) {
        assertScopeReferences(item.scope, actionIds, attemptIds, `animation-report finding ${item.findingId}`)
        if (item.metricIds.some(metricId => !metricIds.has(metricId))) {
            throw new BadRequestException(`animation-report finding ${item.findingId} has an unknown metricId`)
        }
        if (item.evidenceRefs.some(evidenceRef => !evidenceIds.has(evidenceRef))) {
            throw new BadRequestException(`animation-report finding ${item.findingId} has an unknown evidenceRef`)
        }
        if (item.actionIds.some(actionId => !actionIds.has(actionId))) {
            throw new BadRequestException(`animation-report finding ${item.findingId} has an unknown actionId`)
        }
        for (const ref of item.budgetRefs) {
            if (
                ref.catalogVersion !== parsedMeasurementContract.budgetRef.catalogVersion ||
                ref.budgetId !== parsedMeasurementContract.budgetRef.budgetId ||
                ref.budgetVersion !== parsedMeasurementContract.budgetRef.budgetVersion
            ) {
                throw new BadRequestException(`animation-report finding ${item.findingId} budgetRef conflicts with measurementContract`)
            }
            if (item.ruleId !== ref.ruleId) {
                throw new BadRequestException(`animation-report finding ${item.findingId} ruleId conflicts with budgetRef`)
            }
            const expectedMetricId = defaultBudgetRules(ref)?.[ref.ruleId]
            if (isKnownDefaultBudget(ref) && (!expectedMetricId || !item.metricIds.includes(expectedMetricId))) {
                throw new BadRequestException(`animation-report finding ${item.findingId} budget rule does not apply to metricIds`)
            }
        }
    }

    return {
        semanticsVersion: 2,
        measurementContract: parsedMeasurementContract,
        scenarioActions: actions,
        actionWindows: windows,
        metrics: parsedMetrics,
        technologyEvidence: technologies,
        findings: parsedFindings,
    }
}
