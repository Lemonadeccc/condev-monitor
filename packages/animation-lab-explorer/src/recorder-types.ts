import type { ExplorerRiskDisposition, ExplorerRiskIntent } from './types'

export const CHROME_RECORDER_IMPORT_SCHEMA_VERSION = 1 as const

export type ChromeRecorderKnownStepType =
    | 'change'
    | 'click'
    | 'close'
    | 'customStep'
    | 'doubleClick'
    | 'emulateNetworkConditions'
    | 'hover'
    | 'keyDown'
    | 'keyUp'
    | 'navigate'
    | 'scroll'
    | 'setViewport'
    | 'waitForElement'
    | 'waitForExpression'

export type RecorderProposedActionKind = 'click' | 'hover' | 'press' | 'resize'

export type RecorderImportExclusionReason =
    | 'absolute-scroll-needs-review'
    | 'action-limit'
    | 'arbitrary-expression'
    | 'close-step'
    | 'cross-origin'
    | 'custom-step'
    | 'dangerous-action'
    | 'double-click-needs-review'
    | 'frame-origin-unverified'
    | 'input-value'
    | 'invalid-selector'
    | 'invalid-step'
    | 'key-pair-missing'
    | 'navigation-side-effect'
    | 'network-condition-needs-review'
    | 'non-main-target'
    | 'target-url-mismatch'
    | 'unknown-step-type'
    | 'unsupported-device'
    | 'unsupported-field'
    | 'unsupported-key'
    | 'unstable-selector'
    | 'viewport-not-representable'
    | 'wait-condition-needs-review'

export interface RecorderImportPolicyInput {
    maxSteps?: number
    maxActions?: number
    dangerousActionDisposition?: ExplorerRiskDisposition
    crossOriginDisposition?: ExplorerRiskDisposition
    unknownOriginDisposition?: ExplorerRiskDisposition
}

export interface RecorderImportPolicy {
    maxSteps: number
    maxActions: number
    dangerousActionDisposition: ExplorerRiskDisposition
    crossOriginDisposition: ExplorerRiskDisposition
    unknownOriginDisposition: ExplorerRiskDisposition
}

export interface ChromeRecorderImportOptions {
    pageKey: string
    routeKey?: string
    /** Local comparison input only. It is never copied into either manifest. */
    targetUrl: string
    policy?: RecorderImportPolicyInput
}

export interface RecorderLocalSelectorEvidence {
    selector?: string
    textHint?: string
}

interface LocalRecorderActionBase {
    actionId: string
    label: string
    sourceStepIds: readonly string[]
    kind: RecorderProposedActionKind
    manualReviewRequired: true
    recordedTimeoutMs?: number
    limitations: readonly string[]
}

export type LocalRecorderActionProposal =
    | (LocalRecorderActionBase & {
          kind: 'click'
          selector: string
          recordedOffset: { x: number; y: number }
          recordedPointerDurationMs?: number
          reviewHint?: string
      })
    | (LocalRecorderActionBase & { kind: 'hover'; selector: string; reviewHint?: string; suggestedDurationMs: number })
    | (LocalRecorderActionBase & {
          kind: 'press'
          key: 'Enter' | 'Space' | 'Tab' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Escape'
      })
    | (LocalRecorderActionBase & { kind: 'resize'; width: number; height: number })

export interface RecorderConfigurationStep {
    stepId: string
    sourceIndex: number
    type: 'navigate' | 'setViewport'
    status: 'configuration-only'
    limitations: readonly string[]
}

export interface RecorderExcludedStep {
    stepId: string
    sourceIndex: number
    stepType: ChromeRecorderKnownStepType | 'unknown'
    disposition: ExplorerRiskDisposition
    reason: RecorderImportExclusionReason
    riskIntents: readonly ExplorerRiskIntent[]
    localOnly?: RecorderLocalSelectorEvidence & {
        inputValuePresent?: true
        expressionPresent?: true
        customParametersPresent?: true
    }
}

export interface RecorderImportCoverage {
    complete: false
    claim: 'bounded-recorded-step-subset'
    totalSteps: number
    examinedSteps: number
    configurationSteps: number
    proposedActionSteps: number
    proposedActions: number
    rejectedSteps: number
    quarantinedSteps: number
    unexaminedSteps: number
    warning: string
}

export interface LocalRecorderFlowProposal {
    schemaVersion: 1
    source: 'chrome-devtools-recorder'
    dataClassification: 'local-only'
    status: 'needs-review'
    pageKey: string
    routeKey: string
    sourceTitlePresent: boolean
    selectorAttributePresent: boolean
    suggestedViewport?: {
        sourceStepId: string
        width: number
        height: number
        deviceScaleFactor: number
    }
    policy: RecorderImportPolicy
    configurationSteps: readonly RecorderConfigurationStep[]
    actions: readonly LocalRecorderActionProposal[]
    excludedSteps: readonly RecorderExcludedStep[]
    coverage: RecorderImportCoverage
    review: {
        required: true
        warnings: readonly string[]
    }
}

export interface UploadSafeRecorderAction {
    actionId: string
    kind: RecorderProposedActionKind
    sourceStepCount: number
}

export interface UploadSafeRecorderFlowManifest {
    schemaVersion: 1
    source: 'chrome-devtools-recorder'
    dataClassification: 'upload-safe'
    status: 'needs-review'
    pageKey: string
    routeKey: string
    policy: RecorderImportPolicy
    proposedActions: readonly UploadSafeRecorderAction[]
    exclusionReasonCounts: Readonly<Partial<Record<RecorderImportExclusionReason, number>>>
    coverage: RecorderImportCoverage
    reviewRequired: true
    privacy: {
        recorderTitleIncluded: false
        selectorsIncluded: false
        textIncluded: false
        urlsIncluded: false
        pointerCoordinatesIncluded: false
        inputValuesIncluded: false
        expressionsIncluded: false
        customParametersIncluded: false
        frameIndexesIncluded: false
    }
}
