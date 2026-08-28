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

describe('BrowserAnimationLocalEvidenceRegistry', () => {
    it('projects media and motion recorders into a closed local-only snapshot', () => {
        const registry = new BrowserAnimationLocalEvidenceRegistry()
        const media = registry.registerMedia({ snapshot: mediaSnapshot })
        const motion = registry.registerMotion({ snapshot: motionSnapshot })

        const snapshot = registry.snapshot()

        expect(snapshot).toMatchObject({
            version: 1,
            providerCount: 2,
            rejectedProviderCount: 0,
            droppedProviderCount: 0,
            media: { providerCount: 1, retainedRecordCount: 1 },
            motion: { providerCount: 1, retainedRecordCount: 1 },
        })
        expect(JSON.stringify(snapshot)).not.toContain('private-interaction-id')
        expect(JSON.stringify(snapshot)).not.toContain('private-motion-label')

        media.unregister()
        motion.unregister()
        expect(registry.snapshot()).toMatchObject({ providerCount: 0 })
        expect(media.active).toBe(false)
        expect(motion.active).toBe(false)
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
