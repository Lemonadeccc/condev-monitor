import { createHash } from 'node:crypto'

import {
    type AnimationLabMetric,
    evaluateAnimationLabProjectBudgetProfile,
    getAnimationLabMetricCatalogEntry,
    type LabBudgetComparator,
    type LabBudgetRuleDefinitionV1,
    type LabMetricCatalogVersion,
    type LabMetricUnit,
    validateAnimationLabProjectBudgetProfile,
} from '@condev-monitor/animation-lab'
import { BadRequestException } from '@nestjs/common'

import type { ComparableAnimationLabResult, LabMetricComparison } from './lab-comparison'

const MAX_POLICY_BYTES = 64 * 1024
const MAX_RULES = 64
const MAX_ATTEMPTS = 20
const MAX_SAMPLES = 10_000_000
const MAX_TARGET = Number.MAX_SAFE_INTEGER
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,119}$/
const COMPARATORS = ['<=', '<', '>=', '>'] as const
const OPERANDS = ['after-median', 'signed-delta', 'percent-change'] as const
const SEVERITIES = ['warning', 'critical'] as const

export type LabProjectPolicySeverity = (typeof SEVERITIES)[number]
export type LabProjectComparisonOperand = (typeof OPERANDS)[number]
export type LabProjectPolicyVerdict = 'within-policy' | 'breach' | 'indeterminate'

export type LabProjectPolicyScope =
    | { level: 'run' }
    | { level: 'action'; actionId: string }
    | { level: 'subject'; actionId?: string; subjectKey: string }

export type LabProjectAbsoluteRuleV1 = LabBudgetRuleDefinitionV1 & {
    severity: LabProjectPolicySeverity
}

export type LabProjectComparisonRuleV1 = {
    ruleId: string
    metricId: string
    scope: LabProjectPolicyScope
    operand: LabProjectComparisonOperand
    comparator: LabBudgetComparator
    target: { value: number; unit: LabMetricUnit | 'percent' }
    minimumAttemptsPerSide: number
    minimumUnderlyingSamples: number
    severity: LabProjectPolicySeverity
}

export type LabProjectPolicyDefinitionV1 = {
    schemaVersion: 1
    metricCatalogVersion: LabMetricCatalogVersion
    absoluteRules: readonly LabProjectAbsoluteRuleV1[]
    comparisonRules: readonly LabProjectComparisonRuleV1[]
}

export type LabProjectAbsoluteEvaluationV1 = {
    schemaVersion: 1
    kind: 'animation-lab-project-budget-evaluation'
    policyRef: LabProjectPolicyRef
    evidence: 'measured' | 'partial' | 'not-measured'
    verdict: 'within-policy' | 'breach' | 'indeterminate'
    rules: readonly {
        ruleId: string
        metricId: string
        valueUnit: LabMetricUnit
        targetUnit: LabMetricUnit
        severity: LabProjectPolicySeverity
        status: 'within-policy' | 'breach' | 'indeterminate'
        value: number | null
        target: number | null
        samples: number | null
        reason?: string
    }[]
    caveats: readonly ['project-policy-is-not-measurement-evidence']
}

export type LabProjectPolicyRef = {
    policyKey: string
    version: number
    digest: string
}

export type LabProjectComparisonRuleEvaluationV1 = {
    ruleId: string
    metricId: string
    severity: LabProjectPolicySeverity
    status: LabProjectPolicyVerdict
    reasonCodes: readonly string[]
    observed: {
        scope: LabProjectPolicyScope
        beforeMedian: number | null
        afterMedian: number | null
        signedDelta: number | null
        percentChange: number | null
        attemptsBefore: number
        attemptsAfter: number
        minimumUnderlyingSamples: number | null
    }
    decision: {
        operand: LabProjectComparisonOperand
        comparator: LabBudgetComparator
        target: { value: number; unit: LabMetricUnit | 'percent' }
    }
}

export type LabProjectComparisonEvaluationV1 = {
    schemaVersion: 1
    kind: 'animation-lab-deterministic-policy-evaluation'
    policyRef: LabProjectPolicyRef
    beforeRunId: string
    afterRunId: string
    verdict: LabProjectPolicyVerdict
    coverage: { totalRules: number; evaluatedRules: number; breachedRules: number; indeterminateRules: number }
    rules: readonly LabProjectComparisonRuleEvaluationV1[]
    caveats: readonly [
        'project-policy-is-not-measurement-evidence',
        'attempt-distribution-is-descriptive',
        'no-statistical-significance-inference',
    ]
}

function coreBudgetRule(rule: LabProjectAbsoluteRuleV1): LabBudgetRuleDefinitionV1 {
    return {
        ruleId: rule.ruleId,
        metricId: rule.metricId,
        comparator: rule.comparator,
        target: { ...rule.target },
        minimumSamples: rule.minimumSamples,
    }
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
    const allowedSet = new Set(allowed)
    const unknown = Object.keys(value).find(key => !allowedSet.has(key))
    if (unknown) throw new BadRequestException(`${label} contains unsupported field: ${unknown}`)
}

function token(value: unknown, label: string): string {
    if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) throw new BadRequestException(`Invalid ${label}`)
    return value
}

function integer(value: unknown, label: string, min: number, max: number): number {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
        throw new BadRequestException(`${label} must be an integer between ${min} and ${max}`)
    }
    return value as number
}

function finite(value: unknown, label: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new BadRequestException(`${label} must be a finite number between ${min} and ${max}`)
    }
    return value
}

function enumValue<T extends string>(value: unknown, label: string, values: readonly T[]): T {
    if (typeof value !== 'string' || !values.includes(value as T)) throw new BadRequestException(`Invalid ${label}`)
    return value as T
}

function parseScope(raw: unknown, label: string): LabProjectPolicyScope {
    if (!record(raw)) throw new BadRequestException(`${label} must be an object`)
    exactKeys(raw, ['level', 'actionId', 'subjectKey'], label)
    const level = enumValue(raw.level, `${label}.level`, ['run', 'action', 'subject'] as const)
    if (level === 'run') {
        if (raw.actionId !== undefined || raw.subjectKey !== undefined) throw new BadRequestException(`Invalid ${label}`)
        return { level }
    }
    if (level === 'action') {
        if (raw.subjectKey !== undefined) throw new BadRequestException(`Invalid ${label}`)
        return { level, actionId: token(raw.actionId, `${label}.actionId`) }
    }
    return {
        level,
        ...(raw.actionId === undefined ? {} : { actionId: token(raw.actionId, `${label}.actionId`) }),
        subjectKey: token(raw.subjectKey, `${label}.subjectKey`),
    }
}

function parseAbsoluteRule(raw: unknown, index: number, catalogVersion: LabMetricCatalogVersion): LabProjectAbsoluteRuleV1 {
    const label = `definition.absoluteRules[${index}]`
    if (!record(raw)) throw new BadRequestException(`${label} must be an object`)
    exactKeys(raw, ['ruleId', 'metricId', 'comparator', 'target', 'minimumSamples', 'severity'], label)
    const ruleId = token(raw.ruleId, `${label}.ruleId`)
    const metricId = token(raw.metricId, `${label}.metricId`)
    const comparator = enumValue(raw.comparator, `${label}.comparator`, COMPARATORS)
    const minimumSamples = integer(raw.minimumSamples, `${label}.minimumSamples`, 0, MAX_SAMPLES)
    const severity = enumValue(raw.severity, `${label}.severity`, SEVERITIES)
    if (!record(raw.target)) throw new BadRequestException(`${label}.target must be an object`)
    exactKeys(raw.target, ['kind', 'value', 'unit'], `${label}.target`)
    const kind = enumValue(raw.target.kind, `${label}.target.kind`, ['absolute', 'target-frame-multiple'] as const)
    const value = finite(raw.target.value, `${label}.target.value`, 0, MAX_TARGET)
    const entry = getAnimationLabMetricCatalogEntry(metricId, catalogVersion)
    if (!entry) throw new BadRequestException(`${label} references an unknown metric`)
    const target =
        kind === 'absolute'
            ? { kind, value, unit: enumValue(raw.target.unit, `${label}.target.unit`, [entry.unit] as const) }
            : {
                  kind,
                  value,
                  unit: enumValue(raw.target.unit, `${label}.target.unit`, ['ratio'] as const),
              }
    if (kind === 'target-frame-multiple' && entry.unit !== 'ms') {
        throw new BadRequestException(`${label} target-frame multiple requires an ms metric`)
    }
    return { ruleId, metricId, comparator, target, minimumSamples, severity }
}

function parseComparisonRule(raw: unknown, index: number, catalogVersion: LabMetricCatalogVersion): LabProjectComparisonRuleV1 {
    const label = `definition.comparisonRules[${index}]`
    if (!record(raw)) throw new BadRequestException(`${label} must be an object`)
    exactKeys(
        raw,
        [
            'ruleId',
            'metricId',
            'scope',
            'operand',
            'comparator',
            'target',
            'minimumAttemptsPerSide',
            'minimumUnderlyingSamples',
            'severity',
        ],
        label
    )
    const ruleId = token(raw.ruleId, `${label}.ruleId`)
    const metricId = token(raw.metricId, `${label}.metricId`)
    const entry = getAnimationLabMetricCatalogEntry(metricId, catalogVersion)
    if (!entry) throw new BadRequestException(`${label} references an unknown metric`)
    const operand = enumValue(raw.operand, `${label}.operand`, OPERANDS)
    if (!record(raw.target)) throw new BadRequestException(`${label}.target must be an object`)
    exactKeys(raw.target, ['value', 'unit'], `${label}.target`)
    const expectedUnit = operand === 'percent-change' ? 'percent' : entry.unit
    return {
        ruleId,
        metricId,
        scope: parseScope(raw.scope, `${label}.scope`),
        operand,
        comparator: enumValue(raw.comparator, `${label}.comparator`, COMPARATORS),
        target: {
            value: finite(raw.target.value, `${label}.target.value`, operand === 'signed-delta' ? -MAX_TARGET : 0, MAX_TARGET),
            unit: enumValue(raw.target.unit, `${label}.target.unit`, [expectedUnit] as const),
        },
        minimumAttemptsPerSide: integer(raw.minimumAttemptsPerSide, `${label}.minimumAttemptsPerSide`, 3, MAX_ATTEMPTS),
        minimumUnderlyingSamples: integer(raw.minimumUnderlyingSamples, `${label}.minimumUnderlyingSamples`, 0, MAX_SAMPLES),
        severity: enumValue(raw.severity, `${label}.severity`, SEVERITIES),
    }
}

export function parseLabProjectPolicyDefinition(raw: unknown): LabProjectPolicyDefinitionV1 {
    if (!record(raw)) throw new BadRequestException('definition must be an object')
    exactKeys(raw, ['schemaVersion', 'metricCatalogVersion', 'absoluteRules', 'comparisonRules'], 'definition')
    if (raw.schemaVersion !== 1) throw new BadRequestException('Invalid definition.schemaVersion')
    const metricCatalogVersion = integer(raw.metricCatalogVersion, 'definition.metricCatalogVersion', 1, 5) as LabMetricCatalogVersion
    if (!Array.isArray(raw.absoluteRules) || raw.absoluteRules.length > MAX_RULES) {
        throw new BadRequestException(`definition.absoluteRules must contain at most ${MAX_RULES} rules`)
    }
    if (!Array.isArray(raw.comparisonRules) || raw.comparisonRules.length > MAX_RULES) {
        throw new BadRequestException(`definition.comparisonRules must contain at most ${MAX_RULES} rules`)
    }
    if (raw.absoluteRules.length + raw.comparisonRules.length === 0) {
        throw new BadRequestException('definition must contain at least one rule')
    }
    const absoluteRules = raw.absoluteRules.map((rule, index) => parseAbsoluteRule(rule, index, metricCatalogVersion))
    const comparisonRules = raw.comparisonRules.map((rule, index) => parseComparisonRule(rule, index, metricCatalogVersion))
    const ruleIds = [...absoluteRules, ...comparisonRules].map(rule => rule.ruleId)
    if (new Set(ruleIds).size !== ruleIds.length) throw new BadRequestException('definition contains duplicate ruleId values')
    absoluteRules.sort((left, right) => left.ruleId.localeCompare(right.ruleId))
    comparisonRules.sort((left, right) => left.ruleId.localeCompare(right.ruleId))

    const coreProfile = {
        catalogVersion: 1 as const,
        budgetId: 'project.validation',
        budgetVersion: 1,
        rules: absoluteRules.map(coreBudgetRule),
    }
    if (coreProfile.rules.length > 0) {
        const validation = validateAnimationLabProjectBudgetProfile(coreProfile, metricCatalogVersion)
        if (!validation.ok) throw new BadRequestException(`Invalid project budget: ${validation.errors[0] ?? 'unknown error'}`)
    }
    const normalized = { schemaVersion: 1 as const, metricCatalogVersion, absoluteRules, comparisonRules }
    if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_POLICY_BYTES) {
        throw new BadRequestException('definition is too large')
    }
    return normalized
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (!record(value)) return value
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map(key => [key, canonicalize(value[key])])
    )
}

export function digestLabProjectPolicyDefinition(definition: LabProjectPolicyDefinitionV1): string {
    return createHash('sha256')
        .update(JSON.stringify(canonicalize(definition)))
        .digest('hex')
}

function comparisonScopeMatches(metric: LabMetricComparison, scope: LabProjectPolicyScope): boolean {
    return (
        metric.scope.level === scope.level &&
        (metric.scope.actionId ?? null) === ('actionId' in scope ? (scope.actionId ?? null) : null) &&
        (metric.scope.subjectKey ?? null) === ('subjectKey' in scope ? scope.subjectKey : null)
    )
}

function passes(value: number, comparator: LabBudgetComparator, target: number): boolean {
    if (comparator === '<=') return value <= target
    if (comparator === '<') return value < target
    if (comparator === '>=') return value >= target
    return value > target
}

function minimumUnderlyingSamples(metric: LabMetricComparison): number | null {
    const values = [metric.before.underlyingSamples.min, metric.after.underlyingSamples.min]
    return values.every((value): value is number => typeof value === 'number') ? Math.min(...values) : null
}

function indeterminateRule(
    rule: LabProjectComparisonRuleV1,
    reasonCodes: readonly string[],
    metric?: LabMetricComparison
): LabProjectComparisonRuleEvaluationV1 {
    return {
        ruleId: rule.ruleId,
        metricId: rule.metricId,
        severity: rule.severity,
        status: 'indeterminate',
        reasonCodes,
        observed: {
            scope: rule.scope,
            beforeMedian: metric?.before.median ?? null,
            afterMedian: metric?.after.median ?? null,
            signedDelta: metric?.delta ?? null,
            percentChange: metric?.percentChange ?? null,
            attemptsBefore: metric?.before.n ?? 0,
            attemptsAfter: metric?.after.n ?? 0,
            minimumUnderlyingSamples: metric ? minimumUnderlyingSamples(metric) : null,
        },
        decision: { operand: rule.operand, comparator: rule.comparator, target: { ...rule.target } },
    }
}

export function evaluateLabProjectComparisonPolicy(
    policyRef: LabProjectPolicyRef,
    definition: LabProjectPolicyDefinitionV1,
    comparison: ComparableAnimationLabResult
): LabProjectComparisonEvaluationV1 {
    const rules = definition.comparisonRules.map(rule => {
        const matches = comparison.metrics.filter(metric => metric.metricId === rule.metricId && comparisonScopeMatches(metric, rule.scope))
        if (matches.length === 0) return indeterminateRule(rule, ['metric-missing-or-excluded'])
        if (matches.length > 1) return indeterminateRule(rule, ['metric-ambiguous'])
        const metric = matches[0]!
        if (metric.before.n < rule.minimumAttemptsPerSide || metric.after.n < rule.minimumAttemptsPerSide) {
            return indeterminateRule(rule, ['minimum-attempts-not-met'], metric)
        }
        const minimumSamples = minimumUnderlyingSamples(metric)
        if (rule.minimumUnderlyingSamples > 0 && (minimumSamples === null || minimumSamples < rule.minimumUnderlyingSamples)) {
            return indeterminateRule(rule, ['minimum-underlying-samples-not-met'], metric)
        }
        const observed =
            rule.operand === 'after-median' ? metric.after.median : rule.operand === 'signed-delta' ? metric.delta : metric.percentChange
        if (observed === null || !Number.isFinite(observed)) {
            return indeterminateRule(
                rule,
                [rule.operand === 'percent-change' ? 'zero-baseline-percent-change-unavailable' : 'operand-unavailable'],
                metric
            )
        }
        return {
            ruleId: rule.ruleId,
            metricId: rule.metricId,
            severity: rule.severity,
            status: passes(observed, rule.comparator, rule.target.value) ? ('within-policy' as const) : ('breach' as const),
            reasonCodes: [],
            observed: {
                scope: rule.scope,
                beforeMedian: metric.before.median,
                afterMedian: metric.after.median,
                signedDelta: metric.delta,
                percentChange: metric.percentChange,
                attemptsBefore: metric.before.n,
                attemptsAfter: metric.after.n,
                minimumUnderlyingSamples: minimumSamples,
            },
            decision: { operand: rule.operand, comparator: rule.comparator, target: { ...rule.target } },
        }
    })
    const breachedRules = rules.filter(rule => rule.status === 'breach').length
    const indeterminateRules = rules.filter(rule => rule.status === 'indeterminate').length
    const verdict: LabProjectPolicyVerdict =
        breachedRules > 0 ? 'breach' : rules.length === 0 || indeterminateRules > 0 ? 'indeterminate' : 'within-policy'
    return {
        schemaVersion: 1,
        kind: 'animation-lab-deterministic-policy-evaluation',
        policyRef: { ...policyRef },
        beforeRunId: comparison.beforeRunId,
        afterRunId: comparison.afterRunId,
        verdict,
        coverage: {
            totalRules: rules.length,
            evaluatedRules: rules.length - indeterminateRules,
            breachedRules,
            indeterminateRules,
        },
        rules,
        caveats: [
            'project-policy-is-not-measurement-evidence',
            'attempt-distribution-is-descriptive',
            'no-statistical-significance-inference',
        ],
    }
}

export function evaluateLabProjectAbsoluteBudget(
    policyRef: LabProjectPolicyRef,
    definition: LabProjectPolicyDefinitionV1,
    metrics: readonly Pick<AnimationLabMetric, 'metricId' | 'value' | 'samples' | 'status'>[],
    targetFrameMs: number
): LabProjectAbsoluteEvaluationV1 {
    const profile = {
        catalogVersion: 1 as const,
        budgetId: `project.${policyRef.policyKey}`,
        budgetVersion: policyRef.version,
        rules: definition.absoluteRules.map(coreBudgetRule),
    }
    if (profile.rules.length === 0) {
        return {
            schemaVersion: 1,
            kind: 'animation-lab-project-budget-evaluation',
            policyRef: { ...policyRef },
            evidence: 'not-measured',
            verdict: 'indeterminate',
            rules: [],
            caveats: ['project-policy-is-not-measurement-evidence'],
        }
    }
    const result = evaluateAnimationLabProjectBudgetProfile(profile, metrics, { targetFrameMs }, definition.metricCatalogVersion)
    if (!result.ok) throw new BadRequestException(`Invalid stored project budget: ${result.errors[0] ?? 'unknown error'}`)
    const severityByRule = new Map(definition.absoluteRules.map(rule => [rule.ruleId, rule.severity]))
    return {
        schemaVersion: 1,
        kind: 'animation-lab-project-budget-evaluation',
        policyRef: { ...policyRef },
        evidence: result.value.evidence,
        verdict: result.value.outcome === 'pass' ? 'within-policy' : result.value.outcome === 'breach' ? 'breach' : 'indeterminate',
        rules: result.value.rules.map(rule => ({
            ruleId: rule.ruleId,
            metricId: rule.metricId,
            valueUnit: rule.valueUnit,
            targetUnit: rule.targetUnit,
            severity: severityByRule.get(rule.ruleId) ?? 'warning',
            status: rule.outcome === 'pass' ? 'within-policy' : rule.outcome === 'breach' ? 'breach' : 'indeterminate',
            value: rule.value,
            target: rule.target,
            samples: rule.samples,
            ...(rule.reason ? { reason: rule.reason } : {}),
        })),
        caveats: ['project-policy-is-not-measurement-evidence'],
    }
}
