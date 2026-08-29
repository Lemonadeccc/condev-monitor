import { evaluateAnimationLabBudgetRule, resolveAnimationLabBudgetTarget } from './budget'
import { getAnimationLabMetricCatalogEntry } from './catalog'
import { safeToken } from './privacy'
import {
    ANIMATION_LAB_BUDGET_CATALOG_VERSION,
    type AnimationLabMetric,
    type LabBudgetDefinitionV1,
    type LabBudgetRuleDefinitionV1,
    type LabMeasurementContractV2,
    type LabMetricCatalogVersion,
    type LabMetricUnit,
} from './types'

const MAX_ERRORS = 32
const MAX_RULES = 64
const MAX_PROFILE_VERSION = 1_000_000
const MAX_MINIMUM_SAMPLES = 10_000_000
const COMPARATORS = new Set(['<=', '>=', '<', '>'])
const METRIC_CATALOG_VERSIONS = new Set([1, 2, 3, 4, 5])
const PROFILE_KEYS = new Set(['catalogVersion', 'budgetId', 'budgetVersion', 'rules'])
const RULE_KEYS = new Set(['ruleId', 'metricId', 'comparator', 'target', 'minimumSamples'])
const ABSOLUTE_TARGET_KEYS = new Set(['kind', 'value', 'unit'])

export type LabProjectBudgetEvidenceStatus = 'measured' | 'partial' | 'not-measured'
export type LabProjectBudgetOutcome = 'pass' | 'breach' | 'not-evaluated'
export type LabProjectBudgetNotEvaluatedReason =
    | 'metric-missing'
    | 'metric-ambiguous'
    | 'metric-invalid'
    | 'metric-not-measured'
    | 'minimum-samples-not-met'
    | 'partial-within-threshold'
    | 'invalid-target-frame'

export interface LabProjectBudgetRuleEvaluationV1 {
    ruleId: string
    metricId: string
    valueUnit: LabMetricUnit
    targetUnit: LabMetricUnit
    evidence: LabProjectBudgetEvidenceStatus
    outcome: LabProjectBudgetOutcome
    target: number | null
    value: number | null
    samples: number | null
    reason?: LabProjectBudgetNotEvaluatedReason
}

export interface LabProjectBudgetProfileEvaluationV1 {
    catalogVersion: 1
    budgetId: string
    budgetVersion: number
    metricCatalogVersion: LabMetricCatalogVersion
    evidence: LabProjectBudgetEvidenceStatus
    outcome: LabProjectBudgetOutcome
    rules: readonly LabProjectBudgetRuleEvaluationV1[]
}

export type LabProjectBudgetValidationResult =
    | { ok: true; value: Readonly<LabBudgetDefinitionV1> }
    | { ok: false; errors: readonly string[] }

export type LabProjectBudgetEvaluationResult =
    | { ok: true; value: Readonly<LabProjectBudgetProfileEvaluationV1> }
    | { ok: false; errors: readonly string[] }

function record(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype)
}

function add(errors: string[], code: string): void {
    if (errors.length < MAX_ERRORS && !errors.includes(code)) errors.push(code)
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string, errors: string[]): void {
    for (const key of Object.keys(value)) if (!allowed.has(key)) add(errors, `${label}:unsupported-${key.slice(0, 40)}`)
}

function finiteNonNegative(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
}

function validAbsoluteThreshold(unit: string, value: unknown): value is number {
    if (!finiteNonNegative(value)) return false
    if (unit === 'ratio' || unit === 'score') return value <= 1
    if (unit === 'count' || unit === 'bytes' || unit === 'pixels' || unit === 'frames') return Number.isInteger(value)
    return true
}

function positiveInteger(value: unknown, maximum: number): value is number {
    return Number.isInteger(value) && typeof value === 'number' && value >= 1 && value <= maximum
}

function nonNegativeInteger(value: unknown, maximum: number): value is number {
    return Number.isInteger(value) && typeof value === 'number' && value >= 0 && value <= maximum
}

function token(value: unknown): value is string {
    return typeof value === 'string' && safeToken(value, '', 120) === value
}

/**
 * Strictly validates a project-owned budget profile against one existing
 * metric catalog. The profile reuses the versioned default-budget shape so a
 * bundled default can be passed through this same boundary unchanged.
 */
export function validateAnimationLabProjectBudgetProfile(
    input: unknown,
    metricCatalogVersion: LabMetricCatalogVersion
): LabProjectBudgetValidationResult {
    const errors: string[] = []
    if (!METRIC_CATALOG_VERSIONS.has(metricCatalogVersion)) {
        return { ok: false, errors: ['profile:unsupported-metric-catalog-version'] }
    }
    if (!record(input)) return { ok: false, errors: ['profile:invalid-object'] }
    exactKeys(input, PROFILE_KEYS, 'profile', errors)

    if (input.catalogVersion !== ANIMATION_LAB_BUDGET_CATALOG_VERSION) add(errors, 'profile:unsupported-catalog-version')
    if (!token(input.budgetId)) add(errors, 'profile:invalid-id')
    if (!positiveInteger(input.budgetVersion, MAX_PROFILE_VERSION)) add(errors, 'profile:invalid-version')
    if (!Array.isArray(input.rules) || input.rules.length < 1 || input.rules.length > MAX_RULES) add(errors, 'profile:invalid-rule-count')

    const normalizedRules: LabBudgetRuleDefinitionV1[] = []
    const ruleIds = new Set<string>()
    const metricComparators = new Set<string>()
    if (Array.isArray(input.rules)) {
        input.rules.slice(0, MAX_RULES).forEach((candidate, index) => {
            const label = `rules[${index}]`
            if (!record(candidate)) {
                add(errors, `${label}:invalid-object`)
                return
            }
            exactKeys(candidate, RULE_KEYS, label, errors)
            if (!token(candidate.ruleId)) add(errors, `${label}:invalid-id`)
            else if (ruleIds.has(candidate.ruleId)) add(errors, 'profile:duplicate-rule-id')
            else ruleIds.add(candidate.ruleId)

            const catalogEntry =
                typeof candidate.metricId === 'string'
                    ? getAnimationLabMetricCatalogEntry(candidate.metricId, metricCatalogVersion)
                    : undefined
            if (!catalogEntry) add(errors, `${label}:unknown-metric-id`)

            if (!COMPARATORS.has(candidate.comparator as string)) add(errors, `${label}:invalid-comparator`)
            else if (catalogEntry) {
                const identity = `${catalogEntry.metricId}\u0000${String(candidate.comparator)}`
                if (metricComparators.has(identity)) add(errors, 'profile:duplicate-metric-comparator')
                else metricComparators.add(identity)
            }

            if (!nonNegativeInteger(candidate.minimumSamples, MAX_MINIMUM_SAMPLES)) {
                add(errors, `${label}:invalid-minimum-samples`)
            } else if (candidate.minimumSamples === 0 && catalogEntry?.stat !== 'count') {
                add(errors, `${label}:zero-sample-threshold-requires-count-metric`)
            }

            let target: LabBudgetRuleDefinitionV1['target'] | undefined
            if (!record(candidate.target)) add(errors, `${label}:invalid-target`)
            else {
                exactKeys(candidate.target, ABSOLUTE_TARGET_KEYS, `${label}.target`, errors)
                if (!finiteNonNegative(candidate.target.value)) add(errors, `${label}:invalid-threshold`)
                if (candidate.target.kind === 'absolute') {
                    if (catalogEntry && candidate.target.unit !== catalogEntry.unit) add(errors, `${label}:threshold-unit-mismatch`)
                    else if (catalogEntry && !validAbsoluteThreshold(catalogEntry.unit, candidate.target.value)) {
                        add(errors, `${label}:invalid-threshold-for-unit`)
                    } else if (catalogEntry && finiteNonNegative(candidate.target.value)) {
                        target = { kind: 'absolute', value: candidate.target.value, unit: catalogEntry.unit }
                    }
                } else if (candidate.target.kind === 'target-frame-multiple') {
                    if (candidate.target.unit !== 'ratio' || catalogEntry?.unit !== 'ms') {
                        add(errors, `${label}:invalid-target-frame-threshold`)
                    } else if (finiteNonNegative(candidate.target.value)) {
                        target = { kind: 'target-frame-multiple', value: candidate.target.value, unit: 'ratio' }
                    }
                } else add(errors, `${label}:invalid-target-kind`)
            }

            if (
                token(candidate.ruleId) &&
                catalogEntry &&
                COMPARATORS.has(candidate.comparator as string) &&
                nonNegativeInteger(candidate.minimumSamples, MAX_MINIMUM_SAMPLES) &&
                !(candidate.minimumSamples === 0 && catalogEntry.stat !== 'count') &&
                target
            ) {
                normalizedRules.push({
                    ruleId: candidate.ruleId,
                    metricId: catalogEntry.metricId,
                    comparator: candidate.comparator as LabBudgetRuleDefinitionV1['comparator'],
                    target: Object.freeze(target),
                    minimumSamples: candidate.minimumSamples,
                })
            }
        })
    }

    if (errors.length > 0 || typeof input.budgetId !== 'string' || typeof input.budgetVersion !== 'number') {
        return { ok: false, errors: Object.freeze(errors) }
    }
    return {
        ok: true,
        value: Object.freeze({
            catalogVersion: ANIMATION_LAB_BUDGET_CATALOG_VERSION,
            budgetId: input.budgetId,
            budgetVersion: input.budgetVersion,
            rules: Object.freeze(normalizedRules.map(rule => Object.freeze(rule))),
        }),
    }
}

function classifyEvidence(metric: Pick<AnimationLabMetric, 'value' | 'samples' | 'status'>): LabProjectBudgetEvidenceStatus {
    if (
        (metric.status !== 'measured' && metric.status !== 'partial') ||
        !finiteNonNegative(metric.value) ||
        !nonNegativeInteger(metric.samples, MAX_MINIMUM_SAMPLES)
    ) {
        return 'not-measured'
    }
    return metric.status
}

function evaluateRule(
    rule: LabBudgetRuleDefinitionV1,
    matchingMetrics: readonly Pick<AnimationLabMetric, 'metricId' | 'value' | 'samples' | 'status'>[],
    contract: Pick<LabMeasurementContractV2, 'targetFrameMs'>,
    metricCatalogVersion: LabMetricCatalogVersion
): LabProjectBudgetRuleEvaluationV1 {
    const catalogEntry = getAnimationLabMetricCatalogEntry(rule.metricId, metricCatalogVersion)
    if (!catalogEntry) {
        throw new Error(`Validated project budget references an unavailable metric: ${rule.metricId}`)
    }
    const base = {
        ruleId: rule.ruleId,
        metricId: rule.metricId,
        valueUnit: catalogEntry.unit,
        targetUnit: catalogEntry.unit,
    }
    if (matchingMetrics.length === 0) {
        return {
            ...base,
            evidence: 'not-measured',
            outcome: 'not-evaluated',
            target: null,
            value: null,
            samples: null,
            reason: 'metric-missing',
        }
    }
    if (matchingMetrics.length > 1) {
        return {
            ...base,
            evidence: 'not-measured',
            outcome: 'not-evaluated',
            target: null,
            value: null,
            samples: null,
            reason: 'metric-ambiguous',
        }
    }

    const metric = matchingMetrics[0]!
    const evidence = classifyEvidence(metric)
    const value = finiteNonNegative(metric.value) ? metric.value : null
    const samples = nonNegativeInteger(metric.samples, MAX_MINIMUM_SAMPLES) ? metric.samples : null
    if (evidence === 'not-measured') {
        const reason = metric.status === 'measured' || metric.status === 'partial' ? 'metric-invalid' : 'metric-not-measured'
        return { ...base, evidence, outcome: 'not-evaluated', target: null, value, samples, reason }
    }

    const targetFrameValid = finiteNonNegative(contract.targetFrameMs) && contract.targetFrameMs > 0
    const target =
        rule.target.kind === 'absolute' ? rule.target.value : targetFrameValid ? resolveAnimationLabBudgetTarget(rule, contract) : null
    if (
        samples === null ||
        samples < rule.minimumSamples ||
        (rule.minimumSamples === 0 && catalogEntry?.stat === 'count' && (value === 0) !== (samples === 0))
    ) {
        return {
            ...base,
            evidence,
            outcome: 'not-evaluated',
            target,
            value,
            samples,
            reason: 'minimum-samples-not-met',
        }
    }

    if (rule.target.kind === 'target-frame-multiple' && !targetFrameValid) {
        return { ...base, evidence, outcome: 'not-evaluated', target: null, value, samples, reason: 'invalid-target-frame' }
    }

    const evaluation = evaluateAnimationLabBudgetRule(rule, metric, contract)
    if (evaluation.status === 'breach' || evaluation.status === 'candidate-breach') {
        return { ...base, evidence, outcome: 'breach', target, value, samples }
    }
    if (evaluation.status === 'within-budget') return { ...base, evidence, outcome: 'pass', target, value, samples }
    return { ...base, evidence, outcome: 'not-evaluated', target, value, samples, reason: 'partial-within-threshold' }
}

/**
 * Validates and evaluates one complete project budget without expressions or
 * arbitrary callbacks. Duplicate metric inputs are ambiguous and fail closed.
 */
export function evaluateAnimationLabProjectBudgetProfile(
    input: unknown,
    metrics: readonly Pick<AnimationLabMetric, 'metricId' | 'value' | 'samples' | 'status'>[],
    contract: Pick<LabMeasurementContractV2, 'targetFrameMs'>,
    metricCatalogVersion: LabMetricCatalogVersion
): LabProjectBudgetEvaluationResult {
    const validated = validateAnimationLabProjectBudgetProfile(input, metricCatalogVersion)
    if (!validated.ok) return validated
    const rules = validated.value.rules.map(rule =>
        Object.freeze(
            evaluateRule(
                rule,
                metrics.filter(metric => metric.metricId === rule.metricId),
                contract,
                metricCatalogVersion
            )
        )
    )
    const evidence: LabProjectBudgetEvidenceStatus = rules.every(rule => rule.evidence === 'measured')
        ? 'measured'
        : rules.every(rule => rule.evidence === 'not-measured')
          ? 'not-measured'
          : 'partial'
    const outcome: LabProjectBudgetOutcome = rules.some(rule => rule.outcome === 'breach')
        ? 'breach'
        : rules.every(rule => rule.outcome === 'pass')
          ? 'pass'
          : 'not-evaluated'
    return {
        ok: true,
        value: Object.freeze({
            catalogVersion: validated.value.catalogVersion,
            budgetId: validated.value.budgetId,
            budgetVersion: validated.value.budgetVersion,
            metricCatalogVersion,
            evidence,
            outcome,
            rules: Object.freeze(rules),
        }),
    }
}
