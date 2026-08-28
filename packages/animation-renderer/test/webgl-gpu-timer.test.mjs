import assert from 'node:assert/strict'
import test from 'node:test'

import { createRendererHostProbe, createThreeRendererProbe } from '@condev-monitor/monitor-sdk-animation'

import { WebGlGpuTimerOptionsError, createWebGlGpuTimer as createWebGlGpuTimerFactory } from '../build/esm/index.mjs'

const createWebGlGpuTimer = options =>
    createWebGlGpuTimerFactory({
        disjointQueryOwnership: 'exclusive',
        ...options,
    })

const ENUM = {
    QUERY_COUNTER_BITS: 0x8864,
    CURRENT_QUERY: 0x8865,
    QUERY_RESULT: 0x8866,
    QUERY_RESULT_AVAILABLE: 0x8867,
    TIME_ELAPSED: 0x88bf,
    GPU_DISJOINT: 0x8fbb,
}

function createFakeContext(backend, options = {}) {
    const calls = []
    const queries = []
    let currentQuery = null
    let hostCurrentQuery = null
    let disjoint = false
    let contextLost = options.initialContextLost ?? false
    let nextQueryId = 1
    const throwOn = new Set(options.throwOn ?? [])
    const extensionAvailable = options.extensionAvailable ?? true
    const counterBits = options.counterBits ?? 64

    const hit = name => {
        calls.push(name)
        options.onCall?.(name)
        if (throwOn.has(name)) throw new Error(`fake ${name} failure`)
    }
    const makeQuery = () => {
        const query = { id: nextQueryId++, available: false, resultNs: 0, deleteCount: 0 }
        queries.push(query)
        return query
    }
    const begin = query => {
        if (currentQuery || hostCurrentQuery) throw new Error('TIME_ELAPSED query is already active')
        currentQuery = query
    }
    const end = () => {
        currentQuery = null
    }
    const remove = query => {
        query.deleteCount += 1
        if (currentQuery === query) currentQuery = null
    }
    const readCurrent = pname => {
        if (pname === ENUM.QUERY_COUNTER_BITS) return counterBits
        if (pname === ENUM.CURRENT_QUERY) return currentQuery ?? hostCurrentQuery
        throw new Error(`unexpected getQuery pname ${pname}`)
    }
    const readQuery = (query, pname) => {
        if (pname === ENUM.QUERY_RESULT_AVAILABLE) return query.available
        if (pname === ENUM.QUERY_RESULT) {
            if (options.loseContextOnResult) contextLost = true
            return query.resultNs
        }
        throw new Error(`unexpected getQueryParameter pname ${pname}`)
    }

    const extension1 = {
        QUERY_COUNTER_BITS_EXT: ENUM.QUERY_COUNTER_BITS,
        CURRENT_QUERY_EXT: ENUM.CURRENT_QUERY,
        QUERY_RESULT_EXT: ENUM.QUERY_RESULT,
        QUERY_RESULT_AVAILABLE_EXT: ENUM.QUERY_RESULT_AVAILABLE,
        TIME_ELAPSED_EXT: ENUM.TIME_ELAPSED,
        GPU_DISJOINT_EXT: ENUM.GPU_DISJOINT,
        createQueryEXT() {
            hit('ext.createQueryEXT')
            return options.nullQuery ? null : makeQuery()
        },
        deleteQueryEXT(query) {
            hit('ext.deleteQueryEXT')
            remove(query)
        },
        beginQueryEXT(target, query) {
            hit('ext.beginQueryEXT')
            assert.equal(target, ENUM.TIME_ELAPSED)
            begin(query)
        },
        endQueryEXT(target) {
            hit('ext.endQueryEXT')
            assert.equal(target, ENUM.TIME_ELAPSED)
            end()
        },
        getQueryEXT(target, pname) {
            hit('ext.getQueryEXT')
            assert.equal(target, ENUM.TIME_ELAPSED)
            return readCurrent(pname)
        },
        getQueryObjectEXT(query, pname) {
            hit(pname === ENUM.QUERY_RESULT ? 'ext.readResult' : 'ext.readAvailable')
            return readQuery(query, pname)
        },
    }
    const extension2 = {
        QUERY_COUNTER_BITS_EXT: ENUM.QUERY_COUNTER_BITS,
        TIME_ELAPSED_EXT: ENUM.TIME_ELAPSED,
        GPU_DISJOINT_EXT: ENUM.GPU_DISJOINT,
    }
    const gl = {
        CURRENT_QUERY: ENUM.CURRENT_QUERY,
        QUERY_RESULT: ENUM.QUERY_RESULT,
        QUERY_RESULT_AVAILABLE: ENUM.QUERY_RESULT_AVAILABLE,
        getExtension(name) {
            hit(`gl.getExtension:${name}`)
            if (options.loseContextOnGetExtension) {
                contextLost = true
                return null
            }
            if (!extensionAvailable) return null
            if (options.malformedExtension) return {}
            if (backend === 'webgl' && name === 'EXT_disjoint_timer_query') return extension1
            if (backend === 'webgl2' && name === 'EXT_disjoint_timer_query_webgl2') return extension2
            return null
        },
        getParameter(pname) {
            hit('gl.getParameter')
            assert.equal(pname, ENUM.GPU_DISJOINT)
            const value = disjoint
            disjoint = false
            return value
        },
        isContextLost() {
            hit('gl.isContextLost')
            return contextLost
        },
        createQuery() {
            hit('gl.createQuery')
            return options.nullQuery ? null : makeQuery()
        },
        deleteQuery(query) {
            hit('gl.deleteQuery')
            remove(query)
        },
        beginQuery(target, query) {
            hit('gl.beginQuery')
            assert.equal(target, ENUM.TIME_ELAPSED)
            begin(query)
        },
        endQuery(target) {
            hit('gl.endQuery')
            assert.equal(target, ENUM.TIME_ELAPSED)
            end()
        },
        getQuery(target, pname) {
            hit('gl.getQuery')
            assert.equal(target, ENUM.TIME_ELAPSED)
            return readCurrent(pname)
        },
        getQueryParameter(query, pname) {
            hit(pname === ENUM.QUERY_RESULT ? 'gl.readResult' : 'gl.readAvailable')
            return readQuery(query, pname)
        },
        finish() {
            assert.fail('timer must never call finish')
        },
        flush() {
            assert.fail('timer must never call flush')
        },
        getError() {
            assert.fail('timer must never consume the application GL error state')
        },
    }

    return {
        gl,
        calls,
        queries,
        setAvailable(index, resultNs) {
            queries[index].available = true
            queries[index].resultNs = resultNs
        },
        setDisjoint(value = true) {
            disjoint = value
        },
        setContextLost(value = true) {
            contextLost = value
        },
        setHostQueryActive(value = true) {
            hostCurrentQuery = value ? { host: true } : null
        },
        getCurrentQuery() {
            return currentQuery
        },
    }
}

for (const backend of ['webgl', 'webgl2']) {
    test(`${backend} polls asynchronously and consumes each measured result once`, () => {
        const fake = createFakeContext(backend)
        const timer = createWebGlGpuTimer({ gl: fake.gl, backend, sampleEvery: 1 })
        assert.equal(timer.supported, true)
        assert.equal(timer.beginFrame(), true)
        assert.equal(timer.beginFrame(), false)
        assert.equal(timer.endFrame(), true)
        assert.equal(timer.endFrame(), false)

        timer.poll()
        assert.equal(timer.takeLatestEvidence(), null)
        assert.equal(
            fake.calls.some(call => call.endsWith('readResult')),
            false
        )

        fake.setAvailable(0, 1_250_000)
        const resolvedPollStart = fake.calls.length
        timer.poll()
        const resolvedPollCalls = fake.calls.slice(resolvedPollStart)
        const availableIndex = resolvedPollCalls.findIndex(call => call.endsWith('readAvailable'))
        const disjointIndex = resolvedPollCalls.indexOf('gl.getParameter')
        const resultIndex = resolvedPollCalls.findIndex(call => call.endsWith('readResult'))
        assert.equal(availableIndex >= 0 && availableIndex < disjointIndex && disjointIndex < resultIndex, true)
        assert.deepEqual(timer.takeLatestEvidence(), {
            status: 'measured',
            timeMs: 1.25,
            source: 'webgl-disjoint-timer-query',
        })
        assert.equal(timer.takeLatestEvidence(), null)
        assert.equal(fake.queries[0].deleteCount, 1)
        assert.equal(fake.calls.includes(backend === 'webgl' ? 'ext.createQueryEXT' : 'gl.createQuery'), true)
        assert.equal(fake.calls.includes(backend === 'webgl' ? 'gl.createQuery' : 'ext.createQueryEXT'), false)
        timer.dispose()
    })

    test(`${backend} cancelFrame reports deletion failure instead of claiming cancellation`, () => {
        const deleteCall = backend === 'webgl' ? 'ext.deleteQueryEXT' : 'gl.deleteQuery'
        const fake = createFakeContext(backend, { throwOn: [deleteCall] })
        const timer = createWebGlGpuTimer({ gl: fake.gl, backend, sampleEvery: 1 })

        assert.equal(timer.beginFrame(), true)
        assert.equal(timer.cancelFrame(), false)
        assert.equal(timer.getSnapshot().cancelledQueryCount, 0)
        assert.equal(timer.getSnapshot().capability, 'error')
        assert.equal(timer.getSnapshot().errorCount, 1)
        assert.equal(timer.takeLatestEvidence()?.status, 'error')
        assert.equal(fake.calls.filter(call => call === deleteCall).length, 1)
        timer.dispose()
    })
}

for (const backend of ['webgl', 'webgl2']) {
    test(`${backend} distinguishes extension unavailability caused by context loss`, () => {
        const alreadyLost = createFakeContext(backend, { initialContextLost: true })
        const alreadyLostTimer = createWebGlGpuTimer({ gl: alreadyLost.gl, backend })
        assert.equal(alreadyLostTimer.getSnapshot().capability, 'context-lost')
        assert.deepEqual(alreadyLostTimer.takeRendererHostTiming(), {
            gpuTimerCapability: 'unknown',
            gpu: { status: 'context-lost', source: 'webgl-disjoint-timer-query' },
        })
        assert.equal(
            alreadyLost.calls.some(call => call.startsWith('gl.getExtension:')),
            false
        )
        alreadyLostTimer.dispose()

        const lostDuringExtensionRead = createFakeContext(backend, { loseContextOnGetExtension: true })
        const racedTimer = createWebGlGpuTimer({ gl: lostDuringExtensionRead.gl, backend })
        assert.equal(racedTimer.getSnapshot().capability, 'context-lost')
        assert.deepEqual(racedTimer.takeRendererHostTiming(), {
            gpuTimerCapability: 'unknown',
            gpu: { status: 'context-lost', source: 'webgl-disjoint-timer-query' },
        })
        assert.equal(lostDuringExtensionRead.calls.filter(call => call === 'gl.isContextLost').length, 2)
        racedTimer.dispose()
    })
}

test('resolved timer evidence is accepted by the generic renderer host probe', () => {
    const fake = createFakeContext('webgl2')
    const timer = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2', sampleEvery: 1 })
    timer.beginFrame()
    timer.endFrame()
    fake.setAvailable(0, 2_000_000)
    timer.poll()

    const emitted = []
    const probe = createRendererHostProbe({
        backend: timer.backend,
        read: () => ({ gpu: timer.takeLatestEvidence() }),
        sink: { recordRenderStats: sample => emitted.push(sample) },
        now: () => 10,
    })
    const sample = probe.capture()
    assert.deepEqual(sample.gpu, {
        status: 'measured',
        timeMs: 2,
        source: 'webgl-disjoint-timer-query',
        valid: true,
        disjoint: false,
        contextLost: false,
    })
    assert.deepEqual(emitted, [sample])
    assert.equal(probe.capture().gpu.status, 'not-provided')

    timer.beginFrame()
    timer.endFrame()
    fake.setAvailable(1, 3_000_000)
    timer.poll()
    const three = createThreeRendererProbe({
        renderer: {
            info: { render: { calls: 2, triangles: 6 } },
            getContext: () => fake.gl,
        },
        backend: 'webgl2',
        readGpuTiming: () => timer.takeLatestEvidence(),
        sink: { recordRenderStats() {} },
    })
    assert.deepEqual(three.capture().gpu, {
        status: 'measured',
        timeMs: 3,
        source: 'webgl-disjoint-timer-query',
        valid: true,
        disjoint: false,
        contextLost: false,
    })
    three.dispose()
    probe.dispose()
    timer.dispose()
})

test('zero nanoseconds is measured while invalid or timed-out results stay unmeasured', () => {
    const fake = createFakeContext('webgl2')
    const timer = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2', sampleEvery: 1, maxPollAttempts: 2 })

    assert.equal(timer.beginFrame(), true)
    assert.equal(timer.endFrame(), true)
    fake.setAvailable(0, 0)
    timer.poll()
    assert.equal(timer.takeLatestEvidence().timeMs, 0)

    for (const result of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 600_000_000_001]) {
        assert.equal(timer.beginFrame(), true)
        assert.equal(timer.endFrame(), true)
        const index = fake.queries.length - 1
        fake.setAvailable(index, result)
        timer.poll()
        assert.deepEqual(timer.takeLatestEvidence(), {
            status: 'invalid',
            source: 'webgl-disjoint-timer-query',
        })
    }

    assert.equal(timer.beginFrame(), true)
    assert.equal(timer.endFrame(), true)
    timer.poll()
    assert.equal(timer.takeLatestEvidence(), null)
    timer.poll()
    assert.deepEqual(timer.takeLatestEvidence(), { status: 'invalid', source: 'webgl-disjoint-timer-query' })
    assert.equal(timer.getSnapshot().timedOutQueryCount, 1)
    timer.dispose()
})

test('sparse sampling, pending bounds, nested begin, and host query conflicts only skip new work', () => {
    const sparseFake = createFakeContext('webgl2')
    const sparse = createWebGlGpuTimer({ gl: sparseFake.gl, backend: 'webgl2', sampleEvery: 2, maxPendingQueries: 2 })
    assert.equal(sparse.beginFrame(), true)
    assert.equal(sparse.beginFrame(), false)
    assert.equal(sparse.endFrame(), true)
    assert.equal(sparse.beginFrame(), true)
    assert.equal(sparse.endFrame(), true)
    assert.equal(sparse.beginFrame(), false)
    assert.equal(sparse.beginFrame(), false)
    assert.equal(sparseFake.queries.length, 2)
    assert.equal(sparse.getSnapshot().skippedActiveCount, 1)
    assert.equal(sparse.getSnapshot().skippedCapacityCount, 1)
    sparse.dispose()

    const hostFake = createFakeContext('webgl')
    const hostSafe = createWebGlGpuTimer({ gl: hostFake.gl, backend: 'webgl', sampleEvery: 1 })
    hostFake.setHostQueryActive(true)
    hostFake.setDisjoint()
    const disjointReadsBeforeConflict = hostFake.calls.filter(call => call === 'gl.getParameter').length
    assert.equal(hostSafe.beginFrame(), false)
    assert.equal(hostSafe.getSnapshot().skippedHostQueryCount, 1)
    assert.equal(hostFake.queries.length, 0)
    assert.equal(hostFake.calls.filter(call => call === 'gl.getParameter').length, disjointReadsBeforeConflict)
    hostFake.setHostQueryActive(false)
    assert.equal(hostSafe.beginFrame(), false)
    assert.equal(hostSafe.takeLatestEvidence(), null)
    assert.equal(hostSafe.getSnapshot().disjointEpochCount, 0)
    assert.equal(hostSafe.beginFrame(), true)
    assert.equal(hostSafe.endFrame(), true)
    hostFake.setHostQueryActive(true)
    hostFake.setDisjoint()
    const disjointReadsBeforePollConflict = hostFake.calls.filter(call => call === 'gl.getParameter').length
    hostSafe.poll()
    assert.equal(hostSafe.getSnapshot().pendingQueryCount, 1)
    assert.equal(hostFake.calls.filter(call => call === 'gl.getParameter').length, disjointReadsBeforePollConflict)
    hostFake.setHostQueryActive(false)
    hostSafe.poll()
    assert.deepEqual(hostSafe.takeLatestEvidence(), { status: 'disjoint', source: 'webgl-disjoint-timer-query' })
    hostSafe.dispose()
})

test('poll handles only the oldest pending query and never replaces it when the queue is full', () => {
    const fake = createFakeContext('webgl2')
    const timer = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2', sampleEvery: 1, maxPendingQueries: 2 })
    for (let index = 0; index < 2; index += 1) {
        assert.equal(timer.beginFrame(), true)
        assert.equal(timer.endFrame(), true)
        fake.setAvailable(index, (index + 1) * 1_000_000)
    }
    assert.equal(timer.beginFrame(), false)
    assert.equal(fake.queries.length, 2)

    timer.poll()
    assert.equal(timer.takeLatestEvidence().timeMs, 1)
    assert.equal(timer.getSnapshot().pendingQueryCount, 1)
    timer.poll()
    assert.equal(timer.takeLatestEvidence().timeMs, 2)
    assert.equal(timer.getSnapshot().pendingQueryCount, 0)
    timer.dispose()
})

test('a disjoint epoch invalidates all pending queries without reading their results', () => {
    const fake = createFakeContext('webgl2')
    const timer = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2', sampleEvery: 1, maxPendingQueries: 2 })
    timer.beginFrame()
    timer.endFrame()
    fake.setAvailable(0, 2_000_000)
    timer.beginFrame()
    timer.endFrame()
    fake.setDisjoint()
    timer.poll()

    assert.deepEqual(timer.takeLatestEvidence(), { status: 'disjoint', source: 'webgl-disjoint-timer-query' })
    assert.equal(timer.getSnapshot().active, false)
    assert.equal(timer.getSnapshot().pendingQueryCount, 0)
    assert.equal(
        fake.calls.some(call => call.endsWith('readResult')),
        false
    )
    assert.deepEqual(
        fake.queries.map(query => query.deleteCount),
        [1, 1]
    )
    timer.dispose()
})

test('poll is a no-op inside an active render boundary', () => {
    const fake = createFakeContext('webgl2')
    const timer = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2', sampleEvery: 1 })
    timer.beginFrame()
    fake.setDisjoint()
    timer.poll()
    assert.equal(timer.getSnapshot().active, true)
    assert.equal(fake.queries[0].deleteCount, 0)
    assert.equal(timer.takeLatestEvidence(), null)
    timer.endFrame()
    timer.poll()
    assert.deepEqual(timer.takeLatestEvidence(), { status: 'disjoint', source: 'webgl-disjoint-timer-query' })
    timer.dispose()
})

test('context loss is terminal for old query objects and requires host disposal before recreation', () => {
    const fake = createFakeContext('webgl')
    const timer = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl', sampleEvery: 1 })
    timer.beginFrame()
    timer.endFrame()
    fake.setContextLost()
    timer.poll()
    assert.deepEqual(timer.takeRendererHostTiming(), {
        gpuTimerCapability: 'unknown',
        gpu: { status: 'context-lost', source: 'webgl-disjoint-timer-query' },
    })
    assert.deepEqual(timer.takeRendererHostTiming(), {
        gpuTimerCapability: 'unknown',
        gpu: null,
    })
    assert.equal(timer.getSnapshot().capability, 'context-lost')
    assert.equal(fake.queries[0].deleteCount, 0)
    fake.setContextLost(false)
    assert.equal(timer.beginFrame(), false)

    const conflicting = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl' })
    assert.equal(conflicting.getSnapshot().capability, 'owner-conflict')
    conflicting.dispose()
    timer.dispose()
    const recreated = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl' })
    assert.equal(recreated.supported, true)
    recreated.dispose()
})

test('context loss during result retrieval can never become a measured zero', () => {
    const fake = createFakeContext('webgl2', { loseContextOnResult: true })
    const timer = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2', sampleEvery: 1 })
    timer.beginFrame()
    timer.endFrame()
    fake.setAvailable(0, 0)
    timer.poll()
    assert.deepEqual(timer.takeLatestEvidence(), { status: 'context-lost', source: 'webgl-disjoint-timer-query' })
    assert.equal(timer.getSnapshot().measuredQueryCount, 0)
    assert.equal(timer.getSnapshot().capability, 'context-lost')
    timer.dispose()
})

test('renderer host timing detects context loss while the timer is idle', () => {
    const fake = createFakeContext('webgl2')
    const timer = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2' })
    fake.setContextLost()
    assert.deepEqual(timer.takeRendererHostTiming(), {
        gpuTimerCapability: 'unknown',
        gpu: { status: 'context-lost', source: 'webgl-disjoint-timer-query' },
    })
    assert.deepEqual(timer.takeRendererHostTiming(), {
        gpuTimerCapability: 'unknown',
        gpu: null,
    })
    timer.dispose()
})

test('one package instance coordinates one timer owner per context', () => {
    const fake = createFakeContext('webgl2')
    const first = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2' })
    const second = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2' })
    assert.equal(first.supported, true)
    assert.equal(second.supported, false)
    assert.equal(second.getSnapshot().capability, 'owner-conflict')
    second.dispose()
    assert.equal(first.supported, true)
    first.dispose()
    const third = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2' })
    assert.equal(third.supported, true)
    third.dispose()
})

test('renderer host timing keeps capability separate from one-shot evidence', () => {
    const fake = createFakeContext('webgl2')
    const timer = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2', sampleEvery: 1 })
    assert.deepEqual(timer.takeRendererHostTiming(), {
        gpuTimerCapability: 'supported',
        gpu: null,
    })

    timer.beginFrame()
    timer.endFrame()
    fake.setAvailable(0, 2_500_000)
    timer.poll()
    assert.deepEqual(timer.takeRendererHostTiming(), {
        gpuTimerCapability: 'supported',
        gpu: {
            status: 'measured',
            timeMs: 2.5,
            source: 'webgl-disjoint-timer-query',
        },
    })
    assert.equal(timer.takeLatestEvidence(), null)

    timer.beginFrame()
    timer.endFrame()
    fake.setAvailable(1, 3_000_000)
    timer.poll()
    assert.deepEqual(timer.takeLatestEvidence(), {
        status: 'measured',
        timeMs: 3,
        source: 'webgl-disjoint-timer-query',
    })
    assert.deepEqual(timer.takeRendererHostTiming(), {
        gpuTimerCapability: 'supported',
        gpu: null,
    })

    const conflicting = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2' })
    assert.deepEqual(conflicting.takeRendererHostTiming(), {
        gpuTimerCapability: 'unknown',
        gpu: null,
    })
    conflicting.dispose()
    timer.dispose()
    assert.deepEqual(timer.takeRendererHostTiming(), {
        gpuTimerCapability: 'disabled',
        gpu: null,
    })

    const unsupportedFake = createFakeContext('webgl2', { extensionAvailable: false })
    const unsupported = createWebGlGpuTimer({ gl: unsupportedFake.gl, backend: 'webgl2' })
    assert.deepEqual(unsupported.takeRendererHostTiming(), {
        gpuTimerCapability: 'unsupported',
        gpu: null,
    })
    unsupported.dispose()

    const error = createWebGlGpuTimer({ gl: {}, backend: 'webgl2' })
    assert.deepEqual(error.takeRendererHostTiming(), {
        gpuTimerCapability: 'unknown',
        gpu: { status: 'error', source: 'webgl-disjoint-timer-query' },
    })
    assert.deepEqual(error.takeRendererHostTiming(), {
        gpuTimerCapability: 'unknown',
        gpu: null,
    })
    error.dispose()
})

test('unsupported, malformed, and invalid options remain distinct and allocate no queries', () => {
    for (const options of [{ extensionAvailable: false }, { counterBits: 0 }]) {
        const fake = createFakeContext('webgl2', options)
        const timer = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2' })
        assert.equal(timer.supported, false)
        assert.equal(timer.getSnapshot().capability, 'unsupported')
        assert.equal(timer.beginFrame(), false)
        assert.equal(fake.queries.length, 0)
        timer.dispose()
    }

    for (const options of [{ malformedExtension: true }, { counterBits: 29 }, { counterBits: 65 }]) {
        const fake = createFakeContext('webgl2', options)
        const timer = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2' })
        assert.equal(timer.supported, false)
        assert.equal(timer.getSnapshot().capability, 'error')
        assert.deepEqual(timer.takeLatestEvidence(), { status: 'error', source: 'webgl-disjoint-timer-query' })
        assert.equal(fake.queries.length, 0)
        timer.dispose()
    }

    const wrongApi = createFakeContext('webgl2')
    const wrongBackend = createWebGlGpuTimer({ gl: wrongApi.gl, backend: 'webgl' })
    assert.equal(wrongBackend.getSnapshot().capability, 'unsupported')
    wrongBackend.dispose()

    const malformed = createWebGlGpuTimer({ gl: {}, backend: 'webgl2' })
    assert.equal(malformed.getSnapshot().capability, 'error')
    assert.deepEqual(malformed.takeLatestEvidence(), { status: 'error', source: 'webgl-disjoint-timer-query' })
    malformed.dispose()

    assert.throws(
        () => createWebGlGpuTimer({ gl: {}, backend: 'webgl2', sampleEvery: 0 }),
        error => error instanceof WebGlGpuTimerOptionsError
    )
    assert.throws(() => createWebGlGpuTimer({ gl: {}, backend: 'future' }), WebGlGpuTimerOptionsError)
    assert.throws(
        () => createWebGlGpuTimerFactory({ gl: wrongApi.gl, backend: 'webgl2' }),
        /disjointQueryOwnership must explicitly be exclusive/u
    )
})

test('API exceptions and null queries fail closed without escaping or becoming measured', () => {
    for (const [backend, option] of [
        ['webgl', { throwOn: ['gl.getExtension:EXT_disjoint_timer_query'] }],
        ['webgl2', { nullQuery: true }],
        ['webgl2', { throwOn: ['gl.beginQuery'] }],
    ]) {
        const fake = createFakeContext(backend, option)
        let timer
        assert.doesNotThrow(() => {
            timer = createWebGlGpuTimer({ gl: fake.gl, backend, sampleEvery: 1 })
        })
        assert.doesNotThrow(() => timer.beginFrame())
        assert.equal(timer.supported, false)
        assert.deepEqual(timer.takeLatestEvidence(), { status: 'error', source: 'webgl-disjoint-timer-query' })
        timer.dispose()
    }

    const pendingFake = createFakeContext('webgl2', { throwOn: ['gl.readAvailable'] })
    const pending = createWebGlGpuTimer({ gl: pendingFake.gl, backend: 'webgl2', sampleEvery: 1 })
    pending.beginFrame()
    pending.endFrame()
    assert.doesNotThrow(() => pending.poll())
    assert.equal(pending.getSnapshot().capability, 'error')
    assert.deepEqual(pending.takeLatestEvidence(), { status: 'error', source: 'webgl-disjoint-timer-query' })
    pending.dispose()
})

test('dispose balances owned active queries, deletes each query once, and is idempotent', () => {
    const fake = createFakeContext('webgl2')
    const timer = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2', sampleEvery: 1 })
    timer.beginFrame()
    timer.dispose()
    timer.dispose()
    assert.equal(fake.queries[0].deleteCount, 1)
    assert.equal(timer.getSnapshot().capability, 'disposed')
    assert.equal(timer.beginFrame(), false)
    assert.equal(timer.endFrame(), false)
    assert.doesNotThrow(() => timer.poll())
    assert.equal(timer.takeLatestEvidence(), null)
})

for (const backend of ['webgl', 'webgl2']) {
    test(`${backend} cancelFrame balances and deletes an active query without retaining evidence`, () => {
        const fake = createFakeContext(backend)
        const timer = createWebGlGpuTimer({ gl: fake.gl, backend, sampleEvery: 1 })

        assert.equal(timer.beginFrame(), true)
        assert.equal(timer.cancelFrame(), true)
        assert.equal(timer.cancelFrame(), false)
        assert.equal(timer.takeLatestEvidence(), null)
        assert.deepEqual(timer.getSnapshot(), {
            ...timer.getSnapshot(),
            active: false,
            pendingQueryCount: 0,
            evidenceBuffered: false,
            startedQueryCount: 1,
            cancelledQueryCount: 1,
            acceptedTargetSampleCount: 0,
            retainedTargetSampleCount: 0,
            rejectedTargetSampleCount: 0,
        })
        assert.equal(fake.queries[0].deleteCount, 1)
        assert.equal(timer.inspectWindow(targetWindow(0, 10)).capability.observed, false)

        assert.equal(timer.beginFrame(), true)
        assert.equal(timer.endFrame(), true)
        timer.dispose()
    })
}

function targetWindow(startedAt, endedAt, relation = 'selection-window') {
    return { startedAt, endedAt, relation }
}

function createTargetTimer(backend = 'webgl2', timerOptions = {}, contextOptions = {}) {
    const fake = createFakeContext(backend, contextOptions)
    let time = 0
    const timer = createWebGlGpuTimer({
        gl: fake.gl,
        backend,
        sampleEvery: 1,
        now: () => time,
        ...timerOptions,
    })
    return {
        fake,
        timer,
        setTime(value) {
            time = value
        },
    }
}

function recordTargetQuery(harness, { start, end, resultNanoseconds, resolveAt = end }) {
    harness.setTime(start)
    assert.equal(harness.timer.beginFrame(), true)
    harness.setTime(end)
    assert.equal(harness.timer.endFrame(), true)
    const queryIndex = harness.fake.queries.length - 1
    harness.setTime(resolveAt)
    harness.fake.setAvailable(queryIndex, resultNanoseconds)
    harness.timer.poll()
    return queryIndex
}

for (const backend of ['webgl', 'webgl2']) {
    test(`${backend} retains non-consuming target-window p95 at the original frame bounds`, () => {
        const harness = createTargetTimer(backend, { maxRetainedFrames: 4 })
        recordTargetQuery(harness, { start: 0, end: 10, resultNanoseconds: 1_000_000, resolveAt: 100 })

        const first = harness.timer.inspectWindow(targetWindow(0, 10))
        assert.deepEqual(first, {
            family: backend,
            capability: { state: 'supported', observed: true, buffered: false },
            metrics: { gpuFrameMsP95: 1 },
            evidence: {
                window: { startedAt: 0, endedAt: 10 },
                acceptedSampleCount: 1,
                retainedSampleCount: 1,
                droppedSampleCount: 0,
                rejectedSampleCount: 0,
                truncated: false,
                gpu: {
                    valid: true,
                    disjoint: false,
                    contextLost: false,
                    source: 'webgl-timer-query',
                },
            },
        })
        assert.equal(harness.timer.inspectWindow(targetWindow(90, 110)).capability.observed, false)
        assert.equal(harness.timer.inspectWindow(targetWindow(5, 10)).capability.observed, false)
        assert.deepEqual(harness.timer.takeLatestEvidence(), {
            status: 'measured',
            timeMs: 1,
            source: 'webgl-disjoint-timer-query',
        })
        assert.deepEqual(harness.timer.inspectWindow(targetWindow(0, 10)), first)

        recordTargetQuery(harness, { start: 20, end: 30, resultNanoseconds: 2_000_000, resolveAt: 200 })
        const combined = harness.timer.inspectWindow(targetWindow(0, 30, 'interaction-window'))
        assert.deepEqual(combined, {
            family: backend,
            capability: { state: 'supported', observed: true, buffered: false },
            metrics: { gpuFrameMsP95: 1.95 },
            evidence: {
                window: { startedAt: 0, endedAt: 30 },
                acceptedSampleCount: 2,
                retainedSampleCount: 2,
                droppedSampleCount: 0,
                rejectedSampleCount: 0,
                truncated: false,
                gpu: {
                    valid: true,
                    disjoint: false,
                    contextLost: false,
                    source: 'webgl-timer-query',
                },
            },
        })
        const boundInspect = harness.timer.inspect
        assert.deepEqual(boundInspect({ evidenceWindow: targetWindow(0, 30, 'interaction-window') }), {
            inventory: { renderers: [backend] },
            owners: [{ relation: 'renderer-host', label: 'Condev WebGL GPU timer' }],
            renderer: combined,
        })
        assert.deepEqual(harness.timer.takeRendererHostTiming(), {
            gpuTimerCapability: 'supported',
            gpu: { status: 'measured', timeMs: 2, source: 'webgl-disjoint-timer-query' },
        })
        assert.deepEqual(harness.timer.inspectWindow(targetWindow(0, 30)), combined)
        harness.timer.dispose()
    })
}

test('pending, sparse, and capacity-skipped WebGL queries never manufacture target zeroes', () => {
    const harness = createTargetTimer('webgl2', { sampleEvery: 2, maxPendingQueries: 1, maxRetainedFrames: 2 })
    harness.setTime(0)
    assert.equal(harness.timer.beginFrame(), true)
    harness.setTime(10)
    assert.equal(harness.timer.endFrame(), true)
    harness.setTime(20)
    assert.equal(harness.timer.beginFrame(), false)
    harness.setTime(40)
    assert.equal(harness.timer.beginFrame(), false)

    const beforeResolution = harness.timer.inspectWindow(targetWindow(0, 50))
    assert.equal(beforeResolution.capability.observed, false)
    assert.equal('metrics' in beforeResolution, false)
    assert.equal('evidence' in beforeResolution, false)
    assert.equal(harness.timer.takeLatestEvidence(), null)

    harness.fake.setAvailable(0, 0)
    harness.timer.poll()
    const measuredZero = harness.timer.inspectWindow(targetWindow(0, 10))
    assert.equal(measuredZero.metrics.gpuFrameMsP95, 0)
    assert.equal(measuredZero.evidence.acceptedSampleCount, 1)
    assert.equal(measuredZero.evidence.rejectedSampleCount, 0)
    assert.equal(measuredZero.evidence.gpu.valid, true)
    assert.equal(measuredZero.evidence.gpu.source, 'webgl-timer-query')
    harness.timer.dispose()
})

test('a contained pending WebGL query suppresses biased p95 until the fixed window settles', () => {
    const harness = createTargetTimer('webgl2', { maxPendingQueries: 2, maxRetainedFrames: 4 })
    recordTargetQuery(harness, { start: 0, end: 10, resultNanoseconds: 1_000_000 })
    harness.setTime(20)
    assert.equal(harness.timer.beginFrame(), true)
    harness.setTime(30)
    assert.equal(harness.timer.endFrame(), true)

    const unsettled = harness.timer.inspectWindow(targetWindow(0, 30))
    assert.equal(unsettled.capability.observed, false)
    assert.equal('metrics' in unsettled, false)
    assert.equal('evidence' in unsettled, false)
    assert.deepEqual(harness.timer.inspectWindow(targetWindow(0, 10)).metrics, { gpuFrameMsP95: 1 })

    harness.fake.setAvailable(1, 100_000_000)
    harness.timer.poll()
    const settled = harness.timer.inspectWindow(targetWindow(0, 30))
    assert.deepEqual(settled, {
        family: 'webgl2',
        capability: { state: 'supported', observed: true, buffered: false },
        metrics: { gpuFrameMsP95: 95.05 },
        evidence: {
            window: { startedAt: 0, endedAt: 30 },
            acceptedSampleCount: 2,
            retainedSampleCount: 2,
            droppedSampleCount: 0,
            rejectedSampleCount: 0,
            truncated: false,
            gpu: {
                valid: true,
                disjoint: false,
                contextLost: false,
                source: 'webgl-timer-query',
            },
        },
    })
    assert.deepEqual(harness.timer.inspectWindow(targetWindow(0, 30)), settled)
    harness.timer.dispose()
})

test('WebGL target ring exposes exact accepted/retained/dropped arithmetic and forgets ambiguous windows', () => {
    const harness = createTargetTimer('webgl2', { maxRetainedFrames: 2 })
    recordTargetQuery(harness, { start: 0, end: 10, resultNanoseconds: 1_000_000 })
    recordTargetQuery(harness, { start: 20, end: 30, resultNanoseconds: 2_000_000 })
    recordTargetQuery(harness, { start: 40, end: 50, resultNanoseconds: 3_000_000 })

    const full = harness.timer.inspectWindow(targetWindow(0, 50))
    assert.deepEqual(full, {
        family: 'webgl2',
        capability: { state: 'supported', observed: true, buffered: false },
        metrics: {},
        evidence: {
            window: { startedAt: 20, endedAt: 50 },
            acceptedSampleCount: 3,
            retainedSampleCount: 2,
            droppedSampleCount: 1,
            rejectedSampleCount: 0,
            truncated: true,
            gpu: {
                valid: false,
                disjoint: false,
                contextLost: false,
                source: 'webgl-timer-query',
            },
        },
    })
    assert.equal(full.evidence.acceptedSampleCount, full.evidence.retainedSampleCount + full.evidence.droppedSampleCount)
    assert.equal(full.evidence.truncated, full.evidence.droppedSampleCount > 0)

    const recent = harness.timer.inspectWindow(targetWindow(20, 50))
    assert.equal(recent.metrics.gpuFrameMsP95, 2.95)
    assert.deepEqual(
        {
            accepted: recent.evidence.acceptedSampleCount,
            retained: recent.evidence.retainedSampleCount,
            dropped: recent.evidence.droppedSampleCount,
            rejected: recent.evidence.rejectedSampleCount,
            truncated: recent.evidence.truncated,
        },
        { accepted: 2, retained: 2, dropped: 0, rejected: 0, truncated: false }
    )

    const ambiguous = harness.timer.inspectWindow(targetWindow(5, 50))
    assert.equal(ambiguous.capability.observed, false)
    assert.match(ambiguous.capability.reason, /exact sample count is unavailable/)
    assert.equal('metrics' in ambiguous, false)
    assert.equal('evidence' in ambiguous, false)
    const evictedOnly = harness.timer.inspectWindow(targetWindow(0, 10))
    assert.equal(evictedOnly.capability.observed, false)
    assert.equal('evidence' in evictedOnly, false)
    harness.timer.dispose()
})

test('invalid and mixed WebGL target records remain observed but fail closed', () => {
    const invalid = createTargetTimer('webgl2', { maxRetainedFrames: 4 })
    recordTargetQuery(invalid, { start: 0, end: 10, resultNanoseconds: 1_000_000 })
    recordTargetQuery(invalid, { start: 20, end: 30, resultNanoseconds: Number.NaN })
    const mixed = invalid.timer.inspectWindow(targetWindow(0, 30))
    assert.deepEqual(mixed, {
        family: 'webgl2',
        capability: { state: 'supported', observed: true, buffered: false },
        metrics: {},
        evidence: {
            window: { startedAt: 0, endedAt: 30 },
            acceptedSampleCount: 1,
            retainedSampleCount: 1,
            droppedSampleCount: 0,
            rejectedSampleCount: 1,
            truncated: false,
            gpu: {
                valid: false,
                disjoint: false,
                contextLost: false,
                source: 'webgl-timer-query',
            },
        },
    })
    assert.equal('gpuFrameMsP95' in mixed.metrics, false)
    assert.deepEqual(
        {
            accepted: invalid.timer.getSnapshot().acceptedTargetSampleCount,
            retained: invalid.timer.getSnapshot().retainedTargetSampleCount,
            dropped: invalid.timer.getSnapshot().droppedTargetSampleCount,
            rejected: invalid.timer.getSnapshot().rejectedTargetSampleCount,
        },
        { accepted: 1, retained: 1, dropped: 0, rejected: 1 }
    )
    invalid.timer.dispose()
})

test('measured and rejected WebGL target eviction counters remain independent and exact', () => {
    const harness = createTargetTimer('webgl2', { maxRetainedFrames: 2 })
    recordTargetQuery(harness, { start: 0, end: 10, resultNanoseconds: 1_000_000 })
    recordTargetQuery(harness, { start: 20, end: 30, resultNanoseconds: Number.NaN })
    recordTargetQuery(harness, { start: 40, end: 50, resultNanoseconds: 3_000_000 })
    recordTargetQuery(harness, { start: 60, end: 70, resultNanoseconds: Number.NaN })

    assert.deepEqual(
        {
            capacity: harness.timer.getSnapshot().targetResultCapacity,
            accepted: harness.timer.getSnapshot().acceptedTargetSampleCount,
            retained: harness.timer.getSnapshot().retainedTargetSampleCount,
            dropped: harness.timer.getSnapshot().droppedTargetSampleCount,
            rejected: harness.timer.getSnapshot().rejectedTargetSampleCount,
            retainedRejected: harness.timer.getSnapshot().retainedTargetRejectionCount,
            droppedRejected: harness.timer.getSnapshot().droppedTargetRejectionCount,
        },
        {
            capacity: 2,
            accepted: 2,
            retained: 1,
            dropped: 1,
            rejected: 2,
            retainedRejected: 1,
            droppedRejected: 1,
        }
    )

    const full = harness.timer.inspectWindow(targetWindow(0, 70))
    assert.deepEqual(full, {
        family: 'webgl2',
        capability: { state: 'supported', observed: true, buffered: false },
        metrics: {},
        evidence: {
            window: { startedAt: 40, endedAt: 70 },
            acceptedSampleCount: 2,
            retainedSampleCount: 1,
            droppedSampleCount: 1,
            rejectedSampleCount: 2,
            truncated: true,
            gpu: {
                valid: false,
                disjoint: false,
                contextLost: false,
                source: 'webgl-timer-query',
            },
        },
    })
    assert.equal(full.evidence.acceptedSampleCount, full.evidence.retainedSampleCount + full.evidence.droppedSampleCount)

    const recent = harness.timer.inspectWindow(targetWindow(40, 70))
    assert.deepEqual(
        {
            metrics: recent.metrics,
            accepted: recent.evidence.acceptedSampleCount,
            retained: recent.evidence.retainedSampleCount,
            dropped: recent.evidence.droppedSampleCount,
            rejected: recent.evidence.rejectedSampleCount,
            truncated: recent.evidence.truncated,
        },
        { metrics: {}, accepted: 1, retained: 1, dropped: 0, rejected: 1, truncated: false }
    )
    harness.timer.dispose()
})

test('rejected-only eviction preserves normalized measured counts without truncation', () => {
    const harness = createTargetTimer('webgl2', { maxRetainedFrames: 2 })
    recordTargetQuery(harness, { start: 0, end: 10, resultNanoseconds: Number.NaN })
    recordTargetQuery(harness, { start: 20, end: 30, resultNanoseconds: 2_000_000 })
    recordTargetQuery(harness, { start: 40, end: 50, resultNanoseconds: Number.NaN })

    assert.deepEqual(
        {
            accepted: harness.timer.getSnapshot().acceptedTargetSampleCount,
            retained: harness.timer.getSnapshot().retainedTargetSampleCount,
            dropped: harness.timer.getSnapshot().droppedTargetSampleCount,
            rejected: harness.timer.getSnapshot().rejectedTargetSampleCount,
            retainedRejected: harness.timer.getSnapshot().retainedTargetRejectionCount,
            droppedRejected: harness.timer.getSnapshot().droppedTargetRejectionCount,
        },
        {
            accepted: 1,
            retained: 1,
            dropped: 0,
            rejected: 2,
            retainedRejected: 1,
            droppedRejected: 1,
        }
    )

    const inspected = harness.timer.inspectWindow(targetWindow(0, 50))
    assert.deepEqual(inspected, {
        family: 'webgl2',
        capability: { state: 'supported', observed: true, buffered: false },
        metrics: {},
        evidence: {
            window: { startedAt: 20, endedAt: 50 },
            acceptedSampleCount: 1,
            retainedSampleCount: 1,
            droppedSampleCount: 0,
            rejectedSampleCount: 2,
            truncated: false,
            gpu: {
                valid: false,
                disjoint: false,
                contextLost: false,
                source: 'webgl-timer-query',
            },
        },
    })
    assert.equal(inspected.evidence.acceptedSampleCount, inspected.evidence.retainedSampleCount + inspected.evidence.droppedSampleCount)
    assert.equal(inspected.evidence.truncated, inspected.evidence.droppedSampleCount > 0)
    harness.timer.dispose()
})

test('disjoint, context-lost, and API-error WebGL target records preserve closed rejection states', () => {
    const cases = [
        {
            name: 'disjoint',
            setup: () => createTargetTimer('webgl2'),
            reject(harness) {
                harness.fake.setAvailable(0, 2_000_000)
                harness.fake.setDisjoint()
                harness.timer.poll()
            },
            gpu: { valid: false, disjoint: true, contextLost: false, source: 'webgl-timer-query' },
        },
        {
            name: 'context-lost',
            setup: () => createTargetTimer('webgl2'),
            reject(harness) {
                harness.fake.setContextLost()
                harness.timer.poll()
            },
            gpu: { valid: false, disjoint: false, contextLost: true, source: 'webgl-timer-query' },
        },
        {
            name: 'error',
            setup: () => createTargetTimer('webgl2', {}, { throwOn: ['gl.readAvailable'] }),
            reject(harness) {
                harness.timer.poll()
            },
            gpu: { valid: false, disjoint: false, contextLost: false, source: 'webgl-timer-query' },
        },
        {
            name: 'timeout',
            setup: () => createTargetTimer('webgl2', { maxPollAttempts: 1 }),
            reject(harness) {
                harness.timer.poll()
            },
            gpu: { valid: false, disjoint: false, contextLost: false, source: 'webgl-timer-query' },
        },
    ]

    for (const value of cases) {
        const harness = value.setup()
        harness.setTime(0)
        assert.equal(harness.timer.beginFrame(), true, value.name)
        harness.setTime(10)
        assert.equal(harness.timer.endFrame(), true, value.name)
        value.reject(harness)
        const inspected = harness.timer.inspectWindow(targetWindow(0, 10))
        assert.deepEqual(
            inspected,
            {
                family: 'webgl2',
                capability: { state: 'supported', observed: true, buffered: false },
                metrics: {},
                evidence: {
                    window: { startedAt: 0, endedAt: 10 },
                    acceptedSampleCount: 0,
                    retainedSampleCount: 0,
                    droppedSampleCount: 0,
                    rejectedSampleCount: 1,
                    truncated: false,
                    gpu: value.gpu,
                },
            },
            value.name
        )
        assert.equal(harness.timer.getSnapshot().acceptedTargetSampleCount, 0, value.name)
        assert.equal(harness.timer.getSnapshot().rejectedTargetSampleCount, 1, value.name)
        harness.timer.dispose()
    }
})

test('runtime WebGL context loss wins over create, current-query, and disjoint races', () => {
    const cases = [
        { name: 'create', call: 'gl.createQuery', throws: true },
        { name: 'read-current', call: 'gl.getQuery', throws: true },
        { name: 'read-disjoint', call: 'gl.getParameter', disjoint: true },
    ]

    for (const value of cases) {
        let armed = false
        let fake
        fake = createFakeContext('webgl2', {
            onCall(name) {
                if (!armed || name !== value.call) return
                fake.setContextLost()
                if (value.disjoint) fake.setDisjoint()
                if (value.throws) throw new Error(`${value.name} raced with context loss`)
            },
        })
        const timer = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2', sampleEvery: 1, now: () => 0 })
        armed = true
        let began
        assert.doesNotThrow(() => {
            began = timer.beginFrame()
        }, value.name)
        assert.equal(began, false, value.name)
        assert.equal(timer.getSnapshot().capability, 'context-lost', value.name)
        assert.deepEqual(timer.takeLatestEvidence(), { status: 'context-lost', source: 'webgl-disjoint-timer-query' }, value.name)
        const target = timer.inspectWindow(targetWindow(0, 10))
        assert.equal(target.capability.state, 'unknown', value.name)
        assert.equal(target.capability.observed, false, value.name)
        timer.dispose()
    }
})

test('context loss during availability read beats the API exception and records one rejection', () => {
    let armed = false
    let fake
    fake = createFakeContext('webgl2', {
        onCall(name) {
            if (!armed || name !== 'gl.readAvailable') return
            fake.setContextLost()
            throw new Error('availability raced with context loss')
        },
    })
    let time = 0
    const timer = createWebGlGpuTimer({
        gl: fake.gl,
        backend: 'webgl2',
        sampleEvery: 1,
        now: () => time,
    })
    assert.equal(timer.beginFrame(), true)
    time = 10
    assert.equal(timer.endFrame(), true)
    armed = true
    assert.doesNotThrow(() => timer.poll())
    assert.equal(timer.getSnapshot().capability, 'context-lost')
    assert.deepEqual(timer.takeLatestEvidence(), {
        status: 'context-lost',
        source: 'webgl-disjoint-timer-query',
    })
    assert.deepEqual(timer.inspectWindow(targetWindow(0, 10)), {
        family: 'webgl2',
        capability: { state: 'supported', observed: true, buffered: false },
        metrics: {},
        evidence: {
            window: { startedAt: 0, endedAt: 10 },
            acceptedSampleCount: 0,
            retainedSampleCount: 0,
            droppedSampleCount: 0,
            rejectedSampleCount: 1,
            truncated: false,
            gpu: {
                valid: false,
                disjoint: false,
                contextLost: true,
                source: 'webgl-timer-query',
            },
        },
    })
    timer.dispose()
})

test('nested WebGL callbacks are blocked without changing the successful outer host query', () => {
    const nested = {
        currentBegin: [],
        createEnd: [],
        beginBegin: [],
        endEnd: [],
        disjointPollCount: 0,
        availablePollCount: 0,
    }
    let armed = false
    let timer
    const fake = createFakeContext('webgl2', {
        onCall(name) {
            if (!armed) return
            if (name === 'gl.getQuery') nested.currentBegin.push(timer.beginFrame())
            else if (name === 'gl.createQuery') nested.createEnd.push(timer.endFrame())
            else if (name === 'gl.beginQuery') nested.beginBegin.push(timer.beginFrame())
            else if (name === 'gl.endQuery') nested.endEnd.push(timer.endFrame())
            else if (name === 'gl.getParameter') {
                nested.disjointPollCount += 1
                timer.poll()
            } else if (name === 'gl.readAvailable') {
                nested.availablePollCount += 1
                timer.poll()
            }
        },
    })
    let time = 0
    timer = createWebGlGpuTimer({
        gl: fake.gl,
        backend: 'webgl2',
        sampleEvery: 1,
        now: () => time,
    })
    armed = true
    const runtimeCallStart = fake.calls.length

    assert.equal(timer.beginFrame(), true)
    time = 10
    assert.equal(timer.endFrame(), true)
    fake.setAvailable(0, 2_000_000)
    assert.doesNotThrow(() => timer.poll())

    assert.deepEqual(nested.currentBegin, [false, false])
    assert.deepEqual(nested.createEnd, [false])
    assert.deepEqual(nested.beginBegin, [false])
    assert.deepEqual(nested.endEnd, [false])
    assert.equal(nested.disjointPollCount, 2)
    assert.equal(nested.availablePollCount, 1)
    assert.deepEqual(timer.takeLatestEvidence(), {
        status: 'measured',
        timeMs: 2,
        source: 'webgl-disjoint-timer-query',
    })
    assert.deepEqual(timer.inspectWindow(targetWindow(0, 10)).metrics, { gpuFrameMsP95: 2 })
    assert.equal(fake.queries[0].deleteCount, 1)
    assert.equal(fake.getCurrentQuery(), null)

    const runtimeCalls = fake.calls.slice(runtimeCallStart)
    for (const [name, count] of [
        ['gl.getQuery', 2],
        ['gl.getParameter', 2],
        ['gl.createQuery', 1],
        ['gl.beginQuery', 1],
        ['gl.endQuery', 1],
        ['gl.readAvailable', 1],
        ['gl.readResult', 1],
        ['gl.deleteQuery', 1],
    ]) {
        assert.equal(runtimeCalls.filter(call => call === name).length, count, name)
    }
    timer.dispose()
})

for (const value of [
    { name: 'current-query read', call: 'gl.getQuery', phase: 'begin', queryCount: 0, endCallCount: 0 },
    { name: 'disjoint read', call: 'gl.getParameter', phase: 'begin', queryCount: 0, endCallCount: 0 },
    { name: 'query creation', call: 'gl.createQuery', phase: 'begin', queryCount: 1, endCallCount: 0 },
    { name: 'query begin', call: 'gl.beginQuery', phase: 'begin', queryCount: 1, endCallCount: 1 },
    { name: 'query end', call: 'gl.endQuery', phase: 'end', queryCount: 1, endCallCount: 1 },
    { name: 'availability read', call: 'gl.readAvailable', phase: 'poll', queryCount: 1, endCallCount: 1 },
]) {
    test(`dispose re-entry from ${value.name} releases ownership without leaking a query`, () => {
        let armed = false
        let fired = false
        let timer
        const fake = createFakeContext('webgl2', {
            onCall(name) {
                if (!armed || fired || name !== value.call) return
                fired = true
                timer.dispose()
            },
        })
        timer = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2', sampleEvery: 1, now: () => 0 })

        let outerResult
        if (value.phase === 'begin') {
            armed = true
            assert.doesNotThrow(() => {
                outerResult = timer.beginFrame()
            })
            assert.equal(outerResult, false)
        } else {
            assert.equal(timer.beginFrame(), true)
            if (value.phase === 'end') {
                armed = true
                assert.doesNotThrow(() => {
                    outerResult = timer.endFrame()
                })
                assert.equal(outerResult, false)
            } else {
                assert.equal(timer.endFrame(), true)
                fake.setAvailable(0, 1_000_000)
                armed = true
                assert.doesNotThrow(() => timer.poll())
            }
        }

        assert.equal(fired, true)
        assert.equal(timer.getSnapshot().capability, 'disposed')
        assert.equal(timer.takeLatestEvidence(), null)
        assert.equal(fake.queries.length, value.queryCount)
        assert.equal(fake.getCurrentQuery(), null)
        assert.equal(fake.calls.filter(call => call === 'gl.endQuery').length, value.endCallCount)
        for (const query of fake.queries) assert.equal(query.deleteCount, 1)

        const replacement = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2', sampleEvery: 1, now: () => 0 })
        assert.equal(replacement.supported, true)
        replacement.dispose()
    })
}

test('a throwing endQuery is invoked once and cleaned without a second end attempt', () => {
    const fake = createFakeContext('webgl2', { throwOn: ['gl.endQuery'] })
    const timer = createWebGlGpuTimer({ gl: fake.gl, backend: 'webgl2', sampleEvery: 1, now: () => 0 })
    assert.equal(timer.beginFrame(), true)
    let ended
    assert.doesNotThrow(() => {
        ended = timer.endFrame()
    })
    assert.equal(ended, false)
    assert.equal(timer.getSnapshot().capability, 'error')
    assert.equal(fake.calls.filter(call => call === 'gl.endQuery').length, 1)
    assert.equal(fake.queries[0].deleteCount, 1)
    assert.equal(fake.getCurrentQuery(), null)
    assert.deepEqual(timer.takeLatestEvidence(), { status: 'error', source: 'webgl-disjoint-timer-query' })
    timer.dispose()
    assert.equal(fake.calls.filter(call => call === 'gl.endQuery').length, 1)
    assert.equal(fake.queries[0].deleteCount, 1)
})

test('unsupported, owner-conflict, initialization-error, and disposed timers expose no target measurement', () => {
    const unsupportedFake = createFakeContext('webgl2', { extensionAvailable: false })
    const unsupported = createWebGlGpuTimer({ gl: unsupportedFake.gl, backend: 'webgl2', now: () => 0 })
    const unsupportedInspection = unsupported.inspectWindow(targetWindow(0, 10))
    assert.equal(unsupportedInspection.family, 'webgl2')
    assert.equal(unsupportedInspection.capability.state, 'unsupported')
    assert.equal(unsupportedInspection.capability.observed, false)
    assert.equal('metrics' in unsupportedInspection, false)
    unsupported.dispose()

    const ownerFake = createFakeContext('webgl2')
    const owner = createWebGlGpuTimer({ gl: ownerFake.gl, backend: 'webgl2', now: () => 0 })
    const conflict = createWebGlGpuTimer({ gl: ownerFake.gl, backend: 'webgl2', now: () => 0 })
    assert.equal(conflict.inspectWindow(targetWindow(0, 10)).capability.state, 'unknown')
    assert.equal(conflict.inspectWindow(targetWindow(0, 10)).capability.observed, false)
    conflict.dispose()
    owner.dispose()

    const initializationError = createWebGlGpuTimer({ gl: {}, backend: 'webgl2', now: () => 0 })
    assert.equal(initializationError.inspectWindow(targetWindow(0, 10)).capability.state, 'unknown')
    assert.equal(initializationError.inspectWindow(targetWindow(0, 10)).capability.observed, false)
    initializationError.dispose()

    const disposedHarness = createTargetTimer('webgl2')
    disposedHarness.timer.dispose()
    const disposed = disposedHarness.timer.inspectWindow(targetWindow(0, 10))
    assert.equal(disposed.capability.state, 'unknown')
    assert.equal(disposed.capability.observed, false)
    assert.equal('metrics' in disposed, false)
})

test('WebGL target clock failures, regression, and re-entry never escape or become measured', () => {
    const throwingFake = createFakeContext('webgl2')
    const throwing = createWebGlGpuTimer({
        gl: throwingFake.gl,
        backend: 'webgl2',
        sampleEvery: 1,
        now() {
            throw new Error('clock failure')
        },
    })
    let throwingBegan
    assert.doesNotThrow(() => {
        throwingBegan = throwing.beginFrame()
    })
    assert.equal(throwingBegan, true)
    assert.equal(throwing.endFrame(), true)
    assert.equal(throwingFake.queries.length, 1)
    assert.equal(throwing.getSnapshot().clockErrorCount, 2)
    throwingFake.setAvailable(0, 1_000_000)
    throwing.poll()
    assert.deepEqual(throwing.takeLatestEvidence(), {
        status: 'measured',
        timeMs: 1,
        source: 'webgl-disjoint-timer-query',
    })
    assert.equal(throwing.inspectWindow(targetWindow(0, 10)).capability.observed, false)
    throwing.dispose()

    const backward = createTargetTimer('webgl2')
    backward.setTime(10)
    assert.equal(backward.timer.beginFrame(), true)
    backward.setTime(5)
    assert.equal(backward.timer.endFrame(), true)
    assert.equal(backward.timer.getSnapshot().clockErrorCount, 1)
    backward.fake.setAvailable(0, 1_000_000)
    backward.timer.poll()
    assert.deepEqual(backward.timer.takeLatestEvidence(), {
        status: 'measured',
        timeMs: 1,
        source: 'webgl-disjoint-timer-query',
    })
    assert.equal(backward.timer.inspectWindow(targetWindow(0, 20)).capability.observed, false)
    backward.timer.dispose()

    const crossFrame = createTargetTimer('webgl2')
    recordTargetQuery(crossFrame, { start: 10, end: 20, resultNanoseconds: 1_000_000 })
    assert.deepEqual(crossFrame.timer.takeLatestEvidence(), {
        status: 'measured',
        timeMs: 1,
        source: 'webgl-disjoint-timer-query',
    })
    crossFrame.setTime(15)
    assert.equal(crossFrame.timer.beginFrame(), true)
    crossFrame.setTime(25)
    assert.equal(crossFrame.timer.endFrame(), true)
    assert.equal(crossFrame.timer.getSnapshot().clockErrorCount, 1)
    crossFrame.fake.setAvailable(1, 2_000_000)
    crossFrame.timer.poll()
    assert.deepEqual(crossFrame.timer.takeLatestEvidence(), {
        status: 'measured',
        timeMs: 2,
        source: 'webgl-disjoint-timer-query',
    })
    const retained = crossFrame.timer.inspectWindow(targetWindow(0, 30))
    assert.equal(retained.metrics.gpuFrameMsP95, 1)
    assert.equal(retained.evidence.acceptedSampleCount, 1)
    crossFrame.timer.dispose()

    const reentrantFake = createFakeContext('webgl2')
    let reentrantTimer
    let entered = false
    reentrantTimer = createWebGlGpuTimer({
        gl: reentrantFake.gl,
        backend: 'webgl2',
        sampleEvery: 1,
        now() {
            if (!entered) {
                entered = true
                reentrantTimer.dispose()
            }
            return 0
        },
    })
    let began
    assert.doesNotThrow(() => {
        began = reentrantTimer.beginFrame()
    })
    assert.equal(began, false)
    assert.equal(reentrantFake.queries.length, 0)
    assert.equal(reentrantTimer.inspectWindow(targetWindow(0, 10)).capability.observed, false)
})

for (const nestedMethod of ['beginFrame', 'endFrame']) {
    test(`a now callback nested ${nestedMethod} invalidates only target bounds`, () => {
        const fake = createFakeContext('webgl2')
        const nestedResults = []
        let time = 0
        let timer
        timer = createWebGlGpuTimer({
            gl: fake.gl,
            backend: 'webgl2',
            sampleEvery: 1,
            now() {
                nestedResults.push(timer[nestedMethod]())
                return time
            },
        })

        assert.equal(timer.beginFrame(), true)
        time = 10
        assert.equal(timer.endFrame(), true)
        assert.deepEqual(nestedResults, [false, false])
        assert.equal(fake.queries.length, 1)
        assert.equal(timer.getSnapshot().clockErrorCount, 2)

        fake.setAvailable(0, 4_000_000)
        timer.poll()
        assert.deepEqual(timer.takeLatestEvidence(), {
            status: 'measured',
            timeMs: 4,
            source: 'webgl-disjoint-timer-query',
        })
        const target = timer.inspectWindow(targetWindow(0, 10))
        assert.equal(target.capability.observed, false)
        assert.equal('metrics' in target, false)
        assert.equal('evidence' in target, false)
        assert.equal(timer.getSnapshot().acceptedTargetSampleCount, 0)
        timer.dispose()
    })
}

test('hostile WebGL target windows and contexts fail closed while inspect remains bound', () => {
    const harness = createTargetTimer('webgl2')
    recordTargetQuery(harness, { start: 0, end: 10, resultNanoseconds: 1_000_000 })
    const unreadableWindow = new Proxy(
        {},
        {
            get() {
                throw new Error('unreadable window')
            },
        }
    )
    let unreadable
    assert.doesNotThrow(() => {
        unreadable = harness.timer.inspectWindow(unreadableWindow)
    })
    assert.equal(unreadable.capability.observed, false)
    assert.equal('metrics' in unreadable, false)

    for (const invalid of [targetWindow(0, Number.NaN), targetWindow(10, 0), targetWindow(0, 10, 'foreign-window')]) {
        const inspected = harness.timer.inspectWindow(invalid)
        assert.equal(inspected.capability.observed, false)
        assert.equal('evidence' in inspected, false)
    }

    const inspect = harness.timer.inspect
    const withoutContext = inspect()
    assert.deepEqual(withoutContext.inventory, { renderers: ['webgl2'] })
    assert.deepEqual(withoutContext.owners, [{ relation: 'renderer-host', label: 'Condev WebGL GPU timer' }])
    assert.equal(withoutContext.renderer.capability.observed, false)

    const hostileContext = Object.defineProperty({}, 'evidenceWindow', {
        get() {
            throw new Error('unreadable context')
        },
    })
    let hostile
    assert.doesNotThrow(() => {
        hostile = inspect(hostileContext)
    })
    assert.equal(hostile.renderer.capability.observed, false)
    assert.equal('metrics' in hostile.renderer, false)
    assert.deepEqual(inspect({ evidenceWindow: targetWindow(0, 10) }).renderer.metrics, { gpuFrameMsP95: 1 })

    let nestedInspection
    const recursiveWindow = {
        get startedAt() {
            nestedInspection = harness.timer.inspectWindow(targetWindow(0, 10))
            return 0
        },
        endedAt: 10,
        relation: 'selection-window',
    }
    let recursiveOuter
    assert.doesNotThrow(() => {
        recursiveOuter = harness.timer.inspectWindow(recursiveWindow)
    })
    assert.equal(nestedInspection.capability.observed, false)
    assert.equal(recursiveOuter.capability.observed, false)
    assert.equal('metrics' in recursiveOuter, false)
    assert.equal('evidence' in recursiveOuter, false)
    assert.deepEqual(harness.timer.inspectWindow(targetWindow(0, 10)).metrics, { gpuFrameMsP95: 1 })
    harness.timer.dispose()

    const reentrant = createTargetTimer('webgl2')
    recordTargetQuery(reentrant, { start: 0, end: 10, resultNanoseconds: 1_000_000 })
    const disposingWindow = {
        get startedAt() {
            reentrant.timer.dispose()
            return 0
        },
        endedAt: 10,
        relation: 'selection-window',
    }
    let afterDisposal
    assert.doesNotThrow(() => {
        afterDisposal = reentrant.timer.inspectWindow(disposingWindow)
    })
    assert.equal(afterDisposal.capability.state, 'unknown')
    assert.equal(afterDisposal.capability.observed, false)
    assert.equal('metrics' in afterDisposal, false)
})
