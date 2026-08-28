import type { CapabilityState } from './types'

// cspell:ignore rvfc

export const ANIMATION_OVERLAY_PAGE_EVIDENCE_VERSION = 1 as const

const MAX_COUNT = 1_000_000_000
const PAGE_EVIDENCE_STATUSES = new Set<AnimationOverlayPageEvidenceStatus>([
    'measured',
    'partial',
    'not-observed',
    'not-applicable',
    'unsupported',
    'unknown',
])
const CAPABILITY_STATES = new Set<CapabilityState>(['supported', 'unsupported', 'unknown'])
const VISIBILITY_STATES = new Set<AnimationOverlayPageVisibilityState>(['visible', 'hidden', 'prerender', 'unknown'])

export type AnimationOverlayPageEvidenceStatus = 'measured' | 'partial' | 'not-observed' | 'not-applicable' | 'unsupported' | 'unknown'

export type AnimationOverlayPageVisibilityState = 'visible' | 'hidden' | 'prerender' | 'unknown'

export interface AnimationOverlayPageCapabilityEvidence {
    readonly state: CapabilityState
    readonly observed: boolean
    readonly buffered: boolean
}

export interface AnimationOverlayPageEvidenceSnapshotV1 {
    readonly schemaVersion: typeof ANIMATION_OVERLAY_PAGE_EVIDENCE_VERSION
    readonly scope: 'capture-window-local'
    readonly enabled: boolean
    readonly sampleCount: number
    readonly documentScopes: {
        readonly capability: AnimationOverlayPageCapabilityEvidence
        readonly retainedCount: number
        readonly truncated: boolean
    }
    readonly animations: {
        readonly capability: AnimationOverlayPageCapabilityEvidence
        readonly status: AnimationOverlayPageEvidenceStatus
        readonly sampleCount: number
        readonly current: {
            readonly total: number
            readonly inspected: number
            readonly dropped: number
            readonly running: number
            readonly infinite: number
        }
        readonly peakTotal: number
        readonly peakRunning: number
        readonly lifecycle: {
            readonly animationStartCount: number
            readonly animationEndCount: number
            readonly animationCancelCount: number
            readonly transitionRunCount: number
            readonly transitionEndCount: number
            readonly transitionCancelCount: number
        }
    }
    readonly media: {
        readonly capability: AnimationOverlayPageCapabilityEvidence
        readonly status: AnimationOverlayPageEvidenceStatus
        readonly currentVideoCount: number
        readonly retainedVideoCount: number
        readonly droppedVideoCount: number
        readonly activeProbeCount: number
        readonly rvfcSupportedVideoCount: number
        readonly rvfcUnsupportedVideoCount: number
        readonly playingVideoCount: number
    }
    readonly rendererSurfaces: {
        readonly discoveryCapability: AnimationOverlayPageCapabilityEvidence
        readonly contextObservationCapability: AnimationOverlayPageCapabilityEvidence
        readonly status: AnimationOverlayPageEvidenceStatus
        readonly sampleCount: number
        readonly current: {
            readonly total: number
            readonly retained: number
            readonly dropped: number
            readonly svg: number
            readonly canvasUnknown: number
            readonly canvas2d: number
            readonly webgl: number
            readonly webgl2: number
            readonly webgpu: number
        }
        readonly peakTotal: number
        readonly successfulContextObservationCount: number
        readonly webglContextLostCount: number
        readonly webglContextRestoredCount: number
        readonly rendererWorkCapability: AnimationOverlayPageCapabilityEvidence
        readonly gpuTimingCapability: AnimationOverlayPageCapabilityEvidence
    }
    readonly workAvoidance: {
        readonly visibilityCapability: AnimationOverlayPageCapabilityEvidence
        readonly intersectionCapability: AnimationOverlayPageCapabilityEvidence
        readonly status: AnimationOverlayPageEvidenceStatus
        readonly visibilityState: AnimationOverlayPageVisibilityState
        readonly sampleCount: number
        readonly trackedIntersectionTargetCount: number
        readonly knownIntersectionTargetCount: number
        readonly hiddenRunningAnimationReviewSampleCount: number
        readonly hiddenPlayingVideoReviewSampleCount: number
        readonly offscreenRunningAnimationReviewSampleCount: number
        readonly offscreenPlayingVideoReviewSampleCount: number
        readonly current: {
            readonly hiddenRunningAnimations: number
            readonly hiddenPlayingVideos: number
            readonly offscreenRunningAnimations: number
            readonly offscreenPlayingVideos: number
        }
        readonly workDurationCapability: AnimationOverlayPageCapabilityEvidence
    }
    readonly reducedMotion: {
        readonly capability: AnimationOverlayPageCapabilityEvidence
        readonly status: AnimationOverlayPageEvidenceStatus
        readonly preference: boolean | null
        readonly reducedMotionSampleCount: number
        readonly reviewCandidateSampleCount: number
        readonly current: {
            readonly runningAnimationCandidates: number
            readonly infiniteAnimationCandidates: number
            readonly playingVideoCandidates: number
        }
        readonly violationCapability: AnimationOverlayPageCapabilityEvidence
    }
}

export type AnimationOverlayPageEvidenceSnapshot = AnimationOverlayPageEvidenceSnapshotV1

function record(value: unknown): Record<PropertyKey, unknown> | null {
    return typeof value === 'object' && value !== null ? (value as Record<PropertyKey, unknown>) : null
}

function property(value: Record<PropertyKey, unknown>, key: PropertyKey): unknown {
    return value[key]
}

function count(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT ? value : null
}

function capability(value: unknown): AnimationOverlayPageCapabilityEvidence | null {
    const input = record(value)
    if (!input) return null
    const state = property(input, 'state')
    const observed = property(input, 'observed')
    const buffered = property(input, 'buffered')
    if (
        !CAPABILITY_STATES.has(state as CapabilityState) ||
        typeof observed !== 'boolean' ||
        typeof buffered !== 'boolean' ||
        (state === 'unsupported' && observed)
    ) {
        return null
    }
    return Object.freeze({ state: state as CapabilityState, observed, buffered })
}

function status(value: unknown): AnimationOverlayPageEvidenceStatus | null {
    return PAGE_EVIDENCE_STATUSES.has(value as AnimationOverlayPageEvidenceStatus) ? (value as AnimationOverlayPageEvidenceStatus) : null
}

function statusMatchesCapability(
    evidenceStatus: AnimationOverlayPageEvidenceStatus,
    evidenceCapability: AnimationOverlayPageCapabilityEvidence
): boolean {
    if (evidenceStatus === 'measured' || evidenceStatus === 'partial') return evidenceCapability.state === 'supported'
    if (evidenceStatus === 'unsupported') return evidenceCapability.state === 'unsupported'
    if (evidenceStatus === 'unknown') return evidenceCapability.state === 'unknown'
    return true
}

function countFields<const TKeys extends readonly string[]>(
    value: unknown,
    keys: TKeys
): { readonly [TKey in TKeys[number]]: number } | null {
    const input = record(value)
    if (!input) return null
    const output = {} as { [TKey in TKeys[number]]: number }
    for (const key of keys) {
        const parsed = count(property(input, key))
        if (parsed === null) return null
        output[key as TKeys[number]] = parsed
    }
    return Object.freeze(output)
}

/**
 * Reconstructs the local DevTools page-evidence sidecar from closed aggregate fields.
 * Arbitrary provider strings and detail records are intentionally discarded before rendering.
 */
export function projectAnimationOverlayPageEvidenceSnapshot(value: unknown): AnimationOverlayPageEvidenceSnapshot | null {
    try {
        const input = record(value)
        if (
            !input ||
            property(input, 'schemaVersion') !== ANIMATION_OVERLAY_PAGE_EVIDENCE_VERSION ||
            property(input, 'scope') !== 'capture-window-local' ||
            typeof property(input, 'enabled') !== 'boolean'
        ) {
            return null
        }
        const sampleCount = count(property(input, 'sampleCount'))
        const rawDocumentScopes = record(property(input, 'documentScopes'))
        const rawAnimations = record(property(input, 'animations'))
        const rawMedia = record(property(input, 'media'))
        const rawRenderer = record(property(input, 'rendererSurfaces'))
        const rawWork = record(property(input, 'workAvoidance'))
        const rawReduced = record(property(input, 'reducedMotion'))
        if (sampleCount === null || !rawDocumentScopes || !rawAnimations || !rawMedia || !rawRenderer || !rawWork || !rawReduced) {
            return null
        }

        const documentCapability = capability(property(rawDocumentScopes, 'capability'))
        const documentRetainedCount = count(property(rawDocumentScopes, 'retainedCount'))
        const documentTruncated = property(rawDocumentScopes, 'truncated')
        const animationCapability = capability(property(rawAnimations, 'capability'))
        const animationStatus = status(property(rawAnimations, 'status'))
        const animationSampleCount = count(property(rawAnimations, 'sampleCount'))
        const animationCurrent = countFields(property(rawAnimations, 'current'), [
            'total',
            'inspected',
            'dropped',
            'running',
            'infinite',
        ] as const)
        const animationPeakTotal = count(property(rawAnimations, 'peakTotal'))
        const animationPeakRunning = count(property(rawAnimations, 'peakRunning'))
        const animationLifecycle = countFields(property(rawAnimations, 'lifecycle'), [
            'animationStartCount',
            'animationEndCount',
            'animationCancelCount',
            'transitionRunCount',
            'transitionEndCount',
            'transitionCancelCount',
        ] as const)
        const mediaCapability = capability(property(rawMedia, 'capability'))
        const mediaStatus = status(property(rawMedia, 'status'))
        const mediaCounts = countFields(rawMedia, [
            'currentVideoCount',
            'retainedVideoCount',
            'droppedVideoCount',
            'activeProbeCount',
            'rvfcSupportedVideoCount',
            'rvfcUnsupportedVideoCount',
            'playingVideoCount',
        ] as const)
        const rendererDiscoveryCapability = capability(property(rawRenderer, 'discoveryCapability'))
        const rendererContextCapability = capability(property(rawRenderer, 'contextObservationCapability'))
        const rendererStatus = status(property(rawRenderer, 'status'))
        const rendererSampleCount = count(property(rawRenderer, 'sampleCount'))
        const rendererCurrent = countFields(property(rawRenderer, 'current'), [
            'total',
            'retained',
            'dropped',
            'svg',
            'canvasUnknown',
            'canvas2d',
            'webgl',
            'webgl2',
            'webgpu',
        ] as const)
        const rendererPeakTotal = count(property(rawRenderer, 'peakTotal'))
        const rendererContextCounts = countFields(rawRenderer, [
            'successfulContextObservationCount',
            'webglContextLostCount',
            'webglContextRestoredCount',
        ] as const)
        const rendererWorkCapability = capability(property(rawRenderer, 'rendererWorkCapability'))
        const rendererGpuCapability = capability(property(rawRenderer, 'gpuTimingCapability'))
        const visibilityCapability = capability(property(rawWork, 'visibilityCapability'))
        const intersectionCapability = capability(property(rawWork, 'intersectionCapability'))
        const workStatus = status(property(rawWork, 'status'))
        const visibilityState = property(rawWork, 'visibilityState')
        const workSampleCount = count(property(rawWork, 'sampleCount'))
        const trackedIntersectionTargetCount = count(property(rawWork, 'trackedIntersectionTargetCount'))
        const knownIntersectionTargetCount = count(property(rawWork, 'knownIntersectionTargetCount'))
        const workReviewCounts = countFields(rawWork, [
            'hiddenRunningAnimationReviewSampleCount',
            'hiddenPlayingVideoReviewSampleCount',
            'offscreenRunningAnimationReviewSampleCount',
            'offscreenPlayingVideoReviewSampleCount',
        ] as const)
        const workCurrent = countFields(property(rawWork, 'current'), [
            'hiddenRunningAnimations',
            'hiddenPlayingVideos',
            'offscreenRunningAnimations',
            'offscreenPlayingVideos',
        ] as const)
        const workDurationCapability = capability(property(rawWork, 'workDurationCapability'))
        const reducedCapability = capability(property(rawReduced, 'capability'))
        const reducedStatus = status(property(rawReduced, 'status'))
        const reducedPreference = property(rawReduced, 'preference')
        const reducedSampleCount = count(property(rawReduced, 'reducedMotionSampleCount'))
        const reducedReviewCount = count(property(rawReduced, 'reviewCandidateSampleCount'))
        const reducedCurrent = countFields(property(rawReduced, 'current'), [
            'runningAnimationCandidates',
            'infiniteAnimationCandidates',
            'playingVideoCandidates',
        ] as const)
        const reducedViolationCapability = capability(property(rawReduced, 'violationCapability'))

        if (
            !documentCapability ||
            documentRetainedCount === null ||
            typeof documentTruncated !== 'boolean' ||
            !animationCapability ||
            !animationStatus ||
            animationSampleCount === null ||
            !animationCurrent ||
            animationPeakTotal === null ||
            animationPeakRunning === null ||
            !animationLifecycle ||
            !mediaCapability ||
            !mediaStatus ||
            !mediaCounts ||
            !rendererDiscoveryCapability ||
            !rendererContextCapability ||
            !rendererStatus ||
            rendererSampleCount === null ||
            !rendererCurrent ||
            rendererPeakTotal === null ||
            !rendererContextCounts ||
            !rendererWorkCapability ||
            !rendererGpuCapability ||
            !visibilityCapability ||
            !intersectionCapability ||
            !workStatus ||
            !VISIBILITY_STATES.has(visibilityState as AnimationOverlayPageVisibilityState) ||
            workSampleCount === null ||
            trackedIntersectionTargetCount === null ||
            knownIntersectionTargetCount === null ||
            !workReviewCounts ||
            !workCurrent ||
            !workDurationCapability ||
            !reducedCapability ||
            !reducedStatus ||
            (reducedPreference !== null && typeof reducedPreference !== 'boolean') ||
            reducedSampleCount === null ||
            reducedReviewCount === null ||
            !reducedCurrent ||
            !reducedViolationCapability
        ) {
            return null
        }

        const documentScopeComplete = documentCapability.state === 'supported' && !documentTruncated
        const animationStatusValid =
            animationStatus === 'measured'
                ? animationSampleCount > 0 && animationCurrent.dropped === 0 && documentScopeComplete
                : animationStatus === 'partial'
                  ? animationSampleCount > 0 && (animationCurrent.dropped > 0 || !documentScopeComplete)
                  : true
        const animationRelationsValid =
            animationCurrent.inspected + animationCurrent.dropped === animationCurrent.total &&
            animationCurrent.running <= animationCurrent.inspected &&
            animationCurrent.infinite <= animationCurrent.running &&
            animationPeakTotal >= animationCurrent.total &&
            animationPeakRunning >= animationCurrent.running &&
            animationPeakRunning <= animationPeakTotal &&
            animationSampleCount <= sampleCount &&
            statusMatchesCapability(animationStatus, animationCapability) &&
            animationStatusValid
        const mediaStatusValid =
            mediaStatus === 'measured'
                ? sampleCount > 0 &&
                  mediaCounts.currentVideoCount > 0 &&
                  mediaCounts.droppedVideoCount === 0 &&
                  mediaCounts.rvfcUnsupportedVideoCount === 0 &&
                  documentScopeComplete
                : mediaStatus === 'partial'
                  ? sampleCount > 0 &&
                    (!documentScopeComplete ||
                        (mediaCounts.currentVideoCount > 0 &&
                            (mediaCounts.droppedVideoCount > 0 || mediaCounts.rvfcUnsupportedVideoCount > 0)))
                  : true
        const mediaRelationsValid =
            mediaCounts.retainedVideoCount + mediaCounts.droppedVideoCount === mediaCounts.currentVideoCount &&
            mediaCounts.rvfcSupportedVideoCount + mediaCounts.rvfcUnsupportedVideoCount === mediaCounts.retainedVideoCount &&
            mediaCounts.playingVideoCount <= mediaCounts.retainedVideoCount &&
            mediaCounts.activeProbeCount <= mediaCounts.retainedVideoCount &&
            statusMatchesCapability(mediaStatus, mediaCapability) &&
            mediaStatusValid
        const rendererKindCount =
            rendererCurrent.svg +
            rendererCurrent.canvasUnknown +
            rendererCurrent.canvas2d +
            rendererCurrent.webgl +
            rendererCurrent.webgl2 +
            rendererCurrent.webgpu
        const rendererStatusValid =
            rendererStatus === 'measured'
                ? rendererSampleCount > 0 && rendererCurrent.dropped === 0 && documentScopeComplete
                : rendererStatus === 'partial'
                  ? rendererSampleCount > 0 && (rendererCurrent.dropped > 0 || !documentScopeComplete)
                  : true
        const rendererRelationsValid =
            rendererCurrent.retained + rendererCurrent.dropped === rendererCurrent.total &&
            rendererKindCount === rendererCurrent.retained &&
            rendererPeakTotal >= rendererCurrent.total &&
            rendererSampleCount <= sampleCount &&
            (rendererContextCounts.successfulContextObservationCount === 0 ||
                (rendererContextCapability.state === 'supported' && rendererContextCapability.observed)) &&
            statusMatchesCapability(rendererStatus, rendererDiscoveryCapability) &&
            rendererStatusValid
        const currentOffscreenEvidencePositive = workCurrent.offscreenRunningAnimations > 0 || workCurrent.offscreenPlayingVideos > 0
        const historicalOffscreenEvidencePositive =
            workReviewCounts.offscreenRunningAnimationReviewSampleCount > 0 || workReviewCounts.offscreenPlayingVideoReviewSampleCount > 0
        const workStatusValid =
            workStatus === 'measured'
                ? workSampleCount > 0 &&
                  documentScopeComplete &&
                  intersectionCapability.state === 'supported' &&
                  trackedIntersectionTargetCount <= knownIntersectionTargetCount
                : workStatus === 'partial'
                  ? workSampleCount > 0 &&
                    (!documentScopeComplete ||
                        intersectionCapability.state !== 'supported' ||
                        trackedIntersectionTargetCount > knownIntersectionTargetCount)
                  : workStatus === 'not-observed' && workSampleCount === 0
        const workRelationsValid =
            workSampleCount <= sampleCount &&
            knownIntersectionTargetCount <= trackedIntersectionTargetCount &&
            workReviewCounts.hiddenRunningAnimationReviewSampleCount <= workSampleCount &&
            workReviewCounts.hiddenPlayingVideoReviewSampleCount <= workSampleCount &&
            workReviewCounts.offscreenRunningAnimationReviewSampleCount <= workSampleCount &&
            workReviewCounts.offscreenPlayingVideoReviewSampleCount <= workSampleCount &&
            workCurrent.hiddenRunningAnimations <= animationCurrent.running &&
            workCurrent.offscreenRunningAnimations <= animationCurrent.running &&
            workCurrent.hiddenPlayingVideos <= mediaCounts.playingVideoCount &&
            workCurrent.offscreenPlayingVideos <= mediaCounts.playingVideoCount &&
            (visibilityState === 'hidden' || (workCurrent.hiddenRunningAnimations === 0 && workCurrent.hiddenPlayingVideos === 0)) &&
            (!historicalOffscreenEvidencePositive || (intersectionCapability.state === 'supported' && intersectionCapability.observed)) &&
            (!currentOffscreenEvidencePositive || knownIntersectionTargetCount > 0) &&
            workStatusValid
        const reducedRelationsValid =
            reducedSampleCount <= sampleCount &&
            reducedReviewCount <= reducedSampleCount &&
            reducedCurrent.infiniteAnimationCandidates <= reducedCurrent.runningAnimationCandidates &&
            reducedCurrent.runningAnimationCandidates <= animationCurrent.running &&
            reducedCurrent.playingVideoCandidates <= mediaCounts.playingVideoCount &&
            (reducedPreference === true ||
                (reducedCurrent.runningAnimationCandidates === 0 &&
                    reducedCurrent.infiniteAnimationCandidates === 0 &&
                    reducedCurrent.playingVideoCandidates === 0)) &&
            (reducedPreference === true
                ? reducedStatus === (reducedSampleCount > 0 ? 'measured' : 'not-observed')
                : reducedPreference === false
                  ? reducedStatus === 'not-applicable'
                  : reducedStatus === 'not-observed' || reducedStatus === 'unsupported' || reducedStatus === 'unknown') &&
            statusMatchesCapability(reducedStatus, reducedCapability)
        if (!animationRelationsValid || !mediaRelationsValid || !rendererRelationsValid || !workRelationsValid || !reducedRelationsValid) {
            return null
        }

        return Object.freeze({
            schemaVersion: ANIMATION_OVERLAY_PAGE_EVIDENCE_VERSION,
            scope: 'capture-window-local',
            enabled: property(input, 'enabled') as boolean,
            sampleCount,
            documentScopes: Object.freeze({
                capability: documentCapability,
                retainedCount: documentRetainedCount,
                truncated: documentTruncated,
            }),
            animations: Object.freeze({
                capability: animationCapability,
                status: animationStatus,
                sampleCount: animationSampleCount,
                current: animationCurrent,
                peakTotal: animationPeakTotal,
                peakRunning: animationPeakRunning,
                lifecycle: animationLifecycle,
            }),
            media: Object.freeze({ capability: mediaCapability, status: mediaStatus, ...mediaCounts }),
            rendererSurfaces: Object.freeze({
                discoveryCapability: rendererDiscoveryCapability,
                contextObservationCapability: rendererContextCapability,
                status: rendererStatus,
                sampleCount: rendererSampleCount,
                current: rendererCurrent,
                peakTotal: rendererPeakTotal,
                ...rendererContextCounts,
                rendererWorkCapability,
                gpuTimingCapability: rendererGpuCapability,
            }),
            workAvoidance: Object.freeze({
                visibilityCapability,
                intersectionCapability,
                status: workStatus,
                visibilityState: visibilityState as AnimationOverlayPageVisibilityState,
                sampleCount: workSampleCount,
                trackedIntersectionTargetCount,
                knownIntersectionTargetCount,
                ...workReviewCounts,
                current: workCurrent,
                workDurationCapability,
            }),
            reducedMotion: Object.freeze({
                capability: reducedCapability,
                status: reducedStatus,
                preference: reducedPreference as boolean | null,
                reducedMotionSampleCount: reducedSampleCount,
                reviewCandidateSampleCount: reducedReviewCount,
                current: reducedCurrent,
                violationCapability: reducedViolationCapability,
            }),
        })
    } catch {
        return null
    }
}
