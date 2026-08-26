export const ANIMATION_LAB_EXPLORER_SCHEMA_VERSION = 1 as const

export type ExplorerActionKind = 'click' | 'hover' | 'scroll' | 'pointer-path'
export type ExplorerOriginRelation = 'same-origin' | 'cross-origin' | 'unknown'
export type ExplorerCandidateIntent = 'ordinary' | 'submit' | 'delete' | 'payment' | 'logout' | 'file' | 'password' | 'unknown'
export type ExplorerRiskIntent = Exclude<ExplorerCandidateIntent, 'ordinary'>
export type ExplorerRiskDisposition = 'reject' | 'quarantine'

export interface ExplorerRelativePoint {
    xRatio: number
    yRatio: number
}

/**
 * Evidence that must remain on the developer's machine. The explorer never
 * copies any field from this object into an upload-safe manifest.
 */
export interface ExplorerLocalCandidateDetails {
    selector?: string
    textHint?: string
    pointerPath?: readonly ExplorerRelativePoint[]
    scrollDeltaX?: number
    scrollDeltaY?: number
}

/**
 * A caller-classified, already-redacted candidate. It deliberately contains no
 * URL, DOM attributes, input values, coordinates, or captured event payloads.
 */
export interface ExplorerPageCandidate {
    candidateId: string
    kind: ExplorerActionKind
    originRelation: ExplorerOriginRelation
    depth: number
    estimatedDurationMs: number
    intent: ExplorerCandidateIntent
    localOnly?: ExplorerLocalCandidateDetails
}

export interface ExplorerPlanInput {
    /** Safe caller-owned token, not a URL or page title. */
    pageKey: string
    /** Safe route token. Defaults to pageKey. */
    routeKey?: string
    candidates: readonly ExplorerPageCandidate[]
}

export interface ExplorerPlanningPolicyInput {
    maxCandidates?: number
    maxActions?: number
    maxDepth?: number
    maxActionDurationMs?: number
    maxTotalDurationMs?: number
    maxPointerPoints?: number
    allowedKinds?: readonly ExplorerActionKind[]
    dangerousActionDisposition?: ExplorerRiskDisposition
    crossOriginDisposition?: ExplorerRiskDisposition
    unknownOriginDisposition?: ExplorerRiskDisposition
}

export interface ExplorerPlanningPolicy {
    maxCandidates: number
    maxActions: number
    maxDepth: number
    maxActionDurationMs: number
    maxTotalDurationMs: number
    maxPointerPoints: number
    allowedKinds: readonly ExplorerActionKind[]
    dangerousActionDisposition: ExplorerRiskDisposition
    crossOriginDisposition: ExplorerRiskDisposition
    unknownOriginDisposition: ExplorerRiskDisposition
}

interface LocalScenarioActionBase {
    candidateId: string
    label: string
    kind: ExplorerActionKind
    estimatedDurationMs: number
    manualReviewRequired: true
    /** Optional local reviewer context. Never copied into the manifest. */
    reviewHint?: string
}

export type LocalScenarioActionProposal =
    | (LocalScenarioActionBase & { kind: 'click'; selector: string; durationMs?: number })
    | (LocalScenarioActionBase & { kind: 'hover'; selector: string; durationMs: number })
    | (LocalScenarioActionBase & {
          kind: 'scroll'
          selector?: string
          deltaX?: number
          deltaY: number
          durationMs: number
      })
    | (LocalScenarioActionBase & {
          kind: 'pointer-path'
          selector?: string
          durationMs: number
          points: readonly ExplorerRelativePoint[]
      })

export type ExplorerExclusionReason =
    | 'action-limit'
    | 'cross-origin'
    | 'dangerous-action'
    | 'depth-limit'
    | 'duplicate-candidate'
    | 'invalid-depth'
    | 'invalid-duration'
    | 'invalid-pointer-path'
    | 'invalid-scroll-delta'
    | 'invalid-selector'
    | 'kind-disabled'
    | 'missing-selector'
    | 'total-duration-limit'
    | 'unknown-origin'
    | 'unsupported-kind'

export interface ExplorerExcludedCandidate {
    candidateId: string
    kind: ExplorerActionKind | 'unknown'
    disposition: ExplorerRiskDisposition
    reason: ExplorerExclusionReason
    riskIntents: readonly ExplorerRiskIntent[]
    /** Local evidence is retained only to make the review decision explainable. */
    localOnly?: Pick<ExplorerLocalCandidateDetails, 'selector' | 'textHint'>
}

export interface ExplorerCoverageStatement {
    complete: false
    claim: 'bounded-candidate-sample'
    totalCandidates: number
    examinedCandidates: number
    acceptedCandidates: number
    rejectedCandidates: number
    quarantinedCandidates: number
    unexaminedCandidates: number
    warning: string
}

/** Contains selectors and reviewer text. This object must never be uploaded. */
export interface LocalScenarioProposal {
    schemaVersion: 1
    dataClassification: 'local-only'
    status: 'needs-review'
    pageKey: string
    routeKey: string
    policy: ExplorerPlanningPolicy
    actions: readonly LocalScenarioActionProposal[]
    excludedCandidates: readonly ExplorerExcludedCandidate[]
    coverage: ExplorerCoverageStatement
    review: {
        required: true
        warnings: readonly string[]
    }
}

export interface UploadSafeScenarioAction {
    candidateId: string
    kind: ExplorerActionKind
    estimatedDurationMs: number
}

/**
 * The only explorer projection intended for transport. It contains no URL,
 * selector, text, relative pointer points, input value, or raw DOM evidence.
 */
export interface UploadSafeScenarioManifest {
    schemaVersion: 1
    dataClassification: 'upload-safe'
    status: 'needs-review'
    pageKey: string
    routeKey: string
    policy: ExplorerPlanningPolicy
    proposedActions: readonly UploadSafeScenarioAction[]
    exclusionReasonCounts: Readonly<Partial<Record<ExplorerExclusionReason, number>>>
    coverage: ExplorerCoverageStatement
    reviewRequired: true
    privacy: {
        selectorsIncluded: false
        textIncluded: false
        urlsIncluded: false
        pointerCoordinatesIncluded: false
        inputValuesIncluded: false
    }
}
