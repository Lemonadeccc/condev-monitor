import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { Profiler, createElement } from 'react'

import { init as browserAnimationInit } from '@condev-monitor/monitor-sdk-browser/animation'

import { CondevAnimationProfiler, CondevErrorBoundary, MonitorUser, init, useMonitorUser } from '@condev-monitor/react/animation'
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
