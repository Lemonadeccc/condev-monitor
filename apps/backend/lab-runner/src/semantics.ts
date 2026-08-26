import {
    ANIMATION_LAB_METRIC_CATALOG_V1,
    ANIMATION_LAB_METRIC_CATALOG_VERSION,
    ANIMATION_LAB_SEMANTICS_VERSION,
    type AnimationLabMetric,
    type AnimationLabMetricV2,
    type AnimationLabScenario,
    type AnimationLabSemanticsV2,
    DEFAULT_ANIMATION_LAB_BUDGET_REF_V1,
    DEFAULT_ANIMATION_LAB_BUDGET_V1,
    type LabActionWindowV2,
    type LabAttemptSummary,
    type LabFindingV2,
    type LabMeasurementContractV2,
    type LabMetricScopeV2,
    type LabReportScenarioActionV2,
    type LabScenarioAction,
    type LabTechnologyEvidenceV2,
    resolveLabActionId,
} from '@condev-monitor/animation-lab'

const BROWSER_EVIDENCE_ID = 'runtime-browser'
const ACTION_CLOCK_EVIDENCE_ID = 'runner-action-clock'
// Keep these projections aligned with the closed v2 contract. Aggregation is
// performed from the complete in-memory attempts first; the report then keeps
// a deterministic, platform-safe view of both canonical and per-attempt data.
const MAX_CANONICAL_METRICS = 256
const MAX_CANONICAL_FINDINGS = 256
const MAX_TECHNOLOGY_EVIDENCE = 256

function round(value: number): number {
    return Math.round(value * 1_000_000) / 1_000_000
}

function finite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort((left, right) => left - right)
    if (sorted.length === 0) return 0
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0)
}

function catalogEntry(metric: AnimationLabMetric) {
    return ANIMATION_LAB_METRIC_CATALOG_V1.find(
        entry =>
            (metric.metricId ? entry.metricId === metric.metricId : true) &&
            entry.family === metric.family &&
            entry.name === metric.name &&
            entry.stat === metric.stat &&
            entry.unit === metric.unit
    )
}

export function reportScenarioActions(scenario: AnimationLabScenario): LabReportScenarioActionV2[] {
    return scenario.actions.map((action, order) => ({
        actionId: resolveLabActionId(action, order),
        order,
        kind: action.kind,
        label: action.label,
        ...(action.subject ? { subject: action.subject } : {}),
        trigger: { source: action.trigger?.source ?? 'scenario' },
    }))
}

export function decorateLabMetric(
    metric: AnimationLabMetric,
    scope: LabMetricScopeV2,
    options: { evidenceId?: string; acrossAttempts?: boolean } = {}
): AnimationLabMetric {
    const entry = catalogEntry(metric)
    if (!entry) return metric
    const budgetRefs = entry.defaultBudgetRuleIds.map(ruleId => ({
        ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V1,
        ruleId,
    }))
    return {
        ...metric,
        metricId: entry.metricId,
        scope,
        aggregation: options.acrossAttempts ? { population: 'attempts', method: 'median-of-attempts' } : entry.defaultAggregation,
        budgetRefs,
        evidenceRefs: [options.evidenceId ?? BROWSER_EVIDENCE_ID],
        limitations: metric.limitations ?? [],
    }
}

export function measurementContractForReport(scenario: AnimationLabScenario): LabMeasurementContractV2 {
    if (scenario.measurementContract) return scenario.measurementContract
    return {
        contractVersion: ANIMATION_LAB_SEMANTICS_VERSION,
        expectedHz: 60,
        targetFrameMs: round(1_000 / 60),
        source: 'package-default',
        confidence: 'low',
        budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V1,
        metricCatalogVersion: ANIMATION_LAB_METRIC_CATALOG_VERSION,
    }
}

export function probeFrameContract(scenario: AnimationLabScenario): { expectedRefreshHz?: number; targetFrameMs?: number } {
    const contract = scenario.measurementContract
    return contract
        ? { expectedRefreshHz: contract.expectedHz, targetFrameMs: contract.targetFrameMs }
        : { expectedRefreshHz: 60, targetFrameMs: round(1_000 / 60) }
}

export function actionWindowFromProbe(
    action: LabScenarioAction,
    order: number,
    result: {
        startedAtMs: number
        endedAtMs: number
        outcome: LabActionWindowV2['outcome']['status']
        limitations?: readonly string[]
        evidenceRefs?: readonly string[]
    }
): LabActionWindowV2 {
    const startedAtMs = Math.max(0, result.startedAtMs)
    const endedAtMs = Math.max(startedAtMs, result.endedAtMs)
    return {
        actionId: resolveLabActionId(action, order),
        order,
        kind: action.kind,
        trigger: { source: action.trigger?.source ?? 'scenario' },
        ...(action.subject ? { subject: action.subject } : {}),
        outcome: { status: result.outcome },
        timestamps: {
            clock: 'attempt-monotonic',
            startedAtMs: round(startedAtMs),
            endedAtMs: round(endedAtMs),
            durationMs: round(endedAtMs - startedAtMs),
        },
        evidenceRefs: [...new Set(result.evidenceRefs ?? [BROWSER_EVIDENCE_ID])],
        limitations: [...new Set(result.limitations ?? [])],
    }
}

function aggregateActionWindows(
    actions: readonly LabReportScenarioActionV2[],
    attempts: readonly LabAttemptSummary[]
): LabActionWindowV2[] {
    const measured = attempts.filter(attempt => attempt.phase === 'measured')
    return actions.flatMap(action => {
        const windows = measured.flatMap(attempt => attempt.actionWindows?.filter(window => window.actionId === action.actionId) ?? [])
        if (windows.length === 0) return []
        const startedAtMs = median(windows.map(window => window.timestamps.startedAtMs))
        const durationMs = median(windows.map(window => window.timestamps.durationMs))
        const statuses = new Set(windows.map(window => window.outcome.status))
        return [
            {
                actionId: action.actionId,
                order: action.order,
                kind: action.kind,
                trigger: action.trigger,
                ...(action.subject ? { subject: action.subject } : {}),
                outcome: { status: statuses.size === 1 ? windows[0]!.outcome.status : 'unknown' },
                timestamps: {
                    clock: 'attempt-monotonic',
                    startedAtMs: round(startedAtMs),
                    endedAtMs: round(startedAtMs + durationMs),
                    durationMs: round(durationMs),
                },
                evidenceRefs: [...new Set(windows.flatMap(window => window.evidenceRefs))],
                limitations: [
                    ...new Set([
                        ...windows.flatMap(window => window.limitations),
                        ...(windows.length === measured.length ? [] : ['partial-attempt-coverage']),
                    ]),
                ],
            },
        ]
    })
}

function technologyEvidence(
    actions: readonly LabReportScenarioActionV2[],
    scenarioActions: readonly LabScenarioAction[],
    browser: { name: string; version: string },
    metrics: readonly AnimationLabMetric[],
    attempts: readonly LabAttemptSummary[],
    metricProjectionTruncated: boolean
): LabTechnologyEvidenceV2[] {
    const evidence: LabTechnologyEvidenceV2[] = [
        {
            evidenceId: BROWSER_EVIDENCE_ID,
            axis: 'browser-runtime',
            technologyKey: browser.name,
            ...(browser.version ? { version: browser.version } : {}),
            source: 'runtime-probe',
            confidence: 'high',
            status: 'observed',
            scope: { level: 'run' },
            limitations: [
                'browser-outcomes-do-not-prove-framework-owner',
                ...(metricProjectionTruncated ? ['canonical-metric-projection-truncated'] : []),
            ],
        },
        {
            evidenceId: ACTION_CLOCK_EVIDENCE_ID,
            axis: 'browser-runtime',
            technologyKey: 'condev-runner-monotonic-clock',
            source: 'host-adapter',
            confidence: 'high',
            status: 'observed',
            scope: { level: 'run' },
            limitations: ['clock-measures-runner-action-window-not-renderer-work'],
        },
    ]
    if (attempts.some(attempt => attempt.metrics.some(metric => metric.evidenceRefs?.includes('cdp-trace')))) {
        evidence.push({
            evidenceId: 'cdp-trace',
            axis: 'browser-runtime',
            technologyKey: 'chromium-devtools-trace',
            source: 'cdp-trace',
            confidence: 'high',
            status: 'observed',
            scope: { level: 'run' },
            limitations: ['trace-category-durations-may-overlap'],
        })
    }
    if (attempts.some(attempt => attempt.metrics.some(metric => metric.evidenceRefs?.includes('lighthouse')))) {
        evidence.push({
            evidenceId: 'lighthouse',
            axis: 'browser-runtime',
            technologyKey: 'lighthouse',
            source: 'lighthouse',
            confidence: 'high',
            status: 'observed',
            scope: { level: 'run' },
            limitations: ['separate-navigation-experiment'],
        })
    }
    const observedSurfaces: Array<{ metricName: string; key: string; axis: LabTechnologyEvidenceV2['axis'] }> = [
        { metricName: 'svgSurfaces', key: 'svg', axis: 'renderer' },
        { metricName: 'canvas2dSurfaces', key: 'canvas2d', axis: 'graphics-api' },
        { metricName: 'webglSurfaces', key: 'webgl', axis: 'graphics-api' },
        { metricName: 'webgpuSurfaces', key: 'webgpu', axis: 'graphics-api' },
        { metricName: 'videoElementCount', key: 'video', axis: 'media' },
    ]
    for (const surface of observedSurfaces) {
        const observed = metrics.some(metric => metric.name === surface.metricName && finite(metric.value) && metric.value > 0)
        if (!observed) continue
        evidence.push({
            evidenceId: `runtime-surface-${surface.key}`,
            axis: surface.axis,
            technologyKey: surface.key,
            source: 'runtime-probe',
            confidence: 'medium',
            status: 'observed',
            scope: { level: 'run' },
            limitations: ['surface-observation-does-not-prove-renderer-cost'],
        })
    }

    const declaredTechnologyLayers: LabTechnologyEvidenceV2[][] = []
    const maximumDeclarations = Math.max(0, ...scenarioActions.map(action => action.technologies?.length ?? 0))
    for (let technologyIndex = 0; technologyIndex < maximumDeclarations; technologyIndex += 1) {
        declaredTechnologyLayers.push(
            actions.flatMap(action => {
                const declaration = scenarioActions[action.order]?.technologies?.[technologyIndex]
                if (!declaration) return []
                return [
                    {
                        evidenceId: `declared-technology-${action.actionId}-${technologyIndex}`,
                        axis: declaration.axis,
                        technologyKey: declaration.technologyKey,
                        ...(declaration.version ? { version: declaration.version } : {}),
                        source: 'scenario-declaration' as const,
                        confidence: 'explicit' as const,
                        status: 'declared' as const,
                        scope: { level: 'action' as const, actionId: action.actionId },
                        actionId: action.actionId,
                        limitations: ['declared-technology-is-not-runtime-owner-proof'],
                    },
                ]
            })
        )
    }
    const declaredSurfaces: LabTechnologyEvidenceV2[] = actions.flatMap(action => {
        const surface = action.subject?.surface
        if (!surface || surface === 'unknown') return []
        return [
            {
                evidenceId: `declared-surface-${action.actionId}`,
                axis:
                    surface === 'video' || surface === 'audio'
                        ? 'media'
                        : surface === 'dom' || surface === 'svg'
                          ? 'renderer'
                          : 'graphics-api',
                technologyKey: surface,
                source: 'scenario-declaration',
                confidence: 'explicit',
                status: 'declared',
                scope: { level: 'action', actionId: action.actionId },
                actionId: action.actionId,
                limitations: ['declared-subject-is-not-runtime-owner-proof'],
            },
        ]
    })
    const candidates = [
        ...evidence,
        ...(declaredTechnologyLayers[0] ?? []),
        ...declaredSurfaces,
        ...declaredTechnologyLayers.slice(1).flat(),
    ]
    const retained = candidates.slice(0, MAX_TECHNOLOGY_EVIDENCE)
    if (candidates.length > retained.length) {
        const runtimeIndex = retained.findIndex(item => item.evidenceId === BROWSER_EVIDENCE_ID)
        if (runtimeIndex >= 0) {
            const runtime = retained[runtimeIndex]!
            retained[runtimeIndex] = {
                ...runtime,
                limitations: [...new Set([...runtime.limitations, 'technology-evidence-projection-truncated'])],
            }
        }
    }
    return retained
}

function targetValue(rule: (typeof DEFAULT_ANIMATION_LAB_BUDGET_V1.rules)[number], contract: LabMeasurementContractV2): number {
    return rule.target.kind === 'target-frame-multiple' ? contract.targetFrameMs * rule.target.value : rule.target.value
}

function violates(
    value: number,
    comparator: (typeof DEFAULT_ANIMATION_LAB_BUDGET_V1.rules)[number]['comparator'],
    target: number
): boolean {
    if (comparator === '<=') return value > target
    if (comparator === '<') return value >= target
    if (comparator === '>=') return value < target
    return value <= target
}

function findings(metrics: readonly AnimationLabMetricV2[], contract: LabMeasurementContractV2): LabFindingV2[] {
    const output: LabFindingV2[] = []
    for (const metric of metrics) {
        if (!finite(metric.value) || !['measured', 'partial'].includes(metric.status)) continue
        for (const budgetRef of metric.budgetRefs) {
            const rule = DEFAULT_ANIMATION_LAB_BUDGET_V1.rules.find(item => item.ruleId === budgetRef.ruleId)
            if (!rule || rule.metricId !== metric.metricId || (metric.samples ?? 0) < rule.minimumSamples) continue
            const target = targetValue(rule, contract)
            if (!violates(metric.value, rule.comparator, target)) continue
            const actionId = metric.scope.actionId
            output.push({
                findingId: `finding-${rule.ruleId}-${metric.scope.level}-${actionId ?? 'all'}`,
                ruleId: rule.ruleId,
                severity: target > 0 && metric.value > target * 2 ? 'critical' : 'warning',
                status: metric.status === 'measured' ? 'observed' : 'candidate',
                scope: metric.scope,
                metricIds: [metric.metricId],
                evidenceRefs: metric.evidenceRefs,
                budgetRefs: [budgetRef],
                actionIds: actionId ? [actionId] : [],
                limitations: [...new Set([...metric.limitations, 'diagnostic-project-budget-not-web-standard'])],
            })
        }
    }
    return output.slice(0, MAX_CANONICAL_FINDINGS)
}

function canonicalMetricProjection(
    metrics: readonly AnimationLabMetric[],
    scenarioActions: readonly LabReportScenarioActionV2[]
): { metrics: AnimationLabMetricV2[]; omittedActionIds: ReadonlySet<string>; truncated: boolean } {
    const actionOrder = new Map(scenarioActions.map(action => [action.actionId, action.order]))
    const catalogOrder = new Map(ANIMATION_LAB_METRIC_CATALOG_V1.map((entry, index) => [entry.metricId, index]))
    const candidates = metrics
        .filter((metric): metric is AnimationLabMetricV2 => Boolean(metric.metricId && metric.scope))
        .map((metric, originalOrder) => ({ metric, originalOrder }))
        .sort((left, right) => {
            const leftActionId = left.metric.scope.actionId
            const rightActionId = right.metric.scope.actionId
            if (!leftActionId && rightActionId) return -1
            if (leftActionId && !rightActionId) return 1
            if (leftActionId && rightActionId) {
                // Rotate by metric before action so a large scenario retains the
                // highest-value signal for every action instead of starving all
                // later actions after filling the bound with the first few.
                const leftBudgetPriority = left.metric.budgetRefs.length > 0 ? 0 : 1
                const rightBudgetPriority = right.metric.budgetRefs.length > 0 ? 0 : 1
                if (leftBudgetPriority !== rightBudgetPriority) return leftBudgetPriority - rightBudgetPriority
                const metricDifference =
                    (catalogOrder.get(left.metric.metricId) ?? Number.MAX_SAFE_INTEGER) -
                    (catalogOrder.get(right.metric.metricId) ?? Number.MAX_SAFE_INTEGER)
                if (metricDifference !== 0) return metricDifference
                const actionDifference =
                    (actionOrder.get(leftActionId) ?? Number.MAX_SAFE_INTEGER) - (actionOrder.get(rightActionId) ?? Number.MAX_SAFE_INTEGER)
                if (actionDifference !== 0) return actionDifference
            }
            const identityDifference = [left.metric.metricId, left.metric.family, left.metric.name, left.metric.stat, left.metric.unit]
                .join('|')
                .localeCompare(
                    [right.metric.metricId, right.metric.family, right.metric.name, right.metric.stat, right.metric.unit].join('|')
                )
            return identityDifference || left.originalOrder - right.originalOrder
        })
    const retained = candidates.slice(0, MAX_CANONICAL_METRICS).map(item => item.metric)
    const omitted = candidates.slice(MAX_CANONICAL_METRICS).map(item => item.metric)
    return {
        metrics: retained,
        omittedActionIds: new Set(omitted.flatMap(metric => (metric.scope.actionId ? [metric.scope.actionId] : []))),
        truncated: omitted.length > 0,
    }
}

/**
 * Bound report attempts without biasing the first actions in a large scenario.
 * Warm-up detail is deliberately omitted: warm-ups never participate in the
 * measured aggregate, while their runtime capabilities and limitations remain.
 */
export function projectAttemptsForReport(
    attempts: readonly LabAttemptSummary[],
    scenarioActions: readonly LabReportScenarioActionV2[]
): LabAttemptSummary[] {
    return attempts.map(attempt => {
        if (attempt.phase === 'warmup') {
            return {
                ...attempt,
                metrics: [],
                actionWindows: undefined,
                limitations: [...new Set([...attempt.limitations, 'warmup-detail-omitted-from-report'])],
            }
        }
        const projection = canonicalMetricProjection(attempt.metrics, scenarioActions)
        return {
            ...attempt,
            metrics: projection.metrics,
            limitations: [...new Set([...attempt.limitations, ...(projection.truncated ? ['attempt-metric-projection-truncated'] : [])])],
        }
    })
}

export function buildAnimationLabSemantics(options: {
    scenario: AnimationLabScenario
    browser: { name: string; version: string }
    attempts: readonly LabAttemptSummary[]
    aggregateMetrics: readonly AnimationLabMetric[]
}): AnimationLabSemanticsV2 {
    const scenarioActions = reportScenarioActions(options.scenario)
    const measurementContract = measurementContractForReport(options.scenario)
    const projection = canonicalMetricProjection(options.aggregateMetrics, scenarioActions)
    const actionWindows = aggregateActionWindows(scenarioActions, options.attempts).map(window =>
        projection.omittedActionIds.has(window.actionId)
            ? { ...window, limitations: [...new Set([...window.limitations, 'canonical-action-metrics-truncated'])] }
            : window
    )
    return {
        semanticsVersion: ANIMATION_LAB_SEMANTICS_VERSION,
        measurementContract,
        scenarioActions,
        actionWindows,
        metrics: projection.metrics,
        technologyEvidence: technologyEvidence(
            scenarioActions,
            options.scenario.actions,
            options.browser,
            projection.metrics,
            options.attempts,
            projection.truncated
        ),
        findings: findings(projection.metrics, measurementContract),
    }
}
