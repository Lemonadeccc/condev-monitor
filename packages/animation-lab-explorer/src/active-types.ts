import type { ExplorerRelativePoint } from './types'

export const ACTIVE_ANIMATION_EXPLORATION_SCHEMA_VERSION = 1 as const

export type ActiveExplorerBrowserEngine = 'chromium' | 'firefox' | 'webkit' | 'webdriver-bidi' | 'appium'
export type ActiveExplorerActionKind = 'load' | 'click' | 'hover' | 'scroll' | 'pointer-path' | 'resize' | 'press'
export type ActiveExplorerMotionFamily =
    | 'css-animation'
    | 'css-transition'
    | 'waapi'
    | 'svg-smil'
    | 'scroll-driven'
    | 'view-transition'
    | 'script-driven'
    | 'canvas-2d'
    | 'webgl'
    | 'webgpu'
    | 'media'
    | 'unknown'
export type ActiveExplorerEvidenceKind =
    | 'browser-direct'
    | 'browser-event'
    | 'adapter-attested'
    | 'trace-correlated'
    | 'visual-inference'
    | 'surface-only'
    | 'ai-proposed'
export type ActiveExplorerEvidenceConfidence = 'explicit' | 'high' | 'medium' | 'low' | 'unknown'
export type ActiveExplorerCausality = 'direct-api' | 'adapter-bound' | 'temporal-correlation' | 'visual-inference' | 'unknown'
export type ActiveExplorerEdgeStatus = 'executed' | 'failed' | 'timed-out' | 'rejected' | 'quarantined'
export type ActiveExplorerMotionStatus = 'observed' | 'completed' | 'cancelled' | 'running' | 'partial'
export type ActiveExplorerAuthentication = 'none' | 'required-local-storage-state' | 'unknown'
export type ActiveExplorerStopReason =
    | 'candidate-queue-exhausted'
    | 'max-routes'
    | 'max-states'
    | 'max-edges'
    | 'max-depth'
    | 'max-total-duration'
    | 'max-motion-records'
    | 'browser-closed'
    | 'page-crashed'
    | 'policy-blocked'
export type ActiveExplorerLimitation =
    | 'bounded-exploration'
    | 'cross-origin-blocked'
    | 'dangerous-action-blocked'
    | 'network-side-effect-blocked'
    | 'login-state-excluded'
    | 'no-framework-adapter'
    | 'no-renderer-adapter'
    | 'surface-only'
    | 'temporal-correlation'
    | 'visual-change-unclassified'
    | 'infinite-observation-capped'
    | 'observer-sample-capped'
    | 'renderer-adapter-error'
    | 'renderer-object-ambiguous'
    | 'renderer-object-unresolved'
    | 'development-hmr-allowed'
    | 'outcome-needs-review'
    | 'unsupported-browser-evidence'

export interface ActiveExplorerPolicyInput {
    maxRoutes?: number
    maxStates?: number
    maxEdges?: number
    maxDepth?: number
    maxActionsPerState?: number
    maxTotalDurationMs?: number
    actionTimeoutMs?: number
    settleIdleMs?: number
    settleTimeoutMs?: number
    maxMotionRecords?: number
    allowedKinds?: readonly Exclude<ActiveExplorerActionKind, 'load'>[]
    blockMutationRequests?: boolean
    allowDevelopmentHmr?: boolean
}

export interface ActiveExplorerPolicy {
    maxRoutes: number
    maxStates: number
    maxEdges: number
    maxDepth: number
    maxActionsPerState: number
    maxTotalDurationMs: number
    actionTimeoutMs: number
    settleIdleMs: number
    settleTimeoutMs: number
    maxMotionRecords: number
    allowedKinds: readonly Exclude<ActiveExplorerActionKind, 'load'>[]
    blockMutationRequests: boolean
    allowDevelopmentHmr: boolean
}

export interface ActiveExplorerLocalAction {
    actionId: string
    kind: ActiveExplorerActionKind
    candidateId?: string
    selector?: string
    durationMs?: number
    deltaX?: number
    deltaY?: number
    points?: readonly ExplorerRelativePoint[]
    width?: number
    height?: number
    key?: string
}

export interface ActiveExplorerRouteRecord {
    routeId: string
    routeKey: string
    localUrl: string
    stateIds: readonly string[]
}

export interface ActiveExplorerStateRecord {
    stateId: string
    routeId: string
    depth: number
    semanticHash: string
    visualHash?: string
    targetCount: number
    motionInventoryHash: string
    replayEdgeIds: readonly string[]
}

export type ActiveExplorerTargetSurface = 'dom' | 'svg' | 'canvas-2d' | 'webgl' | 'webgpu' | 'media' | 'unknown'

export interface ActiveExplorerTargetRecord {
    targetId: string
    stateId: string
    surface: ActiveExplorerTargetSurface
    localOnly?: {
        selector?: string
        label?: string
    }
}

export interface ActiveExplorerMotionTiming {
    declaredDurationMs?: number
    effectiveDurationMs?: number
    observedActiveMs?: number
    settleMs?: number
    delayMs?: number
    iterations?: number | 'infinite'
    infinite: boolean
}

export interface ActiveExplorerMotionRecord {
    motionId: string
    fingerprint: string
    routeId: string
    stateId: string
    edgeId: string
    targetId?: string
    family: ActiveExplorerMotionFamily
    engine: 'browser-native' | 'svg' | 'script' | 'renderer' | 'media' | 'unknown'
    status: ActiveExplorerMotionStatus
    timing: ActiveExplorerMotionTiming
    properties: readonly string[]
    lifecycle: readonly string[]
    evidenceKinds: readonly ActiveExplorerEvidenceKind[]
    evidenceConfidence: ActiveExplorerEvidenceConfidence
    causality: ActiveExplorerCausality
    limitations: readonly ActiveExplorerLimitation[]
    observedInstances: number
    localOnly?: {
        selector?: string
        animationName?: string
        pseudoElement?: string
        rendererSubjectKey?: string
        rendererOutcomeKey?: string
        rendererResolution?: 'hit' | 'miss' | 'unavailable'
    }
}

export interface ActiveExplorerRendererObjectEvidence {
    subjectKey: string
    surface: 'canvas-2d' | 'webgl' | 'webgpu'
    resolution: 'hit' | 'miss' | 'unavailable'
    selector?: string
    outcomeKey?: string
    outcomeStatus?: 'completed' | 'failed' | 'idle'
    adapterError?: true
}

export interface ActiveExplorerEdgeRecord {
    edgeId: string
    fromStateId: string
    toStateId?: string
    routeId: string
    depth: number
    action: ActiveExplorerLocalAction
    status: ActiveExplorerEdgeStatus
    motionIds: readonly string[]
    startedAtMs: number
    endedAtMs: number
    blockedMutationRequests: number
    limitations: readonly ActiveExplorerLimitation[]
    localOnly?: {
        rendererObjects: readonly ActiveExplorerRendererObjectEvidence[]
    }
    errorCode?: 'action-timeout' | 'action-failed' | 'cross-origin-navigation' | 'browser-closed' | 'page-crashed' | 'policy-blocked'
}

export interface ActiveExplorerCoverage {
    claim: 'bounded-safe-reachable-state-exploration'
    complete: false
    discoveredRoutes: number
    discoveredStates: number
    candidateEdges: number
    executedEdges: number
    observedMotions: number
    completedMotions: number
    quarantinedEdges: number
    failedEdges: number
    stoppedByBounds: boolean
    uncoveredReasonCounts: Readonly<Partial<Record<ActiveExplorerLimitation, number>>>
    warning: string
}

export interface LocalActiveAnimationExplorationSession {
    schemaVersion: 1
    dataClassification: 'local-only'
    status: 'needs-review'
    mode: 'active-explore'
    pageKey: string
    browser: {
        driver: 'playwright' | 'webdriver-bidi' | 'appium'
        engine: ActiveExplorerBrowserEngine
        version?: string
    }
    /** Safe replay requirement only; never a path, cookie, token, or storage-state value. */
    authentication?: ActiveExplorerAuthentication
    startedAt: string
    endedAt: string
    policy: ActiveExplorerPolicy
    routes: readonly ActiveExplorerRouteRecord[]
    states: readonly ActiveExplorerStateRecord[]
    targets: readonly ActiveExplorerTargetRecord[]
    edges: readonly ActiveExplorerEdgeRecord[]
    motions: readonly ActiveExplorerMotionRecord[]
    coverage: ActiveExplorerCoverage
    stopReasons: readonly ActiveExplorerStopReason[]
    limitations: readonly ActiveExplorerLimitation[]
    review: {
        required: true
        warnings: readonly string[]
    }
}

export interface UploadSafeActiveAnimationExplorationSession {
    schemaVersion: 1
    dataClassification: 'upload-safe'
    status: 'needs-review'
    mode: 'active-explore'
    pageKey: string
    browser: LocalActiveAnimationExplorationSession['browser']
    authentication: ActiveExplorerAuthentication
    startedAt: string
    endedAt: string
    policy: ActiveExplorerPolicy
    routes: ReadonlyArray<Omit<ActiveExplorerRouteRecord, 'localUrl'>>
    states: readonly Omit<ActiveExplorerStateRecord, 'visualHash' | 'replayEdgeIds'>[]
    targets: readonly Omit<ActiveExplorerTargetRecord, 'localOnly'>[]
    edges: ReadonlyArray<
        Omit<ActiveExplorerEdgeRecord, 'action' | 'localOnly'> & {
            action: Pick<ActiveExplorerLocalAction, 'actionId' | 'kind' | 'candidateId' | 'durationMs'>
        }
    >
    motions: readonly Omit<ActiveExplorerMotionRecord, 'localOnly'>[]
    coverage: ActiveExplorerCoverage
    stopReasons: readonly ActiveExplorerStopReason[]
    limitations: readonly ActiveExplorerLimitation[]
    reviewRequired: true
    privacy: {
        urlsIncluded: false
        selectorsIncluded: false
        textIncluded: false
        coordinatesIncluded: false
        screenshotsIncluded: false
        inputValuesIncluded: false
        domIncluded: false
    }
}

export interface VisionDiscoveryActionProposal {
    proposalId: string
    source: 'ai-proposed'
    kind: Exclude<ActiveExplorerActionKind, 'load'>
    confidence: number
    localOnly: {
        xRatio?: number
        yRatio?: number
        label?: string
    }
}

/**
 * Optional visual discovery SPI. Implementations may use deterministic CV or a
 * local/self-hosted VLM, but proposals never bypass the explorer policy and
 * never count as observed motion until the browser probe confirms evidence.
 */
export interface VisionDiscoveryAdapter {
    readonly adapterId: string
    proposeTargets(input: {
        redactedImage: Uint8Array
        allowedKinds: readonly Exclude<ActiveExplorerActionKind, 'load'>[]
    }): Promise<readonly VisionDiscoveryActionProposal[]>
}
