import {
    projectAnimationLocalEvidenceSnapshot,
    type AnimationLocalEvidenceSnapshot,
    type MediaSemanticStageRecorder,
    type MotionSemanticCheckpointRecorder,
    type VideoFrameProbe,
} from '@condev-monitor/monitor-sdk-animation'

const MAX_LOCAL_EVIDENCE_PROVIDERS_PER_FAMILY = 16
const MAX_COUNT = 1_000_000_000

type LocalEvidenceProviderKind = 'media' | 'motion' | 'browser-video-presentation'

interface LocalEvidenceProvider {
    readonly kind: LocalEvidenceProviderKind
    readonly snapshot: () => unknown
}

export interface BrowserAnimationLocalEvidenceRegistration {
    readonly active: boolean
    unregister(): void
}

/**
 * Browser-owned, local-only sidecar for the development overlay.
 *
 * The registry never mutates AnimationSnapshot and only returns the closed
 * projection owned by the animation package, so these records cannot enter
 * either animation RUM contract through the normal snapshot boundary.
 */
export class BrowserAnimationLocalEvidenceRegistry {
    private readonly providers = new Map<symbol, LocalEvidenceProvider>()
    private readonly providerCounts = new Map<LocalEvidenceProviderKind, number>()
    private droppedProviderCount = 0

    registerMedia(recorder: Pick<MediaSemanticStageRecorder, 'snapshot'>): BrowserAnimationLocalEvidenceRegistration {
        return this.register('media', () => recorder.snapshot())
    }

    registerMotion(recorder: Pick<MotionSemanticCheckpointRecorder, 'snapshot'>): BrowserAnimationLocalEvidenceRegistration {
        return this.register('motion', () => recorder.snapshot())
    }

    registerBrowserVideoPresentation(probe: Pick<VideoFrameProbe, 'snapshotPresentation'>): BrowserAnimationLocalEvidenceRegistration {
        return this.register('browser-video-presentation', () => probe.snapshotPresentation())
    }

    snapshot(): AnimationLocalEvidenceSnapshot {
        const providers = [...this.providers.values()].map(provider => {
            try {
                return { kind: provider.kind, snapshot: provider.snapshot() } as const
            } catch {
                return { kind: provider.kind, snapshot: null } as const
            }
        })
        return (
            projectAnimationLocalEvidenceSnapshot({
                version: 1,
                providers,
                droppedProviderCount: this.droppedProviderCount,
            }) ?? projectAnimationLocalEvidenceSnapshot({ version: 1, providers: [] })!
        )
    }

    clear(): void {
        this.providers.clear()
        this.providerCounts.clear()
    }

    private register(kind: LocalEvidenceProviderKind, snapshot: () => unknown): BrowserAnimationLocalEvidenceRegistration {
        const familyCount = this.providerCounts.get(kind) ?? 0
        if (familyCount >= MAX_LOCAL_EVIDENCE_PROVIDERS_PER_FAMILY) {
            this.droppedProviderCount = Math.min(MAX_COUNT, this.droppedProviderCount + 1)
            return Object.freeze({
                active: false,
                unregister() {},
            })
        }
        const token = Symbol(kind)
        this.providers.set(token, { kind, snapshot })
        this.providerCounts.set(kind, familyCount + 1)
        const providers = this.providers
        const providerCounts = this.providerCounts
        return {
            get active(): boolean {
                return providers.has(token)
            },
            unregister: (): void => {
                if (!providers.delete(token)) return
                const remaining = Math.max(0, (providerCounts.get(kind) ?? 1) - 1)
                if (remaining === 0) providerCounts.delete(kind)
                else providerCounts.set(kind, remaining)
            },
        }
    }
}
