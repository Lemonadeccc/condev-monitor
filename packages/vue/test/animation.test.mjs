import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { createRenderer, defineComponent, h, KeepAlive, nextTick, ref } from 'vue'

import { init as browserAnimationInit } from '@condev-monitor/monitor-sdk-browser/animation'
import { createCondevVueAnimationScope, init, useCondevAnimation } from '@condev-monitor/vue/animation'
import * as vueRoot from '@condev-monitor/vue'

const require = createRequire(import.meta.url)

function createTestRenderer() {
    return createRenderer({
        patchProp(element, key, _previous, next) {
            element.props[key] = next
        },
        insert(child, parent, anchor) {
            const index = anchor ? parent.children.indexOf(anchor) : -1
            if (index < 0) parent.children.push(child)
            else parent.children.splice(index, 0, child)
            child.parent = parent
        },
        remove(child) {
            const index = child.parent?.children.indexOf(child) ?? -1
            if (index >= 0) child.parent.children.splice(index, 1)
            child.parent = undefined
        },
        createElement(type) {
            return { type, props: {}, children: [], parent: undefined, text: '' }
        },
        createText(text) {
            return { type: 'text', props: {}, children: [], parent: undefined, text }
        },
        createComment(text) {
            return { type: 'comment', props: {}, children: [], parent: undefined, text }
        },
        setText(node, text) {
            node.text = text
        },
        setElementText(node, text) {
            node.text = text
        },
        parentNode(node) {
            return node.parent ?? null
        },
        nextSibling(node) {
            if (!node.parent) return null
            const index = node.parent.children.indexOf(node)
            return node.parent.children[index + 1] ?? null
        },
    })
}

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
                    assert.equal(framework, 'vue')
                    if (throwOnCreate) throw new Error('framework probe unavailable')
                    return {
                        recordCommit() {
                            throw new Error('Vue adapter must not record commit evidence')
                        },
                        recordUpdateWindow(sample) {
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

test('the Vue animation entry reuses the Browser animation init in ESM and CommonJS', () => {
    assert.equal(init, browserAnimationInit)
    const commonJs = require('@condev-monitor/vue/animation')
    const commonJsBrowserAnimation = require('@condev-monitor/monitor-sdk-browser/animation')
    assert.equal(commonJs.init, commonJsBrowserAnimation.init)
    assert.equal(typeof commonJs.createCondevVueAnimationScope, 'function')
    assert.equal(typeof commonJs.useCondevAnimation, 'function')
    assert.equal('useCondevAnimation' in vueRoot, false)
    assert.equal('useCondevAnimation' in require('@condev-monitor/vue'), false)
})

test('useCondevAnimation records a public Vue lifecycle update window', async () => {
    const harness = createClientHarness()
    const times = [10, 18]
    const value = ref(0)
    const renderer = createTestRenderer()
    const root = { type: 'root', props: {}, children: [], parent: undefined, text: '' }
    const App = defineComponent({
        setup() {
            useCondevAnimation({ client: harness.client, now: () => times.shift() })
            return () => h('div', String(value.value))
        },
    })

    const app = renderer.createApp(App)
    app.mount(root)
    value.value += 1
    await nextTick()

    assert.deepEqual(harness.samples, [{ updateWindowMs: 8, timestampMs: 18 }])
    app.unmount()
    assert.equal(harness.disposeCalls, 1)
})

test('the scope registers only anonymous Vue ownership and cleans up targets', () => {
    const harness = createClientHarness()
    const firstTarget = { node: 1 }
    const secondTarget = { node: 2 }
    let target = firstTarget
    const scope = createCondevVueAnimationScope({ client: harness.client, getTarget: () => target, now: () => 1 })

    scope.mounted()
    assert.equal(harness.registrations.length, 1)
    assert.equal(harness.registrations[0].element, firstTarget)
    assert.deepEqual(harness.registrations[0].inspect(), {
        inventory: { uiFrameworks: ['vue'] },
        owners: [{ relation: 'framework-owner', framework: 'vue' }],
    })
    assert.deepEqual(Object.keys(harness.registrations[0].inspect()).sort(), ['inventory', 'owners'])

    target = secondTarget
    scope.beforeUpdate()
    scope.updated()
    assert.equal(harness.registrations.length, 2)
    assert.equal(harness.registrations[0].active, false)
    assert.equal(harness.registrations[1].active, true)

    scope.deactivated()
    assert.equal(harness.registrations[1].active, false)
    scope.beforeUpdate()
    assert.equal(scope.updated(), false)
    assert.equal(harness.samples.length, 1)
    scope.activated()
    assert.equal(harness.registrations.length, 3)
    assert.equal(harness.registrations[2].active, true)

    scope.dispose()
    scope.dispose()
    assert.equal(harness.registrations[2].active, false)
    assert.equal(harness.disposeCalls, 1)
})

test('a failed target replacement releases the previous element registration', () => {
    const harness = createClientHarness()
    let target = { node: 1 }
    const scope = createCondevVueAnimationScope({ client: harness.client, getTarget: () => target, now: () => 1 })

    scope.mounted()
    assert.equal(harness.registrations[0].active, true)
    harness.client.animation.registerTarget = () => {
        throw new Error('target registry unavailable')
    }
    target = { node: 2 }
    scope.beforeUpdate()
    assert.equal(scope.updated(), true)
    assert.equal(harness.registrations[0].active, false)
    scope.dispose()
})

test('useCondevAnimation follows real KeepAlive activation lifecycle', async () => {
    const harness = createClientHarness()
    const visible = ref(true)
    const target = { node: 'kept-alive' }
    const renderer = createTestRenderer()
    const root = { type: 'root', props: {}, children: [], parent: undefined, text: '' }
    const Child = defineComponent({
        setup() {
            useCondevAnimation({ client: harness.client, getTarget: () => target })
            return () => h('div', 'child')
        },
    })
    const Replacement = defineComponent({ setup: () => () => h('span', 'replacement') })
    const App = defineComponent({
        setup: () => () => h(KeepAlive, null, [visible.value ? h(Child) : h(Replacement)]),
    })

    const app = renderer.createApp(App)
    app.mount(root)
    assert.equal(harness.registrations.length, 1)
    assert.equal(harness.registrations[0].active, true)

    visible.value = false
    await nextTick()
    assert.equal(harness.registrations[0].active, false)
    assert.equal(harness.disposeCalls, 0)

    visible.value = true
    await nextTick()
    assert.equal(harness.registrations.length, 2)
    assert.equal(harness.registrations[1].active, true)

    app.unmount()
    assert.equal(harness.registrations[1].active, false)
    assert.equal(harness.disposeCalls, 1)
})

test('invalid clocks and monitor failures cannot alter Vue lifecycle behavior', () => {
    const failed = createClientHarness({ throwOnRecord: true, throwOnRegister: true })
    const times = [20, 10, Number.NaN, 30]
    const scope = createCondevVueAnimationScope({
        client: failed.client,
        getTarget: () => ({ node: 'private' }),
        now: () => times.shift(),
    })

    assert.doesNotThrow(() => scope.mounted())
    scope.beforeUpdate()
    assert.equal(scope.updated(), false)
    scope.beforeUpdate()
    assert.equal(scope.updated(), false)
    assert.equal(failed.samples.length, 0)
    assert.doesNotThrow(() => scope.dispose())

    const unavailable = createClientHarness({ throwOnCreate: true })
    const noProbeScope = createCondevVueAnimationScope({ client: unavailable.client, now: () => 1 })
    assert.doesNotThrow(() => noProbeScope.beforeUpdate())
    assert.equal(noProbeScope.updated(), false)
    assert.doesNotThrow(() => noProbeScope.dispose())
})
