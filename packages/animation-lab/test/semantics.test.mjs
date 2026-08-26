import assert from 'node:assert/strict'
import test from 'node:test'

import {
    ANIMATION_LAB_METRIC_CATALOG_V1,
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
