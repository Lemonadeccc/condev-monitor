import assert from 'node:assert/strict'
import test from 'node:test'

import { createAnimationTargetAdapterRegistry } from '@condev-monitor/monitor-sdk-animation'
import { createPixiObjectTargetAdapter } from '../build/esm/index.mjs'

function createAnimationHarness() {
    let provider
    let registrationOwner
    let cleanupCount = 0
    return {
        animation: {
            registerTarget(element, inspect, options) {
                assert.ok(element)
                provider = inspect
                registrationOwner = options?.owner
                return () => {
                    cleanupCount += 1
                    provider = undefined
                }
            },
        },
        inspect(context) {
            return provider?.(context) ?? null
        },
        get cleanupCount() {
            return cleanupCount
        },
        get registrationOwner() {
            return registrationOwner
        },
    }
}

test('attributes only an explicitly hit Pixi object through an anonymous local identity', () => {
    const harness = createAnimationHarness()
    const sprite = new Proxy(
        {},
        {
            get() {
                assert.fail('adapter must not inspect Pixi object properties')
            },
        }
    )
    const points = []
    const adapter = createPixiObjectTargetAdapter({
        animation: harness.animation,
        element: {},
        backend: 'webgl2',
        hitTest(point) {
            points.push(point)
            return sprite
        },
        classifyObject(object) {
            assert.equal(object, sprite)
            return 'sprite'
        },
    })

    assert.equal(typeof harness.registrationOwner, 'object')

    assert.equal(harness.inspect({ inspectionPurpose: 'local' }), null)
    assert.deepEqual(adapter.captureTarget({ x: 12, y: 24 }), {
        status: 'hit',
        anonymousId: 'pixi-object-1',
        kind: 'sprite',
    })
    assert.equal(Object.isFrozen(points[0]), true)
    assert.deepEqual(points[0], { x: 12, y: 24 })
    assert.deepEqual(harness.inspect({ inspectionPurpose: 'local' }), {
        inventory: { renderers: ['webgl2'] },
        owners: [{ relation: 'renderer-host', label: 'Pixi sprite pixi-object-1' }],
    })
    assert.equal(harness.inspect({ inspectionPurpose: 'rum' }), null)
    assert.equal(harness.inspect(), null)

    assert.deepEqual(adapter.captureTarget({ x: 13, y: 25 }), {
        status: 'hit',
        anonymousId: 'pixi-object-1',
        kind: 'sprite',
    })
    adapter.clearTarget()
    assert.equal(harness.inspect({ inspectionPurpose: 'local' }), null)
    adapter.dispose()
    adapter.dispose()
    assert.equal(harness.cleanupCount, 1)
})

test('misses, invalid points, callback failures, and identity exhaustion clear stale attribution', () => {
    const harness = createAnimationHarness()
    const objects = [{}, {}]
    let current = objects[0]
    let shouldThrow = false
    const adapter = createPixiObjectTargetAdapter({
        animation: harness.animation,
        element: {},
        backend: 'webgpu',
        maxIdentities: 1,
        hitTest() {
            if (shouldThrow) throw new Error('host hit-test failure')
            return current
        },
        classifyObject: () => 'graphics',
    })

    assert.equal(adapter.captureTarget({ x: 0, y: 0 }).status, 'hit')
    current = null
    assert.deepEqual(adapter.captureTarget({ x: 0, y: 0 }), { status: 'miss' })
    assert.equal(harness.inspect({ inspectionPurpose: 'local' }), null)

    current = objects[0]
    assert.equal(adapter.captureTarget({ x: Number.NaN, y: 0 }).status, 'unavailable')
    shouldThrow = true
    assert.equal(adapter.captureTarget({ x: 0, y: 0 }).status, 'unavailable')
    shouldThrow = false
    current = objects[1]
    assert.equal(adapter.captureTarget({ x: 0, y: 0 }).status, 'unavailable')
    assert.equal(harness.inspect({ inspectionPurpose: 'local' }), null)
    adapter.dispose()
})

test('reentrant capture and disposal fail closed without publishing an inner or stale object', () => {
    const harness = createAnimationHarness()
    let adapter
    let operation = 'reenter'
    adapter = createPixiObjectTargetAdapter({
        animation: harness.animation,
        element: {},
        backend: 'webgl',
        hitTest() {
            if (operation === 'reenter') adapter.captureTarget({ x: 1, y: 1 })
            if (operation === 'dispose') adapter.dispose()
            return {}
        },
    })

    assert.equal(adapter.captureTarget({ x: 0, y: 0 }).status, 'unavailable')
    assert.equal(harness.inspect({ inspectionPurpose: 'local' }), null)
    operation = 'dispose'
    assert.equal(adapter.captureTarget({ x: 0, y: 0 }).status, 'unavailable')
    assert.equal(harness.cleanupCount, 1)
    assert.equal(adapter.captureTarget({ x: 0, y: 0 }).status, 'unavailable')
})

test('hostile point getters and clearTarget re-entry cannot publish a target', () => {
    const harness = createAnimationHarness()
    let adapter
    let clearDuringHitTest = false
    adapter = createPixiObjectTargetAdapter({
        animation: harness.animation,
        element: {},
        backend: 'webgl2',
        hitTest() {
            if (clearDuringHitTest) adapter.clearTarget()
            return {}
        },
    })
    const hostilePoint = {
        get x() {
            adapter.captureTarget({ x: 1, y: 1 })
            return 0
        },
        y: 0,
    }

    assert.equal(adapter.captureTarget(hostilePoint).status, 'unavailable')
    assert.equal(harness.inspect({ inspectionPurpose: 'local' }), null)
    clearDuringHitTest = true
    assert.equal(adapter.captureTarget({ x: 0, y: 0 }).status, 'unavailable')
    assert.equal(harness.inspect({ inspectionPurpose: 'local' }), null)
    adapter.dispose()
})

test('requires a closed backend, host hit test, bounded identities, and cleanup handle', () => {
    const base = {
        animation: createAnimationHarness().animation,
        element: {},
        backend: 'webgl',
        hitTest: () => null,
    }
    assert.throws(() => createPixiObjectTargetAdapter({ ...base, backend: 'canvas2d' }), /backend/)
    assert.throws(() => createPixiObjectTargetAdapter({ ...base, hitTest: null }), /hitTest/)
    assert.throws(() => createPixiObjectTargetAdapter({ ...base, maxIdentities: 0 }), /maxIdentities/)
    assert.throws(
        () =>
            createPixiObjectTargetAdapter({
                ...base,
                animation: { registerTarget: () => null },
            }),
        /cleanup handle/
    )
})

test('coexists with framework and renderer providers on the same Canvas regardless of disposal order', () => {
    const canvas = {}
    const registry = createAnimationTargetAdapterRegistry('pixi-composition', '1')
    const frameworkOwner = {}
    const rendererOwner = {}
    const unregisterFramework = registry.register(
        canvas,
        () => ({ inventory: { uiFrameworks: ['react'] }, owners: [{ relation: 'framework-owner', framework: 'react' }] }),
        { owner: frameworkOwner }
    )
    const unregisterRenderer = registry.register(
        canvas,
        () => ({ renderer: { family: 'webgl2', capability: { state: 'supported', observed: false, buffered: false } } }),
        { owner: rendererOwner }
    )
    const sprite = {}
    const pixi = createPixiObjectTargetAdapter({
        animation: { registerTarget: registry.register },
        element: canvas,
        backend: 'webgl2',
        hitTest: () => sprite,
        classifyObject: () => 'sprite',
    })
    assert.equal(pixi.captureTarget({ x: 1, y: 2 }).status, 'hit')

    let inspection = registry.adapter.inspect(canvas, {
        inspectionPurpose: 'local',
        evidenceWindow: { startedAt: 0, endedAt: 1, relation: 'selection-window' },
    })
    assert.deepEqual(inspection.inventory.uiFrameworks, ['react'])
    assert.equal(inspection.owners.length, 2)
    assert.equal(inspection.renderers.length, 1)

    unregisterRenderer()
    inspection = registry.adapter.inspect(canvas, {
        inspectionPurpose: 'local',
        evidenceWindow: { startedAt: 0, endedAt: 1, relation: 'selection-window' },
    })
    assert.equal(inspection.owners.length, 2)
    assert.equal(inspection.renderers.length, 0)
    pixi.dispose()
    inspection = registry.adapter.inspect(canvas, {
        inspectionPurpose: 'local',
        evidenceWindow: { startedAt: 0, endedAt: 1, relation: 'selection-window' },
    })
    assert.equal(inspection.owners.length, 1)
    unregisterFramework()
    assert.equal(registry.adapter.canInspect(canvas), false)
})
