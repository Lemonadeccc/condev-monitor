import assert from 'node:assert/strict'
import test from 'node:test'

import { ANIMATION_LAB_METRIC_CATALOG_V1 } from '@condev-monitor/animation-lab'

import {
    decodePageProbeResult,
    PAGE_PROBE_ACTION_METRIC_IDS,
    PAGE_PROBE_CAPABILITY_KEYS,
    PAGE_PROBE_ROOT_METRIC_IDS,
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

const catalogById = new Map(ANIMATION_LAB_METRIC_CATALOG_V1.map(entry => [entry.metricId, entry]))
const catalogIdByTuple = new Map(
    ANIMATION_LAB_METRIC_CATALOG_V1.map(entry => [[entry.family, entry.name, entry.stat, entry.unit].join('|'), entry.metricId])
)

function metricId(metric) {
    return catalogIdByTuple.get([metric.family, metric.name, metric.stat, metric.unit].join('|'))
}

function metricForId(metricId, overrides = {}) {
    const entry = catalogById.get(metricId)
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

test('rebuilds a catalog-only probe result and replaces page limitations with runner codes', () => {
    const raw = rawResult()
    const decoded = decodePageProbeResult(raw, expectedActions)

    assert.deepEqual(decoded.metrics, raw.metrics)
    assert.equal(decoded.actionResults.length, 1)
    assert.deepEqual(decoded.actionResults[0].metrics, raw.actionResults[0].metrics)
    assert.deepEqual(decoded.capabilities, raw.capabilities)
    assert.ok(decoded.limitations.every(value => /^[a-z0-9-]+$/.test(value)))
    assert.equal(JSON.stringify(decoded).includes('private page prose'), false)
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
    assert.doesNotThrow(() => decodePageProbeResult(coherentUnsupported, expectedActions))

    const trueButUnsupported = rawResult()
    const index = trueButUnsupported.metrics.findIndex(item => item.name === 'LCP')
    trueButUnsupported.metrics[index] = { ...trueButUnsupported.metrics[index], value: null, status: 'unsupported' }
    assert.throws(() => decodePageProbeResult(trueButUnsupported, expectedActions), TypeError)
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
    assert.equal(eventCount.limitations, undefined)
    assert.equal(frameP95.status, 'measured')
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
