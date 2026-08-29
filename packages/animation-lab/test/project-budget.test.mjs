import assert from 'node:assert/strict'
import test from 'node:test'

import {
    DEFAULT_ANIMATION_LAB_BUDGET_V2,
    evaluateAnimationLabProjectBudgetProfile,
    validateAnimationLabProjectBudgetProfile,
} from '../build/esm/index.js'

const contract = { targetFrameMs: 16.666667 }

function profile() {
    return {
        catalogVersion: 1,
        budgetId: 'project.checkout.animation',
        budgetVersion: 3,
        rules: [
            {
                ruleId: 'frame-tail',
                metricId: 'frame.duration.p95',
                comparator: '<=',
                target: { kind: 'target-frame-multiple', value: 1.25, unit: 'ratio' },
                minimumSamples: 120,
            },
            {
                ruleId: 'minimum-lighthouse-score',
                metricId: 'lighthouse.performance.score',
                comparator: '>=',
                target: { kind: 'absolute', value: 0.9, unit: 'score' },
                minimumSamples: 1,
            },
        ],
    }
}

test('validates and freezes a project profile using only closed catalog metrics and thresholds', () => {
    const result = validateAnimationLabProjectBudgetProfile(profile(), 1)
    assert.equal(result.ok, true)
    assert.equal(Object.isFrozen(result.value), true)
    assert.equal(Object.isFrozen(result.value.rules), true)
    assert.equal(Object.isFrozen(result.value.rules[0].target), true)
    assert.deepEqual(result.value, profile())
})

test('rejects invalid profile identity, version, shape, and absolute threshold semantics', () => {
    assert.deepEqual(validateAnimationLabProjectBudgetProfile(null, 1), { ok: false, errors: ['profile:invalid-object'] })

    const input = profile()
    input.catalogVersion = 2
    input.budgetId = 'private profile expression'
    input.budgetVersion = 0
    input.rules = [
        {
            ruleId: 'negative-threshold',
            metricId: 'frame.duration.p95',
            comparator: '<=',
            target: { kind: 'absolute', value: -1, unit: 'count' },
            minimumSamples: 1,
        },
    ]
    const result = validateAnimationLabProjectBudgetProfile(input, 1)
    assert.equal(result.ok, false)
    for (const code of [
        'profile:unsupported-catalog-version',
        'profile:invalid-id',
        'profile:invalid-version',
        'rules[0]:invalid-threshold',
        'rules[0]:threshold-unit-mismatch',
    ]) {
        assert.ok(result.errors.includes(code), code)
    }

    assert.deepEqual(validateAnimationLabProjectBudgetProfile({ ...profile(), rules: [] }, 1), {
        ok: false,
        errors: ['profile:invalid-rule-count'],
    })
})

test('rejects duplicate, unknown, expression-like, and invalid threshold definitions', () => {
    const input = profile()
    input.expression = 'metric.value > 0'
    input.rules.push(
        { ...input.rules[0] },
        {
            ruleId: 'unknown-metric',
            metricId: 'project.private.metric',
            comparator: 'eval',
            target: { kind: 'absolute', value: 'targetFrameMs * 2', unit: 'ms', expression: 'targetFrameMs * 2' },
            minimumSamples: -1,
        },
        {
            ruleId: 'bad-unit',
            metricId: 'frame.slow-rate',
            comparator: '<=',
            target: { kind: 'target-frame-multiple', value: Number.POSITIVE_INFINITY, unit: 'ratio' },
            minimumSamples: 0,
        },
        {
            ruleId: 'ratio-out-of-range',
            metricId: 'frame.slow-rate',
            comparator: '<=',
            target: { kind: 'absolute', value: 1.1, unit: 'ratio' },
            minimumSamples: 1,
        },
        {
            ruleId: 'fractional-count',
            metricId: 'frame.jank-bursts',
            comparator: '<=',
            target: { kind: 'absolute', value: 0.5, unit: 'count' },
            minimumSamples: 1,
        }
    )

    const result = validateAnimationLabProjectBudgetProfile(input, 1)
    assert.equal(result.ok, false)
    for (const code of [
        'profile:unsupported-expression',
        'profile:duplicate-rule-id',
        'profile:duplicate-metric-comparator',
        'rules[3]:unknown-metric-id',
        'rules[3]:invalid-comparator',
        'rules[3].target:unsupported-expression',
        'rules[3]:invalid-threshold',
        'rules[3]:invalid-minimum-samples',
        'rules[4]:invalid-target-frame-threshold',
        'rules[4]:invalid-threshold',
        'rules[4]:zero-sample-threshold-requires-count-metric',
        'rules[5]:invalid-threshold-for-unit',
        'rules[6]:invalid-threshold-for-unit',
    ]) {
        assert.ok(result.errors.includes(code), code)
    }
})

test('rejects metrics that do not exist in the explicitly selected catalog version', () => {
    const input = profile()
    input.rules = [
        {
            ruleId: 'gpu-tail',
            metricId: 'renderer.gpu-frame.p95',
            comparator: '<=',
            target: { kind: 'absolute', value: 12, unit: 'ms' },
            minimumSamples: 30,
        },
    ]
    assert.deepEqual(validateAnimationLabProjectBudgetProfile(input, 3), {
        ok: false,
        errors: ['rules[0]:unknown-metric-id'],
    })
    assert.equal(validateAnimationLabProjectBudgetProfile(input, 4).ok, true)
    assert.deepEqual(validateAnimationLabProjectBudgetProfile(input, 99), {
        ok: false,
        errors: ['profile:unsupported-metric-catalog-version'],
    })
})

test('evaluates measured pass/breach and a partial candidate breach without hiding profile coverage', () => {
    const result = evaluateAnimationLabProjectBudgetProfile(
        profile(),
        [
            { metricId: 'frame.duration.p95', value: 24, samples: 120, status: 'partial' },
            { metricId: 'lighthouse.performance.score', value: 0.95, samples: 1, status: 'measured' },
        ],
        contract,
        1
    )
    assert.equal(result.ok, true)
    assert.equal(result.value.evidence, 'partial')
    assert.equal(result.value.outcome, 'breach')
    assert.deepEqual(result.value.rules, [
        {
            ruleId: 'frame-tail',
            metricId: 'frame.duration.p95',
            valueUnit: 'ms',
            targetUnit: 'ms',
            evidence: 'partial',
            outcome: 'breach',
            target: 20.83333375,
            value: 24,
            samples: 120,
        },
        {
            ruleId: 'minimum-lighthouse-score',
            metricId: 'lighthouse.performance.score',
            valueUnit: 'score',
            targetUnit: 'score',
            evidence: 'measured',
            outcome: 'pass',
            target: 0.9,
            value: 0.95,
            samples: 1,
        },
    ])
})

test('evaluates strict less-than and greater-than comparators at their exact boundary', () => {
    const input = {
        ...profile(),
        rules: [
            {
                ruleId: 'strict-frame-tail',
                metricId: 'frame.duration.p95',
                comparator: '<',
                target: { kind: 'absolute', value: 20, unit: 'ms' },
                minimumSamples: 1,
            },
            {
                ruleId: 'strict-score-floor',
                metricId: 'lighthouse.performance.score',
                comparator: '>',
                target: { kind: 'absolute', value: 0.9, unit: 'score' },
                minimumSamples: 1,
            },
        ],
    }
    const boundary = evaluateAnimationLabProjectBudgetProfile(
        input,
        [
            { metricId: 'frame.duration.p95', value: 20, samples: 1, status: 'measured' },
            { metricId: 'lighthouse.performance.score', value: 0.9, samples: 1, status: 'measured' },
        ],
        contract,
        1
    )
    assert.equal(boundary.ok, true)
    assert.deepEqual(
        boundary.value.rules.map(rule => rule.outcome),
        ['breach', 'breach']
    )

    const passing = evaluateAnimationLabProjectBudgetProfile(
        input,
        [
            { metricId: 'frame.duration.p95', value: 19, samples: 1, status: 'measured' },
            { metricId: 'lighthouse.performance.score', value: 0.91, samples: 1, status: 'measured' },
        ],
        contract,
        1
    )
    assert.equal(passing.ok, true)
    assert.equal(passing.value.outcome, 'pass')
})

test('keeps insufficient, missing, unsupported, and ambiguous evidence not evaluated', () => {
    const measuredButSmall = evaluateAnimationLabProjectBudgetProfile(
        profile(),
        [
            { metricId: 'frame.duration.p95', value: 30, samples: 10, status: 'measured' },
            { metricId: 'lighthouse.performance.score', value: null, samples: null, status: 'unsupported' },
        ],
        contract,
        1
    )
    assert.equal(measuredButSmall.ok, true)
    assert.equal(measuredButSmall.value.evidence, 'partial')
    assert.equal(measuredButSmall.value.outcome, 'not-evaluated')
    assert.equal(measuredButSmall.value.rules[0].evidence, 'measured')
    assert.equal(measuredButSmall.value.rules[0].reason, 'minimum-samples-not-met')
    assert.equal(measuredButSmall.value.rules[1].evidence, 'not-measured')
    assert.equal(measuredButSmall.value.rules[1].reason, 'metric-not-measured')

    const ambiguous = evaluateAnimationLabProjectBudgetProfile(
        { ...profile(), rules: [profile().rules[0]] },
        [
            { metricId: 'frame.duration.p95', value: 10, samples: 120, status: 'measured' },
            { metricId: 'frame.duration.p95', value: 11, samples: 120, status: 'measured' },
        ],
        contract,
        1
    )
    assert.equal(ambiguous.ok, true)
    assert.equal(ambiguous.value.evidence, 'not-measured')
    assert.equal(ambiguous.value.outcome, 'not-evaluated')
    assert.equal(ambiguous.value.rules[0].reason, 'metric-ambiguous')
})

test('maps a partial value within threshold to not-evaluated instead of a false pass', () => {
    const input = { ...profile(), rules: [profile().rules[0]] }
    const result = evaluateAnimationLabProjectBudgetProfile(
        input,
        [{ metricId: 'frame.duration.p95', value: 18, samples: 120, status: 'partial' }],
        contract,
        1
    )
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.rules[0], {
        ruleId: 'frame-tail',
        metricId: 'frame.duration.p95',
        valueUnit: 'ms',
        targetUnit: 'ms',
        evidence: 'partial',
        outcome: 'not-evaluated',
        target: 20.83333375,
        value: 18,
        samples: 120,
        reason: 'partial-within-threshold',
    })
})

test('accepts bundled default budgets unchanged and preserves their rule semantics', () => {
    const validated = validateAnimationLabProjectBudgetProfile(DEFAULT_ANIMATION_LAB_BUDGET_V2, 1)
    assert.equal(validated.ok, true)
    assert.deepEqual(validated.value, DEFAULT_ANIMATION_LAB_BUDGET_V2)

    const result = evaluateAnimationLabProjectBudgetProfile(
        {
            ...DEFAULT_ANIMATION_LAB_BUDGET_V2,
            rules: [DEFAULT_ANIMATION_LAB_BUDGET_V2.rules.find(rule => rule.ruleId === 'long-task-count')],
        },
        [{ metricId: 'main.long-task.count', value: 0, samples: 0, status: 'measured' }],
        contract,
        1
    )
    assert.equal(result.ok, true)
    assert.equal(result.value.evidence, 'measured')
    assert.equal(result.value.outcome, 'pass')
    assert.equal(result.value.rules[0].outcome, 'pass')
})

test('fails closed when a target-frame rule receives an invalid frame contract', () => {
    const input = { ...profile(), rules: [profile().rules[0]] }
    const result = evaluateAnimationLabProjectBudgetProfile(
        input,
        [{ metricId: 'frame.duration.p95', value: 18, samples: 120, status: 'measured' }],
        { targetFrameMs: Number.NaN },
        1
    )
    assert.equal(result.ok, true)
    assert.equal(result.value.rules[0].outcome, 'not-evaluated')
    assert.equal(result.value.rules[0].reason, 'invalid-target-frame')
})
