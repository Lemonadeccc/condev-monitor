import assert from 'node:assert/strict'
import test from 'node:test'

import { createThreeAfterRenderRegistry, createThreeRendererAdapter, ThreeRendererAdapterOptionsError } from '../build/esm/index.mjs'

function createProbePort(events, options = {}) {
    let read
    let disposed = false
    let unregisterCount = 0
    const animation = {
        createRendererProbe(input) {
            events.push('create-probe')
            read = input.read
            return {
                capture() {
                    events.push('capture')
                    if (options.captureError) throw options.captureError
                    return read()
                },
                dispose() {
                    events.push('dispose-probe')
                    disposed = true
                },
            }
        },
        registerTarget(element, inspect) {
            events.push('register-target')
            if (options.registrationError) throw options.registrationError
            assert.equal(element, options.target)
            assert.equal(typeof inspect, 'function')
            return () => {
                events.push('unregister-target')
                unregisterCount += 1
            }
        },
    }
    return {
        animation,
        read: () => read?.(),
        isDisposed: () => disposed,
        unregisterCount: () => unregisterCount,
    }
}

function createTimer(events, overrides = {}) {
    let disposeCount = 0
    return {
        backend: 'webgl2',
        poll() {
            events.push('poll')
        },
        beginFrame() {
            events.push('begin')
            return overrides.beginFrame?.() ?? true
        },
        endFrame() {
            events.push('end')
            return true
        },
        cancelFrame() {
            events.push('cancel')
            return true
        },
        takeRendererHostTiming() {
            events.push('take-timing')
            return {
                gpuTimerCapability: 'supported',
                gpu: { status: 'measured', timeMs: 2, source: 'webgl-disjoint-timer-query' },
            }
        },
        inspect() {
            return null
        },
        dispose() {
            events.push('dispose-timer')
            disposeCount += 1
        },
        get disposeCount() {
            return disposeCount
        },
    }
}

test('Three adapter renders once, brackets GPU timing, and captures only public counters', () => {
    const events = []
    const target = {}
    const port = createProbePort(events, { target })
    const timer = createTimer(events)
    const privateScene = { secret: 'must-not-be-read' }
    const renderer = {
        info: {
            render: { calls: 3, triangles: 12, lines: 2, points: 4 },
            memory: { geometries: 5, textures: 6 },
            programs: [{}, {}],
        },
        render(scene, camera) {
            events.push('render')
            assert.equal(scene, privateScene)
            assert.equal(camera, 'camera')
        },
    }
    const adapter = createThreeRendererAdapter({
        animation: port.animation,
        renderer,
        backend: 'webgl2',
        gpuTimer: { timer, ownership: 'caller' },
        target: { element: target },
    })

    assert.equal(adapter.render(privateScene, 'camera'), undefined)
    assert.deepEqual(events, ['create-probe', 'register-target', 'poll', 'begin', 'render', 'end', 'capture', 'take-timing'])
    assert.deepEqual(port.read(), {
        gpuTimerCapability: 'supported',
        gpu: { status: 'measured', timeMs: 2, source: 'webgl-disjoint-timer-query' },
        drawCalls: 3,
        triangles: 12,
        lines: 2,
        points: 4,
        geometries: 5,
        textures: 6,
        programs: 2,
    })

    adapter.dispose()
    adapter.dispose()
    assert.equal(port.unregisterCount(), 1)
    assert.equal(port.isDisposed(), true)
    assert.equal(timer.disposeCount, 0)
})

test('Three adapter preserves renderer throws and cancels incomplete GPU evidence', () => {
    const events = []
    const port = createProbePort(events)
    const timer = createTimer(events)
    const original = new Error('renderer failed')
    const renderer = {
        info: { render: { calls: 1 } },
        render() {
            events.push('render')
            throw original
        },
    }
    const adapter = createThreeRendererAdapter({
        animation: port.animation,
        renderer,
        backend: 'webgl2',
        gpuTimer: { timer, ownership: 'adapter' },
    })

    assert.throws(
        () => adapter.render({}, {}),
        error => error === original
    )
    assert.deepEqual(events, ['create-probe', 'poll', 'begin', 'render', 'cancel'])
    adapter.dispose()
    assert.equal(timer.disposeCount, 1)
})

test('Three adapter does not attach to a returned Promise or report it as a completed frame', () => {
    const events = []
    const port = createProbePort(events)
    const timer = createTimer(events)
    const result = Promise.resolve('later')
    let thenReads = 0
    const renderer = {
        render() {
            events.push('render')
            return new Proxy(result, {
                get(target, property, receiver) {
                    if (property === 'then') thenReads += 1
                    return Reflect.get(target, property, receiver)
                },
            })
        },
    }
    const adapter = createThreeRendererAdapter({
        animation: port.animation,
        renderer,
        backend: 'webgl2',
        gpuTimer: { timer, ownership: 'caller' },
    })

    const returned = adapter.render({}, {})
    assert.equal(returned instanceof Promise, true)
    assert.equal(thenReads, 0)
    assert.deepEqual(events, ['create-probe', 'poll', 'begin', 'render', 'cancel'])
    adapter.dispose()
})

test('Three adapter reports disabled GPU timing without changing renderer behavior', () => {
    const events = []
    const port = createProbePort(events)
    const returnValue = { rendered: true }
    const renderer = {
        info: { render: { calls: 0, triangles: 0 } },
        render() {
            events.push('render')
            return returnValue
        },
    }
    const adapter = createThreeRendererAdapter({ animation: port.animation, renderer, backend: 'webgl2' })

    assert.equal(adapter.render({}, {}), returnValue)
    assert.deepEqual(events, ['create-probe', 'render'])
    assert.deepEqual(port.read(), {
        gpuTimerCapability: 'disabled',
        gpu: null,
        drawCalls: 0,
        triangles: 0,
    })
    adapter.dispose()
})

test('Three adapter never relabels cumulative autoReset=false render counters as per-frame evidence', () => {
    const events = []
    const port = createProbePort(events)
    const renderer = {
        info: {
            autoReset: false,
            render: { calls: 300, triangles: 1_200, lines: 20, points: 40 },
            memory: { geometries: 5, textures: 6 },
            programs: [{}, {}],
        },
        render() {},
    }
    const adapter = createThreeRendererAdapter({ animation: port.animation, renderer, backend: 'webgl2' })

    adapter.render({}, {})
    assert.deepEqual(port.read(), {
        gpuTimerCapability: 'disabled',
        gpu: null,
        geometries: 5,
        textures: 6,
        programs: 2,
    })
    adapter.dispose()
})

test('Three adapter observes externally rendered frames without rendering or duplicating a frame', () => {
    const events = []
    const port = createProbePort(events)
    const renderer = {
        info: { render: { frame: 0, calls: 0, triangles: 0 } },
        render() {
            events.push('unexpected-render')
        },
    }
    const adapter = createThreeRendererAdapter({ animation: port.animation, renderer, backend: 'webgl2' })

    assert.equal(adapter.captureFrame(), false)
    renderer.info.render = { frame: 1, calls: 3, triangles: 12 }
    assert.equal(adapter.captureFrame(), true)
    assert.equal(adapter.captureFrame(), false)
    assert.deepEqual(events, ['create-probe', 'capture'])
    assert.deepEqual(port.read(), {
        gpuTimerCapability: 'disabled',
        gpu: null,
        drawCalls: 3,
        triangles: 12,
    })

    renderer.info.render = { frame: 2, calls: 4, triangles: 18 }
    assert.equal(adapter.captureFrame(), true)
    adapter.dispose()
    assert.equal(adapter.captureFrame(), false)
    assert.deepEqual(events, ['create-probe', 'capture', 'capture', 'dispose-probe'])
})

test('Three adapter brackets externally owned frames without taking over rendering', () => {
    const events = []
    const port = createProbePort(events)
    const timer = createTimer(events)
    const renderer = {
        info: { render: { frame: 0, calls: 0, triangles: 0 } },
        render() {
            events.push('unexpected-render')
        },
    }
    const adapter = createThreeRendererAdapter({
        animation: port.animation,
        renderer,
        backend: 'webgl2',
        gpuTimer: { timer, ownership: 'adapter' },
    })

    assert.equal(adapter.completeExternalFrame(), false)
    assert.equal(adapter.beginExternalFrame(), true)
    renderer.info.render = { frame: 1, calls: 3, triangles: 12 }
    assert.equal(adapter.completeExternalFrame(), true)
    assert.equal(adapter.completeExternalFrame(), false)
    assert.deepEqual(events, ['create-probe', 'poll', 'begin', 'end', 'capture', 'take-timing'])

    assert.equal(adapter.beginExternalFrame(), true)
    assert.equal(adapter.completeExternalFrame(), false)
    assert.deepEqual(events.slice(-3), ['poll', 'begin', 'cancel'])
    assert.equal(adapter.beginExternalFrame(), true)
    assert.deepEqual(events.slice(-5), ['poll', 'begin', 'cancel', 'poll', 'begin'])
    adapter.dispose()
    assert.deepEqual(events.slice(-3), ['cancel', 'dispose-probe', 'dispose-timer'])
})

test('Three adapter keeps using the public frame sequence when autoReset disables counter resets', () => {
    const events = []
    const port = createProbePort(events)
    const renderer = {
        info: { autoReset: false, render: { frame: 1, calls: 9, triangles: 27 } },
        render() {
            events.push('unexpected-render')
        },
    }
    const adapter = createThreeRendererAdapter({ animation: port.animation, renderer, backend: 'webgl2' })

    assert.equal(adapter.captureFrame(), true)
    assert.equal(adapter.captureFrame(), false)
    renderer.info.render.frame = 2
    assert.equal(adapter.captureFrame(), true)
    assert.deepEqual(events, ['create-probe', 'capture', 'capture'])
    assert.deepEqual(port.read(), {
        gpuTimerCapability: 'disabled',
        gpu: null,
    })
})

test('Three adapter fails closed when an external frame sequence is missing or capture fails', () => {
    const events = []
    const renderer = {
        info: { render: { calls: 1 } },
        render() {
            events.push('unexpected-render')
        },
    }
    const adapter = createThreeRendererAdapter({
        animation: createProbePort(events, { captureError: new Error('sink unavailable') }).animation,
        renderer,
        backend: 'webgl2',
    })

    assert.equal(adapter.captureFrame(), false)
    renderer.info.render.frame = 1
    assert.equal(adapter.captureFrame(), false)
    assert.equal(adapter.captureFrame(), false)
    assert.deepEqual(events, ['create-probe', 'capture'])
})

test('Three after-render registry shares one subscription and isolates renderer roots', () => {
    const events = []
    let afterRender
    let subscribeCount = 0
    let unsubscribeCount = 0
    const registry = createThreeAfterRenderRegistry(callback => {
        subscribeCount += 1
        afterRender = callback
        return () => {
            unsubscribeCount += 1
        }
    })
    const first = {
        captureFrame() {
            events.push('first')
            return true
        },
    }
    const second = {
        captureFrame() {
            events.push('second')
            throw new Error('root disappeared')
        },
    }

    const unregisterFirst = registry.register(first)
    const unregisterFirstDuplicate = registry.register(first)
    const unregisterSecond = registry.register(second)
    assert.equal(subscribeCount, 1)
    assert.doesNotThrow(() => afterRender())
    assert.deepEqual(events, ['first', 'second'])

    unregisterFirst()
    assert.equal(unsubscribeCount, 0)
    unregisterSecond()
    assert.equal(unsubscribeCount, 0)
    unregisterFirstDuplicate()
    unregisterFirstDuplicate()
    assert.equal(unsubscribeCount, 1)

    registry.dispose()
    registry.dispose()
    assert.throws(() => registry.register(first), ThreeRendererAdapterOptionsError)
})

test('Three adapter isolates monitoring failures and rolls back setup failures', () => {
    const captureError = new Error('sink unavailable')
    const events = []
    const port = createProbePort(events, { captureError })
    const renderer = {
        render() {
            events.push('render')
            return 'business-result'
        },
    }
    const adapter = createThreeRendererAdapter({ animation: port.animation, renderer, backend: 'webgl' })
    assert.equal(adapter.render({}, {}), 'business-result')
    assert.deepEqual(events, ['create-probe', 'render'])
    adapter.dispose()

    const rollbackEvents = []
    const registrationError = new Error('registration failed')
    const target = {}
    const rollbackPort = createProbePort(rollbackEvents, { registrationError, target })
    const ownedTimer = createTimer(rollbackEvents)
    assert.throws(
        () =>
            createThreeRendererAdapter({
                animation: rollbackPort.animation,
                renderer,
                backend: 'webgl2',
                gpuTimer: { timer: ownedTimer, ownership: 'adapter' },
                target: { element: target },
            }),
        error => error === registrationError
    )
    assert.deepEqual(rollbackEvents, ['create-probe', 'register-target', 'dispose-probe', 'dispose-timer'])
})
