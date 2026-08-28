import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'

import { init as browserAnimationInit } from '@condev-monitor/monitor-sdk-browser/animation'
import { condevAnimationTarget, createCondevSvelteAnimationScope, init, useCondevAnimation } from '@condev-monitor/svelte/animation'
import * as svelteRoot from '@condev-monitor/svelte'

const require = createRequire(import.meta.url)

function deferred() {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

function createClientHarness({ throwOnCreate = false, throwOnRecord = false, throwOnRegister = false, rejectOnRecord = false } = {}) {
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
                    assert.equal(framework, 'svelte')
                    if (throwOnCreate) throw new Error('framework probe unavailable')
                    return {
                        recordCommit() {
                            throw new Error('Svelte adapter must not record commit evidence')
                        },
                        recordUpdateWindow(sample) {
                            if (throwOnRecord) throw new Error('monitor unavailable')
                            if (rejectOnRecord) return false
                            samples.push(sample)
                            return true
                        },
                        recordCheckWindow() {
                            throw new Error('Svelte adapter must not record component check evidence')
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

test('the ESM-only Svelte animation entry reuses Browser init while the framework-neutral root supports CommonJS', () => {
    assert.equal(init, browserAnimationInit)
    assert.throws(() => require('@condev-monitor/svelte/animation'), /No "exports" main defined|not defined by "exports"/)
    assert.equal('useCondevAnimation' in svelteRoot, false)
    assert.equal('useCondevAnimation' in require('@condev-monitor/svelte'), false)
})

test('a Svelte 5 runes component accepts the tracked effect and target action API', () => {
    const source = String.raw`
        <script>
            import { condevAnimationTarget, useCondevAnimation } from '@condev-monitor/svelte/animation'
            let count = $state(0)
            const scope = useCondevAnimation({ client: globalThis.monitorClient })
            $effect.pre(() => scope.trackPendingStateWindow(count))
        </script>
        <button use:condevAnimationTarget={scope} onclick={() => count += 1}>{count}</button>
    `

    assert.doesNotThrow(() => compile(source, { generate: 'client', runes: true }))
})

test('a real Svelte server render does not run effects or actions and remains cleanup-safe', async () => {
    const harness = createClientHarness()
    globalThis.monitorClient = harness.client
    const source = String.raw`
        <script>
            import { condevAnimationTarget, useCondevAnimation } from '@condev-monitor/svelte/animation'
            let count = $state(0)
            const scope = useCondevAnimation({ client: globalThis.monitorClient })
            $effect.pre(() => scope.trackPendingStateWindow(count))
        </script>
        <button use:condevAnimationTarget={scope}>{count}</button>
    `
    const compiled = compile(source, { generate: 'server', runes: true })
        .js.code.replaceAll("'svelte/internal/server'", JSON.stringify(import.meta.resolve('svelte/internal/server')))
        .replaceAll("'@condev-monitor/svelte/animation'", JSON.stringify(import.meta.resolve('@condev-monitor/svelte/animation')))
    const componentModule = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

    try {
        const result = render(componentModule.default)
        assert.match(result.body, /<button>0<\/button>/)
        assert.deepEqual(harness.samples, [])
        assert.deepEqual(harness.registrations, [])
        assert.equal(harness.disposeCalls, 1)
    } finally {
        delete globalThis.monitorClient
    }
})

test('the first effect run warms the scope and later runs record a tick-bounded pending-state window', async () => {
    const harness = createClientHarness()
    const times = [10, 18]
    const scope = createCondevSvelteAnimationScope({
        client: harness.client,
        now: () => times.shift(),
        tick: () => Promise.resolve(),
    })

    scope.trackPendingStateWindow('initial dependency')
    await Promise.resolve()
    assert.deepEqual(harness.samples, [])

    scope.trackPendingStateWindow('updated dependency')
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(harness.samples, [{ updateWindowMs: 8, timestampMs: 18 }])
    scope.destroy()
})

test('overlapping effects and destroy invalidate late tick samples', async () => {
    const harness = createClientHarness()
    const first = deferred()
    const second = deferred()
    const pending = [first.promise, second.promise]
    const times = [10, 20, 28]
    const scope = createCondevSvelteAnimationScope({
        client: harness.client,
        now: () => times.shift(),
        tick: () => pending.shift(),
    })

    scope.trackPendingStateWindow('warm')
    scope.trackPendingStateWindow('first')
    scope.trackPendingStateWindow('second')
    first.resolve()
    await Promise.resolve()
    assert.deepEqual(harness.samples, [])
    second.resolve()
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(harness.samples, [{ updateWindowMs: 8, timestampMs: 28 }])

    const late = deferred()
    const destroyScope = createCondevSvelteAnimationScope({
        client: harness.client,
        now: () => 30,
        tick: () => late.promise,
    })
    destroyScope.trackPendingStateWindow('warm')
    destroyScope.trackPendingStateWindow('pending')
    destroyScope.destroy()
    late.resolve()
    await Promise.resolve()
    assert.equal(harness.samples.length, 1)
    scope.destroy()
})

test('the target action retains only anonymous Svelte ownership and supports scope-switch cleanup', () => {
    const firstHarness = createClientHarness()
    const secondHarness = createClientHarness()
    const firstScope = createCondevSvelteAnimationScope({ client: firstHarness.client })
    const secondScope = createCondevSvelteAnimationScope({ client: secondHarness.client })
    const element = { node: 'private-element' }

    const action = condevAnimationTarget(element, firstScope)
    assert.equal(firstHarness.registrations.length, 1)
    assert.equal(firstHarness.registrations[0].element, element)
    assert.deepEqual(firstHarness.registrations[0].inspect(), {
        inventory: { uiFrameworks: ['svelte'] },
        owners: [{ relation: 'framework-owner', framework: 'svelte' }],
    })
    assert.deepEqual(Object.keys(firstHarness.registrations[0].inspect()).sort(), ['inventory', 'owners'])

    action.update(firstScope)
    assert.equal(firstHarness.registrations.length, 1)
    action.update(secondScope)
    assert.equal(firstHarness.registrations[0].active, false)
    assert.equal(secondHarness.registrations.length, 1)
    assert.equal(secondHarness.registrations[0].active, true)

    secondScope.destroy()
    assert.equal(secondHarness.registrations[0].active, false)
    assert.doesNotThrow(() => action.destroy())
    firstScope.destroy()
})

test('useCondevAnimation registers idempotent cleanup through the public destroy lifecycle', () => {
    const harness = createClientHarness()
    let cleanup
    const scope = useCondevAnimation({
        client: harness.client,
        registerDestroy(callback) {
            cleanup = callback
        },
    })

    assert.equal(typeof cleanup, 'function')
    cleanup()
    cleanup()
    scope.destroy()
    assert.equal(harness.disposeCalls, 1)

    const failedHarness = createClientHarness()
    assert.throws(
        () =>
            useCondevAnimation({
                client: failedHarness.client,
                registerDestroy() {
                    throw new Error('outside component initialization')
                },
            }),
        /outside component initialization/
    )
    assert.equal(failedHarness.disposeCalls, 1)
})

test('invalid clocks, rejected ticks, and monitor failures fail closed', async () => {
    const harness = createClientHarness({ throwOnRecord: true, throwOnRegister: true })
    const times = [20, 10, Number.NaN]
    const scope = createCondevSvelteAnimationScope({
        client: harness.client,
        now: () => times.shift(),
        tick: () => Promise.resolve(),
    })

    scope.trackPendingStateWindow('warm')
    scope.trackPendingStateWindow('reverse clock')
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(harness.samples, [])

    scope.trackPendingStateWindow('invalid clock')

    const failedAction = condevAnimationTarget({ node: 1 }, scope)
    assert.doesNotThrow(() => failedAction.destroy())
    assert.doesNotThrow(() => scope.destroy())

    const throwingTick = createCondevSvelteAnimationScope({
        client: harness.client,
        now: () => 1,
        tick: () => {
            throw new Error('tick unavailable')
        },
    })
    throwingTick.trackPendingStateWindow('warm')
    assert.doesNotThrow(() => throwingTick.trackPendingStateWindow('throwing tick'))
    throwingTick.destroy()

    const rejectingTick = createCondevSvelteAnimationScope({
        client: harness.client,
        now: () => 1,
        tick: () => Promise.reject(new Error('tick rejected')),
    })
    rejectingTick.trackPendingStateWindow('warm')
    assert.doesNotThrow(() => rejectingTick.trackPendingStateWindow('rejected tick'))
    await Promise.resolve()
    await Promise.resolve()
    rejectingTick.destroy()

    const missingProbe = createCondevSvelteAnimationScope({
        client: createClientHarness({ throwOnCreate: true }).client,
        tick: () => Promise.resolve(),
        now: () => 1,
    })
    missingProbe.trackPendingStateWindow('warm')
    missingProbe.trackPendingStateWindow('update')
    await Promise.resolve()
    assert.deepEqual(harness.samples, [])
    missingProbe.destroy()
})

test('bounded local diagnostics distinguish adapter failures from an idle scope', async () => {
    const healthy = createCondevSvelteAnimationScope({ client: createClientHarness().client })
    assert.deepEqual(healthy.getDiagnostics(), {
        state: 'active',
        frameworkProbeErrors: 0,
        targetRegistrationErrors: 0,
        tickErrors: 0,
        clockErrors: 0,
        sampleRecordErrors: 0,
        sampleRejected: 0,
    })
    healthy.destroy()
    assert.equal(healthy.getDiagnostics().state, 'destroyed')

    const harness = createClientHarness({ rejectOnRecord: true, throwOnRegister: true })
    const scope = createCondevSvelteAnimationScope({ client: harness.client, now: () => 1, tick: () => Promise.resolve() })
    condevAnimationTarget({ node: 1 }, scope)
    scope.trackPendingStateWindow('warm')
    scope.trackPendingStateWindow('update')
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(scope.getDiagnostics(), {
        state: 'degraded',
        frameworkProbeErrors: 0,
        targetRegistrationErrors: 1,
        tickErrors: 0,
        clockErrors: 0,
        sampleRecordErrors: 0,
        sampleRejected: 1,
    })
    scope.destroy()
})
