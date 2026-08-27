import type { LabRunStatus } from './lab.contracts'
import type { ParsedAnimationReport } from './lab-projection'
import {
    ANIMATION_LAB_METRIC_SAMPLES_MAX,
    type AnimationLabMetricV2Projection,
    type AnimationLabSemanticsV2,
    assertAnimationLabMetricCatalogTupleV2,
} from './lab-semantics-v2'

export const ANIMATION_LAB_COMPARISON_SCHEMA_VERSION = 1 as const

const MAX_ATTEMPTS = 20
const MAX_METRICS_PER_ATTEMPT = 256
const MAX_EXCLUDED_METRICS = 256
const MAX_REASONS = 64
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,159}$/
const SHA256_HEX = /^[a-f0-9]{64}$/

type ComparisonExecution = NonNullable<ParsedAnimationReport['context']['execution']>
type MeasurementContract = AnimationLabSemanticsV2['measurementContract']
type ComparisonScope = {
    level: 'run' | 'action' | 'subject'
    actionId?: string
    subjectKey?: string
}

export type LabComparisonMeasuredAttempt = {
    attemptId: string
    metrics: readonly AnimationLabMetricV2Projection[]
    capabilities: Readonly<Record<string, boolean | null>>
}

export type LabComparisonCandidate = {
    runId: string
    appId: string
    status: LabRunStatus
    scenarioKey: string
    comparisonContext: {
        routeKey: string
        scenarioProtocolHash: string
        environment: string
        browser: { name: string; version: string; headless: boolean }
        viewport: { width: number; height: number; dpr: number }
        reducedMotion: ParsedAnimationReport['context']['reducedMotion']
        cacheMode: ParsedAnimationReport['context']['cacheMode']
        execution: ComparisonExecution
        measurementContract: MeasurementContract
    }
    measuredAttempts: readonly LabComparisonMeasuredAttempt[]
}

export type LabComparisonMismatchField =
    | 'candidate'
    | 'run-status'
    | 'measured-attempts'
    | 'metrics'
    | 'capabilities'
    | 'app-id'
    | 'scenario-key'
    | 'route-key'
    | 'scenario-protocol'
    | 'environment'
    | 'browser-name'
    | 'browser-version'
    | 'browser-headless'
    | 'viewport-width'
    | 'viewport-height'
    | 'device-scale-factor'
    | 'reduced-motion'
    | 'cache-mode'
    | 'warmup-runs'
    | 'measured-runs'
    | 'observation-duration'
    | 'trace-mode'
    | 'lighthouse-mode'
    | 'color-scheme'
    | 'cpu-throttle-rate'
    | 'network-profile'
    | 'measurement-contract-version'
    | 'expected-refresh-rate'
    | 'target-frame-duration'
    | 'measurement-source'
    | 'measurement-confidence'
    | 'metric-catalog-version'
    | 'budget-reference'

export type LabComparisonRejectionReason = {
    code: 'invalid-candidate' | 'condition-mismatch'
    side: 'before' | 'after' | 'both'
    field: LabComparisonMismatchField
}

export type LabComparisonUnavailableReason = {
    code: 'evidence-unavailable'
    side: 'before' | 'after' | 'both'
    field: 'animation-report-missing' | 'animation-report-expired'
}

export type LabComparisonCaveat =
    | 'host-environment-unverified'
    | 'caller-attested-scenario-protocol'
    | 'attempt-distribution-is-descriptive'
    | 'no-statistical-significance-inference'
    | 'zero-baseline-percent-change-unavailable'
    | 'percent-change-overflow-unavailable'

export type LabComparisonExclusionReason =
    | 'before-missing-attempt'
    | 'after-missing-attempt'
    | 'before-partial-status'
    | 'after-partial-status'
    | 'before-unavailable-status'
    | 'after-unavailable-status'
    | 'metric-evidence-mismatch'

export type LabMetricAttemptDistribution = {
    n: number
    min: number
    median: number
    p75: number
    p95: number
    max: number
    underlyingSamples: {
        knownAttempts: number
        total: number
        min: number | null
        max: number | null
    }
}

export type LabMetricComparison = {
    metricId: string
    family: AnimationLabMetricV2Projection['family']
    name: string
    stat: AnimationLabMetricV2Projection['stat']
    unit: AnimationLabMetricV2Projection['unit']
    scope: ComparisonScope
    sourceAggregation: AnimationLabMetricV2Projection['aggregation']
    comparisonAggregation: { population: 'measured-attempts'; method: 'median' }
    budgetRefs: AnimationLabMetricV2Projection['budgetRefs']
    evidenceRefs: readonly string[]
    evidenceLevel: Exclude<AnimationLabMetricV2Projection['evidenceLevel'], 'unsupported-or-unknown'>
    evidenceStatus: 'measured'
    before: LabMetricAttemptDistribution
    after: LabMetricAttemptDistribution
    delta: number
    percentChange: number | null
    direction: 'increase' | 'decrease' | 'unchanged'
}

export type LabExcludedMetricComparison = {
    metricId: string
    scope: ComparisonScope
    reasons: readonly LabComparisonExclusionReason[]
}

export type ComparableAnimationLabResult = {
    schemaVersion: typeof ANIMATION_LAB_COMPARISON_SCHEMA_VERSION
    kind: 'animation-lab-before-after'
    comparable: true
    trust: 'caller-attested'
    beforeRunId: string
    afterRunId: string
    scenarioKey: string
    routeKey: string
    conditions: LabComparisonCandidate['comparisonContext']
    caveats: readonly LabComparisonCaveat[]
    coverage: {
        beforeAttempts: number
        afterAttempts: number
        candidateMetricTuples: number
        comparedMetrics: number
        excludedMetrics: number
        retainedExcludedMetrics: number
        droppedExcludedMetrics: number
    }
    metrics: readonly LabMetricComparison[]
    excluded: readonly LabExcludedMetricComparison[]
}

export type IncomparableAnimationLabResult = {
    schemaVersion: typeof ANIMATION_LAB_COMPARISON_SCHEMA_VERSION
    kind: 'animation-lab-before-after'
    comparable: false
    reasons: readonly (LabComparisonRejectionReason | LabComparisonUnavailableReason)[]
}

export type AnimationLabComparisonResult = ComparableAnimationLabResult | IncomparableAnimationLabResult

export function unavailableAnimationLabComparison(reasons: readonly LabComparisonUnavailableReason[]): IncomparableAnimationLabResult {
    const retained = reasons
        .filter(
            (reason, index, all) => all.findIndex(candidate => candidate.side === reason.side && candidate.field === reason.field) === index
        )
        .slice(0, MAX_REASONS)
        .map(reason => ({ ...reason }))
    return {
        schemaVersion: ANIMATION_LAB_COMPARISON_SCHEMA_VERSION,
        kind: 'animation-lab-before-after',
        comparable: false,
        reasons: retained,
    }
}

type MetricGroup = {
    exemplar: AnimationLabMetricV2Projection
    byAttempt: Map<number, AnimationLabMetricV2Projection>
}

function token(value: unknown, maximumLength = 160): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= maximumLength && SAFE_TOKEN.test(value)
}

function boundedString(value: unknown, maximumLength: number, allowEmpty = false): value is string {
    if (typeof value !== 'string' || value.length > maximumLength || (!allowEmpty && value.length === 0)) return false
    for (const character of value) {
        const code = character.charCodeAt(0)
        if (code < 32 || code === 127) return false
    }
    return true
}

function finite(value: unknown, minimum: number, maximum: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
    return finite(value, minimum, maximum) && Number.isInteger(value)
}

function same(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right)
}

function normalizedNetwork(value: ComparisonExecution['network']) {
    if (value === null) return null
    return {
        offline: value.offline ?? null,
        latencyMs: value.latencyMs ?? null,
        downloadBytesPerSecond: value.downloadBytesPerSecond ?? null,
        uploadBytesPerSecond: value.uploadBytesPerSecond ?? null,
    }
}

function normalizedCapabilities(value: LabComparisonMeasuredAttempt['capabilities']) {
    return Object.keys(value)
        .sort()
        .map(key => [key, value[key]] as const)
}

function normalizedBudgetRef(value: MeasurementContract['budgetRef']) {
    return [value.catalogVersion, value.budgetId, value.budgetVersion] as const
}

function comparisonScope(value: AnimationLabMetricV2Projection['scope']): ComparisonScope {
    if (value.level === 'attempt' || value.level === 'run') return { level: 'run' }
    if (value.level === 'action') return { level: 'action', actionId: value.actionId }
    return {
        level: 'subject',
        ...(value.actionId ? { actionId: value.actionId } : {}),
        subjectKey: value.subjectKey,
    }
}

function normalizedBudgetRuleRefs(value: AnimationLabMetricV2Projection['budgetRefs']) {
    return value
        .map(ref => [ref.catalogVersion, ref.budgetId, ref.budgetVersion, ref.ruleId] as const)
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

/** Identity of one per-attempt metric after deliberately removing attemptId. */
function metricIdentity(metric: AnimationLabMetricV2Projection): string {
    return JSON.stringify([
        metric.metricId,
        metric.family,
        metric.name,
        metric.stat,
        metric.unit,
        comparisonScope(metric.scope),
        metric.aggregation.population,
        metric.aggregation.method,
        normalizedBudgetRuleRefs(metric.budgetRefs),
    ])
}

function metricScopeIdentity(metric: AnimationLabMetricV2Projection): string {
    return JSON.stringify([metric.metricId, comparisonScope(metric.scope)])
}

function validMetric(metric: AnimationLabMetricV2Projection, attemptId: string, metricCatalogVersion: 1 | 2): boolean {
    if (!token(metric.metricId) || !token(metric.name)) return false
    try {
        assertAnimationLabMetricCatalogTupleV2(metric, 'lab-comparison.metric', metricCatalogVersion)
    } catch {
        return false
    }
    if (!['run', 'attempt', 'action', 'subject'].includes(metric.scope.level)) return false
    if (metric.scope.attemptId !== undefined && metric.scope.attemptId !== attemptId) return false
    if (metric.scope.level === 'run' && (metric.scope.attemptId || metric.scope.actionId || metric.scope.subjectKey)) return false
    if (metric.scope.level === 'attempt' && (!metric.scope.attemptId || metric.scope.actionId || metric.scope.subjectKey)) return false
    if (metric.scope.level === 'action' && (!metric.scope.actionId || metric.scope.subjectKey)) return false
    if (metric.scope.level === 'subject' && !metric.scope.subjectKey) return false
    if (metric.scope.actionId !== undefined && !token(metric.scope.actionId, 120)) return false
    if (metric.scope.subjectKey !== undefined && !token(metric.scope.subjectKey, 128)) return false
    if (metric.budgetRefs.length > 8 || metric.evidenceRefs.length > 64 || metric.limitations.length > 32) return false
    if (
        metric.budgetRefs.some(
            ref =>
                ref.catalogVersion !== 1 || !token(ref.budgetId, 120) || !integer(ref.budgetVersion, 1, 10_000) || !token(ref.ruleId, 120)
        ) ||
        metric.evidenceRefs.some(ref => !token(ref)) ||
        metric.limitations.some(item => !token(item))
    ) {
        return false
    }
    if (!['measured', 'partial', 'not-observed', 'unsupported', 'unknown'].includes(metric.status)) return false
    if (!['controlled-lab-measurement', 'runtime-observation', 'unsupported-or-unknown'].includes(metric.evidenceLevel)) return false
    if (metric.samples !== null && !integer(metric.samples, 0, ANIMATION_LAB_METRIC_SAMPLES_MAX)) return false
    if (metric.status === 'measured' || metric.status === 'partial') {
        return finite(metric.value, 0, Number.MAX_VALUE) && metric.evidenceLevel !== 'unsupported-or-unknown'
    }
    return metric.value === null
}

function validCapabilities(value: LabComparisonMeasuredAttempt['capabilities']): boolean {
    return (
        Object.keys(value).length <= 128 &&
        Object.entries(value).every(
            ([key, capability]) => token(key, 80) && (capability === true || capability === false || capability === null)
        )
    )
}

function validateContext(context: LabComparisonCandidate['comparisonContext']): boolean {
    const execution = context.execution
    const contract = context.measurementContract
    const network = execution.network
    return (
        token(context.routeKey) &&
        SHA256_HEX.test(context.scenarioProtocolHash) &&
        boundedString(context.environment, 120, true) &&
        token(context.browser.name, 40) &&
        boundedString(context.browser.version, 120) &&
        typeof context.browser.headless === 'boolean' &&
        integer(context.viewport.width, 240, 7_680) &&
        integer(context.viewport.height, 240, 4_320) &&
        finite(context.viewport.dpr, 0.5, 8) &&
        (context.reducedMotion === 'no-preference' || context.reducedMotion === 'reduce') &&
        (context.cacheMode === 'cold' || context.cacheMode === 'warm') &&
        integer(execution.warmupRuns, 0, 10) &&
        integer(execution.measuredRuns, 3, MAX_ATTEMPTS) &&
        (execution.durationMs === null || integer(execution.durationMs, 5_000, 120_000)) &&
        typeof execution.trace === 'boolean' &&
        typeof execution.lighthouse === 'boolean' &&
        (execution.colorScheme === null || execution.colorScheme === 'light' || execution.colorScheme === 'dark') &&
        finite(execution.cpuThrottleRate, 1, 20) &&
        (network === null ||
            ((network.offline === undefined || typeof network.offline === 'boolean') &&
                (network.latencyMs === undefined || finite(network.latencyMs, 0, 120_000)) &&
                (network.downloadBytesPerSecond === undefined || finite(network.downloadBytesPerSecond, 1, 1_000_000_000)) &&
                (network.uploadBytesPerSecond === undefined || finite(network.uploadBytesPerSecond, 1, 1_000_000_000)))) &&
        contract.contractVersion === 2 &&
        finite(contract.expectedHz, 1, 1_000) &&
        finite(contract.targetFrameMs, 1, 1_000) &&
        Math.abs(contract.targetFrameMs - 1_000 / contract.expectedHz) <= Math.max(0.05, (1_000 / contract.expectedHz) * 0.01) &&
        ['explicit', 'observed', 'inferred', 'package-default', 'unknown'].includes(contract.source) &&
        ['explicit', 'high', 'medium', 'low', 'unknown'].includes(contract.confidence) &&
        (contract.source !== 'explicit' || contract.confidence === 'explicit') &&
        token(contract.budgetRef.budgetId, 120) &&
        contract.budgetRef.catalogVersion === 1 &&
        integer(contract.budgetRef.budgetVersion, 1, 10_000) &&
        (contract.metricCatalogVersion === 1 || contract.metricCatalogVersion === 2)
    )
}

function invalidCandidateReasons(candidate: LabComparisonCandidate, side: 'before' | 'after'): LabComparisonRejectionReason[] {
    const reasons: LabComparisonRejectionReason[] = []
    const add = (field: LabComparisonMismatchField): void => {
        if (reasons.length < MAX_REASONS && !reasons.some(reason => reason.field === field)) {
            reasons.push({ code: 'invalid-candidate', side, field })
        }
    }
    if (!token(candidate.runId) || !token(candidate.appId, 80) || !token(candidate.scenarioKey, 120)) add('candidate')
    if (candidate.status !== 'completed') add('run-status')
    if (!validateContext(candidate.comparisonContext)) add('candidate')
    if (
        candidate.measuredAttempts.length < 3 ||
        candidate.measuredAttempts.length > MAX_ATTEMPTS ||
        candidate.measuredAttempts.length !== candidate.comparisonContext.execution.measuredRuns
    ) {
        add('measured-attempts')
    }
    const attemptIds = new Set<string>()
    let expectedCapabilities: ReturnType<typeof normalizedCapabilities> | null = null
    for (const attempt of candidate.measuredAttempts.slice(0, MAX_ATTEMPTS + 1)) {
        if (!token(attempt.attemptId) || attemptIds.has(attempt.attemptId)) add('measured-attempts')
        attemptIds.add(attempt.attemptId)
        if (!validCapabilities(attempt.capabilities)) add('capabilities')
        const signature = normalizedCapabilities(attempt.capabilities)
        if (expectedCapabilities === null) expectedCapabilities = signature
        else if (!same(expectedCapabilities, signature)) add('capabilities')
        if (attempt.metrics.length > MAX_METRICS_PER_ATTEMPT) add('metrics')
        const metricIds = new Set<string>()
        for (const metric of attempt.metrics.slice(0, MAX_METRICS_PER_ATTEMPT + 1)) {
            if (!validMetric(metric, attempt.attemptId, candidate.comparisonContext.measurementContract.metricCatalogVersion)) {
                add('metrics')
                break
            }
            const identity = metricScopeIdentity(metric)
            if (metricIds.has(identity)) {
                add('metrics')
                break
            }
            metricIds.add(identity)
        }
    }
    return reasons
}

function mismatch(field: LabComparisonMismatchField): LabComparisonRejectionReason {
    return { code: 'condition-mismatch', side: 'both', field }
}

function comparisonMismatches(before: LabComparisonCandidate, after: LabComparisonCandidate): LabComparisonRejectionReason[] {
    const left = before.comparisonContext
    const right = after.comparisonContext
    const beforeCapabilities = normalizedCapabilities(before.measuredAttempts[0]!.capabilities)
    const afterCapabilities = normalizedCapabilities(after.measuredAttempts[0]!.capabilities)
    const checks: Array<readonly [LabComparisonMismatchField, unknown, unknown]> = [
        ['app-id', before.appId, after.appId],
        ['scenario-key', before.scenarioKey, after.scenarioKey],
        ['route-key', left.routeKey, right.routeKey],
        ['scenario-protocol', left.scenarioProtocolHash, right.scenarioProtocolHash],
        ['environment', left.environment, right.environment],
        ['browser-name', left.browser.name, right.browser.name],
        ['browser-version', left.browser.version, right.browser.version],
        ['browser-headless', left.browser.headless, right.browser.headless],
        ['viewport-width', left.viewport.width, right.viewport.width],
        ['viewport-height', left.viewport.height, right.viewport.height],
        ['device-scale-factor', left.viewport.dpr, right.viewport.dpr],
        ['reduced-motion', left.reducedMotion, right.reducedMotion],
        ['cache-mode', left.cacheMode, right.cacheMode],
        ['warmup-runs', left.execution.warmupRuns, right.execution.warmupRuns],
        ['measured-runs', left.execution.measuredRuns, right.execution.measuredRuns],
        ['observation-duration', left.execution.durationMs, right.execution.durationMs],
        ['trace-mode', left.execution.trace, right.execution.trace],
        ['lighthouse-mode', left.execution.lighthouse, right.execution.lighthouse],
        ['color-scheme', left.execution.colorScheme, right.execution.colorScheme],
        ['cpu-throttle-rate', left.execution.cpuThrottleRate, right.execution.cpuThrottleRate],
        ['network-profile', normalizedNetwork(left.execution.network), normalizedNetwork(right.execution.network)],
        ['measurement-contract-version', left.measurementContract.contractVersion, right.measurementContract.contractVersion],
        ['expected-refresh-rate', left.measurementContract.expectedHz, right.measurementContract.expectedHz],
        ['target-frame-duration', left.measurementContract.targetFrameMs, right.measurementContract.targetFrameMs],
        ['measurement-source', left.measurementContract.source, right.measurementContract.source],
        ['measurement-confidence', left.measurementContract.confidence, right.measurementContract.confidence],
        ['metric-catalog-version', left.measurementContract.metricCatalogVersion, right.measurementContract.metricCatalogVersion],
        [
            'budget-reference',
            normalizedBudgetRef(left.measurementContract.budgetRef),
            normalizedBudgetRef(right.measurementContract.budgetRef),
        ],
        ['capabilities', beforeCapabilities, afterCapabilities],
    ]
    return checks
        .filter(([, beforeValue, afterValue]) => !same(beforeValue, afterValue))
        .map(([field]) => mismatch(field))
        .slice(0, MAX_REASONS)
}

function copyContext(context: LabComparisonCandidate['comparisonContext']): LabComparisonCandidate['comparisonContext'] {
    return {
        routeKey: context.routeKey,
        scenarioProtocolHash: context.scenarioProtocolHash,
        environment: context.environment,
        browser: { ...context.browser },
        viewport: { ...context.viewport },
        reducedMotion: context.reducedMotion,
        cacheMode: context.cacheMode,
        execution: {
            ...context.execution,
            network: context.execution.network ? { ...context.execution.network } : null,
        },
        measurementContract: {
            ...context.measurementContract,
            budgetRef: { ...context.measurementContract.budgetRef },
        },
    }
}

function collectMetricGroups(attempts: readonly LabComparisonMeasuredAttempt[]): Map<string, MetricGroup> {
    const groups = new Map<string, MetricGroup>()
    for (const [attemptIndex, attempt] of attempts.entries()) {
        for (const metric of attempt.metrics) {
            const identity = metricIdentity(metric)
            const group = groups.get(identity) ?? { exemplar: metric, byAttempt: new Map<number, AnimationLabMetricV2Projection>() }
            group.byAttempt.set(attemptIndex, metric)
            groups.set(identity, group)
        }
    }
    return groups
}

function round(value: number): number {
    if (value !== 0 && Math.abs(value) < 0.0000005) return value
    if (Math.abs(value) > Number.MAX_VALUE / 1_000_000) return value
    const rounded = Math.round(value * 1_000_000) / 1_000_000
    return Object.is(rounded, -0) ? 0 : rounded
}

function percentChange(before: number, delta: number): number | null {
    if (before === 0) return null
    const value = (delta / before) * 100
    return Number.isFinite(value) ? round(value) : null
}

function nearestRank(sorted: readonly number[], percentile: number): number {
    return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]!
}

function distribution(metrics: readonly AnimationLabMetricV2Projection[]): LabMetricAttemptDistribution {
    const values = metrics.map(metric => metric.value as number).sort((left, right) => left - right)
    const middle = Math.floor(values.length / 2)
    const lowerMiddle = values[middle - 1] ?? 0
    const upperMiddle = values[middle] ?? 0
    const median = values.length % 2 === 0 ? lowerMiddle + (upperMiddle - lowerMiddle) / 2 : upperMiddle
    const samples = metrics.map(metric => metric.samples).filter((value): value is number => typeof value === 'number')
    return {
        n: values.length,
        min: round(values[0]!),
        median: round(median),
        p75: round(nearestRank(values, 0.75)),
        p95: round(nearestRank(values, 0.95)),
        max: round(values[values.length - 1]!),
        underlyingSamples: {
            knownAttempts: samples.length,
            total: samples.reduce((total, value) => total + value, 0),
            min: samples.length > 0 ? Math.min(...samples) : null,
            max: samples.length > 0 ? Math.max(...samples) : null,
        },
    }
}

function allMeasured(group: MetricGroup | undefined, attemptCount: number): boolean {
    if (!group || group.byAttempt.size !== attemptCount) return false
    return [...group.byAttempt.values()].every(
        metric => metric.status === 'measured' && typeof metric.value === 'number' && Number.isFinite(metric.value)
    )
}

function evidenceSignature(metric: AnimationLabMetricV2Projection): string {
    return JSON.stringify([metric.evidenceLevel, [...metric.evidenceRefs].sort()])
}

function sameMetricEvidence(before: MetricGroup | undefined, after: MetricGroup | undefined): boolean {
    if (!before || !after) return false
    const signatures = [...[...before.byAttempt.values()].map(evidenceSignature), ...[...after.byAttempt.values()].map(evidenceSignature)]
    return new Set(signatures).size === 1
}

function exclusions(
    before: MetricGroup | undefined,
    after: MetricGroup | undefined,
    beforeAttemptCount: number,
    afterAttemptCount: number
): LabComparisonExclusionReason[] {
    const reasons: LabComparisonExclusionReason[] = []
    const inspect = (side: 'before' | 'after', group: MetricGroup | undefined, count: number): void => {
        if (!group || group.byAttempt.size !== count) reasons.push(`${side}-missing-attempt`)
        const statuses = group ? [...group.byAttempt.values()].map(metric => metric.status) : []
        if (statuses.includes('partial')) reasons.push(`${side}-partial-status`)
        if (statuses.some(status => status !== 'measured' && status !== 'partial')) reasons.push(`${side}-unavailable-status`)
    }
    inspect('before', before, beforeAttemptCount)
    inspect('after', after, afterAttemptCount)
    if (before && after && !sameMetricEvidence(before, after)) reasons.push('metric-evidence-mismatch')
    return reasons
}

function compareMetric(before: MetricGroup, after: MetricGroup): LabMetricComparison {
    const beforeMetrics = [...before.byAttempt.values()]
    const afterMetrics = [...after.byAttempt.values()]
    const beforeDistribution = distribution(beforeMetrics)
    const afterDistribution = distribution(afterMetrics)
    const delta = round(afterDistribution.median - beforeDistribution.median)
    const evidenceLevel = before.exemplar.evidenceLevel as Exclude<
        AnimationLabMetricV2Projection['evidenceLevel'],
        'unsupported-or-unknown'
    >
    return {
        metricId: before.exemplar.metricId,
        family: before.exemplar.family,
        name: before.exemplar.name,
        stat: before.exemplar.stat,
        unit: before.exemplar.unit,
        scope: comparisonScope(before.exemplar.scope),
        sourceAggregation: { ...before.exemplar.aggregation },
        comparisonAggregation: { population: 'measured-attempts', method: 'median' },
        budgetRefs: before.exemplar.budgetRefs.map(ref => ({ ...ref })),
        evidenceRefs: [...before.exemplar.evidenceRefs],
        evidenceLevel,
        evidenceStatus: 'measured',
        before: beforeDistribution,
        after: afterDistribution,
        delta,
        percentChange: percentChange(beforeDistribution.median, delta),
        direction: delta > 0 ? 'increase' : delta < 0 ? 'decrease' : 'unchanged',
    }
}

/**
 * Produces descriptive Before/After evidence from repeated measured attempts.
 * It never infers significance, improvement/regression, or an overall score.
 */
export function compareAnimationLabCandidates(before: LabComparisonCandidate, after: LabComparisonCandidate): AnimationLabComparisonResult {
    const invalidReasons = [...invalidCandidateReasons(before, 'before'), ...invalidCandidateReasons(after, 'after')].slice(0, MAX_REASONS)
    if (invalidReasons.length > 0) {
        return {
            schemaVersion: ANIMATION_LAB_COMPARISON_SCHEMA_VERSION,
            kind: 'animation-lab-before-after',
            comparable: false,
            reasons: invalidReasons,
        }
    }

    const mismatches = comparisonMismatches(before, after)
    if (mismatches.length > 0) {
        return {
            schemaVersion: ANIMATION_LAB_COMPARISON_SCHEMA_VERSION,
            kind: 'animation-lab-before-after',
            comparable: false,
            reasons: mismatches,
        }
    }

    const beforeGroups = collectMetricGroups(before.measuredAttempts)
    const afterGroups = collectMetricGroups(after.measuredAttempts)
    const identities = [...new Set([...beforeGroups.keys(), ...afterGroups.keys()])].sort()
    const metrics: LabMetricComparison[] = []
    const excluded: LabExcludedMetricComparison[] = []
    for (const identity of identities) {
        const beforeGroup = beforeGroups.get(identity)
        const afterGroup = afterGroups.get(identity)
        if (
            allMeasured(beforeGroup, before.measuredAttempts.length) &&
            allMeasured(afterGroup, after.measuredAttempts.length) &&
            sameMetricEvidence(beforeGroup, afterGroup) &&
            beforeGroup &&
            afterGroup
        ) {
            metrics.push(compareMetric(beforeGroup, afterGroup))
            continue
        }
        if (excluded.length >= MAX_EXCLUDED_METRICS) continue
        const exemplar = beforeGroup?.exemplar ?? afterGroup!.exemplar
        excluded.push({
            metricId: exemplar.metricId,
            scope: comparisonScope(exemplar.scope),
            reasons: exclusions(beforeGroup, afterGroup, before.measuredAttempts.length, after.measuredAttempts.length),
        })
    }
    metrics.sort((left, right) =>
        [left.metricId, left.scope.level, left.scope.actionId ?? '', left.scope.subjectKey ?? '']
            .join('|')
            .localeCompare([right.metricId, right.scope.level, right.scope.actionId ?? '', right.scope.subjectKey ?? ''].join('|'))
    )
    const excludedCount = identities.length - metrics.length
    const caveats: LabComparisonCaveat[] = [
        'host-environment-unverified',
        'caller-attested-scenario-protocol',
        'attempt-distribution-is-descriptive',
        'no-statistical-significance-inference',
    ]
    if (metrics.some(metric => metric.before.median === 0)) caveats.push('zero-baseline-percent-change-unavailable')
    if (metrics.some(metric => metric.before.median !== 0 && metric.percentChange === null)) {
        caveats.push('percent-change-overflow-unavailable')
    }

    return {
        schemaVersion: ANIMATION_LAB_COMPARISON_SCHEMA_VERSION,
        kind: 'animation-lab-before-after',
        comparable: true,
        trust: 'caller-attested',
        beforeRunId: before.runId,
        afterRunId: after.runId,
        scenarioKey: before.scenarioKey,
        routeKey: before.comparisonContext.routeKey,
        conditions: copyContext(before.comparisonContext),
        caveats,
        coverage: {
            beforeAttempts: before.measuredAttempts.length,
            afterAttempts: after.measuredAttempts.length,
            candidateMetricTuples: identities.length,
            comparedMetrics: metrics.length,
            excludedMetrics: excludedCount,
            retainedExcludedMetrics: excluded.length,
            droppedExcludedMetrics: Math.max(0, excludedCount - excluded.length),
        },
        metrics,
        excluded,
    }
}
