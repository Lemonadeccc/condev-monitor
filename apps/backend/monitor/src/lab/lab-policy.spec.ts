import { BadRequestException } from '@nestjs/common'

import type { ComparableAnimationLabResult, LabMetricComparison } from './lab-comparison'
import {
    digestLabProjectPolicyDefinition,
    evaluateLabProjectAbsoluteBudget,
    evaluateLabProjectComparisonPolicy,
    type LabProjectPolicyDefinitionV1,
    parseLabProjectPolicyDefinition,
} from './lab-policy'

function definition(overrides: Partial<LabProjectPolicyDefinitionV1> = {}) {
    return {
        schemaVersion: 1 as const,
        metricCatalogVersion: 5 as const,
        absoluteRules: [
            {
                ruleId: 'frame-tail',
                metricId: 'frame.duration.p95',
                comparator: '<=' as const,
                target: { kind: 'absolute' as const, value: 25, unit: 'ms' as const },
                minimumSamples: 120,
                severity: 'critical' as const,
            },
        ],
        comparisonRules: [
            {
                ruleId: 'frame-regression',
                metricId: 'frame.duration.p95',
                scope: { level: 'run' as const },
                operand: 'percent-change' as const,
                comparator: '<=' as const,
                target: { value: 10, unit: 'percent' as const },
                minimumAttemptsPerSide: 3,
                minimumUnderlyingSamples: 120,
                severity: 'warning' as const,
            },
        ],
        ...overrides,
    }
}

function distribution(median: number, underlyingMinimum = 180) {
    return {
        n: 3,
        min: median - 1,
        median,
        p75: median + 0.5,
        p95: median + 1,
        max: median + 1,
        underlyingSamples: { knownAttempts: 3, total: underlyingMinimum * 3, min: underlyingMinimum, max: underlyingMinimum },
    }
}

function metric(before = 20, after = 24, percentChange: number | null = 20): LabMetricComparison {
    return {
        metricId: 'frame.duration.p95',
        family: 'frameCadence',
        name: 'frameDurationMs',
        stat: 'p95',
        unit: 'ms',
        scope: { level: 'run' },
        sourceAggregation: { population: 'frames', method: 'nearest-rank' },
        comparisonAggregation: { population: 'measured-attempts', method: 'median' },
        budgetRefs: [],
        evidenceRefs: ['page-probe'],
        evidenceLevel: 'controlled-lab-measurement',
        evidenceStatus: 'measured',
        before: distribution(before),
        after: distribution(after),
        delta: after - before,
        percentChange,
        direction: after > before ? 'increase' : after < before ? 'decrease' : 'unchanged',
    }
}

function comparison(metrics: LabMetricComparison[] = [metric()]): ComparableAnimationLabResult {
    return {
        schemaVersion: 1,
        kind: 'animation-lab-before-after',
        comparable: true,
        trust: 'caller-attested',
        beforeRunId: 'before-run',
        afterRunId: 'after-run',
        scenarioKey: 'hero.hover',
        routeKey: 'home',
        conditions: {} as never,
        caveats: ['attempt-distribution-is-descriptive', 'no-statistical-significance-inference'],
        coverage: {
            beforeAttempts: 3,
            afterAttempts: 3,
            candidateMetricTuples: metrics.length,
            comparedMetrics: metrics.length,
            excludedMetrics: 0,
            retainedExcludedMetrics: 0,
            droppedExcludedMetrics: 0,
        },
        metrics,
        excluded: [],
    }
}

const policyRef = { policyKey: 'project-animation', version: 3, digest: 'a'.repeat(64) }

describe('Lab project policy', () => {
    it('parses a closed definition and produces an order-stable digest', () => {
        const input = definition({
            comparisonRules: [
                definition().comparisonRules[0]!,
                {
                    ...definition().comparisonRules[0]!,
                    ruleId: 'frame-delta',
                    operand: 'signed-delta',
                    target: { value: 3, unit: 'ms' },
                },
            ],
        })
        const parsed = parseLabProjectPolicyDefinition(input)
        const reordered = parseLabProjectPolicyDefinition({
            comparisonRules: [...input.comparisonRules].reverse(),
            absoluteRules: [...input.absoluteRules].reverse(),
            metricCatalogVersion: 5,
            schemaVersion: 1,
        })

        expect(parsed.absoluteRules).toHaveLength(1)
        expect(parsed.comparisonRules).toHaveLength(2)
        expect(parsed.comparisonRules.map(rule => rule.ruleId)).toEqual(['frame-delta', 'frame-regression'])
        expect(digestLabProjectPolicyDefinition(parsed)).toBe(digestLabProjectPolicyDefinition(reordered))
    })

    it.each([
        { ...definition(), expression: 'value > 1' },
        definition({
            absoluteRules: [{ ...definition().absoluteRules[0]!, target: { kind: 'absolute', value: 25, unit: 'bytes' } }] as never,
        }),
        definition({
            comparisonRules: [
                definition().comparisonRules[0]!,
                { ...definition().comparisonRules[0]!, operand: 'signed-delta', target: { value: 5, unit: 'ms' } },
            ],
        }),
    ])('rejects open fields, unit drift, and duplicate rule identities', input => {
        expect(() => parseLabProjectPolicyDefinition(input)).toThrow(BadRequestException)
    })

    it('classifies a deterministic comparison breach without claiming significance', () => {
        const result = evaluateLabProjectComparisonPolicy(policyRef, parseLabProjectPolicyDefinition(definition()), comparison())

        expect(result.verdict).toBe('breach')
        expect(result.rules[0]).toMatchObject({ ruleId: 'frame-regression', status: 'breach', severity: 'warning' })
        expect(result.caveats).toContain('no-statistical-significance-inference')
    })

    it('returns within-policy only when every configured comparison rule has enough evidence', () => {
        const result = evaluateLabProjectComparisonPolicy(
            policyRef,
            parseLabProjectPolicyDefinition(definition()),
            comparison([metric(20, 21, 5)])
        )

        expect(result.verdict).toBe('within-policy')
        expect(result.coverage).toEqual({ totalRules: 1, evaluatedRules: 1, breachedRules: 0, indeterminateRules: 0 })
    })

    it('keeps an overall breach when another required rule is indeterminate', () => {
        const input = definition({
            comparisonRules: [
                definition().comparisonRules[0]!,
                {
                    ...definition().comparisonRules[0]!,
                    ruleId: 'long-task-change',
                    metricId: 'main.long-task.count',
                    operand: 'signed-delta',
                    target: { value: 0, unit: 'count' },
                },
            ],
        })
        const result = evaluateLabProjectComparisonPolicy(policyRef, parseLabProjectPolicyDefinition(input), comparison())

        expect(result.verdict).toBe('breach')
        expect(result.coverage).toEqual({ totalRules: 2, evaluatedRules: 1, breachedRules: 1, indeterminateRules: 1 })
        expect(result.rules.find(rule => rule.ruleId === 'long-task-change')).toMatchObject({
            status: 'indeterminate',
            reasonCodes: ['metric-missing-or-excluded'],
        })
    })

    it('does not claim comparison success when a policy has no comparison rules', () => {
        const result = evaluateLabProjectComparisonPolicy(
            policyRef,
            parseLabProjectPolicyDefinition(definition({ comparisonRules: [] })),
            comparison()
        )

        expect(result.verdict).toBe('indeterminate')
        expect(result.coverage).toEqual({ totalRules: 0, evaluatedRules: 0, breachedRules: 0, indeterminateRules: 0 })
    })

    it.each([
        { metrics: [] as LabMetricComparison[], reason: 'metric-missing-or-excluded' },
        { metrics: [metric(0, 4, null)], reason: 'zero-baseline-percent-change-unavailable' },
        {
            metrics: [
                { ...metric(), before: { ...metric().before, underlyingSamples: { knownAttempts: 0, total: 0, min: null, max: null } } },
            ],
            reason: 'minimum-underlying-samples-not-met',
        },
    ])('keeps missing, zero-baseline, and insufficient evidence indeterminate', ({ metrics, reason }) => {
        const result = evaluateLabProjectComparisonPolicy(policyRef, parseLabProjectPolicyDefinition(definition()), comparison(metrics))

        expect(result.verdict).toBe('indeterminate')
        expect(result.rules[0]?.reasonCodes).toContain(reason)
    })

    it('evaluates run-level absolute project budgets without mutating measurement evidence', () => {
        const parsed = parseLabProjectPolicyDefinition(definition())
        const breached = evaluateLabProjectAbsoluteBudget(
            policyRef,
            parsed,
            [{ metricId: 'frame.duration.p95', value: 30, samples: 180, status: 'measured' }],
            16.666667
        )
        const partialWithin = evaluateLabProjectAbsoluteBudget(
            policyRef,
            parsed,
            [{ metricId: 'frame.duration.p95', value: 20, samples: 180, status: 'partial' }],
            16.666667
        )

        expect(breached).toMatchObject({ verdict: 'breach', evidence: 'measured' })
        expect(breached.rules[0]).toMatchObject({
            status: 'breach',
            severity: 'critical',
            value: 30,
            target: 25,
            valueUnit: 'ms',
            targetUnit: 'ms',
        })
        expect(partialWithin).toMatchObject({ verdict: 'indeterminate', evidence: 'partial' })
        expect(partialWithin.rules[0]).toMatchObject({ status: 'indeterminate', reason: 'partial-within-threshold' })
    })
})
