import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyReport } from './run-animation-fixture-matrix.mjs'

const measurementContract = Object.freeze({
    contractVersion: 2,
    expectedHz: 60,
    targetFrameMs: 16.666667,
    source: 'explicit',
    confidence: 'explicit',
    budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 4 },
    metricCatalogVersion: 4,
})

const rendererMetrics = Object.freeze([
    { metricId: 'renderer.draw-calls.p95', status: 'measured' },
    { metricId: 'renderer.gpu-frame.p95', status: 'unsupported' },
    { metricId: 'renderer.triangles.p95', status: 'partial' },
])

function fixture() {
    return {
        scenario: { warmupRuns: 1, measuredRuns: 2, measurementContract },
        report: {
            semanticsVersion: 3,
            browser: { name: 'webkit' },
            measurementContract,
            attempts: [
                { attemptId: 'warmup-1', phase: 'warmup', metrics: [] },
                { attemptId: 'measured-1', phase: 'measured', metrics: rendererMetrics },
                { attemptId: 'measured-2', phase: 'measured', metrics: rendererMetrics },
            ],
            coverage: { review: 'matched', totals: { declared: 2, passed: 2, uncovered: 0 } },
        },
    }
}

test('accepts a reviewed report with exact measurement and explicit renderer evidence states', () => {
    const { report, scenario } = fixture()
    assert.doesNotThrow(() => verifyReport(report, scenario, 'fixture', 'webkit'))
})

test('rejects measurement-contract and measured-attempt drift', () => {
    const contractDrift = fixture()
    contractDrift.report.measurementContract = { ...measurementContract, metricCatalogVersion: 3 }
    assert.throws(() => verifyReport(contractDrift.report, contractDrift.scenario, 'fixture', 'webkit'), /measurement contract/u)

    const attemptDrift = fixture()
    attemptDrift.report.attempts = attemptDrift.report.attempts.slice(0, 2)
    assert.throws(() => verifyReport(attemptDrift.report, attemptDrift.scenario, 'fixture', 'webkit'), /attempt count drifted/u)
})

test('rejects silent renderer omissions and unknown metric states', () => {
    const omission = fixture()
    omission.report.attempts[1].metrics = rendererMetrics.slice(1)
    assert.throws(() => verifyReport(omission.report, omission.scenario, 'fixture', 'webkit'), /silently omitted/u)

    const unknown = fixture()
    unknown.report.attempts[1].metrics = [{ metricId: 'renderer.draw-calls.p95', status: 'healthy' }, ...rendererMetrics.slice(1)]
    assert.throws(() => verifyReport(unknown.report, unknown.scenario, 'fixture', 'webkit'), /invalid status/u)
})
