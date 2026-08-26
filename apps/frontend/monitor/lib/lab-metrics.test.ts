import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LabMetric, LabRun, LabRunAnalysis } from '../types/lab'
import { buildLabActionDiagnostics } from './lab-actions'
import {
    formatLabMetricValue,
    getLabLimitationLabel,
    getLabMetricAggregationLabel,
    getLabMetricLabel,
    getLabMetricStatusLabel,
    selectLabRunMetrics,
} from './lab-metrics'

const V2_METRIC_IDS = [
    'pipeline.loaf-render-start-to-paint.count',
    'pipeline.loaf-render-start-to-paint.p95',
    'pipeline.loaf-paint-to-presentation.count',
    'pipeline.loaf-paint-to-presentation.p95',
    'main.input-capture-to-next-raf-callback.count',
    'main.input-capture-to-next-raf-callback.p95',
    'interaction.loaf-first-ui-event-to-frame-end.count',
    'interaction.loaf-first-ui-event-to-frame-end.p95',
    'pipeline.loaf-attributed-forced-style-layout.count',
    'pipeline.loaf-attributed-forced-style-layout.p95',
] as const

const V2_LIMITATION_CODES = [
    'input-capture-listener-to-next-raf-callback-proxy',
    'not-paint-or-presentation-timing',
    'trusted-discrete-input-only',
    'loaf-frame-end-not-paint-or-presentation',
    'first-ui-event-may-predate-loaf',
    'loaf-attributed-scripts-lower-bound',
    'forced-style-layout-implementation-dependent',
    'loaf-render-paint-boundary-candidates-incomplete',
    'loaf-paint-presentation-boundary-candidates-incomplete',
    'input-frame-scheduling-candidates-incomplete',
    'loaf-first-ui-event-candidates-incomplete',
    'loaf-forced-style-layout-attribution-incomplete',
    'page-probe-input-frame-scheduling-samples-truncated',
] as const

function metric(metricId: string, scope: LabMetric['scope']): LabMetric {
    return {
        metricId,
        family: 'renderingPipeline',
        name: 'rawInternalMetricName',
        stat: metricId.endsWith('.count') ? 'count' : 'p95',
        unit: metricId.endsWith('.count') ? 'count' : 'ms',
        value: metricId.endsWith('.count') ? 3 : 18.25,
        samples: 3,
        status: 'measured',
        evidenceLevel: 'controlled-lab-measurement',
        scope,
        aggregation:
            scope?.level === 'run'
                ? { population: 'attempts', method: 'median-of-attempts' }
                : { population: 'frames', method: 'nearest-rank' },
        budgetRefs: [],
        evidenceRefs: ['runtime-browser'],
        limitations: ['loaf-only-over-50ms'],
    }
}

const run: LabRun = {
    runId: 'run-v2',
    appId: 'app-v2',
    name: 'Catalog v2 lab',
    status: 'completed',
    source: 'local-runner',
    createdAt: '2026-08-26T00:00:00.000Z',
    summary: {
        metrics: [
            {
                ...metric('pipeline.loaf-render-start-to-paint.p95', undefined),
                scope: undefined,
            },
        ],
    },
}

const analysis: LabRunAnalysis = {
    semanticsVersion: 2,
    measurementContract: {
        contractVersion: 2,
        expectedHz: 60,
        targetFrameMs: 16.666667,
        source: 'explicit',
        confidence: 'explicit',
        budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 1 },
        metricCatalogVersion: 2,
    },
    scenarioActions: [
        {
            actionId: 'page-scroll',
            order: 0,
            kind: 'scroll',
            label: 'page-scroll',
            trigger: { source: 'scenario' },
            subject: { scope: 'page', role: 'scroll', surface: 'unknown' },
        },
    ],
    actionWindows: [],
    metrics: [
        metric('pipeline.loaf-render-start-to-paint.p95', { level: 'run' }),
        metric('pipeline.loaf-paint-to-presentation.p95', { level: 'action', actionId: 'page-scroll' }),
        metric('main.input-capture-to-next-raf-callback.p95', { level: 'attempt', attemptId: 'attempt-1' }),
    ],
    technologyEvidence: [],
    findings: [],
}

describe('Lab catalog v2 metric presentation', () => {
    it('provides stable Chinese and English names for catalog-v2 metrics', () => {
        for (const metricId of V2_METRIC_IDS) {
            const label = getLabMetricLabel({ metricId, name: 'rawInternalMetricName' })
            assert.ok(label.zhCN.length > 5, metricId)
            assert.ok(label.en.length > 5, metricId)
            assert.notEqual(label.zhCN, '指标：rawInternalMetricName')
            assert.notEqual(label.en, 'raw Internal Metric Name')
        }
        assert.deepEqual(getLabMetricLabel({ metricId: 'pipeline.loaf-attributed-forced-style-layout.count', name: 'raw' }), {
            zhCN: 'LoAF 归因的强制样式 / 布局有效帧样本数',
            en: 'LoAF-attributed forced style / layout valid frame samples',
        })
    })

    it('keeps run metrics separate from action and attempt evidence', () => {
        const selected = selectLabRunMetrics(run, analysis)
        assert.deepEqual(
            selected.map(item => [item.metricId, item.scope?.level]),
            [['pipeline.loaf-render-start-to-paint.p95', 'run']]
        )

        const legacy = selectLabRunMetrics(run, null)
        assert.equal(legacy.length, 1)
        assert.equal(legacy[0]?.scope, undefined)

        const diagnostics = buildLabActionDiagnostics(run, analysis, [])
        assert.deepEqual(
            diagnostics.actions[0]?.metrics.map(item => [item.metricId, item.scope?.level]),
            [['pipeline.loaf-paint-to-presentation.p95', 'action']]
        )
    })

    it('distinguishes unavailable evidence and renders aggregation and limitations bilingually', () => {
        assert.deepEqual(getLabMetricStatusLabel('measured'), { zhCN: '已测量', en: 'Measured' })
        assert.deepEqual(getLabMetricStatusLabel('partial'), { zhCN: '部分测量', en: 'Partial' })
        assert.deepEqual(getLabMetricStatusLabel('not-observed'), { zhCN: '未观测到有效值', en: 'Not observed' })
        assert.deepEqual(getLabMetricStatusLabel('unsupported'), { zhCN: '当前能力不支持', en: 'Unsupported' })
        assert.deepEqual(getLabMetricStatusLabel('unknown'), { zhCN: '能力或证据未知', en: 'Unknown' })
        assert.deepEqual(getLabMetricAggregationLabel({ population: 'attempts', method: 'median-of-attempts' }), {
            zhCN: '重复尝试 · 多次尝试中位数',
            en: 'Attempts · Median of attempts',
        })
        assert.match(getLabLimitationLabel('loaf-only-over-50ms').zhCN, /50 ms/u)
        assert.match(getLabLimitationLabel('presentation-time-implementation-dependent').en, /implementation-dependent/u)
        assert.equal(formatLabMetricValue(null, 'ms'), '未采集 / 未知')
        assert.equal(formatLabMetricValue(0, 'count'), '0 次')
        assert.equal(formatLabMetricValue(3, 'count'), '3 次')
    })

    it('keeps CLS values raw while formatting Lighthouse category scores on a 0–100 scale', () => {
        assert.equal(formatLabMetricValue(0.1, 'score', 'vital.cls.latest'), '0.1')
        assert.equal(formatLabMetricValue(0.1, 'score', 'lighthouse.cls.latest'), '0.1')
        assert.equal(formatLabMetricValue(0.91, 'score', 'lighthouse.performance.score'), '91')
    })

    it('explains every catalog-v2 Runner limitation without exposing a raw-code fallback', () => {
        for (const code of V2_LIMITATION_CODES) {
            const label = getLabLimitationLabel(code)
            assert.ok(label.zhCN.length > 12, code)
            assert.ok(label.en.length > 12, code)
            assert.doesNotMatch(label.zhCN, /^限制代码：/u, code)
        }
    })
})
