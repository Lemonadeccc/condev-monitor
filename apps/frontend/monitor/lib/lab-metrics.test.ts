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
    'aggregate-sample-count-exceeds-contract-bound',
    'observed-page-raf-cadence-not-display-refresh-rate',
    'event-timing-duration-threshold-16ms',
    'event-timing-entry-count-not-distinct-interactions',
    'video-playback-quality-partial-surface-coverage',
    'video-playback-quality-cumulative-snapshot-not-measurement-window-delta',
    'video-playback-quality-total-includes-displayed-and-dropped',
    'video-playback-quality-read-error',
    'video-playback-quality-no-video-elements',
    'video-playback-quality-zero-total-frames',
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

const V3_VIDEO_LIMITATION_CODES = [
    'video-playback-quality-window-counter-delta',
    'video-playback-quality-window-object-identity-only',
    'video-playback-quality-not-decode-presentation-or-gpu-timing',
    'video-playback-quality-window-partial-surface-coverage',
    'video-playback-quality-window-coverage-unavailable',
    'video-playback-quality-window-element-added',
    'video-playback-quality-window-element-removed',
    'video-playback-quality-window-counter-discontinuity',
    'video-playback-quality-window-read-error',
    'video-playback-quality-window-no-video-elements',
    'video-playback-quality-window-zero-total-frame-delta',
    'video-playback-quality-api-unsupported',
] as const

const V4_RENDERER_METRIC_IDS = ['renderer.draw-calls.p95', 'renderer.triangles.p95', 'renderer.gpu-frame.p95'] as const

const V4_RENDERER_LIMITATION_CODES = [
    'renderer-adapter-identity-not-retained',
    'renderer-evidence-is-page-level',
    'renderer-adapter-samples-not-observed-or-rejected',
    'renderer-host-evidence-rejected',
    'page-probe-renderer-host-evidence-truncated',
    'renderer-host-sample-p95',
    'renderer-multiple-producers-not-distinguished',
    'renderer-host-gpu-query-p95',
    'renderer-gpu-action-window-not-proven',
    'renderer-evidence-bridge-unavailable',
] as const

const V5_MEDIA_STAGE_METRIC_IDS = [
    'media.declared-completed.count',
    'media.declared-cancelled.count',
    'media.declared-begin-to-decode.p95',
    'media.declared-decode-to-upload.p95',
    'media.declared-upload-to-first-visible.p95',
    'media.declared-begin-to-first-visible.p95',
] as const

const V5_MEDIA_STAGE_LIMITATION_CODES = [
    'media-stage-caller-attested',
    'media-stage-not-browser-decoder-or-gpu-proof',
    'media-stage-complete-attempt-window-only',
    'media-stage-kind-aggregate',
    'media-stage-attempts-not-observed-or-rejected',
    'media-stage-evidence-bridge-unavailable',
    'media-stage-evidence-rejected',
    'page-probe-media-stage-evidence-truncated',
] as const

const TRACE_ACTION_PHASE_LIMITATION_CODES = [
    'trace-action-marker-not-observed',
    'trace-action-marker-ambiguous',
    'trace-action-phase-events-not-observed',
    'trace-action-thread-kind-unknown',
    'trace-action-non-laminar-overlap',
    'trace-action-cross-thread-total-may-exceed-wall-time',
    'trace-action-classification-is-correlative',
    'trace-action-raster-gpu-is-not-gpu-completion',
    'trace-action-thread-breakdown-truncated',
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
        assert.deepEqual(getLabMetricLabel({ metricId: 'frame.refresh.inferred', name: 'inferredRefreshHz' }), {
            zhCN: '页面 rAF 回调节奏（帧间隔 p50 推算）',
            en: 'Observed page rAF callback cadence (from frame-interval p50)',
        })
        assert.deepEqual(getLabMetricLabel({ metricId: '', name: 'inferredRefreshHz' }), {
            zhCN: '页面 rAF 回调节奏（帧间隔 p50 推算）',
            en: 'Observed page rAF callback cadence (from frame-interval p50)',
        })
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

    it('presents the catalog-v3 action-window video metric and every closed limitation bilingually', () => {
        assert.deepEqual(getLabMetricLabel({ metricId: 'media.video-window-dropped-frame-rate', name: 'videoWindowDroppedFrameRate' }), {
            zhCN: '动作窗口视频丢帧率',
            en: 'Action-window video dropped-frame rate',
        })
        for (const limitation of V3_VIDEO_LIMITATION_CODES) {
            const label = getLabLimitationLabel(limitation)
            assert.ok(label.zhCN.length > 5, limitation)
            assert.ok(label.en.length > 5, limitation)
            assert.notEqual(label.zhCN, `限制：${limitation}`)
            assert.notEqual(label.en, limitation)
        }
    })

    it('presents catalog-v4 renderer metrics and every closed limitation bilingually', () => {
        for (const metricId of V4_RENDERER_METRIC_IDS) {
            const label = getLabMetricLabel({ metricId, name: 'rawRendererMetric' })
            assert.ok(label.zhCN.length > 5, metricId)
            assert.ok(label.en.length > 5, metricId)
            assert.notEqual(label.zhCN, '指标：rawRendererMetric')
            assert.notEqual(label.en, 'raw Renderer Metric')
        }
        for (const limitation of V4_RENDERER_LIMITATION_CODES) {
            const label = getLabLimitationLabel(limitation)
            assert.ok(label.zhCN.length > 5, limitation)
            assert.ok(label.en.length > 5, limitation)
            assert.notEqual(label.zhCN, `限制：${limitation}`)
            assert.notEqual(label.en, limitation)
        }
    })

    it('presents catalog-v5 caller-attested media stages and every closed boundary bilingually', () => {
        for (const metricId of V5_MEDIA_STAGE_METRIC_IDS) {
            const label = getLabMetricLabel({ metricId, name: 'rawMediaStageMetric' })
            assert.ok(label.zhCN.length > 5, metricId)
            assert.ok(label.en.length > 5, metricId)
            assert.notEqual(label.zhCN, '指标：rawMediaStageMetric')
            assert.notEqual(label.en, 'raw Media Stage Metric')
        }
        for (const limitation of V5_MEDIA_STAGE_LIMITATION_CODES) {
            const label = getLabLimitationLabel(limitation)
            assert.ok(label.zhCN.length > 5, limitation)
            assert.ok(label.en.length > 5, limitation)
            assert.notEqual(label.zhCN, `限制：${limitation}`)
            assert.notEqual(label.en, limitation)
        }
    })

    it('explains every trace action phase limitation without exposing raw codes', () => {
        for (const limitation of TRACE_ACTION_PHASE_LIMITATION_CODES) {
            const label = getLabLimitationLabel(limitation)
            assert.ok(label.zhCN.length > 5, limitation)
            assert.ok(label.en.length > 5, limitation)
            assert.notEqual(label.zhCN, `限制：${limitation}`)
            assert.notEqual(label.en, limitation)
        }
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
        assert.match(getLabLimitationLabel('single-controlled-run-not-field-p75').en, /not a device-segmented field p75/u)
        assert.match(getLabLimitationLabel('lcp-soft-navigation-not-modeled').zhCN, /软导航边界/u)
        assert.match(getLabLimitationLabel('lab-cls-window-may-understate-full-session').en, /understate later layout shifts/u)
        assert.match(getLabLimitationLabel('lighthouse-form-factor-desktop').zhCN, /desktop form factor/u)
        assert.match(getLabLimitationLabel('lighthouse-form-factor-mobile').en, /mobile form factor/u)
        assert.match(getLabLimitationLabel('lighthouse-isolated-process-does-not-inherit-measured-cache').zhCN, /独立 Chrome 进程/u)
        assert.match(getLabLimitationLabel('presentation-time-implementation-dependent').en, /implementation-dependent/u)
        assert.match(getLabLimitationLabel('observed-page-raf-cadence-not-display-refresh-rate').zhCN, /不是物理屏幕刷新率/u)
        assert.match(
            getLabLimitationLabel('observed-page-raf-cadence-not-display-refresh-rate').en,
            /not the physical display refresh rate/u
        )
        assert.match(getLabLimitationLabel('event-timing-duration-threshold-16ms').zhCN, /不代表全部输入事件/u)
        assert.match(getLabLimitationLabel('event-timing-entry-count-not-distinct-interactions').en, /not distinct interactions/u)
        assert.match(getLabLimitationLabel('video-playback-quality-partial-surface-coverage').zhCN, /部分 video 元素/u)
        assert.match(
            getLabLimitationLabel('video-playback-quality-cumulative-snapshot-not-measurement-window-delta').en,
            /not a start-to-end/u
        )
        assert.match(getLabLimitationLabel('video-playback-quality-total-includes-displayed-and-dropped').zhCN, /不是纯解码帧/u)
        assert.match(getLabLimitationLabel('video-playback-quality-read-error').en, /no ratio was calculated/u)
        assert.match(getLabLimitationLabel('aggregate-sample-count-exceeds-contract-bound').zhCN, /不保留精确总数/u)
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
