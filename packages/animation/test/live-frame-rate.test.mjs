import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import ts from 'typescript'

// Keep the helper package-internal while still exercising its source on every
// supported Node version; its only import is type-only and is erased here.
const source = readFileSync(new URL('../src/live-frame-rate.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
    },
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
const { measureLiveFrameRate } = await import(moduleUrl)

function snapshot({
    captureId = 'animation-capture',
    state = 'running',
    capturedAt = 1_000,
    totalObservedCount = 60,
    visibility = 'visible',
    transitionCount = 0,
} = {}) {
    return {
        captureId,
        state,
        capturedAt,
        frames: { totalObservedCount },
        visibility: { current: visibility, transitionCount },
    }
}

test('live frame rate measures the actual interval between compatible snapshots', () => {
    const previous = snapshot({ capturedAt: 1_000, totalObservedCount: 100 })
    const current = snapshot({ capturedAt: 2_000, totalObservedCount: 160 })

    assert.deepEqual(measureLiveFrameRate(previous, current), {
        status: 'measured',
        framesPerSecond: 60,
        windowMs: 1_000,
        callbackCount: 60,
    })

    assert.deepEqual(measureLiveFrameRate(previous, snapshot({ capturedAt: 2_500, totalObservedCount: 130 })), {
        status: 'measured',
        framesPerSecond: 20,
        windowMs: 1_500,
        callbackCount: 30,
    })

    assert.deepEqual(measureLiveFrameRate(previous, snapshot({ capturedAt: 2_000, totalObservedCount: 220 })), {
        status: 'measured',
        framesPerSecond: 120,
        windowMs: 1_000,
        callbackCount: 120,
    })
})

test('live frame rate collects a new baseline after missing or incompatible history', () => {
    const current = snapshot({ capturedAt: 2_000, totalObservedCount: 160 })

    assert.deepEqual(measureLiveFrameRate(undefined, current), { status: 'collecting' })
    assert.deepEqual(measureLiveFrameRate(snapshot({ captureId: 'old-capture' }), current), { status: 'collecting' })
    assert.deepEqual(measureLiveFrameRate(snapshot({ capturedAt: 1_000, totalObservedCount: 100, transitionCount: 1 }), current), {
        status: 'collecting',
    })
    assert.deepEqual(measureLiveFrameRate(snapshot({ state: 'stopped' }), current), { status: 'collecting' })
    assert.deepEqual(measureLiveFrameRate(snapshot({ visibility: 'hidden' }), current), { status: 'collecting' })
    assert.deepEqual(measureLiveFrameRate(current, current), { status: 'collecting' })
})

test('live frame rate keeps unavailable data distinct from a measured zero', () => {
    const previous = snapshot({ capturedAt: 1_000, totalObservedCount: 100 })

    assert.deepEqual(measureLiveFrameRate(previous, snapshot({ capturedAt: 2_000, totalObservedCount: 100 })), {
        status: 'measured',
        framesPerSecond: 0,
        windowMs: 1_000,
        callbackCount: 0,
    })
    assert.deepEqual(measureLiveFrameRate(previous, snapshot({ state: 'stopped' })), { status: 'not-observed' })
    assert.deepEqual(measureLiveFrameRate(previous, snapshot({ visibility: 'hidden' })), { status: 'not-observed' })
    assert.deepEqual(measureLiveFrameRate(previous, snapshot({ captureId: '' })), { status: 'not-observed' })
    assert.deepEqual(measureLiveFrameRate(previous, snapshot({ capturedAt: Number.NaN })), { status: 'not-observed' })
    assert.deepEqual(measureLiveFrameRate(previous, snapshot({ capturedAt: -1 })), { status: 'not-observed' })
    assert.deepEqual(measureLiveFrameRate(previous, snapshot({ transitionCount: Number.NaN })), { status: 'not-observed' })
    assert.deepEqual(measureLiveFrameRate(previous, snapshot({ capturedAt: 2_000, totalObservedCount: 1_000_000_000 })), {
        status: 'not-observed',
    })
    assert.deepEqual(measureLiveFrameRate(previous, snapshot({ capturedAt: 2_000, totalObservedCount: 99 })), { status: 'not-observed' })
    assert.deepEqual(measureLiveFrameRate(previous, snapshot({ capturedAt: 500, totalObservedCount: 110 })), { status: 'not-observed' })
})
