import assert from 'node:assert/strict'
import test from 'node:test'

import { ANIMATION_RUM_V3_METRIC_CATALOG, validateNormalizedAnimationRumV2, validateNormalizedAnimationRumV3 } from '../build/esm/index.js'
import {
    ANIMATION_RUM_V2_GOLDEN_NOW,
    ANIMATION_RUM_V3_GOLDEN_NOW,
    createAnimationRumV2GoldenReport,
    createAnimationRumV3GoldenReport,
} from '../build/esm/testing.js'

function validate(report) {
    return validateNormalizedAnimationRumV3(report, { nowEpochMs: ANIMATION_RUM_V3_GOLDEN_NOW })
}

test('accepts the closed soft-navigation RUM v3 report', () => {
    const report = createAnimationRumV3GoldenReport()
    assert.deepEqual(
        ANIMATION_RUM_V3_METRIC_CATALOG.map(definition => ({
            metricId: definition.metricId,
            vitalName: definition.vitalName,
            evidenceWindow: definition.evidenceWindow,
            relation: definition.relation,
            owner: definition.owner,
            requiredCapability: definition.requiredCapability,
        })),
        [
            {
                metricId: 'vital.soft-navigation.cls.latest',
                vitalName: 'CLS',
                evidenceWindow: 'soft-navigation-lifetime',
                relation: 'page-window',
                owner: 'web-vitals-runtime',
                requiredCapability: 'web-vitals-soft-navigation',
            },
            {
                metricId: 'vital.soft-navigation.inp.latest',
                vitalName: 'INP',
                evidenceWindow: 'soft-navigation-lifetime',
                relation: 'page-window',
                owner: 'web-vitals-runtime',
                requiredCapability: 'web-vitals-soft-navigation',
            },
            {
                metricId: 'vital.soft-navigation.lcp.latest',
                vitalName: 'LCP',
                evidenceWindow: 'soft-navigation-lifetime',
                relation: 'page-window',
                owner: 'web-vitals-runtime',
                requiredCapability: 'web-vitals-soft-navigation',
            },
        ]
    )
    assert.equal(validate(report).ok, true)
})

test('requires a static route key and the fixed page identity', () => {
    for (const mutate of [
        report => delete report.context.routeKey,
        report => (report.context.routeKey = 'orders.12345'),
        report => (report.scope = 'target'),
        report => (report.parentCaptureId = 'capture_parent_1234'),
        report => (report.targetKey = 'hero-canvas'),
        report => (report.captureKind = 'page'),
    ]) {
        const report = createAnimationRumV3GoldenReport()
        mutate(report)
        assert.equal(validate(report).ok, false)
    }
})

test('requires bounded aggregation context and exact runtime dimensions', () => {
    const capped = createAnimationRumV3GoldenReport()
    capped.context.windowDurationMs = 604_800_000
    capped.context.windowDurationCapped = true
    capped.captureQuality.integrity = 'partial'
    capped.captureQuality.reasons = ['window-capped']
    capped.metrics = capped.metrics.map(metric => ({ ...metric, status: 'partial' }))
    capped.coverage.userOutcome.status = 'partial'
    assert.equal(validate(capped).ok, true)

    for (const mutate of [
        report => (report.context.windowDurationCapped = true),
        report => delete report.context.runtime,
        report => (report.context.runtime.framework = 'next-private'),
        report => (report.context.runtime.renderer = 'webgl'),
        report => (report.context.runtime.backend = 'metal'),
        report => (report.context.visibilityState = 'foreground'),
        report => (report.context.viewportBucket = '1920x1080'),
    ]) {
        const report = createAnimationRumV3GoldenReport()
        mutate(report)
        assert.equal(validate(report).ok, false)
    }
})

test('requires exactly the canonical three metrics and bindings', () => {
    for (const mutate of [
        report => report.metrics.pop(),
        report => report.metrics.reverse(),
        report => (report.metrics[0].metricId = 'vital.cls.latest'),
        report => (report.metrics[0].relation = 'adapter'),
        report => (report.metrics[0].owner = 'browser-core'),
        report => report.metrics.push({ ...report.metrics[0] }),
    ]) {
        const report = createAnimationRumV3GoldenReport()
        mutate(report)
        assert.equal(validate(report).ok, false)
    }
})

test('represents supported but unobserved vitals only as null/null not-observed', () => {
    const report = createAnimationRumV3GoldenReport()
    report.metrics[1] = {
        ...report.metrics[1],
        value: null,
        samples: null,
        status: 'not-observed',
    }
    report.providerEvidence['web-vitals-runtime'].userOutcome = {
        ...report.providerEvidence['web-vitals-runtime'].userOutcome,
        accepted: 2,
        retained: 2,
        evidence: 2,
    }
    assert.equal(validate(report).ok, true)

    for (const mutation of [metric => (metric.value = 0), metric => (metric.samples = 0), metric => (metric.status = 'unknown')]) {
        const invalid = createAnimationRumV3GoldenReport()
        invalid.metrics[1] = { ...invalid.metrics[1], value: null, samples: null, status: 'not-observed' }
        mutation(invalid.metrics[1])
        assert.equal(validate(invalid).ok, false)
    }
})

test('binds capability, provider evidence, quality, metrics, and coverage', () => {
    const unsupported = createAnimationRumV3GoldenReport()
    unsupported.capabilities['web-vitals-soft-navigation'] = {
        status: 'unsupported',
        metrics: { CLS: 'unsupported', INP: 'unsupported', LCP: 'unsupported' },
    }
    unsupported.metrics = unsupported.metrics.map(metric => ({ ...metric, value: null, samples: null, status: 'unsupported' }))
    unsupported.coverage.userOutcome = { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' }
    unsupported.captureQuality.sufficiency = 'insufficient'
    unsupported.providerEvidence['web-vitals-runtime'].userOutcome = {
        version: '0.1.0',
        accepted: 0,
        retained: 0,
        evidence: 0,
        dropped: 0,
        rejected: 0,
        truncated: false,
    }
    assert.equal(validate(unsupported).ok, true)

    const partial = createAnimationRumV3GoldenReport()
    partial.providerEvidence['web-vitals-runtime'].userOutcome = {
        version: '0.1.0',
        accepted: 3,
        retained: 3,
        evidence: 3,
        dropped: 1,
        rejected: 0,
        truncated: true,
    }
    partial.captureQuality = {
        sufficiency: 'sufficient',
        integrity: 'partial',
        reasons: ['provider-truncated'],
    }
    partial.metrics = partial.metrics.map(metric => ({ ...metric, status: 'partial' }))
    partial.coverage.userOutcome.status = 'partial'
    assert.equal(validate(partial).ok, true)

    const mismatched = createAnimationRumV3GoldenReport()
    mismatched.capabilities['web-vitals-soft-navigation'].status = 'unknown'
    assert.equal(validate(mismatched).ok, false)

    const inflatedSamples = createAnimationRumV3GoldenReport()
    inflatedSamples.metrics[0].samples = 2
    const inflatedResult = validate(inflatedSamples)
    assert.equal(inflatedResult.ok, false)
    assert.ok(inflatedResult.errors.includes('invalid_metric_samples'))
})

test('supports mixed per-vital capability without disguising unavailable metrics', () => {
    const report = createAnimationRumV3GoldenReport()
    report.capabilities['web-vitals-soft-navigation'] = {
        status: 'supported',
        metrics: { CLS: 'supported', INP: 'unsupported', LCP: 'unknown' },
    }
    report.captureQuality = {
        sufficiency: 'sufficient',
        integrity: 'partial',
        reasons: ['source-field-incomplete'],
    }
    report.providerEvidence['web-vitals-runtime'].userOutcome = {
        version: '0.1.0',
        accepted: 1,
        retained: 1,
        evidence: 1,
        dropped: 0,
        rejected: 0,
        truncated: false,
    }
    report.metrics = [
        { ...report.metrics[0], status: 'partial' },
        { ...report.metrics[1], value: null, samples: null, status: 'unsupported' },
        { ...report.metrics[2], value: null, samples: null, status: 'unknown' },
    ]
    report.coverage.userOutcome = { status: 'partial', evidenceLevel: 'runtime-observation' }
    assert.equal(validate(report).ok, true)

    const disguised = structuredClone(report)
    disguised.metrics[1].status = 'not-observed'
    assert.equal(validate(disguised).ok, false)
})

test('binds latest samples and provider evidence to exactly the non-null final metrics', () => {
    const unobserved = createAnimationRumV3GoldenReport()
    unobserved.metrics[1] = { ...unobserved.metrics[1], value: null, samples: null, status: 'not-observed' }
    unobserved.providerEvidence['web-vitals-runtime'].userOutcome = {
        ...unobserved.providerEvidence['web-vitals-runtime'].userOutcome,
        accepted: 2,
        retained: 2,
        evidence: 2,
    }
    assert.equal(validate(unobserved).ok, true)

    for (const mutate of [
        report => (report.providerEvidence['web-vitals-runtime'].userOutcome.evidence = 2),
        report => (report.providerEvidence['web-vitals-runtime'].userOutcome.accepted = 2),
        report => (report.providerEvidence['web-vitals-runtime'].userOutcome.retained = 2),
        report => (report.metrics[0].samples = 2),
    ]) {
        const report = createAnimationRumV3GoldenReport()
        mutate(report)
        assert.equal(validate(report).ok, false)
    }
})

test('binds disabled and unknown capability states to quality and null metrics', () => {
    const disabled = createAnimationRumV3GoldenReport()
    disabled.capabilities['web-vitals-soft-navigation'] = {
        status: 'disabled',
        metrics: { CLS: 'disabled', INP: 'disabled', LCP: 'disabled' },
    }
    disabled.metrics = disabled.metrics.map(metric => ({ ...metric, value: null, samples: null, status: 'not-instrumented' }))
    disabled.providerEvidence['web-vitals-runtime'].userOutcome = {
        version: '0.1.0',
        accepted: 0,
        retained: 0,
        evidence: 0,
        dropped: 0,
        rejected: 0,
        truncated: false,
    }
    disabled.captureQuality.sufficiency = 'insufficient'
    disabled.coverage.userOutcome = { status: 'not-instrumented', evidenceLevel: 'unsupported-or-unknown' }
    assert.equal(validate(disabled).ok, true)

    const unknown = structuredClone(disabled)
    unknown.capabilities['web-vitals-soft-navigation'] = {
        status: 'unknown',
        metrics: { CLS: 'unknown', INP: 'unknown', LCP: 'unknown' },
    }
    unknown.metrics = unknown.metrics.map(metric => ({ ...metric, status: 'unknown' }))
    unknown.captureQuality = {
        sufficiency: 'insufficient',
        integrity: 'partial',
        reasons: ['source-field-incomplete'],
    }
    unknown.coverage.userOutcome.status = 'unknown'
    assert.equal(validate(unknown).ok, true)
})

test('rejects privacy-sensitive and native soft-navigation identity fields recursively', () => {
    for (const key of ['url', 'pathname', 'selector', 'text', 'navigationId', 'interactionId', 'startTime', 'startedAt', 'segmentId']) {
        const report = createAnimationRumV3GoldenReport()
        report.context[key] = key === 'url' ? 'https://example.test/private' : 'secret'
        const result = validate(report)
        assert.equal(result.ok, false, key)
        assert.ok(result.errors.includes('forbidden_field'), `${key}: ${JSON.stringify(result)}`)
    }
})

test('rejects unknown fields and payloads beyond 64 KiB', () => {
    const unknown = { ...createAnimationRumV3GoldenReport(), custom: 'value' }
    assert.equal(validate(unknown).ok, false)
    const oversized = { ...createAnimationRumV3GoldenReport(), padding: 'x'.repeat(70_000) }
    const result = validate(oversized)
    assert.equal(result.ok, false)
    assert.ok(result.errors.includes('payload_too_large'))
})

test('keeps the v2 golden report accepted without normalization changes', () => {
    const result = validateNormalizedAnimationRumV2(createAnimationRumV2GoldenReport(), {
        nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW,
    })
    assert.equal(result.ok, true)
})
