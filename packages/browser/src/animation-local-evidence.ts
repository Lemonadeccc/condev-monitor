import {
    projectAnimationLocalEvidenceSnapshot,
    type AnimationLocalEvidenceSnapshot,
    type MediaSemanticStageRecorder,
    type MotionSemanticCheckpointRecorder,
} from '@condev-monitor/monitor-sdk-animation'

const MAX_LOCAL_EVIDENCE_PROVIDERS = 16
const MAX_COUNT = 1_000_000_000

type LocalEvidenceProviderKind = 'media' | 'motion'

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
    private droppedProviderCount = 0

    registerMedia(recorder: Pick<MediaSemanticStageRecorder, 'snapshot'>): BrowserAnimationLocalEvidenceRegistration {
        return this.register('media', () => recorder.snapshot())
    }

    registerMotion(recorder: Pick<MotionSemanticCheckpointRecorder, 'snapshot'>): BrowserAnimationLocalEvidenceRegistration {
        return this.register('motion', () => recorder.snapshot())
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
    }

    private register(kind: LocalEvidenceProviderKind, snapshot: () => unknown): BrowserAnimationLocalEvidenceRegistration {
        if (this.providers.size >= MAX_LOCAL_EVIDENCE_PROVIDERS) {
            this.droppedProviderCount = Math.min(MAX_COUNT, this.droppedProviderCount + 1)
            return Object.freeze({
                active: false,
                unregister() {},
            })
        }
        const token = Symbol(kind)
        this.providers.set(token, { kind, snapshot })
        const providers = this.providers
        return {
            get active(): boolean {
                return providers.has(token)
            },
            unregister: (): void => {
                providers.delete(token)
            },
        }
    }
}
