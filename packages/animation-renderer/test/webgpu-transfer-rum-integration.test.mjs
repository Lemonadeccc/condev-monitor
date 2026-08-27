import assert from 'node:assert/strict'
import test from 'node:test'

import {
    AnimationCollector,
    createAnimationTargetAdapterRegistry,
    toAnimationRumV2TargetReport,
} from '@condev-monitor/monitor-sdk-animation'

import { createWebGpuTransferRecorder } from '../build/esm/index.mjs'

class FakeRuntime {
    constructor() {
        this.isBrowser = true
        this.frameCapability = 'supported'
        this.time = 0
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

    subscribeFrames() {
        return () => {}
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

function report(runtime, pageSnapshot, targetSnapshot, suffix) {
    return toAnimationRumV2TargetReport(pageSnapshot, targetSnapshot, {
        eventId: `event_webgpu_transfer_${suffix}_12345678`,
        captureId: `capture_webgpu_transfer_${suffix}_12345678`,
        targetKey: 'main-canvas',
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
        routeKey: 'webgpu.transfer',
        release: 'test-1.0.0',
        environment: 'test',
        sdkVersion: '0.1.0',
    })
}

test('WebGPU transfer evidence stays local without changing the RUM baseline', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime, explicitRefreshHz: 60 }).start()
    const target = createCanvasTarget()
    const recorder = createWebGpuTransferRecorder({
        device: { lost: new Promise(() => {}) },
        now: () => runtime.now(),
    })
    const registry = createAnimationTargetAdapterRegistry('webgpu-transfer-recorder', '1.0.0')
    const unregister = registry.register(target, recorder.inspect)
    const purposes = []
    const rumSafeAdapter = {
        id: 'rum-safe-adapter',
        version: '1.0.0',
        canInspect: element => element === target,
        inspect(_element, context) {
            purposes.push(context.inspectionPurpose)
            return { inventory: { motionEngines: ['gsap'] } }
        },
    }
    const localSelection = collector.selectElement(target, { adapters: [registry.adapter, rumSafeAdapter] })
    const rumSelection = collector.selectElement(target, {
        inspectionPurpose: 'rum',
        adapters: [registry.adapter, rumSafeAdapter],
    })
    const baselineSelection = collector.selectElement(target, {
        inspectionPurpose: 'rum',
        adapters: [rumSafeAdapter],
    })

    runtime.setTime(1)
    recorder.measureUpload({ kind: 'queue-write-buffer', bytes: 64 }, () => runtime.setTime(2))
    runtime.setTime(3)
    const localSnapshot = localSelection.snapshot()
    const rumSnapshot = rumSelection.snapshot()
    const baselineSnapshot = baselineSelection.snapshot()

    assert.ok(localSnapshot.renderers.some(renderer => renderer.family === 'webgpu'))
    assert.equal(
        rumSnapshot.renderers.some(renderer => renderer.family === 'webgpu'),
        false
    )
    assert.ok(rumSnapshot.inventory.motionEngines.includes('gsap'))
    assert.deepEqual(rumSnapshot.inventory, baselineSnapshot.inventory)
    assert.deepEqual(rumSnapshot.owners, baselineSnapshot.owners)
    assert.deepEqual(rumSnapshot.renderers, baselineSnapshot.renderers)
    assert.deepEqual(rumSnapshot.adapterErrors, baselineSnapshot.adapterErrors)
    assert.deepEqual(purposes, ['local', 'rum', 'rum'])

    const pageSnapshot = collector.stop()
    const withTransfer = report(runtime, pageSnapshot, rumSnapshot, 'guarded')
    const baseline = report(runtime, pageSnapshot, baselineSnapshot, 'baseline')
    assert.deepEqual(withTransfer.capabilities, baseline.capabilities)
    assert.deepEqual(withTransfer.providerEvidence, baseline.providerEvidence)
    assert.deepEqual(withTransfer.metrics, baseline.metrics)

    localSelection.clear()
    rumSelection.clear()
    baselineSelection.clear()
    unregister()
    recorder.dispose()
})
