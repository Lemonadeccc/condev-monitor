import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LabComparisonMetric, LabComparisonRejectionReason, LabRun } from '../types/lab'
import {
    buildLabComparisonAppSwitchHref,
    buildLabComparisonMetricView,
    formatLabComparisonPercent,
    formatLabComparisonRunLabel,
    getLabComparisonReasonLabel,
    getLabComparisonRequestError,
    getLabComparisonSelectionState,
    isLabComparisonRunId,
    selectCompletedLabRuns,
} from './lab-comparison'

const runs: LabRun[] = [
    {
        runId: 'before-run',
        appId: 'app-id',
        name: 'Before',
        status: 'completed',
        source: 'local-runner',
        createdAt: '2026-08-26T00:00:00.000Z',
    },
    {
        runId: 'after-run',
        appId: 'app-id',
        name: 'After',
        status: 'completed',
        source: 'local-runner',
        createdAt: '2026-08-26T01:00:00.000Z',
    },
    {
        runId: 'partial-run',
        appId: 'app-id',
        name: 'Partial',
        status: 'partial',
        source: 'local-runner',
        createdAt: '2026-08-26T02:00:00.000Z',
    },
]

const distribution = {
    n: 3,
    min: 10,
    median: 12,
    p75: 14,
    p95: 14,
    max: 14,
    underlyingSamples: { knownAttempts: 3, total: 300, min: 100, max: 100 },
}

function metric(overrides: Partial<LabComparisonMetric> = {}): LabComparisonMetric {
    return {
        metricId: 'frame.duration.p95',
        family: 'frameCadence',
        name: 'frameDuration',
        stat: 'p95',
        unit: 'ms',
        scope: { level: 'run' },
        sourceAggregation: { population: 'frames', method: 'nearest-rank' },
        comparisonAggregation: { population: 'measured-attempts', method: 'median' },
        budgetRefs: [],
        evidenceRefs: ['runtime-browser'],
        evidenceLevel: 'controlled-lab-measurement',
        evidenceStatus: 'measured',
        before: distribution,
        after: { ...distribution, median: 15 },
        delta: 3,
        percentChange: 25,
        direction: 'increase',
        ...overrides,
    }
}

describe('Animation Lab comparison view model', () => {
    it('offers completed runs only and rejects incomplete, stale, or identical selections', () => {
        const completed = selectCompletedLabRuns(runs)
        assert.deepEqual(
            completed.map(run => run.runId),
            ['before-run', 'after-run']
        )
        assert.equal(getLabComparisonSelectionState(completed, '', ''), 'incomplete')
        assert.equal(getLabComparisonSelectionState(completed, 'before-run', 'partial-run'), 'unknown-run')
        assert.equal(getLabComparisonSelectionState(completed, 'before-run', 'before-run'), 'same-run')
        assert.equal(getLabComparisonSelectionState(completed, 'before-run', 'after-run'), 'ready')
        assert.equal(isLabComparisonRunId('11111111-1111-4111-8111-111111111111'), true)
        assert.equal(isLabComparisonRunId('before-run'), false)
    })

    it('switches application and clears the pair in one href while retaining the time scope', () => {
        const href = buildLabComparisonAppSwitchHref(
            new URLSearchParams({
                appId: 'old-app',
                before: '11111111-1111-4111-8111-111111111111',
                after: '22222222-2222-4222-8222-222222222222',
                range: '7d',
                from: '2026-08-01T00:00:00.000Z',
                to: '2026-08-08T00:00:00.000Z',
            }),
            'new-app'
        )
        const query = new URL(href, 'https://monitor.example').searchParams
        assert.equal(query.get('appId'), 'new-app')
        assert.equal(query.has('before'), false)
        assert.equal(query.has('after'), false)
        assert.equal(query.get('range'), '7d')
        assert.equal(query.get('from'), '2026-08-01T00:00:00.000Z')
        assert.equal(query.get('to'), '2026-08-08T00:00:00.000Z')
    })

    it('adds short release or browser context to repeated run names without displaying target URLs', () => {
        const releaseLabel = formatLabComparisonRunLabel({
            ...runs[0],
            release: 'release-2026.08.27',
            browser: 'chromium 140',
            targetUrl: 'https://private.example/orders/secret',
        })
        assert.match(releaseLabel, /Before · .* · release-2026\.08\.27/u)
        assert.doesNotMatch(releaseLabel, /private|orders|secret/u)

        const browserLabel = formatLabComparisonRunLabel({ ...runs[1], browser: 'chromium 140.0.1' })
        assert.match(browserLabel, /After · .* · chromium 140\.0\.1/u)
    })

    it('describes numeric direction without improvement, regression, or a score', () => {
        const view = buildLabComparisonMetricView(metric())
        assert.equal(view.direction.zhCN, '数值增加')
        assert.equal(view.direction.en, 'Increase')
        assert.equal(view.delta, '+3.00 ms')
        assert.equal(view.percentChange, '+25%')
        assert.doesNotMatch(JSON.stringify(view), /改善|退化|improv|regress|score/iu)
        assert.deepEqual(view.before, {
            n: '3',
            min: '10.0 ms',
            median: '12.0 ms',
            p75: '14.0 ms',
            p95: '14.0 ms',
            max: '14.0 ms',
        })
    })

    it('renders an unavailable percent change as an em dash when the baseline is zero', () => {
        const view = buildLabComparisonMetricView(
            metric({
                before: { ...distribution, min: 0, median: 0 },
                after: { ...distribution, median: 1 },
                delta: 1,
                percentChange: null,
            })
        )
        assert.equal(view.percentChange, '—')
        assert.equal(formatLabComparisonPercent(null), '—')
    })

    it('explains expired and missing evidence bilingually without leaking backend details', () => {
        const expired: LabComparisonRejectionReason = {
            code: 'evidence-unavailable',
            side: 'before',
            field: 'animation-report-expired',
        }
        const label = getLabComparisonReasonLabel(expired)
        assert.match(label.zhCN, /基线运行.*保留期/u)
        assert.match(label.en, /Before run.*expired/u)
        assert.match(getLabComparisonRequestError(410, 'internal storage key: private'), /重新运行相同 Scenario/u)
        assert.doesNotMatch(getLabComparisonRequestError(410, 'internal storage key: private'), /private/u)
    })

    it('renders condition mismatches as neutral eligibility failures', () => {
        const label = getLabComparisonReasonLabel({
            code: 'condition-mismatch',
            side: 'both',
            field: 'browser-version',
        })
        assert.match(label.zhCN, /浏览器版本不一致/u)
        assert.match(label.en, /browser version differs/u)
        assert.doesNotMatch(`${label.zhCN} ${label.en}`, /改善|退化|improv|regress/iu)
    })
})
