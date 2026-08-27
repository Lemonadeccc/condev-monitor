import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
    ANIMATION_RUM_V2_INHERITED_V1_METRIC_COUNT,
    ANIMATION_RUM_V2_MAX_METRICS,
    ANIMATION_RUM_V2_METRIC_CATALOG,
    ANIMATION_RUM_V2_PAGE_ADDITION_COUNT,
    ANIMATION_RUM_V2_PER_MINUTE_METRIC_IDS,
    ANIMATION_RUM_V2_TARGET_ADAPTER_ADDITION_COUNT,
    detectAnimationRumProtocol,
    getAnimationRumV2MetricDefinition,
    isAnimationRumV2RouteKey,
    isAnimationRumV2TargetKey,
    validateNormalizedAnimationRumV2,
} from '../build/esm/index.js'
import {
    ANIMATION_RUM_V2_GOLDEN_CASES,
    ANIMATION_RUM_V2_GOLDEN_NOW,
    createAnimationRumV2GoldenReport,
    createAnimationRumV2ReportForMetric,
} from '../build/esm/testing.js'

test('keeps the v2 metric registry closed, unique, and intentionally bounded', () => {
    assert.equal(
        ANIMATION_RUM_V2_METRIC_CATALOG.length,
        ANIMATION_RUM_V2_INHERITED_V1_METRIC_COUNT + ANIMATION_RUM_V2_PAGE_ADDITION_COUNT + ANIMATION_RUM_V2_TARGET_ADAPTER_ADDITION_COUNT
    )
    assert.ok(ANIMATION_RUM_V2_METRIC_CATALOG.length <= ANIMATION_RUM_V2_MAX_METRICS)
    const ids = ANIMATION_RUM_V2_METRIC_CATALOG.map(definition => definition.metricId)
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(getAnimationRumV2MetricDefinition('frame.duration.p95')?.name, 'frameDurationMs')
    assert.equal(getAnimationRumV2MetricDefinition('custom.metric.channel'), undefined)
    assert.equal(getAnimationRumV2MetricDefinition('target.effective-pixel-ratio-bucket.latest')?.unit, 'multiplier')
    assert.ok(Object.isFrozen(ANIMATION_RUM_V2_METRIC_CATALOG))
    assert.ok(ANIMATION_RUM_V2_METRIC_CATALOG.every(definition => Object.isFrozen(definition) && Object.isFrozen(definition.bindings)))
})

test('locks the complete catalog manifest independently from its validator', () => {
    const manifest = ANIMATION_RUM_V2_METRIC_CATALOG.map(definition => ({
        metricId: definition.metricId,
        family: definition.family,
        name: definition.name,
        stat: definition.stat,
        unit: definition.unit,
        evidenceWindow: definition.evidenceWindow,
        bindings: definition.bindings.map(binding => ({
            scope: binding.scope,
            relation: binding.relation,
            owners: [...binding.owners],
        })),
        requiredCapabilities: [...definition.requiredCapabilities],
        allowedValues: definition.allowedValues ? [...definition.allowedValues] : null,
        partialWhenQualityReasons: [...definition.partialWhenQualityReasons],
        populationMetricId: definition.populationMetricId ?? null,
    }))
    const hash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
    assert.equal(hash, '256cc18e6a1ff339887ec246317791e693d317d94e15e91b5158d612e8237b58')
})

test('normalizes only closed event flows and never point-in-time inventory', () => {
    const ids = new Set(ANIMATION_RUM_V2_PER_MINUTE_METRIC_IDS)
    assert.ok(Object.isFrozen(ANIMATION_RUM_V2_PER_MINUTE_METRIC_IDS))
    assert.equal(ids.size, ANIMATION_RUM_V2_PER_MINUTE_METRIC_IDS.length)
    for (const metricId of ids) {
        const definition = getAnimationRumV2MetricDefinition(metricId)
        assert.ok(definition, metricId)
        assert.ok(definition.stat === 'count' || definition.stat === 'sum', metricId)
        assert.equal(definition.evidenceWindow, 'capture-window', metricId)
    }
    for (const metricId of [
        'animation.running.count',
        'animation.infinite.count',
        'accessibility.reduced-motion-active-candidate.count',
        'surface.canvas.count',
        'surface.svg.count',
        'surface.canvas2d.count',
        'surface.webgl.count',
        'surface.webgpu.count',
        'media.video-element.count',
    ]) {
        assert.equal(ids.has(metricId), false, metricId)
    }
})

test('links each distribution to its intended observed population', () => {
    const expected = {
        'main.loaf-duration.p95': 'main.loaf.count',
        'main.loaf-blocking.p95': 'main.loaf.count',
        'pipeline.loaf-style-layout-tail.p95': 'main.loaf.count',
        'main.long-task-duration.p95': 'main.long-task.count',
        'main.long-task-duration.max': 'main.long-task.count',
        'outcome.interaction-duration.p95': 'outcome.interaction.count',
        'pipeline.loaf-render-start-to-paint.p95': 'pipeline.loaf-render-start-to-paint.count',
        'pipeline.loaf-paint-to-presentation.p95': 'pipeline.loaf-paint-to-presentation.count',
        'main.input-capture-to-next-raf.p95': 'main.input-capture-to-next-raf.count',
        'outcome.loaf-first-ui-to-end.p95': 'outcome.loaf-first-ui-to-end.count',
        'pipeline.loaf-forced-style-layout.p95': 'pipeline.loaf-forced-style-layout.count',
        'resource.duration.p95': 'resource.count',
    }
    const actual = Object.fromEntries(
        ANIMATION_RUM_V2_METRIC_CATALOG.filter(definition => definition.populationMetricId).map(definition => [
            definition.metricId,
            definition.populationMetricId,
        ])
    )
    assert.deepEqual(actual, expected)
})

test('accepts an observed zero count without inventing a distribution', () => {
    const populationIds = new Set(
        ANIMATION_RUM_V2_METRIC_CATALOG.flatMap(definition => (definition.populationMetricId ? [definition.populationMetricId] : []))
    )
    for (const metricId of populationIds) {
        const definition = getAnimationRumV2MetricDefinition(metricId)
        assert.ok(definition, metricId)
        const report = createAnimationRumV2ReportForMetric(definition, definition.bindings[0])
        Object.assign(report.metrics[0], { value: 0, samples: 0 })
        const result = validateNormalizedAnimationRumV2(report, { nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW })
        assert.equal(result.ok, true, `${metricId}: ${JSON.stringify(result)}`)
    }
})

test('rejects a distribution when its explicitly reported population is unusable', () => {
    for (const definition of ANIMATION_RUM_V2_METRIC_CATALOG.filter(candidate => candidate.populationMetricId)) {
        const report = createAnimationRumV2ReportForMetric(definition, definition.bindings[0])
        report.metrics.unshift({
            metricId: definition.populationMetricId,
            relation: report.metrics[0].relation,
            owner: report.metrics[0].owner,
            value: null,
            samples: null,
            status: 'not-observed',
        })
        const result = validateNormalizedAnimationRumV2(report, { nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW })
        assert.equal(result.ok, false, definition.metricId)
        assert.ok(result.errors.includes('metric_population_contradiction'), `${definition.metricId}: ${JSON.stringify(result)}`)
    }
})

test('accepts every registered scope, relation, and provider binding', () => {
    for (const definition of ANIMATION_RUM_V2_METRIC_CATALOG) {
        for (const binding of definition.bindings) {
            const report = createAnimationRumV2ReportForMetric(definition, binding)
            const result = validateNormalizedAnimationRumV2(report, { nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW })
            assert.equal(result.ok, true, `${definition.metricId} ${binding.scope}/${binding.relation}: ${JSON.stringify(result)}`)
        }
    }
})

test('keeps GPU timer capability and unavailable metric status semantically aligned', () => {
    const definition = getAnimationRumV2MetricDefinition('renderer.gpu-frame.p95')
    assert.ok(definition)
    const unavailableStatuses = ['not-observed', 'not-instrumented', 'unsupported', 'unknown']
    const cases = [
        { renderer: 'supported', timer: 'supported', allowed: ['not-observed', 'unknown'] },
        { renderer: 'unsupported', timer: 'supported', allowed: ['unsupported'] },
        { renderer: 'supported', timer: 'unsupported', allowed: ['unsupported'] },
        { renderer: 'disabled', timer: 'unknown', allowed: ['not-instrumented'] },
        { renderer: 'unknown', timer: 'supported', allowed: ['unknown'] },
        { renderer: 'unsupported', timer: 'disabled', allowed: ['unsupported'] },
    ]

    for (const binding of definition.bindings) {
        for (const capabilityCase of cases) {
            for (const status of unavailableStatuses) {
                const report = createAnimationRumV2ReportForMetric(definition, binding)
                report.capabilities['renderer-adapter'] = capabilityCase.renderer
                report.capabilities['gpu-timer-query'] = capabilityCase.timer
                Object.assign(report.metrics[0], { value: null, samples: null, status })
                report.coverage.renderer = {
                    status,
                    evidenceLevel: status === 'not-observed' ? 'runtime-observation' : 'unsupported-or-unknown',
                }

                const result = validateNormalizedAnimationRumV2(report, { nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW })
                const label = `${binding.scope}/${binding.relation} renderer=${capabilityCase.renderer} timer=${capabilityCase.timer} status=${status}`
                assert.equal(result.ok, capabilityCase.allowed.includes(status), `${label}: ${JSON.stringify(result)}`)
                if (!result.ok && !capabilityCase.allowed.includes(status)) {
                    assert.ok(result.errors.includes('metric_capability_mismatch'), `${label}: ${JSON.stringify(result)}`)
                }
            }
        }
    }
})

test('matches the shared v2 golden acceptance corpus', () => {
    for (const golden of ANIMATION_RUM_V2_GOLDEN_CASES) {
        const result = validateNormalizedAnimationRumV2(golden.payload(), { nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW })
        assert.equal(result.ok, golden.accepted, `${golden.name}: ${JSON.stringify(result)}`)
    }
})

test('keeps normalized validation separate from transport protocol detection', () => {
    const report = createAnimationRumV2GoldenReport()
    assert.equal(validateNormalizedAnimationRumV2(report, { nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW }).ok, true)
    assert.equal(detectAnimationRumProtocol({ ...report, event_type: 'animation_rum' }), 'v2')
    assert.equal(detectAnimationRumProtocol({ event_type: 'animation_rum', contractVersion: 1, snapshotSchemaVersion: 1 }), 'v1')
    assert.equal(
        detectAnimationRumProtocol({ event_type: 'animation_rum', contractVersion: 9, snapshotSchemaVersion: 1 }),
        'versioned-unknown'
    )
    assert.equal(detectAnimationRumProtocol({ event_type: 'animation_rum', message: 'legacy custom event' }), 'legacy-animation-rum')
    assert.equal(detectAnimationRumProtocol({ event_type: 'error', contractVersion: 2, snapshotSchemaVersion: 1 }), 'other')
})

test('shares privacy-bounded semantic key validation with server control planes', () => {
    assert.equal(isAnimationRumV2RouteKey('catalog.product-detail'), true)
    assert.equal(isAnimationRumV2RouteKey('docs:motion_examples'), true)
    assert.equal(isAnimationRumV2RouteKey('orders.12345'), false)
    assert.equal(isAnimationRumV2RouteKey('orders.550e8400-e29b-41d4-a716-446655440000'), false)
    assert.equal(isAnimationRumV2RouteKey('Catalog.Product'), false)

    assert.equal(isAnimationRumV2TargetKey('hero-canvas'), true)
    assert.equal(isAnimationRumV2TargetKey('gallery.card'), true)
    assert.equal(isAnimationRumV2TargetKey('item.abcdef0123456789'), false)
    assert.equal(isAnimationRumV2TargetKey('hero:canvas'), false)
})

test('does not accept a transport wrapper as a normalized report', () => {
    const wrapped = { ...createAnimationRumV2GoldenReport(), event_type: 'animation_rum', _eventId: 'event_12345678' }
    const result = validateNormalizedAnimationRumV2(wrapped, { nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW })
    assert.equal(result.ok, false)
    assert.ok(result.errors.includes('unknown_root_field'))
})
