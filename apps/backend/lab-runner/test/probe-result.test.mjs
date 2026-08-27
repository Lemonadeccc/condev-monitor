import assert from 'node:assert/strict'
import test from 'node:test'

import { ANIMATION_LAB_METRIC_CATALOG_V1, ANIMATION_LAB_METRIC_CATALOG_V2 } from '@condev-monitor/animation-lab'

import {
    decodePageProbeResult,
    PAGE_PROBE_ACTION_METRIC_IDS,
    PAGE_PROBE_ACTION_METRIC_IDS_V2,
    PAGE_PROBE_CAPABILITY_KEYS,
    PAGE_PROBE_CAPABILITY_KEYS_V2,
    PAGE_PROBE_ROOT_METRIC_IDS,
    PAGE_PROBE_ROOT_METRIC_IDS_V2,
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

const catalogByIdV2 = new Map(ANIMATION_LAB_METRIC_CATALOG_V2.map(entry => [entry.metricId, entry]))
const catalogIdByTuple = new Map(
    ANIMATION_LAB_METRIC_CATALOG_V1.map(entry => [[entry.family, entry.name, entry.stat, entry.unit].join('|'), entry.metricId])
)

function metricId(metric) {
    return catalogIdByTuple.get([metric.family, metric.name, metric.stat, metric.unit].join('|'))
}

function metricForId(metricId, overrides = {}) {
    const entry = catalogByIdV2.get(metricId)
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
