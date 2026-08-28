import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import test from 'node:test'
import { renderToString } from 'solid-js/web'

import { init as browserAnimationInit } from '@condev-monitor/monitor-sdk-browser/animation'
import { condevAnimationTarget, createCondevSolidAnimationScope, init, useCondevAnimation } from '@condev-monitor/solid/animation'
import * as solidRoot from '@condev-monitor/solid'

const require = createRequire(import.meta.url)

function createClientHarness({ throwOnRecord = false, throwOnRegister = false, rejectOnRecord = false } = {}) {
    const samples = []
    const registrations = []
    return {
        samples,
        registrations,
        client: {
            animation: {
                recordWorkStats(sample) {
                    if (throwOnRecord) throw new Error('monitor unavailable')
                    if (rejectOnRecord) return false
                    samples.push(sample)
                    return true
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

test('Solid ESM and CommonJS animation entries reuse Browser init while the package root stays framework-neutral', () => {
    assert.equal(init, browserAnimationInit)
    assert.equal(typeof require('@condev-monitor/solid/animation').init, 'function')
    assert.equal('useCondevAnimation' in solidRoot, false)
    assert.equal('useCondevAnimation' in require('@condev-monitor/solid'), false)
})

test('a browser-conditioned element owner releases its target before the outer Solid scope is disposed', () => {
    const script = String.raw`
        import { createRoot } from 'solid-js'
        import { condevAnimationTarget, useCondevAnimation } from '@condev-monitor/solid/animation'

        let unregisterCalls = 0
        const client = {
            animation: {
                recordWorkStats() { return true },
                registerTarget() { return () => { unregisterCalls += 1 } },
            },
        }
        const owner = createRoot(disposeOuter => {
            const scope = useCondevAnimation({ client })
            const disposeElement = createRoot(dispose => {
                condevAnimationTarget({ node: 'private-element' }, () => scope)
                return dispose
            })
            return { disposeElement, disposeOuter, scope }
        })
        await Promise.resolve()
        const beforeElementUnmount = unregisterCalls
        owner.disposeElement()
        const afterElementUnmount = unregisterCalls
        const scopeAfterElementUnmount = owner.scope.getDiagnostics().state
        owner.disposeOuter()
        process.stdout.write(JSON.stringify({ beforeElementUnmount, afterElementUnmount, scopeAfterElementUnmount }))
    `
    const result = JSON.parse(
        execFileSync(process.execPath, ['--conditions=browser', '--input-type=module', '--eval', script], {
            cwd: process.cwd(),
            encoding: 'utf8',
        })
    )

    assert.deepEqual(result, { beforeElementUnmount: 0, afterElementUnmount: 1, scopeAfterElementUnmount: 'active' })
})

test('Solid server rendering starts no monitor work and registers no DOM target', () => {
    const harness = createClientHarness()
    const output = renderToString(() => {
        useCondevAnimation({ client: harness.client })
        return 'server-safe'
    })

    assert.equal(output, 'server-safe')
    assert.deepEqual(harness.samples, [])
    assert.deepEqual(harness.registrations, [])
})

test('explicit reactive work records only synchronous host script self-time', () => {
    const harness = createClientHarness()
    const times = [10, 18]
    const scope = createCondevSolidAnimationScope({ client: harness.client, now: () => times.shift() })

    const result = scope.measureReactiveWork(() => ({ privateSignalValue: 42 }))

    assert.deepEqual(result, { privateSignalValue: 42 })
    assert.deepEqual(harness.samples, [
        {
            source: 'host',
            timestampMs: 18,
            workMs: 8,
            category: 'script',
        },
    ])
    assert.deepEqual(Object.keys(harness.samples[0]).sort(), ['category', 'source', 'timestampMs', 'workMs'])
    scope.destroy()
})

test('application callback errors keep their identity and are never converted into monitor failures', () => {
    const harness = createClientHarness()
    const scope = createCondevSolidAnimationScope({ client: harness.client, now: () => 1 })
    const applicationError = new Error('application effect failed')

    assert.throws(
        () =>
            scope.measureReactiveWork(() => {
                throw applicationError
            }),
        error => error === applicationError
    )
    assert.deepEqual(harness.samples, [])
    assert.deepEqual(scope.getDiagnostics(), {
        state: 'active',
        targetRegistrationErrors: 0,
        targetCleanupErrors: 0,
        clockErrors: 0,
        sampleRecordErrors: 0,
        sampleRejected: 0,
    })
    scope.destroy()
})

test('explicit target bindings retain only anonymous Solid ownership and have per-element disposers', () => {
    const harness = createClientHarness()
    const scope = createCondevSolidAnimationScope({ client: harness.client })
    const first = { node: 'private-first' }
    const second = { node: 'private-second' }

    const unbindFirst = scope.bindTarget(first)
    const unbindSecond = scope.bindTarget(second)
    assert.equal(harness.registrations.length, 2)
    assert.equal(harness.registrations[0].element, first)
    assert.deepEqual(harness.registrations[0].inspect(), {
        inventory: { uiFrameworks: ['solid'] },
        owners: [{ relation: 'framework-owner', framework: 'solid' }],
    })
    assert.deepEqual(Object.keys(harness.registrations[0].inspect()).sort(), ['inventory', 'owners'])

    assert.equal(harness.registrations[1].element, second)
    unbindFirst()
    assert.equal(harness.registrations[0].active, false)
    assert.equal(harness.registrations[1].active, true)
    scope.destroy()
    assert.equal(harness.registrations[1].active, false)
    assert.doesNotThrow(() => unbindSecond())
})

test('invalid clocks and monitor failures fail closed while callbacks keep running', () => {
    const throwingHarness = createClientHarness({ throwOnRecord: true, throwOnRegister: true })
    const times = [20, 10, Number.NaN]
    const scope = createCondevSolidAnimationScope({ client: throwingHarness.client, now: () => times.shift() })
    let callbackCalls = 0

    scope.bindTarget({ node: 1 })
    assert.equal(
        scope.measureReactiveWork(() => {
            callbackCalls += 1
            return 'reverse-clock'
        }),
        'reverse-clock'
    )
    assert.equal(
        scope.measureReactiveWork(() => {
            callbackCalls += 1
            return 'invalid-clock'
        }),
        'invalid-clock'
    )
    assert.equal(callbackCalls, 2)
    assert.deepEqual(throwingHarness.samples, [])
    assert.deepEqual(scope.getDiagnostics(), {
        state: 'degraded',
        targetRegistrationErrors: 1,
        targetCleanupErrors: 0,
        clockErrors: 2,
        sampleRecordErrors: 0,
        sampleRejected: 0,
    })

    const recordFailure = createCondevSolidAnimationScope({ client: throwingHarness.client, now: () => 1 })
    assert.equal(
        recordFailure.measureReactiveWork(() => 7),
        7
    )
    assert.equal(recordFailure.getDiagnostics().sampleRecordErrors, 1)

    const rejectedHarness = createClientHarness({ rejectOnRecord: true })
    const rejected = createCondevSolidAnimationScope({ client: rejectedHarness.client, now: () => 1 })
    assert.equal(
        rejected.measureReactiveWork(() => 9),
        9
    )
    assert.equal(rejected.getDiagnostics().sampleRejected, 1)

    scope.destroy()
    recordFailure.destroy()
    rejected.destroy()
})

test('target unregister failures are bounded local diagnostics and never break owner cleanup', () => {
    const scope = createCondevSolidAnimationScope({
        client: {
            animation: {
                recordWorkStats() {
                    return true
                },
                registerTarget() {
                    return () => {
                        throw new Error('registry cleanup failed')
                    }
                },
            },
        },
    })
    const unbind = scope.bindTarget({ node: 1 })

    assert.doesNotThrow(() => unbind())
    assert.equal(scope.getDiagnostics().targetCleanupErrors, 1)
    scope.destroy()
    assert.equal(scope.getDiagnostics().state, 'destroyed')
})

test('cleanup registration is idempotent and a failed owner registration releases the scope', () => {
    const harness = createClientHarness()
    let cleanup
    const scope = useCondevAnimation({
        client: harness.client,
        registerCleanup(callback) {
            cleanup = callback
        },
    })
    scope.bindTarget({ node: 1 })

    cleanup()
    cleanup()
    scope.destroy()
    assert.equal(harness.registrations[0].active, false)
    assert.equal(scope.getDiagnostics().state, 'destroyed')

    assert.throws(
        () =>
            useCondevAnimation({
                client: harness.client,
                registerCleanup() {
                    throw new Error('outside Solid owner')
                },
            }),
        /outside Solid owner/
    )
})
