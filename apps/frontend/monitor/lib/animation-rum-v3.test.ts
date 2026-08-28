import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
    animationRumV3DisclosureLabel,
    animationRumV3MetricStatusLabel,
    formatAnimationRumV3Count,
    formatAnimationRumV3Metric,
    parseAnimationRumV3CapturesResponse,
    parseAnimationRumV3SummaryResponse,
} from './animation-rum-v3'

const summaryResponse = {
    success: true,
    data: {
        contractVersion: 3,
        snapshotSchemaVersion: 1,
        captureKind: 'soft-navigation',
        minimumSampleThreshold: 30,
        window: {
            from: '2026-08-26T00:00:00.000Z',
            to: '2026-08-27T00:00:00.000Z',
            retentionDays: 90,
            retentionClamped: false,
        },
        captures: { total: 30, sufficient: 30, insufficient: 0, partial: 0 },
        projectionIntegrity: {
            semantics: 'completion-marker-child-row-counts',
            completionMarkers: 31,
            verified: 30,
            excludedFromAnalytics: 1,
            metricCountMismatches: 1,
            providerEvidenceCountMismatches: 0,
            childIdentityMismatches: 0,
        },
        groups: [
            {
                dimensions: {
                    routeKey: 'catalog.detail',
                    release: 'web-1.0.0',
                    environment: 'production',
                    runtime: { framework: 'react', renderer: 'dom', backend: 'dom' },
                },
                metric: { metricId: 'vital.soft-navigation.inp.latest', vitalName: 'INP', unit: 'ms' },
                captureCount: 30,
                measuredCount: 30,
                partialCount: 0,
                notObservedCount: 0,
                notInstrumentedCount: 0,
                unsupportedCount: 0,
                unknownCount: 0,
                insufficientEvidenceCount: 0,
                reportedSamples: 30,
                disclosure: { minimumSampleThreshold: 30, status: 'available' },
                captureValue: { p50: 80, p75: 120, p95: 180 },
            },
        ],
    },
}

const metric = (metricId: string, vitalName: string, unit: string, value: number) => ({
    metricId,
    vitalName,
    unit,
    value,
    samples: 1,
    status: 'measured',
})

const capturesResponse = {
    success: true,
    data: {
        contractVersion: 3,
        snapshotSchemaVersion: 1,
        captureKind: 'soft-navigation',
        minimumSampleThreshold: 30,
        pagination: { total: 1, limit: 50, offset: 0, hasMore: false },
        captures: [
            {
                eventId: 'event_12345678',
                captureId: 'capture_12345678',
                captureKind: 'soft-navigation',
                scope: 'page',
                capturedAt: '2026-08-26T08:00:00.000Z',
                receivedAt: '2026-08-26T08:00:01.000Z',
                release: 'web-1.0.0',
                dist: '42',
                environment: 'production',
                sdkVersion: '3.0.0',
                monitorVersion: '3.0.0',
                sampleRate: 1,
                samplingPolicyVersion: 1,
                context: {
                    routeKey: 'catalog.detail',
                    visibilityState: 'visible',
                    reducedMotion: false,
                    viewportBucket: 'large',
                    dprBucket: '2',
                    refreshHz: 60,
                    refreshBudgetSource: 'observed',
                    refreshBudgetConfidence: 'high',
                    windowDurationMs: 4_000,
                    windowDurationCapped: false,
                    runtime: { framework: 'react', renderer: 'dom', backend: 'dom' },
                },
                quality: { sufficiency: 'sufficient', integrity: 'complete', reasons: [] },
                providerEvidenceCount: 1,
                metricCount: 3,
                metrics: [
                    metric('vital.soft-navigation.cls.latest', 'CLS', 'ratio', 0.01),
                    metric('vital.soft-navigation.inp.latest', 'INP', 'ms', 120),
                    metric('vital.soft-navigation.lcp.latest', 'LCP', 'ms', 900),
                ],
                selector: '#must-not-copy',
            },
        ],
    },
}

describe('animation RUM v3 presentation helpers', () => {
    it('keeps unknown values distinct from zero', () => {
        assert.equal(formatAnimationRumV3Count(0), '0')
        assert.equal(formatAnimationRumV3Count(null), '未知')
        assert.equal(formatAnimationRumV3Metric(null, 'ms'), '样本不足 / 未知')
    })

    it('formats the closed metric and disclosure states', () => {
        assert.equal(formatAnimationRumV3Metric(0.025, 'ratio'), '0.025')
        assert.equal(formatAnimationRumV3Metric(120, 'ms'), '120 ms')
        assert.equal(animationRumV3MetricStatusLabel('not-observed'), '未观测到')
        assert.match(animationRumV3DisclosureLabel('insufficient-samples', 30), /30/u)
    })

    it('rebuilds only a consistent summary response and rejects contradictory disclosure', () => {
        assert.deepEqual(parseAnimationRumV3SummaryResponse(summaryResponse), summaryResponse)
        assert.equal(
            parseAnimationRumV3SummaryResponse({
                ...summaryResponse,
                data: {
                    ...summaryResponse.data,
                    groups: [
                        {
                            ...summaryResponse.data.groups[0],
                            measuredCount: 29,
                        },
                    ],
                },
            }),
            null
        )
        assert.equal(
            parseAnimationRumV3SummaryResponse({
                ...summaryResponse,
                data: {
                    ...summaryResponse.data,
                    groups: [{ ...summaryResponse.data.groups[0], reportedSamples: 29 }],
                },
            }),
            null
        )
        assert.equal(
            parseAnimationRumV3SummaryResponse({
                ...summaryResponse,
                data: {
                    ...summaryResponse.data,
                    groups: [{ ...summaryResponse.data.groups[0], insufficientEvidenceCount: 31 }],
                },
            }),
            null
        )
        assert.equal(
            parseAnimationRumV3SummaryResponse({
                ...summaryResponse,
                data: {
                    ...summaryResponse.data,
                    groups: [{ ...summaryResponse.data.groups[0], captureValue: { p50: 180, p75: 120, p95: 80 } }],
                },
            }),
            null
        )
        assert.equal(
            parseAnimationRumV3SummaryResponse({
                ...summaryResponse,
                data: {
                    ...summaryResponse.data,
                    projectionIntegrity: { ...summaryResponse.data.projectionIntegrity, verified: 29 },
                },
            }),
            null
        )
    })

    it('requires exactly three closed metrics and drops unknown capture fields', () => {
        const parsed = parseAnimationRumV3CapturesResponse(capturesResponse)
        assert.ok(parsed)
        assert.equal('selector' in parsed.data.captures[0], false)
        assert.equal(
            parseAnimationRumV3CapturesResponse({
                ...capturesResponse,
                data: {
                    ...capturesResponse.data,
                    captures: [{ ...capturesResponse.data.captures[0], metrics: capturesResponse.data.captures[0].metrics.slice(0, 2) }],
                },
            }),
            null
        )
        assert.equal(
            parseAnimationRumV3CapturesResponse({
                ...capturesResponse,
                data: {
                    ...capturesResponse.data,
                    pagination: { ...capturesResponse.data.pagination, limit: 1, total: 1 },
                    captures: [capturesResponse.data.captures[0], capturesResponse.data.captures[0]],
                },
            }),
            null
        )
        assert.equal(
            parseAnimationRumV3CapturesResponse({
                ...capturesResponse,
                data: {
                    ...capturesResponse.data,
                    captures: [{ ...capturesResponse.data.captures[0], eventId: 12345678 }],
                },
            }),
            null
        )
    })
})
