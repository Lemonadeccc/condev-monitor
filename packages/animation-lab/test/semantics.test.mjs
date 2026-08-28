import assert from 'node:assert/strict'
import test from 'node:test'

import {
    ANIMATION_LAB_METRIC_CATALOG_V1,
    ANIMATION_LAB_METRIC_CATALOG_V2,
    ANIMATION_LAB_METRIC_CATALOG_V3,
    ANIMATION_LAB_METRIC_CATALOG_V4,
    DEFAULT_ANIMATION_LAB_BUDGET_REF_V1,
    DEFAULT_ANIMATION_LAB_BUDGET_REF_V2,
    DEFAULT_ANIMATION_LAB_BUDGET_REF_V3,
    DEFAULT_ANIMATION_LAB_BUDGET_REF_V4,
    DEFAULT_ANIMATION_LAB_BUDGET_V1,
    DEFAULT_ANIMATION_LAB_BUDGET_V2,
    DEFAULT_ANIMATION_LAB_BUDGET_V3,
    DEFAULT_ANIMATION_LAB_BUDGET_V4,
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

test('accepts touch and pen action kinds in scenario and action-window semantics', () => {
    for (const kind of ['touch-tap', 'touch-swipe', 'touch-pinch', 'pen-path']) {
        const input = semantics()
        input.scenarioActions[0].kind = kind
        input.actionWindows[0].kind = kind

        const result = validateAnimationLabSemanticsV2(input)
        assert.equal(result.ok, true, kind)
        assert.equal(result.value.scenarioActions[0].kind, kind)
        assert.equal(result.value.actionWindows[0].kind, kind)
    }
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
    metricInput.metrics[0].details = { text: 'private DOM copy', scene: 'private-scene', shader: 'private-shader' }
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

test('adds explicit budget versions without changing earlier rule tuples', () => {
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
    assert.equal(getAnimationLabBudgetV1('condev.animation.default', 3), DEFAULT_ANIMATION_LAB_BUDGET_V3)
    assert.equal(getAnimationLabBudgetV1('condev.animation.default', 4), DEFAULT_ANIMATION_LAB_BUDGET_V4)
    assert.deepEqual(
        DEFAULT_ANIMATION_LAB_BUDGET_V3.rules.slice(0, DEFAULT_ANIMATION_LAB_BUDGET_V2.rules.length),
        DEFAULT_ANIMATION_LAB_BUDGET_V2.rules
    )
    assert.equal(DEFAULT_ANIMATION_LAB_BUDGET_V3.rules.length, DEFAULT_ANIMATION_LAB_BUDGET_V2.rules.length + 7)
    assert.deepEqual(
        DEFAULT_ANIMATION_LAB_BUDGET_V4.rules.slice(0, DEFAULT_ANIMATION_LAB_BUDGET_V3.rules.length),
        DEFAULT_ANIMATION_LAB_BUDGET_V3.rules
    )
    assert.equal(DEFAULT_ANIMATION_LAB_BUDGET_V4.rules.length, DEFAULT_ANIMATION_LAB_BUDGET_V3.rules.length + 1)
    assert.equal(getAnimationLabBudgetV1('condev.animation.default', 5), undefined)
})

test('adds renderer evidence only in catalog v4 and gates GPU budget evaluation', () => {
    assert.deepEqual(ANIMATION_LAB_METRIC_CATALOG_V4.slice(0, ANIMATION_LAB_METRIC_CATALOG_V3.length), ANIMATION_LAB_METRIC_CATALOG_V3)
    assert.equal(ANIMATION_LAB_METRIC_CATALOG_V4.length, ANIMATION_LAB_METRIC_CATALOG_V3.length + 3)

    const expected = [
        ['renderer.draw-calls.p95', 'drawCalls', 'count', []],
        ['renderer.triangles.p95', 'triangles', 'count', []],
        ['renderer.gpu-frame.p95', 'gpuFrameMs', 'ms', ['renderer-gpu-frame-tail']],
    ]
    for (const [metricId, name, unit, defaultBudgetRuleIds] of expected) {
        assert.equal(getAnimationLabMetricCatalogEntry(metricId, 3), undefined)
        assert.deepEqual(getAnimationLabMetricCatalogEntry(metricId, 4), {
            metricId,
            family: 'renderer',
            name,
            stat: 'p95',
            unit,
            defaultScope: 'attempt',
            defaultAggregation: { population: 'samples', method: 'nearest-rank' },
            defaultBudgetRuleIds,
        })
    }

    const rule = DEFAULT_ANIMATION_LAB_BUDGET_V4.rules.find(candidate => candidate.ruleId === 'renderer-gpu-frame-tail')
    assert.deepEqual(rule, {
        ruleId: 'renderer-gpu-frame-tail',
        metricId: 'renderer.gpu-frame.p95',
        comparator: '<=',
        target: { kind: 'target-frame-multiple', value: 0.8, unit: 'ratio' },
        minimumSamples: 30,
    })
    const contract = { targetFrameMs: 16.666667 }
    assert.equal(
        evaluateAnimationLabBudgetRule(rule, { metricId: rule.metricId, value: 13, samples: 30, status: 'measured' }, contract).status,
        'within-budget'
    )
    assert.equal(
        evaluateAnimationLabBudgetRule(rule, { metricId: rule.metricId, value: 17, samples: 30, status: 'partial' }, contract).status,
        'candidate-breach'
    )
    assert.equal(
        evaluateAnimationLabBudgetRule(rule, { metricId: rule.metricId, value: 17, samples: 29, status: 'measured' }, contract).status,
        'insufficient-evidence'
    )
})

test('evaluates expanded v3 diagnostics only from sufficient measured evidence', () => {
    const contract = { targetFrameMs: 16.666667 }
    const cases = [
        ['loaf-count', 'main.loaf.count', 0, 0],
        ['interaction-processing-tail', 'interaction.processing.p95', 50, 3],
        ['interaction-presentation-tail', 'interaction.presentation.p95', 100, 3],
        ['page-lcp', 'vital.lcp.latest', 2_500, 1],
        ['page-cls', 'vital.cls.latest', 0.1, 1],
        ['lighthouse-first-contentful-paint', 'lighthouse.fcp.latest', 1_800, 1],
        ['lighthouse-total-blocking-time', 'lighthouse.total-blocking-time.latest', 200, 1],
    ]

    for (const [ruleId, metricId, target, minimumSamples] of cases) {
        const rule = DEFAULT_ANIMATION_LAB_BUDGET_V3.rules.find(candidate => candidate.ruleId === ruleId)
        assert.equal(rule.metricId, metricId)
        assert.equal(
            evaluateAnimationLabBudgetRule(rule, { metricId, value: target, samples: minimumSamples, status: 'measured' }, contract).status,
            'within-budget'
        )
        const breachedSamples = minimumSamples === 0 ? 1 : minimumSamples
        assert.equal(
            evaluateAnimationLabBudgetRule(rule, { metricId, value: target + 0.01, samples: breachedSamples, status: 'measured' }, contract)
                .status,
            'breach'
        )
        assert.equal(
            evaluateAnimationLabBudgetRule(rule, { metricId, value: target + 0.01, samples: breachedSamples, status: 'partial' }, contract)
                .status,
            'candidate-breach'
        )
        assert.equal(
            evaluateAnimationLabBudgetRule(rule, { metricId, value: target, samples: minimumSamples, status: 'partial' }, contract).status,
            'insufficient-evidence'
        )
        if (minimumSamples > 0) {
            assert.equal(
                evaluateAnimationLabBudgetRule(
                    rule,
                    { metricId, value: target + 0.01, samples: minimumSamples - 1, status: 'measured' },
                    contract
                ).status,
                'insufficient-evidence'
            )
        } else {
            assert.equal(
                evaluateAnimationLabBudgetRule(rule, { metricId, value: 1, samples: 0, status: 'measured' }, contract).status,
                'insufficient-evidence'
            )
        }
        assert.equal(
            evaluateAnimationLabBudgetRule(rule, { metricId, value: null, samples: null, status: 'unsupported' }, contract).status,
            'insufficient-evidence'
        )
    }
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
})

test('keeps catalog v2 unchanged while catalog v3 adds windowed video playback quality', () => {
    assert.deepEqual(ANIMATION_LAB_METRIC_CATALOG_V3.slice(0, ANIMATION_LAB_METRIC_CATALOG_V2.length), ANIMATION_LAB_METRIC_CATALOG_V2)
    assert.equal(ANIMATION_LAB_METRIC_CATALOG_V3.length, ANIMATION_LAB_METRIC_CATALOG_V2.length + 1)
    assert.equal(getAnimationLabMetricCatalogEntry('media.video-window-dropped-frame-rate', 2), undefined)
    assert.deepEqual(getAnimationLabMetricCatalogEntry('media.video-window-dropped-frame-rate', 3), {
        metricId: 'media.video-window-dropped-frame-rate',
        family: 'resourcesMedia',
        name: 'videoWindowDroppedFrameRate',
        stat: 'ratio',
        unit: 'ratio',
        defaultScope: 'action',
        defaultAggregation: { population: 'media-frames', method: 'ratio' },
        defaultBudgetRuleIds: [],
    })
    assert.throws(() => getAnimationLabMetricCatalogEntry('frame.duration.p95', 5), RangeError)
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

test('accepts the windowed video metric only when the measurement contract selects catalog v3', () => {
    const input = semantics()
    input.measurementContract.metricCatalogVersion = 3
    input.metrics = [
        {
            metricId: 'media.video-window-dropped-frame-rate',
            family: 'resourcesMedia',
            name: 'videoWindowDroppedFrameRate',
            stat: 'ratio',
            unit: 'ratio',
            value: 0.03,
            samples: 100,
            status: 'measured',
            evidenceLevel: 'controlled-lab-measurement',
            scope: { level: 'action', attemptId: 'measured-01', actionId: 'hero-hover-01' },
            aggregation: { population: 'media-frames', method: 'ratio' },
            budgetRefs: [],
            evidenceRefs: ['technology.browser.chromium'],
            limitations: [
                'video-playback-quality-window-counter-delta',
                'video-playback-quality-total-includes-displayed-and-dropped',
                'video-playback-quality-window-object-identity-only',
                'video-playback-quality-not-decode-presentation-or-gpu-timing',
            ],
        },
    ]
    input.findings = []
    assert.equal(validateAnimationLabSemanticsV2(input).ok, true)

    const missingBoundary = structuredClone(input)
    missingBoundary.metrics[0].limitations = []
    assert.equal(validateAnimationLabSemanticsV2(missingBoundary).ok, false)

    const wrongScope = structuredClone(input)
    wrongScope.metrics[0].scope = { level: 'run' }
    assert.equal(validateAnimationLabSemanticsV2(wrongScope).ok, false)

    input.measurementContract.metricCatalogVersion = 2
    const legacy = validateAnimationLabSemanticsV2(input)
    assert.equal(legacy.ok, false)
    assert.ok(legacy.errors.includes('metrics[0]:unknown-metric-id'))
})

test('accepts a disclosed aggregate video sample overflow without weakening attempt evidence', () => {
    const input = semantics()
    input.measurementContract.metricCatalogVersion = 3
    input.metrics = [
        {
            metricId: 'media.video-window-dropped-frame-rate',
            family: 'resourcesMedia',
            name: 'videoWindowDroppedFrameRate',
            stat: 'ratio',
            unit: 'ratio',
            value: 0.03,
            samples: null,
            status: 'partial',
            evidenceLevel: 'controlled-lab-measurement',
            scope: { level: 'action', actionId: 'hero-hover-01' },
            aggregation: { population: 'attempts', method: 'median-of-attempts' },
            budgetRefs: [],
            evidenceRefs: ['technology.browser.chromium'],
            limitations: [
                'video-playback-quality-window-counter-delta',
                'video-playback-quality-total-includes-displayed-and-dropped',
                'video-playback-quality-window-object-identity-only',
                'video-playback-quality-not-decode-presentation-or-gpu-timing',
                'aggregate-sample-count-exceeds-contract-bound',
            ],
        },
    ]
    input.findings = []
    assert.equal(validateAnimationLabSemanticsV2(input).ok, true)

    const attemptScoped = structuredClone(input)
    attemptScoped.metrics[0].scope.attemptId = 'measured-01'
    const attemptResult = validateAnimationLabSemanticsV2(attemptScoped)
    assert.equal(attemptResult.ok, false)
    assert.ok(attemptResult.errors.includes('metrics[0]:video-window-needs-positive-frame-delta'))

    const undisclosed = structuredClone(input)
    undisclosed.metrics[0].limitations.pop()
    assert.equal(validateAnimationLabSemanticsV2(undisclosed).ok, false)

    const measured = structuredClone(input)
    measured.metrics[0].status = 'measured'
    assert.equal(validateAnimationLabSemanticsV2(measured).ok, false)
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
    value.budgetRef = DEFAULT_ANIMATION_LAB_BUDGET_REF_V3
    assert.equal(validateLabMeasurementContract(value).ok, true)
    value.budgetRef = { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 5 }
    const unknownVersion = validateLabMeasurementContract(value)
    assert.equal(unknownVersion.ok, false)
    assert.ok(unknownVersion.errors.includes('measurementContract.budgetRef:unknown-local-budget'))
})

test('requires metric catalog v4 for budget v4 without blocking older budgets on catalog v4', () => {
    const value = semantics().measurementContract
    value.budgetRef = DEFAULT_ANIMATION_LAB_BUDGET_REF_V4
    value.metricCatalogVersion = 3

    const incompatible = validateLabMeasurementContract(value)
    assert.equal(incompatible.ok, false)
    assert.ok(incompatible.errors.includes('measurementContract:budget-v4-requires-metric-catalog-v4'))

    value.metricCatalogVersion = 4
    assert.equal(validateLabMeasurementContract(value).ok, true)

    value.budgetRef = DEFAULT_ANIMATION_LAB_BUDGET_REF_V3
    assert.equal(validateLabMeasurementContract(value).ok, true)
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
