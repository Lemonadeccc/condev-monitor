import assert from 'node:assert/strict'
import test from 'node:test'

// cspell:ignore rvfc

import {
    createFrameworkCommitProbe,
    createGsapLifecycleCycleAnalyzer,
    createGsapLifecycleProbe,
    createGsapTickerObserver,
    createRendererHostProbe,
    createThreeRendererProbe,
    createVideoFrameProbe,
    readGsapLifecycleSnapshot,
    readThreeRendererSnapshot,
    readVideoPlaybackQuality,
} from '../build/esm/index.mjs'

test('framework probe keeps React render work distinct from commit work and isolates sink failures', () => {
    const samples = []
    const probe = createFrameworkCommitProbe({
        framework: 'react',
        now: () => 50,
        sink: { recordFrameworkStats: sample => samples.push(sample) },
    })

    probe.onReactProfilerRender('PrivateComponentName', 'update', 7.5, 11, 20, 42)
    assert.deepEqual(samples, [
        {
            source: 'react-profiler',
            framework: 'react',
            phase: 'update',
            renderMs: 7.5,
            baseRenderMs: 11,
            timestampMs: 42,
        },
    ])
    assert.equal('commitMs' in samples[0], false)
    assert.equal(JSON.stringify(samples).includes('PrivateComponentName'), false)

    assert.equal(probe.recordCommit({ phase: 'mount', renderMs: 2, commitMs: 3 }), true)
    assert.deepEqual([samples[1].renderMs, samples[1].commitMs, samples[1].timestampMs], [2, 3, 50])
    assert.equal(probe.recordCommit({ renderMs: Number.NaN, commitMs: -1 }), false)
    assert.equal(probe.recordCommit({ renderMs: 600_001 }), false)
    assert.equal(probe.recordUpdateWindow({ updateWindowMs: 8, timestampMs: 60 }), true)
    assert.deepEqual(samples[2], {
        source: 'framework-lifecycle',
        framework: 'react',
        phase: 'update',
        updateWindowMs: 8,
        timestampMs: 60,
    })
    assert.equal(probe.recordUpdateWindow({ updateWindowMs: Number.NaN }), false)
    assert.equal(probe.recordUpdateWindow({ updateWindowMs: 600_001 }), false)
    assert.equal(probe.recordCheckWindow({ checkWindowMs: 5, timestampMs: 70 }), true)
    assert.deepEqual(samples[3], {
        source: 'framework-check',
        framework: 'react',
        phase: 'check',
        checkWindowMs: 5,
        timestampMs: 70,
    })
    assert.equal(probe.recordCheckWindow({ checkWindowMs: Number.NaN }), false)
    assert.equal(probe.recordCheckWindow({ checkWindowMs: 600_001 }), false)

    probe.dispose()
    probe.dispose()
    assert.equal(probe.recordCommit({ renderMs: 1 }), false)
    assert.equal(probe.recordUpdateWindow({ updateWindowMs: 1 }), false)
    assert.equal(probe.recordCheckWindow({ checkWindowMs: 1 }), false)

    const throwingProbe = createFrameworkCommitProbe({
        framework: 'vue',
        sink: {
            recordFrameworkStats() {
                throw new Error('host sink failure')
            },
        },
    })
    assert.doesNotThrow(() => throwingProbe.onReactProfilerRender('ignored', 'mount', 1, 1, 0, 1))
    assert.equal(throwingProbe.recordCommit({ commitMs: 1 }), false)

    const nonReactSamples = []
    const nonReactProbe = createFrameworkCommitProbe({
        framework: 'vue',
        sink: { recordFrameworkStats: sample => nonReactSamples.push(sample) },
    })
    nonReactProbe.onReactProfilerRender('ignored', 'update', 1, 1, 0, 1)
    assert.equal(nonReactSamples.length, 0)
})

test('public helpers normalize runtime enum escape values before a custom sink sees them', () => {
    const frameworkSamples = []
    const framework = createFrameworkCommitProbe({
        framework: 'https://private.example/framework',
        sink: { recordFrameworkStats: sample => frameworkSamples.push(sample) },
    })
    assert.equal(framework.recordCommit({ renderMs: 1 }), true)
    assert.equal(frameworkSamples[0].framework, 'other')

    const renderer = readThreeRendererSnapshot({}, { backend: 'https://private.example/renderer' })
    assert.equal(renderer.backend, 'unknown')
    const impossibleCanvasThree = readThreeRendererSnapshot({}, { backend: 'canvas2d' })
    assert.equal(impossibleCanvasThree.backend, 'unknown')

    const lifecycle = readGsapLifecycleSnapshot({}, { checkpoint: 'https://private.example/checkpoint' })
    assert.equal(lifecycle.checkpoint, 'manual')
    assert.doesNotMatch(JSON.stringify([frameworkSamples, renderer, lifecycle]), /private\.example/)
})

test('Three snapshot reads public counters and accepts GPU time only with complete valid evidence', () => {
    const renderer = {
        info: {
            render: { calls: 5, triangles: 120, lines: 4, points: 2 },
            memory: { geometries: 3, textures: 7 },
            programs: [{}, {}],
        },
        getContext() {
            return { isContextLost: () => false }
        },
    }
    const valid = readThreeRendererSnapshot(renderer, {
        backend: 'webgl2',
        now: () => 100,
        readGpuTiming: () => ({
            timeMs: 3.25,
            valid: true,
            disjoint: false,
            contextLost: false,
            source: 'webgl-disjoint-timer-query',
        }),
    })
    assert.deepEqual(valid, {
        source: 'three-renderer-info',
        backend: 'webgl2',
        timestampMs: 100,
        drawCalls: 5,
        triangles: 120,
        lines: 4,
        points: 2,
        geometries: 3,
        textures: 7,
        programs: 2,
        gpu: {
            status: 'measured',
            timeMs: 3.25,
            source: 'webgl-disjoint-timer-query',
            valid: true,
            disjoint: false,
            contextLost: false,
        },
    })

    const mismatched = readThreeRendererSnapshot(renderer, {
        backend: 'webgpu',
        readGpuTiming: () => ({
            timeMs: 2,
            valid: true,
            disjoint: false,
            contextLost: false,
            source: 'webgl-disjoint-timer-query',
        }),
    })
    assert.deepEqual(mismatched.gpu, { status: 'invalid', source: 'webgl-disjoint-timer-query' })

    const neutral = readThreeRendererSnapshot(renderer, {
        backend: 'unknown',
        readGpuTiming: () => ({
            timeMs: 2,
            valid: true,
            disjoint: false,
            contextLost: false,
            source: 'host-timer-query',
        }),
    })
    assert.equal(neutral.gpu.status, 'measured')

    const canonical = readThreeRendererSnapshot(renderer, {
        backend: 'webgl2',
        readGpuTiming: () => ({ status: 'measured', timeMs: 1.5, source: 'webgl-disjoint-timer-query' }),
    })
    assert.deepEqual(canonical.gpu, {
        status: 'measured',
        timeMs: 1.5,
        source: 'webgl-disjoint-timer-query',
        valid: true,
        disjoint: false,
        contextLost: false,
    })

    const canonicalDisjoint = readThreeRendererSnapshot(renderer, {
        backend: 'webgl2',
        readGpuTiming: () => ({ status: 'disjoint', source: 'webgl-disjoint-timer-query' }),
    })
    assert.deepEqual(canonicalDisjoint.gpu, { status: 'disjoint', source: 'webgl-disjoint-timer-query' })

    for (const [reading, expectedStatus] of [
        [
            {
                timeMs: 2,
                valid: true,
                disjoint: true,
                contextLost: false,
                source: 'webgl-disjoint-timer-query',
            },
            'disjoint',
        ],
        [
            {
                timeMs: 2,
                valid: true,
                disjoint: false,
                contextLost: true,
                source: 'webgl-disjoint-timer-query',
            },
            'context-lost',
        ],
        [{ timeMs: 2, valid: true, disjoint: false, contextLost: false }, 'invalid'],
        [
            {
                timeMs: Number.NaN,
                valid: true,
                disjoint: false,
                contextLost: false,
                source: 'host-timer-query',
            },
            'invalid',
        ],
    ]) {
        const snapshot = readThreeRendererSnapshot(renderer, { readGpuTiming: () => reading })
        assert.equal(snapshot.gpu.status, expectedStatus)
        assert.equal('timeMs' in snapshot.gpu, false)
    }

    const lostRenderer = { ...renderer, getContext: () => ({ isContextLost: () => true }) }
    const lost = readThreeRendererSnapshot(lostRenderer, {
        readGpuTiming: () => ({
            timeMs: 1,
            valid: true,
            disjoint: false,
            contextLost: false,
            source: 'host-timer-query',
        }),
    })
    assert.equal(lost.gpu.status, 'context-lost')
    assert.equal('timeMs' in lost.gpu, false)
})

test('Three probe cleanup is idempotent and sink exceptions cannot break capture', () => {
    let calls = 0
    const probe = createThreeRendererProbe({
        renderer: { info: { render: { calls: 1 } } },
        sink: {
            recordRenderStats() {
                calls += 1
                throw new Error('sink failure')
            },
        },
    })
    assert.doesNotThrow(() => probe.capture())
    assert.equal(calls, 1)
    probe.dispose()
    probe.dispose()
    assert.equal(probe.capture(), null)
    assert.equal(calls, 1)
})

test('generic renderer host probe normalizes closed counters and resolved GPU evidence', () => {
    const samples = []
    const probe = createRendererHostProbe({
        backend: 'webgl2',
        now: () => 125,
        read: () => ({
            gpuTimerCapability: 'supported',
            drawCalls: 0,
            triangles: 0,
            lines: 0,
            points: 0,
            geometries: 0,
            textures: 0,
            programs: 0,
            contextLost: false,
            gpu: {
                timeMs: 0,
                valid: true,
                disjoint: false,
                contextLost: false,
                source: 'webgl-disjoint-timer-query',
            },
        }),
        sink: { recordRenderStats: sample => samples.push(sample) },
    })

    const captured = probe.capture()
    assert.deepEqual(captured, {
        source: 'renderer-host',
        backend: 'webgl2',
        timestampMs: 125,
        gpuTimerCapability: 'supported',
        drawCalls: 0,
        triangles: 0,
        lines: 0,
        points: 0,
        geometries: 0,
        textures: 0,
        programs: 0,
        gpu: {
            status: 'measured',
            timeMs: 0,
            source: 'webgl-disjoint-timer-query',
            valid: true,
            disjoint: false,
            contextLost: false,
        },
    })
    assert.deepEqual(samples, [captured])
})

test('generic renderer host probe preserves only closed GPU timer capabilities', () => {
    for (const gpuTimerCapability of ['supported', 'unsupported', 'disabled', 'unknown']) {
        const sample = createRendererHostProbe({
            backend: 'webgl2',
            read: () => ({ gpuTimerCapability, gpu: null }),
            sink: { recordRenderStats() {} },
        }).capture()
        assert.equal(sample.gpuTimerCapability, gpuTimerCapability)
        assert.deepEqual(sample.gpu, { status: 'not-provided' })
    }

    let sinkCalls = 0
    for (const read of [
        () => ({ gpuTimerCapability: 'future-capability', gpu: null }),
        () => ({
            gpuTimerCapability: 'unsupported',
            gpu: { status: 'measured', timeMs: 1, source: 'webgl-disjoint-timer-query' },
        }),
        () => ({ gpuTimerCapability: 'disabled', gpu: { status: 'disjoint', source: 'webgl-disjoint-timer-query' } }),
        () => ({ gpuTimerCapability: 'supported', gpu: { status: 'context-lost', source: 'webgl-disjoint-timer-query' } }),
        () => ({ gpuTimerCapability: 'supported', gpu: { status: 'error', source: 'webgl-disjoint-timer-query' } }),
        () =>
            Object.defineProperty({}, 'gpuTimerCapability', {
                get() {
                    throw new Error('released timer')
                },
            }),
    ]) {
        const probe = createRendererHostProbe({
            backend: 'webgl2',
            read,
            sink: { recordRenderStats: () => (sinkCalls += 1) },
        })
        assert.equal(probe.capture(), null)
    }
    assert.equal(sinkCalls, 0)

    const canvasProbe = createRendererHostProbe({
        backend: 'canvas2d',
        read: () => ({ gpuTimerCapability: 'supported', gpu: null }),
        sink: { recordRenderStats: () => (sinkCalls += 1) },
    })
    assert.equal(canvasProbe.capture(), null)
    assert.equal(sinkCalls, 0)
})

test('generic renderer host probe accepts closed GPU status readings without invented timing values', () => {
    const readings = [
        {
            input: { status: 'measured', timeMs: 0, source: 'webgl-disjoint-timer-query' },
            expected: {
                status: 'measured',
                timeMs: 0,
                source: 'webgl-disjoint-timer-query',
                valid: true,
                disjoint: false,
                contextLost: false,
            },
        },
        { input: { status: 'not-provided' }, expected: { status: 'not-provided' } },
        {
            input: { status: 'invalid', source: 'webgl-disjoint-timer-query' },
            expected: { status: 'invalid', source: 'webgl-disjoint-timer-query' },
        },
        {
            input: { status: 'disjoint', source: 'webgl-disjoint-timer-query' },
            expected: { status: 'disjoint', source: 'webgl-disjoint-timer-query' },
        },
        {
            input: { status: 'context-lost', source: 'webgl-disjoint-timer-query' },
            expected: { status: 'context-lost', source: 'webgl-disjoint-timer-query' },
        },
        {
            input: { status: 'error', source: 'webgl-disjoint-timer-query' },
            expected: { status: 'error', source: 'webgl-disjoint-timer-query' },
        },
    ]

    for (const { input, expected } of readings) {
        const sample = createRendererHostProbe({
            backend: 'webgl2',
            read: () => ({ gpu: input }),
            sink: { recordRenderStats() {} },
        }).capture()
        assert.deepEqual(sample.gpu, expected)
        if (input.status !== 'measured') assert.equal('timeMs' in sample.gpu, false)
    }
})

test('generic renderer host probe rejects contradictory GPU status fields and incompatible provenance', () => {
    const invalidReadings = [
        { backend: 'webgl2', gpu: { status: 'measured', timeMs: 1 } },
        { backend: 'webgl2', gpu: { status: 'measured', timeMs: -1, source: 'webgl-disjoint-timer-query' } },
        { backend: 'webgl2', gpu: { status: 'measured', timeMs: Number.NaN, source: 'webgl-disjoint-timer-query' } },
        { backend: 'webgl2', gpu: { status: 'measured', timeMs: 1, source: 'private-gpu-clock' } },
        { backend: 'webgpu', gpu: { status: 'measured', timeMs: 1, source: 'webgl-disjoint-timer-query' } },
        { backend: 'webgl2', gpu: { status: 'disjoint', timeMs: 0, source: 'webgl-disjoint-timer-query' } },
        { backend: 'webgl2', gpu: { status: 'error', valid: false, source: 'webgl-disjoint-timer-query' } },
        { backend: 'webgl2', gpu: { status: 'measured', timeMs: 1, valid: true, source: 'webgl-disjoint-timer-query' } },
        { backend: 'webgl2', gpu: { status: 'future-status', source: 'webgl-disjoint-timer-query' } },
        { backend: 'webgl2', gpu: 'not-a-reading' },
        { backend: 'webgl2', gpu: [] },
    ]

    for (const { backend, gpu } of invalidReadings) {
        const sample = createRendererHostProbe({
            backend,
            read: () => ({ gpu }),
            sink: { recordRenderStats() {} },
        }).capture()
        assert.equal(sample.gpu.status, 'invalid')
        assert.equal('timeMs' in sample.gpu, false)
        assert.doesNotMatch(JSON.stringify(sample.gpu), /private-gpu-clock|future-status|not-a-reading/)
    }

    const poisonedGpu = Object.defineProperty({}, 'source', {
        get() {
            throw new Error('must not be read after direct context loss')
        },
    })
    const contextLost = createRendererHostProbe({
        backend: 'webgl2',
        read: () => ({ contextLost: true, gpu: poisonedGpu }),
        sink: { recordRenderStats() {} },
    }).capture()
    assert.deepEqual(contextLost.gpu, { status: 'context-lost' })
})

test('generic renderer host probe is fail-closed, exception-safe, and disposable', () => {
    let invalidSinkCalls = 0
    const invalidProbe = createRendererHostProbe({
        backend: 'webgpu',
        read: () => ({ drawCalls: -1, triangles: 1.5, lines: 1_000_000_001, points: Number.NaN }),
        sink: { recordRenderStats: () => (invalidSinkCalls += 1) },
    })
    assert.equal(invalidProbe.capture(), null)
    assert.equal(invalidSinkCalls, 0)

    let readCalls = 0
    let sinkCalls = 0
    let reading = {
        drawCalls: 4,
        triangles: 12,
        textures: 2,
        programs: 3,
        contextLost: false,
        gpu: {
            timeMs: 2,
            valid: true,
            disjoint: false,
            contextLost: false,
            source: 'webgl-disjoint-timer-query',
        },
    }
    const probe = createRendererHostProbe({
        backend: 'webgpu',
        read() {
            readCalls += 1
            return reading
        },
        sink: {
            recordRenderStats() {
                sinkCalls += 1
                throw new Error('sink failure')
            },
        },
    })

    let mismatched
    assert.doesNotThrow(() => {
        mismatched = probe.capture()
    })
    assert.equal(mismatched.source, 'renderer-host')
    assert.equal(mismatched.backend, 'webgpu')
    assert.equal(mismatched.drawCalls, 4)
    assert.equal(mismatched.triangles, 12)
    assert.equal(mismatched.textures, 2)
    assert.equal(mismatched.programs, 3)
    assert.deepEqual(mismatched.gpu, { status: 'invalid', source: 'webgl-disjoint-timer-query' })

    reading = { contextLost: true }
    assert.deepEqual(probe.capture().gpu, { status: 'context-lost' })
    assert.equal(sinkCalls, 2)
    probe.dispose()
    probe.dispose()
    assert.equal(probe.capture(), null)
    assert.equal(readCalls, 2)

    const throwingRead = createRendererHostProbe({
        read() {
            throw new Error('read failure')
        },
        sink: { recordRenderStats: () => assert.fail('read failures must not reach the sink') },
    })
    assert.doesNotThrow(() => throwingRead.capture())
    assert.equal(throwingRead.capture(), null)

    const contextGetterFailure = createRendererHostProbe({
        backend: 'webgl2',
        read: () => ({
            drawCalls: 1,
            get contextLost() {
                throw new Error('released context')
            },
            gpu: {
                timeMs: 1,
                valid: true,
                disjoint: false,
                contextLost: false,
                source: 'webgl-disjoint-timer-query',
            },
        }),
        sink: { recordRenderStats() {} },
    })
    assert.deepEqual(contextGetterFailure.capture().gpu, { status: 'error' })

    const nestedGpuFailure = createRendererHostProbe({
        backend: 'webgl2',
        read: () => ({
            drawCalls: 1,
            contextLost: false,
            gpu: Object.defineProperty({}, 'source', {
                get() {
                    throw new Error('revoked GPU result')
                },
            }),
        }),
        sink: { recordRenderStats() {} },
    })
    assert.deepEqual(nestedGpuFailure.capture().gpu, { status: 'error' })

    const target = {}
    const { proxy, revoke } = Proxy.revocable(target, {})
    revoke()
    const revokedReading = createRendererHostProbe({
        read: () => proxy,
        sink: { recordRenderStats: () => assert.fail('revoked readings must not reach the sink') },
    })
    assert.doesNotThrow(() => revokedReading.capture())
    assert.equal(revokedReading.capture(), null)

    const invalidContextType = createRendererHostProbe({
        read: () => ({ drawCalls: 1, contextLost: 'no' }),
        sink: { recordRenderStats: () => assert.fail('invalid context state must not reach the sink') },
    })
    assert.equal(invalidContextType.capture(), null)
})

test('generic renderer host probe represents Canvas2D without accepting invented GPU time', () => {
    const sample = createRendererHostProbe({
        backend: 'canvas2d',
        read: () => ({
            drawCalls: 0,
            gpu: {
                timeMs: 1,
                valid: true,
                disjoint: false,
                contextLost: false,
                source: 'host-timer-query',
            },
        }),
        sink: { recordRenderStats() {} },
    }).capture()

    assert.equal(sample.backend, 'canvas2d')
    assert.equal(sample.drawCalls, 0)
    assert.deepEqual(sample.gpu, { status: 'invalid', source: 'host-timer-query' })
})

test('GSAP lifecycle probe uses public snapshots, tolerates child failures, and never kills business animations', () => {
    let killCalls = 0
    const children = [
        { isActive: () => true, kill: () => (killCalls += 1) },
        { isActive: () => false, kill: () => (killCalls += 1) },
        {
            isActive() {
                throw new Error('detached animation')
            },
            kill: () => (killCalls += 1),
        },
    ]
    const gsap = {
        globalTimeline: { getChildren: () => children },
        get ticker() {
            throw new Error('private ticker must not be inspected')
        },
    }
    const scrollTrigger = { getAll: () => [{}, {}] }
    const direct = readGsapLifecycleSnapshot({ gsap, scrollTrigger }, { checkpoint: 'mount', now: () => 10 })
    assert.deepEqual(direct, {
        source: 'gsap-public-api',
        checkpoint: 'mount',
        timestampMs: 10,
        animations: { status: 'measured', total: 3, rejectedActiveChecks: 1 },
        scrollTriggers: { status: 'measured', total: 2 },
    })

    const samples = []
    const probe = createGsapLifecycleProbe({
        gsap,
        scrollTrigger,
        sink: { recordLifecycleStats: sample => samples.push(sample) },
    })
    assert.equal(probe.capture('after-interaction').checkpoint, 'after-interaction')
    probe.dispose()
    probe.dispose()
    assert.equal(probe.capture('unmount'), null)
    assert.equal(samples.length, 1)
    assert.equal(killCalls, 0)

    const unavailable = readGsapLifecycleSnapshot({})
    assert.equal(unavailable.animations.status, 'unsupported')
    assert.equal(unavailable.scrollTriggers.status, 'unsupported')
})

test('GSAP lifecycle cycle analyzer requires ordered equivalent cycles before reporting a growth candidate', () => {
    const analyzer = createGsapLifecycleCycleAnalyzer({ minimumCycles: 3, capacity: 3 })
    const sample = (checkpoint, animations, scrollTriggers) => ({
        source: 'gsap-public-api',
        checkpoint,
        timestampMs: 10,
        animations: animations === null ? { status: 'unsupported' } : { status: 'measured', total: animations },
        scrollTriggers: scrollTriggers === null ? { status: 'unsupported' } : { status: 'measured', total: scrollTriggers },
    })
    const cycle = (animations, scrollTriggers) => {
        assert.equal(analyzer.record(sample('mount', animations + 2, scrollTriggers + 1)), true)
        assert.equal(analyzer.record(sample('after-interaction', animations + 1, scrollTriggers + 1)), true)
        assert.equal(analyzer.record(sample('unmount', animations, scrollTriggers)), true)
    }

    assert.equal(analyzer.record(sample('manual', 99, 99)), false)
    assert.equal(analyzer.record(sample('unmount', 99, 99)), false)
    cycle(1, 4)
    cycle(2, 4)
    assert.deepEqual(analyzer.snapshot(), {
        status: 'insufficient-cycles',
        growthCandidate: null,
        animationGrowthCandidate: null,
        scrollTriggerGrowthCandidate: null,
        completedCycleCount: 2,
        retainedCycleCount: 2,
        minimumCycles: 3,
        capacity: 3,
        droppedCycleCount: 0,
        rejectedCheckpointCount: 2,
        truncated: false,
        postUnmountAnimationTotals: [1, 2],
        postUnmountScrollTriggerTotals: [4, 4],
    })

    cycle(3, 4)
    assert.deepEqual(analyzer.snapshot(), {
        status: 'growth-candidate',
        growthCandidate: true,
        animationGrowthCandidate: true,
        scrollTriggerGrowthCandidate: false,
        completedCycleCount: 3,
        retainedCycleCount: 3,
        minimumCycles: 3,
        capacity: 3,
        droppedCycleCount: 0,
        rejectedCheckpointCount: 2,
        truncated: false,
        postUnmountAnimationTotals: [1, 2, 3],
        postUnmountScrollTriggerTotals: [4, 4, 4],
    })

    cycle(2, 4)
    const bounded = analyzer.snapshot()
    assert.equal(bounded.status, 'no-strict-growth-candidate')
    assert.equal(bounded.growthCandidate, false)
    assert.deepEqual(bounded.postUnmountAnimationTotals, [2, 3, 2])
    assert.equal(bounded.completedCycleCount, 4)
    assert.equal(bounded.droppedCycleCount, 1)
    assert.equal(bounded.truncated, true)

    analyzer.dispose()
    assert.equal(analyzer.record(sample('mount', 1, 1)), false)
    assert.equal(analyzer.snapshot().completedCycleCount, 4)
})

test('GSAP lifecycle cycle analyzer invalidates interrupted cycles and reset clears every local state', () => {
    const analyzer = createGsapLifecycleCycleAnalyzer()
    const sample = checkpoint => ({
        source: 'gsap-public-api',
        checkpoint,
        timestampMs: 1,
        animations: { status: 'measured', total: 1 },
        scrollTriggers: { status: 'measured', total: 1 },
    })

    assert.equal(analyzer.record(sample('mount')), true)
    assert.equal(analyzer.record(sample('unmount')), false)
    assert.equal(analyzer.record(sample('after-interaction')), false)
    assert.equal(analyzer.record(sample('unmount')), false)
    assert.equal(analyzer.snapshot().completedCycleCount, 0)

    assert.equal(analyzer.record(sample('mount')), true)
    assert.equal(analyzer.record(sample('after-interaction')), true)
    assert.equal(analyzer.record(sample('mount')), true)
    assert.equal(analyzer.record(sample('after-interaction')), true)
    assert.equal(analyzer.record(sample('unmount')), true)
    assert.equal(analyzer.snapshot().completedCycleCount, 1)

    analyzer.record(sample('mount'))
    analyzer.reset()
    assert.deepEqual(analyzer.snapshot(), {
        status: 'insufficient-cycles',
        growthCandidate: null,
        animationGrowthCandidate: null,
        scrollTriggerGrowthCandidate: null,
        completedCycleCount: 0,
        retainedCycleCount: 0,
        minimumCycles: 3,
        capacity: 10,
        droppedCycleCount: 0,
        rejectedCheckpointCount: 0,
        truncated: false,
        postUnmountAnimationTotals: [],
        postUnmountScrollTriggerTotals: [],
    })
    assert.equal(analyzer.record(sample('after-interaction')), false)
    assert.equal(analyzer.record(sample('unmount')), false)
    assert.equal(analyzer.snapshot().completedCycleCount, 0)
})

test('GSAP lifecycle cycle analyzer stays inconclusive when retained cleanup evidence is unavailable', () => {
    const analyzer = createGsapLifecycleCycleAnalyzer()
    for (let index = 0; index < 3; index += 1) {
        analyzer.record({
            source: 'gsap-public-api',
            checkpoint: 'mount',
            timestampMs: index,
            animations: { status: 'unsupported' },
            scrollTriggers: { status: 'measured', total: 2 },
        })
        analyzer.record({
            source: 'gsap-public-api',
            checkpoint: 'after-interaction',
            timestampMs: index,
            animations: { status: 'unsupported' },
            scrollTriggers: { status: 'measured', total: 2 },
        })
        analyzer.record({
            source: 'gsap-public-api',
            checkpoint: 'unmount',
            timestampMs: index,
            animations: { status: 'unsupported' },
            scrollTriggers: { status: 'measured', total: 2 },
        })
    }

    const result = analyzer.snapshot()
    assert.equal(result.status, 'inconclusive')
    assert.equal(result.growthCandidate, null)
    assert.equal(result.animationGrowthCandidate, null)
    assert.equal(result.scrollTriggerGrowthCandidate, false)
})

test('GSAP ticker observer records bounded public cadence without controlling the ticker', () => {
    const listeners = new Set()
    const addCalls = []
    const removeCalls = []
    const ticker = {
        add(...args) {
            addCalls.push(args)
            listeners.add(args[0])
        },
        remove(listener) {
            removeCalls.push(listener)
            listeners.delete(listener)
        },
        fps() {
            assert.fail('observer must not read or change ticker fps')
        },
        lagSmoothing() {
            assert.fail('observer must not read or change lag smoothing')
        },
    }
    const emit = (time, deltaTime, frame) => {
        for (const listener of [...listeners]) listener(time, deltaTime, frame)
    }
    const observer = createGsapTickerObserver({ ticker, capacity: 2, slowTickThresholdMs: 20 })

    assert.equal(observer.running, false)
    assert.equal(observer.start(), true)
    assert.equal(observer.start(), false)
    assert.equal(observer.running, true)
    assert.equal(addCalls.length, 1)
    assert.equal(addCalls[0].length, 1)

    emit(0.016, 16, 1)
    emit(0.04, 24, 2)
    emit(0.072, 32, 3)
    emit(0.08, Number.NaN, 4)
    emit(0.09, -1, 5)

    assert.deepEqual(observer.snapshot(), {
        status: 'observing',
        running: true,
        cleanupFailed: false,
        capacity: 2,
        acceptedTickCount: 3,
        retainedTickCount: 2,
        droppedTickCount: 1,
        rejectedTickCount: 2,
        truncated: true,
        slowTickThresholdMs: 20,
        slowTickTotalObservedCount: 2,
        deltaTimeMs: { count: 2, p50: 28, p75: 30, p95: 31.6, p99: 31.92, max: 32, total: 56 },
    })

    assert.equal(observer.stop(), true)
    assert.equal(observer.running, false)
    assert.equal(removeCalls[0], addCalls[0][0])
    emit(0.2, 128, 6)
    assert.equal(observer.snapshot().acceptedTickCount, 3)

    observer.reset()
    assert.deepEqual(observer.snapshot(), {
        status: 'idle',
        running: false,
        cleanupFailed: false,
        capacity: 2,
        acceptedTickCount: 0,
        retainedTickCount: 0,
        droppedTickCount: 0,
        rejectedTickCount: 0,
        truncated: false,
        slowTickThresholdMs: 20,
        slowTickTotalObservedCount: 0,
        deltaTimeMs: null,
    })
})

test('GSAP ticker observer fails closed when attachment or cleanup is unavailable', () => {
    const unsupported = createGsapTickerObserver({ ticker: {} })
    assert.equal(unsupported.start(), false)
    assert.equal(unsupported.snapshot().status, 'unsupported')
    assert.equal(unsupported.stop(), true)
    assert.equal(unsupported.snapshot().status, 'unsupported')

    const addFailure = createGsapTickerObserver({
        ticker: {
            add() {
                throw new Error('released ticker')
            },
            remove() {},
        },
    })
    assert.doesNotThrow(() => addFailure.start())
    assert.equal(addFailure.snapshot().status, 'add-failed')
    assert.equal(addFailure.stop(), true)
    assert.equal(addFailure.snapshot().status, 'add-failed')

    const sideEffectListeners = new Set()
    const sideEffectFailure = createGsapTickerObserver({
        ticker: {
            add(callback) {
                sideEffectListeners.add(callback)
                throw new Error('registered before host failure')
            },
            remove(callback) {
                sideEffectListeners.delete(callback)
            },
        },
    })
    assert.equal(sideEffectFailure.start(), false)
    assert.equal(sideEffectListeners.size, 0)
    assert.equal(sideEffectFailure.snapshot().status, 'add-failed')
    assert.equal(sideEffectFailure.snapshot().cleanupFailed, false)

    let listener
    let removeFails = true
    const cleanupFailure = createGsapTickerObserver({
        ticker: {
            add(callback) {
                listener = callback
            },
            remove(callback) {
                assert.equal(callback, listener)
                if (removeFails) throw new Error('ticker teardown raced with app cleanup')
            },
        },
    })
    assert.equal(cleanupFailure.start(), true)
    listener(0.01, 10, 1)
    assert.equal(cleanupFailure.stop(), false)
    assert.equal(cleanupFailure.running, false)
    assert.equal(cleanupFailure.snapshot().status, 'remove-failed')
    assert.equal(cleanupFailure.snapshot().cleanupFailed, true)
    listener(0.02, 10, 2)
    assert.equal(cleanupFailure.snapshot().acceptedTickCount, 1)
    assert.equal(cleanupFailure.start(), false)

    removeFails = false
    assert.equal(cleanupFailure.stop(), true)
    assert.equal(cleanupFailure.snapshot().status, 'idle')
    assert.equal(cleanupFailure.snapshot().cleanupFailed, false)
    cleanupFailure.dispose()
    assert.equal(cleanupFailure.start(), false)
    assert.equal(cleanupFailure.snapshot().status, 'disposed')
})

test('GSAP ticker observer pins teardown ownership and retries disposal after a transient cleanup failure', () => {
    const firstListeners = new Set()
    const secondListeners = new Set()
    let removeFails = false
    const firstTicker = {
        add(callback) {
            firstListeners.add(callback)
        },
        remove(callback) {
            if (removeFails) throw new Error('temporary teardown failure')
            firstListeners.delete(callback)
        },
    }
    const secondTicker = {
        add(callback) {
            secondListeners.add(callback)
        },
        remove(callback) {
            secondListeners.delete(callback)
        },
    }
    const options = { ticker: firstTicker }
    const observer = createGsapTickerObserver(options)
    assert.equal(observer.start(), true)
    options.ticker = secondTicker
    assert.equal(observer.stop(), true)
    assert.equal(firstListeners.size, 0)
    assert.equal(secondListeners.size, 0)

    assert.equal(observer.start(), true)
    removeFails = true
    observer.dispose()
    assert.equal(observer.running, false)
    assert.equal(observer.snapshot().status, 'disposed')
    assert.equal(observer.snapshot().cleanupFailed, true)
    assert.equal(firstListeners.size, 1)

    removeFails = false
    observer.dispose()
    assert.equal(observer.snapshot().cleanupFailed, false)
    assert.equal(firstListeners.size, 0)
})

class FakeVideo {
    constructor() {
        this.nextHandle = 1
        this.callbacks = new Map()
        this.cancelCount = 0
        this.quality = { totalVideoFrames: 10, droppedVideoFrames: 1, corruptedVideoFrames: 0 }
    }

    requestVideoFrameCallback(callback) {
        const handle = this.nextHandle++
        this.callbacks.set(handle, callback)
        return handle
    }

    cancelVideoFrameCallback(handle) {
        this.cancelCount += 1
        this.callbacks.delete(handle)
    }

    getVideoPlaybackQuality() {
        return { ...this.quality }
    }

    fire(now, metadata) {
        const [entry] = this.callbacks.entries()
        assert.ok(entry)
        this.callbacks.delete(entry[0])
        entry[1](now, metadata)
    }

    play() {
        throw new Error('probe must not play media')
    }

    pause() {
        throw new Error('probe must not pause media')
    }
}

test('video probe baselines the first frame, survives counter resets, and never controls playback', () => {
    const video = new FakeVideo()
    const samples = []
    const probe = createVideoFrameProbe({ video, sink: { recordMediaStats: sample => samples.push(sample) } })
    assert.equal(probe.start(), true)
    assert.equal(probe.running, true)

    video.fire(100, { mediaTime: 1, presentedFrames: 8, expectedDisplayTime: 99, processingDuration: 0.002 })
    assert.equal(samples.length, 0)

    video.quality = { totalVideoFrames: 12, droppedVideoFrames: 2, corruptedVideoFrames: 0 }
    video.fire(116, { mediaTime: 1.016, presentedFrames: 9, expectedDisplayTime: 115, processingDuration: 0.003 })
    assert.deepEqual(samples[0], {
        source: 'video-rvfc',
        timestampMs: 116,
        callbackIntervalMs: 16,
        mediaTimeDeltaMs: 16,
        presentedFramesDelta: 1,
        displayLatenessMs: 1,
        processingDurationMs: 3,
        playbackQuality: {
            status: 'measured',
            totalVideoFramesDelta: 2,
            droppedVideoFramesDelta: 1,
            corruptedVideoFramesDelta: 0,
        },
    })

    video.quality = { totalVideoFrames: 1, droppedVideoFrames: 0, corruptedVideoFrames: 0 }
    video.fire(132, { mediaTime: 0.1, presentedFrames: 1 })
    assert.equal(samples.length, 1)

    video.quality = { totalVideoFrames: 3, droppedVideoFrames: 1, corruptedVideoFrames: 0 }
    video.fire(148, { mediaTime: 0.116, presentedFrames: 2 })
    assert.equal(samples.length, 2)
    assert.deepEqual(samples[1].playbackQuality, {
        status: 'measured',
        totalVideoFramesDelta: 2,
        droppedVideoFramesDelta: 1,
        corruptedVideoFramesDelta: 0,
    })

    // Hosts call this on hidden/offscreen -> visible boundaries so a paused
    // callback interval is not reported as one giant media sample.
    probe.resetBaseline()
    video.quality = { totalVideoFrames: 4, droppedVideoFrames: 1, corruptedVideoFrames: 0 }
    video.fire(5_000, { mediaTime: 5, presentedFrames: 3 })
    assert.equal(samples.length, 2)
    video.quality = { totalVideoFrames: 5, droppedVideoFrames: 1, corruptedVideoFrames: 0 }
    video.fire(5_016, { mediaTime: 5.016, presentedFrames: 4 })
    assert.equal(samples.length, 3)
    assert.equal(samples[2].callbackIntervalMs, 16)

    probe.stop()
    probe.stop()
    assert.equal(video.cancelCount, 1)
    assert.equal(probe.running, false)
    probe.dispose()
    probe.dispose()
    assert.equal(probe.start(), false)
})

test('video probe can downsample automatic evidence while preserving interval deltas', () => {
    const video = new FakeVideo()
    const samples = []
    const probe = createVideoFrameProbe({
        video,
        minimumSampleIntervalMs: 100,
        sink: { recordMediaStats: sample => samples.push(sample) },
    })
    probe.start()
    video.fire(100, { mediaTime: 1, presentedFrames: 10 })

    video.quality = { totalVideoFrames: 11, droppedVideoFrames: 1, corruptedVideoFrames: 0 }
    video.fire(116, { mediaTime: 1.016, presentedFrames: 11 })
    video.quality = { totalVideoFrames: 12, droppedVideoFrames: 2, corruptedVideoFrames: 0 }
    video.fire(132, { mediaTime: 1.032, presentedFrames: 12 })
    assert.equal(samples.length, 0)

    video.quality = { totalVideoFrames: 18, droppedVideoFrames: 3, corruptedVideoFrames: 0 }
    video.fire(212, { mediaTime: 1.112, presentedFrames: 18 })
    assert.equal(samples.length, 1)
    assert.equal(samples[0].callbackIntervalMs, 112)
    assert.equal(samples[0].presentedFramesDelta, 8)
    assert.deepEqual(samples[0].playbackQuality, {
        status: 'measured',
        totalVideoFramesDelta: 8,
        droppedVideoFramesDelta: 2,
        corruptedVideoFramesDelta: 0,
    })
    probe.dispose()
})

test('video probe fails closed on unsupported APIs and isolates playback-quality and sink errors', () => {
    assert.deepEqual(readVideoPlaybackQuality({}), { status: 'unsupported' })
    assert.deepEqual(
        readVideoPlaybackQuality({
            getVideoPlaybackQuality: () => ({ totalVideoFrames: 10, droppedVideoFrames: 1 }),
        }),
        { status: 'measured', totalVideoFrames: 10, droppedVideoFrames: 1 }
    )
    assert.deepEqual(
        readVideoPlaybackQuality({
            getVideoPlaybackQuality() {
                throw new Error('released media')
            },
        }),
        { status: 'error' }
    )
    assert.equal(createVideoFrameProbe({ video: {}, sink: { recordMediaStats() {} } }).start(), false)

    const video = new FakeVideo()
    const probe = createVideoFrameProbe({
        video,
        sink: {
            recordMediaStats() {
                throw new Error('sink failure')
            },
        },
    })
    probe.start()
    video.fire(10, { mediaTime: 0, presentedFrames: 1 })
    assert.doesNotThrow(() => video.fire(26, { mediaTime: 0.016, presentedFrames: 2 }))
    assert.equal(probe.running, true)
    assert.equal(video.callbacks.size, 1)
    probe.dispose()
    assert.equal(video.cancelCount, 1)
})
