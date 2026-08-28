import assert from 'node:assert/strict'
import test from 'node:test'

import { AnimationCollector, createRendererHostProbe, toAnimationRumV2PageReport } from '@condev-monitor/monitor-sdk-animation'

import { createThreeRendererAdapter } from '../build/esm/index.mjs'

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

function metric(report, metricId) {
    const result = report.metrics.find(item => item.metricId === metricId)
    assert.ok(result, `missing ${metricId}`)
    return result
}

test('Three adapter public counters reach the existing closed page RUM v2 renderer metrics', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime, explicitRefreshHz: 60 }).start()
    const animation = {
        createRendererProbe: options => createRendererHostProbe({ ...options, sink: collector, now: () => runtime.now() }),
        registerTarget() {
            assert.fail('page-only adapter setup must not register a target')
        },
    }
    const renderer = {
        info: {
            render: { calls: 3, triangles: 12 },
            memory: { geometries: 4, textures: 5 },
            programs: [{}, {}],
        },
        render() {},
    }
    const adapter = createThreeRendererAdapter({ animation, renderer, backend: 'webgl2' })

    for (const timestamp of [10, 20, 30]) {
        runtime.time = timestamp
        adapter.render({}, {})
    }
    adapter.dispose()

    const report = toAnimationRumV2PageReport(collector.stop(), {
        eventId: 'event_three_adapter_12345678',
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
        routeKey: 'fixture.three',
        release: 'test-1.0.0',
        environment: 'test',
        sdkVersion: '0.1.0',
    })

    assert.equal(report.capabilities['renderer-adapter'], 'supported')
    assert.equal(report.capabilities['gpu-timer-query'], 'disabled')
    assert.deepEqual(metric(report, 'renderer.draw-calls.p95'), {
        metricId: 'renderer.draw-calls.p95',
        value: 3,
        samples: 3,
        status: 'measured',
        relation: 'adapter',
        owner: 'renderer-adapter',
    })
    assert.equal(metric(report, 'renderer.triangles.p95').value, 12)
    assert.equal(metric(report, 'renderer.triangles.p95').status, 'measured')
    assert.equal(metric(report, 'renderer.gpu-frame.p95').value, null)
    assert.equal(metric(report, 'renderer.gpu-frame.p95').status, 'not-instrumented')
    assert.deepEqual(report.context.runtime, { framework: 'unknown', renderer: 'canvas', backend: 'webgl2' })
    assert.equal(JSON.stringify(report).includes('geometries'), false)
    assert.equal(JSON.stringify(report).includes('textures'), false)
    assert.equal(JSON.stringify(report).includes('programs'), false)
})
