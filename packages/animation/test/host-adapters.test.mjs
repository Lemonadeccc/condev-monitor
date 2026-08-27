import assert from 'node:assert/strict'
import test from 'node:test'

// cspell:ignore rvfc

import {
    createFrameworkCommitProbe,
    createGsapLifecycleProbe,
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

    probe.dispose()
    probe.dispose()
    assert.equal(probe.recordCommit({ renderMs: 1 }), false)

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
