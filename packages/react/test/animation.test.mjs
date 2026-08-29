import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { Profiler, createElement } from 'react'

import { init as browserAnimationInit } from '@condev-monitor/monitor-sdk-browser/animation'

import {
    CondevAnimationProfiler,
    CondevErrorBoundary,
    MonitorUser,
    createCondevReactComponentScope,
    init,
    useMonitorUser,
} from '@condev-monitor/react/animation'
import { CondevR3FObserver } from '@condev-monitor/react/animation/r3f'
import * as reactRoot from '@condev-monitor/react'

const require = createRequire(import.meta.url)

function createFakeWebGl2TimerContext() {
    const enums = {
        QUERY_COUNTER_BITS: 0x8864,
        CURRENT_QUERY: 0x8865,
        QUERY_RESULT: 0x8866,
        QUERY_RESULT_AVAILABLE: 0x8867,
        TIME_ELAPSED: 0x88bf,
        GPU_DISJOINT: 0x8fbb,
    }
    const queries = []
    let currentQuery = null
    const extension = {
        QUERY_COUNTER_BITS_EXT: enums.QUERY_COUNTER_BITS,
        TIME_ELAPSED_EXT: enums.TIME_ELAPSED,
        GPU_DISJOINT_EXT: enums.GPU_DISJOINT,
    }
    const gl = {
        CURRENT_QUERY: enums.CURRENT_QUERY,
        QUERY_RESULT: enums.QUERY_RESULT,
        QUERY_RESULT_AVAILABLE: enums.QUERY_RESULT_AVAILABLE,
        getExtension(name) {
            return name === 'EXT_disjoint_timer_query_webgl2' ? extension : null
        },
        getParameter(pname) {
            assert.equal(pname, enums.GPU_DISJOINT)
            return false
        },
        isContextLost() {
            return false
        },
        createQuery() {
            const query = { available: false, resultNs: 0, deleted: false }
            queries.push(query)
            return query
        },
        deleteQuery(query) {
            query.deleted = true
            if (currentQuery === query) currentQuery = null
        },
        beginQuery(target, query) {
            assert.equal(target, enums.TIME_ELAPSED)
            assert.equal(currentQuery, null)
            currentQuery = query
        },
        endQuery(target) {
            assert.equal(target, enums.TIME_ELAPSED)
            currentQuery = null
        },
        getQuery(target, pname) {
            assert.equal(target, enums.TIME_ELAPSED)
            if (pname === enums.QUERY_COUNTER_BITS) return 64
            if (pname === enums.CURRENT_QUERY) return currentQuery
            throw new Error(`unexpected query property ${pname}`)
        },
        getQueryParameter(query, pname) {
            if (pname === enums.QUERY_RESULT_AVAILABLE) return query.available
            if (pname === enums.QUERY_RESULT) return query.resultNs
            throw new Error(`unexpected query result property ${pname}`)
        },
    }

    return {
        gl,
        queries,
        resolve(index, resultNs) {
            queries[index].available = true
            queries[index].resultNs = resultNs
        },
    }
}

test('the React animation entry reuses the Browser animation init', () => {
    assert.equal(init, browserAnimationInit)
    const commonJs = require('@condev-monitor/react/animation')
    const commonJsBrowserAnimation = require('@condev-monitor/monitor-sdk-browser/animation')
    assert.equal(commonJs.init, commonJsBrowserAnimation.init)
    assert.equal(typeof commonJs.init, 'function')
    assert.equal(typeof commonJs.CondevAnimationProfiler, 'function')
    assert.equal(typeof commonJs.CondevErrorBoundary, 'function')
    assert.equal(typeof commonJs.MonitorUser, 'function')
    assert.equal(typeof commonJs.useMonitorUser, 'function')
    assert.equal(typeof CondevErrorBoundary, 'function')
    assert.equal(typeof MonitorUser, 'function')
    assert.equal(typeof useMonitorUser, 'function')
    assert.equal('CondevAnimationProfiler' in reactRoot, false)
    assert.equal('CondevAnimationProfiler' in require('@condev-monitor/react'), false)
})

test('the optional R3F entry stays isolated from ordinary React entries', () => {
    const commonJs = require('@condev-monitor/react/animation/r3f')
    const commonJsAnimation = require('@condev-monitor/react/animation')

    assert.equal(typeof CondevR3FObserver, 'function')
    assert.equal(typeof commonJs.CondevR3FObserver, 'function')
    assert.equal('CondevR3FObserver' in reactRoot, false)
    assert.equal('CondevR3FObserver' in require('@condev-monitor/react'), false)
    assert.equal('CondevR3FObserver' in commonJsAnimation, false)
})

test('the React component scope keeps Profiler and independent commit evidence local to a bound Element', () => {
    const records = []
    let inspect
    const component = createCondevReactComponentScope({
        client: {
            animation: {
                createFrameworkComponentScope(options) {
                    assert.deepEqual(options, { framework: 'react', label: 'Private card' })
                    return {
                        record(value) {
                            records.push(value)
                            return true
                        },
                        snapshot(window) {
                            return { schemaVersion: 1, scopeId: 'framework-scope-1', framework: 'react', label: 'Private card', window }
                        },
                        dispose() {},
                    }
                },
                registerTarget(_element, provider) {
                    inspect = provider
                    return () => {}
                },
            },
        },
        label: 'Private card',
    })
    component.onRender('private-id', 'update', 4, 7, 1, 20)
    component.recordIndependentCommit(2, 22)
    component.bindTarget({})
    assert.deepEqual(
        records.map(record => record.kind),
        ['render', 'commit-attested']
    )
    assert.equal(inspect({ inspectionPurpose: 'local', evidenceWindow: { startedAt: 0, endedAt: 30 } }).frameworkScopes.length, 1)
    assert.equal('frameworkScopes' in inspect({ inspectionPurpose: 'rum', evidenceWindow: { startedAt: 0, endedAt: 30 } }), false)
    assert.equal(JSON.stringify(records).includes('private-id'), false)
    component.dispose()
})

test('the R3F observer shares one after-render subscription and cleans up renderer roots', () => {
    const fiber = require('@react-three/fiber')
    const react = require('react')
    const commonJs = require('@condev-monitor/react/animation/r3f')
    const originalUseThree = fiber.useThree
    const originalAddAfterEffect = fiber.addAfterEffect
    const originalUseEffect = react.useEffect
    const originalUseRef = react.useRef
    const cleanups = []
    const captures = [0, 0]
    const disposals = [0, 0]
    const renderers = [
        { info: { render: { frame: 0 } }, render() {} },
        { info: { render: { frame: 0 } }, render() {} },
    ]
    let currentRenderer
    let afterRender
    let subscriptions = 0
    let stopCount = 0

    const client = index => ({
        animation: {
            createRendererProbe() {
                return {
                    capture() {
                        captures[index] += 1
                    },
                    dispose() {
                        disposals[index] += 1
                    },
                }
            },
            registerTarget() {
                return () => {}
            },
        },
    })

    try {
        fiber.useThree = selector => selector({ gl: currentRenderer })
        fiber.addAfterEffect = callback => {
            subscriptions += 1
            afterRender = callback
            return () => {
                stopCount += 1
            }
        }
        react.useEffect = effect => {
            cleanups.push(effect())
        }
        react.useRef = initialValue => ({ current: initialValue })

        currentRenderer = renderers[0]
        assert.equal(commonJs.CondevR3FObserver({ client: client(0), backend: 'webgl2' }), null)
        currentRenderer = renderers[1]
        assert.equal(commonJs.CondevR3FObserver({ client: client(1), backend: 'webgl2' }), null)
        assert.equal(subscriptions, 1)

        renderers[0].info.render.frame = 1
        afterRender()
        assert.deepEqual(captures, [1, 0])
        renderers[1].info.render.frame = 1
        afterRender()
        assert.deepEqual(captures, [1, 1])

        cleanups[0]()
        assert.equal(stopCount, 0)
        cleanups[1]()
        assert.equal(stopCount, 1)
        assert.deepEqual(disposals, [1, 1])

        currentRenderer = renderers[0]
        commonJs.CondevR3FObserver({ client: client(0), backend: 'webgl2' })
        assert.equal(subscriptions, 2)
        cleanups[2]()
        assert.equal(stopCount, 2)
    } finally {
        fiber.useThree = originalUseThree
        fiber.addAfterEffect = originalAddAfterEffect
        react.useEffect = originalUseEffect
        react.useRef = originalUseRef
    }
})

test('the R3F observer opt-in brackets actual frames with sparse WebGL GPU timing', () => {
    const fiber = require('@react-three/fiber')
    const react = require('react')
    const commonJs = require('@condev-monitor/react/animation/r3f')
    const originalUseThree = fiber.useThree
    const originalUseFrame = fiber.useFrame
    const originalAddAfterEffect = fiber.addAfterEffect
    const originalUseEffect = react.useEffect
    const originalUseRef = react.useRef
    const fake = createFakeWebGl2TimerContext()
    const readings = []
    let beforeRender
    let afterRender
    let cleanup
    let afterStops = 0
    const renderer = {
        info: { render: { frame: 0, calls: 0, triangles: 0 } },
        render() {},
        getContext() {
            return fake.gl
        },
    }
    const client = {
        animation: {
            createRendererProbe({ read }) {
                return {
                    capture() {
                        readings.push(read())
                    },
                    dispose() {},
                }
            },
            registerTarget() {
                return () => {}
            },
        },
    }

    try {
        fiber.useThree = selector => selector({ gl: renderer })
        fiber.useFrame = (callback, priority) => {
            assert.equal(priority, Number.NEGATIVE_INFINITY)
            beforeRender = callback
        }
        fiber.addAfterEffect = callback => {
            afterRender = callback
            return () => {
                afterStops += 1
            }
        }
        react.useEffect = effect => {
            const effectCleanup = effect()
            if (effectCleanup) cleanup = effectCleanup
        }
        react.useRef = initialValue => ({ current: initialValue })

        const boundary = commonJs.CondevR3FObserver({
            client,
            backend: 'webgl2',
            gpuTiming: { disjointQueryOwnership: 'exclusive', sampleEvery: 1 },
        })
        assert.equal(typeof boundary.type, 'function')
        assert.equal(boundary.type(boundary.props), null)

        const duplicateErrors = []
        commonJs.CondevR3FObserver({
            client,
            backend: 'webgl2',
            gpuTiming: { disjointQueryOwnership: 'exclusive', sampleEvery: 1 },
            onSetupError(error) {
                duplicateErrors.push(error)
            },
        })
        assert.equal(duplicateErrors[0].stage, 'gpu-timer-create')
        assert.match(duplicateErrors[0].cause.message, /already active/)
        assert.equal(fake.queries.length, 0)

        beforeRender()
        renderer.info.render = { frame: 1, calls: 2, triangles: 6 }
        afterRender()
        assert.equal(readings[0].gpuTimerCapability, 'supported')
        assert.equal(readings[0].gpu, null)

        fake.resolve(0, 2_000_000)
        beforeRender()
        renderer.info.render = { frame: 2, calls: 3, triangles: 9 }
        afterRender()
        assert.deepEqual(readings[1].gpu, {
            status: 'measured',
            timeMs: 2,
            source: 'webgl-disjoint-timer-query',
        })
        assert.equal(readings[1].drawCalls, 3)
        assert.equal(readings[1].triangles, 9)

        cleanup()
        assert.equal(afterStops, 1)
        assert.equal(fake.queries[1].deleted, true)
    } finally {
        fiber.useThree = originalUseThree
        fiber.useFrame = originalUseFrame
        fiber.addAfterEffect = originalAddAfterEffect
        react.useEffect = originalUseEffect
        react.useRef = originalUseRef
    }
})

test('unrelated R3F roots do not consume sparse GPU sampling attempts', () => {
    const fiber = require('@react-three/fiber')
    const react = require('react')
    const commonJs = require('@condev-monitor/react/animation/r3f')
    const originalUseThree = fiber.useThree
    const originalUseFrame = fiber.useFrame
    const originalAddAfterEffect = fiber.addAfterEffect
    const originalUseEffect = react.useEffect
    const originalUseRef = react.useRef
    const fakes = [createFakeWebGl2TimerContext(), createFakeWebGl2TimerContext()]
    const readings = [[], []]
    const renderers = fakes.map((fake, index) => ({
        info: { render: { frame: 0, calls: 0, triangles: 0 } },
        render() {},
        getContext() {
            return fake.gl
        },
        index,
    }))
    const beforeRender = []
    const cleanups = []
    let currentRenderer
    let currentRoot = 0
    let afterRender
    let afterSubscriptions = 0
    let afterStops = 0

    const client = index => ({
        animation: {
            createRendererProbe({ read }) {
                return {
                    capture() {
                        readings[index].push(read())
                    },
                    dispose() {},
                }
            },
            registerTarget() {
                return () => {}
            },
        },
    })

    try {
        fiber.useThree = selector => selector({ gl: currentRenderer })
        fiber.useFrame = (callback, priority) => {
            assert.equal(priority, Number.NEGATIVE_INFINITY)
            beforeRender[currentRoot] = callback
        }
        fiber.addAfterEffect = callback => {
            afterSubscriptions += 1
            afterRender = callback
            return () => {
                afterStops += 1
            }
        }
        react.useEffect = effect => {
            cleanups.push(effect())
        }
        react.useRef = initialValue => ({ current: initialValue })

        currentRenderer = renderers[0]
        currentRoot = 0
        const firstBoundary = commonJs.CondevR3FObserver({
            client: client(0),
            backend: 'webgl2',
            gpuTiming: { disjointQueryOwnership: 'exclusive', sampleEvery: 2 },
        })
        firstBoundary.type(firstBoundary.props)

        currentRenderer = renderers[1]
        currentRoot = 1
        const secondBoundary = commonJs.CondevR3FObserver({
            client: client(1),
            backend: 'webgl2',
            gpuTiming: { disjointQueryOwnership: 'exclusive', sampleEvery: 2 },
        })
        secondBoundary.type(secondBoundary.props)

        assert.equal(afterSubscriptions, 1)
        for (let frame = 1; frame <= 4; frame += 1) {
            beforeRender[1]()
            renderers[1].info.render = { frame, calls: frame, triangles: frame * 3 }
            afterRender()
        }

        assert.equal(fakes[0].queries.length, 0)
        assert.equal(fakes[1].queries.length, 2)
        assert.equal(readings[0].length, 0)
        assert.equal(readings[1].length, 4)

        beforeRender[0]()
        renderers[0].info.render = { frame: 1, calls: 2, triangles: 6 }
        afterRender()
        assert.equal(fakes[0].queries.length, 1)
        assert.equal(readings[0].length, 1)

        afterRender()
        assert.equal(fakes[0].queries.length, 1)
        assert.equal(readings[0].length, 1)

        cleanups[0]()
        assert.equal(afterStops, 0)
        cleanups[1]()
        assert.equal(afterStops, 1)
    } finally {
        fiber.useThree = originalUseThree
        fiber.useFrame = originalUseFrame
        fiber.addAfterEffect = originalAddAfterEffect
        react.useEffect = originalUseEffect
        react.useRef = originalUseRef
    }
})

test('the R3F observer exposes local setup failures without breaking application rendering', () => {
    const fiber = require('@react-three/fiber')
    const react = require('react')
    const commonJs = require('@condev-monitor/react/animation/r3f')
    const originalUseThree = fiber.useThree
    const originalAddAfterEffect = fiber.addAfterEffect
    const originalUseEffect = react.useEffect
    const originalUseRef = react.useRef
    const setupErrors = []
    let disposals = 0
    const renderer = {
        info: { render: { frame: 0 } },
        render() {},
        getContext() {
            throw new Error('context unavailable')
        },
    }
    const client = {
        animation: {
            createRendererProbe() {
                return {
                    capture() {},
                    dispose() {
                        disposals += 1
                    },
                }
            },
            registerTarget() {
                return () => {}
            },
        },
    }

    try {
        fiber.useThree = selector => selector({ gl: renderer })
        react.useEffect = effect => effect()
        react.useRef = initialValue => ({ current: initialValue })
        fiber.addAfterEffect = () => {
            throw new Error('subscription unavailable')
        }

        assert.doesNotThrow(() =>
            commonJs.CondevR3FObserver({
                client,
                backend: 'webgl2',
                onSetupError(error) {
                    setupErrors.push(error)
                },
            })
        )
        assert.equal(setupErrors[0].stage, 'after-render-subscribe')
        assert.match(setupErrors[0].cause.message, /subscription unavailable/)
        assert.equal(disposals, 1)

        assert.doesNotThrow(() =>
            commonJs.CondevR3FObserver({
                client,
                backend: 'invalid',
                onSetupError(error) {
                    setupErrors.push(error)
                    throw new Error('diagnostics unavailable')
                },
            })
        )
        assert.equal(setupErrors[1].stage, 'adapter-create')

        assert.doesNotThrow(() =>
            commonJs.CondevR3FObserver({
                client,
                backend: 'webgl2',
                gpuTiming: { disjointQueryOwnership: 'exclusive' },
                onSetupError(error) {
                    setupErrors.push(error)
                },
            })
        )
        assert.equal(setupErrors[2].stage, 'gpu-timer-create')
        assert.match(setupErrors[2].cause.message, /context unavailable/)
    } finally {
        fiber.useThree = originalUseThree
        fiber.addAfterEffect = originalAddAfterEffect
        react.useEffect = originalUseEffect
        react.useRef = originalUseRef
    }
})

test('CondevAnimationProfiler records bounded anonymous render evidence', () => {
    const samples = []
    const child = createElement('div', null, 'application content')
    const element = CondevAnimationProfiler({
        client: {
            animation: {
                recordFrameworkStats(sample) {
                    samples.push(sample)
                    return true
                },
            },
        },
        children: child,
    })

    assert.equal(element.type, Profiler)
    assert.equal(element.props.id, 'condev-animation-root')
    assert.equal(element.props.children, child)

    element.props.onRender('private-component-name', 'mount', 4.25, 6.5, 1.25, 8.75)

    assert.deepEqual(samples, [
        {
            source: 'react-profiler',
            framework: 'react',
            phase: 'mount',
            renderMs: 4.25,
            baseRenderMs: 6.5,
            timestampMs: 8.75,
        },
    ])
    assert.equal('id' in samples[0], false)
    assert.equal('startTime' in samples[0], false)
    assert.equal('commitMs' in samples[0], false)
})

test('CondevAnimationProfiler closes future phases and isolates monitor failures', () => {
    let calls = 0
    const element = CondevAnimationProfiler({
        client: {
            animation: {
                recordFrameworkStats(sample) {
                    calls += 1
                    assert.equal(sample.phase, 'other')
                    throw new Error('monitor unavailable')
                },
            },
        },
        children: null,
    })

    assert.doesNotThrow(() => element.props.onRender('ignored', 'future-phase', 1, 2, 3, 4))
    assert.equal(calls, 1)

    const hostileClient = {}
    Object.defineProperty(hostileClient, 'animation', {
        get() {
            throw new Error('revoked client')
        },
    })
    const hostileElement = CondevAnimationProfiler({ client: hostileClient, children: null })
    assert.doesNotThrow(() => hostileElement.props.onRender('ignored', 'update', 1, 2, 3, 4))
})
