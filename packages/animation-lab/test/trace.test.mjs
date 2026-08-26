import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeTraceEvents } from '../build/esm/index.js'

test('builds bounded action-attributed timeline events without retaining origins or query data', () => {
    const trace = [
        { ph: 'M', name: 'thread_name', pid: 7, tid: 11, args: { name: 'CrRendererMain' } },
        { ph: 'X', name: 'condev.lab.action.hero-hover', cat: 'blink.user_timing', pid: 7, tid: 11, ts: 1_000, dur: 10_000 },
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
