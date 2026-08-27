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
