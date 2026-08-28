import assert from 'node:assert/strict'
import test from 'node:test'

import { BabylonRendererAdapterOptionsError, createBabylonRendererAdapter } from '../build/esm/index.mjs'

const readEnabledPerfCounter = () => true

function createObservable(options = {}) {
    const observers = new Set()
    return {
        add(callback) {
            if (options.addError) throw options.addError
            const observer = { callback }
            observers.add(observer)
            if (options.callOnAdd) callback()
            return observer
        },
        remove(observer) {
            if (options.removeError) throw options.removeError
            return observers.delete(observer)
        },
        emit() {
            for (const observer of Array.from(observers)) observer.callback()
        },
        size() {
            return observers.size
        },
    }
}

function createScene() {
    return {
        onAfterRenderObservable: createObservable(),
        onDisposeObservable: createObservable(),
        get render() {
            throw new Error('adapter must not inspect or invoke scene render')
        },
    }
}

function createInstrumentation(scene, counter = { count: 0, current: 0 }) {
    let disposeCount = 0
    return {
        scene,
        drawCallsCounter: counter,
        dispose() {
            disposeCount += 1
        },
        disposeCount: () => disposeCount,
    }
}

function createAnimationPort() {
    const readings = []
    let probeDisposeCount = 0
    let captureAttempts = 0
    return {
        animation: {
            createRendererProbe(options) {
                assert.ok(['webgl', 'webgl2', 'webgpu'].includes(options.backend))
                return {
                    capture() {
                        captureAttempts += 1
                        const reading = options.read()
                        if (reading) readings.push(reading)
                        return reading
                    },
                    dispose() {
                        probeDisposeCount += 1
                    },
                }
            },
        },
        readings,
        captureAttempts: () => captureAttempts,
        probeDisposeCount: () => probeDisposeCount,
    }
}

test('Babylon adapter passively captures completed public draw-call counter frames', () => {
    const scene = createScene()
    const counter = { count: 0, current: 0 }
    const instrumentation = createInstrumentation(scene, counter)
    const port = createAnimationPort()
    const adapter = createBabylonRendererAdapter({
        animation: port.animation,
        scene,
        instrumentation,
        backend: 'webgl2',
        readPerfCounterEnabled: readEnabledPerfCounter,
    })

    scene.onAfterRenderObservable.emit()
    counter.count = 1
    counter.current = 3
    scene.onAfterRenderObservable.emit()
    scene.onAfterRenderObservable.emit()
    counter.count = 2
    counter.current = 0
    scene.onAfterRenderObservable.emit()

    assert.equal(port.captureAttempts(), 4)
    assert.deepEqual(port.readings, [
        { gpuTimerCapability: 'disabled', gpu: null, drawCalls: 3 },
        { gpuTimerCapability: 'disabled', gpu: null, drawCalls: 0 },
    ])
    assert.equal(scene.onAfterRenderObservable.size(), 1)
    assert.equal(scene.onDisposeObservable.size(), 1)

    adapter.dispose()
    adapter.dispose()
    assert.equal(scene.onAfterRenderObservable.size(), 0)
    assert.equal(scene.onDisposeObservable.size(), 0)
    assert.equal(port.probeDisposeCount(), 1)
    assert.equal(instrumentation.disposeCount(), 0)

    counter.count = 3
    counter.current = 9
    scene.onAfterRenderObservable.emit()
    assert.equal(port.captureAttempts(), 4)
})

test('Babylon adapter supports WebGPU draw accounting without claiming GPU timing or triangles', () => {
    const scene = createScene()
    const counter = { count: 1, current: 7 }
    const instrumentation = createInstrumentation(scene, counter)
    const port = createAnimationPort()
    const adapter = createBabylonRendererAdapter({
        animation: port.animation,
        scene,
        instrumentation,
        backend: 'webgpu',
        readPerfCounterEnabled: readEnabledPerfCounter,
    })

    scene.onAfterRenderObservable.emit()
    assert.deepEqual(port.readings, [{ gpuTimerCapability: 'disabled', gpu: null, drawCalls: 7 }])
    assert.equal('triangles' in port.readings[0], false)
    adapter.dispose()
})

test('Babylon adapter never reports disabled PerfCounter frames as measured zero', () => {
    const scene = createScene()
    const counter = { count: 1, current: 4 }
    const instrumentation = createInstrumentation(scene, counter)
    const port = createAnimationPort()
    let enabled = true
    const adapter = createBabylonRendererAdapter({
        animation: port.animation,
        scene,
        instrumentation,
        backend: 'webgl2',
        readPerfCounterEnabled: () => enabled,
    })

    scene.onAfterRenderObservable.emit()
    enabled = false
    counter.count = 2
    counter.current = 0
    scene.onAfterRenderObservable.emit()
    enabled = true
    counter.current = 6
    scene.onAfterRenderObservable.emit()

    assert.deepEqual(port.readings, [
        { gpuTimerCapability: 'disabled', gpu: null, drawCalls: 4 },
        { gpuTimerCapability: 'disabled', gpu: null, drawCalls: 6 },
    ])
    adapter.dispose()
})

test('Babylon adapter rejects enabled-state changes and errors without advancing the frame sequence', () => {
    const scene = createScene()
    const counter = { count: 1, current: 9 }
    const instrumentation = createInstrumentation(scene, counter)
    const port = createAnimationPort()
    const enabledReads = [true, true, false]
    const adapter = createBabylonRendererAdapter({
        animation: port.animation,
        scene,
        instrumentation,
        backend: 'webgl2',
        readPerfCounterEnabled: () => {
            const value = enabledReads.shift()
            if (value === undefined) throw new Error('enabled state unavailable')
            return value
        },
    })

    scene.onAfterRenderObservable.emit()
    scene.onAfterRenderObservable.emit()
    enabledReads.push(true, true)
    scene.onAfterRenderObservable.emit()

    assert.deepEqual(port.readings, [{ gpuTimerCapability: 'disabled', gpu: null, drawCalls: 9 }])
    adapter.dispose()
})

test('Babylon adapter isolates hostile counter getters from the application render callback', () => {
    const scene = createScene()
    let hostile = true
    let count = 1
    const counter = {
        get count() {
            if (hostile) throw new Error('counter revoked')
            return count
        },
        get current() {
            return 5
        },
    }
    const instrumentation = createInstrumentation(scene, counter)
    const port = createAnimationPort()
    const adapter = createBabylonRendererAdapter({
        animation: port.animation,
        scene,
        instrumentation,
        backend: 'webgl',
        readPerfCounterEnabled: readEnabledPerfCounter,
    })

    assert.doesNotThrow(() => scene.onAfterRenderObservable.emit())
    hostile = false
    assert.doesNotThrow(() => scene.onAfterRenderObservable.emit())
    count = 2
    assert.doesNotThrow(() => scene.onAfterRenderObservable.emit())
    assert.deepEqual(port.readings, [
        { gpuTimerCapability: 'disabled', gpu: null, drawCalls: 5 },
        { gpuTimerCapability: 'disabled', gpu: null, drawCalls: 5 },
    ])
    adapter.dispose()
})

test('Babylon scene disposal releases adapter-owned instrumentation exactly once', () => {
    const scene = createScene()
    const instrumentation = createInstrumentation(scene, { count: 1, current: 2 })
    const port = createAnimationPort()
    const adapter = createBabylonRendererAdapter({
        animation: port.animation,
        scene,
        instrumentation,
        backend: 'webgl2',
        readPerfCounterEnabled: readEnabledPerfCounter,
        instrumentationOwnership: 'adapter',
    })

    scene.onDisposeObservable.emit()
    scene.onDisposeObservable.emit()
    adapter.dispose()
    assert.equal(instrumentation.disposeCount(), 1)
    assert.equal(port.probeDisposeCount(), 1)
    assert.equal(scene.onAfterRenderObservable.size(), 0)
    assert.equal(scene.onDisposeObservable.size(), 0)
})

test('Babylon adapter rejects mismatched scenes, disabled counters, and duplicate instrumentation', () => {
    const scene = createScene()
    const otherScene = createScene()
    const instrumentation = createInstrumentation(scene)
    const port = createAnimationPort()

    assert.throws(
        () =>
            createBabylonRendererAdapter({
                animation: port.animation,
                scene: otherScene,
                instrumentation,
                backend: 'webgl2',
                readPerfCounterEnabled: readEnabledPerfCounter,
            }),
        error => error instanceof BabylonRendererAdapterOptionsError && /same scene|supplied scene/u.test(error.message)
    )
    assert.throws(
        () =>
            createBabylonRendererAdapter({
                animation: port.animation,
                scene,
                instrumentation,
                backend: 'webgl2',
                readPerfCounterEnabled: () => false,
            }),
        error => error instanceof BabylonRendererAdapterOptionsError && /PerfCounter.Enabled/u.test(error.message)
    )

    const first = createBabylonRendererAdapter({
        animation: port.animation,
        scene,
        instrumentation,
        backend: 'webgl2',
        readPerfCounterEnabled: readEnabledPerfCounter,
    })
    assert.throws(
        () =>
            createBabylonRendererAdapter({
                animation: port.animation,
                scene,
                instrumentation,
                backend: 'webgl2',
                readPerfCounterEnabled: readEnabledPerfCounter,
            }),
        error => error instanceof BabylonRendererAdapterOptionsError && /active Babylon renderer adapter/u.test(error.message)
    )
    first.dispose()

    const replacement = createBabylonRendererAdapter({
        animation: port.animation,
        scene,
        instrumentation,
        backend: 'webgl2',
        readPerfCounterEnabled: readEnabledPerfCounter,
    })
    replacement.dispose()
})

test('Babylon adapter rejects two instrumentations for the same scene and monitor', () => {
    const scene = createScene()
    const firstInstrumentation = createInstrumentation(scene)
    const secondInstrumentation = createInstrumentation(scene)
    const port = createAnimationPort()
    const first = createBabylonRendererAdapter({
        animation: port.animation,
        scene,
        instrumentation: firstInstrumentation,
        backend: 'webgl2',
        readPerfCounterEnabled: readEnabledPerfCounter,
    })

    assert.throws(
        () =>
            createBabylonRendererAdapter({
                animation: port.animation,
                scene,
                instrumentation: secondInstrumentation,
                backend: 'webgl2',
                readPerfCounterEnabled: readEnabledPerfCounter,
            }),
        error => error instanceof BabylonRendererAdapterOptionsError && /scene already has an active/u.test(error.message)
    )

    first.dispose()
    const replacement = createBabylonRendererAdapter({
        animation: port.animation,
        scene,
        instrumentation: secondInstrumentation,
        backend: 'webgl2',
        readPerfCounterEnabled: readEnabledPerfCounter,
    })
    replacement.dispose()
})

test('Babylon adapter cleans staged subscriptions when scene disposal fires synchronously', () => {
    const scene = createScene()
    scene.onDisposeObservable = createObservable({ callOnAdd: true })
    const instrumentation = createInstrumentation(scene)
    const port = createAnimationPort()
    const adapter = createBabylonRendererAdapter({
        animation: port.animation,
        scene,
        instrumentation,
        backend: 'webgl2',
        readPerfCounterEnabled: readEnabledPerfCounter,
        instrumentationOwnership: 'adapter',
    })

    assert.equal(scene.onAfterRenderObservable.size(), 0)
    assert.equal(scene.onDisposeObservable.size(), 0)
    assert.equal(port.probeDisposeCount(), 1)
    assert.equal(instrumentation.disposeCount(), 1)
    adapter.dispose()
    assert.equal(port.probeDisposeCount(), 1)
})

test('Babylon adapter ignores synchronous after-render callbacks until initialization is complete', () => {
    const scene = createScene()
    scene.onAfterRenderObservable = createObservable({ callOnAdd: true })
    const instrumentation = createInstrumentation(scene, { count: 1, current: 3 })
    const port = createAnimationPort()
    const adapter = createBabylonRendererAdapter({
        animation: port.animation,
        scene,
        instrumentation,
        backend: 'webgl2',
        readPerfCounterEnabled: readEnabledPerfCounter,
    })

    assert.equal(port.captureAttempts(), 0)
    scene.onAfterRenderObservable.emit()
    assert.equal(port.captureAttempts(), 1)
    assert.deepEqual(port.readings, [{ gpuTimerCapability: 'disabled', gpu: null, drawCalls: 3 }])
    adapter.dispose()
})

test('Babylon adapter fails closed when a counter getter disposes the scene or reenters capture', () => {
    const disposingScene = createScene()
    const disposingCounter = {
        get count() {
            disposingScene.onDisposeObservable.emit()
            return 1
        },
        current: 5,
    }
    const disposingPort = createAnimationPort()
    const disposingAdapter = createBabylonRendererAdapter({
        animation: disposingPort.animation,
        scene: disposingScene,
        instrumentation: createInstrumentation(disposingScene, disposingCounter),
        backend: 'webgl2',
        readPerfCounterEnabled: readEnabledPerfCounter,
    })

    assert.doesNotThrow(() => disposingScene.onAfterRenderObservable.emit())
    assert.deepEqual(disposingPort.readings, [])
    assert.equal(disposingScene.onAfterRenderObservable.size(), 0)
    disposingAdapter.dispose()

    const reentrantScene = createScene()
    const reentrantCounter = {
        get count() {
            reentrantScene.onAfterRenderObservable.emit()
            return 1
        },
        current: 8,
    }
    const reentrantPort = createAnimationPort()
    const reentrantAdapter = createBabylonRendererAdapter({
        animation: reentrantPort.animation,
        scene: reentrantScene,
        instrumentation: createInstrumentation(reentrantScene, reentrantCounter),
        backend: 'webgl2',
        readPerfCounterEnabled: readEnabledPerfCounter,
    })

    assert.doesNotThrow(() => reentrantScene.onAfterRenderObservable.emit())
    assert.equal(reentrantPort.captureAttempts(), 2)
    assert.deepEqual(reentrantPort.readings, [{ gpuTimerCapability: 'disabled', gpu: null, drawCalls: 8 }])
    reentrantAdapter.dispose()
})

test('Babylon adapter rolls back subscriptions and owned resources after partial setup failure', () => {
    const scene = createScene()
    scene.onDisposeObservable = createObservable({ addError: new Error('dispose subscription failed') })
    const instrumentation = createInstrumentation(scene)
    const port = createAnimationPort()

    assert.throws(
        () =>
            createBabylonRendererAdapter({
                animation: port.animation,
                scene,
                instrumentation,
                backend: 'webgl2',
                readPerfCounterEnabled: readEnabledPerfCounter,
                instrumentationOwnership: 'adapter',
            }),
        error => error instanceof BabylonRendererAdapterOptionsError && /scene disposal/u.test(error.message)
    )
    assert.equal(scene.onAfterRenderObservable.size(), 0)
    assert.equal(port.probeDisposeCount(), 1)
    assert.equal(instrumentation.disposeCount(), 1)

    const replacementScene = {
        onAfterRenderObservable: createObservable(),
        onDisposeObservable: undefined,
    }
    const replacement = createBabylonRendererAdapter({
        animation: port.animation,
        scene: replacementScene,
        instrumentation: createInstrumentation(replacementScene),
        backend: 'webgl2',
        readPerfCounterEnabled: readEnabledPerfCounter,
    })
    replacement.dispose()
})
