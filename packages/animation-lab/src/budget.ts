import type { AnimationLabMetric, LabBudgetRuleDefinitionV1, LabBudgetRuleEvaluationV1, LabMeasurementContractV2 } from './types'

function finiteNonNegative(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function resolveAnimationLabBudgetTarget(
    rule: LabBudgetRuleDefinitionV1,
    contract: Pick<LabMeasurementContractV2, 'targetFrameMs'>
): number {
    return rule.target.kind === 'target-frame-multiple' ? contract.targetFrameMs * rule.target.value : rule.target.value
}

function violates(value: number, rule: LabBudgetRuleDefinitionV1, target: number): boolean {
    if (rule.comparator === '<=') return value > target
    if (rule.comparator === '<') return value >= target
    if (rule.comparator === '>=') return value < target
    return value <= target
}

/**
 * Evaluates one metric against one closed budget rule without manufacturing a
 * sample. A zero-event count is sufficient only when that budget version sets
 * `minimumSamples` to zero and the producer explicitly reports finite
 * `samples: 0`, a finite value, and `status: measured`.
 */
export function evaluateAnimationLabBudgetRule(
    rule: LabBudgetRuleDefinitionV1,
    metric: Pick<AnimationLabMetric, 'metricId' | 'value' | 'samples' | 'status'>,
    contract: Pick<LabMeasurementContractV2, 'targetFrameMs'>
): LabBudgetRuleEvaluationV1 {
    const target = resolveAnimationLabBudgetTarget(rule, contract)
    if (
        metric.metricId !== rule.metricId ||
        !finiteNonNegative(metric.value) ||
        !finiteNonNegative(metric.samples) ||
        !Number.isInteger(metric.samples) ||
        metric.samples < rule.minimumSamples ||
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

    const breached = violates(metric.value, rule, target)
    if (metric.status === 'partial') {
        return { status: breached ? 'candidate-breach' : 'insufficient-evidence', target }
    }
    return { status: breached ? 'breach' : 'within-budget', target }
}
