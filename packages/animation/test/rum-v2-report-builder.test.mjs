import assert from 'node:assert/strict'
import test from 'node:test'

// cspell:ignore rvfc

import {
    ANIMATION_RUM_V2_MAX_PAYLOAD_BYTES,
    ANIMATION_RUM_V2_METRIC_CATALOG,
    validateNormalizedAnimationRumV2,
} from '@condev-monitor/animation-rum-contract'

import { AnimationCollector, toAnimationRumSummary, toAnimationRumV2PageReport, toAnimationRumV2TargetReport } from '../build/esm/index.mjs'

class FakeRuntime {
    constructor() {
        this.isBrowser = true
        this.frameCapability = 'supported'
        this.time = 0
        this.frames = new Set()
    }

    now() {
        return this.time
    }

    wallNow() {
        return 1_777_000_000_000 + this.time
    }

    subscribeFrames(callback) {
        this.frames.add(callback)
        return () => this.frames.delete(callback)
    }

    getVisibilityState() {
        return 'visible'
    }

    onVisibilityChange() {
        return () => {}
    }

    getReducedMotion() {
        return false
    }

    onReducedMotionChange() {
        return () => {}
    }

    observePerformance() {
        return { state: 'supported', buffered: true, disconnect() {} }
    }

    tick(delta) {
        this.time += delta
        for (const callback of this.frames) callback(this.time)
    }
}

function duration(values) {
    const sorted = [...values].sort((left, right) => left - right)
    const percentile = value => sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)]
    return {
        count: sorted.length,
        p50: percentile(0.5),
        p75: percentile(0.75),
        p95: percentile(0.95),
        p99: percentile(0.99),
        max: sorted.at(-1),
        total: sorted.reduce((sum, value) => sum + value, 0),
    }
}

function capturePage() {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime, explicitRefreshHz: 60, maxFrames: 128 }).start()
    runtime.tick(0)
    for (let index = 0; index < 70; index += 1) runtime.tick(index % 17 === 0 ? 28 : 16)
    return { runtime, snapshot: collector.stop() }
}

function captureMediaPage(playbackQualities, maxHostEvidenceSamples = 8) {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({
        runtime,
        explicitRefreshHz: 60,
        maxFrames: 128,
        maxHostEvidenceSamples,
    }).start()
    runtime.tick(0)
    for (const playbackQuality of playbackQualities) {
        runtime.tick(16)
        assert.equal(
            collector.recordMediaStats({
                source: 'video-rvfc',
                timestampMs: runtime.time,
                callbackIntervalMs: 16,
                playbackQuality,
            }),
            true
        )
    }
    return { runtime, snapshot: collector.stop() }
}

function projectionOptions(runtime, overrides = {}) {
    return {
        eventId: 'event_page_12345678',
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 0.25,
        samplingPolicyVersion: 2,
        routeKey: 'gallery.detail',
        release: 'web-2.0.0',
        dist: '42',
        environment: 'production',
        sdkVersion: '0.1.0',
        ...overrides,
    }
}

function pageEvidence() {
    const supported = { state: 'supported', observed: true, buffered: false }
    return {
        enabled: true,
        sampleCount: 3,
        documentScopes: { capability: supported, retainedCount: 1, truncated: false },
        animations: {
            capability: supported,
            status: 'measured',
            sampleCount: 3,
            current: { total: 0, inspected: 0, dropped: 0, running: 0, infinite: 0 },
        },
        media: {
            capability: supported,
            status: 'not-observed',
            currentVideoCount: 0,
            retainedVideoCount: 0,
            droppedVideoCount: 0,
            rvfcSupportedVideoCount: 0,
            rvfcUnsupportedVideoCount: 0,
        },
        rendererSurfaces: {
            discoveryCapability: supported,
            contextObservationCapability: supported,
            status: 'measured',
            sampleCount: 3,
            current: {
                total: 3,
                retained: 3,
                dropped: 0,
                svg: 1,
                canvasUnknown: 0,
                canvas2d: 1,
                webgl: 0,
                webgl2: 1,
                webgpu: 0,
            },
        },
        reducedMotion: {
            capability: supported,
            status: 'measured',
            preference: true,
            reducedMotionSampleCount: 2,
            current: { runningAnimationCandidates: 0 },
        },
    }
}

function qualitySummary() {
    return {
        status: 'measured',
        acceptedSampleCount: 4,
        retainedSampleCount: 4,
        droppedSampleCount: 0,
        rejectedSampleCount: 0,
        capacity: 64,
        inputToVisual: duration([8, 10, 12, 14]),
        pointerSampleAge: duration([2, 3, 4, 5]),
        progressError: duration([0.01, 0.02, 0.03, 0.04]),
        domWebglAlignmentError: null,
        controlWritersPerFrame: null,
        controllerConflictSampleCount: 0,
        settleTime: duration([100, 120, 140, 160]),
        overshootRatio: null,
        oscillationCount: null,
        coalescedEventsAvailable: 0,
        coalescedEventsConsumed: 0,
        coalescedEventUtilization: null,
    }
}

function targetSnapshot() {
    const supported = { state: 'supported', observed: true, buffered: false }
    const signal = (values, count = values.length) => ({
        status: 'measured',
        overlapCount: count,
        overlapDurationMs: values.reduce((sum, value) => sum + value, 0),
        duration: values.length > 0 ? duration(values) : null,
    })
    return {
        schemaVersion: 1,
        selectionId: 'https://private.example/#hero',
        state: 'selected',
        selectedAt: 0,
        capturedAt: 1_200,
        elapsedMs: 1_200,
        localDescriptor: {
            tagName: 'canvas-private-id',
            role: 'private-role',
            mode: 'subtree',
            connected: true,
        },
        direct: {
            capability: supported,
            relation: 'direct-subtree',
            totalCount: 0,
            inspectedCount: 0,
            droppedAnimationCount: 0,
            runningCount: 0,
            infiniteCount: 0,
        },
        geometry: {
            capability: supported,
            backingPixelArea: 1_920 * 1_080,
            effectivePixelRatio: 2.2,
        },
        inventory: {
            uiFrameworks: ['react'],
            metaRuntimes: ['next'],
            renderers: ['webgl2'],
            motionEngines: ['gsap'],
        },
        owners: [
            {
                adapterId: 'private-adapter',
                adapterVersion: '1.0.0',
                relation: 'framework-owner',
                framework: 'react',
                label: 'PrivateProductCard',
                source: { file: '/private/ProductCard.tsx', line: 42 },
            },
        ],
        renderers: [
            {
                adapterId: 'private-renderer',
                adapterVersion: '1.2.3',
                family: 'webgl2',
                capability: supported,
                metrics: { gpuFrameMsP95: 7, drawCallsP95: 11, trianglesP95: 20_000 },
                evidence: {
                    window: { startedAt: 0, endedAt: 1_000, durationMs: 1_000 },
                    acceptedSampleCount: 3,
                    retainedSampleCount: 3,
                    droppedSampleCount: 0,
                    rejectedSampleCount: 0,
                    truncated: false,
                    gpu: {
                        valid: true,
                        disjoint: false,
                        contextLost: false,
                        source: 'webgl-timer-query',
                        rejectionReason: null,
                    },
                },
            },
        ],
        activeInteractionId: null,
        correlated: {
            frames: {
                status: 'measured',
                retainedCount: 4,
                duration: duration([10, 12, 14, 20]),
                slowFrameCount: 1,
                slowFrameRatio: 0.25,
                missedFrameOpportunities: 1,
                bursts: { count: 1, longestFrameCount: 1, longestDurationMs: 20, maxMissedFrameOpportunities: 1 },
            },
            longAnimationFrames: signal([60]),
            longTasks: signal([80]),
            eventTiming: signal([48]),
            inputFrameScheduling: {
                status: 'measured',
                retainedCount: 2,
                totalObservedCount: 2,
                droppedSampleCount: 0,
                cancelledSampleCount: 0,
                pendingCount: 0,
                duration: duration([4, 6]),
            },
            quality: qualitySummary(),
        },
        correlationRelation: 'temporal-overlap',
        correlatedDurationMs: 1_200,
        adapterErrors: ['private-renderer: secret adapter failure at https://private.example'],
    }
}

function metric(report, metricId) {
    const result = report.metrics.find(item => item.metricId === metricId)
    assert.ok(result, `missing ${metricId}`)
    return result
}

function assertAvailableMetricsHaveEvidence(report) {
    const definitions = new Map(ANIMATION_RUM_V2_METRIC_CATALOG.map(definition => [definition.metricId, definition]))
    for (const item of report.metrics) {
        if (item.status !== 'measured' && item.status !== 'partial') continue
        const family = definitions.get(item.metricId)?.family
        assert.ok(family, `missing catalog definition for ${item.metricId}`)
        assert.ok(report.providerEvidence[item.owner]?.[family]?.evidence > 0, `missing provider evidence for ${item.metricId}`)
    }
}

test('page builder emits the closed v2 projection, preserves v1, and never invents missing zeros', () => {
    const { runtime, snapshot } = capturePage()
    snapshot.privateUrl = 'https://private.example/users/42'
    snapshot.frames.selector = '#private-card'
    const v1Before = toAnimationRumSummary(snapshot, {
        eventId: 'event_v1_golden_1234',
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    const snapshotBefore = JSON.stringify(snapshot)
    const report = toAnimationRumV2PageReport(snapshot, projectionOptions(runtime))
    const v1After = toAnimationRumSummary(snapshot, {
        eventId: 'event_v1_golden_1234',
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })

    assert.deepEqual(v1After, v1Before)
    assert.equal(JSON.stringify(snapshot), snapshotBefore)
    assert.equal(report.metrics.length, 67)
    assert.equal(validateNormalizedAnimationRumV2(report, { nowEpochMs: runtime.wallNow() }).ok, true)
    assertAvailableMetricsHaveEvidence(report)
    assert.ok(new TextEncoder().encode(JSON.stringify(report)).byteLength <= ANIMATION_RUM_V2_MAX_PAYLOAD_BYTES)
    assert.deepEqual(
        [metric(report, 'main.loaf.count').value, metric(report, 'main.loaf.count').samples],
        [0, 0],
        'a supported observer window may prove an exact zero'
    )
    assert.deepEqual(
        [metric(report, 'resource.count').value, metric(report, 'resource.transfer-size.sum').value],
        [0, 0],
        'measured resource zeroes must remain distinct from missing fields'
    )
    for (const id of [
        'outcome.loaf-first-ui-to-end.count',
        'pipeline.loaf-forced-style-layout.count',
        'surface.canvas.count',
        'renderer.gpu-frame.p95',
    ]) {
        assert.equal(metric(report, id).value, null, `${id} must not invent zero without evidence`)
    }
    assert.doesNotMatch(JSON.stringify(report), /private\.example|privateUrl|selector|#private-card/)
})

test('a missing supported resource scalar fails closed while independent measured zeroes survive', () => {
    const { runtime, snapshot } = capturePage()
    snapshot.resourceTiming.transferSizeBytes = null
    const report = toAnimationRumV2PageReport(snapshot, projectionOptions(runtime))

    assert.deepEqual([metric(report, 'resource.count').value, metric(report, 'resource.count').status], [0, 'partial'])
    assert.deepEqual(
        [metric(report, 'resource.transfer-size.sum').value, metric(report, 'resource.transfer-size.sum').status],
        [null, 'unknown']
    )
    assert.ok(report.captureQuality.reasons.includes('source-field-incomplete'))
})

test('page builder maps Browser page evidence and the exact browser-utils LoAF diagnostics shape', () => {
    const { runtime, snapshot } = capturePage()
    const report = toAnimationRumV2PageReport(
        snapshot,
        projectionOptions(runtime, {
            pageEvidence: pageEvidence(),
            runtime: { framework: 'react', renderer: 'mixed', backend: 'webgl2' },
            viewportBucket: 'large',
            dprBucket: '2',
            interactionQuality: qualitySummary(),
            loafDiagnostics: {
                loafFirstUiEventToFrameEnd: {
                    capability: 'supported',
                    count: 0,
                    p95Ms: null,
                    accepted: 0,
                    rejected: 0,
                    retained: 0,
                    dropped: 0,
                    truncated: false,
                    status: 'not-observed',
                },
                loafAttributedForcedStyleLayout: {
                    capability: 'supported',
                    count: 3,
                    p95Ms: 12,
                    accepted: 3,
                    rejected: 0,
                    retained: 3,
                    dropped: 0,
                    truncated: false,
                    status: 'measured',
                },
            },
        })
    )

    assert.equal(validateNormalizedAnimationRumV2(report, { nowEpochMs: runtime.wallNow() }).ok, true)
    assertAvailableMetricsHaveEvidence(report)
    assert.deepEqual(
        [metric(report, 'outcome.loaf-first-ui-to-end.count').value, metric(report, 'outcome.loaf-first-ui-to-end.p95').value],
        [0, null]
    )
    assert.deepEqual(
        [metric(report, 'pipeline.loaf-forced-style-layout.count').value, metric(report, 'pipeline.loaf-forced-style-layout.p95').value],
        [3, 12]
    )
    assert.equal(metric(report, 'surface.canvas.count').value, 2)
    assert.equal(metric(report, 'surface.svg.count').value, 1)
    assert.equal(metric(report, 'media.video-element.count').value, 0)
    assert.equal(metric(report, 'accessibility.reduced-motion-active-candidate.count').value, 0)
    assert.equal(metric(report, 'interaction.input-to-visual.p95').value, 14)
})

test('target builder requires an explicit semantic target key and keeps direct, overlap, and adapter relations separate', () => {
    const { runtime, snapshot } = capturePage()
    const target = targetSnapshot()
    const report = toAnimationRumV2TargetReport(
        snapshot,
        target,
        projectionOptions(runtime, {
            eventId: 'event_target_12345678',
            captureId: 'capture_target_12345678',
            targetKey: 'hero-canvas',
        })
    )

    const validation = validateNormalizedAnimationRumV2(report, { nowEpochMs: runtime.wallNow() })
    assert.equal(validation.ok, true, validation.ok ? '' : validation.errors.join(', '))
    assert.equal(report.scope, 'target')
    assert.equal(report.metrics.length, 48)
    assert.equal(report.parentCaptureId, snapshot.captureId)
    assert.equal(report.targetKey, 'hero-canvas')
    assert.equal(report.context.runtime.framework, 'react')
    assert.equal(metric(report, 'frame.duration.p95').relation, 'target-temporal-overlap')
    assert.equal(metric(report, 'frame.duration.p95').value, 20)
    assert.equal(metric(report, 'animation.running.count').relation, 'target-direct')
    assert.equal(metric(report, 'animation.running.count').value, 0)
    assert.equal(metric(report, 'target.backing-store-pixels-bucket.latest').value, 2_073_600)
    assert.equal(metric(report, 'target.effective-pixel-ratio-bucket.latest').value, 3)
    assert.equal(metric(report, 'renderer.gpu-frame.p95').relation, 'adapter')
    assert.equal(metric(report, 'renderer.gpu-frame.p95').value, 7)
    assert.equal(metric(report, 'outcome.input-delay.p95').value, null)
    assertAvailableMetricsHaveEvidence(report)
    assert.doesNotMatch(JSON.stringify(report), /private\.example|PrivateProductCard|ProductCard\.tsx|private-renderer|selectionId/)

    const page = toAnimationRumV2PageReport(snapshot, projectionOptions(runtime))
    const supportedIds = new Set([...page.metrics, ...report.metrics].map(item => item.metricId))
    assert.equal(supportedIds.size, 69)
    assert.deepEqual([...supportedIds].sort(), ANIMATION_RUM_V2_METRIC_CATALOG.map(item => item.metricId).sort())

    assert.throws(
        () =>
            toAnimationRumV2TargetReport(
                snapshot,
                target,
                projectionOptions(runtime, {
                    eventId: 'event_target_87654321',
                    captureId: 'capture_target_87654321',
                    targetKey: '#hero.private-card',
                })
            ),
        /targetKey/
    )
    assert.throws(
        () =>
            toAnimationRumV2TargetReport(
                snapshot,
                target,
                projectionOptions(runtime, {
                    eventId: 'event_target_abcdefgh',
                    captureId: snapshot.captureId,
                    targetKey: 'hero-canvas',
                })
            ),
        /differ/
    )
})

test('target builder omits GPU timing whose source does not match the renderer backend', () => {
    const { runtime, snapshot } = capturePage()
    const target = targetSnapshot()
    target.renderers[0].family = 'webgpu'
    const report = toAnimationRumV2TargetReport(
        snapshot,
        target,
        projectionOptions(runtime, {
            eventId: 'event_target_gpu_mismatch',
            captureId: 'capture_target_gpu_mismatch',
            targetKey: 'hero-canvas',
        })
    )

    assert.deepEqual([metric(report, 'renderer.gpu-frame.p95').value, metric(report, 'renderer.gpu-frame.p95').status], [null, 'unknown'])
    assert.equal(report.capabilities['gpu-timer-query'], 'unknown')
    assert.ok(report.captureQuality.reasons.includes('source-field-incomplete'))
})

test('target builder rejects host-only GPU sources and invalid renderer families from runtime snapshots', () => {
    const cases = [
        { family: 'webgl', source: 'webgl-disjoint-timer-query' },
        { family: 'webgl', source: 'host-timer-query' },
        { family: 'private-renderer', source: 'host-summary' },
    ]

    for (const [index, value] of cases.entries()) {
        const { runtime, snapshot } = capturePage()
        const target = targetSnapshot()
        target.renderers[0].family = value.family
        target.renderers[0].evidence.gpu.source = value.source
        target.renderers[0].evidence.gpu.rejectionReason = null
        const report = toAnimationRumV2TargetReport(
            snapshot,
            target,
            projectionOptions(runtime, {
                eventId: `event_target_gpu_closed_${index}`,
                captureId: `capture_target_gpu_closed_${index}`,
                targetKey: 'hero-canvas',
            })
        )

        assert.deepEqual(
            [metric(report, 'renderer.gpu-frame.p95').value, metric(report, 'renderer.gpu-frame.p95').status],
            [null, 'unknown']
        )
        assert.equal(report.capabilities['gpu-timer-query'], 'unknown')
        assert.ok(report.captureQuality.reasons.includes('source-field-incomplete'))
    }
})

test('page builder reports rejected renderer evidence as unknown GPU instrumentation', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime, explicitRefreshHz: 60 }).start()
    assert.equal(
        collector.recordRenderStats({
            source: 'three-renderer-info',
            backend: 'webgpu',
            timestampMs: 0,
            gpu: {
                status: 'measured',
                timeMs: 2.5,
                source: 'webgl-disjoint-timer-query',
                valid: true,
                disjoint: false,
                contextLost: false,
            },
        }),
        false
    )
    const report = toAnimationRumV2PageReport(collector.stop(), projectionOptions(runtime))

    assert.deepEqual(
        [
            metric(report, 'renderer.gpu-frame.p95').value,
            metric(report, 'renderer.gpu-frame.p95').samples,
            metric(report, 'renderer.gpu-frame.p95').status,
        ],
        [null, null, 'unknown']
    )
    assert.equal(report.capabilities['gpu-timer-query'], 'unknown')
    assert.equal(report.providerEvidence['renderer-adapter'].renderer.rejected, 1)
    assert.ok(report.captureQuality.reasons.includes('provider-rejected-samples'))
})

test('host adapter rings preserve exact retained evidence and truthful truncation', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime, explicitRefreshHz: 60, maxHostEvidenceSamples: 2 }).start()
    for (let index = 1; index <= 3; index += 1) {
        runtime.time = index
        assert.equal(
            collector.recordRenderStats({
                source: 'three-renderer-info',
                backend: 'webgl2',
                timestampMs: index,
                drawCalls: index * 10,
                gpu: { status: 'not-provided' },
            }),
            true
        )
        assert.equal(
            collector.recordMediaStats({
                source: 'video-rvfc',
                timestampMs: index,
                callbackIntervalMs: 16,
                playbackQuality: {
                    status: 'measured',
                    totalVideoFramesDelta: 10,
                    droppedVideoFramesDelta: index === 3 ? 1 : 0,
                },
            }),
            true
        )
    }
    const snapshot = collector.stop()
    const report = toAnimationRumV2PageReport(snapshot, projectionOptions(runtime))

    assert.equal(snapshot.hostEvidence.renderer.evidenceSampleCount, 3)
    assert.equal(snapshot.hostEvidence.renderer.retainedEvidenceSampleCount, 2)
    assert.deepEqual(report.providerEvidence['renderer-adapter'].renderer, {
        version: report.monitorVersion,
        accepted: 3,
        retained: 2,
        evidence: 2,
        dropped: 1,
        rejected: 0,
        truncated: true,
    })
    assert.deepEqual(report.providerEvidence['media-adapter'].resourcesMedia, {
        version: report.monitorVersion,
        accepted: 3,
        retained: 2,
        evidence: 2,
        dropped: 1,
        rejected: 0,
        truncated: true,
    })
    assert.deepEqual([metric(report, 'renderer.draw-calls.p95').value, metric(report, 'renderer.draw-calls.p95').status], [29.5, 'partial'])
    assert.deepEqual(
        [metric(report, 'renderer.triangles.p95').value, metric(report, 'renderer.triangles.p95').status],
        [null, 'not-observed']
    )
    assert.deepEqual(
        [metric(report, 'media.video-dropped-frame-rate.ratio').value, metric(report, 'media.video-dropped-frame-rate.ratio').status],
        [0.05, 'partial']
    )
    assert.ok(report.captureQuality.reasons.includes('provider-truncated'))
})

test('RUM v2 preserves unsupported-only video playback quality without serializing media identity', () => {
    const { runtime, snapshot } = captureMediaPage([{ status: 'unsupported' }])
    assert.deepEqual(
        [
            snapshot.hostEvidence.media.playbackQualityMeasuredSampleCount,
            snapshot.hostEvidence.media.playbackQualityUnsupportedSampleCount,
            snapshot.hostEvidence.media.playbackQualityErrorSampleCount,
        ],
        [0, 1, 0]
    )
    snapshot.hostEvidence.media.videoUrl = 'https://private.example/video/customer-42.mp4?token=secret'
    snapshot.hostEvidence.media.selector = '#private-video'
    snapshot.hostEvidence.media.currentTime = 42

    const report = toAnimationRumV2PageReport(snapshot, projectionOptions(runtime))
    const validation = validateNormalizedAnimationRumV2(report, { nowEpochMs: runtime.wallNow() })

    assert.equal(validation.ok, true, validation.ok ? '' : validation.errors.join(', '))
    assert.equal(report.capabilities['video-playback-quality'], 'unsupported')
    assert.deepEqual(
        [
            metric(report, 'media.video-dropped-frame-rate.ratio').value,
            metric(report, 'media.video-dropped-frame-rate.ratio').samples,
            metric(report, 'media.video-dropped-frame-rate.ratio').status,
        ],
        [null, null, 'unsupported']
    )
    assert.equal(report.captureQuality.reasons.includes('source-field-incomplete'), false)
    assert.doesNotMatch(JSON.stringify(report), /private\.example|customer-42|token=secret|private-video|videoUrl|currentTime/)
})

test('RUM v2 keeps playback-quality read errors unknown instead of disabled or zero', () => {
    const { runtime, snapshot } = captureMediaPage([{ status: 'error' }])
    const report = toAnimationRumV2PageReport(snapshot, projectionOptions(runtime))
    const validation = validateNormalizedAnimationRumV2(report, { nowEpochMs: runtime.wallNow() })

    assert.equal(validation.ok, true, validation.ok ? '' : validation.errors.join(', '))
    assert.deepEqual(
        [
            snapshot.hostEvidence.media.playbackQualityMeasuredSampleCount,
            snapshot.hostEvidence.media.playbackQualityUnsupportedSampleCount,
            snapshot.hostEvidence.media.playbackQualityErrorSampleCount,
        ],
        [0, 0, 1]
    )
    assert.equal(report.capabilities['video-playback-quality'], 'unknown')
    assert.deepEqual(
        [metric(report, 'media.video-dropped-frame-rate.ratio').value, metric(report, 'media.video-dropped-frame-rate.ratio').status],
        [null, 'unknown']
    )
    assert.equal(report.captureQuality.reasons.includes('source-field-incomplete'), false)
})

test('RUM v2 treats a measured zero playback denominator as supported but not observed', () => {
    const { runtime, snapshot } = captureMediaPage([
        { status: 'measured', totalVideoFramesDelta: 0, droppedVideoFramesDelta: 0 },
    ])
    const report = toAnimationRumV2PageReport(snapshot, projectionOptions(runtime))
    const validation = validateNormalizedAnimationRumV2(report, { nowEpochMs: runtime.wallNow() })

    assert.equal(validation.ok, true, validation.ok ? '' : validation.errors.join(', '))
    assert.equal(snapshot.hostEvidence.media.totalVideoFramesDelta, 0)
    assert.equal(snapshot.hostEvidence.media.droppedVideoFramesDelta, 0)
    assert.equal(snapshot.hostEvidence.media.playbackDropRatio, null)
    assert.equal(report.capabilities['video-playback-quality'], 'supported')
    assert.deepEqual(
        [
            metric(report, 'media.video-dropped-frame-rate.ratio').value,
            metric(report, 'media.video-dropped-frame-rate.ratio').samples,
            metric(report, 'media.video-dropped-frame-rate.ratio').status,
        ],
        [null, null, 'not-observed']
    )
    assert.equal(report.captureQuality.reasons.includes('source-field-incomplete'), false)
})

test('RUM v2 keeps mixed retained playback evidence and ring truncation partial', () => {
    const { runtime, snapshot } = captureMediaPage(
        [
            { status: 'unsupported' },
            { status: 'measured', totalVideoFramesDelta: 10, droppedVideoFramesDelta: 1 },
            { status: 'error' },
        ],
        2
    )
    const report = toAnimationRumV2PageReport(snapshot, projectionOptions(runtime))
    const validation = validateNormalizedAnimationRumV2(report, { nowEpochMs: runtime.wallNow() })

    assert.equal(validation.ok, true, validation.ok ? '' : validation.errors.join(', '))
    assert.deepEqual(
        [
            snapshot.hostEvidence.media.acceptedSampleCount,
            snapshot.hostEvidence.media.retainedSampleCount,
            snapshot.hostEvidence.media.droppedSampleCount,
            snapshot.hostEvidence.media.playbackQualityMeasuredSampleCount,
            snapshot.hostEvidence.media.playbackQualityUnsupportedSampleCount,
            snapshot.hostEvidence.media.playbackQualityErrorSampleCount,
        ],
        [3, 2, 1, 1, 0, 1]
    )
    assert.equal(report.capabilities['video-playback-quality'], 'supported')
    assert.deepEqual(
        [metric(report, 'media.video-dropped-frame-rate.ratio').value, metric(report, 'media.video-dropped-frame-rate.ratio').status],
        [0.1, 'partial']
    )
    assert.deepEqual(report.providerEvidence['media-adapter'].resourcesMedia, {
        version: report.monitorVersion,
        accepted: 3,
        retained: 2,
        evidence: 2,
        dropped: 1,
        rejected: 0,
        truncated: true,
    })
    assert.ok(report.captureQuality.reasons.includes('provider-truncated'))
    assert.equal(report.captureQuality.reasons.includes('source-field-incomplete'), false)
})

test('RUM v2 measures the supported subset of mixed playback evidence without degrading unrelated families', () => {
    const { runtime, snapshot } = captureMediaPage([
        { status: 'unsupported' },
        { status: 'measured', totalVideoFramesDelta: 10, droppedVideoFramesDelta: 1 },
        { status: 'error' },
    ])
    const report = toAnimationRumV2PageReport(snapshot, projectionOptions(runtime))
    const validation = validateNormalizedAnimationRumV2(report, { nowEpochMs: runtime.wallNow() })

    assert.equal(validation.ok, true, validation.ok ? '' : validation.errors.join(', '))
    assert.equal(report.capabilities['video-playback-quality'], 'supported')
    assert.deepEqual(
        [metric(report, 'media.video-dropped-frame-rate.ratio').value, metric(report, 'media.video-dropped-frame-rate.ratio').status],
        [0.1, 'measured']
    )
    assert.equal(report.captureQuality.reasons.includes('source-field-incomplete'), false)
})

test('RUM v2 positive playback denominator remains measured with or without optional status counts', () => {
    const { runtime, snapshot } = captureMediaPage([
        { status: 'measured', totalVideoFramesDelta: 20, droppedVideoFramesDelta: 2 },
    ])
    const currentReport = toAnimationRumV2PageReport(snapshot, projectionOptions(runtime))
    const currentValidation = validateNormalizedAnimationRumV2(currentReport, { nowEpochMs: runtime.wallNow() })

    assert.equal(currentValidation.ok, true, currentValidation.ok ? '' : currentValidation.errors.join(', '))
    assert.equal(currentReport.capabilities['video-playback-quality'], 'supported')
    assert.deepEqual(
        [
            metric(currentReport, 'media.video-dropped-frame-rate.ratio').value,
            metric(currentReport, 'media.video-dropped-frame-rate.ratio').samples,
            metric(currentReport, 'media.video-dropped-frame-rate.ratio').status,
        ],
        [0.1, 1, 'measured']
    )

    delete snapshot.hostEvidence.media.playbackQualityUnsupportedSampleCount
    delete snapshot.hostEvidence.media.playbackQualityErrorSampleCount
    const legacyReport = toAnimationRumV2PageReport(
        snapshot,
        projectionOptions(runtime, { eventId: 'event_page_legacy_1234' })
    )
    const legacyValidation = validateNormalizedAnimationRumV2(legacyReport, { nowEpochMs: runtime.wallNow() })

    assert.equal(legacyValidation.ok, true, legacyValidation.ok ? '' : legacyValidation.errors.join(', '))
    assert.equal(legacyReport.capabilities['video-playback-quality'], 'supported')
    assert.deepEqual(
        [
            metric(legacyReport, 'media.video-dropped-frame-rate.ratio').value,
            metric(legacyReport, 'media.video-dropped-frame-rate.ratio').samples,
            metric(legacyReport, 'media.video-dropped-frame-rate.ratio').status,
        ],
        [0.1, 1, 'measured']
    )
})

test('RUM v2 fails closed when only half of the optional playback status breakdown is present', () => {
    const { runtime, snapshot } = captureMediaPage([
        { status: 'measured', totalVideoFramesDelta: 20, droppedVideoFramesDelta: 2 },
    ])
    delete snapshot.hostEvidence.media.playbackQualityErrorSampleCount

    const report = toAnimationRumV2PageReport(snapshot, projectionOptions(runtime))
    const validation = validateNormalizedAnimationRumV2(report, { nowEpochMs: runtime.wallNow() })

    assert.equal(validation.ok, true, validation.ok ? '' : validation.errors.join(', '))
    assert.equal(report.capabilities['video-playback-quality'], 'unknown')
    assert.deepEqual(
        [metric(report, 'media.video-dropped-frame-rate.ratio').value, metric(report, 'media.video-dropped-frame-rate.ratio').status],
        [null, 'unknown']
    )
    assert.ok(report.captureQuality.reasons.includes('source-field-incomplete'))
})

test('rejected-only interaction quality stays partial without fabricating ring loss', () => {
    const { runtime, snapshot } = capturePage()
    const quality = qualitySummary()
    quality.status = 'partial'
    quality.rejectedSampleCount = 1
    const report = toAnimationRumV2PageReport(snapshot, projectionOptions(runtime, { interactionQuality: quality }))
    const provider = report.providerEvidence['target-sidecar'].scrollGesture

    assert.deepEqual(
        {
            accepted: provider.accepted,
            retained: provider.retained,
            dropped: provider.dropped,
            rejected: provider.rejected,
            truncated: provider.truncated,
        },
        { accepted: 4, retained: 4, dropped: 0, rejected: 1, truncated: false }
    )
    assert.equal(metric(report, 'interaction.input-to-visual.p95').status, 'partial')
    assert.ok(report.captureQuality.reasons.includes('provider-rejected-samples'))
    assert.equal(report.captureQuality.reasons.includes('provider-truncated'), false)
})

test('rejected-only LoAF diagnostics preserve zero accepted and never claim a measured zero', () => {
    const { runtime, snapshot } = capturePage()
    const baseline = toAnimationRumV2PageReport(snapshot, projectionOptions(runtime))
    const rejectedOnly = {
        capability: 'supported',
        count: 0,
        p95Ms: null,
        accepted: 0,
        rejected: 1,
        retained: 0,
        dropped: 0,
        truncated: false,
        status: 'partial',
    }
    const report = toAnimationRumV2PageReport(
        snapshot,
        projectionOptions(runtime, {
            loafDiagnostics: {
                loafFirstUiEventToFrameEnd: rejectedOnly,
                loafAttributedForcedStyleLayout: rejectedOnly,
            },
        })
    )
    const provider = report.providerEvidence['browser-core'].userOutcome
    const baselineProvider = baseline.providerEvidence['browser-core'].userOutcome

    assert.equal(provider.accepted, baselineProvider.accepted)
    assert.equal(provider.retained, baselineProvider.retained)
    assert.equal(provider.evidence, baselineProvider.evidence)
    assert.equal(provider.dropped, baselineProvider.dropped)
    assert.equal(provider.rejected, baselineProvider.rejected + 1)
    assert.deepEqual(
        [metric(report, 'outcome.loaf-first-ui-to-end.count').value, metric(report, 'outcome.loaf-first-ui-to-end.count').status],
        [null, 'unknown']
    )
    assert.ok(report.captureQuality.reasons.includes('provider-rejected-samples'))
    assert.equal(report.captureQuality.reasons.includes('provider-truncated'), false)
})

test('target zero overlap reports matching measured count and sum zeros', () => {
    const { runtime, snapshot } = capturePage()
    const target = targetSnapshot()
    target.correlated.longTasks = {
        status: 'not-observed',
        overlapCount: 0,
        overlapDurationMs: 0,
        duration: null,
    }
    const report = toAnimationRumV2TargetReport(
        snapshot,
        target,
        projectionOptions(runtime, {
            eventId: 'event_target_zero_1234',
            captureId: 'capture_target_zero_1234',
            targetKey: 'hero-canvas',
        })
    )

    assert.deepEqual([metric(report, 'main.long-task.count').value, metric(report, 'main.long-task.count').status], [0, 'measured'])
    assert.deepEqual(
        [metric(report, 'main.long-task-duration.sum').value, metric(report, 'main.long-task-duration.sum').status],
        [0, 'measured']
    )
    assert.deepEqual(
        [metric(report, 'main.long-task-duration.p95').value, metric(report, 'main.long-task-duration.p95').status],
        [null, 'not-observed']
    )
})

test('target temporal reports use the correlated interaction duration and reject a mismatched relation', () => {
    const { runtime, snapshot } = capturePage()
    const target = targetSnapshot()
    target.elapsedMs = 600_000
    target.capturedAt = 600_000
    target.correlatedDurationMs = 1_200
    const report = toAnimationRumV2TargetReport(
        snapshot,
        target,
        projectionOptions(runtime, {
            eventId: 'event_target_window_12',
            captureId: 'capture_target_window_12',
            targetKey: 'hero-canvas',
        })
    )
    assert.equal(report.context.windowDurationMs, 1_200)
    assert.equal(report.context.windowDurationCapped, false)
    assert.ok(report.captureQuality.reasons.includes('visible-window-too-short'))

    target.correlationRelation = null
    const malformed = toAnimationRumV2TargetReport(
        snapshot,
        target,
        projectionOptions(runtime, {
            eventId: 'event_target_relation_1',
            captureId: 'capture_target_relation_1',
            targetKey: 'hero-canvas',
        })
    )
    assert.equal(metric(malformed, 'frame.duration.p95').value, null)
    assert.equal(metric(malformed, 'frame.duration.p95').status, 'not-observed')
    assert.ok(malformed.captureQuality.reasons.includes('source-field-incomplete'))
})

test('lossy optional sources stay partial without inventing measurements or corrupting provider counts', () => {
    const { runtime, snapshot } = capturePage()
    snapshot.inputFrameScheduling = {
        version: 1,
        status: 'not-observed',
        retainedCount: 0,
        totalObservedCount: 0,
        droppedSampleCount: 1,
        cancelledSampleCount: 2,
        pendingCount: 0,
        capacity: 8,
        duration: null,
        byKind: { pointer: 0, keyboard: 0, click: 0 },
    }
    const evidence = pageEvidence()
    evidence.documentScopes.truncated = true
    evidence.animations.status = 'partial'
    const report = toAnimationRumV2PageReport(snapshot, projectionOptions(runtime, { pageEvidence: evidence }))

    const validation = validateNormalizedAnimationRumV2(report, { nowEpochMs: runtime.wallNow() })
    assert.equal(validation.ok, true, validation.ok ? '' : validation.errors.join(', '))
    assert.deepEqual(
        [metric(report, 'main.input-capture-to-next-raf.count').value, metric(report, 'main.input-capture-to-next-raf.count').status],
        [null, 'not-observed']
    )
    assert.equal(report.providerEvidence['input-scheduling'].mainThread.accepted, 0)
    assert.equal(report.providerEvidence['input-scheduling'].mainThread.retained, 0)
    assert.equal(report.providerEvidence['input-scheduling'].mainThread.dropped, 0)
    assert.equal(report.providerEvidence['input-scheduling'].mainThread.truncated, false)
    assert.equal(report.providerEvidence['input-scheduling'].mainThread.rejected, 3)
    assert.equal(metric(report, 'animation.running.count').status, 'partial')
    assert.equal(metric(report, 'surface.canvas.count').status, 'partial')
    assert.equal(metric(report, 'media.video-element.count').status, 'partial')
    assert.equal(report.captureQuality.reasons.includes('provider-truncated'), false)
    assert.ok(report.captureQuality.reasons.includes('provider-rejected-samples'))
    assert.ok(report.captureQuality.reasons.includes('source-field-incomplete'))
})

test('an installed target renderer adapter with no observation remains supported but does not manufacture zeroes', () => {
    const { runtime, snapshot } = capturePage()
    const target = targetSnapshot()
    target.adapterErrors = []
    target.renderers = target.renderers.map(renderer => ({
        ...renderer,
        capability: { state: 'supported', observed: false, buffered: false },
        metrics: {
            ...renderer.metrics,
            gpuFrameMsP95: null,
            drawCallsP95: null,
            trianglesP95: null,
        },
    }))
    const report = toAnimationRumV2TargetReport(
        snapshot,
        target,
        projectionOptions(runtime, {
            eventId: 'event_target_unseen_1234',
            captureId: 'capture_target_unseen_1234',
            targetKey: 'hero-canvas',
        })
    )

    assert.equal(validateNormalizedAnimationRumV2(report, { nowEpochMs: runtime.wallNow() }).ok, true)
    assert.equal(report.capabilities['renderer-adapter'], 'supported')
    assert.deepEqual([metric(report, 'renderer.gpu-frame.p95').value, metric(report, 'renderer.gpu-frame.p95').status], [null, 'unknown'])
    for (const id of ['renderer.draw-calls.p95', 'renderer.triangles.p95']) {
        assert.deepEqual([metric(report, id).value, metric(report, id).samples, metric(report, id).status], [null, null, 'not-observed'])
    }
})
