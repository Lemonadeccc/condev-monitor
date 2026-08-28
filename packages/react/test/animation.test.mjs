import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { Profiler, createElement } from 'react'

import { init as browserAnimationInit } from '@condev-monitor/monitor-sdk-browser/animation'

import { CondevAnimationProfiler, CondevErrorBoundary, MonitorUser, init, useMonitorUser } from '@condev-monitor/react/animation'
import { CondevR3FObserver } from '@condev-monitor/react/animation/r3f'
import * as reactRoot from '@condev-monitor/react'

const require = createRequire(import.meta.url)

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

test('the R3F observer shares one after-render subscription and cleans up renderer roots', () => {
    const fiber = require('@react-three/fiber')
    const react = require('react')
    const commonJs = require('@condev-monitor/react/animation/r3f')
    const originalUseThree = fiber.useThree
    const originalAddAfterEffect = fiber.addAfterEffect
    const originalUseEffect = react.useEffect
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
    }
})

test('the R3F observer exposes local setup failures without breaking application rendering', () => {
    const fiber = require('@react-three/fiber')
    const react = require('react')
    const commonJs = require('@condev-monitor/react/animation/r3f')
    const originalUseThree = fiber.useThree
    const originalAddAfterEffect = fiber.addAfterEffect
    const originalUseEffect = react.useEffect
    const setupErrors = []
    let disposals = 0
    const renderer = { info: { render: { frame: 0 } }, render() {} }
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
    } finally {
        fiber.useThree = originalUseThree
        fiber.addAfterEffect = originalAddAfterEffect
        react.useEffect = originalUseEffect
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
