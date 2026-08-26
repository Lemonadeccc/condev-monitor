import assert from 'node:assert/strict'
import test from 'node:test'

import {
    ANIMATION_LAB_METRIC_CATALOG_V1,
    ANIMATION_LAB_METRIC_CATALOG_V2,
    DEFAULT_ANIMATION_LAB_BUDGET_REF_V1,
    DEFAULT_ANIMATION_LAB_BUDGET_V1,
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
})
