import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { init as browserAnimationInit } from '@condev-monitor/monitor-sdk-browser/animation'
import {
    bindCondevAngularAnimationTarget,
    createCondevAngularAnimationScope,
    init,
    registerCondevAngularPostRender,
} from '@condev-monitor/angular/animation'
import * as angularRoot from '@condev-monitor/angular'

const require = createRequire(import.meta.url)

function createClientHarness({
    throwOnCreate = false,
    throwOnRecord = false,
    throwOnRegister = false,
    throwOnUnregister = false,
    withComponentScope = false,
} = {}) {
    const samples = []
    const localRecords = []
    const registrations = []
    let disposeCalls = 0
    return {
        samples,
        localRecords,
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
                ...(withComponentScope
                    ? {
                          createFrameworkComponentScope() {
                              return {
                                  record(value) {
                                      localRecords.push(value)
                                      return true
                                  },
                                  snapshot(window) {
                                      return { schemaVersion: 1, scopeId: 'framework-scope-1', framework: 'angular', label: null, window }
                                  },
                                  dispose() {},
                              }
                          },
                      }
                    : {}),
                registerTarget(element, inspect) {
                    if (throwOnRegister) throw new Error('target registry unavailable')
                    for (const current of registrations) {
                        if (current.element === element && current.active) current.unregister()
                    }
                    const registration = { element, inspect, active: true }
                    registrations.push(registration)
                    const unregister = () => {
                        if (throwOnUnregister) throw new Error('target registry cleanup failed')
                        registration.active = false
                    }
                    Object.defineProperty(unregister, 'active', { get: () => registration.active })
                    registration.unregister = unregister
                    return unregister
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
    assert.equal(typeof commonJs.bindCondevAngularAnimationTarget, 'function')
    assert.equal(typeof commonJs.registerCondevAngularPostRender, 'function')
    assert.equal('createCondevAngularAnimationScope' in angularRoot, false)
    assert.equal('bindCondevAngularAnimationTarget' in angularRoot, false)
    assert.equal('createCondevAngularAnimationScope' in require('@condev-monitor/angular'), false)
    assert.equal('bindCondevAngularAnimationTarget' in require('@condev-monitor/angular'), false)
})

test('the decorator-free Angular target binding keeps anonymous ownership and disposes idempotently', () => {
    const harness = createClientHarness()
    const target = { node: 'private-angular-element' }

    const unbind = bindCondevAngularAnimationTarget(harness.client, target)

    assert.equal(unbind.status, 'attached')
    assert.equal(harness.registrations.length, 1)
    assert.equal(harness.registrations[0].element, target)
    assert.deepEqual(harness.registrations[0].inspect(), {
        inventory: { uiFrameworks: ['angular'] },
        owners: [{ relation: 'framework-owner', framework: 'angular' }],
    })
    assert.deepEqual(Object.keys(harness.registrations[0].inspect()).sort(), ['inventory', 'owners'])

    assert.doesNotThrow(() => unbind())
    assert.equal(unbind.status, 'disposed')
    assert.doesNotThrow(() => unbind())
    assert.equal(harness.registrations[0].active, false)
})

test('the decorator-free Angular target binding fails closed around registry setup and cleanup', () => {
    const unavailable = createClientHarness({ throwOnRegister: true })
    const failedBinding = bindCondevAngularAnimationTarget(unavailable.client, { node: 1 })

    assert.equal(failedBinding.status, 'unavailable')
    assert.equal(unavailable.registrations.length, 0)
    assert.doesNotThrow(() => failedBinding())

    const cleanupFailure = createClientHarness({ throwOnUnregister: true })
    const unbind = bindCondevAngularAnimationTarget(cleanupFailure.client, { node: 2 })
    assert.doesNotThrow(() => unbind())
    assert.equal(unbind.status, 'cleanup-failed')
    assert.doesNotThrow(() => unbind())
    assert.equal(cleanupFailure.registrations[0].active, true)
})

test('the target helper and lifecycle scope share same-element ownership without eviction', () => {
    const target = { node: 'shared-angular-element' }
    const scopeFirst = createClientHarness()
    const scope = createCondevAngularAnimationScope({ client: scopeFirst.client, getTarget: () => target })
    scope.postRendered()

    const sharedHelper = bindCondevAngularAnimationTarget(scopeFirst.client, target)
    assert.equal(sharedHelper.status, 'attached')
    assert.equal(scopeFirst.registrations.length, 1)
    assert.equal(scopeFirst.registrations[0].active, true)

    scope.destroy()
    assert.equal(scopeFirst.registrations[0].active, true)
    sharedHelper()
    assert.equal(scopeFirst.registrations[0].active, false)

    const helperFirst = createClientHarness()
    const helper = bindCondevAngularAnimationTarget(helperFirst.client, target)
    const waitingScope = createCondevAngularAnimationScope({ client: helperFirst.client, getTarget: () => target })
    waitingScope.postRendered()

    assert.equal(helper.status, 'attached')
    assert.equal(helperFirst.registrations.length, 1)

    helper()
    waitingScope.postRendered()
    assert.equal(helperFirst.registrations.length, 1)
    assert.equal(helperFirst.registrations[0].active, true)
    waitingScope.destroy()
    assert.equal(helperFirst.registrations[0].active, false)
})

test('Angular bindings expose and recover from replacement by another target provider', () => {
    const target = { node: 'replaceable-angular-element' }
    const helperHarness = createClientHarness()
    const first = bindCondevAngularAnimationTarget(helperHarness.client, target)
    const external = helperHarness.client.animation.registerTarget(target, () => ({ owners: [] }))

    assert.equal(first.status, 'replaced')
    assert.equal(external.active, true)

    const recovered = bindCondevAngularAnimationTarget(helperHarness.client, target)
    assert.equal(recovered.status, 'attached')
    assert.equal(external.active, false)
    recovered()
    first()

    const scopeHarness = createClientHarness()
    const scope = createCondevAngularAnimationScope({ client: scopeHarness.client, getTarget: () => target })
    scope.postRendered()
    const scopeExternal = scopeHarness.client.animation.registerTarget(target, () => ({ owners: [] }))
    assert.equal(scopeExternal.active, true)

    scope.postRendered()
    assert.equal(scopeExternal.active, false)
    assert.equal(scopeHarness.registrations.length, 3)
    assert.equal(scopeHarness.registrations[2].active, true)
    scope.destroy()
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

test('Angular input changes produce closed local check evidence without entering RUM inspection', () => {
    const harness = createClientHarness({ withComponentScope: true })
    const times = [10, 18]
    const scope = createCondevAngularAnimationScope({ client: harness.client, getTarget: () => ({}), now: () => times.shift() })
    scope.postRendered()
    scope.inputChanged(2)
    scope.checkStarted()
    scope.viewChecked()
    assert.deepEqual(harness.localRecords, [
        {
            kind: 'check',
            reason: 'angular-input-change',
            reasonSource: 'angular-input-change',
            durationMs: 8,
            timestampMs: 18,
            updateCauses: ['input'],
            observedCauseCount: 2,
        },
    ])
    const inspect = harness.registrations[0].inspect
    assert.equal(inspect({ inspectionPurpose: 'local', evidenceWindow: { startedAt: 0, endedAt: 20 } }).frameworkScopes.length, 1)
    assert.equal('frameworkScopes' in inspect({ inspectionPurpose: 'rum', evidenceWindow: { startedAt: 0, endedAt: 20 } }), false)
    scope.destroy()
})

test('invalid Angular check windows consume their input-change marker', () => {
    const cases = [
        { name: 'invalid start', read: [Number.NaN, 5, 20, 28] },
        { name: 'clock rollback', read: [10, 5, 20, 28] },
        {
            name: 'throwing end clock',
            read: (() => {
                let call = 0
                return () => {
                    call += 1
                    if (call === 2) throw new Error('clock unavailable')
                    return call === 1 ? 10 : call === 3 ? 20 : 28
                }
            })(),
        },
    ]

    for (const current of cases) {
        const harness = createClientHarness({ withComponentScope: true })
        const now = Array.isArray(current.read) ? () => current.read.shift() : current.read
        const scope = createCondevAngularAnimationScope({ client: harness.client, now })
        scope.inputChanged()
        scope.checkStarted()
        assert.equal(scope.viewChecked(), false, current.name)
        scope.checkStarted()
        assert.equal(scope.viewChecked(), true, current.name)
        assert.deepEqual(harness.localRecords, [], current.name)
        scope.destroy()
    }
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
