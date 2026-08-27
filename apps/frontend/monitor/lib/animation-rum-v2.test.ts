import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AnimationRumV2SummaryMetric } from '../types/animation-v2'
import {
    animationRumV2MetricDisplay,
    animationRumV2MetricStatusCountEntries,
    animationRumV2QualityReasonLabel,
    animationRumV2RelationLabel,
    animationRumV2StatusLabel,
    decodeAnimationRumV2CaptureId,
    findAnimationRumV2SummaryMetric,
    formatAnimationRumV2Integer,
    formatAnimationRumV2Metric,
    isPositiveAnimationRumV2Integer,
} from './animation-rum-v2'

function summaryMetric(overrides: Partial<AnimationRumV2SummaryMetric> = {}): AnimationRumV2SummaryMetric {
    return {
        metricId: 'frame.duration.p95',
        family: 'frameCadence',
        name: 'frameDurationMs',
        stat: 'p95',
        unit: 'ms',
        evidenceWindow: 'capture-window',
        scope: 'page',
        relation: 'page-window',
        owner: 'browser-core',
        captureCount: 4,
        statusCounts: {
            measured: 2,
            partial: 1,
            notObserved: 1,
            notInstrumented: 0,
            unsupported: 0,
            unknown: 0,
        },
        capturesWithValue: 3,
        measuredCaptures: 2,
        partialCaptures: 1,
        excludedPartialCaptures: 1,
        reportedSamples: 120,
        measuredReportedSamples: 100,
        partialReportedSamples: 20,
        captureValue: {
            aggregation: 'distribution-of-capture-aggregates',
            measuredCaptures: 2,
            partialCaptures: 1,
            excludedPartialCaptures: 1,
            average: 17.5,
            p50: 16,
            p75: 18,
            p95: 23,
            min: 14,
            max: 25,
        },
        valuePerMinute: null,
        ...overrides,
    }
}

describe('Animation RUM v2 presentation helpers', () => {
    it('preserves UInt64 decimal strings without an unsafe Number conversion', () => {
        const aboveSafeInteger = '18446744073709551615'

        assert.equal(formatAnimationRumV2Integer(aboveSafeInteger), '18,446,744,073,709,551,615')
        assert.equal(isPositiveAnimationRumV2Integer(aboveSafeInteger), true)
        assert.equal(formatAnimationRumV2Integer('0'), '0')
        assert.equal(isPositiveAnimationRumV2Integer('0000'), false)
        assert.equal(formatAnimationRumV2Integer(null), '—')
        assert.equal(formatAnimationRumV2Integer('not-an-integer'), '—')
    })

    it('decodes route capture IDs without crashing on malformed percent escapes', () => {
        assert.equal(decodeAnimationRumV2CaptureId('capture_12345678'), 'capture_12345678')
        assert.equal(decodeAnimationRumV2CaptureId('capture%5F12345678'), 'capture_12345678')
        assert.equal(decodeAnimationRumV2CaptureId('capture%ZZ12345678'), null)
        assert.equal(decodeAnimationRumV2CaptureId(''), null)
    })

    it('distinguishes unavailable evidence from a real zero', () => {
        assert.equal(formatAnimationRumV2Metric(null, 'ms'), '未采集 / 未知')
        assert.equal(formatAnimationRumV2Metric(0, 'count'), '0')
        assert.equal(formatAnimationRumV2Metric(0, 'ratio'), '0%')
        assert.equal(animationRumV2StatusLabel('partial'), '部分测量')
        assert.equal(animationRumV2StatusLabel('unknown'), '未知')
    })

    it('keeps all six GPU timer result states visible without collapsing unavailable evidence into zero', () => {
        const statusFieldByCapability = {
            supported: 'notObserved',
            disabled: 'notInstrumented',
            unsupported: 'unsupported',
            unknown: 'unknown',
        } as const

        for (const [capability, activeField] of Object.entries(statusFieldByCapability)) {
            const statusCounts = {
                measured: 0,
                partial: 0,
                notObserved: 0,
                notInstrumented: 0,
                unsupported: 0,
                unknown: 0,
                [activeField]: 1,
            }
            const gpuMetric = summaryMetric({
                metricId: 'renderer.gpu-frame.p95',
                family: 'renderer',
                name: 'gpuFrameMs',
                relation: 'adapter',
                owner: 'renderer-adapter',
                statusCounts,
            })
            const entries = animationRumV2MetricStatusCountEntries(gpuMetric.statusCounts)

            assert.deepEqual(
                entries.map(entry => entry.status),
                ['measured', 'partial', 'not-observed', 'not-instrumented', 'unsupported', 'unknown']
            )
            assert.equal(entries.filter(entry => entry.count === 1).length, 1, capability)
            assert.equal(entries.find(entry => entry.count === 1)?.status.replaceAll('-', ''), activeField.toLowerCase(), capability)
            assert.equal(
                entries.reduce((sum, entry) => sum + Number(entry.count), 0),
                1,
                capability
            )
        }
    })

    it('finds metrics by scope and relation instead of merging page and target evidence', () => {
        const page = summaryMetric()
        const target = summaryMetric({ scope: 'target', relation: 'target-temporal-overlap' })
        const metrics = [page, target]

        assert.equal(findAnimationRumV2SummaryMetric(metrics, 'frame.duration.p95', 'page', 'page-window'), page)
        assert.equal(findAnimationRumV2SummaryMetric(metrics, 'frame.duration.p95', 'target', 'target-temporal-overlap'), target)
        assert.equal(findAnimationRumV2SummaryMetric(metrics, 'frame.duration.p95', 'target', 'target-direct'), undefined)
    })

    it('uses normalized rates only when the API supplies a measured per-minute distribution', () => {
        const raw = summaryMetric()
        assert.deepEqual(animationRumV2MetricDisplay(raw), { normalized: false, p50: 16, p75: 18, p95: 23 })

        const normalized = summaryMetric({
            valuePerMinute: {
                capturesWithValue: 2,
                average: 4,
                p50: 3,
                p75: 5,
                p95: 8,
                min: 2,
                max: 9,
            },
        })
        assert.deepEqual(animationRumV2MetricDisplay(normalized), { normalized: true, p50: 3, p75: 5, p95: 8 })
    })

    it('explains attribution and quality boundaries in Chinese', () => {
        assert.match(animationRumV2RelationLabel('target-temporal-overlap'), /非因果/u)
        assert.match(animationRumV2QualityReasonLabel('provider-truncated'), /截断/u)
    })
})
