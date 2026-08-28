import assert from 'node:assert/strict'
import test from 'node:test'

import { validateNormalizedAnimationRumV3 } from '@condev-monitor/animation-rum-contract'

import { AnimationOptionsError, toAnimationRumV3SoftNavigationReport } from '../build/esm/index.mjs'

const capturedAtEpochMs = Date.parse('2026-08-29T08:00:00.000Z')

function measurement(name, value, segmentId = 41, startedAt = 1_000) {
    return {
        name,
        value,
        delta: value,
        rating: 'good',
        navigationType: 'soft-navigation',
        segmentId,
        startedAt,
        attribution: {
            selector: '#private-target',
            navigationUrl: 'https://private.example/account/42',
        },
    }
}

function segment(overrides = {}) {
    return {
        schemaVersion: 1,
        segmentId: 41,
        startedAt: 1_000,
        finalizedAt: 3_500,
        elapsedMs: 2_500,
        reason: 'next-soft-navigation',
        capability: { CLS: 'supported', INP: 'supported', LCP: 'supported' },
        observedUpdateCount: 7,
        droppedEntryCount: 0,
        rejectedUpdateCount: 0,
        latest: {
            CLS: measurement('CLS', 0.025),
            INP: measurement('INP', 120),
            LCP: measurement('LCP', 1_250),
        },
        navigationUrl: 'https://private.example/account/42',
        selector: '#private-target',
        ...overrides,
    }
}

function options(overrides = {}) {
    return {
        eventId: 'event_soft_navigation_1234',
        captureId: 'capture_soft_navigation_1234',
        capturedAtEpochMs,
        sampleRate: 0.1,
        samplingPolicyVersion: 3,
        routeKey: 'catalog.product-detail',
        release: 'web-1.0.0',
        dist: '42',
        environment: 'production',
        sdkVersion: '0.1.0',
        visibilityState: 'visible',
        reducedMotion: false,
        viewportBucket: 'large',
        dprBucket: '2',
        refreshHz: 60,
        refreshBudgetSource: 'observed',
        refreshBudgetConfidence: 'high',
        runtime: { framework: 'react', renderer: 'dom', backend: 'dom' },
        ...overrides,
    }
}

test('builds the closed three-metric soft-navigation report without local identity or attribution', () => {
    const report = toAnimationRumV3SoftNavigationReport(segment(), options())
    const validation = validateNormalizedAnimationRumV3(report, { nowEpochMs: capturedAtEpochMs })

    assert.equal(validation.ok, true, validation.ok ? undefined : validation.errors.join(', '))
    assert.deepEqual(
        report.metrics.map(metric => [metric.metricId, metric.value, metric.samples, metric.status]),
        [
            ['vital.soft-navigation.cls.latest', 0.025, 1, 'measured'],
            ['vital.soft-navigation.inp.latest', 120, 1, 'measured'],
            ['vital.soft-navigation.lcp.latest', 1_250, 1, 'measured'],
        ]
    )
    assert.deepEqual(report.providerEvidence['web-vitals-runtime'].userOutcome, {
        version: '0.1.0',
        accepted: 3,
        retained: 3,
        evidence: 3,
        dropped: 0,
        rejected: 0,
        truncated: false,
    })
    assert.equal(report.context.routeKey, 'catalog.product-detail')
    assert.equal(report.context.windowDurationMs, 2_500)
    assert.equal(report.context.windowDurationCapped, false)

    const serialized = JSON.stringify(report)
    for (const forbidden of ['segmentId', 'startedAt', 'next-soft-navigation', 'navigationUrl', 'selector', 'private.example']) {
        assert.equal(serialized.includes(forbidden), false, `unexpected local field: ${forbidden}`)
    }
})

test('marks every observed value partial when loss, rejection, unknown capability, or window capping weakens integrity', () => {
    const report = toAnimationRumV3SoftNavigationReport(
        segment({
            finalizedAt: 604_802_000,
            elapsedMs: 604_801_000,
            capability: { CLS: 'supported', INP: 'unknown', LCP: 'supported' },
            droppedEntryCount: 4,
            rejectedUpdateCount: 2,
            latest: {
                CLS: measurement('CLS', 0.04),
                INP: null,
                LCP: measurement('LCP', 2_000),
            },
        }),
        options()
    )

    assert.equal(report.context.windowDurationMs, 604_800_000)
    assert.equal(report.context.windowDurationCapped, true)
    assert.deepEqual(report.captureQuality, {
        sufficiency: 'sufficient',
        integrity: 'partial',
        reasons: ['provider-rejected-samples', 'provider-truncated', 'source-field-incomplete', 'window-capped'],
    })
    assert.deepEqual(
        report.metrics.map(metric => metric.status),
        ['partial', 'unknown', 'partial']
    )
    assert.equal(report.coverage.userOutcome.status, 'partial')
    assert.deepEqual(report.providerEvidence['web-vitals-runtime'].userOutcome, {
        version: '0.1.0',
        accepted: 2,
        retained: 2,
        evidence: 2,
        dropped: 4,
        rejected: 2,
        truncated: true,
    })
    assert.equal(validateNormalizedAnimationRumV3(report, { nowEpochMs: capturedAtEpochMs }).ok, true)
})

test('keeps supported absence, unsupported metrics, and mixed capability coverage explicit', () => {
    const report = toAnimationRumV3SoftNavigationReport(
        segment({
            capability: { CLS: 'supported', INP: 'unsupported', LCP: 'unsupported' },
            observedUpdateCount: 0,
            latest: { CLS: null, INP: null, LCP: null },
        }),
        options({ runtime: { framework: 'vanilla', renderer: 'canvas', backend: 'webgl2' } })
    )

    assert.deepEqual(
        report.metrics.map(metric => [metric.value, metric.samples, metric.status]),
        [
            [null, null, 'not-observed'],
            [null, null, 'unsupported'],
            [null, null, 'unsupported'],
        ]
    )
    assert.deepEqual(report.capabilities['web-vitals-soft-navigation'], {
        status: 'supported',
        metrics: { CLS: 'supported', INP: 'unsupported', LCP: 'unsupported' },
    })
    assert.deepEqual(report.coverage.userOutcome, {
        status: 'not-observed',
        evidenceLevel: 'runtime-observation',
    })
    assert.deepEqual(report.captureQuality, { sufficiency: 'insufficient', integrity: 'complete', reasons: [] })
})

test('rejects dynamic route identities, cross-segment values, contradictory capability, and malformed source counts', () => {
    const cases = [
        [segment(), options({ routeKey: '/account/42?token=private' })],
        [segment({ latest: { CLS: measurement('CLS', 0.1, 99), INP: null, LCP: null } }), options()],
        [
            segment({
                capability: { CLS: 'unsupported', INP: 'supported', LCP: 'supported' },
                latest: { CLS: measurement('CLS', 0.1), INP: measurement('INP', 100), LCP: measurement('LCP', 1_000) },
            }),
            options(),
        ],
        [segment({ droppedEntryCount: -1 }), options()],
        [segment({ elapsedMs: 2_400 }), options()],
        [segment(), options({ capturedAtEpochMs: Number.NaN })],
    ]

    for (const [source, projection] of cases) {
        assert.throws(() => toAnimationRumV3SoftNavigationReport(source, projection), AnimationOptionsError)
    }
})
