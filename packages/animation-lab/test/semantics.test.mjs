import assert from 'node:assert/strict'
import test from 'node:test'

import {
    ANIMATION_LAB_METRIC_CATALOG_V1,
    ANIMATION_LAB_METRIC_CATALOG_V2,
    DEFAULT_ANIMATION_LAB_BUDGET_REF_V1,
    DEFAULT_ANIMATION_LAB_BUDGET_REF_V2,
    DEFAULT_ANIMATION_LAB_BUDGET_V1,
    DEFAULT_ANIMATION_LAB_BUDGET_V2,
    evaluateAnimationLabBudgetRule,
    getAnimationLabBudgetV1,
    getAnimationLabMetricCatalogEntry,
    validateAnimationLabSemanticsV2,
    validateLabMeasurementContract,
} from '../build/esm/index.js'

function budgetRef(ruleId) {
    return { ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V1, ruleId }
}

function semantics() {
    return {
        semanticsVersion: 2,
        measurementContract: {
            contractVersion: 2,
            expectedHz: 60,
            targetFrameMs: 16.666667,
            source: 'explicit',
            confidence: 'explicit',
            budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V1,
            metricCatalogVersion: 1,
        },
        scenarioActions: [
            {
                actionId: 'hero-hover-01',
                order: 0,
                kind: 'hover',
                label: 'hero-hover',
                subject: { scope: 'subject', subjectKey: 'hero.primary', role: 'hero', surface: 'dom' },
                trigger: { source: 'scenario' },
            },
        ],
        actionWindows: [
            {
                actionId: 'hero-hover-01',
                order: 0,
                kind: 'hover',
                trigger: { source: 'scenario' },
                subject: { scope: 'subject', subjectKey: 'hero.primary', role: 'hero', surface: 'dom' },
                outcome: { status: 'completed', outcomeKey: 'motion-observed' },
                timestamps: { clock: 'attempt-monotonic', startedAtMs: 100, endedAtMs: 125, durationMs: 25 },
                evidenceRefs: ['technology.browser.chromium'],
                limitations: [],
            },
        ],
        metrics: [
            {
                metricId: 'frame.duration.p95',
                family: 'frameCadence',
                name: 'frameDurationMs',
                stat: 'p95',
                unit: 'ms',
                value: 20,
                samples: 3,
                status: 'measured',
                evidenceLevel: 'controlled-lab-measurement',
                scope: { level: 'action', actionId: 'hero-hover-01' },
                aggregation: { population: 'attempts', method: 'median-of-attempts' },
                budgetRefs: [budgetRef('frame-tail')],
                evidenceRefs: ['technology.browser.chromium'],
                limitations: ['temporal-overlap-not-causation'],
            },
        ],
        technologyEvidence: [
            {
                evidenceId: 'technology.browser.chromium',
                axis: 'browser-runtime',
                technologyKey: 'chromium',
                version: '140.0.0',
                source: 'runtime-probe',
                confidence: 'high',
                status: 'observed',
                scope: { level: 'action', actionId: 'hero-hover-01' },
                actionId: 'hero-hover-01',
                limitations: [],
            },
        ],
        findings: [
            {
                findingId: 'finding.frame-tail.hero',
                ruleId: 'frame-tail',
                severity: 'warning',
                status: 'observed',
                scope: { level: 'action', actionId: 'hero-hover-01' },
                metricIds: ['frame.duration.p95'],
                evidenceRefs: ['technology.browser.chromium'],
                budgetRefs: [budgetRef('frame-tail')],
                actionIds: ['hero-hover-01'],
                limitations: ['temporal-overlap-not-causation'],
            },
        ],
    }
}

test('accepts a fully referenced selector-free v2 semantic bundle', () => {
    const result = validateAnimationLabSemanticsV2(semantics())
    assert.equal(result.ok, true)
    assert.equal(result.value.metrics[0].scope.attemptId, undefined)
    assert.equal(result.value.metrics[0].aggregation.method, 'median-of-attempts')
})

test('requires unsupported-or-unknown evidence exactly for unsupported or unknown metric statuses', () => {
    const mismatches = [
        { status: 'unsupported', evidenceLevel: 'controlled-lab-measurement', value: null, samples: null },
        { status: 'unknown', evidenceLevel: 'runtime-observation', value: null, samples: null },
        { status: 'measured', evidenceLevel: 'unsupported-or-unknown', value: 20, samples: 3 },
        { status: 'partial', evidenceLevel: 'unsupported-or-unknown', value: 20, samples: 2 },
        { status: 'not-observed', evidenceLevel: 'unsupported-or-unknown', value: null, samples: 0 },
    ]
    for (const mismatch of mismatches) {
        const input = semantics()
        input.measurementContract.metricCatalogVersion = 2
        input.metrics[0] = { ...input.metrics[0], ...mismatch }
        input.findings = []
        const result = validateAnimationLabSemanticsV2(input)
        assert.equal(result.ok, false)
        assert.ok(result.errors.includes('metrics[0]:status-evidence-mismatch'))
    }

    for (const valid of [
        { status: 'unknown', evidenceLevel: 'unsupported-or-unknown', value: null, samples: null },
        { status: 'not-observed', evidenceLevel: 'controlled-lab-measurement', value: null, samples: 0 },
        { status: 'partial', evidenceLevel: 'runtime-observation', value: 20, samples: 2 },
    ]) {
        const input = semantics()
        input.measurementContract.metricCatalogVersion = 2
        input.metrics[0] = { ...input.metrics[0], ...valid }
        input.findings = []
        assert.equal(validateAnimationLabSemanticsV2(input).ok, true)
    }
})

test('accepts the legacy catalog v1 unsupported evidence shape', () => {
    const input = semantics()
    input.metrics[0] = {
        ...input.metrics[0],
        value: null,
        samples: null,
        status: 'unsupported',
        evidenceLevel: 'controlled-lab-measurement',
    }
    input.findings = []
    assert.equal(validateAnimationLabSemanticsV2(input).ok, true)

    input.metrics[0] = {
        ...input.metrics[0],
        value: 20,
        samples: 3,
        status: 'measured',
        evidenceLevel: 'unsupported-or-unknown',
    }
    const forgedAvailable = validateAnimationLabSemanticsV2(input)
    assert.equal(forgedAvailable.ok, false)
    assert.ok(forgedAvailable.errors.includes('metrics[0]:status-evidence-mismatch'))
})

test('rejects unknown report fields and selector or DOM-text channels', () => {
    const selectorInput = semantics()
    selectorInput.scenarioActions[0].selector = '[data-private="customer-name"]'
    selectorInput.scenarioActions[0].subject.subjectKey = 'Customer full name from DOM'
    const selectorResult = validateAnimationLabSemanticsV2(selectorInput)
    assert.equal(selectorResult.ok, false)
    assert.ok(selectorResult.errors.includes('semantic-report:forbidden-field'))
    assert.ok(selectorResult.errors.includes('scenarioActions[0]:unsupported-selector'))
    assert.ok(selectorResult.errors.includes('scenarioActions[0].subject:invalid-subject-key'))

    const metricInput = semantics()
    metricInput.metrics[0].details = { text: 'private DOM copy' }
    const metricResult = validateAnimationLabSemanticsV2(metricInput)
    assert.equal(metricResult.ok, false)
    assert.ok(metricResult.errors.includes('metrics[0]:unsupported-details'))
    assert.ok(metricResult.errors.includes('semantic-report:forbidden-field'))
})

test('rejects broken references, tuple drift, timestamps, and refresh contracts', () => {
    const input = semantics()
    input.measurementContract.targetFrameMs = 8.333333
    input.actionWindows[0].timestamps.durationMs = 1
    input.metrics[0].name = 'customMetricChannel'
    input.metrics[0].evidenceRefs = ['missing-evidence']
    input.findings[0].actionIds = ['missing-action']

    const result = validateAnimationLabSemanticsV2(input)
    assert.equal(result.ok, false)
    assert.ok(result.errors.includes('measurementContract:inconsistent-frame-target'))
    assert.ok(result.errors.includes('actionWindows[0].timestamps:inconsistent'))
    assert.ok(result.errors.includes('metrics[0]:catalog-tuple-mismatch'))
    assert.ok(result.errors.includes('metrics:unknown-evidence-ref'))
    assert.ok(result.errors.includes('findings:unknown-action-id'))
})

test('central metric and budget catalogs are closed, unique, and internally referenced', () => {
    const metricIds = ANIMATION_LAB_METRIC_CATALOG_V1.map(metric => metric.metricId)
    assert.equal(new Set(metricIds).size, metricIds.length)
    assert.ok(metricIds.length >= 50)
    assert.equal(getAnimationLabMetricCatalogEntry('frame.duration.p95').name, 'frameDurationMs')

    const ruleIds = DEFAULT_ANIMATION_LAB_BUDGET_V1.rules.map(rule => rule.ruleId)
    assert.equal(new Set(ruleIds).size, ruleIds.length)
    for (const rule of DEFAULT_ANIMATION_LAB_BUDGET_V1.rules) assert.ok(getAnimationLabMetricCatalogEntry(rule.metricId))
})

test('adds an explicit budget v2 without changing the v1 rule tuple', () => {
    assert.equal(DEFAULT_ANIMATION_LAB_BUDGET_V1.budgetVersion, 1)
    assert.equal(DEFAULT_ANIMATION_LAB_BUDGET_V1.rules.find(rule => rule.ruleId === 'long-task-count').minimumSamples, 1)
    assert.equal(DEFAULT_ANIMATION_LAB_BUDGET_V2.budgetVersion, 2)
    assert.deepEqual(
        DEFAULT_ANIMATION_LAB_BUDGET_V2.rules.map(rule => ({
            ...rule,
            minimumSamples: rule.ruleId === 'long-task-count' ? 1 : rule.minimumSamples,
        })),
        DEFAULT_ANIMATION_LAB_BUDGET_V1.rules
    )
    assert.equal(DEFAULT_ANIMATION_LAB_BUDGET_V2.rules.find(rule => rule.ruleId === 'long-task-count').minimumSamples, 0)
    assert.equal(getAnimationLabBudgetV1('condev.animation.default', 1), DEFAULT_ANIMATION_LAB_BUDGET_V1)
    assert.equal(getAnimationLabBudgetV1('condev.animation.default', 2), DEFAULT_ANIMATION_LAB_BUDGET_V2)
    assert.equal(getAnimationLabBudgetV1('condev.animation.default', 3), undefined)
})

test('evaluates zero-event count evidence only for the opted-in budget version', () => {
    const contract = { targetFrameMs: 16.666667 }
    const zeroMetric = { metricId: 'main.long-task.count', value: 0, samples: 0, status: 'measured' }
    const positiveMetric = { ...zeroMetric, value: 1, samples: 1 }
    const partialPositive = { ...positiveMetric, status: 'partial' }
    const v1Rule = DEFAULT_ANIMATION_LAB_BUDGET_V1.rules.find(rule => rule.ruleId === 'long-task-count')
    const v2Rule = DEFAULT_ANIMATION_LAB_BUDGET_V2.rules.find(rule => rule.ruleId === 'long-task-count')

    assert.equal(evaluateAnimationLabBudgetRule(v1Rule, zeroMetric, contract).status, 'insufficient-evidence')
    assert.equal(evaluateAnimationLabBudgetRule(v2Rule, zeroMetric, contract).status, 'within-budget')
    assert.equal(evaluateAnimationLabBudgetRule(v2Rule, positiveMetric, contract).status, 'breach')
    assert.equal(evaluateAnimationLabBudgetRule(v2Rule, partialPositive, contract).status, 'candidate-breach')
    assert.equal(evaluateAnimationLabBudgetRule(v2Rule, { ...zeroMetric, status: 'partial' }, contract).status, 'insufficient-evidence')
    assert.equal(evaluateAnimationLabBudgetRule(v2Rule, { ...zeroMetric, samples: null }, contract).status, 'insufficient-evidence')
    assert.equal(evaluateAnimationLabBudgetRule(v2Rule, { ...zeroMetric, samples: 1 }, contract).status, 'insufficient-evidence')
    assert.equal(evaluateAnimationLabBudgetRule(v2Rule, { ...zeroMetric, value: 1 }, contract).status, 'insufficient-evidence')
    for (const status of ['not-observed', 'unsupported', 'unknown']) {
        assert.equal(
            evaluateAnimationLabBudgetRule(
                v2Rule,
                { ...zeroMetric, value: null, samples: status === 'not-observed' ? 0 : null, status },
                contract
            ).status,
            'insufficient-evidence'
        )
    }
})

test('rejects malformed budget refs without throwing from cross-reference checks', () => {
    const input = semantics()
    input.metrics[0].budgetRefs = [null]
    input.findings[0].budgetRefs = [null]
    assert.doesNotThrow(() => validateAnimationLabSemanticsV2(input))
    const result = validateAnimationLabSemanticsV2(input)
    assert.equal(result.ok, false)
    assert.ok(result.errors.includes('metrics[0].budgetRefs[0]:invalid'))
    assert.ok(result.errors.includes('findings[0].budgetRefs[0]:invalid'))

    for (const malformed of [null, {}]) {
        const malformedMetric = semantics()
        malformedMetric.metrics[0].budgetRefs = malformed
        assert.doesNotThrow(() => validateAnimationLabSemanticsV2(malformedMetric))
        const malformedResult = validateAnimationLabSemanticsV2(malformedMetric)
        assert.equal(malformedResult.ok, false)
        assert.ok(malformedResult.errors.includes('metrics[0].budgetRefs:invalid-count'))
    }

    const malformedEvidence = semantics()
    malformedEvidence.metrics[0].evidenceRefs = {}
    assert.doesNotThrow(() => validateAnimationLabSemanticsV2(malformedEvidence))
    const malformedEvidenceResult = validateAnimationLabSemanticsV2(malformedEvidence)
    assert.equal(malformedEvidenceResult.ok, false)
    assert.ok(malformedEvidenceResult.errors.includes('metrics[0].evidenceRefs:invalid-count'))
})

test('keeps catalog v1 unchanged while catalog v2 adds closed scheduling and LoAF diagnostic metrics', () => {
    assert.deepEqual(ANIMATION_LAB_METRIC_CATALOG_V2.slice(0, ANIMATION_LAB_METRIC_CATALOG_V1.length), ANIMATION_LAB_METRIC_CATALOG_V1)
    assert.equal(ANIMATION_LAB_METRIC_CATALOG_V2.length, ANIMATION_LAB_METRIC_CATALOG_V1.length + 10)
    assert.equal(getAnimationLabMetricCatalogEntry('pipeline.loaf-render-start-to-paint.p95', 1), undefined)
    assert.equal(getAnimationLabMetricCatalogEntry('pipeline.loaf-render-start-to-paint.p95'), undefined)
    assert.equal(
        getAnimationLabMetricCatalogEntry('pipeline.loaf-render-start-to-paint.p95', 2)?.name,
        'longAnimationFrameRenderStartToPaintMs'
    )
    assert.deepEqual(
        [
            'main.input-capture-to-next-raf-callback.count',
            'main.input-capture-to-next-raf-callback.p95',
            'interaction.loaf-first-ui-event-to-frame-end.count',
            'interaction.loaf-first-ui-event-to-frame-end.p95',
            'pipeline.loaf-attributed-forced-style-layout.count',
            'pipeline.loaf-attributed-forced-style-layout.p95',
        ].map(metricId => {
            const entry = getAnimationLabMetricCatalogEntry(metricId, 2)
            return [entry?.family, entry?.name, entry?.stat, entry?.unit]
        }),
        [
            ['mainThread', 'inputCaptureToNextRafCallbackCount', 'count', 'count'],
            ['mainThread', 'inputCaptureToNextRafCallbackMs', 'p95', 'ms'],
            ['userOutcome', 'longAnimationFrameFirstUIEventToFrameEndCount', 'count', 'count'],
            ['userOutcome', 'longAnimationFrameFirstUIEventToFrameEndMs', 'p95', 'ms'],
            ['renderingPipeline', 'longAnimationFrameAttributedForcedStyleAndLayoutCount', 'count', 'count'],
            ['renderingPipeline', 'longAnimationFrameAttributedForcedStyleAndLayoutMs', 'p95', 'ms'],
        ]
    )
    assert.throws(() => getAnimationLabMetricCatalogEntry('frame.duration.p95', 3), RangeError)
})

test('accepts additive v2 metrics only when the measurement contract selects catalog v2', () => {
    const input = semantics()
    input.measurementContract.metricCatalogVersion = 2
    input.metrics = [
        {
            metricId: 'pipeline.loaf-render-start-to-paint.p95',
            family: 'renderingPipeline',
            name: 'longAnimationFrameRenderStartToPaintMs',
            stat: 'p95',
            unit: 'ms',
            value: null,
            samples: 0,
            status: 'not-observed',
            evidenceLevel: 'controlled-lab-measurement',
            scope: { level: 'run' },
            aggregation: { population: 'frames', method: 'nearest-rank' },
            budgetRefs: [],
            evidenceRefs: ['technology.browser.chromium'],
            limitations: ['loaf-only-over-50ms'],
        },
    ]
    input.findings = []
    assert.equal(validateAnimationLabSemanticsV2(input).ok, true)

    input.measurementContract.metricCatalogVersion = 1
    const legacy = validateAnimationLabSemanticsV2(input)
    assert.equal(legacy.ok, false)
    assert.ok(legacy.errors.includes('metrics[0]:unknown-metric-id'))
})

test('measurement contract validator fails closed on unknown fields', () => {
    const value = semantics().measurementContract
    value.expectedFpsLabel = 'from DOM'
    const result = validateLabMeasurementContract(value)
    assert.equal(result.ok, false)
    assert.ok(result.errors.includes('measurementContract:unsupported-expectedFpsLabel'))
})

test('rejects a budget reference that the local runner cannot execute', () => {
    const value = semantics().measurementContract
    value.budgetRef = { catalogVersion: 1, budgetId: 'unloaded.project-budget', budgetVersion: 1 }
    const result = validateLabMeasurementContract(value)
    assert.equal(result.ok, false)
    assert.ok(result.errors.includes('measurementContract.budgetRef:unknown-local-budget'))

    value.budgetRef = DEFAULT_ANIMATION_LAB_BUDGET_REF_V2
    assert.equal(validateLabMeasurementContract(value).ok, true)
    value.budgetRef = { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 3 }
    const unknownVersion = validateLabMeasurementContract(value)
    assert.equal(unknownVersion.ok, false)
    assert.ok(unknownVersion.errors.includes('measurementContract.budgetRef:unknown-local-budget'))
})

test('accepts budget v2 and rejects mixed metric or finding budget references', () => {
    const input = semantics()
    input.measurementContract.budgetRef = DEFAULT_ANIMATION_LAB_BUDGET_REF_V2
    input.metrics[0].budgetRefs = [{ ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V2, ruleId: 'frame-tail' }]
    input.findings[0].budgetRefs = [{ ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V2, ruleId: 'frame-tail' }]
    assert.equal(validateAnimationLabSemanticsV2(input).ok, true)

    input.metrics[0].budgetRefs = [budgetRef('frame-tail')]
    const mixedMetric = validateAnimationLabSemanticsV2(input)
    assert.equal(mixedMetric.ok, false)
    assert.ok(mixedMetric.errors.includes('metrics:budget-ref-contract-mismatch'))

    input.metrics[0].budgetRefs = [{ ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V2, ruleId: 'frame-tail' }]
    input.findings[0].budgetRefs = [budgetRef('frame-tail')]
    const mixedFinding = validateAnimationLabSemanticsV2(input)
    assert.equal(mixedFinding.ok, false)
    assert.ok(mixedFinding.errors.includes('findings:budget-ref-contract-mismatch'))

    input.findings[0].budgetRefs = [{ ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V2, ruleId: 'long-task-count' }]
    const wrongFindingMetric = validateAnimationLabSemanticsV2(input)
    assert.equal(wrongFindingMetric.ok, false)
    assert.ok(wrongFindingMetric.errors.includes('findings:budget-rule-metric-mismatch'))

    input.findings[0].metricIds = ['frame.duration.p95']
    input.findings[0].ruleId = 'long-task-count'
    input.findings[0].budgetRefs = [{ ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V2, ruleId: 'frame-tail' }]
    const wrongFindingRuleId = validateAnimationLabSemanticsV2(input)
    assert.equal(wrongFindingRuleId.ok, false)
    assert.ok(wrongFindingRuleId.errors.includes('findings:rule-id-budget-ref-mismatch'))

    input.findings = []
    input.metrics[0].budgetRefs = [{ ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V2, ruleId: 'long-task-count' }]
    const wrongMetricRule = validateAnimationLabSemanticsV2(input)
    assert.equal(wrongMetricRule.ok, false)
    assert.ok(wrongMetricRule.errors.includes('metrics[0].budgetRefs[0]:metric-mismatch'))
})
