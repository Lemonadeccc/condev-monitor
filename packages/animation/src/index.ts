export { AnimationCollector, AnimationOptionsError, AnimationStateError, AnimationUnsupportedError } from './collector'
export {
    ANIMATION_MONITOR_VERSION,
    ANIMATION_RUM_CONTRACT_VERSION,
    ANIMATION_RUM_MAX_WINDOW_DURATION_MS,
    ANIMATION_RUM_SAMPLING_POLICY_VERSION,
    AnimationIntegration,
    deterministicAnimationRumSample,
    toAnimationRumSummary,
} from './integration'
export type { AnimationRumProjectionOptions } from './integration'
export { createAnimationElementPicker } from './element-picker'
export * from './host-adapters'
export * from './media-semantics'
export * from './motion-semantics'
export type { AnimationOverlaySource } from './overlay'
export { recommendAnimationImprovements } from './recommendations'
export { createBrowserAnimationRuntime } from './runtime'
export { createAnimationTargetAdapterRegistry } from './target-adapter-registry'
export { observeCanvasRendererContexts } from './renderer-surfaces'
export type { CanvasRendererContextKind, CanvasRendererContextListener, CanvasRendererContextObservation } from './renderer-surfaces'
export { toAnimationRumV2PageReport, toAnimationRumV2TargetReport } from './rum-v2/report-builder'
export type * from './rum-v2/types'
export type * from './types'
