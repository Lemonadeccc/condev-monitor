import { BrowserAnimationLocalEvidenceRegistry } from './animation-local-evidence'

function mediaSnapshot() {
    return {
        status: 'active' as const,
        capacity: 1,
        maximumActiveAttempts: 1,
        begunAttemptCount: 1,
        retainedAttemptCount: 1,
        droppedAttemptCount: 0,
        activeAttemptCount: 0,
        completedAttemptCount: 1,
        cancelledAttemptCount: 0,
        truncated: false,
        attempts: [
            {
                attemptId: 41,
                kind: 'video',
                outcome: 'completed',
                startedAt: 100,
                endedAt: 140,
                durationMs: 40,
                decodeReady: {
                    stage: 'decode-ready',
                    timestampMs: 110,
                    elapsedMs: 10,
                    durationMs: 6,
                    byteCount: 4_096,
                    itemCount: 1,
                },
                uploadReady: {
                    stage: 'upload-ready',
                    timestampMs: 120,
                    elapsedMs: 20,
                    durationMs: 4,
                    byteCount: 4_096,
                    itemCount: 1,
                },
                firstVisible: {
                    stage: 'first-visible',
                    timestampMs: 132,
                    elapsedMs: 32,
                    durationMs: null,
                    byteCount: null,
                    itemCount: 1,
                },
            },
        ],
    }
}

function checkpoint(boundary: 'before-interaction' | 'after-interaction') {
    return {
        boundary,
        capturedAt: boundary === 'before-interaction' ? 200 : 225,
        status: 'measured',
        configuredSourceCount: 1,
        measuredSourceCount: 1,
        unobservedSourceCount: 0,
        errorSourceCount: 0,
        sourceStatus: {
            'gsap-ticker': 'measured',
            'lenis-scroll': 'not-configured',
            'scroll-trigger': 'not-configured',
        },
    }
}

function motionSnapshot() {
    return {
        status: 'active' as const,
        capacity: 1,
        maximumActiveInteractions: 1,
        begunInteractionCount: 1,
        retainedInteractionCount: 1,
        droppedInteractionCount: 0,
        activeInteractionCount: 0,
        completedInteractionCount: 1,
        cancelledInteractionCount: 0,
        abandonedInteractionCount: 0,
        sourceReadErrorCount: 0,
        cleanupFailed: false,
        cleanupFailureCount: 0,
        truncated: false,
        interactions: [
            {
                id: 'private-interaction-id',
                label: 'private-motion-label',
                kind: 'pointer',
                outcome: 'completed',
                startedAt: 200,
                endedAt: 225,
                durationMs: 25,
                before: checkpoint('before-interaction'),
                after: checkpoint('after-interaction'),
            },
        ],
    }
}

function browserVideoPresentationSnapshot() {
    return {
        schemaVersion: 1 as const,
        evidenceKind: 'browser-video-presentation-callback' as const,
        proves: 'browser-callback-and-metadata' as const,
        state: 'active' as const,
        startedAt: 90,
        firstCallbackAt: 100,
        startToFirstCallbackMs: 10,
        acceptedRecordCount: 1,
        retainedRecordCount: 1,
        droppedRecordCount: 0,
        rejectedRecordCount: 0,
        truncated: false,
        window: { startedAt: 100, endedAt: 100 },
        records: [
            {
                callbackAt: 100,
                callbackIntervalMs: null,
                mediaTimeDeltaMs: null,
                presentedFramesDelta: null,
                expectedDisplayDeltaMs: 4,
                processingDurationMs: 2,
                src: 'https://private.example/video.mp4',
            },
        ],
        gpuUploadMs: 7,
    }
}

describe('BrowserAnimationLocalEvidenceRegistry', () => {
    it('projects media, motion, and browser video callback evidence into a closed local-only snapshot', () => {
        const registry = new BrowserAnimationLocalEvidenceRegistry()
        const media = registry.registerMedia({ snapshot: mediaSnapshot })
        const motion = registry.registerMotion({ snapshot: motionSnapshot })
        const video = registry.registerBrowserVideoPresentation({ snapshotPresentation: browserVideoPresentationSnapshot })

        const snapshot = registry.snapshot()

        expect(snapshot).toMatchObject({
            version: 1,
            providerCount: 3,
            rejectedProviderCount: 0,
            droppedProviderCount: 0,
            media: { providerCount: 1, retainedRecordCount: 1 },
            motion: { providerCount: 1, retainedRecordCount: 1 },
            browserVideoPresentation: {
                providerCount: 1,
                retainedRecordCount: 1,
                records: [{ callbackAt: 100, expectedDisplayDeltaMs: 4, processingDurationMs: 2 }],
            },
        })
        expect(JSON.stringify(snapshot)).not.toContain('private-interaction-id')
        expect(JSON.stringify(snapshot)).not.toContain('private-motion-label')
        expect(JSON.stringify(snapshot)).not.toContain('private.example')
        expect(JSON.stringify(snapshot)).not.toContain('gpuUploadMs')

        media.unregister()
        motion.unregister()
        video.unregister()
        expect(registry.snapshot()).toMatchObject({ providerCount: 0 })
        expect(media.active).toBe(false)
        expect(motion.active).toBe(false)
        expect(video.active).toBe(false)
    })

    it('fails hostile providers closed and reports provider capacity loss', () => {
        const registry = new BrowserAnimationLocalEvidenceRegistry()
        registry.registerMedia({
            snapshot: () => {
                throw new Error('hostile provider')
            },
        })
        for (let index = 0; index < 16; index += 1) registry.registerMedia({ snapshot: mediaSnapshot })

        expect(registry.snapshot()).toMatchObject({
            providerCount: 15,
            rejectedProviderCount: 1,
            droppedProviderCount: 1,
            truncated: true,
        })
    })

    it('keeps media and motion capacity available after sixteen automatic video providers', () => {
        const registry = new BrowserAnimationLocalEvidenceRegistry()
        const videos = Array.from({ length: 16 }, () =>
            registry.registerBrowserVideoPresentation({ snapshotPresentation: browserVideoPresentationSnapshot })
        )
        const overflowVideo = registry.registerBrowserVideoPresentation({ snapshotPresentation: browserVideoPresentationSnapshot })
        const media = registry.registerMedia({ snapshot: mediaSnapshot })
        const motion = registry.registerMotion({ snapshot: motionSnapshot })

        expect(overflowVideo.active).toBe(false)
        expect(media.active).toBe(true)
        expect(motion.active).toBe(true)
        expect(registry.snapshot()).toMatchObject({
            providerCount: 18,
            rejectedProviderCount: 0,
            droppedProviderCount: 1,
            media: { providerCount: 1, retainedRecordCount: 1 },
            motion: { providerCount: 1, retainedRecordCount: 1 },
            browserVideoPresentation: { providerCount: 16, retainedRecordCount: 16 },
        })

        for (const video of videos) video.unregister()
        media.unregister()
        motion.unregister()
    })

    it('clears every retained provider without touching the recorder', () => {
        const registry = new BrowserAnimationLocalEvidenceRegistry()
        const recorder = { snapshot: jest.fn(mediaSnapshot) }
        const registration = registry.registerMedia(recorder)

        registry.clear()

        expect(registry.snapshot()).toMatchObject({ providerCount: 0 })
        expect(recorder.snapshot).not.toHaveBeenCalled()
        expect(registration.active).toBe(false)
        registration.unregister()
        expect(registration.active).toBe(false)
    })
})
