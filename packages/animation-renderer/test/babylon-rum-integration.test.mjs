import assert from 'node:assert/strict'
import test from 'node:test'

import { AnimationCollector, createRendererHostProbe, toAnimationRumV2PageReport } from '@condev-monitor/monitor-sdk-animation'

import { createBabylonRendererAdapter } from '../build/esm/index.mjs'

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

function createObservable() {
    const observers = new Set()
    return {
        add(callback) {
            const observer = { callback }
            observers.add(observer)
            return observer
        },
        remove(observer) {
            return observers.delete(observer)
        },
        emit() {
            for (const observer of Array.from(observers)) observer.callback()
        },
    }
}

function metric(report, metricId) {
    const result = report.metrics.find(item => item.metricId === metricId)
    assert.ok(result, `missing ${metricId}`)
    return result
}

test('Babylon public draw calls reach the existing closed page RUM v2 renderer metric', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime, explicitRefreshHz: 60 }).start()
    const animation = {
        createRendererProbe: options => createRendererHostProbe({ ...options, sink: collector, now: () => runtime.now() }),
    }
    const scene = {
        onAfterRenderObservable: createObservable(),
        onDisposeObservable: createObservable(),
    }
    const counter = { count: 0, current: 0 }
    const instrumentation = { scene, drawCallsCounter: counter, dispose() {} }
    const adapter = createBabylonRendererAdapter({
        animation,
        scene,
        instrumentation,
        backend: 'webgpu',
        readPerfCounterEnabled: () => true,
    })

    for (const [timestamp, drawCalls] of [
        [10, 2],
        [20, 4],
        [30, 3],
    ]) {
        runtime.time = timestamp
        counter.count += 1
        counter.current = drawCalls
        scene.onAfterRenderObservable.emit()
    }
    adapter.dispose()

    const report = toAnimationRumV2PageReport(collector.stop(), {
        eventId: 'event_babylon_adapter_12345678',
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
        routeKey: 'fixture.babylon',
        release: 'test-1.0.0',
        environment: 'test',
        sdkVersion: '0.1.0',
    })

    assert.equal(report.capabilities['renderer-adapter'], 'supported')
    assert.equal(report.capabilities['gpu-timer-query'], 'disabled')
    assert.deepEqual(metric(report, 'renderer.draw-calls.p95'), {
        metricId: 'renderer.draw-calls.p95',
        value: 3.9,
        samples: 3,
        status: 'measured',
        relation: 'adapter',
        owner: 'renderer-adapter',
    })
    assert.equal(metric(report, 'renderer.triangles.p95').value, null)
    assert.equal(metric(report, 'renderer.triangles.p95').status, 'not-observed')
    assert.equal(metric(report, 'renderer.gpu-frame.p95').value, null)
    assert.equal(metric(report, 'renderer.gpu-frame.p95').status, 'not-instrumented')
    assert.deepEqual(report.context.runtime, { framework: 'unknown', renderer: 'canvas', backend: 'webgpu' })
    assert.equal(JSON.stringify(report).includes('Babylon'), false)
    assert.equal(JSON.stringify(report).includes('scene'), false)
})
