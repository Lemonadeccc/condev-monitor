import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeTraceEvents } from '../build/esm/index.js'

function actionMark(label, phase, ts, pid = 7, tid = 11, navigationId = 'document-fixture') {
    return {
        ph: 'I',
        name: `condev.lab.action.${label}.${phase}`,
        cat: 'blink.user_timing',
        pid,
        tid,
        ts,
        args: { data: { navigationId } },
    }
}

test('builds bounded action-attributed timeline events without retaining origins or query data', () => {
    const trace = [
        { ph: 'M', name: 'thread_name', pid: 7, tid: 11, args: { name: 'CrRendererMain' } },
        actionMark('hero-hover', 'start', 1_000),
        { ph: 'X', name: 'condev.lab.action.hero-hover', cat: 'blink.user_timing', pid: 7, tid: 11, ts: 1_000, dur: 10_000 },
        actionMark('hero-hover', 'end', 11_000),
        {
            ph: 'X',
            name: 'FunctionCall',
            cat: 'devtools.timeline',
            pid: 7,
            tid: 11,
            ts: 2_000,
            dur: 4_000,
            args: {
                data: {
                    stackTrace: [
                        {
                            functionName: 'animateHero',
                            url: 'https://secret.example/users/person@example.com/app.js?access_token=private#fragment',
                            lineNumber: 12,
                            columnNumber: 4,
                        },
                    ],
                },
            },
        },
        { ph: 'X', name: 'Paint', cat: 'devtools.timeline', pid: 7, tid: 11, ts: 7_000, dur: 2_000 },
    ]
    for (let index = 0; index < 1_100; index += 1) {
        trace.push({ ph: 'X', name: 'RunTask', cat: 'devtools.timeline', pid: 7, tid: 11, ts: 20_000 + index * 2_000, dur: 1_000 })
    }

    const result = normalizeTraceEvents(trace, { maxRetainedEvents: 1_000 })
    assert.equal(result.retainedEvents, 1_000)
    assert.equal(result.droppedEvents, 103)
    assert.equal(result.totalInputEvents, trace.length)
    assert.equal(
        result.events.some(event => event.name === 'condev.lab.action.hero-hover'),
        true
    )

    const script = result.events.find(event => event.name === 'FunctionCall')
    assert.equal(script.actionLabel, 'hero-hover')
    assert.equal(script.thread, 'main')
    assert.equal(script.stack[0].source, '/users/:redacted/app.js')
    assert.equal(script.stack[0].source.includes('secret.example'), false)
    assert.equal(script.stack[0].source.includes('access_token'), false)
    assert.equal(result.categoryDurationMs.script, 1_104)
    assert.equal(result.categoryDurationMs.paint, 2)
})

test('reports empty traces as explicit empty bounded chunks', () => {
    assert.deepEqual(normalizeTraceEvents([]), {
        schemaVersion: 1,
        startMs: 0,
        endMs: 0,
        totalInputEvents: 0,
        retainedEvents: 0,
        droppedEvents: 0,
        events: [],
        categoryDurationMs: {
            interaction: 0,
            script: 0,
            'style-layout': 0,
            paint: 0,
            composite: 0,
            'raster-gpu': 0,
            network: 0,
            animation: 0,
            gc: 0,
            other: 0,
        },
    })
})

test('uses emitted complete events as the clock origin when Chrome metadata has ts zero', () => {
    const monotonicOriginUs = 2_190_123_456_000
    const result = normalizeTraceEvents([
        { ph: 'M', name: 'process_name', pid: 7, tid: 0, ts: 0, args: { name: 'Renderer' } },
        { ph: 'M', name: 'thread_name', pid: 7, tid: 11, ts: 0, args: { name: 'CrRendererMain' } },
        { ph: 'I', name: 'TracingStartedInBrowser', pid: 7, tid: 11, ts: 0 },
        { ph: 'X', name: 'FunctionCall', cat: 'devtools.timeline', pid: 7, tid: 11, ts: monotonicOriginUs, dur: 4_000 },
        { ph: 'Complete', name: 'Paint', cat: 'devtools.timeline', pid: 7, tid: 11, ts: monotonicOriginUs + 8_000, dur: 2_000 },
    ])

    assert.equal(result.startMs, 0)
    assert.equal(result.endMs, 10)
    assert.deepEqual(
        result.events.map(event => ({ name: event.name, startMs: event.startMs, durationMs: event.durationMs, thread: event.thread })),
        [
            { name: 'FunctionCall', startMs: 0, durationMs: 4, thread: 'main' },
            { name: 'Paint', startMs: 8, durationMs: 2, thread: 'main' },
        ]
    )
})

test('returns bounded empty output when input has no emit-eligible complete events', () => {
    const result = normalizeTraceEvents([
        { ph: 'M', name: 'thread_name', pid: 7, tid: 11, ts: 0, args: { name: 'CrRendererMain' } },
        { ph: 'B', name: 'FunctionCall', pid: 7, tid: 11, ts: 2_190_123_456_000 },
        { ph: 'X', name: 'missing-duration', pid: 7, tid: 11, ts: 2_190_123_457_000 },
        { ph: 'X', name: 'negative-duration', pid: 7, tid: 11, ts: 2_190_123_458_000, dur: -1 },
        { ph: 'X', name: 'zero-duration', pid: 7, tid: 11, ts: 2_190_123_459_000, dur: 0 },
        { ph: 'X', name: 'non-finite-timestamp', pid: 7, tid: 11, ts: Number.POSITIVE_INFINITY, dur: 1_000 },
    ])

    assert.equal(result.startMs, 0)
    assert.equal(result.endMs, 0)
    assert.equal(result.totalInputEvents, 6)
    assert.equal(result.retainedEvents, 0)
    assert.equal(result.droppedEvents, 0)
    assert.deepEqual(result.events, [])
})

test('builds mutually exclusive per-thread action phase summaries before event retention is truncated', () => {
    const trace = [
        { ph: 'M', name: 'thread_name', pid: 7, tid: 11, args: { name: 'CrRendererMain' } },
        { ph: 'M', name: 'thread_name', pid: 7, tid: 12, args: { name: 'DedicatedWorker thread' } },
        actionMark('hero-hover', 'start', 1_000),
        { ph: 'X', name: 'condev.lab.action.hero-hover', cat: 'blink.user_timing', pid: 7, tid: 11, ts: 1_000, dur: 10_000 },
        actionMark('hero-hover', 'end', 11_000),
        { ph: 'X', name: 'RunTask', cat: 'devtools.timeline', pid: 7, tid: 11, ts: 1_000, dur: 10_000 },
        { ph: 'X', name: 'FunctionCall', cat: 'devtools.timeline', pid: 7, tid: 11, ts: 2_000, dur: 8_000 },
        { ph: 'X', name: 'Layout', cat: 'devtools.timeline', pid: 7, tid: 11, ts: 4_000, dur: 2_000 },
        { ph: 'X', name: 'Paint', cat: 'devtools.timeline', pid: 7, tid: 11, ts: 7_000, dur: 2_000 },
        { ph: 'X', name: 'Animation', cat: 'animation', pid: 7, tid: 12, ts: 3_000, dur: 5_000 },
    ]
    for (let index = 0; index < 1_100; index += 1) {
        trace.push({ ph: 'X', name: 'RunTask', cat: 'devtools.timeline', pid: 7, tid: 11, ts: 20_000 + index * 2_000, dur: 1_000 })
    }

    const result = normalizeTraceEvents(trace, {
        maxRetainedEvents: 1_000,
        actionIdentities: [{ actionId: 'action-hero', actionLabel: 'hero-hover' }],
    })

    assert.equal(result.schemaVersion, 2)
    assert.equal(result.retainedEvents, 1_000)
    assert.deepEqual(result.actionPhaseSummaries, [
        {
            actionId: 'action-hero',
            actionLabel: 'hero-hover',
            startMs: 0,
            endMs: 10,
            wallTimeMs: 10,
            status: 'measured',
            eventCount: 5,
            classifiedThreadTimeMs: 15,
            threads: [
                {
                    threadId: 'thread-0',
                    thread: 'main',
                    classifiedSelfTimeMs: 10,
                    phases: {
                        script: 6,
                        'style-layout': 2,
                        paint: 2,
                        composite: 0,
                        'raster-gpu': 0,
                        animation: 0,
                        gc: 0,
                        other: 0,
                    },
                },
                {
                    threadId: 'thread-1',
                    thread: 'worker',
                    classifiedSelfTimeMs: 5,
                    phases: {
                        script: 0,
                        'style-layout': 0,
                        paint: 0,
                        composite: 0,
                        'raster-gpu': 0,
                        animation: 5,
                        gc: 0,
                        other: 0,
                    },
                },
            ],
            limitations: ['trace-action-classification-is-correlative', 'trace-action-cross-thread-total-may-exceed-wall-time'],
        },
    ])
})

test('marks crossing phase intervals as partial and clips them to the action window', () => {
    const result = normalizeTraceEvents(
        [
            { ph: 'M', name: 'thread_name', pid: 1, tid: 2, args: { name: 'CrRendererMain' } },
            actionMark('crossing', 'start', 1_000, 1, 2),
            { ph: 'X', name: 'condev.lab.action.crossing', cat: 'blink.user_timing', pid: 1, tid: 2, ts: 1_000, dur: 8_000 },
            actionMark('crossing', 'end', 9_000, 1, 2),
            { ph: 'X', name: 'RunTask', cat: 'devtools.timeline', pid: 1, tid: 2, ts: 0, dur: 7_000 },
            { ph: 'X', name: 'Paint', cat: 'devtools.timeline', pid: 1, tid: 2, ts: 5_000, dur: 6_000 },
        ],
        { actionIdentities: [{ actionId: 'crossing-action', actionLabel: 'crossing' }] }
    )

    const summary = result.actionPhaseSummaries[0]
    assert.equal(summary.status, 'partial')
    assert.equal(summary.startMs, 1)
    assert.equal(summary.endMs, 9)
    assert.equal(summary.classifiedThreadTimeMs, 8)
    assert.equal(summary.threads[0].phases.script, 4)
    assert.equal(summary.threads[0].phases.paint, 4)
    assert.ok(summary.limitations.includes('trace-action-non-laminar-overlap'))
})

test('keeps missing and ambiguous action markers explicit instead of reporting measured zero', () => {
    const result = normalizeTraceEvents(
        [
            actionMark('duplicate', 'start', 1_000, 1, 2),
            { ph: 'X', name: 'condev.lab.action.duplicate', cat: 'blink.user_timing', pid: 1, tid: 2, ts: 1_000, dur: 1_000 },
            actionMark('duplicate', 'end', 2_000, 1, 2),
            actionMark('duplicate', 'start', 3_000, 1, 2),
            { ph: 'X', name: 'condev.lab.action.duplicate', cat: 'blink.user_timing', pid: 1, tid: 2, ts: 3_000, dur: 1_000 },
            actionMark('duplicate', 'end', 4_000, 1, 2),
        ],
        {
            actionIdentities: [
                { actionId: 'missing-action', actionLabel: 'missing' },
                { actionId: 'duplicate-action', actionLabel: 'duplicate' },
            ],
        }
    )

    assert.deepEqual(result.actionPhaseSummaries, [
        {
            actionId: 'missing-action',
            actionLabel: 'missing',
            startMs: null,
            endMs: null,
            wallTimeMs: null,
            status: 'not-observed',
            eventCount: 0,
            classifiedThreadTimeMs: null,
            threads: [],
            limitations: ['trace-action-marker-not-observed'],
        },
        {
            actionId: 'duplicate-action',
            actionLabel: 'duplicate',
            startMs: null,
            endMs: null,
            wallTimeMs: null,
            status: 'partial',
            eventCount: 0,
            classifiedThreadTimeMs: null,
            threads: [],
            limitations: ['trace-action-marker-ambiguous'],
        },
    ])
})

test('pairs real Chromium user-timing b/e measures only with exact same-document companions', () => {
    const instant = (label, phase, ts, navigationId, overrides = {}) => ({
        ph: 'I',
        name: `condev.lab.action.${label}.${phase}`,
        cat: 'blink.user_timing',
        pid: 7,
        tid: 11,
        ts,
        args: { data: { navigationId, privateValue: 'must-not-be-retained' } },
        ...overrides,
    })
    const begin = (label, ts, id, overrides = {}) => ({
        ph: 'b',
        name: `condev.lab.action.${label}`,
        cat: 'blink.user_timing',
        pid: 7,
        tid: 11,
        ts,
        id2: { local: id },
        scope: 'renderer',
        args: { privateValue: 'must-not-be-retained' },
        ...overrides,
    })
    const end = (label, ts, id, overrides = {}) => ({
        ph: 'e',
        name: `condev.lab.action.${label}`,
        cat: 'blink.user_timing',
        pid: 7,
        tid: 11,
        ts,
        id2: { local: id },
        scope: 'renderer',
        args: { privateValue: 'must-not-be-retained' },
        ...overrides,
    })
    const trace = [
        { ph: 'M', name: 'thread_name', pid: 7, tid: 11, args: { name: 'CrRendererMain' } },
        instant('valid', 'start', 1_000, 'document-a'),
        begin('valid', 1_000, '0x1'),
        { ph: 'X', name: 'condev.lab.action.valid', cat: 'blink.user_timing', pid: 7, tid: 11, ts: 1_000, dur: 1_000 },
        { ph: 'X', name: 'FunctionCall', cat: 'devtools.timeline', pid: 7, tid: 11, ts: 1_100, dur: 700 },
        instant('valid', 'end', 2_000, 'document-a'),
        end('valid', 2_000, '0x1'),
        instant('cross-document', 'start', 3_000, 'document-a'),
        begin('cross-document', 3_000, '0x2'),
        instant('cross-document', 'end', 4_000, 'document-b'),
        end('cross-document', 4_000, '0x2'),
        instant('cross-thread', 'start', 5_000, 'document-a'),
        begin('cross-thread', 5_000, '0x3'),
        instant('cross-thread', 'end', 6_000, 'document-a', { tid: 12 }),
        end('cross-thread', 6_000, '0x3', { tid: 12 }),
        instant('duplicate', 'start', 7_000, 'document-a'),
        begin('duplicate', 7_000, '0x4'),
        begin('duplicate', 7_000, '0x4'),
        { ph: 'X', name: 'condev.lab.action.duplicate', cat: 'blink.user_timing', pid: 7, tid: 11, ts: 7_000, dur: 1_000 },
        instant('duplicate', 'end', 8_000, 'document-a'),
        end('duplicate', 8_000, '0x4'),
        instant('negative', 'start', 10_000, 'document-a'),
        begin('negative', 10_000, '0x5'),
        instant('negative', 'end', 9_000, 'document-a'),
        end('negative', 9_000, '0x5'),
        begin('missing-companion', 11_000, '0x6'),
        end('missing-companion', 12_000, '0x6'),
        instant('duplicate-companion', 'start', 13_000, 'document-a'),
        instant('duplicate-companion', 'start', 13_000, 'document-a'),
        begin('duplicate-companion', 13_000, '0x7'),
        instant('duplicate-companion', 'end', 14_000, 'document-a'),
        end('duplicate-companion', 14_000, '0x7'),
        instant('duplicate-complete', 'start', 15_000, 'document-a'),
        { ph: 'X', name: 'condev.lab.action.duplicate-complete', cat: 'blink.user_timing', pid: 7, tid: 11, ts: 15_000, dur: 1_000 },
        { ph: 'X', name: 'condev.lab.action.duplicate-complete', cat: 'blink.user_timing', pid: 7, tid: 11, ts: 15_000, dur: 1_000 },
        instant('duplicate-complete', 'end', 16_000, 'document-a'),
        instant('shared-companion', 'start', 17_000, 'document-a'),
        begin('shared-companion', 17_000, '0x8'),
        begin('shared-companion', 17_000, '0x9'),
        instant('shared-companion', 'end', 18_000, 'document-a'),
        end('shared-companion', 18_000, '0x8'),
        end('shared-companion', 18_000, '0x9'),
        {
            ph: 'X',
            name: 'condev.lab.action.untrusted-complete',
            cat: 'untrusted.category',
            pid: 7,
            tid: 11,
            ts: 19_000,
            dur: 1_000,
        },
    ]
    const actionIdentities = [
        'valid',
        'cross-document',
        'cross-thread',
        'duplicate',
        'negative',
        'missing-companion',
        'duplicate-companion',
        'duplicate-complete',
        'shared-companion',
        'untrusted-complete',
    ].map(label => ({
        actionId: `action-${label}`,
        actionLabel: label,
    }))

    const result = normalizeTraceEvents(trace, { actionIdentities })

    const summariesByLabel = new Map(result.actionPhaseSummaries.map(summary => [summary.actionLabel, summary]))
    assert.equal(summariesByLabel.get('valid').startMs, 0)
    assert.equal(summariesByLabel.get('valid').endMs, 1)
    assert.equal(summariesByLabel.get('valid').status, 'measured')
    for (const label of ['cross-document', 'cross-thread', 'negative', 'missing-companion', 'duplicate-companion', 'untrusted-complete']) {
        const summary = summariesByLabel.get(label)
        assert.equal(summary.startMs, null, summary.actionLabel)
        assert.ok(summary.limitations.includes('trace-action-marker-not-observed'), summary.actionLabel)
    }
    for (const label of ['duplicate', 'duplicate-complete', 'shared-companion']) {
        const summary = summariesByLabel.get(label)
        assert.equal(summary.startMs, null, summary.actionLabel)
        assert.deepEqual(summary.limitations, ['trace-action-marker-ambiguous'], summary.actionLabel)
    }
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes('document-a'), false)
    assert.equal(serialized.includes('document-b'), false)
    assert.equal(serialized.includes('must-not-be-retained'), false)
    assert.equal(serialized.includes('0x1'), false)
})

test('pre-indexes the legal 128-action boundary over a large trace without repeatedly scanning every action', () => {
    const actionIdentities = Array.from({ length: 128 }, (_, index) => ({
        actionId: `action-${index}`,
        actionLabel: `action-${index}`,
    }))
    const actionWindows = actionIdentities.map((identity, index) => ({
        label: identity.actionLabel,
        startMs: index * 10,
        endMs: index * 10 + 10,
    }))
    const trace = [{ ph: 'M', name: 'thread_name', pid: 1, tid: 2, args: { name: 'CrRendererMain' } }]
    for (let index = 0; index < 64_000; index += 1) {
        const actionIndex = index % actionIdentities.length
        trace.push({
            ph: 'X',
            name: 'FunctionCall',
            cat: 'devtools.timeline',
            pid: 1,
            tid: 2,
            ts: actionIndex * 10_000 + (index % 10) * 100,
            dur: 50,
        })
    }

    const result = normalizeTraceEvents(trace, { actionIdentities, actionWindows, maxRetainedEvents: 1_000 })

    assert.equal(result.actionPhaseSummaries.length, 128)
    assert.equal(
        result.actionPhaseSummaries.reduce((total, summary) => total + summary.eventCount, 0),
        64_000
    )
    assert.equal(
        result.actionPhaseSummaries.every(summary => summary.status === 'measured'),
        true
    )
    assert.throws(
        () => normalizeTraceEvents([], { actionIdentities: [...actionIdentities, { actionId: 'overflow', actionLabel: 'overflow' }] }),
        /exceed 128/u
    )
})

test('rejects overlapping action windows before expanding event-to-window associations', () => {
    const actionIdentities = Array.from({ length: 128 }, (_, index) => ({
        actionId: `overlap-action-${index}`,
        actionLabel: `overlap-action-${index}`,
    }))
    const actionWindows = actionIdentities.map(identity => ({
        label: identity.actionLabel,
        startMs: 0,
        endMs: 100,
    }))
    const trace = Array.from({ length: 20_000 }, (_, index) => ({
        ph: 'X',
        name: 'FunctionCall',
        cat: 'devtools.timeline',
        pid: 1,
        tid: 2,
        ts: index,
        dur: 100,
    }))

    assert.throws(() => normalizeTraceEvents(trace, { actionIdentities, actionWindows }), /trace action windows must not overlap/u)
})

test('bounds large action thread breakdowns without hiding that the retained total is partial', () => {
    const trace = [
        { ph: 'M', name: 'thread_name', pid: 1, tid: 0, args: { name: 'CrRendererMain' } },
        actionMark('many-threads', 'start', 1_000, 1, 0),
        { ph: 'X', name: 'condev.lab.action.many-threads', cat: 'blink.user_timing', pid: 1, tid: 0, ts: 1_000, dur: 2_000 },
        actionMark('many-threads', 'end', 3_000, 1, 0),
    ]
    for (let index = 1; index <= 65; index += 1) {
        trace.push(
            { ph: 'M', name: 'thread_name', pid: 1, tid: index, args: { name: 'DedicatedWorker thread' } },
            { ph: 'X', name: 'FunctionCall', cat: 'devtools.timeline', pid: 1, tid: index, ts: 1_000, dur: 1_000 }
        )
    }

    const summary = normalizeTraceEvents(trace, {
        actionIdentities: [{ actionId: 'many-threads-action', actionLabel: 'many-threads' }],
    }).actionPhaseSummaries[0]

    assert.equal(summary.status, 'partial')
    assert.equal(summary.eventCount, 65)
    assert.equal(summary.threads.length, 64)
    assert.equal(summary.classifiedThreadTimeMs, 64)
    assert.ok(summary.limitations.includes('trace-action-thread-breakdown-truncated'))
    assert.ok(summary.limitations.includes('trace-action-cross-thread-total-may-exceed-wall-time'))
    assert.equal(new Set(summary.threads.map(thread => thread.threadId)).size, 64)
})
