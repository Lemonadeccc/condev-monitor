import assert from 'node:assert/strict'
import test from 'node:test'

import {
    ANIMATION_LAB_METRIC_CATALOG_V1,
    ANIMATION_LAB_METRIC_CATALOG_V2,
    ANIMATION_LAB_METRIC_CATALOG_V4,
} from '@condev-monitor/animation-lab'

import {
    decodePageProbeResult,
    decodePageProbeResultWithObserverDrops,
    PAGE_PROBE_ACTION_METRIC_IDS,
    PAGE_PROBE_ACTION_METRIC_IDS_V2,
    PAGE_PROBE_ACTION_METRIC_IDS_V3,
    PAGE_PROBE_ACTION_METRIC_IDS_V4,
    PAGE_PROBE_CAPABILITY_KEYS,
    PAGE_PROBE_CAPABILITY_KEYS_V2,
    PAGE_PROBE_CAPABILITY_KEYS_V4,
    PAGE_PROBE_OBSERVER_DROP_KEYS,
    PAGE_PROBE_ROOT_METRIC_IDS,
    PAGE_PROBE_ROOT_METRIC_IDS_V2,
    PAGE_PROBE_ROOT_METRIC_IDS_V3,
    PAGE_PROBE_ROOT_METRIC_IDS_V4,
} from '../src/probe-result.ts'

const expectedActions = [{ actionId: 'hero-hover', order: 0, kind: 'hover' }]

function metric(overrides = {}) {
    return {
        family: 'frameCadence',
        name: 'frameDurationMs',
        stat: 'p95',
        unit: 'ms',
        value: 18.5,
        samples: 120,
        status: 'measured',
        evidenceLevel: 'controlled-lab-measurement',
        ...overrides,
    }
}

const catalogByIdV3 = new Map(ANIMATION_LAB_METRIC_CATALOG_V4.map(entry => [entry.metricId, entry]))
const catalogIdByTuple = new Map(
    ANIMATION_LAB_METRIC_CATALOG_V1.map(entry => [[entry.family, entry.name, entry.stat, entry.unit].join('|'), entry.metricId])
)

function metricId(metric) {
    return catalogIdByTuple.get([metric.family, metric.name, metric.stat, metric.unit].join('|'))
}

function metricForCatalogId(metrics, id) {
    const entry = catalogByIdV3.get(id)
    assert.ok(entry, id)
    return metrics.find(
        item => item.family === entry.family && item.name === entry.name && item.stat === entry.stat && item.unit === entry.unit
    )
}

function metricForId(metricId, overrides = {}) {
    const entry = catalogByIdV3.get(metricId)
    assert.ok(entry, metricId)
    return {
        family: entry.family,
        name: entry.name,
        stat: entry.stat,
        unit: entry.unit,
        value: entry.unit === 'ratio' || entry.unit === 'score' ? 0.5 : 1,
        samples: 1,
        status: 'measured',
        evidenceLevel: 'controlled-lab-measurement',
        ...overrides,
    }
}

function observerDrops(value = 0) {
    return Object.fromEntries(PAGE_PROBE_OBSERVER_DROP_KEYS.map(key => [key, value]))
}

function observerDropCountUnavailable(value = false) {
    return Object.fromEntries(PAGE_PROBE_OBSERVER_DROP_KEYS.map(key => [key, value]))
}

function withObserverDropContract(result) {
    result.observerDrops = observerDrops()
    result.observerDropCountUnavailable = observerDropCountUnavailable()
    result.observerDropCountCapped = observerDropCountUnavailable()
    result.observerEntryDeliveryObserved = observerDropCountUnavailable(true)
    return result
}

const loafPaintMetricIds = [
    'pipeline.loaf-render-start-to-paint.count',
    'pipeline.loaf-render-start-to-paint.p95',
    'pipeline.loaf-paint-to-presentation.count',
    'pipeline.loaf-paint-to-presentation.p95',
]
const eventTimingMetricIds = [
    'interaction.event-duration.p95',
    'interaction.input-delay.p95',
    'interaction.processing.p95',
    'interaction.presentation.p95',
    'interaction.count',
]
const videoPlaybackQualityLimitations = [
    'video-playback-quality-cumulative-snapshot-not-measurement-window-delta',
    'video-playback-quality-total-includes-displayed-and-dropped',
]
const inputFrameSchedulingMetricIds = ['main.input-capture-to-next-raf-callback.count', 'main.input-capture-to-next-raf-callback.p95']
const loafFirstUIEventMetricIds = ['interaction.loaf-first-ui-event-to-frame-end.count', 'interaction.loaf-first-ui-event-to-frame-end.p95']
const loafForcedStyleLayoutMetricIds = [
    'pipeline.loaf-attributed-forced-style-layout.count',
    'pipeline.loaf-attributed-forced-style-layout.p95',
]

function rawResult() {
    return {
        durationMs: 1_000,
        metrics: PAGE_PROBE_ROOT_METRIC_IDS.map(metricId =>
            metricForId(metricId, metricId === 'probe.dropped-samples.count' ? { value: 0 } : {})
        ),
        actionResults: [
            {
                actionId: 'hero-hover',
                order: 0,
                label: 'hero-hover',
                kind: 'hover',
                startedAtMs: 100,
                endedAtMs: 600,
                outcome: 'completed',
                metrics: PAGE_PROBE_ACTION_METRIC_IDS.map(metricId => metricForId(metricId)),
            },
        ],
        capabilities: Object.fromEntries(PAGE_PROBE_CAPABILITY_KEYS.map(key => [key, true])),
        sampleDrops: {
            frames: 0,
            longTasks: 0,
            longAnimationFrames: 0,
            eventTimings: 0,
            resources: 0,
        },
        limitations: ['private page prose must never cross the decoder'],
    }
}

function rawResultV2() {
    const result = rawResult()
    result.metrics = PAGE_PROBE_ROOT_METRIC_IDS_V2.map(metricId =>
        metricForId(metricId, metricId === 'probe.dropped-samples.count' ? { value: 0 } : {})
    )
    result.actionResults[0].metrics = PAGE_PROBE_ACTION_METRIC_IDS_V2.map(metricId => metricForId(metricId))
    result.capabilities = Object.fromEntries(PAGE_PROBE_CAPABILITY_KEYS_V2.map(key => [key, true]))
    result.sampleDrops.inputFrameScheduling = 0
    return result
}

function rawResultV3() {
    const result = rawResultV2()
    result.metrics = PAGE_PROBE_ROOT_METRIC_IDS_V3.map(metricId =>
        metricForId(metricId, metricId === 'probe.dropped-samples.count' ? { value: 0 } : {})
    )
    result.actionResults[0].metrics = PAGE_PROBE_ACTION_METRIC_IDS_V3.map(metricId =>
        metricForId(metricId, metricId === 'media.video-window-dropped-frame-rate' ? { value: 0.03, samples: 100 } : {})
    )
    result.actionResults[0].videoWindowEvidence = {
        beginSurfaces: 1,
        endSurfaces: 1,
        matchedSurfaces: 1,
        eligibleSurfaces: 1,
        readErrorSurfaces: 0,
        discontinuitySurfaces: 0,
        totalFrameDelta: 100,
        droppedFrameDelta: 3,
    }
    return result
}

function rendererWindowEvidence(overrides = {}) {
    return {
        acceptedSamples: 1,
        retainedSamples: 1,
        droppedSamples: 0,
        rejectedSamples: 0,
        drawCallSamples: 1,
        triangleSamples: 1,
        ...overrides,
    }
}

function rendererRootEvidence(overrides = {}) {
    return {
        ...rendererWindowEvidence({ acceptedSamples: 2, retainedSamples: 2, drawCallSamples: 2, triangleSamples: 2 }),
        gpuMeasuredSamples: 2,
        gpuNotProvidedSamples: 0,
        gpuInvalidSamples: 0,
        gpuDisjointSamples: 0,
        gpuContextLostSamples: 0,
        gpuErrorSamples: 0,
        gpuSupportedSamples: 2,
        gpuUnsupportedSamples: 0,
        gpuDisabledSamples: 0,
        gpuUnknownCapabilitySamples: 0,
        ...overrides,
    }
}

function rawResultV4() {
    const result = rawResultV3()
    result.metrics = PAGE_PROBE_ROOT_METRIC_IDS_V4.map(metricId => {
        if (metricId === 'probe.dropped-samples.count') return metricForId(metricId, { value: 0 })
        if (metricId === 'renderer.draw-calls.p95') return metricForId(metricId, { value: 4, samples: 2 })
        if (metricId === 'renderer.triangles.p95') return metricForId(metricId, { value: 120, samples: 2 })
        if (metricId === 'renderer.gpu-frame.p95') return metricForId(metricId, { value: 4.5, samples: 2 })
        return metricForId(metricId)
    })
    result.actionResults[0].metrics = PAGE_PROBE_ACTION_METRIC_IDS_V4.map(metricId => {
        if (metricId === 'media.video-window-dropped-frame-rate') return metricForId(metricId, { value: 0.03, samples: 100 })
        if (metricId === 'renderer.draw-calls.p95') return metricForId(metricId, { value: 4, samples: 1 })
        if (metricId === 'renderer.triangles.p95') return metricForId(metricId, { value: 120, samples: 1 })
        return metricForId(metricId)
    })
    result.actionResults[0].rendererWindowEvidence = rendererWindowEvidence()
    result.capabilities = Object.fromEntries(PAGE_PROBE_CAPABILITY_KEYS_V4.map(key => [key, true]))
    result.sampleDrops.rendererHostEvidence = 0
    result.rendererEvidence = rendererRootEvidence()
    return result
}

function setLoafPaintStatus(result, status) {
    const evidenceLevel = status === 'unsupported' || status === 'unknown' ? 'unsupported-or-unknown' : 'controlled-lab-measurement'
    for (const metrics of [result.metrics, ...result.actionResults.map(action => action.metrics)]) {
        for (const [index, item] of metrics.entries()) {
            const id = ANIMATION_LAB_METRIC_CATALOG_V2.find(
                entry => entry.family === item.family && entry.name === item.name && entry.stat === item.stat && entry.unit === item.unit
            )?.metricId
            if (!loafPaintMetricIds.includes(id)) continue
            const isCount = id.endsWith('.count')
            metrics[index] = {
                ...item,
                value: status === 'not-observed' && isCount ? 0 : null,
                samples: status === 'not-observed' ? 0 : null,
                status: status === 'not-observed' && isCount ? 'measured' : status,
                evidenceLevel,
            }
        }
    }
}

function setPairStatus(result, metricIds, status) {
    const evidenceLevel = status === 'unsupported' || status === 'unknown' ? 'unsupported-or-unknown' : 'controlled-lab-measurement'
    for (const metrics of [result.metrics, ...result.actionResults.map(action => action.metrics)]) {
        for (const [index, item] of metrics.entries()) {
            const id = ANIMATION_LAB_METRIC_CATALOG_V2.find(
                entry => entry.family === item.family && entry.name === item.name && entry.stat === item.stat && entry.unit === item.unit
            )?.metricId
            if (!metricIds.includes(id)) continue
            const isCount = id.endsWith('.count')
            metrics[index] = {
                ...item,
                value: status === 'not-observed' && isCount ? 0 : null,
                samples: status === 'not-observed' ? 0 : null,
                status: status === 'not-observed' && isCount ? 'measured' : status,
                evidenceLevel,
            }
        }
    }
}

test('rebuilds a catalog-only probe result and replaces page limitations with runner codes', () => {
    const raw = rawResult()
    const decoded = decodePageProbeResult(raw, expectedActions)

    assert.deepEqual(
        decoded.metrics.map(({ limitations: _limitations, ...item }) => item),
        raw.metrics
    )
    const observedRafCadence = decoded.metrics.find(item => item.name === 'inferredRefreshHz')
    assert.deepEqual(observedRafCadence.limitations, ['observed-page-raf-cadence-not-display-refresh-rate'])
    assert.equal(decoded.actionResults.length, 1)
    assert.deepEqual(
        decoded.actionResults[0].metrics.map(({ limitations: _limitations, ...item }) => item),
        raw.actionResults[0].metrics
    )
    assert.deepEqual(decoded.capabilities, raw.capabilities)
    assert.ok(decoded.limitations.every(value => /^[a-z0-9-]+$/.test(value)))
    assert.equal(JSON.stringify(decoded).includes('private page prose'), false)
})

test('discloses the conditional Event Timing population and entry-count semantics', () => {
    const decoded = decodePageProbeResult(rawResult(), expectedActions)
    const rootEventTiming = decoded.metrics.filter(item => eventTimingMetricIds.includes(metricId(item)))
    const actionEventTiming = decoded.actionResults[0].metrics.filter(item => eventTimingMetricIds.includes(metricId(item)))

    assert.equal(rootEventTiming.length, 5)
    assert.equal(actionEventTiming.length, 4)
    assert.ok([...rootEventTiming, ...actionEventTiming].every(item => item.limitations.includes('event-timing-duration-threshold-16ms')))
    const count = rootEventTiming.find(item => metricId(item) === 'interaction.count')
    assert.ok(count.limitations.includes('event-timing-entry-count-not-distinct-interactions'))
    assert.equal(count.status, 'measured')
    assert.equal(count.value, 1)
})

test('discloses LoAF and page-vital observation boundaries on decoded metrics', () => {
    const decoded = decodePageProbeResult(rawResult(), expectedActions)
    for (const metricIdValue of ['main.loaf.count', 'main.loaf.duration.p95', 'main.loaf.blocking.p95']) {
        assert.ok(metricForCatalogId(decoded.metrics, metricIdValue).limitations.includes('loaf-only-over-50ms'))
    }
    assert.deepEqual(metricForCatalogId(decoded.metrics, 'vital.lcp.latest').limitations, [
        'single-controlled-run-not-field-p75',
        'lcp-soft-navigation-not-modeled',
    ])
    assert.deepEqual(metricForCatalogId(decoded.metrics, 'vital.cls.latest').limitations, [
        'single-controlled-run-not-field-p75',
        'lab-cls-window-may-understate-full-session',
    ])
})

test('keeps video playback quality populations distinct and uses media frames as samples', () => {
    const cases = [
        {
            name: 'complete',
            elements: 2,
            rawMetric: { value: 0.1, samples: 150, status: 'measured' },
            limitation: null,
        },
        {
            name: 'partial',
            elements: 2,
            rawMetric: { value: 0.05, samples: 100, status: 'partial' },
            limitation: 'video-playback-quality-partial-surface-coverage',
        },
        {
            name: 'no-video',
            elements: 0,
            rawMetric: { value: null, samples: 0, status: 'not-observed' },
            limitation: 'video-playback-quality-no-video-elements',
        },
        {
            name: 'zero-frames',
            elements: 1,
            rawMetric: { value: null, samples: 0, status: 'not-observed' },
            limitation: 'video-playback-quality-zero-total-frames',
        },
        {
            name: 'read-error',
            elements: 1,
            rawMetric: { value: null, samples: null, status: 'not-observed' },
            limitation: 'video-playback-quality-read-error',
        },
    ]

    for (const fixture of cases) {
        const raw = rawResult()
        Object.assign(
            raw.metrics.find(item => item.name === 'videoElementCount'),
            { value: fixture.elements }
        )
        Object.assign(
            raw.metrics.find(item => item.name === 'videoDroppedFrameRate'),
            fixture.rawMetric
        )
        const decoded = decodePageProbeResult(raw, expectedActions)
        const metric = decoded.metrics.find(item => item.name === 'videoDroppedFrameRate')
        assert.deepEqual(
            {
                value: metric.value,
                samples: metric.samples,
                status: metric.status,
                limitations: metric.limitations ?? [],
            },
            {
                ...fixture.rawMetric,
                limitations: [...videoPlaybackQualityLimitations, ...(fixture.limitation ? [fixture.limitation] : [])],
            },
            fixture.name
        )
    }

    const unsupported = rawResult()
    unsupported.capabilities.videoPlaybackQuality = false
    Object.assign(
        unsupported.metrics.find(item => item.name === 'videoDroppedFrameRate'),
        {
            value: null,
            samples: null,
            status: 'unsupported',
        }
    )
    const unsupportedMetric = decodePageProbeResult(unsupported, expectedActions).metrics.find(
        item => item.name === 'videoDroppedFrameRate'
    )
    assert.deepEqual(
        {
            value: unsupportedMetric.value,
            samples: unsupportedMetric.samples,
            status: unsupportedMetric.status,
            limitations: unsupportedMetric.limitations,
        },
        { value: null, samples: null, status: 'unsupported', limitations: videoPlaybackQualityLimitations }
    )
})

test('decodes catalog v3 action-window video deltas and derives closed limitations', () => {
    const measured = decodePageProbeResult(rawResultV3(), expectedActions, 3).actionResults[0].metrics.find(
        item => item.name === 'videoWindowDroppedFrameRate'
    )
    assert.deepEqual(
        { value: measured.value, samples: measured.samples, status: measured.status, limitations: measured.limitations },
        {
            value: 0.03,
            samples: 100,
            status: 'measured',
            limitations: [
                'video-playback-quality-window-counter-delta',
                'video-playback-quality-total-includes-displayed-and-dropped',
                'video-playback-quality-window-object-identity-only',
                'video-playback-quality-not-decode-presentation-or-gpu-timing',
            ],
        }
    )

    const partial = rawResultV3()
    Object.assign(partial.actionResults[0].metrics.at(-1), { value: 0.02, samples: 50, status: 'partial' })
    Object.assign(partial.actionResults[0].videoWindowEvidence, {
        endSurfaces: 2,
        totalFrameDelta: 50,
        droppedFrameDelta: 1,
    })
    const partialMetric = decodePageProbeResult(partial, expectedActions, 3).actionResults[0].metrics.at(-1)
    assert.equal(partialMetric.status, 'partial')
    assert.ok(partialMetric.limitations.includes('video-playback-quality-window-partial-surface-coverage'))
    assert.ok(partialMetric.limitations.includes('video-playback-quality-window-element-added'))

    const unknown = rawResultV3()
    Object.assign(unknown.actionResults[0].metrics.at(-1), {
        value: null,
        samples: null,
        status: 'unknown',
        evidenceLevel: 'unsupported-or-unknown',
    })
    Object.assign(unknown.actionResults[0].videoWindowEvidence, {
        eligibleSurfaces: 0,
        discontinuitySurfaces: 1,
        totalFrameDelta: 0,
        droppedFrameDelta: 0,
    })
    const unknownMetric = decodePageProbeResult(unknown, expectedActions, 3).actionResults[0].metrics.at(-1)
    assert.equal(unknownMetric.status, 'unknown')
    assert.ok(unknownMetric.limitations.includes('video-playback-quality-window-counter-discontinuity'))

    for (const fixture of [
        { beginSurfaces: 0, endSurfaces: 0, limitation: 'video-playback-quality-window-no-video-elements' },
        { beginSurfaces: 1, endSurfaces: 1, limitation: 'video-playback-quality-window-zero-total-frame-delta' },
    ]) {
        const raw = rawResultV3()
        Object.assign(raw.actionResults[0].metrics.at(-1), { value: null, samples: 0, status: 'not-observed' })
        Object.assign(raw.actionResults[0].videoWindowEvidence, {
            beginSurfaces: fixture.beginSurfaces,
            endSurfaces: fixture.endSurfaces,
            matchedSurfaces: fixture.beginSurfaces,
            eligibleSurfaces: fixture.beginSurfaces,
            totalFrameDelta: 0,
            droppedFrameDelta: 0,
        })
        const decoded = decodePageProbeResult(raw, expectedActions, 3).actionResults[0].metrics.at(-1)
        assert.equal(decoded.status, 'not-observed')
        assert.ok(decoded.limitations.includes(fixture.limitation))
    }
})

test('decodes catalog v4 renderer evidence without manufacturing adapter or GPU measurements', () => {
    const decoded = decodePageProbeResult(rawResultV4(), expectedActions, 4)
    const rootRenderer = decoded.metrics.filter(
        item => item.family === 'renderer' && ['drawCalls', 'triangles', 'gpuFrameMs'].includes(item.name)
    )
    assert.deepEqual(
        rootRenderer.map(item => [item.name, item.value, item.samples, item.status]),
        [
            ['drawCalls', 4, 2, 'measured'],
            ['triangles', 120, 2, 'measured'],
            ['gpuFrameMs', 4.5, 2, 'measured'],
        ]
    )
    const actionRenderer = decoded.actionResults[0].metrics.filter(item => item.family === 'renderer')
    assert.deepEqual(
        actionRenderer.map(item => [item.name, item.samples, item.status]),
        [
            ['drawCalls', 1, 'measured'],
            ['triangles', 1, 'measured'],
        ]
    )
    assert.equal(
        actionRenderer.some(item => item.name === 'gpuFrameMs'),
        false
    )
    assert.ok(decoded.limitations.includes('renderer-gpu-action-window-not-proven'))
    assert.ok(rootRenderer.every(item => item.limitations.includes('renderer-multiple-producers-not-distinguished')))

    const noAdapter = rawResultV4()
    for (const item of noAdapter.metrics.filter(
        item => item.family === 'renderer' && ['drawCalls', 'triangles', 'gpuFrameMs'].includes(item.name)
    )) {
        Object.assign(item, { value: null, samples: 0, status: 'not-observed' })
    }
    for (const item of noAdapter.actionResults[0].metrics.filter(item => item.family === 'renderer')) {
        Object.assign(item, { value: null, samples: 0, status: 'not-observed' })
    }
    noAdapter.rendererEvidence = rendererRootEvidence({
        acceptedSamples: 0,
        retainedSamples: 0,
        drawCallSamples: 0,
        triangleSamples: 0,
        gpuMeasuredSamples: 0,
        gpuSupportedSamples: 0,
    })
    noAdapter.actionResults[0].rendererWindowEvidence = rendererWindowEvidence({
        acceptedSamples: 0,
        retainedSamples: 0,
        drawCallSamples: 0,
        triangleSamples: 0,
    })
    const noAdapterRenderer = decodePageProbeResult(noAdapter, expectedActions, 4).metrics.filter(item =>
        ['drawCalls', 'triangles', 'gpuFrameMs'].includes(item.name)
    )
    assert.ok(noAdapterRenderer.every(item => item.status === 'not-observed' && item.value === null && item.samples === 0))

    const unsupportedGpu = rawResultV4()
    unsupportedGpu.rendererEvidence = rendererRootEvidence({
        acceptedSamples: 1,
        retainedSamples: 1,
        drawCallSamples: 1,
        triangleSamples: 1,
        gpuMeasuredSamples: 0,
        gpuNotProvidedSamples: 1,
        gpuSupportedSamples: 0,
        gpuDisabledSamples: 1,
    })
    for (const item of unsupportedGpu.metrics.filter(item => item.name === 'drawCalls' || item.name === 'triangles')) {
        item.samples = 1
    }
    Object.assign(
        unsupportedGpu.metrics.find(item => item.name === 'gpuFrameMs'),
        {
            value: null,
            samples: null,
            status: 'unsupported',
            evidenceLevel: 'unsupported-or-unknown',
        }
    )
    assert.equal(
        decodePageProbeResult(unsupportedGpu, expectedActions, 4).metrics.find(item => item.name === 'gpuFrameMs')?.status,
        'unsupported'
    )
})

test('derives catalog v4 renderer partial and unknown states from closed evidence counters', () => {
    const partial = rawResultV4()
    partial.rendererEvidence.rejectedSamples = 1
    for (const item of partial.metrics.filter(
        item => item.family === 'renderer' && ['drawCalls', 'triangles', 'gpuFrameMs'].includes(item.name)
    )) {
        item.status = 'partial'
    }
    const partialDecoded = decodePageProbeResult(partial, expectedActions, 4)
    assert.ok(
        partialDecoded.metrics
            .filter(item => item.family === 'renderer' && ['drawCalls', 'triangles', 'gpuFrameMs'].includes(item.name))
            .every(item => item.status === 'partial')
    )
    assert.ok(partialDecoded.limitations.includes('renderer-host-evidence-rejected'))

    const disjoint = rawResultV4()
    Object.assign(disjoint.rendererEvidence, {
        gpuMeasuredSamples: 0,
        gpuDisjointSamples: 2,
    })
    Object.assign(
        disjoint.metrics.find(item => item.name === 'gpuFrameMs'),
        {
            value: null,
            samples: null,
            status: 'unknown',
            evidenceLevel: 'unsupported-or-unknown',
        }
    )
    assert.equal(decodePageProbeResult(disjoint, expectedActions, 4).metrics.find(item => item.name === 'gpuFrameMs')?.status, 'unknown')

    const forgedSamples = rawResultV4()
    forgedSamples.metrics.find(item => item.name === 'drawCalls').samples = 1
    assert.throws(() => decodePageProbeResult(forgedSamples, expectedActions, 4), /renderer draw-call metric contract/)

    const privateRendererField = rawResultV4()
    privateRendererField.rendererEvidence.scene = 'private-scene'
    assert.throws(() => decodePageProbeResult(privateRendererField, expectedActions, 4), /unsupported fields/)

    const forgedDrop = rawResultV4()
    forgedDrop.sampleDrops.rendererHostEvidence = 1
    forgedDrop.metrics.find(item => item.name === 'droppedProbeSamples').value = 1
    assert.throws(() => decodePageProbeResult(forgedDrop, expectedActions, 4), /renderer sample drop coherence/)
})

test('keeps catalog v4 renderer evidence truncation scoped to the affected root and action windows', () => {
    const raw = rawResultV4()
    raw.sampleDrops.rendererHostEvidence = 1
    raw.metrics.find(item => item.name === 'droppedProbeSamples').value = 1
    Object.assign(raw.rendererEvidence, {
        acceptedSamples: 3,
        droppedSamples: 1,
    })
    for (const item of raw.metrics.filter(item => ['drawCalls', 'triangles', 'gpuFrameMs'].includes(item.name))) {
        item.status = 'partial'
    }

    const decoded = decodePageProbeResult(raw, expectedActions, 4)
    const rootRenderer = decoded.metrics.filter(item => ['drawCalls', 'triangles', 'gpuFrameMs'].includes(item.name))
    const actionRenderer = decoded.actionResults[0].metrics.filter(item => ['drawCalls', 'triangles'].includes(item.name))

    assert.ok(rootRenderer.every(item => item.status === 'partial'))
    assert.ok(rootRenderer.every(item => item.limitations.includes('page-probe-renderer-host-evidence-truncated')))
    assert.ok(actionRenderer.every(item => item.status === 'measured'))
    assert.ok(actionRenderer.every(item => !item.limitations.includes('page-probe-renderer-host-evidence-truncated')))

    const actionTruncated = rawResultV4()
    actionTruncated.sampleDrops.rendererHostEvidence = 1
    actionTruncated.metrics.find(item => item.name === 'droppedProbeSamples').value = 1
    Object.assign(actionTruncated.rendererEvidence, { acceptedSamples: 3, droppedSamples: 1 })
    Object.assign(actionTruncated.actionResults[0].rendererWindowEvidence, {
        acceptedSamples: 2,
        droppedSamples: 1,
    })
    for (const item of actionTruncated.metrics.filter(item => ['drawCalls', 'triangles', 'gpuFrameMs'].includes(item.name))) {
        item.status = 'partial'
    }
    for (const item of actionTruncated.actionResults[0].metrics.filter(item => ['drawCalls', 'triangles'].includes(item.name))) {
        item.status = 'partial'
    }

    const actionTruncatedDecoded = decodePageProbeResult(actionTruncated, expectedActions, 4)
    const truncatedActionRenderer = actionTruncatedDecoded.actionResults[0].metrics.filter(item =>
        ['drawCalls', 'triangles'].includes(item.name)
    )
    assert.ok(truncatedActionRenderer.every(item => item.status === 'partial'))
    assert.ok(truncatedActionRenderer.every(item => item.limitations.includes('page-probe-renderer-host-evidence-truncated')))
})

test('rejects forged catalog v3 video-window coverage and keeps catalog v2 unchanged', () => {
    assert.doesNotThrow(() => decodePageProbeResult(rawResultV2(), expectedActions, 2))

    const forgedCoverage = rawResultV3()
    forgedCoverage.actionResults[0].videoWindowEvidence.endSurfaces = 2
    assert.throws(() => decodePageProbeResult(forgedCoverage, expectedActions, 3), TypeError)

    const forgedHealthyPartial = rawResultV3()
    forgedHealthyPartial.actionResults[0].metrics.at(-1).status = 'partial'
    assert.throws(() => decodePageProbeResult(forgedHealthyPartial, expectedActions, 3), TypeError)

    const forgedLegacy = rawResultV2()
    forgedLegacy.actionResults[0].videoWindowEvidence = rawResultV3().actionResults[0].videoWindowEvidence
    assert.throws(() => decodePageProbeResult(forgedLegacy, expectedActions, 2), TypeError)
})

test('rejects partial status outside video quality and incoherent video sample states', () => {
    const forgedPartial = rawResult()
    forgedPartial.metrics[0].status = 'partial'
    assert.throws(() => decodePageProbeResult(forgedPartial, expectedActions), TypeError)

    for (const rawMetric of [
        { value: 0.1, samples: 0, status: 'measured' },
        { value: 0.1, samples: 0, status: 'partial' },
        { value: null, samples: 1, status: 'not-observed' },
    ]) {
        const raw = rawResult()
        Object.assign(
            raw.metrics.find(item => item.name === 'videoDroppedFrameRate'),
            rawMetric
        )
        assert.throws(() => decodePageProbeResult(raw, expectedActions), TypeError)
    }

    for (const fixture of [
        { elements: 0, rawMetric: { value: 0.1, samples: 100, status: 'measured' } },
        { elements: 0, rawMetric: { value: 0.1, samples: 100, status: 'partial' } },
        { elements: 1, rawMetric: { value: 0.1, samples: 100, status: 'partial' } },
        { elements: 0, rawMetric: { value: null, samples: null, status: 'not-observed' } },
    ]) {
        const raw = rawResult()
        Object.assign(
            raw.metrics.find(item => item.name === 'videoElementCount'),
            { value: fixture.elements }
        )
        Object.assign(
            raw.metrics.find(item => item.name === 'videoDroppedFrameRate'),
            fixture.rawMetric
        )
        assert.throws(() => decodePageProbeResult(raw, expectedActions), TypeError)
    }

    const forgedElementPopulation = rawResult()
    Object.assign(
        forgedElementPopulation.metrics.find(item => item.name === 'videoElementCount'),
        { samples: 2 }
    )
    assert.throws(() => decodePageProbeResult(forgedElementPopulation, expectedActions), TypeError)
})

test('decodes catalog v2 LoAF paint phases without changing the default v1 payload contract', () => {
    const raw = rawResultV2()
    const decoded = decodePageProbeResult(raw, expectedActions, 2)
    const renderP95 = decoded.metrics.find(item => item.name === 'longAnimationFrameRenderStartToPaintMs')
    const presentationP95 = decoded.metrics.find(item => item.name === 'longAnimationFramePaintToPresentationMs')

    assert.equal(renderP95.value, 1)
    assert.ok(renderP95.limitations.includes('loaf-only-over-50ms'))
    assert.ok(presentationP95.limitations.includes('presentation-time-implementation-dependent'))
    assert.throws(() => decodePageProbeResult(raw, expectedActions), TypeError)

    const legacyUnknown = rawResult()
    legacyUnknown.metrics[0].value = null
    legacyUnknown.metrics[0].samples = null
    legacyUnknown.metrics[0].status = 'unknown'
    assert.throws(() => decodePageProbeResult(legacyUnknown, expectedActions), TypeError)
})

test('preserves missing, unknown, and exposed-null LoAF paint evidence instead of manufacturing zero milliseconds', () => {
    const unsupported = rawResultV2()
    unsupported.capabilities.loafPaintTime = false
    unsupported.capabilities.loafPresentationTime = false
    setLoafPaintStatus(unsupported, 'unsupported')
    const unsupportedMetrics = decodePageProbeResult(unsupported, expectedActions, 2).metrics.filter(item => item.name.includes('Paint'))
    assert.ok(unsupportedMetrics.every(item => item.value === null && item.status === 'unsupported'))

    const unknown = rawResultV2()
    unknown.capabilities.loafPaintTime = null
    unknown.capabilities.loafPresentationTime = null
    setLoafPaintStatus(unknown, 'unknown')
    const unknownMetrics = decodePageProbeResult(unknown, expectedActions, 2).metrics.filter(item => item.name.includes('Paint'))
    assert.ok(unknownMetrics.every(item => item.value === null && item.status === 'unknown'))

    const exposedNull = rawResultV2()
    setLoafPaintStatus(exposedNull, 'not-observed')
    const exposedMetrics = decodePageProbeResult(exposedNull, expectedActions, 2).metrics.filter(item => item.name.includes('Paint'))
    assert.ok(exposedMetrics.filter(item => item.stat === 'p95').every(item => item.value === null && item.status === 'not-observed'))
    assert.ok(exposedMetrics.filter(item => item.stat === 'count').every(item => item.value === 0 && item.status === 'measured'))
})

test('decodes v2 input scheduling and LoAF diagnostic pairs with closed proxy limitations', () => {
    const decoded = decodePageProbeResult(rawResultV2(), expectedActions, 2)
    const input = decoded.metrics.find(item => item.name === 'inputCaptureToNextRafCallbackMs')
    const firstUi = decoded.metrics.find(item => item.name === 'longAnimationFrameFirstUIEventToFrameEndMs')
    const forced = decoded.metrics.find(item => item.name === 'longAnimationFrameAttributedForcedStyleAndLayoutMs')

    assert.ok(input.limitations.includes('input-capture-listener-to-next-raf-callback-proxy'))
    assert.ok(input.limitations.includes('not-paint-or-presentation-timing'))
    assert.ok(firstUi.limitations.includes('first-ui-event-may-predate-loaf'))
    assert.ok(firstUi.limitations.includes('loaf-frame-end-not-paint-or-presentation'))
    assert.ok(forced.limitations.includes('loaf-attributed-scripts-lower-bound'))
    assert.ok(forced.limitations.includes('forced-style-layout-implementation-dependent'))
})

test('keeps false, unknown, and supported-with-no-samples distinct for the six v2 metrics', () => {
    const raw = rawResultV2()
    raw.capabilities.inputFrameScheduling = false
    raw.capabilities.loafFirstUIEventTimestamp = null
    setPairStatus(raw, inputFrameSchedulingMetricIds, 'unsupported')
    setPairStatus(raw, loafFirstUIEventMetricIds, 'unknown')
    setPairStatus(raw, loafForcedStyleLayoutMetricIds, 'not-observed')

    const decoded = decodePageProbeResult(raw, expectedActions, 2)
    const input = decoded.metrics.filter(item => item.name.startsWith('inputCaptureToNextRaf'))
    const firstUi = decoded.metrics.filter(item => item.name.startsWith('longAnimationFrameFirstUIEvent'))
    const forced = decoded.metrics.filter(item => item.name.startsWith('longAnimationFrameAttributedForced'))
    assert.ok(input.every(item => item.status === 'unsupported' && item.value === null && item.samples === null))
    assert.ok(firstUi.every(item => item.status === 'unknown' && item.value === null && item.samples === null))
    assert.equal(forced.find(item => item.stat === 'count').status, 'measured')
    assert.equal(forced.find(item => item.stat === 'count').value, 0)
    assert.equal(forced.find(item => item.stat === 'p95').status, 'not-observed')
})

test('derives partial percentiles from incomplete v2 candidates without falsifying exact valid counts', () => {
    const raw = rawResultV2()
    for (const metrics of [raw.metrics, raw.actionResults[0].metrics]) {
        const count = metrics.find(item => item.name === 'longAnimationFrameFirstUIEventToFrameEndCount')
        count.samples = 2
    }

    const decoded = decodePageProbeResult(raw, expectedActions, 2)
    const rootCount = decoded.metrics.find(item => item.name === 'longAnimationFrameFirstUIEventToFrameEndCount')
    const rootP95 = decoded.metrics.find(item => item.name === 'longAnimationFrameFirstUIEventToFrameEndMs')
    const actionP95 = decoded.actionResults[0].metrics.find(item => item.name === 'longAnimationFrameFirstUIEventToFrameEndMs')
    assert.equal(rootCount.status, 'measured')
    assert.equal(rootCount.value, 1)
    assert.equal(rootCount.samples, 2)
    assert.ok(rootCount.limitations.includes('loaf-first-ui-event-candidates-incomplete'))
    assert.equal(rootP95.status, 'partial')
    assert.equal(actionP95.status, 'partial')
})

test('rejects unexplained retained-sample loss and impossible v2 pair relationships', () => {
    const unexplainedLoss = rawResultV2()
    unexplainedLoss.metrics.find(item => item.name === 'inputCaptureToNextRafCallbackCount').value = 2
    unexplainedLoss.metrics.find(item => item.name === 'inputCaptureToNextRafCallbackCount').samples = 2
    assert.throws(() => decodePageProbeResult(unexplainedLoss, expectedActions, 2), TypeError)

    const moreValidThanCandidates = rawResultV2()
    moreValidThanCandidates.metrics.find(item => item.name === 'longAnimationFrameAttributedForcedStyleAndLayoutCount').samples = 0
    assert.throws(() => decodePageProbeResult(moreValidThanCandidates, expectedActions, 2), TypeError)

    const falseButMeasured = rawResultV2()
    falseButMeasured.capabilities.inputFrameScheduling = false
    assert.throws(() => decodePageProbeResult(falseButMeasured, expectedActions, 2), TypeError)
})

test('fails closed for non-records and unsupported fields at every trust boundary', () => {
    assert.throws(() => decodePageProbeResult(null, expectedActions), TypeError)
    assert.throws(() => decodePageProbeResult({ ...rawResult(), selector: '#private' }, expectedActions), TypeError)

    const customMetric = rawResult()
    customMetric.metrics[0].text = 'private DOM text'
    assert.throws(() => decodePageProbeResult(customMetric, expectedActions), TypeError)

    const customAction = rawResult()
    customAction.actionResults[0].dom = '<button>private</button>'
    assert.throws(() => decodePageProbeResult(customAction, expectedActions), TypeError)

    const customCapability = rawResult()
    customCapability.capabilities.frameworkOwner = true
    assert.throws(() => decodePageProbeResult(customCapability, expectedActions), TypeError)
})

test('accepts only closed catalog tuples, bounded scalars and controlled page evidence', () => {
    for (const overrides of [
        { name: 'customMetric' },
        { value: Number.NaN },
        { value: -1 },
        { value: null, status: 'measured' },
        { value: 1, status: 'unsupported' },
        { status: 'partial' },
        { evidenceLevel: 'runtime-observation' },
        { samples: 10_000_001 },
    ]) {
        const raw = rawResult()
        raw.metrics[0] = { ...raw.metrics[0], ...overrides }
        assert.throws(() => decodePageProbeResult(raw, expectedActions), TypeError)
    }

    const ratio = rawResult()
    const ratioIndex = ratio.metrics.findIndex(item => item.name === 'slowFrameRate')
    ratio.metrics[ratioIndex] = { ...ratio.metrics[ratioIndex], value: 1.01 }
    assert.throws(() => decodePageProbeResult(ratio, expectedActions), TypeError)
})

test('requires the exact root/action metric and capability contracts', () => {
    const forgedRoot = rawResult()
    forgedRoot.metrics[0] = metricForId('lighthouse.performance.score')
    assert.throws(() => decodePageProbeResult(forgedRoot, expectedActions), TypeError)

    const forgedAction = rawResult()
    forgedAction.actionResults[0].metrics[0] = metricForId('trace.script.duration')
    assert.throws(() => decodePageProbeResult(forgedAction, expectedActions), TypeError)

    const emptyRoot = rawResult()
    emptyRoot.metrics = []
    assert.throws(() => decodePageProbeResult(emptyRoot, expectedActions), TypeError)

    const missingCapability = rawResult()
    delete missingCapability.capabilities.longtask
    assert.throws(() => decodePageProbeResult(missingCapability, expectedActions), TypeError)
})

test('requires capability and producer metric statuses to agree', () => {
    const falseButMeasured = rawResult()
    falseButMeasured.capabilities.longtask = false
    assert.throws(() => decodePageProbeResult(falseButMeasured, expectedActions), TypeError)

    const coherentUnsupported = rawResult()
    coherentUnsupported.capabilities.longtask = false
    for (const metrics of [coherentUnsupported.metrics, coherentUnsupported.actionResults[0].metrics]) {
        for (const [index, item] of metrics.entries()) {
            if (item.name === 'longTaskCount' || item.name === 'longTaskDurationMs') {
                metrics[index] = { ...item, value: null, status: 'unsupported' }
            }
        }
    }
    const normalizedUnsupported = decodePageProbeResult(coherentUnsupported, expectedActions)
    assert.ok(
        normalizedUnsupported.metrics
            .filter(item => item.name === 'longTaskCount' || item.name === 'longTaskDurationMs')
            .every(item => item.status === 'unsupported' && item.evidenceLevel === 'unsupported-or-unknown')
    )

    const trueButUnsupported = rawResult()
    const index = trueButUnsupported.metrics.findIndex(item => item.name === 'LCP')
    trueButUnsupported.metrics[index] = { ...trueButUnsupported.metrics[index], value: null, status: 'unsupported' }
    assert.throws(() => decodePageProbeResult(trueButUnsupported, expectedActions), TypeError)
})

test('requires v2 LoAF field exposure and phase statuses to agree', () => {
    const missingFieldButMeasured = rawResultV2()
    missingFieldButMeasured.capabilities.loafPaintTime = false
    assert.throws(() => decodePageProbeResult(missingFieldButMeasured, expectedActions, 2), TypeError)

    const noLoafButUnknownField = rawResultV2()
    noLoafButUnknownField.capabilities.loaf = false
    noLoafButUnknownField.capabilities.loafPaintTime = null
    noLoafButUnknownField.capabilities.loafPresentationTime = null
    assert.throws(() => decodePageProbeResult(noLoafButUnknownField, expectedActions, 2), TypeError)
})

test('requires a one-to-one scenario action match and bounded monotonic clocks', () => {
    for (const mutation of [
        action => {
            action.actionId = 'forged-action'
        },
        action => {
            action.order = 1
        },
        action => {
            action.kind = 'click'
        },
        action => {
            action.startedAtMs = -1
        },
        action => {
            action.endedAtMs = 99
        },
        action => {
            action.endedAtMs = 1_001
        },
        action => {
            action.outcome = 'unknown'
        },
    ]) {
        const raw = rawResult()
        mutation(raw.actionResults[0])
        assert.throws(() => decodePageProbeResult(raw, expectedActions), TypeError)
    }

    assert.throws(() => decodePageProbeResult({ ...rawResult(), actionResults: [] }, expectedActions), TypeError)
    const duplicate = rawResult()
    duplicate.actionResults.push({ ...duplicate.actionResults[0] })
    assert.throws(() => decodePageProbeResult(duplicate, expectedActions), TypeError)
})

test('rejects oversized page-controlled collections before decoding entries', () => {
    const tooManyMetrics = rawResult()
    tooManyMetrics.metrics = Array.from({ length: 257 }, () => metric())
    assert.throws(() => decodePageProbeResult(tooManyMetrics, expectedActions), TypeError)

    const tooManyLimitations = rawResult()
    tooManyLimitations.limitations = Array.from({ length: 33 }, () => 'ignored')
    assert.throws(() => decodePageProbeResult(tooManyLimitations, expectedActions), TypeError)

    const tooManyExpectedActions = Array.from({ length: 101 }, (_, order) => ({
        actionId: `action-${order}`,
        order,
        kind: 'wait',
    }))
    assert.throws(() => decodePageProbeResult(rawResult(), tooManyExpectedActions), TypeError)

    const tooManyActionMetrics = rawResult()
    tooManyActionMetrics.actionResults[0].metrics = Array.from({ length: 33 }, (_, index) =>
        metric(index === 0 ? { stat: 'p50' } : { name: `forged-${index}` })
    )
    assert.throws(() => decodePageProbeResult(tooManyActionMetrics, expectedActions), TypeError)
})

test('accepts an empty final-document action segment after runner-observed navigation', () => {
    const raw = rawResult()
    raw.actionResults = []
    assert.deepEqual(decodePageProbeResult(raw, []).actionResults, [])
})

test('adds only a fixed truncation code when the closed dropped-sample metric is positive', () => {
    const raw = rawResult()
    const droppedIndex = raw.metrics.findIndex(item => item.name === 'droppedProbeSamples')
    raw.metrics[droppedIndex] = { ...raw.metrics[droppedIndex], value: 5 }
    raw.sampleDrops.eventTimings = 5

    const decoded = decodePageProbeResult(raw, expectedActions)
    assert.ok(decoded.limitations.includes('page-probe-samples-truncated'))
    assert.equal(decoded.limitations.includes('5 probe samples exceeded'), false)
})

test('downgrades only sample-derived metrics for the truncated stream', () => {
    const raw = rawResult()
    const droppedIndex = raw.metrics.findIndex(item => item.name === 'droppedProbeSamples')
    raw.metrics[droppedIndex] = { ...raw.metrics[droppedIndex], value: 5 }
    raw.sampleDrops.eventTimings = 5

    const decoded = decodePageProbeResult(raw, expectedActions)
    const eventP95 = decoded.metrics.find(item => item.name === 'eventTimingDurationMs')
    const eventCount = decoded.metrics.find(item => item.name === 'interactionCount')
    const frameP95 = decoded.metrics.find(item => item.name === 'frameDurationMs' && item.stat === 'p95')
    const actionInputDelay = decoded.actionResults[0].metrics.find(item => item.name === 'inputDelayMs')

    assert.equal(eventP95.status, 'partial')
    assert.ok(eventP95.limitations.includes('page-probe-event-timing-samples-truncated'))
    assert.equal(actionInputDelay.status, 'partial')
    assert.ok(actionInputDelay.limitations.includes('page-probe-event-timing-samples-truncated'))
    assert.equal(eventCount.status, 'measured')
    assert.deepEqual(eventCount.limitations, ['event-timing-duration-threshold-16ms', 'event-timing-entry-count-not-distinct-interactions'])
    assert.equal(frameP95.status, 'measured')
})

test('keeps v2 full-stream LoAF phase counts measured while retained percentiles and action phases become partial', () => {
    const raw = rawResultV2()
    const droppedIndex = raw.metrics.findIndex(item => item.name === 'droppedProbeSamples')
    raw.metrics[droppedIndex] = { ...raw.metrics[droppedIndex], value: 4 }
    raw.sampleDrops.longAnimationFrames = 4

    const decoded = decodePageProbeResult(raw, expectedActions, 2)
    const rootCount = decoded.metrics.find(item => item.name === 'longAnimationFrameRenderStartToPaintCount')
    const rootP95 = decoded.metrics.find(item => item.name === 'longAnimationFrameRenderStartToPaintMs')
    const actionCount = decoded.actionResults[0].metrics.find(item => item.name === 'longAnimationFrameRenderStartToPaintCount')
    const actionP95 = decoded.actionResults[0].metrics.find(item => item.name === 'longAnimationFrameRenderStartToPaintMs')

    assert.equal(rootCount.status, 'measured')
    assert.equal(rootP95.status, 'partial')
    assert.equal(actionCount.status, 'partial')
    assert.equal(actionP95.status, 'partial')
    assert.ok(rootP95.limitations.includes('page-probe-loaf-samples-truncated'))
})

test('tracks v2 input scheduling drops separately and leaves the completed full-stream count measured', () => {
    const raw = rawResultV2()
    const droppedIndex = raw.metrics.findIndex(item => item.name === 'droppedProbeSamples')
    raw.metrics[droppedIndex] = { ...raw.metrics[droppedIndex], value: 3 }
    raw.sampleDrops.inputFrameScheduling = 3

    const decoded = decodePageProbeResult(raw, expectedActions, 2)
    const rootCount = decoded.metrics.find(item => item.name === 'inputCaptureToNextRafCallbackCount')
    const rootP95 = decoded.metrics.find(item => item.name === 'inputCaptureToNextRafCallbackMs')
    const actionP95 = decoded.actionResults[0].metrics.find(item => item.name === 'inputCaptureToNextRafCallbackMs')
    assert.equal(rootCount.status, 'measured')
    assert.equal(rootP95.status, 'partial')
    assert.equal(actionP95.status, 'partial')
    assert.ok(rootP95.limitations.includes('page-probe-input-frame-scheduling-samples-truncated'))

    const legacy = rawResult()
    legacy.sampleDrops.inputFrameScheduling = 0
    assert.throws(() => decodePageProbeResult(legacy, expectedActions), TypeError)
})

test('preserves complete streaming totals while every truncated retained distribution becomes partial', () => {
    const contracts = [
        {
            stream: 'frames',
            partialRoot: [
                'frame.duration.p50',
                'frame.duration.p95',
                'frame.duration.p99',
                'frame.refresh.inferred',
                'frame.slow-rate',
                'frame.jank-bursts',
                'frame.longest-slow-run',
                'frame.missed-opportunities',
            ],
            measuredRoot: ['frame.target.latest'],
            partialAction: ['frame.duration.p50', 'frame.duration.p95', 'frame.duration.p99', 'frame.slow-rate', 'frame.jank-bursts'],
        },
        {
            stream: 'longTasks',
            partialRoot: ['main.long-task.duration.p95'],
            measuredRoot: ['main.long-task.count', 'main.long-task.duration.sum'],
            partialAction: ['main.long-task.count', 'main.long-task.duration.p95'],
        },
        {
            stream: 'longAnimationFrames',
            partialRoot: ['main.loaf.duration.p95', 'main.loaf.blocking.p95', 'pipeline.loaf-style-layout-tail.p95'],
            measuredRoot: ['main.loaf.count'],
            partialAction: ['main.loaf.count', 'main.loaf.duration.p95'],
        },
        {
            stream: 'eventTimings',
            partialRoot: [
                'interaction.event-duration.p95',
                'interaction.input-delay.p95',
                'interaction.processing.p95',
                'interaction.presentation.p95',
            ],
            measuredRoot: ['interaction.count'],
            partialAction: [
                'interaction.event-duration.p95',
                'interaction.input-delay.p95',
                'interaction.processing.p95',
                'interaction.presentation.p95',
            ],
        },
        {
            stream: 'resources',
            partialRoot: ['resource.duration.p95'],
            measuredRoot: ['resource.count', 'resource.transfer.sum', 'resource.encoded.sum', 'resource.decoded.sum'],
            partialAction: [],
        },
    ]

    for (const contract of contracts) {
        const raw = rawResult()
        const droppedIndex = raw.metrics.findIndex(item => item.name === 'droppedProbeSamples')
        raw.metrics[droppedIndex] = { ...raw.metrics[droppedIndex], value: 7 }
        raw.sampleDrops[contract.stream] = 7

        const decoded = decodePageProbeResult(raw, expectedActions)
        const rootById = new Map(decoded.metrics.map(item => [metricId(item), item]))
        const actionById = new Map(decoded.actionResults[0].metrics.map(item => [metricId(item), item]))
        for (const id of contract.partialRoot) assert.equal(rootById.get(id)?.status, 'partial', `${contract.stream}:${id}`)
        for (const id of contract.measuredRoot) assert.equal(rootById.get(id)?.status, 'measured', `${contract.stream}:${id}`)
        for (const id of contract.partialAction) assert.equal(actionById.get(id)?.status, 'partial', `${contract.stream}:${id}`)
    }
})

test('conservatively bounds root quality for positive timeline-history loss while preserving live action windows', () => {
    const contracts = [
        {
            stream: 'longTasks',
            limitation: 'page-probe-long-task-timeline-history-incomplete',
            partialRoot: ['main.long-task.count', 'main.long-task.duration.p95', 'main.long-task.duration.sum'],
            measuredAction: ['main.long-task.count', 'main.long-task.duration.p95'],
        },
        {
            stream: 'longAnimationFrames',
            limitation: 'page-probe-loaf-timeline-history-incomplete',
            partialRoot: ['main.loaf.count', 'main.loaf.duration.p95', 'main.loaf.blocking.p95', 'pipeline.loaf-style-layout-tail.p95'],
            measuredAction: ['main.loaf.count', 'main.loaf.duration.p95'],
        },
        {
            stream: 'eventTimings',
            limitation: 'page-probe-event-timing-timeline-history-incomplete',
            partialRoot: [...eventTimingMetricIds],
            measuredAction: eventTimingMetricIds.filter(id => id !== 'interaction.count'),
        },
        {
            stream: 'resources',
            limitation: 'page-probe-resource-timing-timeline-history-incomplete',
            partialRoot: [
                'resource.count',
                'resource.duration.p95',
                'resource.transfer.sum',
                'resource.encoded.sum',
                'resource.decoded.sum',
            ],
            measuredAction: [],
        },
        {
            stream: 'layoutShifts',
            limitation: 'page-probe-layout-shift-timeline-history-incomplete',
            partialRoot: ['vital.cls.latest'],
            measuredAction: [],
        },
        {
            stream: 'largestContentfulPaints',
            limitation: 'page-probe-lcp-timeline-history-incomplete',
            partialRoot: ['vital.lcp.latest'],
            measuredAction: [],
        },
    ]

    for (const contract of contracts) {
        const raw = withObserverDropContract(rawResult())
        raw.observerDrops[contract.stream] = 3
        const decoded = decodePageProbeResultWithObserverDrops(raw, expectedActions, 1)
        assert.equal(decoded.observerDrops[contract.stream], 3)
        assert.ok(decoded.limitations.includes(contract.limitation))
        for (const id of contract.partialRoot) {
            const item = metricForCatalogId(decoded.metrics, id)
            assert.equal(item?.status, 'partial', `${contract.stream}:${id}`)
            assert.ok(item?.limitations.includes(contract.limitation), `${contract.stream}:${id}:limitation`)
        }
        for (const id of contract.measuredAction) {
            const item = metricForCatalogId(decoded.actionResults[0].metrics, id)
            assert.equal(item?.status, 'measured', `${contract.stream}:${id}`)
            assert.equal(item?.limitations?.includes(contract.limitation) ?? false, false, `${contract.stream}:${id}:limitation`)
        }
        assert.equal(
            metricForCatalogId(decoded.metrics, 'frame.duration.p95')?.status,
            'measured',
            `${contract.stream}:unrelated frame metric`
        )
    }
})

test('conservatively bounds every v2 LoAF root phase while preserving live action windows', () => {
    const raw = withObserverDropContract(rawResultV2())
    raw.observerDrops.longAnimationFrames = 2
    const decoded = decodePageProbeResultWithObserverDrops(raw, expectedActions, 2)
    const affectedNames = [
        'longAnimationFrameCount',
        'longAnimationFrameDurationMs',
        'longAnimationFrameBlockingMs',
        'longAnimationFrameStyleLayoutTailMs',
        'longAnimationFrameRenderStartToPaintCount',
        'longAnimationFrameRenderStartToPaintMs',
        'longAnimationFramePaintToPresentationCount',
        'longAnimationFramePaintToPresentationMs',
        'longAnimationFrameFirstUIEventToFrameEndCount',
        'longAnimationFrameFirstUIEventToFrameEndMs',
        'longAnimationFrameAttributedForcedStyleAndLayoutCount',
        'longAnimationFrameAttributedForcedStyleAndLayoutMs',
    ]
    const root = decoded.metrics.filter(item => affectedNames.includes(item.name))
    const action = decoded.actionResults[0].metrics.filter(item => affectedNames.includes(item.name))

    assert.equal(root.length, affectedNames.length)
    assert.equal(action.length, affectedNames.length - 2)
    assert.ok(root.every(item => item.status === 'partial'))
    assert.ok(root.every(item => item.limitations.includes('page-probe-loaf-timeline-history-incomplete')))
    assert.ok(action.every(item => item.status === 'measured'))
    assert.ok(action.every(item => !(item.limitations ?? []).includes('page-probe-loaf-timeline-history-incomplete')))
    assert.equal(decoded.metrics.find(item => item.name === 'inputCaptureToNextRafCallbackCount')?.status, 'measured')
})

test('keeps unreported timeline-history drop counts null without fabricating zero or downgrading metrics', () => {
    const raw = withObserverDropContract(rawResult())
    raw.observerDrops.eventTimings = null
    raw.observerDropCountUnavailable.eventTimings = true
    const decoded = decodePageProbeResultWithObserverDrops(raw, expectedActions, 1)

    assert.equal(decoded.observerDrops.eventTimings, null)
    assert.equal(decoded.observerDropCountUnavailable.eventTimings, true)
    assert.equal(decoded.observerEntryDeliveryObserved.eventTimings, true)
    assert.equal(decoded.metrics.find(item => item.name === 'interactionCount')?.status, 'measured')
    assert.equal(decoded.actionResults[0].metrics.find(item => item.name === 'inputDelayMs')?.status, 'measured')
    assert.ok(decoded.limitations.includes('page-probe-event-timing-timeline-history-drop-count-unavailable'))
})

test('distinguishes a supported stream with no entry delivery from an unavailable first-callback count', () => {
    const raw = withObserverDropContract(rawResult())
    raw.observerDrops.layoutShifts = null
    raw.observerEntryDeliveryObserved.layoutShifts = false
    const rawCls = metricForCatalogId(raw.metrics, 'vital.cls.latest')
    assert.ok(rawCls)
    rawCls.value = 0
    const decoded = decodePageProbeResultWithObserverDrops(raw, expectedActions, 1)
    const cls = metricForCatalogId(decoded.metrics, 'vital.cls.latest')

    assert.equal(decoded.observerDrops.layoutShifts, null)
    assert.equal(decoded.observerDropCountUnavailable.layoutShifts, false)
    assert.equal(decoded.observerEntryDeliveryObserved.layoutShifts, false)
    assert.equal(cls?.status, 'measured')
    assert.equal(decoded.limitations.includes('page-probe-layout-shift-timeline-history-drop-count-unavailable'), false)
})

test('keeps the timeline-history drop wire opt-in while accepting legacy v1 and v2 probe payloads', () => {
    const legacyV1 = rawResult()
    const legacyV2 = rawResultV2()
    assert.deepEqual(Object.keys(decodePageProbeResult(legacyV1, expectedActions)).sort(), [
        'actionResults',
        'capabilities',
        'durationMs',
        'limitations',
        'metrics',
    ])
    assert.deepEqual(Object.keys(decodePageProbeResult(legacyV2, expectedActions, 2)).sort(), [
        'actionResults',
        'capabilities',
        'durationMs',
        'limitations',
        'metrics',
    ])
    assert.throws(() => decodePageProbeResultWithObserverDrops(legacyV1, expectedActions, 1), TypeError)

    const current = withObserverDropContract(rawResult())
    assert.throws(() => decodePageProbeResult(current, expectedActions), TypeError)
    assert.equal(decodePageProbeResultWithObserverDrops(current, expectedActions, 1).observerDrops.longTasks, 0)
})

test('preserves a known-positive lower bound when the timeline-history drop count exceeds the private wire limit', () => {
    const raw = withObserverDropContract(rawResult())
    raw.observerDrops.resources = 10_000_000
    raw.observerDropCountCapped.resources = true
    const decoded = decodePageProbeResultWithObserverDrops(raw, expectedActions, 1)
    const resourceCount = metricForCatalogId(decoded.metrics, 'resource.count')

    assert.equal(decoded.observerDrops.resources, 10_000_000)
    assert.equal(decoded.observerDropCountCapped.resources, true)
    assert.equal(resourceCount?.status, 'partial')
    assert.ok(resourceCount?.limitations.includes('page-probe-resource-timing-timeline-history-incomplete'))
    assert.ok(decoded.limitations.includes('page-probe-resource-timing-timeline-history-drop-count-capped'))
})

test('rejects forged timeline-history drop state and capability contradictions', () => {
    for (const mutation of [
        raw => {
            raw.observerDrops.longTasks = -1
        },
        raw => {
            raw.observerDrops.longTasks = 10_000_001
        },
        raw => {
            raw.observerDrops.longTasks = 1
            raw.observerDropCountUnavailable.longTasks = true
        },
        raw => {
            raw.capabilities.longtask = false
            raw.observerDrops.longTasks = 1
        },
        raw => {
            raw.capabilities.longtask = false
            raw.observerDrops.longTasks = null
            raw.observerDropCountUnavailable.longTasks = true
        },
        raw => {
            raw.observerDrops.longTasks = null
        },
        raw => {
            raw.observerEntryDeliveryObserved.longTasks = false
        },
        raw => {
            raw.observerEntryDeliveryObserved.longTasks = 'yes'
        },
        raw => {
            const longTaskCount = metricForCatalogId(raw.metrics, 'main.long-task.count')
            assert.ok(longTaskCount)
            longTaskCount.value = 0
        },
        raw => {
            raw.observerDrops.privateEntries = 1
        },
        raw => {
            raw.observerDropCountUnavailable.resources = 'yes'
        },
        raw => {
            raw.observerDropCountCapped.resources = true
        },
        raw => {
            raw.observerDrops.resources = 10_000_000
            raw.observerDropCountCapped.resources = true
            raw.observerDropCountUnavailable.resources = true
        },
    ]) {
        const raw = withObserverDropContract(rawResult())
        mutation(raw)
        assert.throws(() => decodePageProbeResultWithObserverDrops(raw, expectedActions, 1), TypeError)
    }
})

test('rejects forged or incoherent per-stream truncation metadata', () => {
    const mismatched = rawResult()
    const droppedIndex = mismatched.metrics.findIndex(item => item.name === 'droppedProbeSamples')
    mismatched.metrics[droppedIndex] = { ...mismatched.metrics[droppedIndex], value: 5 }
    mismatched.sampleDrops.resources = 4
    assert.throws(() => decodePageProbeResult(mismatched, expectedActions), TypeError)

    const unsupportedStream = rawResult()
    unsupportedStream.sampleDrops.privateDomEvents = 1
    assert.throws(() => decodePageProbeResult(unsupportedStream, expectedActions), TypeError)
})
