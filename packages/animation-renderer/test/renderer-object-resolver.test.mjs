import assert from 'node:assert/strict'
import test from 'node:test'

import { createRendererObjectResolverRegistry, createThreeRaycastObjectResolver } from '../build/esm/index.mjs'

test('returns only hit, miss, unavailable, and an explicitly enabled bounded local point', () => {
    const registry = createRendererObjectResolverRegistry()
    const seen = []
    const unregister = registry.register(
        'hero.product',
        point => {
            seen.push(point)
            return { status: 'hit', localPoint: { x: 0.25, y: -0.5 }, meshName: 'secret', userData: { secret: true } }
        },
        { includeLocalPoint: true }
    )

    assert.deepEqual(registry.resolve('hero.product', { clientX: 10, clientY: 20 }), {
        status: 'hit',
        localPoint: { x: 0.25, y: -0.5 },
    })
    assert.equal(Object.isFrozen(seen[0]), true)
    assert.deepEqual(seen[0], { clientX: 10, clientY: 20 })
    assert.deepEqual(Object.keys(registry.resolve('missing', { clientX: 0, clientY: 0 })), ['status'])

    unregister()
    unregister()
    assert.deepEqual(registry.resolve('hero.product', { clientX: 10, clientY: 20 }), { status: 'unavailable' })
    registry.dispose()
})

test('rejects duplicate live subject keys and allows registration after idempotent cleanup', () => {
    const registry = createRendererObjectResolverRegistry()
    const firstCleanup = registry.register('scene.cta', () => 'hit')
    assert.throws(() => registry.register('scene.cta', () => 'miss'), /already registered/)
    firstCleanup()
    firstCleanup()

    const secondCleanup = registry.register('scene.cta', () => 'miss')
    assert.deepEqual(registry.resolve('scene.cta'), { status: 'miss' })
    secondCleanup()
    registry.dispose()
    registry.dispose()
    assert.throws(() => registry.register('scene.cta', () => 'hit'), /disposed/)
})

test('cleanup during resolution invalidates the in-flight result and permits a later replacement', () => {
    const registry = createRendererObjectResolverRegistry()
    let cleanup
    cleanup = registry.register('scene.dynamic', () => {
        cleanup()
        return 'hit'
    })

    assert.deepEqual(registry.resolve('scene.dynamic'), { status: 'unavailable' })
    const replacementCleanup = registry.register('scene.dynamic', () => 'miss')
    assert.deepEqual(registry.resolve('scene.dynamic'), { status: 'miss' })
    replacementCleanup()
    registry.dispose()
})

test('host exceptions, invalid evidence, hostile getters, and re-entry fail closed', () => {
    const registry = createRendererObjectResolverRegistry()
    registry.register('throws', () => {
        throw new Error('host failure')
    })
    registry.register('invalid-status', () => ({ status: 'caused-frame', localPoint: { x: 0, y: 0 } }))
    registry.register('invalid-point', () => ({ status: 'hit', localPoint: { x: 2, y: 0 } }), { includeLocalPoint: true })
    registry.register('hostile', () => ({
        get status() {
            registry.resolve('hostile')
            return 'hit'
        },
    }))
    registry.register('reentrant', () => registry.resolve('reentrant'))

    assert.deepEqual(registry.resolve('throws'), { status: 'unavailable' })
    assert.deepEqual(registry.resolve('invalid-status'), { status: 'unavailable' })
    assert.deepEqual(registry.resolve('invalid-point'), { status: 'unavailable' })
    assert.deepEqual(registry.resolve('hostile'), { status: 'unavailable' })
    assert.deepEqual(registry.resolve('reentrant'), { status: 'unavailable' })
    assert.deepEqual(
        registry.resolve('throws', {
            get clientX() {
                throw new Error('hostile point')
            },
            clientY: 0,
        }),
        { status: 'unavailable' }
    )
    registry.dispose()
})

test('Three helper uses only public raycast APIs and never reads intersection/object metadata', () => {
    const camera = new Proxy(
        {},
        {
            get() {
                assert.fail('camera properties must not be read')
            },
        }
    )
    const object = new Proxy(
        {},
        {
            get() {
                assert.fail('object properties must not be read')
            },
        }
    )
    const intersection = new Proxy(
        {},
        {
            get() {
                assert.fail('intersection entries must not be read')
            },
        }
    )
    const calls = []
    let hit = true
    const resolver = createThreeRaycastObjectResolver({
        canvas: {
            getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 100 }),
        },
        camera,
        object,
        recursive: true,
        raycaster: {
            setFromCamera(point, receivedCamera) {
                calls.push(['set', point, receivedCamera])
            },
            intersectObject(receivedObject, recursive) {
                calls.push(['intersect', receivedObject, recursive])
                return hit ? [intersection] : []
            },
            intersectObjects() {
                assert.fail('single-object resolver must not call intersectObjects')
            },
        },
    })
    const registry = createRendererObjectResolverRegistry()
    registry.register('hero.mesh', resolver, { includeLocalPoint: true })

    assert.deepEqual(registry.resolve('hero.mesh', { clientX: 150, clientY: 75 }), {
        status: 'hit',
        localPoint: { x: -0.5, y: 0.5 },
    })
    assert.equal(Object.isFrozen(calls[0][1]), true)
    assert.equal(calls[0][2], camera)
    assert.equal(calls[1][1], object)
    assert.equal(calls[1][2], true)

    hit = false
    assert.deepEqual(registry.resolve('hero.mesh', { clientX: 200, clientY: 100 }), {
        status: 'miss',
        localPoint: { x: 0, y: 0 },
    })
    assert.deepEqual(registry.resolve('hero.mesh', { clientX: 99, clientY: 100 }), { status: 'miss' })
    registry.dispose()
})

test('Three helper supports dynamic host sources and fails closed when they or public methods fail', () => {
    const objects = [{}, {}]
    let mode = 'hit'
    const resolver = createThreeRaycastObjectResolver({
        canvas: {
            getBoundingClientRect() {
                if (mode === 'rect-throws') throw new Error('rect')
                return { left: 0, top: 0, width: mode === 'zero-size' ? 0 : 10, height: 10 }
            },
        },
        getCamera: () => (mode === 'no-camera' ? null : {}),
        getObjects: () => (mode === 'no-objects' ? null : objects),
        raycaster: {
            setFromCamera() {
                if (mode === 'set-throws') throw new Error('ray')
            },
            intersectObject() {
                assert.fail('object list resolver must not call intersectObject')
            },
            intersectObjects(received) {
                assert.equal(received, objects)
                if (mode === 'intersect-throws') throw new Error('intersect')
                if (mode === 'bad-length') return { length: Number.NaN }
                return [{}]
            },
        },
    })

    assert.equal(resolver.resolve({ clientX: 5, clientY: 5 }).status, 'hit')
    for (const unavailableMode of ['rect-throws', 'zero-size', 'no-camera', 'no-objects', 'set-throws', 'intersect-throws', 'bad-length']) {
        mode = unavailableMode
        assert.deepEqual(resolver.resolve({ clientX: 5, clientY: 5 }), 'unavailable')
    }
})

test('validates opaque subject keys and exactly one Three camera and object source', () => {
    const registry = createRendererObjectResolverRegistry()
    assert.throws(() => registry.register('selector #secret', () => 'hit'), /subjectKey/)
    assert.throws(() => registry.register('x'.repeat(129), () => 'hit'), /subjectKey/)
    assert.throws(() => registry.register('valid', null), /resolver/)

    const raycaster = {
        setFromCamera() {},
        intersectObject: () => [],
        intersectObjects: () => [],
    }
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) }
    assert.throws(() => createThreeRaycastObjectResolver({ canvas, raycaster, object: {} }), /camera/)
    assert.throws(() => createThreeRaycastObjectResolver({ canvas, raycaster, camera: {}, object: {}, objects: [] }), /exactly one object/)
    registry.dispose()
})
