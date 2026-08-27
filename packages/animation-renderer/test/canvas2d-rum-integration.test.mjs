import assert from 'node:assert/strict'
import test from 'node:test'

import {
    AnimationCollector,
    createAnimationTargetAdapterRegistry,
    toAnimationRumV2TargetReport,
} from '@condev-monitor/monitor-sdk-animation'

import { createCanvas2dRecorder } from '../build/esm/index.mjs'

class FakeRuntime {
    constructor() {
        this.isBrowser = true
        this.frameCapability = 'supported'
        this.time = 0
        this.frameCallbacks = new Set()
    }

    now() {
        return this.time
    }

    wallNow() {
        return 1_777_000_000_000 + this.time
    }

    setTime(value) {
        this.time = value
    }

    subscribeFrames(callback) {
        this.frameCallbacks.add(callback)
        return () => this.frameCallbacks.delete(callback)
    }

    getVisibilityState() {
        return 'visible'
    }

    onVisibilityChange() {
        return () => {}
    }

    getReducedMotion() {
        return false
    }

    onReducedMotionChange() {
        return () => {}
    }

    observePerformance() {
        return { state: 'supported', buffered: true, disconnect() {} }
    }
}

function createCanvasTarget() {
    return {
        tagName: 'CANVAS',
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        isConnected: true,
        width: 320,
        height: 180,
        ownerDocument: { defaultView: { innerWidth: 1_280, innerHeight: 720 } },
        getAttribute: () => null,
        getAnimations: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 320, bottom: 180, width: 320, height: 180 }),
        addEventListener() {},
        removeEventListener() {},
    }
}

function recordFrame(runtime, recorder, start, end, drawCalls) {
    runtime.setTime(start)
    assert.equal(recorder.beginFrame(), true)
    assert.equal(recorder.recordDraw('path', drawCalls), true)
    runtime.setTime(end)
    assert.equal(recorder.endFrame(), true)
}

function metric(report, metricId) {
    const value = report.metrics.find(item => item.metricId === metricId)
    assert.ok(value, `missing ${metricId}`)
    return value
}

test('Canvas2D bounded target evidence remains a partial RUM v2 renderer provider', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime, explicitRefreshHz: 60 }).start()
    const target = createCanvasTarget()
    const recorder = createCanvas2dRecorder({
        context: { canvas: target },
        frameBoundary: 'complete-canvas-frame',
        drawCallCoverage: 'complete-frame',
        maxRetainedFrames: 2,
        now: () => runtime.now(),
    })
    const registry = createAnimationTargetAdapterRegistry('canvas2d-recorder', '1.0.0')
    const unregister = registry.register(target, recorder.inspect)
    const selection = collector.selectElement(target, { adapters: [registry.adapter] })

    recordFrame(runtime, recorder, 0, 10, 1)
    recordFrame(runtime, recorder, 20, 30, 2)
    recordFrame(runtime, recorder, 40, 50, 3)

    const targetSnapshot = selection.snapshot()
    const canvasEvidence = targetSnapshot.renderers.find(renderer => renderer.family === 'canvas2d')
    assert.ok(canvasEvidence)
    assert.deepEqual(
        {
            accepted: canvasEvidence.evidence.acceptedSampleCount,
            retained: canvasEvidence.evidence.retainedSampleCount,
            dropped: canvasEvidence.evidence.droppedSampleCount,
            truncated: canvasEvidence.evidence.truncated,
        },
        { accepted: 3, retained: 2, dropped: 1, truncated: true }
    )

    const pageSnapshot = collector.stop()
    const report = toAnimationRumV2TargetReport(pageSnapshot, targetSnapshot, {
        eventId: 'event_canvas2d_partial_12345678',
        captureId: 'capture_canvas2d_partial_12345678',
        targetKey: 'main-canvas',
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
        routeKey: 'canvas.partial',
        release: 'test-1.0.0',
        environment: 'test',
        sdkVersion: '0.1.0',
    })
    const drawCalls = metric(report, 'renderer.draw-calls.p95')
    const provider = report.providerEvidence['renderer-adapter']?.renderer

    assert.equal(drawCalls.status, 'partial')
    assert.notEqual(drawCalls.status, 'unknown')
    assert.equal(drawCalls.samples, 2)
    assert.equal(provider?.accepted, 3)
    assert.equal(provider?.retained, 2)
    assert.equal(provider?.evidence, 2)
    assert.equal(provider?.dropped, 1)
    assert.equal(provider?.truncated, true)

    selection.clear()
    unregister()
    recorder.dispose()
})
