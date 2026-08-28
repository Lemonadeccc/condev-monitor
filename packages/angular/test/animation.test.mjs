import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { init as browserAnimationInit } from '@condev-monitor/monitor-sdk-browser/animation'
import { createCondevAngularAnimationScope, init, registerCondevAngularPostRender } from '@condev-monitor/angular/animation'
import * as angularRoot from '@condev-monitor/angular'

const require = createRequire(import.meta.url)

function createClientHarness({ throwOnCreate = false, throwOnRecord = false, throwOnRegister = false } = {}) {
    const samples = []
    const registrations = []
    let disposeCalls = 0
    return {
        samples,
        registrations,
        get disposeCalls() {
            return disposeCalls
        },
        client: {
            animation: {
                createFrameworkProbe(framework) {
                    assert.equal(framework, 'angular')
                    if (throwOnCreate) throw new Error('framework probe unavailable')
                    return {
                        recordCommit() {
                            throw new Error('Angular adapter must not record commit evidence')
                        },
                        recordUpdateWindow() {
                            throw new Error('Angular component checks must not be recorded as DOM update windows')
                        },
                        recordCheckWindow(sample) {
                            if (throwOnRecord) throw new Error('monitor unavailable')
                            samples.push(sample)
                            return true
                        },
                        onReactProfilerRender() {},
                        dispose() {
                            disposeCalls += 1
                        },
                    }
                },
                registerTarget(element, inspect) {
                    if (throwOnRegister) throw new Error('target registry unavailable')
                    const registration = { element, inspect, active: true }
                    registrations.push(registration)
                    return () => {
                        registration.active = false
                    }
                },
            },
        },
    }
}

test('the Angular animation entry reuses the Browser animation init in ESM and CommonJS', () => {
    assert.equal(init, browserAnimationInit)
    const commonJs = require('@condev-monitor/angular/animation')
    const commonJsBrowserAnimation = require('@condev-monitor/monitor-sdk-browser/animation')
    assert.equal(commonJs.init, commonJsBrowserAnimation.init)
    assert.equal(typeof commonJs.createCondevAngularAnimationScope, 'function')
    assert.equal(typeof commonJs.registerCondevAngularPostRender, 'function')
    assert.equal('createCondevAngularAnimationScope' in angularRoot, false)
    assert.equal('createCondevAngularAnimationScope' in require('@condev-monitor/angular'), false)
})

test('the Angular scope records only an observed component check window', () => {
    const harness = createClientHarness()
    const times = [10, 18]
    const scope = createCondevAngularAnimationScope({ client: harness.client, now: () => times.shift() })

    scope.checkStarted()
    assert.equal(scope.viewChecked(), true)
    assert.deepEqual(harness.samples, [{ checkWindowMs: 8, timestampMs: 18 }])

    scope.destroy()
    scope.destroy()
    scope.checkStarted()
    assert.equal(scope.viewChecked(), false)
    assert.equal(harness.disposeCalls, 1)
})

test('post-render synchronizes anonymous Angular ownership and switches targets safely', () => {
    const harness = createClientHarness()
    const firstTarget = { node: 1 }
    const secondTarget = { node: 2 }
    let target = firstTarget
    const scope = createCondevAngularAnimationScope({ client: harness.client, getTarget: () => target })

    scope.checkStarted()
    scope.viewChecked()
    assert.equal(harness.registrations.length, 0)

    scope.postRendered()
    assert.equal(harness.registrations.length, 1)
    assert.equal(harness.registrations[0].element, firstTarget)
    assert.deepEqual(harness.registrations[0].inspect(), {
        inventory: { uiFrameworks: ['angular'] },
        owners: [{ relation: 'framework-owner', framework: 'angular' }],
    })
    assert.deepEqual(Object.keys(harness.registrations[0].inspect()).sort(), ['inventory', 'owners'])

    target = secondTarget
    scope.postRendered()
    assert.equal(harness.registrations.length, 2)
    assert.equal(harness.registrations[0].active, false)
    assert.equal(harness.registrations[1].active, true)

    scope.destroy()
    assert.equal(harness.registrations[1].active, false)
})

test('a failed Angular target replacement releases the previous element registration', () => {
    const harness = createClientHarness()
    let target = { node: 1 }
    const scope = createCondevAngularAnimationScope({ client: harness.client, getTarget: () => target })

    scope.postRendered()
    assert.equal(harness.registrations[0].active, true)
    harness.client.animation.registerTarget = () => {
        throw new Error('target registry unavailable')
    }
    target = { node: 2 }
    scope.postRendered()
    assert.equal(harness.registrations[0].active, false)
    scope.destroy()
})

test('the public Angular post-render registrar stays application-wide and cleanup-safe', () => {
    const calls = []
    const injector = { token: 'public-injector' }
    let read
    let destroyCalls = 0
    const handle = registerCondevAngularPostRender(
        { postRendered: () => calls.push('post-render') },
        {
            injector,
            register(callbacks, options) {
                assert.equal(options.injector, injector)
                assert.deepEqual(Object.keys(callbacks), ['read'])
                read = callbacks.read
                return {
                    destroy() {
                        destroyCalls += 1
                    },
                }
            },
        }
    )

    read()
    assert.deepEqual(calls, ['post-render'])
    handle.destroy()
    handle.destroy()
    assert.equal(destroyCalls, 1)

    assert.throws(
        () =>
            registerCondevAngularPostRender(
                { postRendered: () => calls.push('unexpected') },
                {
                    injector,
                    register() {
                        throw new Error('invalid Angular render registration')
                    },
                }
            ),
        /invalid Angular render registration/
    )
})

test('invalid clocks and monitor failures cannot alter Angular lifecycle behavior', () => {
    const clockValues = [Number.NaN, 4, 3, -1]
    const clockHarness = createClientHarness()
    const scope = createCondevAngularAnimationScope({ client: clockHarness.client, now: () => clockValues.shift() })
    scope.checkStarted()
    assert.equal(scope.viewChecked(), false)
    scope.checkStarted()
    assert.equal(scope.viewChecked(), false)
    assert.deepEqual(clockHarness.samples, [])
    scope.destroy()

    const throwingHarness = createClientHarness({ throwOnRecord: true, throwOnRegister: true })
    const throwingScope = createCondevAngularAnimationScope({
        client: throwingHarness.client,
        getTarget: () => ({ node: 1 }),
        now: (() => {
            const values = [1, 2]
            return () => values.shift()
        })(),
    })
    assert.doesNotThrow(() => throwingScope.postRendered())
    throwingScope.checkStarted()
    assert.equal(throwingScope.viewChecked(), false)
    assert.doesNotThrow(() => throwingScope.destroy())

    const missingProbe = createCondevAngularAnimationScope({ client: createClientHarness({ throwOnCreate: true }).client })
    missingProbe.checkStarted()
    assert.equal(missingProbe.viewChecked(), false)
    missingProbe.destroy()
})
